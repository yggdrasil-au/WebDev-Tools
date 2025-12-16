#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { rollup } from 'rollup'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

// Read package.json from CWD
const pkgPath = path.resolve(process.cwd(), 'package.json')
if (!fs.existsSync(pkgPath)) {
    console.error('Error: package.json not found in current directory.')
    process.exit(1)
}
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))

const year = new Date().getFullYear()

function getBanner(pkg) {
    if (!pkg.buildConfig || !pkg.buildConfig.banner) {
        return ''
    }
    let banner = pkg.buildConfig.banner
    
    // Replace ${variable} with value from pkg
    return banner.replace(/\$\{(.+?)\}/g, (match, p1) => {
        if (p1 === 'year') return year;
        
        const keys = p1.split('.')
        let value = pkg
        for (const key of keys) {
            if (value && value[key] !== undefined) {
                value = value[key]
            } else {
                return match // undefined, keep original
            }
        }
        return value
    })
}

const banner = getBanner(pkg)

const srcDir = path.resolve(process.cwd(), 'source/ts')
const outDir = path.resolve(process.cwd(), 'www/dist/js')

// Recursively find .ts files
function findTSFiles(dir) {
    if (!fs.existsSync(dir)) {
        return []
    }
    let results = []
    const list = fs.readdirSync(dir, { withFileTypes: true })

    for (const file of list) {
        const fullPath = path.join(dir, file.name)
        if (file.isDirectory()) {
            results = results.concat(findTSFiles(fullPath))
        } else if (file.isFile() && file.name.endsWith('.ts') && !file.name.startsWith('_')) { // skip underscore-prefixed entry files
            results.push(fullPath)
        }
    }
    return results
}

async function buildFile(inputFile) {
    const relativePath = path.relative(srcDir, inputFile)
    const isServiceWorker = path.basename(inputFile) === 'service-worker.ts'
    let outputFile
    if (isServiceWorker) {
        outputFile = path.resolve(process.cwd(), 'www/dist/service-worker.js')
    } else {
        outputFile = path.join(outDir, relativePath).replace(/\.ts$/, '.js')
    }
    const name = path.basename(inputFile, '.ts')

    // Make sure output folder exists
    fs.mkdirSync(path.dirname(outputFile), { recursive: true })

    const bundle = await rollup({
        input: inputFile,
        // Bundle all imports so runtime doesn't expect globals
        external: () => false,
        plugins: [
            // Resolve ESM dependencies from node_modules when bundling loaders
            nodeResolve({ browser: true }),
            typescript({
                tsconfig: path.resolve(process.cwd(), 'tsconfig.json'),
                sourceMap: true,
            }),
        ],
        onwarn(warning, warn) {
            // Customize warnings here if you want
            warn(warning)
        },
    })

    const isRegisterSW = path.basename(inputFile) === 'register-service-worker.ts'
    await bundle.write({
        file: outputFile,
        // Service Worker should be a plain IIFE; register script as ESM; others UMD
        format: isServiceWorker ? 'iife' : (isRegisterSW ? 'esm' : 'umd'),
        inlineDynamicImports: true,
        banner,
        name: isServiceWorker ? 'ServiceWorker' : name,
        sourcemap: true,
    })

    console.log(`Built: ${inputFile} -> ${outputFile}`)
}

async function buildAll() {
    const tsFiles = findTSFiles(srcDir)
    if (tsFiles.length === 0) {
        console.log('No .ts files found in source/ts')
        return
    }
    for (const file of tsFiles) {
        await buildFile(file)
    }
}

try {
    await buildAll()
} catch (error) {
    console.error(error)
    process.exit(1)
}
