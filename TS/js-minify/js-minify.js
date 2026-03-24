#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { minify } from 'terser'

async function minifyOne(file, noSourcemap, deleteSource) {
    const mapPath = `${file}.map`
    const outFile = file.replace(/\.js$/i, '.min.js')
    const outMapName = path.basename(file).replace(/\.js$/i, '.min.js.map')

    // Ensure output directory exists (mirrors input structure)
    fs.mkdirSync(path.dirname(outFile), { recursive: true })

    const code = fs.readFileSync(file, 'utf8')
    const prevMap = fs.existsSync(mapPath) ? fs.readFileSync(mapPath, 'utf8') : undefined

    const minifyOptions = {
        compress: { passes: 2 },
        mangle: true,
        format: { comments: /^!/ },
    }

    if (!noSourcemap) {
        minifyOptions.sourceMap = {
            content: prevMap,
            filename: path.basename(outFile),
            url: outMapName,
        }
    }

    const result = await minify(code, minifyOptions)

    if (!result || typeof result.code !== 'string') {
        throw new Error(`Terser failed to produce output for ${file}`)
    }

    fs.writeFileSync(outFile, result.code, 'utf8')
    if (!noSourcemap && result.map) {
        fs.writeFileSync(`${outFile}.map`, result.map, 'utf8')
    }
    console.log(`Minified: ${file} -> ${outFile}`)

    if (deleteSource) {
        try {
            fs.unlinkSync(file)
            if (fs.existsSync(mapPath)) {
                fs.unlinkSync(mapPath)
            }
            console.log(`Deleted source: ${file}`)
        } catch (err) {
            console.error(`Failed to delete source: ${file}`, err)
        }
    }
}

async function run() {
    const args = process.argv.slice(2);
    const inputDirs = [];
    let noSourcemap = false;
    let deleteSource = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--inputDir') {
            if (i + 1 < args.length) {
                inputDirs.push(args[i + 1]);
                i++;
            }
        } else if (args[i] === '--no-sourcemap' || args[i] === '--no-source-map') {
            noSourcemap = true;
        } else if (args[i] === '--delete-source') {
            deleteSource = true;
        }
    }

    if (inputDirs.length === 0) {
        console.error('Error: No input directories specified. Usage: js-minify --inputDir <path> [--inputDir <path> ...] [--no-sourcemap] [--delete-source]');
        process.exit(1);
    }

    console.log(`Searching for files in: ${inputDirs.join(', ')}`);
    console.log(`Options: Source Maps: ${!noSourcemap}, Delete Source: ${deleteSource}`);

    const patterns = inputDirs.flatMap(dir => {
        const cleanDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
        return [`${cleanDir}/**/*.js`, `!${cleanDir}/**/*.min.js`];
    });

    const files = await fg(patterns)
    for (const file of files) {
        await minifyOne(file, noSourcemap, deleteSource)
    }
}

try {
    await run()
} catch (error) {
    console.error(error)
    process.exitCode = 1
}
