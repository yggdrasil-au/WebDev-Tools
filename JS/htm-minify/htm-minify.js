#!/usr/bin/env node
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import readline from 'node:readline'
import fg from 'fast-glob'
import { minify } from 'html-minifier-terser'

const execAsync = promisify(exec)

// --- Helpers ---

function formatTime(ms) {
    if (ms < 1000) return `${ms}ms`
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const sec = s % 60
    if (m === 0) return `${s}.${Math.round((ms % 1000) / 100)}s`
    return `${m}m ${sec}s`
}

function getConcurrency(val) {
    const cpuCount = os.cpus().length;
    let concurrency;

    if (val === undefined || val === true) {
        // Default: Half of CPUs, at least 1
        return Math.max(1, Math.round(cpuCount / 2));
    }

    if (typeof val === 'string' && val.startsWith('cpu')) {
        if (val === 'cpu') {
            concurrency = cpuCount;
        } else {
            // Handle "cpu-1", "cpu+2" etc.
            const diff = parseInt(val.replace('cpu', ''), 10);
            if (!isNaN(diff)) {
                concurrency = cpuCount + diff;
            } else {
                concurrency = 1;
            }
        }
    } else {
        const parsed = parseInt(val, 10);
        concurrency = isNaN(parsed) ? 1 : parsed;
    }

    return Math.max(1, concurrency);
}

class ProgressBar {
    constructor(total) {
        this.total = total;
        this.current = 0;
        this.success = 0;
        this.fail = 0;
        this.startTime = Date.now();
        this.isTTY = process.stdout.isTTY;
    }

    update(success) {
        this.current++;
        if (success) this.success++;
        else this.fail++;

        if (this.isTTY) {
            this.render();
        } else if (this.current % 100 === 0 || this.current === this.total) {
            // Log every 100 items if not TTY (e.g. CI)
            console.log(`Progress: ${this.current}/${this.total} (Success: ${this.success}, Fail: ${this.fail})`);
        }
    }

    render() {
        const percentage = Math.round((this.current / this.total) * 100);
        const elapsed = Date.now() - this.startTime;
        const rate = this.current > 0 ? this.current / elapsed : 0; // items per ms
        const etaMs = rate > 0 ? (this.total - this.current) / rate : 0;
        
        const barLength = 20;
        const filledLength = Math.round((barLength * this.current) / this.total);
        const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
        
        const status = `[${bar}] ${percentage}% | ${this.current}/${this.total} | ✅ ${this.success} ❌ ${this.fail} | Time: ${formatTime(elapsed)} | ETA: ${formatTime(etaMs)}`;

        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(status);
    }

    finish() {
        if (this.isTTY) {
            this.render();
            process.stdout.write('\n');
        }
        const totalTime = Date.now() - this.startTime;
        console.log(`\nDone in ${formatTime(totalTime)}.`);
        console.log(`Results: ${this.success} successful, ${this.fail} failed.`);
    }
}

async function minifyOne(file, logInfo = true) {
    if (logInfo) console.log(`Processing ${file}...`)
    let content;
    try {
        content = await fsPromises.readFile(file, 'utf8')
    } catch (e) {
        if (logInfo) console.error(`Error reading ${file}:`, e);
        return false;
    }

    // 1. Minify PHP (if present)
    // We use php -w to strip comments and whitespace from PHP blocks.
    // This requires PHP to be installed and in the PATH.
    if (file.endsWith('.phtml') || file.endsWith('.php') || file.endsWith('.shtml') || content.includes('<?php')) {
        let tempFile = file + '.temp.php';
        try {
            await fsPromises.writeFile(tempFile, content);

            // Run php -w using execAsync
            // We capture stdout.
            const { stdout } = await execAsync(`php -w "${tempFile}"`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

            if (stdout) {
                content = stdout;
            }
        } catch (e) {
            if (logInfo) console.warn(`Warning: Failed to minify PHP in ${file}. Continuing with HTML minification only. Error: ${e.message}`);
        } finally {
            try {
                await fsPromises.unlink(tempFile);
            } catch (unlinkErr) {
                if (unlinkErr.code !== 'ENOENT') {
                    // ignore
                }
            }
        }
    }

    // 2. Minify HTML/CSS/JS
    try {
        const result = await minify(content, {
            collapseWhitespace: true,
            removeComments: true,
            minifyCSS: true,
            minifyJS: true,
            ignoreCustomFragments: [ /<\?php[\s\S]*?\?>/ ], // Ignore PHP blocks so html-minifier doesn't mangle them
            keepClosingSlash: true,
            caseSensitive: true,
            includeAutoGeneratedTags: false // Prevent inserting tags that might break PHP structure
        })

        await fsPromises.writeFile(file, result, 'utf8')
        if (logInfo) console.log(`Minified: ${file}`)
        return true;
    } catch (e) {
        if (logInfo) console.error(`Error minifying HTML in ${file}:`, e)
        return false;
    }
}

async function processBatch(files, concurrency) {
    const total = files.length;
    console.log(`Processing ${total} files with concurrency: ${concurrency}`);
    
    const progressBar = new ProgressBar(total);
    const results = [];
    const executing = [];
    
    for (const file of files) {
        const p = minifyOne(file, false).then(success => {
            progressBar.update(success);
            executing.splice(executing.indexOf(p), 1);
        });
        
        results.push(p);
        executing.push(p);
        
        if (executing.length >= concurrency) {
            await Promise.race(executing);
        }
    }
    
    await Promise.all(results);
    progressBar.finish();
}

async function run() {
    const args = process.argv.slice(2);
    const inputDirs = [];
    let concurrency = 1;
    let parallelFlagFound = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--inputDir') {
            if (i + 1 < args.length) {
                inputDirs.push(args[i + 1]);
                i++;
            }
        } else if (args[i] === '--parallel') {
             parallelFlagFound = true;
             // Check if next arg is a value or another flag
             const nextArg = args[i + 1];
             if (nextArg && !nextArg.startsWith('--')) {
                 concurrency = getConcurrency(nextArg);
                 i++;
             } else {
                 concurrency = getConcurrency();
             }
        }
    }

    if (inputDirs.length === 0) {
        console.log('No input directories specified. Use --inputDir <path>. Defaulting to www/dist for backward compatibility if needed, or exiting.');
        // For safety, let's require the argument as requested.
        console.error('Error: No input directories specified. Usage: htm-minify --inputDir <path> [--parallel [val]]');
        process.exit(1);
    }

    const patterns = inputDirs.map(dir => {
        // Normalize path separators to forward slashes for fast-glob
        const cleanDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
        return `${cleanDir}/**/*.{html,phtml,htm,shtml}`;
    });

    console.log(`Searching for files in: ${inputDirs.join(', ')}`);

    // Look for html, phtml, htm, shtml in specified directories
    const files = await fg(patterns);

    if (files.length === 0) {
        console.log('No HTML/PHTML files found to minify.')
        return
    }

    if (parallelFlagFound) {
         await processBatch(files, concurrency);
    } else {
         for (const file of files) {
            await minifyOne(file, true);
         }
    }
}

try {
    await run()
} catch (error) {
    console.error(error)
    process.exitCode = 1
}
