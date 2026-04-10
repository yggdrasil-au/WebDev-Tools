#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run --allow-write
import fs from 'node:fs'
import path from 'node:path'

import { nodeResolve } from 'npm:@rollup/plugin-node-resolve@^16.0.3'
import typescript from 'npm:@rollup/plugin-typescript@^12.3.0'
import { rollup } from 'npm:rollup@^4.59.0'
import type { Plugin } from 'npm:rollup@^4.59.0'

interface PackageBannerConfig {
    banner?: string
}

interface PackageJson {
    buildConfig?: PackageBannerConfig
}

interface TypeScriptPluginOptions {
    tsconfig: string
    sourceMap: boolean
}

const root: string = Deno.cwd()
const pkgPath: string = path.resolve(root, 'package.json')

if (!fs.existsSync(pkgPath)) {
    console.error('Error: package.json not found in current directory.')
    Deno.exit(1)
}

const pkg: PackageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as PackageJson
const year: number = new Date().getFullYear()
const srcDir: string = path.resolve(root, 'source/ts')
const outDir: string = path.resolve(root, 'www/dist/js')
const noSourceMap: boolean = Deno.args.includes('--no-source-map') || Deno.args.includes('--no-sourcemap')
const createTypeScriptPlugin = typescript as unknown as (options: TypeScriptPluginOptions) => Plugin

function getBanner(packageJson: PackageJson): string {
    if (!packageJson.buildConfig || !packageJson.buildConfig.banner) {
        return ''
    }

    const banner: string = packageJson.buildConfig.banner

    return banner.replace(/\$\{(.+?)\}/g, (match: string, token: string) => {
        if (token === 'year') {
            return String(year)
        }

        const keys: string[] = token.split('.')
        let value: unknown = packageJson as unknown

        for (const key of keys) {
            if (value && typeof value === 'object' && key in (value as Record<string, unknown>)) {
                value = (value as Record<string, unknown>)[key]
            } else {
                return match
            }
        }

        return typeof value === 'string' ? value : String(value)
    })
}

const banner: string = getBanner(pkg)

function findTSFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) {
        return []
    }

    let results: string[] = []
    const list: fs.Dirent[] = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of list) {
        const fullPath: string = path.join(dir, entry.name)

        if (entry.isDirectory()) {
            results = results.concat(findTSFiles(fullPath))
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.startsWith('_')) {
            results.push(fullPath)
        }
    }

    return results
}

async function buildFile(inputFile: string): Promise<void> {
    const relativePath: string = path.relative(srcDir, inputFile)
    const isServiceWorker: boolean = path.basename(inputFile) === 'service-worker.ts'
    const isRegisterSW: boolean = path.basename(inputFile) === 'register-service-worker.ts'
    let outputFile: string

    if (isServiceWorker) {
        outputFile = path.resolve(root, 'www/dist/service-worker.js')
    } else {
        outputFile = path.join(outDir, relativePath).replace(/\.ts$/, '.js')
    }

    fs.mkdirSync(path.dirname(outputFile), { recursive: true })

    const bundle = await rollup({
        input: inputFile,
        external: () => false,
        plugins: [
            nodeResolve({ browser: true }),
            createTypeScriptPlugin({
                tsconfig: path.resolve(root, 'tsconfig.json'),
                sourceMap: !noSourceMap,
            }),
        ],
        onwarn(warning, warn) {
            warn(warning)
        },
    })

    await bundle.write({
        file: outputFile,
        format: isServiceWorker ? 'iife' : (isRegisterSW ? 'esm' : 'umd'),
        inlineDynamicImports: true,
        banner,
        name: isServiceWorker ? 'ServiceWorker' : path.basename(inputFile, '.ts'),
        sourcemap: !noSourceMap,
    })

    console.log(`Built: ${inputFile} -> ${outputFile}`)
}

async function buildAll(): Promise<void> {
    const tsFiles: string[] = findTSFiles(srcDir)

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
    Deno.exit(1)
}