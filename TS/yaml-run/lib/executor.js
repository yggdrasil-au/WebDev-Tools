import path from 'node:path';

import { expandGlob } from 'jsr:@std/fs';

import { addStat } from './stats.js';
import { injectVariables } from './config.js';
import { classifyCommand } from './resolution.js';

const isWin = Deno.build.os === 'windows';
const denoExecutable = Deno.execPath();
const activeProcesses = new Map();
let shutdownRequested = false;
let shutdownWaiters = [];
const SUPPORTED_FS_ACTIONS = new Set(['rm', 'mkdir', 'copy']);

/**
 * @typedef {{
 *     parentId: number | null,
 *     depth: number,
 * }} ExecutionScope
 *
 * @typedef {{
 *     siteRoot: string,
 *     scripts: Record<string, unknown>,
 *     variables: Record<string, unknown>,
 *     toolCatalog: Map<string, Array<{ label: string, executeSpec: string }>>,
 *     execution?: ExecutionScope,
 * }} ExecutionContext
 */

function buildEnvironment(envVars) {
    const baseEnvironment = Deno.env.toObject();
    return envVars ? { ...baseEnvironment, ...envVars } : baseEnvironment;
}

function quoteForDisplay(value) {
    if (value.length === 0) {
        return '""';
    }

    if (/\s|"/.test(value)) {
        return `"${value.replace(/"/g, '\\"')}"`;
    }

    return value;
}

function formatCommandForDisplay(commandParts) {
    return commandParts.map((part) => quoteForDisplay(part)).join(' ');
}

function isGlobPattern(targetPath) {
    return /[*?[\]{}]/.test(targetPath);
}

async function pathExists(targetPath) {
    try {
        return await Deno.stat(targetPath);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return null;
        }

        throw error;
    }
}

async function removePath(targetPath) {
    try {
        await Deno.remove(targetPath, { recursive: true });
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
            throw error;
        }
    }
}

async function removeGlobPattern(siteRoot, targetPattern) {
    const globOptions = path.isAbsolute(targetPattern) ? undefined : { root: siteRoot };
    let matched = false;

    for await (const entry of expandGlob(targetPattern, globOptions)) {
        matched = true;
        await removePath(path.resolve(siteRoot, entry.path));
    }

    return matched;
}

async function copyPathRecursive(sourcePath, destinationPath) {
    const sourceInfo = await Deno.stat(sourcePath);
    const destinationInfo = await pathExists(destinationPath);
    const finalDestination = destinationInfo && destinationInfo.isDirectory
        ? path.join(destinationPath, path.basename(sourcePath))
        : destinationPath;

    if (sourceInfo.isDirectory) {
        await Deno.mkdir(finalDestination, { recursive: true });

        for await (const entry of Deno.readDir(sourcePath)) {
            await copyPathRecursive(
                path.join(sourcePath, entry.name),
                path.join(finalDestination, entry.name)
            );
        }

        return;
    }

    await Deno.mkdir(path.dirname(finalDestination), { recursive: true });
    await Deno.copyFile(sourcePath, finalDestination);
}

async function copyGlobMatches(siteRoot, sourcePattern, destinationPath) {
    const globOptions = path.isAbsolute(sourcePattern) ? undefined : { root: siteRoot };
    let matched = false;

    for await (const entry of expandGlob(sourcePattern, globOptions)) {
        if (!matched) {
            await Deno.mkdir(destinationPath, { recursive: true });
            matched = true;
        }

        await copyPathRecursive(path.resolve(siteRoot, entry.path), destinationPath);
    }

    return matched;
}

function resolveShutdownWaiters() {
    if (!shutdownRequested || activeProcesses.size > 0) {
        return;
    }

    const waiters = shutdownWaiters;
    shutdownWaiters = [];

    for (const resolve of waiters) {
        resolve();
    }
}

function registerActiveProcess(child, stat) {
    activeProcesses.set(child, { stat });
}

function unregisterActiveProcess(child) {
    activeProcesses.delete(child);
    resolveShutdownWaiters();
}

function terminateChildProcess(child) {
    try {
        child.kill('SIGTERM');
        return;
    } catch {
        try {
            child.kill();
        } catch {
            // Ignore shutdown errors; the child may already be exiting.
        }
    }
}

function markActiveProcessesInterrupted() {
    for (const { stat } of activeProcesses.values()) {
        if (stat.status === 'RUNNING') {
            stat.status = 'INTERRUPTED';
        }
    }
}

export function isShutdownRequested() {
    return shutdownRequested;
}

