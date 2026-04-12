import { addStat } from './stats.js';
import { injectVariables } from './config.js';
import { classifyCommand } from './resolution.js';

const isWin = Deno.build.os === 'windows';
const denoExecutable = Deno.execPath();

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
 */
function spawnTrackedProcess(command, args, siteRoot, envVars, statType, statName, failureLabel) {
    const start = Date.now();

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
                addStat({ type: statType, name: statName, duration, status });

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
 */
function executeShell(shellKind, command, siteRoot, envVars) {
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
        'Command'
    );
}

/**
 * Executes a command directly from PATH.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {string} siteRoot
 * @param {Record<string, string>} [envVars]
 */
function executePath(executable, args, siteRoot, envVars) {
    const commandParts = [executable, ...args];
    console.log(`\x1b[36m> ${formatCommandForDisplay(commandParts)}\x1b[0m`);

    return spawnTrackedProcess(
        executable,
        args,
        siteRoot,
        envVars,
        'PATH',
        formatCommandForDisplay(commandParts),
        'PATH command'
    );
}

/**
 * Executes a managed Deno-backed tool.
 *
 * @param {{ label: string, executeSpec: string }} tool
 * @param {string[]} args
 * @param {string} siteRoot
 * @param {Record<string, string>} [envVars]
 */
function executeDenoTool(tool, args, siteRoot, envVars) {
    const commandParts = [denoExecutable, 'run', '-A', tool.executeSpec, ...args];
    console.log(`\x1b[36m> ${formatCommandForDisplay(commandParts)}\x1b[0m`);

    return spawnTrackedProcess(
        denoExecutable,
        ['run', '-A', tool.executeSpec, ...args],
        siteRoot,
        envVars,
        'TOOL',
        `${tool.label} ${args.join(' ')}`.trim(),
        'Tool'
    );
}

/**
 * Runs a raw string as either a managed task, a managed tool, or shell text.
 *
 * @param {string} value
 * @param {{ siteRoot: string, scripts: Record<string, unknown>, variables: Record<string, unknown>, toolCatalog: Map<string, Array<{ label: string, executeSpec: string }>> }} context
 */
async function runCommandOrTask(value, context) {
    if (typeof value !== 'string') {
        throw new Error(`Unsupported step type: ${typeof value}`);
    }

    const injectedCommand = injectVariables(value, context.variables);
    const classification = classifyCommand(injectedCommand, context.scripts, context.toolCatalog);

    if (classification.kind === 'script' && classification.scriptName) {
        await runTask(classification.scriptName, context);
        return;
    }

    if (classification.kind === 'tool' && classification.tool) {
        await executeDenoTool(
            classification.tool,
            classification.args ?? [],
            context.siteRoot
        );
        return;
    }

    if (classification.kind === 'path' && classification.executable) {
        await executePath(
            classification.executable,
            classification.args ?? [],
            context.siteRoot
        );
        return;
    }

    await executeShell(classification.shellKind ?? 'cross-shell', classification.rawCommand, context.siteRoot);
}

/**
 * Main Task Runner Logic (Recursive for parallel/series).
 *
 * @param {string} taskName
 * @param {{ siteRoot: string, scripts: Record<string, unknown>, variables: Record<string, unknown>, toolCatalog: Map<string, Array<{ label: string, executeSpec: string }>> }} context
 */
export async function runTask(taskName, context) {
    const start = Date.now();
    let status = 'FAIL';

    try {
        const task = context.scripts[taskName];

        if (!task) {
            throw new Error(`Task "${taskName}" not found in scripts.yaml`);
        }

        if (typeof task === 'string') {
            await runCommandOrTask(task, context);
            status = 'PASS';
            return;
        }

        if (Array.isArray(task)) {
            for (const step of task) {
                await runCommandOrTask(step, context);
            }
            status = 'PASS';
            return;
        }

        if (typeof task === 'object') {
            if (task.parallel && Array.isArray(task.parallel)) {
                console.log(`\x1b[33m[Parallel] Starting: ${task.parallel.join(', ')}\x1b[0m`);
                const promises = task.parallel.map((t) => runCommandOrTask(t, context));
                await Promise.all(promises);
                status = 'PASS';
                return;
            }

            if (task.series && Array.isArray(task.series)) {
                for (const subTask of task.series) {
                    await runCommandOrTask(subTask, context);
                }
                status = 'PASS';
                return;
            }

            if (task.cmd || task.script) {
                await runCommandOrTask(task.cmd || task.script, context);
                status = 'PASS';
                return;
            }
        }

        throw new Error(`Task "${taskName}" has an unsupported shape.`);
    } finally {
        const duration = Date.now() - start;
        addStat({ type: 'TASK', name: taskName, duration, status });
    }
}
