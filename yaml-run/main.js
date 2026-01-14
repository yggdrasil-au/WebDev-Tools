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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} root
 * @param {string[]} pathParts
 * @returns {unknown}
 */
function getValueByPath(root, pathParts) {
    /** @type {unknown} */
    let current = root;
    for (const part of pathParts) {
        if (!isPlainObject(current)) {
            return undefined;
        }

        if (!Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined;
        }

        current = current[part];
    }
    return current;
}

/**
 * Resolves {{placeholders}} inside the merged vars tree.
 *
 * Supported placeholder keys:
 * - Absolute: {{paths.www}}, {{pkg.version}}
 * - Relative: {{www}} (resolved from sibling/ancestor keys)
 *
 * Notes:
 * - Only resolves placeholders within string values.
 * - On undefined/cycles/non-primitive substitutions, leaves placeholders unchanged.
 *
 * @param {Record<string, unknown>} rootData
 */
function resolveVarsPlaceholders(rootData) {
    /** @type {Map<string, unknown>} */
    const resolvedCache = new Map();
    /** @type {Set<string>} */
    const resolving = new Set();

    /**
     * @typedef {{ obj: Record<string, unknown>, pathParts: string[] }} Ancestor
     */

    /**
     * @param {string[]} pathParts
     */
    function pathKey(pathParts) {
        return pathParts.join('.');
    }

    /**
     * Returns ancestors for the container object that owns the leaf key.
     * Example: for ['paths','web_root'], returns [rootData, rootData.paths].
     *
     * @param {string[]} leafPathParts
     * @returns {Ancestor[]}
     */
    function getContainerAncestors(leafPathParts) {
        /** @type {Ancestor[]} */
        const ancestors = [{ obj: rootData, pathParts: [] }];
        if (leafPathParts.length < 2) {
            return ancestors;
        }

        /** @type {unknown} */
        let current = rootData;
        /** @type {string[]} */
        let currentPathParts = [];

        for (let i = 0; i < leafPathParts.length - 1; i++) {
            const part = leafPathParts[i];
            if (!isPlainObject(current)) {
                break;
            }

            if (!Object.prototype.hasOwnProperty.call(current, part)) {
                break;
            }

            current = current[part];
            currentPathParts = [...currentPathParts, part];

            if (isPlainObject(current)) {
                ancestors.push({ obj: current, pathParts: currentPathParts });
            }
        }

        return ancestors;
    }

    /**
     * @param {string} placeholderKey
     * @param {Ancestor[]} containerAncestors
     * @returns {string[] | null}
     */
    function resolvePlaceholderToPathParts(placeholderKey, containerAncestors) {
        const trimmed = placeholderKey.trim();
        if (trimmed.length === 0) {
            return null;
        }

        // Absolute path (dot-notation)
        if (trimmed.includes('.')) {
            return trimmed.split('.');
        }

        // Relative path: search container ancestors from nearest -> root
        for (let i = containerAncestors.length - 1; i >= 0; i--) {
            const { obj, pathParts } = containerAncestors[i];
            if (Object.prototype.hasOwnProperty.call(obj, trimmed)) {
                return [...pathParts, trimmed];
            }
        }

        // Optional fallback: root-level variable (rare, but safe)
        if (Object.prototype.hasOwnProperty.call(rootData, trimmed)) {
            return [trimmed];
        }

        return null;
    }

    /**
     * @param {unknown} value
     * @param {string[]} valuePathParts
     * @param {Ancestor[]} containerAncestors
     * @returns {unknown}
     */
    function resolveAny(value, valuePathParts, containerAncestors) {
        if (typeof value === 'string') {
            return resolveString(value, valuePathParts, containerAncestors);
        }

        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                value[i] = resolveAny(value[i], [...valuePathParts, String(i)], containerAncestors);
            }
            return value;
        }

        if (isPlainObject(value)) {
            /** @type {Ancestor[]} */
            const nextAncestors = [...containerAncestors, { obj: value, pathParts: valuePathParts }];
            for (const [k, v] of Object.entries(value)) {
                value[k] = resolveAny(v, [...valuePathParts, k], nextAncestors);
            }
            return value;
        }

        return value;
    }

    /**
     * @param {string} input
     * @param {string[]} valuePathParts
     * @param {Ancestor[]} containerAncestors
     */
    function resolveString(input, valuePathParts, containerAncestors) {
        return input.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key) => {
            const refPathParts = resolvePlaceholderToPathParts(String(key), containerAncestors);
            if (!refPathParts) {
                console.warn(`[yaml-run] Warning: Variable {{${key}}} is undefined.`);
                return match;
            }

            const resolved = resolveValueAtPath(refPathParts);
            if (resolved === undefined) {
                // Warning already emitted inside resolveValueAtPath (cycle/undefined)
                return match;
            }

            if (
                typeof resolved === 'string' ||
                typeof resolved === 'number' ||
                typeof resolved === 'boolean' ||
                typeof resolved === 'bigint'
            ) {
                return String(resolved);
            }

            console.warn(
                `[yaml-run] Warning: Variable {{${key}}} resolved to a non-primitive value; leaving placeholder unchanged.`
            );
            return match;
        });
    }

    /**
     * @param {string[]} refPathParts
     * @returns {unknown}
     */
    function resolveValueAtPath(refPathParts) {
        const refKey = pathKey(refPathParts);
        if (resolvedCache.has(refKey)) {
            return resolvedCache.get(refKey);
        }

        if (resolving.has(refKey)) {
            console.warn(`[yaml-run] Warning: Detected cyclic variable reference at "${refKey}".`);
            return undefined;
        }

        const raw = getValueByPath(rootData, refPathParts);
        if (raw === undefined) {
            console.warn(`[yaml-run] Warning: Variable "${refKey}" is undefined.`);
            return undefined;
        }

        resolving.add(refKey);
        const containerAncestors = getContainerAncestors(refPathParts);
        const resolved = resolveAny(raw, refPathParts, containerAncestors);
        resolving.delete(refKey);

        resolvedCache.set(refKey, resolved);
        return resolved;
    }

    // Resolve everything in-place starting at the root.
    resolveAny(rootData, [], [{ obj: rootData, pathParts: [] }]);
}