export function requestShutdown() {
    if (!shutdownRequested) {
        shutdownRequested = true;
        markActiveProcessesInterrupted();

        for (const child of activeProcesses.keys()) {
            terminateChildProcess(child);
        }
    }

    resolveShutdownWaiters();
}

export function waitForShutdown() {
    if (!shutdownRequested || activeProcesses.size === 0) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        shutdownWaiters.push(resolve);
    });
}

/**
 * @param {'cross-shell' | 'cmd' | 'powershell' | 'pwsh' | 'bash'} shellKind
 */
function resolveShellCommand(shellKind) {
    switch (shellKind) {
        case 'cmd': {
            return {
                args: ['/d', '/s', '/c'],
                command: 'cmd',
            };
        }
        case 'powershell': {
            return {
                command: 'powershell',
                args: ['-NoLogo', '-NoProfile', '-Command'],
            };
        }
        case 'pwsh': {
            return {
                command: 'pwsh',
                args: ['-NoLogo', '-NoProfile', '-Command'],
            };
        }
        case 'bash': {
            return {
                command: 'bash',
                args: ['-lc'],
            };
        }
        case 'cross-shell':
        default: {
            return isWin
                ? {
                    command: 'powershell',
                    args: ['-NoLogo', '-NoProfile', '-Command'],
                }
                : {
                    command: 'bash',
                    args: ['-lc'],
                };
        }
    }
}

/**
 * Executes native filesystem operations.
 *
 * @param {'rm' | 'mkdir' | 'copy'} action
 * @param {string[]} args
 * @param {string} siteRoot
 * @param {{ id: number, depth: number } | null} parentStat
 */
async function executeFs(action, args, siteRoot, parentStat) {
    const start = Date.now();
    const stat = addStat({
        type: 'FS',
        name: `fs: ${action} ${args.join(' ')}`.trim(),
        parentId: parentStat ? parentStat.id : null,
        depth: parentStat ? parentStat.depth + 1 : 0,
        status: 'RUNNING',
        duration: 0,
    });

    try {
        console.log(`[36m> ${formatCommandForDisplay(['fs', action, ...args])}[0m`);

        if (!SUPPORTED_FS_ACTIONS.has(action)) {
            throw new Error(`Unknown fs action: ${action}`);
        }

        switch (action) {
            case 'rm': {
                if (args.length === 0) {
                    throw new Error('fs: rm requires at least one target.');
                }

                for (const targetSpec of args) {
                    if (isGlobPattern(targetSpec)) {
                        await removeGlobPattern(siteRoot, targetSpec);
                        continue;
                    }

                    await removePath(path.resolve(siteRoot, targetSpec));
                }

                break;
            }
            case 'mkdir': {
                if (args.length === 0) {
                    throw new Error('fs: mkdir requires at least one target.');
                }

                for (const directorySpec of args) {
                    await Deno.mkdir(path.resolve(siteRoot, directorySpec), { recursive: true });
                }

                break;
            }
            case 'copy': {
                if (args.length !== 2) {
                    throw new Error('fs: copy requires a source and destination.');
                }

                const [sourceSpec, destinationSpec] = args;
                const destinationPath = path.resolve(siteRoot, destinationSpec);

                if (isGlobPattern(sourceSpec)) {
                    await copyGlobMatches(siteRoot, sourceSpec, destinationPath);
                } else {
                    await copyPathRecursive(path.resolve(siteRoot, sourceSpec), destinationPath);
                }

                break;
            }
            default: {
                throw new Error(`Unknown fs action: ${action}`);
            }
        }

        stat.status = 'PASS';
    } catch (error) {
        stat.status = 'FAIL';
        throw error;
    } finally {
        stat.duration = Date.now() - start;
    }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} siteRoot
 * @param {Record<string, string>} [envVars]
 * @param {'CMD' | 'PATH' | 'TOOL'} statType
 * @param {string} statName
 * @param {string} failureLabel
 * @param {{ id: number, depth: number } | null} parentStat
 * @param {'null' | 'inherit'} [stdinMode]
 */
