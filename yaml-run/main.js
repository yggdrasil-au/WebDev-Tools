#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';

// --- Configuration ---
const CWD = process.cwd();
const CONFIG_FILES = {
    vars: path.join(CWD, 'vars.yaml'),
    scripts: path.join(CWD, 'scripts.yaml')
};

// --- Helpers ---

/**
 * Flattens nested objects into dot-notation (e.g., {a: {b: 1}} -> "a.b": 1)
 */
function flattenVariables(obj, prefix = '', target = {}) {
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const val = obj[key];
            const newKey = prefix ? `${prefix}.${key}` : key;
            if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                flattenVariables(val, newKey, target);
            } else {
                target[newKey] = val;
            }
        }
    }
    return target;
}

/**
 * Loads and resolves variables from vars.yaml and its referenced sources
 */
async function loadVariables() {
    if (!fs.existsSync(CONFIG_FILES.vars)) return {};

    const rawConfig = yaml.load(fs.readFileSync(CONFIG_FILES.vars, 'utf8')) || {};
    const mergedData = {};

    // 1. Process "sources" (external files)
    if (rawConfig.sources) {
        for (const [scope, filePath] of Object.entries(rawConfig.sources)) {
            const absolutePath = path.resolve(CWD, filePath);
            
            if (!fs.existsSync(absolutePath)) {
                console.warn(`[yaml-run] Warning: Source file not found: ${filePath}`);
                continue;
            }

            if (absolutePath.endsWith('.json')) {
                mergedData[scope] = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
            } else if (absolutePath.endsWith('.js') || absolutePath.endsWith('.mjs')) {
                // Dynamic import for JS files
                const mod = await import(`file://${absolutePath}`);
                mergedData[scope] = mod.default || mod;
            }
        }
    }

    // 2. Process inline variables defined in vars.yaml
    if (rawConfig.vars) {
        Object.assign(mergedData, rawConfig.vars);
    }

    return flattenVariables(mergedData);
}

/**
 * Replaces $(key) placeholders with values
 */
function injectVariables(commandStr, variables) {
    if (typeof commandStr !== 'string') return commandStr;
    
    return commandStr.replace(/\$\((.*?)\)/g, (match, key) => {
        const val = variables[key.trim()];
        if (val === undefined) {
            console.warn(`[yaml-run] Warning: Variable $(${key}) is undefined.`);
            return match; // Leave it raw if not found
        }
        return val;
    });
}

/**
 * Executes a single shell command
 */
function executeShell(command, envVars) {
    return new Promise((resolve, reject) => {
        // Strip newlines for cleaner logging/execution
        const cleanCommand = command.replace(/\n/g, ' ');
        console.log(`\x1b[36m> ${cleanCommand}\x1b[0m`);

        const child = spawn(cleanCommand, {
            shell: true,
            stdio: 'inherit',
            env: { ...process.env, ...envVars }
        });

        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Command failed with code ${code}`));
        });
    });
}

/**
 * Main Task Runner Logic (Recursive for parallel/series)
 */
async function runTask(taskName, scriptConfig, variables) {
    const task = scriptConfig[taskName];

    if (!task) {
        throw new Error(`Task "${taskName}" not found in scripts.yaml`);
    }

    // CASE 1: Task is a simple string command
    if (typeof task === 'string') {
        const finalCmd = injectVariables(task, variables);
        await executeShell(finalCmd);
        return;
    }

    // CASE 2: Task is an object (Complex Logic)
    if (typeof task === 'object') {
        
        // Handle Parallel Execution
        if (task.parallel && Array.isArray(task.parallel)) {
            console.log(`\x1b[33m[Parallel] Starting: ${task.parallel.join(', ')}\x1b[0m`);
            const promises = task.parallel.map(t => runTask(t, scriptConfig, variables));
            await Promise.all(promises);
            return;
        }

        // Handle Series Execution
        if (task.series && Array.isArray(task.series)) {
            for (const subTask of task.series) {
                await runTask(subTask, scriptConfig, variables);
            }
            return;
        }

        // Handle direct "cmd" or "script" key inside object
        if (task.cmd || task.script) {
            const finalCmd = injectVariables(task.cmd || task.script, variables);
            await executeShell(finalCmd);
            return;
        }
    }
}

// --- Main Execution Entry ---
async function main() {
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
        process.exit(1);
    }
}

main();