#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { minify } from 'terser'

async function minifyOne(file) {
    const mapPath = `${file}.map`
    const outFile = file.replace(/\.js$/i, '.min.js')
    const outMapName = path.basename(file).replace(/\.js$/i, '.min.js.map')

    // Ensure output directory exists (mirrors input structure)
    fs.mkdirSync(path.dirname(outFile), { recursive: true })

    const code = fs.readFileSync(file, 'utf8')
    const prevMap = fs.existsSync(mapPath) ? fs.readFileSync(mapPath, 'utf8') : undefined

    const result = await minify(code, {
        compress: { passes: 2 },
        mangle: true,
        format: { comments: /^!/ },
        sourceMap: {
            content: prevMap,
            filename: path.basename(outFile),
            url: outMapName,
        },
    })

    if (!result || typeof result.code !== 'string') {
        throw new Error(`Terser failed to produce output for ${file}`)
    }

    fs.writeFileSync(outFile, result.code, 'utf8')
    if (result.map) {
        fs.writeFileSync(`${outFile}.map`, result.map, 'utf8')
    }
    console.log(`Minified: ${file} -> ${outFile}`)
}

async function run() {
    const args = process.argv.slice(2);
    const inputDirs = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--inputDir') {
            if (i + 1 < args.length) {
                inputDirs.push(args[i + 1]);
                i++;
            }
        }
    }

    if (inputDirs.length === 0) {
        console.error('Error: No input directories specified. Usage: js-minify --inputDir <path> [--inputDir <path> ...]');
        process.exit(1);
    }

    console.log(`Searching for files in: ${inputDirs.join(', ')}`);

    const patterns = inputDirs.flatMap(dir => {
        const cleanDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
        return [`${cleanDir}/**/*.js`, `!${cleanDir}/**/*.min.js`];
    });

    const files = await fg(patterns)
    for (const file of files) {
        await minifyOne(file)
    }
}

try {
    await run()
} catch (error) {
    console.error(error)
    process.exitCode = 1
}
