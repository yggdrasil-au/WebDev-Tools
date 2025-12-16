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

        // Get all files in the source directory
        const files = await fs.readdir(inputDir);

        // Check if the input directory is empty
        if (files.length === 0) {
            console.warn("\u001B[33m%s\u001B[0m", `Input directory is empty: ${inputDir}`);
            return;
        }

        // Iterate over all files in the input directory
        for (const source of files) {
            const filePath = path.join(inputDir, source);
            const fileInfo = path.parse(source);

            // Validate that the source file exists
            try {
                await fs.access(filePath);
            } catch {
                console.warn("\u001B[33m%s\u001B[0m", `Source file not found: ${source}. Skipping.`);
                continue;
            }

            // Attempt to get metadata from the image
            let metadata;
            try {
                metadata = await sharp(filePath).metadata();
            } catch (error) {
                console.error("\u001B[31m%s\u001B[0m", `Metadata Error for ${source}: `, error.message);
                continue;
            }

            const detectedFormat = metadata.format ? metadata.format.toLowerCase() : 'unknown';
            const fileExt = fileInfo.ext.toLowerCase().replace('.', '');

            // Normalize jpg/jpeg for comparison
            const normalizedExt = fileExt === 'jpg' ? 'jpeg' : fileExt;
            const normalizedFormat = detectedFormat === 'jpg' ? 'jpeg' : detectedFormat;

            if (normalizedExt !== normalizedFormat) {
                console.warn("\u001B[31m%s\u001B[0m", `Warning: File extension (.${fileExt}) does not match detected format (${detectedFormat.toUpperCase()}) for file ${source}`);
            } else {
                console.log("\u001B[32m%s\u001B[0m", `File ${source} detected as ${detectedFormat.toUpperCase()} format.`);
            }

            // Extract the ID and title from the filename
            const nameParts = fileInfo.name.split('-Source-');
            const id = nameParts[0]; // ID is the first part of the filename
            const title = nameParts[1] ? nameParts[1] : ''; // Title is the second part after "-Source-" (if exists)

            // Filter supported image formats (excluding SVG)
            const supportedFormats = ['png', 'jpg', 'jpeg', 'webp'];
            if (supportedFormats.includes(metadata.format?.toLowerCase())) {
                // Check for custom sizes
                const customConfig = configData.find(config => config.source === source);
                let sizes = customConfig ? customConfig.sizes : [];

                if (customConfig) {
                     console.log("\u001B[36m%s\u001B[0m", `[Config Match] Found configuration for ${source}`);
                } else {
                     console.log("\u001B[33m%s\u001B[0m", `[No Config] No configuration found for ${source}, using default compression.`);
                }

                // If no sizes are specified, compress the original image
                if (sizes.length === 0) {
                    const outputFileName = `${id}-${title}-x${metadata.width}.webp`;
                    const outputFilePath = path.join(outputDir, outputFileName);

                    console.log("\u001B[34m%s\u001B[0m", `Compressing ${source} -> ${outputFileName}`);
                    try {
                        await sharp(filePath)
                            .toFormat('webp', { quality: 85 })
                            .toFile(outputFilePath);
                        console.log("\u001B[32m%s\u001B[0m", `Saved: ${outputFilePath}`);
                    } catch (error) {
                        console.error("\u001B[31m%s\u001B[0m", `Failed to compress ${source}:`, error.message);
                    }
                } else {
                    // Resize and compress images based on sizes
                    for (const size of sizes) {
                        const targetWidth = size === 0 ? metadata.width : size;
                        const outputFileName = `${id}-${title}-x${targetWidth}.webp`;
                        const outputFilePath = path.join(outputDir, outputFileName);

                        console.log("\u001B[34m%s\u001B[0m", `Processing ${source} -> ${outputFileName}`);
                        try {
                            let pipeline = sharp(filePath);
                            if (size !== 0) {
                                pipeline = pipeline.resize({ width: size });
                            }

                            await pipeline
                                .toFormat('webp', { quality: 85 })
                                .toFile(outputFilePath);
                            console.log("\u001B[32m%s\u001B[0m", `Saved: ${outputFilePath}`);
                        } catch (error) {
                            console.error("\u001B[31m%s\u001B[0m", `Failed to process ${source} at size ${size}:`, error.message);
                        }
                    }
                }
            } else {
                // Handle WebP and SVG files (copying with correct naming)
                //if (['webp', 'svg'].includes(metadata.format?.toLowerCase())) {
                    const size = metadata.width;
                    const fileExtension = `.${metadata.format?.toLowerCase()}`;
                    const outputFileName = `${id}-${title}-x${size}${fileExtension}`;
                    const outputFilePath = path.join(outputDir, outputFileName);

                    console.log("\u001B[32m%s\u001B[0m", `Copying file: ${source} -> ${outputFileName}`);
                    try {
                        await fs.copyFile(filePath, outputFilePath);
                        console.log("\u001B[32m%s\u001B[0m", `Saved: ${outputFilePath}`);
                    } catch (error) {
                        console.error("\u001B[31m%s\u001B[0m", `Failed to copy ${source}:`, error.message);
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
