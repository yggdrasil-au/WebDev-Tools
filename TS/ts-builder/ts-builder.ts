#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run --allow-write

/**
 * TS-Builder
 * A Deno script to bundle TypeScript files into browser-ready JS.
 * * Features:
 * - Recursive directory traversal.
 * - Supports custom banners with ${year} and ${version} templates.
 * - Source map toggling.
 * - Automatically ignores files starting with an underscore (e.g., _utils.ts).
 */

import fs from 'node:fs'
import path from 'node:path'

const root: string = Deno.cwd()
const year: number = new Date().getFullYear()

/**
 * Represents the configuration options parsed from CLI arguments.
 */
interface BuildOptions {
    banner: string;
    srcDir: string;
    outDir: string;
    noSourceMap: boolean;
}

/**
 * Parses command line arguments to configure the build process.
 * * @param args - Deno.args array
 * @returns Parsed BuildOptions object
 * @example ts-builder "/* v${version} *\/" -i ./src -o ./dist
 */
function getArgs(args: string[]): BuildOptions {
    let _banner: string | undefined
    let _srcDir: string | undefined
    let _outDir: string | undefined
    const noSourceMap: boolean = args.includes('--no-source-map') || args.includes('--no-sourcemap')

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--inputDir' || arg === '-i') {
            _srcDir = path.resolve(root, args[++i])
        } else if (arg === '--outputDir' || arg === '-o') {
            _outDir = path.resolve(root, args[++i])
        } else if (!arg.startsWith('-')) {
            // Treat non-flag arguments as part of the banner string
            _banner = (_banner ? _banner + ' ' : '') + arg
        }
    }

    return {
        banner: _banner || '',
        srcDir: _srcDir || path.resolve(root, 'source/ts'),
        outDir: _outDir || path.resolve(root, 'www/dist/js'),
        noSourceMap
    }
}

const { banner: bannerArgument, srcDir, outDir, noSourceMap } = getArgs(Deno.args)

if (!srcDir || !outDir) {
    console.error('Usage: ts-builder <banner> --inputDir <src> --outputDir <dist>')
    Deno.exit(1)
}

// Extract version from deno.jsonc if available
const denoConfigPath: string = path.resolve(root, 'deno.jsonc')
const denoConfigText: string = fs.existsSync(denoConfigPath) ? fs.readFileSync(denoConfigPath, 'utf-8') : ''
const siteVersionMatch: RegExpMatchArray | null = denoConfigText.match(/"version"\s*:\s*"([^"]+)"/)
const siteVersion: string | undefined = siteVersionMatch ? siteVersionMatch[1] : undefined

const banner: string = getBanner(bannerArgument ?? '')
const denoExecutable: string = Deno.execPath()

/**
 * Processes the banner template by replacing ${year} and ${version} tokens.
 */
function getBanner(bannerTemplate: string): string {
    if (!bannerTemplate) return ''

    return bannerTemplate.replace(/\$\{(.+?)\}/g, (match: string, token: string) => {
        if (token === 'year') return String(year)
        if (token === 'version') return siteVersion || match
        return match
    })
}

/**
 * Constructs the command line arguments for the 'deno bundle' subprocess.
 */
function createBundleArgs(inputFile: string, outputFile: string): string[] {
    const args: string[] = [
        'bundle',
        '--no-check',
        '--platform=browser',
        '--format=iife',
        '--packages=bundle',
        '--node-modules-dir=auto',
        '--output',
        outputFile,
    ]

    if (!noSourceMap) {
        args.push('--sourcemap=linked')
    }

    args.push(inputFile)
    return args
}

/**
 * Executes the bundling process for a single file and prepends the banner.
 */
async function bundleFile(inputFile: string, outputFile: string): Promise<void> {
    const command = new Deno.Command(denoExecutable, {
        args: createBundleArgs(inputFile, outputFile),
        stdout: 'piped',
        stderr: 'piped',
    })

    const result: Deno.CommandOutput = await command.output()

    if (result.code !== 0) {
        const stderr: string = new TextDecoder().decode(result.stderr).trim()
        const stdout: string = new TextDecoder().decode(result.stdout).trim()
        const details: string = stderr || stdout || `deno bundle failed with exit code ${result.code}`

        throw new Error(`Failed to bundle ${inputFile}.\n${details}`)
    }

    if (banner) {
        const bundledContent: string = fs.readFileSync(outputFile, 'utf-8')
        fs.writeFileSync(outputFile, `${banner}\n${bundledContent}`)
    }
}

/**
 * Recursively finds all .ts files in a directory.
 * Files starting with an underscore (_) are ignored (treated as private/partials).
 */
function findTSFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return []

    let results: string[] = []
    const list: fs.Dirent[] = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of list) {
        const fullPath: string = path.join(dir, entry.name)

        if (entry.isDirectory()) {
            results = results.concat(findTSFiles(fullPath))
        } else if (
            entry.isFile() &&
            entry.name.endsWith('.ts') &&
            !entry.name.startsWith('_')
        ) {
            results.push(fullPath)
        }
    }

    return results
}

/**
 * Maps an input TypeScript file to its output JavaScript destination and triggers bundling.
 */
async function buildFile(inputFile: string): Promise<void> {
    const relativePath: string = path.relative(srcDir, inputFile)
    const outputFile: string = path.join(outDir, relativePath).replace(/\.ts$/, '.js')

    // Ensure target directory exists before writing
    fs.mkdirSync(path.dirname(outputFile), { recursive: true })

    await bundleFile(inputFile, outputFile)
    console.log(`Built: ${inputFile} -> ${outputFile}`)
}

/**
 * Entry point: Finds all valid TS files and processes them.
 */
async function buildAll(): Promise<void> {
    const tsFiles: string[] = findTSFiles(srcDir)

    if (tsFiles.length === 0) {
        console.log(`No .ts files found in ${srcDir}`)
        return
    }

    for (const file of tsFiles) {
        await buildFile(file)
    }
}

// Execution block
try {
    await buildAll()
} catch (error) {
    console.error(error)
    Deno.exit(1)
}