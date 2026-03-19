import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

/* :: :: Function :: START :: */

/**
 * Convert images based on configuration from a JSON or YAML file.
 * @param {string} inputDir - Directory containing source images.
 * @param {string} outputDir - Directory to save converted images.
 * @param {string} configPath - Path to the configuration file (YAML preferred).
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

    /**
     * Resolves {{placeholders}} using vars dictionary
     */
    function resolvePlaceholders (obj, vars) {
        if (!vars || Object.keys(vars).length === 0) return obj;

        function resolveString (str) {
            // First check if the entire string is exactly ONE placeholder
            const exactMatch = str.match(/^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/);
            if (exactMatch) {
                const key = exactMatch[1];
                const parts = key.split('.');
                let current = vars;
                let found = true;
                for (const part of parts) {
                    if (current && Object.prototype.hasOwnProperty.call(current, part)) {
                        current = current[part];
                    } else {
                        found = false;
                        break;
                    }
                }
                if (found) {
                    // Return the literal object/array/primitive
                    return typeof current === 'object' && current !== null ? traverse(current) : current; 
                }
            }

            // Otherwise, replace occurrences inside the string
            return str.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key) => {
                const parts = key.split('.');
                let current = vars;
                for (const part of parts) {
                    if (current && Object.prototype.hasOwnProperty.call(current, part)) {
                        current = current[part];
                    } else {
                        return match; // Unresolved, return placeholder
                    }
                }
                
                if (typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean') {
                    return String(current);
                }
                return match;
            });
        }

        function traverse (value) {
            if (typeof value === 'string') {
                return resolveString(value);
            }
            if (Array.isArray(value)) {
                return value.map(item => traverse(item));
            }
            if (value !== null && typeof value === 'object') {
                const result = {};
                for (const [k, v] of Object.entries(value)) {
                    result[k] = traverse(v);
                }
                return result;
            }
            return value;
        }

        return traverse(obj);
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
        let conversionsData;
        try {
            const configFileContent = await fs.readFile(configPath, 'utf-8');
            
            if (configPath.toLowerCase().endsWith('.json')) {
                log('yellow', 'WARN', `Using .json configuration is deprecated. Please migrate to .yaml: ${configPath}`);
                configData = JSON.parse(configFileContent);
                conversionsData = configData;
            } else {
                configData = yaml.load(configFileContent);
                
                // If it's the new format with vars
                if (configData && !Array.isArray(configData)) {
                    const vars = configData.vars || {};
                    const resolvedData = resolvePlaceholders(configData, vars);
                    conversionsData = resolvedData.images || resolvedData.conversions || [];
                } else {
                    // It's a top-level array in Yaml
                    conversionsData = configData;
                }
            }
        } catch (error) {
            log('red', 'ERROR', `Failed to read or parse config file: ${error.message}`);
            return;
        }

        if (!Array.isArray(conversionsData) || conversionsData.length === 0) {
            log('yellow', 'WARN', `Configuration images/conversions list is empty or invalid.`);
            return;
        }

        // 3. FEATURE RESTORED: Verify files defined in config actually exist in source
        for (const configEntry of conversionsData) {
            const sourcePath = path.join(fullInputDir, configEntry.source);
            try {
                await fs.access(sourcePath);
            } catch {
                log('red', 'MISSING', `File defined in config not found: ${configEntry.source}`);
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

            const customConfig = conversionsData.find(config => {
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
