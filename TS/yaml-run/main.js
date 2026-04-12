#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run

import yaml from "npm:js-yaml@^4.1.1";
import { createConfigFiles, findSiteRoot } from './lib/constants.js';
import { loadVariables } from './lib/config.js';
import { buildToolCatalog } from './lib/resolution.js';
import { isShutdownRequested, requestShutdown, runTask, waitForShutdown } from './lib/executor.js';
import { validateScripts } from './lib/validation.js';
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
    let interrupted = false;

    const onSignal = () => {
        if (!interrupted) {
            interrupted = true;
            console.warn('\x1b[33m[Interrupted] Stopping active tasks...\x1b[0m');
        }

        requestShutdown();
    };

    Deno.addSignalListener('SIGINT', onSignal);
    Deno.addSignalListener('SIGTERM', onSignal);

    try {
        const siteRoot = await findSiteRoot(Deno.cwd());
        const configFiles = createConfigFiles(siteRoot);
        const scriptConfig = yaml.load(await Deno.readTextFile(configFiles.scripts))?.scripts || {};
        const variables = await loadVariables(siteRoot);
        const toolCatalog = await buildToolCatalog(siteRoot);

        const validationWarnings = validateScripts({
            siteRoot,
            scripts: scriptConfig,
            variables,
            toolCatalog,
        });

        for (const warning of validationWarnings) {
            console.warn(`\x1b[33m[Warning] ${warning.scriptName} :: ${warning.stepPath} - ${warning.message}\x1b[0m`);
        }

        await runTask(taskName, {
            siteRoot,
            scripts: scriptConfig,
            variables,
            toolCatalog,
        });

        return isShutdownRequested() || interrupted ? 130 : 0;

    } catch (err) {
        if (isShutdownRequested() || interrupted) {
            return 130;
        }

        console.error(`\x1b[31m[Error] ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
        return 1;
    } finally {
        if (isShutdownRequested() || interrupted) {
            await waitForShutdown();
        }

        Deno.removeSignalListener('SIGINT', onSignal);
        Deno.removeSignalListener('SIGTERM', onSignal);
        printStatsSummary(Date.now() - startTotal);
    }
}

const exitCode = await main();
Deno.exit(exitCode);
