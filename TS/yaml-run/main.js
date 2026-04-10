#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run

import yaml from "npm:js-yaml@^4.1.1";
import { CONFIG_FILES } from './lib/constants.js';
import { loadVariables } from './lib/config.js';
import { runTask } from './lib/executor.js';
import { printStatsSummary } from './lib/stats.js';

// --- Main Execution Entry ---
async function main() {
    const startTotal = Date.now();
    const args = Deno.args;
    if (args.length === 0) {
        console.error('Usage: yaml-run <task_name>');
        return 1;
    }

    const taskName = args[0];

    try {
        try {
            await Deno.stat(CONFIG_FILES.scripts);
        } catch {
            throw new Error('scripts.yaml not found in current directory.');
        }

        const scriptConfig = yaml.load(await Deno.readTextFile(CONFIG_FILES.scripts))?.scripts || {};
        const variables = await loadVariables();

        await runTask(taskName, scriptConfig, variables);
        return 0;

    } catch (err) {
        console.error(`\x1b[31m[Error] ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
        return 1;
    } finally {
        printStatsSummary(Date.now() - startTotal);
    }
}

const exitCode = await main();
Deno.exit(exitCode);
