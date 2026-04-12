#!/usr/bin/env -S deno run --allow-read --allow-run --allow-write

import path from 'node:path';

const ROOT_DIR: string = Deno.cwd();
const SOURCE_DIR: string = path.resolve(ROOT_DIR, 'source/html');
const DIST_DIR: string = path.resolve(ROOT_DIR, 'www/dist');
const WEBSITE_DIR: string = path.resolve(ROOT_DIR, 'www/website');

function protectPHP(content: string): string {
    return content.replace(/<\?php([\s\S]*?)\?>/g, '<!--?php$1?-->');
}

function restorePHP(content: string): string {
    return content.replace(/<!--\?php([\s\S]*?)\?-->/g, '<?php$1?>');
}

async function listFilesWithExtension(
    directory: string,
    extension: string
): Promise<string[]> {
    const files: string[] = [];

    try {
        for await (const entry of Deno.readDir(directory)) {
            const fullPath: string = path.join(directory, entry.name);

            if (entry.isDirectory) {
                const nestedFiles: string[] = await listFilesWithExtension(fullPath, extension);
                files.push(...nestedFiles);
            } else if (entry.isFile && fullPath.endsWith(extension)) {
                files.push(fullPath);
            }
        }
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return files;
        }

        throw error;
    }

    return files;
}

async function copyDirectoryContents(
    sourceDirectory: string,
    destinationDirectory: string
): Promise<void> {
    const sourceRoot: string = path.resolve(sourceDirectory);
    const destinationRoot: string = path.resolve(destinationDirectory);

    if (sourceRoot === destinationRoot) {
        throw new Error(`Refusing to copy a directory into itself: ${sourceRoot}`);
    }

    await Deno.mkdir(destinationRoot, { recursive: true });

    for await (const entry of Deno.readDir(sourceRoot)) {
        const sourcePath: string = path.join(sourceRoot, entry.name);
        const destinationPath: string = path.join(destinationRoot, entry.name);

        if (entry.isDirectory) {
            await copyDirectoryContents(sourcePath, destinationPath);
        } else if (entry.isFile) {
            await Deno.copyFile(sourcePath, destinationPath);
        }
    }
}

async function protectSourceFiles(): Promise<void> {
    const sourceFiles: string[] = await listFilesWithExtension(SOURCE_DIR, '.astro');

    for (const filePath of sourceFiles) {
        const content: string = await Deno.readTextFile(filePath);
        const protectedContent: string = protectPHP(content);

        if (content !== protectedContent) {
            await Deno.writeTextFile(filePath, protectedContent);
            console.log(`[PreBuild] Protected PHP in ${filePath}`);
        }
    }

    console.log('[PreBuild] Completed PHP protection in source files.');
}

async function restoreSourceFiles(): Promise<void> {
    const sourceFiles: string[] = await listFilesWithExtension(SOURCE_DIR, '.astro');

    for (const filePath of sourceFiles) {
        const content: string = await Deno.readTextFile(filePath);
        const restoredContent: string = restorePHP(content);

        if (content !== restoredContent) {
            await Deno.writeTextFile(filePath, restoredContent);
            console.log(`[PostBuild] Restored PHP in ${filePath}`);
        }
    }
}

async function postProcessWebsiteOutput(): Promise<void> {
    await copyDirectoryContents(DIST_DIR, WEBSITE_DIR);
    console.log('[PostBuild] Copied www/dist to www/website');

    const websiteFiles: string[] = await listFilesWithExtension(WEBSITE_DIR, '.html');

    for (const filePath of websiteFiles) {
        const originalContent: string = await Deno.readTextFile(filePath);
        const restoredContent: string = restorePHP(originalContent);

        if (originalContent === restoredContent) {
            console.log(`[PostBuild] Skipped (no PHP tags) ${filePath}`);
            continue;
        }

        const destinationPath: string = filePath.replace(/\.html$/, '.phtml');
        await Deno.writeTextFile(destinationPath, restoredContent);
        await Deno.remove(filePath);
        console.log(`[PostBuild] Converted and restored PHP in ${destinationPath}`);
    }

    console.log('[PostBuild] Completed post-build processing.');
}

async function preBuild(): Promise<void> {
    await protectSourceFiles();
}

async function postBuild(): Promise<void> {
    let buildOutputExists: boolean = false;

    try {
        const stat = await Deno.stat(DIST_DIR);
        buildOutputExists = stat.isDirectory;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            buildOutputExists = false;
        } else {
            throw error;
        }
    }

    if (!buildOutputExists) {
        throw new Error(`Build output not found at ${DIST_DIR}. Run the build first.`);
    }

    await postProcessWebsiteOutput();
    await restoreSourceFiles();
}

async function runFullBuild(): Promise<void> {
    await preBuild();

    console.log('[FullBuild] Running Astro build...');
    const command = new Deno.Command('astro', {
        args: ['build'],
        cwd: ROOT_DIR,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
    });

    const status = await command.spawn().status;

    if (!status.success) {
        throw new Error(`Astro build failed with exit code ${status.code}`);
    }

    await postBuild();
}

function printUsage(): void {
    console.log('Usage: build-php [pre|post|full]');
}

async function main(): Promise<void> {
    const command: string | undefined = Deno.args[0];

    switch (command) {
        case 'pre': {
            await preBuild();
            break;
        }
        case 'post': {
            await postBuild();
            break;
        }
        case 'full': {
            await runFullBuild();
            break;
        }
        default: {
            printUsage();
            break;
        }
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        const message: string = error instanceof Error ? error.message : String(error);
        console.error('[build-php] Failed:', message);
        Deno.exit(1);
    }
}