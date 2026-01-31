import { convertImages } from './index.js';

(async () => {
    const args = process.argv.slice(2);

    let inputDir = './source/assets/images/Source';       // Default directory containing the source images
    let outputDir = './source/assets/images/prod';     // Default directory where converted images will be saved
    let configPath = './source/assets/images/webp.json'; // Default path to the JSON configuration file

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--inputDir':
                inputDir = args[++i];
                break;
            case '--outputDir':
                outputDir = args[++i];
                break;
            case '--configPath':
                configPath = args[++i];
                break;
        }
    }

    await convertImages(inputDir, outputDir, configPath);
})();
