import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

/* :: :: Function :: START :: */

/**
 * Convert images based on configuration from a JSON file.
 * @param {string} inputDir - Directory containing source images.
 * @param {string} outputDir - Directory to save converted images.
 * @param {string} configPath - Path to the JSON configuration file.
 */
export async function convertImages (
    inputDir,
    outputDir,
    configPath
) {
    /* :: :: Helpers :: START :: */

    const colors = {
        red: "\x1b[31m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        blue: "\x1b[34m",
        cyan: "\x1b[36m",
        dim: "\x1b[2m",
        reset: "\x1b[0m"
    };

    /**
     * Helper for consistent, colorful logging
     */
    const log = (
        color,
        label,
        message
    ) => {
        console.log(`${colors[color]}[${label}]${colors.reset} ${message}`);
    };

    /**
     * Helper to format bytes
     */
    const formatSize = (bytes) => {
        return (bytes / 1024).toFixed(2) + ' KB';
    };

    /**
     * Helper to recursively get files
     */
    async function getFiles (dir) {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(dirents.map((dirent) => {
            const res = path.join(dir, dirent.name);
            return dirent.isDirectory() ? getFiles(res) : res;
        }));
        return files.flat();
    }

    /* :: :: Helpers :: END :: */

    // //

    /* :: :: Logic :: START :: */

    try {
        const fullOutputDir = path.resolve(outputDir);
        const fullInputDir = path.resolve(inputDir);

        // Ensure output directory exists
        await fs.mkdir(fullOutputDir, { recursive: true });

        // 1. Initial Access Check
        try {
            await fs.access(fullInputDir);
        } catch {
            log('red', 'ERROR', `Input directory not found: ${fullInputDir}`);
            return;
        }

        // 2. Configuration Loading
        let configData;
        try {
            const configFileContent = await fs.readFile(configPath, 'utf-8');
            configData = JSON.parse(configFileContent);
        } catch (error) {
            log('red', 'ERROR', `Failed to read or parse JSON config: ${error.message}`);
            return;
        }

        if (!Array.isArray(configData) || configData.length === 0) {
            log('yellow', 'WARN', `Configuration file is empty or invalid.`);
            return;
        }

        // 3. FEATURE RESTORED: Verify files defined in JSON actually exist in source
        for (const configEntry of configData) {
            const sourcePath = path.join(fullInputDir, configEntry.source);
            try {
                await fs.access(sourcePath);
            } catch {
                log('red', 'MISSING', `File defined in JSON not found: ${configEntry.source}`);
            }
        }

        const files = await getFiles(fullInputDir);

        if (files.length === 0) {
            log('yellow', 'WARN', `Input directory is empty.`);
            return;
        }

        log('blue', 'START', `Processing ${files.length} files...`);
        console.log('---');

        for (const filePath of files) {
            // Paths for logic
            const relativePath = path.relative(fullInputDir, filePath);
            const normalizedRelativePath = relativePath.split(path.sep).join('/');

            // Paths for file operations & logging (Absolute)
            const relativeDir = path.dirname(relativePath);
            const targetDir = path.join(fullOutputDir, relativeDir);

            await fs.mkdir(targetDir, { recursive: true });

            const fileInfo = path.parse(filePath);
            const fileName = fileInfo.base;
            const fileExt = fileInfo.ext.toLowerCase().replace('.', '');

            const customConfig = configData.find(config => {
                return config.source === normalizedRelativePath;
            });

            // Handle "Original" or SVG-direct flags
            if (customConfig?.original || (fileExt === 'svg' && customConfig?.output === 'svg')) {
                const outputFilePath = path.join(targetDir, fileName);
                try {
                    await fs.copyFile(filePath, outputFilePath);
                    log('green', 'COPY', `${normalizedRelativePath} (Preserved Original)`);
                } catch (e) {
                    log('red', 'FAIL', `Copy failed: ${e.message}`);
                }
                continue;
            }

            // 4. Metadata and Format Verification (FEATURE RESTORED)
            let metadata;
            try {
                metadata = await sharp(filePath).metadata();
            } catch (error) {
                // Now specifically logs the error message from Sharp (e.g., "Input file is of an unsupported image format")
                log('red', 'ERROR', `Sharp cannot read ${normalizedRelativePath}: ${error.message}`);
                continue;
            }

            // FEATURE RESTORED: Extension vs Format Mismatch Check
            const detectedFormat = metadata.format?.toLowerCase() || 'unknown';
            const normalizedExt = (fileExt === 'jpg') ? 'jpeg' : fileExt;
            const normalizedFormat = (detectedFormat === 'jpg') ? 'jpeg' : detectedFormat;

            if (normalizedExt !== normalizedFormat && detectedFormat !== 'unknown') {
                log('yellow', 'MISMATCH', `${normalizedRelativePath} is .${fileExt} but detected as ${detectedFormat.toUpperCase()}`);
            }

            // 5. Processing Logic
            const supportedFormats = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'tiff', 'gif'];

            if (!supportedFormats.includes(detectedFormat)) {
                log('dim', 'SKIP', `Unsupported format (${detectedFormat.toUpperCase()}) for ${normalizedRelativePath}`);
                continue;
            }

            // 6. Prepare Output Logic
            const nameParts = fileInfo.name.split('-Source-');
            const id = nameParts[0];
            const title = nameParts[1] || '';

            const sizes = customConfig?.sizes || [];
            const targetFormat = customConfig?.output || 'webp';

            // Determine operations list (if no sizes, just one operation)
            const operations = (sizes.length > 0) ? sizes : [0];

            for (const size of operations) {
                const targetWidth = size === 0 ? metadata.width : size;
                const outputFileName = `${id}-${title}-x${targetWidth}.${targetFormat}`;
                const outputFilePath = path.join(targetDir, outputFileName);

                try {
                    let pipeline = sharp(filePath);
                    if (size !== 0) {
                        pipeline = pipeline.resize({ width: size });
                    }

                    // Perform conversion and capture info
                    const info = await pipeline
                        .toFormat(targetFormat, { quality: 85 })
                        .toFile(outputFilePath);

                    // Structured log with size
                    log('green', 'DONE', `${outputFileName} ${colors.dim}(${formatSize(info.size)})${colors.reset}`);

                } catch (error) {
                    log('red', 'FAIL', `Process error [${size}px] for ${normalizedRelativePath}: ${error.message}`);
                }
            }
        }

        console.log('---');
        log('blue', 'END', `Output saved to: ${fullOutputDir}`);

    } catch (error) {
        log('red', 'CRITICAL', `Unexpected error: ${error.message}`);
    }
}

/* :: :: Logic :: END :: */

/* :: :: Function :: END :: */
