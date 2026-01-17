#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { getConfiguration } from './src/config/loader.mjs';
import { Deployer } from './src/core/deployer.mjs';

// Global error handler
process.on('unhandledRejection', (err) => {
    console.error('[deploy] Unhandled Rejection:', err.message || err);
    process.exit(1);
});

async function main() {
    const { config, dryRun, listMode, availableProfiles } = await getConfiguration();

    if (listMode) {
        console.log('[deploy] Available deployments:', availableProfiles.join(', '));
        process.exit(0);
    }

    if (dryRun) {
        console.log(`[deploy] DRY RUN`);
        console.log(`- Strategy: ${config.strategy} | Transfer: ${config.transfer}`);
        if (config.transfer === 'tar') console.log(`- Batching: ${config.batchSizeMB > 0 ? config.batchSizeMB + 'MB' : 'None (Single Tar)'} | Concurrency: ${config.concurrency}`);
        console.log(`- Local: ${config.localDir}`);
        console.log(`- Remote: ${config.remoteDir}`);
        process.exit(0);
    }

    // Validation
    if (!fs.existsSync(config.localDir)) {
        console.error(`Local dir not found: ${config.localDir}`);
        process.exit(1);
    }
    if (!config.remoteDir) {
        console.error('remoteDir is required');
        process.exit(1);
    }

    if (config.transfer === 'tar') {
        try {
        await new Promise((resolve, reject) => {
            execFile('tar', ['--version'], (err) => err ? reject(new Error('Local "tar" command not found')) : resolve());
        });
        } catch (e) {
            console.error(e.message);
            process.exit(1);
        }
    }

    const deployer = new Deployer(config);
    try {
        await deployer.run();
    } catch (e) {
        console.error('[deploy] Failed:', e.message);
        process.exit(1);
    }
}

main();
