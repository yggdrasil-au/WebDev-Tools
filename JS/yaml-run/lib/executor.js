import { spawn } from 'node:child_process';
import { addStat } from './stats.js';
import { injectVariables } from './config.js';

/**
 * Executes a single shell command
 */
function executeShell(command, envVars) {
    const start = Date.now();
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
            const duration = Date.now() - start;
            const status = code === 0 ? 'PASS' : 'FAIL';
            addStat({ type: 'CMD', name: cleanCommand, duration, status });

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
export async function runTask(taskName, scriptConfig, variables) {
    const start = Date.now();
    let status = 'FAIL';

    try {
        const task = scriptConfig[taskName];

        if (!task) {
            throw new Error(`Task "${taskName}" not found in scripts.yaml`);
        }

        // CASE 1: Task is a simple string command
        if (typeof task === 'string') {
            await runCommandOrTask(task, scriptConfig, variables);
            status = 'PASS';
            return;
        }

        // CASE 1b: Task is a list of steps (shorthand series)
        if (Array.isArray(task)) {
            for (const step of task) {
                await runCommandOrTask(step, scriptConfig, variables);
            }
            status = 'PASS';
            return;
        }

        // CASE 2: Task is an object (Complex Logic)
        if (typeof task === 'object') {

            // Handle Parallel Execution
            if (task.parallel && Array.isArray(task.parallel)) {
                console.log(`\x1b[33m[Parallel] Starting: ${task.parallel.join(', ')}\x1b[0m`);
                const promises = task.parallel.map((t) => runCommandOrTask(t, scriptConfig, variables));
                await Promise.all(promises);
                status = 'PASS';
                return;
            }

            // Handle Series Execution
            if (task.series && Array.isArray(task.series)) {
                for (const subTask of task.series) {
                    await runCommandOrTask(subTask, scriptConfig, variables);
                }
                status = 'PASS';
                return;
            }

            // Handle direct "cmd" or "script" key inside object
            if (task.cmd || task.script) {
                await runCommandOrTask(task.cmd || task.script, scriptConfig, variables);
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
