import { injectVariables } from './config.js';
import { classifyCommand, hasShellOperators } from './resolution.js';

/**
 * @typedef {{
 *     scriptName: string,
 *     stepPath: string,
 *     message: string,
 * }} ValidationWarning
 */

/**
 * @typedef {{
 *     siteRoot: string,
 *     scripts: Record<string, unknown>,
 *     variables: Record<string, unknown>,
 *     toolCatalog: Map<string, Array<{ label: string, executeSpec: string }>>,
 * }} ValidationContext
 */

const isWindows = Deno.build.os === 'windows';

/**
 * @param {string} commandText
 */
function hasPortableAlternative(commandText) {
    const normalizedCommand = commandText.toLowerCase();

    if (/\brm\s+-rf\b/.test(normalizedCommand) || /\bshx\s+rm\b/.test(normalizedCommand)) {
        return 'Use `npm:rimraf` or a Deno filesystem delete helper instead of `rm -rf`.';
    }

    if (/\bmkdir\s+-p\b/.test(normalizedCommand)) {
        return 'Use `Deno.mkdir(..., { recursive: true })` or a direct filesystem helper instead of `mkdir -p`.';
    }

    if (/\bcp\s+-r\b/.test(normalizedCommand) || /\bshx\s+cp\b/.test(normalizedCommand)) {
        return 'Use a Deno filesystem copy helper or split the work into explicit file operations instead of `cp -r`.';
    }

    if (/\bdeno\s+run\b/.test(normalizedCommand)) {
        return 'Use `path: deno ...` instead of wrapping `deno` in a shell command.';
    }

    return null;
}

/**
 * @param {ValidationWarning[]} warnings
 * @param {string} scriptName
 * @param {string} stepPath
 * @param {string} message
 */
function addWarning(warnings, scriptName, stepPath, message) {
    warnings.push({
        scriptName,
        stepPath,
        message,
    });
}

/**
 * @param {unknown} task
 * @param {ValidationContext} context
 * @param {string} scriptName
 * @param {string} stepPath
 * @param {ValidationWarning[]} warnings
 */
function validateTask(task, context, scriptName, stepPath, warnings) {
    if (typeof task === 'string') {
        validateCommand(task, context, scriptName, stepPath, warnings);
        return;
    }

    if (Array.isArray(task)) {
        task.forEach((subTask, index) => {
            validateTask(subTask, context, scriptName, `${stepPath}[${index}]`, warnings);
        });

        return;
    }

    if (task && typeof task === 'object') {
        const recordTask = /** @type {Record<string, unknown>} */ (task);

        if (Array.isArray(recordTask.parallel)) {
            recordTask.parallel.forEach((subTask, index) => {
                validateTask(subTask, context, scriptName, `${stepPath}.parallel[${index}]`, warnings);
            });
            return;
        }

        if (Array.isArray(recordTask.series)) {
            recordTask.series.forEach((subTask, index) => {
                validateTask(subTask, context, scriptName, `${stepPath}.series[${index}]`, warnings);
            });
            return;
        }

        if (typeof recordTask.cmd === 'string') {
            validateCommand(recordTask.cmd, context, scriptName, `${stepPath}.cmd`, warnings);
        }

        if (typeof recordTask.script === 'string') {
            validateCommand(recordTask.script, context, scriptName, `${stepPath}.script`, warnings);
        }

        return;
    }

    addWarning(
        warnings,
        scriptName,
        stepPath,
        `Task step has unsupported type: ${typeof task}.`
    );
}

/**
 * @param {string} command
 * @param {ValidationContext} context
 * @param {string} scriptName
 * @param {string} stepPath
 * @param {ValidationWarning[]} warnings
 */
function validateCommand(command, context, scriptName, stepPath, warnings) {
    const injectedCommand = injectVariables(command, context.variables);

    let classification;
    try {
        classification = classifyCommand(injectedCommand, context.scripts, context.toolCatalog);
    } catch (error) {
        addWarning(
            warnings,
            scriptName,
            stepPath,
            error instanceof Error ? error.message : String(error)
        );
        return;
    }

    if (classification.kind === 'shell') {
        if (classification.compatibilityAlias === 'shell') {
            addWarning(
                warnings,
                scriptName,
                stepPath,
                'The `shell:` prefix is deprecated. Use `cross-shell:`, `cmd:`, `powershell:`, `pwsh:`, `bash:`, or `path:` instead.'
            );
        }

        if (classification.shellKind === 'bash' && isWindows) {
            addWarning(
                warnings,
                scriptName,
                stepPath,
                'The `bash:` prefix is not supported on Windows without an external bash installation.'
            );
        }

        if ((classification.shellKind === 'cmd' || classification.shellKind === 'powershell') && !isWindows) {
            addWarning(
                warnings,
                scriptName,
                stepPath,
                `The \`${classification.shellKind}:\` prefix is Windows-only and is not supported on this platform.`
            );
        }

        const portableAlternative = hasPortableAlternative(injectedCommand);
        if (portableAlternative) {
            addWarning(warnings, scriptName, stepPath, portableAlternative);
        }

        return;
    }

    if (classification.kind === 'path') {
        if (hasShellOperators(injectedCommand)) {
            addWarning(
                warnings,
                scriptName,
                stepPath,
                'The `path:` prefix does not support shell operators such as `&&`, `||`, or `|`.'
            );
        }

        return;
    }
}

/**
 * Validates every task defined in scripts.yaml and returns portability warnings.
 *
 * @param {ValidationContext} context
 * @returns {ValidationWarning[]}
 */
export function validateScripts(context) {
    /** @type {ValidationWarning[]} */
    const warnings = [];

    for (const [scriptName, task] of Object.entries(context.scripts)) {
        validateTask(task, context, scriptName, scriptName, warnings);
    }

    return warnings;
}