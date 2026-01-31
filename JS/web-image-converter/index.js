import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 *  Convert images based on configuration from a JSON file.
 *  @param {string} inputDir - Directory containing source images.
 *  @param {string} outputDir - Directory to save converted images.
 *  @param {string} configPath - Path to the JSON configuration file.
 */
export async function convertImages(inputDir, outputDir, configPath) {
    try {
        // Ensure output directory exists
        await fs.mkdir(outputDir, { recursive: true });

        // Check if input directory exists
        try {
            await fs.access(inputDir);
        } catch {
            console.error("\u001B[31m%s\u001B[0m", `Input directory not found: ${inputDir} at path ${path.resolve(inputDir)}`);
            return;
        }

        // Read and parse the JSON configuration file
        let configData;
        try {
            const configFileContent = await fs.readFile(configPath, 'utf-8');
            configData = JSON.parse(configFileContent);
        } catch (error) {
            console.error("\u001B[31m%s\u001B[0m", `Failed to read or parse JSON configuration file: ${error.message}`);
            return;
        }

        // Check if configData is empty or not an array
        if (!Array.isArray(configData) || configData.length === 0) {
            console.warn("\u001B[33m%s\u001B[0m", `Configuration file is empty or invalid: ${configPath}`);
            return;
        }

        // Check for files defined in JSON but missing in source directory
        for (const configEntry of configData) {
             const sourcePath = path.join(inputDir, configEntry.source);
             try {
                 await fs.access(sourcePath);
             } catch {
                 console.error("\u001B[31m%s\u001B[0m", `Error: File defined in JSON not found in source directory: ${configEntry.source}`);
             }
        }

        // Helper to recursively get files
        async function getFiles(dir) {
            const dirents = await fs.readdir(dir, { withFileTypes: true });
            const files = await Promise.all(dirents.map((dirent) => {
                const res = path.join(dir, dirent.name);
                return dirent.isDirectory() ? getFiles(res) : res;
            }));
            return files.flat();
        }

        // Get all files in the source directory
        const files = await getFiles(inputDir);

        // Check if the input directory is empty
        if (files.length === 0) {
            console.warn("\u001B[33m%s\u001B[0m", `Input directory is empty: ${inputDir}`);
            return;
        }

        // Iterate over all files in the input directory
        for (const filePath of files) {
            const relativePath = path.relative(inputDir, filePath);
            const normalizedRelativePath = relativePath.split(path.sep).join('/');

            const relativeDir = path.dirname(relativePath);
            const targetDir = path.join(outputDir, relativeDir);
            await fs.mkdir(targetDir, { recursive: true });

            const fileInfo = path.parse(filePath);
            const fileName = fileInfo.base;
            const fileExt = fileInfo.ext.toLowerCase().replace('.', '');

            const customConfig = configData.find(config => config.source === normalizedRelativePath);

            // Special handling for preserving original file
            if (customConfig && customConfig.original === true) {
                const outputFileName = fileName; // Keep original filename
                const outputFilePath = path.join(targetDir, outputFileName);

                console.log("\u001B[32m%s\u001B[0m", `Copying Original (skip processing): ${normalizedRelativePath} -> ${outputFileName}`);
                try {
                    await fs.copyFile(filePath, outputFilePath);
                    console.log("\u001B[32m%s\u001B[0m", `Saved: ${outputFilePath}`);
                } catch (error) {
                    console.error("\u001B[31m%s\u001B[0m", `Failed to copy ${normalizedRelativePath}:`, error.message);
                }
                continue;
            }

            // Special handling for SVG copying if output is set to 'svg'
            if (fileExt === 'svg' && customConfig && customConfig.output === 'svg') {
                const outputFileName = fileName; // Keep original filename
                const outputFilePath = path.join(targetDir, outputFileName);

                console.log("\u001B[32m%s\u001B[0m", `Copying SVG (skip handling): ${normalizedRelativePath} -> ${outputFileName}`);
                try {
                    await fs.copyFile(filePath, outputFilePath);
                    console.log("\u001B[32m%s\u001B[0m", `Saved: ${outputFilePath}`);
                } catch (error) {
                    console.error("\u001B[31m%s\u001B[0m", `Failed to copy ${normalizedRelativePath}:`, error.message);
                }
                continue;
            }

            // Attempt to get metadata from the image
            let metadata;
            try {
                metadata = await sharp(filePath).metadata();
            } catch (error) {
                console.error("\u001B[31m%s\u001B[0m", `Metadata Error for ${normalizedRelativePath}: `, error.message);
                continue;
            }

            const detectedFormat = metadata.format ? metadata.format.toLowerCase() : 'unknown';

            // Normalize jpg/jpeg for comparison
            const normalizedExt = fileExt === 'jpg' ? 'jpeg' : fileExt;
            const normalizedFormat = detectedFormat === 'jpg' ? 'jpeg' : detectedFormat;

            if (normalizedExt !== normalizedFormat) {
                console.warn("\u001B[31m%s\u001B[0m", `Warning: File extension (.${fileExt}) does not match detected format (${detectedFormat.toUpperCase()}) for file ${normalizedRelativePath}`);
            } else {
                console.log("\u001B[32m%s\u001B[0m", `File ${normalizedRelativePath} detected as ${detectedFormat.toUpperCase()} format.`);
            }

            // Extract the ID and title from the filename
            const nameParts = fileInfo.name.split('-Source-');
            const id = nameParts[0]; // ID is the first part of the filename
            const title = nameParts[1] ? nameParts[1] : ''; // Title is the second part after "-Source-" (if exists)

            // Filter supported image formats (excluding SVG)
            const supportedFormats = ['png', 'jpg', 'jpeg', 'webp'];
            if (supportedFormats.includes(metadata.format?.toLowerCase())) {
                // Check for custom sizes
                let sizes = customConfig ? customConfig.sizes : [];

                if (customConfig) {
                     console.log("\u001B[36m%s\u001B[0m", `[Config Match] Found configuration for ${normalizedRelativePath}`);
                } else {
                     console.log("\u001B[33m%s\u001B[0m", `[No Config] No configuration found for ${normalizedRelativePath}, using default compression.`);
                }

                // Determine target format (default to 'webp')
                const targetFormat = (customConfig && customConfig.output) ? customConfig.output : 'webp';

                // If no sizes are specified, compress the original image
                if (!sizes || sizes.length === 0) {
                    const outputFileName = `${id}-${title}-x${metadata.width}.${targetFormat}`;
                    const outputFilePath = path.join(targetDir, outputFileName);

                    console.log("\u001B[34m%s\u001B[0m", `Compressing ${normalizedRelativePath} -> ${outputFileName}`);
                    try {
                        await sharp(filePath)
                            .toFormat(targetFormat, { quality: 85 })
                            .toFile(outputFilePath);
                        console.log("\u001B[32m%s\u001B[0m", `Saved: ${outputFilePath}`);
                    } catch (error) {
                        console.error("\u001B[31m%s\u001B[0m", `Failed to compress ${normalizedRelativePath}:`, error.message);
                    }
                } else {
                    // Resize and compress images based on sizes
                    for (const size of sizes) {
                        const targetWidth = size === 0 ? metadata.width : size;
                        const outputFileName = `${id}-${title}-x${targetWidth}.${targetFormat}`;
                        const outputFilePath = path.join(targetDir, outputFileName);

                        console.log("\u001B[34m%s\u001B[0m", `Processing ${normalizedRelativePath} -> ${outputFileName}`);
                        try {
                            let pipeline = sharp(filePath);
                            if (size !== 0) {
                                pipeline = pipeline.resize({ width: size });
                            }

                            await pipeline
                                .toFormat(targetFormat, { quality: 85 })
                                .toFile(outputFilePath);
                            console.log("\u001B[32m%s\u001B[0m", `Saved: ${outputFilePath}`);
                        } catch (error) {
                            console.error("\u001B[31m%s\u001B[0m", `Failed to process ${normalizedRelativePath} at size ${size}:`, error.message);
                        }
                    }
                }
            } else {
                // Handle WebP and SVG files (copying with correct naming)
                //if (['webp', 'svg'].includes(metadata.format?.toLowerCase())) {
                    const size = metadata.width;
                    const fileExtension = `.${metadata.format?.toLowerCase()}`;
                    const outputFileName = `${id}-${title}-x${size}${fileExtension}`;
                    const outputFilePath = path.join(targetDir, outputFileName);

                    console.log("\u001B[32m%s\u001B[0m", `Copying file: ${normalizedRelativePath} -> ${outputFileName}`);
                    try {
                        await fs.copyFile(filePath, outputFilePath);
                        console.log("\u001B[32m%s\u001B[0m", `Saved: ${outputFilePath}`);
                    } catch (error) {
                        console.error("\u001B[31m%s\u001B[0m", `Failed to copy ${normalizedRelativePath}:`, error.message);
                    }
                    continue;
                //}
            }
        }

        console.log("\u001B[32m%s\u001B[0m", 'Conversion complete.');
    } catch (error) {
        console.error("\u001B[31m%s\u001B[0m", 'Error during conversion:', error);
    }
}
