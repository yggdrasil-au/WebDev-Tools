#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = './source/html';
const DIST_DIR = './www/website';
const WEBDIST_DIR = './www/website';

// Helper: recursively find files with extension
const findFiles = function findFiles(dir, ext) {
    let files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(findFiles(fullPath, ext));
        } else if (entry.isFile() && fullPath.endsWith(ext)) {
            files.push(fullPath);
        } else {
            // Other file types are ignored.
        }
    }
    return files;
};

// Protect PHP by commenting tags out
const protectPHP = function protectPHP(content) {
    return content.replace(/<\?php([\s\S]*?)\?>/g, '<!--?php$1?-->');
};

// Restore PHP by uncommenting
const restorePHP = function restorePHP(content) {
    return content.replace(/<!--\?php([\s\S]*?)\?-->/g, '<?php$1?>');
};

// Remove PHP comment blocks from static HTML
const cleanHtmlComments = function cleanHtmlComments(content) {
    return content.replace(/<!--\?php[\s\S]*?\?-->/g, '');
};

// Copy directory recursively (Node 16+)
const copyDirSync = function copyDirSync(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else if (entry.isFile()) {
            fs.copyFileSync(srcPath, destPath);
        } else {
            // Other types (like symlinks) are ignored.
        }
    }
};

// Pre-build: comment out PHP in source `.astro` files
const preBuild = function preBuild() {
    const files = findFiles(SRC_DIR, '.astro');
    for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        const protectedContent = protectPHP(content);
        if (content !== protectedContent) {
            fs.writeFileSync(file, protectedContent, 'utf8');
            console.log(`[PreBuild] Protected PHP in ${file}`);
        }
    }
    console.log('[PreBuild] Completed PHP protection in source files.');
};

// Post-build:
// 1. Copy www/dist -> www/webdist
// 2. In www/webdist: rename .html to .phtml and uncomment PHP
// 3. In www/dist: remove PHP comment blocks for clean static build
// 4. Restore PHP in source files
const postBuild = function postBuild() {
    // Step 1: Copy dist to webdist
    copyDirSync(DIST_DIR, WEBDIST_DIR);
    console.log('[PostBuild] Copied www/dist to www/webdist');

    // Step 2: Process webdist .html files -> .phtml + restore PHP
    const webFiles = findFiles(WEBDIST_DIR, '.html');
    for (const file of webFiles) {
        let content = fs.readFileSync(file, 'utf8');
        content = restorePHP(content);
        const newPath = file.replace(/\.html$/, '.phtml');
        fs.writeFileSync(newPath, content, 'utf8');
        fs.unlinkSync(file);
        console.log(`[PostBuild] Converted and restored PHP in ${newPath}`);
    }

    // Step 3: Clean dist HTML files from PHP comments
    /*const distFiles = findFiles(DIST_DIR, '.html');
    for (const file of distFiles) {
        const content = fs.readFileSync(file, 'utf8');
        const cleaned = cleanHtmlComments(content);
        if (content !== cleaned) {
            fs.writeFileSync(file, cleaned, 'utf8');
            console.log(`[PostBuild] Cleaned PHP comments in ${file}`);
        }
    }*/

    // Step 4: Restore PHP in source files
    // disable to always keep the php commented out in source files
    const srcFiles = findFiles(SRC_DIR, '.astro');
    for (const file of srcFiles) {
        const content = fs.readFileSync(file, 'utf8');
        const restored = restorePHP(content);
        if (content !== restored) {
            fs.writeFileSync(file, restored, 'utf8');
            console.log(`[PostBuild] Restored PHP in ${file}`);
        }
    }

    console.log('[PostBuild] Completed post-build processing.');
};

// Main CLI control
const main = async function main() {
    const arg = process.argv[2];
    switch (arg) {
        case 'pre': {
            preBuild();
            break;
        }
        case 'post': {
            postBuild();
            break;
        }
        case 'full': {
            preBuild();
            // Run Astro build
            const { execSync } = await import('node:child_process');
            console.log('[FullBuild] Running Astro build...');
            execSync('astro build', { stdio: 'inherit' });
            postBuild();
            break;
        }
        default: {
            console.log('Usage: node build-php.js [pre|post|full]');
            break;
        }
    }
};

main();