/**
 * Loads and resolves variables from vars.yaml and its referenced sources
 */
async function loadVariables() {
    if (!fs.existsSync(CONFIG_FILES.vars)) {
        return {};
    }

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

    resolveVarsPlaceholders(mergedData);
    return flattenVariables(mergedData);
}

/**
 * Replaces {{key}} placeholders with values.
 *
 * Note: We intentionally avoid the $(...) syntax because it collides with POSIX
 * shell command substitution.
 */
function injectVariables(commandStr, variables) {
    if (typeof commandStr !== 'string') return commandStr;

    return commandStr.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key) => {
        const val = variables[key.trim()];
        if (val === undefined) {
            console.warn(`[yaml-run] Warning: Variable {{${key}}} is undefined.`);
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
            env: { ...process.env, ...(envVars ?? {}) }
        });

        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Command failed with code ${code}`));
        });
    });
}

function looksLikeTaskName(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;

    // If it contains obvious shell operators/whitespace, treat it as a command.
    return !(/[\s&|;<>]/.test(trimmed));
}

async function runCommandOrTask(value, scriptConfig, variables) {
    if (typeof value !== 'string') {
        throw new Error(`Unsupported step type: ${typeof value}`);
    }

    const trimmed = value.trim();

    // Prefer task execution if it exists; otherwise treat as a shell command.
    if (Object.prototype.hasOwnProperty.call(scriptConfig, trimmed) && looksLikeTaskName(trimmed)) {
        await runTask(trimmed, scriptConfig, variables);
        return;
    }

    const finalCmd = injectVariables(value, variables);
    await executeShell(finalCmd);
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
        await runCommandOrTask(task, scriptConfig, variables);
        return;
    }

    // CASE 1b: Task is a list of steps (shorthand series)
    if (Array.isArray(task)) {
        for (const step of task) {
            await runCommandOrTask(step, scriptConfig, variables);
        }
        return;
    }

    // CASE 2: Task is an object (Complex Logic)
    if (typeof task === 'object') {

        // Handle Parallel Execution
        if (task.parallel && Array.isArray(task.parallel)) {
            console.log(`\x1b[33m[Parallel] Starting: ${task.parallel.join(', ')}\x1b[0m`);
            const promises = task.parallel.map((t) => runCommandOrTask(t, scriptConfig, variables));
            await Promise.all(promises);
            return;
        }

        // Handle Series Execution
        if (task.series && Array.isArray(task.series)) {
            for (const subTask of task.series) {
                await runCommandOrTask(subTask, scriptConfig, variables);
            }
            return;
        }

        // Handle direct "cmd" or "script" key inside object
        if (task.cmd || task.script) {
            await runCommandOrTask(task.cmd || task.script, scriptConfig, variables);
            return;
        }
    }

    throw new Error(`Task "${taskName}" has an unsupported shape.`);
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