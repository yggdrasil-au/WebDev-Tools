import fg from 'npm:fast-glob@3.3.3'
import { minify } from 'npm:html-minifier-terser@7.2.0'
import { Engine } from 'php-parser'

// Initialize the PHP Parser Engine
const phpEngine = new Engine({
    parser: { extractDoc: false },
    ast: { withPositions: false }
});

// --- Helpers ---

/**
 * Minifies PHP blocks locally without requiring the PHP binary.
 * Tokenizes the content and filters out comments and excess whitespace.
 */
function minifyPhpLocally(content: string): string {
    try {
        const tokens = phpEngine.tokenGetAll(content);
        let output = '';

        for (const token of tokens) {
            if (Array.isArray(token)) {
                const [name, value] = token;

                // Skip all types of comments
                if (name === 'T_COMMENT' || name === 'T_DOC_COMMENT') {
                    continue;
                }

                // Collapse whitespace to a single space
                if (name === 'T_WHITESPACE') {
                    output += ' ';
                    continue;
                }

                output += value;
            } else {
                // Literals/characters that aren't wrapped in token arrays (like ';' or '{')
                output += token;
            }
        }

        // Final cleanup: remove double spaces and fix spacing around PHP tags
        return output
            .replace(/[ \t]+/g, ' ')
            .replace(/\s+\?>/g, '?>')
            .replace(/<\?php\s+/g, '<?php ');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`PHP Tokenization failed: ${msg}`);
    }
}

function formatTime(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const sec = s % 60
    if (m === 0) return `${s}.${Math.round((ms % 1000) / 100)}s`
    return `${m}m ${sec}s`
}

function getConcurrency(val?: string | boolean): number {
    const cpuCount = navigator.hardwareConcurrency;
    let concurrency: number;

    if (val === undefined || val === true) {
        return Math.max(1, Math.round(cpuCount / 2));
    }

    if (typeof val === 'string' && val.startsWith('cpu')) {
        if (val === 'cpu') {
            concurrency = cpuCount;
        } else {
            const diff = parseInt(val.replace('cpu', ''), 10);
            concurrency = !isNaN(diff) ? cpuCount + diff : 1;
        }
    } else {
        const parsed = parseInt(String(val), 10);
        concurrency = isNaN(parsed) ? 1 : parsed;
    }

    return Math.max(1, concurrency);
}

class ProgressBar {
    total: number;
    current: number = 0;
    success: number = 0;
    fail: number = 0;
    startTime: number = Date.now();
    isTTY: boolean;

    constructor(total: number) {
        this.total = total;
        this.isTTY = Deno.stdout.isTerminal();
    }

    update(success: boolean) {
        this.current++;
        if (success) this.success++;
        else this.fail++;

        if (this.isTTY) {
            this.render();
        } else if (this.current % 100 === 0 || this.current === this.total) {
            console.log(`Progress: ${this.current}/${this.total} (Success: ${this.success}, Fail: ${this.fail})`);
        }
    }

    render() {
        const percentage = Math.round((this.current / this.total) * 100);
        const elapsed = Date.now() - this.startTime;
        const rate = this.current > 0 ? this.current / elapsed : 0;
        const etaMs = rate > 0 ? (this.total - this.current) / rate : 0;

        const barLength = 20;
        const filledLength = Math.round((barLength * this.current) / this.total);
        const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

        const status = `[${bar}] ${percentage}% | ${this.current}/${this.total} | ✅ ${this.success} ❌ ${this.fail} | Time: ${formatTime(elapsed)} | ETA: ${formatTime(etaMs)}`;

        const encoder = new TextEncoder();
        Deno.stdout.writeSync(encoder.encode(`\x1b[2K\r${status}`));
    }

    finish() {
        if (this.isTTY) {
            this.render();
            Deno.stdout.writeSync(new TextEncoder().encode('\n'));
        }
        const totalTime = Date.now() - this.startTime;
        console.log(`\nDone in ${formatTime(totalTime)}.`);
        console.log(`Results: ${this.success} successful, ${this.fail} failed.`);
    }
}

async function minifyOne(file: string, logInfo = true): Promise<boolean> {
    if (logInfo) console.log(`Processing ${file}...`)
    let content: string;
    try {
        content = await Deno.readTextFile(file);
    } catch (e) {
        if (logInfo) console.error(`Error reading ${file}:`, e);
        return false;
    }

    // 1. Minify PHP Logic (Now Local/Native)
    if (file.endsWith('.phtml') || file.endsWith('.php') || file.endsWith('.shtml') || content.includes('<?php')) {
        try {
            content = minifyPhpLocally(content);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (logInfo) console.warn(`Warning: PHP minification skipped for ${file}. Error: ${msg}`);
        }
    }

    // 2. Minify HTML/CSS/JS
    try {
        const result = await minify(content, {
            collapseWhitespace: true,
            removeComments: true,
            minifyCSS: true,
            minifyJS: true,
            ignoreCustomFragments: [ /<\?php[\s\S]*?\?>/ ],
            keepClosingSlash: true,
            caseSensitive: true,
            includeAutoGeneratedTags: false
        })

        await Deno.writeTextFile(file, result);
        if (logInfo) console.log(`Minified: ${file}`)
        return true;
    } catch (e) {
        if (logInfo) console.error(`Error minifying HTML in ${file}:`, e)
        return false;
    }
}

async function processBatch(files: string[], concurrency: number) {
    const total = files.length;
    console.log(`Processing ${total} files with concurrency: ${concurrency}`);

    const progressBar = new ProgressBar(total);
    const results: Promise<void>[] = [];
    const executing: Promise<void>[] = [];

    for (const file of files) {
        const p = minifyOne(file, false).then((success) => {
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
    const args = Deno.args;
    const inputDirs: string[] = [];
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
        console.error('Error: No input directories specified. Usage: deno task start --inputDir <path> [--parallel [val]]');
        Deno.exit(1);
    }

    const patterns = inputDirs.map(dir => {
        const cleanDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
        return `${cleanDir}/**/*.{html,phtml,htm,shtml}`;
    });

    console.log(`Searching for files in: ${inputDirs.join(', ')}`);

    const files = await fg(patterns);

    if (files.length === 0) {
        console.log('No HTML/PHTML files found to minify.');
        return;
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
    await run();
} catch (error) {
    console.error(error);
    Deno.exit(1);
}