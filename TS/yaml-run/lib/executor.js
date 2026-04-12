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
 * Executes a single shell command.
 *
 * @param {string} command
 * @param {string} siteRoot
 * @param {Record<string, string>} [envVars]
 */
function executeShell(command, siteRoot, envVars) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const cleanCommand = command.replace(/\n/g, ' ');
        console.log(`\x1b[36m> ${cleanCommand}\x1b[0m`);

        try {
            const child = new Deno.Command(isWin ? 'cmd' : 'sh', {
                args: isWin ? ['/d', '/s', '/c', cleanCommand] : ['-c', cleanCommand],
                cwd: siteRoot,
                env: buildEnvironment(envVars),
                stdin: 'null',
                stdout: 'inherit',
                stderr: 'inherit',
            }).spawn();

            child.status.then((result) => {
                const duration = Date.now() - start;
                const status = result.success ? 'PASS' : 'FAIL';
                addStat({ type: 'CMD', name: cleanCommand, duration, status });

                if (result.success) {
                    resolve();
                } else {
                    reject(new Error(`Command failed with code ${result.code}`));
                }
            }).catch(reject);
        } catch (error) {
            reject(error);
        }
    });
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
    const start = Date.now();
    const commandParts = [denoExecutable, 'run', '-A', tool.executeSpec, ...args];
    console.log(`\x1b[36m> ${formatCommandForDisplay(commandParts)}\x1b[0m`);

    return new Promise((resolve, reject) => {
        try {
            const child = new Deno.Command(denoExecutable, {
                args: ['run', '-A', tool.executeSpec, ...args],
                cwd: siteRoot,
                env: buildEnvironment(envVars),
                stdin: 'null',
                stdout: 'inherit',
                stderr: 'inherit',
            }).spawn();

            child.status.then((result) => {
                const duration = Date.now() - start;
                const status = result.success ? 'PASS' : 'FAIL';
                addStat({ type: 'TOOL', name: `${tool.label} ${args.join(' ')}`.trim(), duration, status });

                if (result.success) {
                    resolve();
                } else {
                    reject(new Error(`Tool failed with code ${result.code}`));
                }
            }).catch(reject);
        } catch (error) {
            reject(error);
        }
    });
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

    await executeShell(classification.rawCommand, context.siteRoot);
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
