import { addStat } from './stats.js';
import { injectVariables } from './config.js';
import { classifyCommand } from './resolution.js';

const isWin = Deno.build.os === 'windows';
const denoExecutable = Deno.execPath();

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

/**
 * @param {'cross-shell' | 'cmd' | 'powershell' | 'pwsh' | 'bash'} shellKind
 */
function resolveShellCommand(shellKind) {
    switch (shellKind) {
        case 'cmd': {
            return {
                command: 'cmd',
                args: ['/d', '/s', '/c'],
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
 * @param {string} command
 * @param {string[]} args
 * @param {string} siteRoot
 * @param {Record<string, string>} [envVars]
 * @param {'CMD' | 'PATH' | 'TOOL'} statType
 * @param {string} statName
 * @param {string} failureLabel
 * @param {{ id: number, depth: number } | null} parentStat
 */
function spawnTrackedProcess(command, args, siteRoot, envVars, statType, statName, failureLabel, parentStat) {
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
                stdin: 'null',
                stdout: 'inherit',
                stderr: 'inherit',
            }).spawn();

            child.status.then((result) => {
                const duration = Date.now() - start;
                const status = result.success ? 'PASS' : 'FAIL';
                stat.duration = duration;
                stat.status = status;

                if (result.success) {
                    resolve();
                } else {
                    reject(new Error(`${failureLabel} failed with code ${result.code}`));
                }
            }).catch(reject);
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
 */
function executeShell(shellKind, command, siteRoot, envVars, parentStat) {
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
        parentStat
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
 */
function executePath(executable, args, siteRoot, envVars, parentStat) {
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
        parentStat
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
 */
function executeDenoTool(tool, args, siteRoot, envVars, parentStat) {
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
        parentStat
    );
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
async function runCommandOrTask(value, context, parentStat) {
    if (typeof value !== 'string') {
        throw new Error(`Unsupported step type: ${typeof value}`);
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
            parentStat
        );
        return;
    }

    await executeShell(classification.shellKind ?? 'cross-shell', classification.rawCommand, context.siteRoot, undefined, parentStat);
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
                await runCommandOrTask(step, context, taskStat);
            }
            status = 'PASS';
            return;
        }

        if (typeof task === 'object') {
            if (task.parallel && Array.isArray(task.parallel)) {
                console.log(`\x1b[33m[Parallel] Starting: ${task.parallel.join(', ')}\x1b[0m`);
                const promises = task.parallel.map((t) => runCommandOrTask(t, context, taskStat));
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
                    await runCommandOrTask(subTask, context, taskStat);
                }
                status = 'PASS';
                return;
            }

            if (task.cmd || task.script) {
                await runCommandOrTask(task.cmd || task.script, context, taskStat);
                status = 'PASS';
                return;
            }
        }

        throw new Error(`Task "${taskName}" has an unsupported shape.`);
    } finally {
        const duration = Date.now() - start;
        taskStat.duration = duration;
        taskStat.status = status;
    }
}
