#!/usr/bin/env node

import fs from 'node:fs';
import yaml from 'js-yaml';
import { CONFIG_FILES } from './lib/constants.js';
import { loadVariables } from './lib/config.js';
import { runTask } from './lib/executor.js';
import { printStatsSummary } from './lib/stats.js';

// --- Main Execution Entry ---
async function main() {
    const startTotal = Date.now();
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('Usage: yaml-run <task_name>');
        process.exit(1);
    }

    const taskName = args[0];

    try {
        if (!fs.existsSync(CONFIG_FILES.scripts)) {
            throw new Error('scripts.yaml not found in current directory.');
        }

        const scriptConfig = yaml.load(fs.readFileSync(CONFIG_FILES.scripts, 'utf8'))?.scripts || {};
        const variables = await loadVariables();

        await runTask(taskName, scriptConfig, variables);

    } catch (err) {
        console.error(`\x1b[31m[Error] ${err.message}\x1b[0m`);
        process.exitCode = 1;
    } finally {
        printStatsSummary(Date.now() - startTotal);
    }
}

main();