function spawnTrackedProcess(command, args, siteRoot, envVars, statType, statName, failureLabel, parentStat, stdinMode = 'null') {
    const start = Date.now();
    const stat = addStat({
        type: statType,
        name: statName,
        parentId: parentStat ? parentStat.id : null,
        depth: parentStat ? parentStat.depth + 1 : 0,
        status: 'RUNNING',
        duration: 0,
    });

    return new Promise((resolve, reject) => {
        try {
            const child = new Deno.Command(command, {
                args,
                cwd: siteRoot,
                env: buildEnvironment(envVars),
                stdin: stdinMode,
                stdout: 'inherit',
                stderr: 'inherit',
            }).spawn();

            registerActiveProcess(child, stat);

            let finalized = false;

            const finalize = () => {
                if (finalized) {
                    return;
                }

                finalized = true;
                unregisterActiveProcess(child);
            };

            child.status.then((result) => {
                const duration = Date.now() - start;
                stat.duration = duration;
                finalize();

                if (shutdownRequested) {
                    stat.status = 'INTERRUPTED';
                    reject(new Error('Execution interrupted.'));
                    return;
                }

                const status = result.success ? 'PASS' : 'FAIL';
                stat.status = status;

                if (result.success) {
                    resolve();
                } else {
                    reject(new Error(`${failureLabel} failed with code ${result.code}`));
                }
            }).catch((error) => {
                stat.duration = Date.now() - start;
                finalize();

                if (shutdownRequested) {
                    stat.status = 'INTERRUPTED';
                    reject(new Error('Execution interrupted.'));
                    return;
                }

                stat.status = 'FAIL';
                reject(error);
            });
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Executes a single shell command.
 *
 * @param {'cross-shell' | 'cmd' | 'powershell' | 'pwsh' | 'bash'} shellKind
 * @param {string} command
 * @param {string} siteRoot
 * @param {Record<string, string>} [envVars]
 * @param {{ id: number, depth: number } | null} parentStat
 * @param {'null' | 'inherit'} [stdinMode]
 */
function executeShell(shellKind, command, siteRoot, envVars, parentStat, stdinMode = 'null') {
    const cleanCommand = command.replace(/\n/g, ' ');
    const shell = resolveShellCommand(shellKind);
    console.log(`\x1b[36m> ${formatCommandForDisplay([shell.command, ...shell.args, cleanCommand])}\x1b[0m`);

    return spawnTrackedProcess(
        shell.command,
        [...shell.args, cleanCommand],
        siteRoot,
        envVars,
        'CMD',
        `${shellKind}: ${cleanCommand}`,
        'Command',
        parentStat,
        stdinMode
    );
}

/**
 * Executes a command directly from PATH.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {string} siteRoot
 * @param {Record<string, string>} [envVars]
 * @param {{ id: number, depth: number } | null} parentStat
 * @param {'null' | 'inherit'} [stdinMode]
 */
function executePath(executable, args, siteRoot, envVars, parentStat, stdinMode = 'null') {
    const commandParts = [executable, ...args];
    console.log(`\x1b[36m> ${formatCommandForDisplay(commandParts)}\x1b[0m`);

    return spawnTrackedProcess(
        executable,
        args,
        siteRoot,
        envVars,
        'PATH',
        formatCommandForDisplay(commandParts),
        'PATH command',
        parentStat,
        stdinMode
    );
}

/**
 * Executes a managed Deno-backed tool.
 *
 * @param {{ label: string, executeSpec: string }} tool
 * @param {string[]} args
 * @param {string} siteRoot
 * @param {Record<string, string>} [envVars]
 * @param {{ id: number, depth: number } | null} parentStat
 * @param {'null' | 'inherit'} [stdinMode]
 */
function executeDenoTool(tool, args, siteRoot, envVars, parentStat, stdinMode = 'null') {
    const commandParts = [denoExecutable, 'run', '-A', tool.executeSpec, ...args];
    console.log(`\x1b[36m> ${formatCommandForDisplay(commandParts)}\x1b[0m`);

    return spawnTrackedProcess(
        denoExecutable,
        ['run', '-A', tool.executeSpec, ...args],
        siteRoot,
        envVars,
        'TOOL',
        `${tool.label} ${args.join(' ')}`.trim(),
        'Tool',
        parentStat,
        stdinMode
    );
}

/**
 * @param {unknown} step
 * @param {ExecutionContext} context
 * @param {{ id: number, depth: number } | null} parentStat
 */
async function runTaskStep(step, context, parentStat) {
    if (typeof step === 'string') {
        await runCommandOrTask(step, context, parentStat);
        return;
    }

    if (step && typeof step === 'object') {
        if (typeof step.cmd === 'string') {
            await runCommandOrTask(step.cmd, context, parentStat, step.interactive === true);
            return;
        }

        if (typeof step.script === 'string') {
            await runCommandOrTask(step.script, context, parentStat, step.interactive === true);
            return;
        }
    }

    throw new Error(`Unsupported step type: ${typeof step}`);
}

/**
 * @param {ExecutionContext} context
 * @param {{ id: number, depth: number }} parentStat
 * @returns {ExecutionContext}
 */
function createChildExecutionContext(context, parentStat) {
    return {
        ...context,
        execution: {
            parentId: parentStat.id,
            depth: parentStat.depth + 1,
        },
    };
}

/**
 * Runs a raw string as either a managed task, a managed tool, or shell text.
 *
 * @param {string} value
 * @param {ExecutionContext} context
 * @param {{ id: number, depth: number } | null} parentStat
 */
async function runCommandOrTask(value, context, parentStat, interactive = false) {
    if (typeof value !== 'string') {
        throw new Error(`Unsupported step type: ${typeof value}`);
    }

    if (shutdownRequested) {
        throw new Error('Execution interrupted.');
    }

    const injectedCommand = injectVariables(value, context.variables);
    const classification = classifyCommand(injectedCommand, context.scripts, context.toolCatalog);

    if (classification.kind === 'script' && classification.scriptName) {
        if (!parentStat) {
            throw new Error('Missing execution parent for nested task dispatch.');
        }

        await runTask(classification.scriptName, createChildExecutionContext(context, parentStat));
        return;
    }

    if (classification.kind === 'tool' && classification.tool) {
        await executeDenoTool(
            classification.tool,
            classification.args ?? [],
            context.siteRoot,
            undefined,
            parentStat,
            interactive ? 'inherit' : 'null'
        );
        return;
    }

    if (classification.kind === 'fs' && classification.fsAction) {
        await executeFs(
            classification.fsAction,
            classification.fsArgs ?? [],
            context.siteRoot,
            parentStat
        );
        return;
    }

    if (classification.kind === 'path' && classification.executable) {
        await executePath(
            classification.executable,
            classification.args ?? [],
            context.siteRoot,
            undefined,
            parentStat,
            interactive ? 'inherit' : 'null'
        );
        return;
    }

    await executeShell(classification.shellKind ?? 'cross-shell', classification.rawCommand, context.siteRoot, undefined, parentStat, interactive ? 'inherit' : 'null');
}

/**
 * Main Task Runner Logic (Recursive for parallel/series).
 *
 * @param {string} taskName
 * @param {ExecutionContext} context
 */
export async function runTask(taskName, context) {
    const start = Date.now();
    let status = 'FAIL';
    const executionScope = context.execution ?? {
        parentId: null,
        depth: 0,
    };
    const taskStat = addStat({
        type: 'TASK',
        name: taskName,
        parentId: executionScope.parentId,
        depth: executionScope.depth,
        status: 'RUNNING',
        duration: 0,
    });

    try {
        if (shutdownRequested) {
            status = 'INTERRUPTED';
            throw new Error('Execution interrupted.');
        }

        const task = context.scripts[taskName];

        if (!task) {
            throw new Error(`Task "${taskName}" not found in scripts.yaml`);
        }

        if (typeof task === 'string') {
            await runCommandOrTask(task, context, taskStat);
            status = 'PASS';
            return;
        }

        if (Array.isArray(task)) {
            for (const step of task) {
                if (shutdownRequested) {
                    status = 'INTERRUPTED';
                    throw new Error('Execution interrupted.');
                }

                await runTaskStep(step, context, taskStat);
            }
            status = 'PASS';
            return;
        }

        if (typeof task === 'object') {
            if (task.parallel && Array.isArray(task.parallel)) {
                console.log(`\x1b[33m[Parallel] Starting: ${task.parallel.join(', ')}\x1b[0m`);
                const promises = task.parallel.map((t) => runTaskStep(t, context, taskStat));
                const results = await Promise.allSettled(promises);
                const rejectedResult = results.find((result) => result.status === 'rejected');

                if (rejectedResult && rejectedResult.status === 'rejected') {
                    throw rejectedResult.reason;
                }

                status = 'PASS';
                return;
            }

            if (task.series && Array.isArray(task.series)) {
                for (const subTask of task.series) {
                    if (shutdownRequested) {
                        status = 'INTERRUPTED';
                        throw new Error('Execution interrupted.');
                    }

                    await runTaskStep(subTask, context, taskStat);
                }
                status = 'PASS';
                return;
            }

            if (task.cmd || task.script) {
                await runCommandOrTask(task.cmd || task.script, context, taskStat, task.interactive === true);
                status = 'PASS';
                return;
            }
        }

        throw new Error(`Task "${taskName}" has an unsupported shape.`);
    } finally {
        const duration = Date.now() - start;
        taskStat.duration = duration;
        taskStat.status = shutdownRequested && status !== 'PASS' ? 'INTERRUPTED' : status;
    }
}
