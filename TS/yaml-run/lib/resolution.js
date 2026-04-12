import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConfigFiles, findRepositoryRoot } from './constants.js';
import { isPlainObject } from './utils.js';

const IGNORED_DIRECTORIES = new Set([
    '.git',
    '.history',
    '.vs',
    '.vscode',
    '.betterGit',
    'build',
    'Build',
    'dist',
    'node_modules',
    'www',
    'cap_sync',
]);

/**
 * @typedef {{
 *     kind: 'local-package' | 'npm-package' | 'site-bin',
 *     packageName: string,
 *     binName: string,
 *     executeSpec: string,
 *     sourcePath: string,
 *     label: string,
 * }} ToolCandidate
 */

/**
 * @typedef {{
 *     name: string | null,
 *     bin: unknown,
 *     exports: unknown,
 *     packageJsonPath: string | null,
 *     denoManifestPath: string | null,
 * }} PackageMetadata
 */

/**
 * @typedef {{
 *     kind: 'script' | 'tool' | 'shell',
 *     rawCommand: string,
 *     firstToken?: string,
 *     args?: string[],
 *     scriptName?: string,
 *     tool?: ToolCandidate,
 * }} CommandClassification
 */

async function pathExists(filePath) {
    try {
        await Deno.stat(filePath);
        return true;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return false;
        }

        throw error;
    }
}

function stripJsonc(input) {
    let output = '';
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < input.length; i++) {
        const character = input[i];
        const nextCharacter = input[i + 1];

        if (inLineComment) {
            if (character === '\n' || character === '\r') {
                inLineComment = false;
                output += character;
            }

            continue;
        }

        if (inBlockComment) {
            if (character === '*' && nextCharacter === '/') {
                inBlockComment = false;
                i++;
            }

            continue;
        }

        if (inString) {
            output += character;

            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === '"') {
                inString = false;
            }

            continue;
        }

        if (character === '"') {
            inString = true;
            output += character;
            continue;
        }

        if (character === '/' && nextCharacter === '/') {
            inLineComment = true;
            i++;
            continue;
        }

        if (character === '/' && nextCharacter === '*') {
            inBlockComment = true;
            i++;
            continue;
        }

        output += character;
    }

    return output.replace(/,\s*([}\]])/g, '$1');
}

async function readJsonFile(filePath) {
    return JSON.parse(await Deno.readTextFile(filePath));
}

async function readJsoncFile(filePath) {
    const rawText = await Deno.readTextFile(filePath);
    return JSON.parse(stripJsonc(rawText));
}

async function readManifestFile(filePath) {
    if (!(await pathExists(filePath))) {
        return null;
    }

    if (filePath.endsWith('.jsonc')) {
        return readJsoncFile(filePath);
    }

    return readJsonFile(filePath);
}

/**
 * @param {string} packageName
 */
function getUnscopedPackageName(packageName) {
    const lastSlashIndex = packageName.lastIndexOf('/');
    if (lastSlashIndex === -1) {
        return packageName;
    }

    return packageName.slice(lastSlashIndex + 1);
}

/**
 * @param {string} target
 */
function extractNpmPackageName(target) {
    if (!target.startsWith('npm:')) {
        return null;
    }

    let packageName = target.slice(4).trim();
    const packageJsonIndex = packageName.indexOf('/package.json');
    if (packageJsonIndex !== -1) {
        packageName = packageName.slice(0, packageJsonIndex);
    }

    const versionSeparatorIndex = packageName.lastIndexOf('@');
    if (versionSeparatorIndex > 0) {
        packageName = packageName.slice(0, versionSeparatorIndex);
    }

    return packageName;
}

/**
 * @param {string} packageName
 * @param {unknown} binValue
 * @returns {Array<{ binName: string, relativePath: string }>}
 */
function normalizeBinEntries(packageName, binValue) {
    /** @type {Array<{ binName: string, relativePath: string }>} */
    const binEntries = [];

    if (typeof binValue === 'string') {
        binEntries.push({
            binName: getUnscopedPackageName(packageName),
            relativePath: binValue,
        });

        return binEntries;
    }

    if (!isPlainObject(binValue)) {
        return binEntries;
    }

    for (const [binName, relativePath] of Object.entries(binValue)) {
        if (typeof relativePath !== 'string') {
            continue;
        }

        binEntries.push({ binName, relativePath });
    }

    return binEntries;
}

/**
 * @param {unknown} exportsValue
 * @returns {string | null}
 */
function resolveExportTarget(exportsValue) {
    if (typeof exportsValue === 'string') {
        return exportsValue;
    }

    if (!isPlainObject(exportsValue)) {
        return null;
    }

    const directRootExport = exportsValue['.'] ?? exportsValue['./'];
    if (typeof directRootExport === 'string') {
        return directRootExport;
    }

    if (isPlainObject(directRootExport)) {
        const preferredKeys = ['default', 'import', 'node'];

        for (const key of preferredKeys) {
            const target = directRootExport[key];
            if (typeof target === 'string') {
                return target;
            }
        }
    }

    const stringValues = Object.values(exportsValue).filter((value) => typeof value === 'string');
    if (stringValues.length === 1) {
        return stringValues[0];
    }

    return null;
}

/**
 * @param {string} packageName
 * @param {unknown} exportsValue
 * @returns {Array<{ binName: string, relativePath: string }>}
 */
function normalizeExportEntries(packageName, exportsValue) {
    const exportTarget = resolveExportTarget(exportsValue);
    if (typeof exportTarget !== 'string') {
        return [];
    }

    return [
        {
            binName: getUnscopedPackageName(packageName),
            relativePath: exportTarget,
        },
    ];
}

/**
 * @param {string} packageName
 * @param {PackageMetadata} metadata
 */
function collectLocalToolEntries(packageName, metadata) {
    const binEntries = normalizeBinEntries(packageName, metadata.bin);
    if (binEntries.length > 0) {
        return {
            entries: binEntries,
            sourcePath: metadata.packageJsonPath ?? metadata.denoManifestPath,
        };
    }

    const exportEntries = normalizeExportEntries(packageName, metadata.exports);
    if (exportEntries.length > 0) {
        return {
            entries: exportEntries,
            sourcePath: metadata.denoManifestPath ?? metadata.packageJsonPath,
        };
    }

    return {
        entries: [],
        sourcePath: metadata.packageJsonPath ?? metadata.denoManifestPath,
    };
}

function createToolCandidate(kind, packageName, binName, executeSpec, sourcePath) {
    return {
        kind,
        packageName,
        binName,
        executeSpec,
        sourcePath,
        label: `${kind}:${packageName}:${binName}`,
    };
}

/**
 * @param {Map<string, ToolCandidate[]>} catalog
 * @param {ToolCandidate} candidate
 */
function addToolCandidate(catalog, candidate) {
    const existingCandidates = catalog.get(candidate.binName);
    if (existingCandidates) {
        existingCandidates.push(candidate);
        return;
    }

    catalog.set(candidate.binName, [candidate]);
}

/**
 * @param {string} repoRoot
 */
async function discoverLocalPackageDirectories(repoRoot) {
    /** @type {Map<string, string[]>} */
    const packageDirectories = new Map();
    /** @type {string[]} */
    const rootsToScan = [];

    const toolsTsRoot = path.join(repoRoot, 'Tools', 'TS');
    const toolsRoot = path.join(repoRoot, 'Tools');

    if (await pathExists(toolsTsRoot)) {
        rootsToScan.push(toolsTsRoot);
    } else if (await pathExists(toolsRoot)) {
        rootsToScan.push(toolsRoot);
    }

    for (const rootDir of rootsToScan) {
        const stack = [rootDir];

        while (stack.length > 0) {
            const currentDir = stack.pop();
            if (!currentDir) {
                continue;
            }

            const packageJsonPath = path.join(currentDir, 'package.json');
            let packageName = null;

            if (await pathExists(packageJsonPath)) {
                try {
                    const packageJson = await readJsonFile(packageJsonPath);
                    packageName = typeof packageJson.name === 'string' ? packageJson.name : null;
                } catch (error) {
                    console.warn(`[yaml-run] Warning: Unable to read local package metadata at ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            if (packageName === null) {
                const denoJsonPath = path.join(currentDir, 'deno.json');
                const denoJsoncPath = path.join(currentDir, 'deno.jsonc');
                const denoManifestPath = (await pathExists(denoJsonPath)) ? denoJsonPath : (await pathExists(denoJsoncPath)) ? denoJsoncPath : null;

                if (denoManifestPath) {
                    try {
                        const denoManifest = await readManifestFile(denoManifestPath);
                        packageName = isPlainObject(denoManifest) && typeof denoManifest.name === 'string' ? denoManifest.name : null;
                    } catch (error) {
                        console.warn(`[yaml-run] Warning: Unable to read local Deno metadata at ${denoManifestPath}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }

            if (packageName) {
                const existingDirectories = packageDirectories.get(packageName);
                if (existingDirectories) {
                    existingDirectories.push(currentDir);
                } else {
                    packageDirectories.set(packageName, [currentDir]);
                }
            }

            try {
                for await (const entry of Deno.readDir(currentDir)) {
                if (!entry.isDirectory) {
                    continue;
                }

                if (IGNORED_DIRECTORIES.has(entry.name)) {
                    continue;
                }

                stack.push(path.join(currentDir, entry.name));
                }
            } catch (error) {
                if (error instanceof Deno.errors.NotFound) {
                    continue;
                }

                throw error;
            }
        }
    }

    return packageDirectories;
}

/**
 * @param {Record<string, unknown>} sitePackageJson
 */
function collectPackageNamesFromPackageJson(sitePackageJson) {
    /** @type {Set<string>} */
    const packageNames = new Set();
    const dependencyScopes = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

    for (const scopeName of dependencyScopes) {
        const dependencyBlock = sitePackageJson[scopeName];
        if (!isPlainObject(dependencyBlock)) {
            continue;
        }

        for (const packageName of Object.keys(dependencyBlock)) {
            packageNames.add(packageName);
        }
    }

    return packageNames;
}

/**
 * @param {Record<string, unknown>} denoManifest
 */
function collectPackageNamesFromDenoManifest(denoManifest) {
    /** @type {Set<string>} */
    const packageNames = new Set();
    const importsBlock = denoManifest.imports;

    if (!isPlainObject(importsBlock)) {
        return packageNames;
    }

    for (const value of Object.values(importsBlock)) {
        if (typeof value !== 'string') {
            continue;
        }

        const packageName = extractNpmPackageName(value);
        if (packageName) {
            packageNames.add(packageName);
        }
    }

    return packageNames;
}

/**
 * @param {string} packageName
 */
async function loadPackageMetadata(packageName) {
    try {
        const resolvedModulePath = fileURLToPath(await import.meta.resolve(`npm:${packageName}`));
        let currentDirectory = path.dirname(resolvedModulePath);

        while (true) {
            const packageJsonPath = path.join(currentDirectory, 'package.json');

            if (await pathExists(packageJsonPath)) {
                return readJsonFile(packageJsonPath);
            }

            const parentDirectory = path.dirname(currentDirectory);
            if (parentDirectory === currentDirectory) {
                break;
            }

            currentDirectory = parentDirectory;
        }

        return null;
    } catch (error) {
        console.warn(`[yaml-run] Warning: Unable to inspect package metadata for ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

/**
 * @param {string} packageDirectory
 * @returns {Promise<PackageMetadata | null>}
 */
async function loadLocalPackageMetadata(packageDirectory) {
    const packageJsonPath = path.join(packageDirectory, 'package.json');
    const denoJsonPath = path.join(packageDirectory, 'deno.json');
    const denoJsoncPath = path.join(packageDirectory, 'deno.jsonc');

    /** @type {PackageMetadata} */
    const metadata = {
        name: null,
        bin: undefined,
        exports: undefined,
        packageJsonPath: null,
        denoManifestPath: null,
    };

    const packageJson = await readManifestFile(packageJsonPath);
    if (isPlainObject(packageJson)) {
        metadata.packageJsonPath = packageJsonPath;
        metadata.name = typeof packageJson.name === 'string' ? packageJson.name : metadata.name;
        metadata.bin = packageJson.bin;

        if ('exports' in packageJson) {
            metadata.exports = packageJson.exports;
        }
    }

    const denoManifestPath = (await pathExists(denoJsonPath)) ? denoJsonPath : (await pathExists(denoJsoncPath)) ? denoJsoncPath : null;
    if (denoManifestPath) {
        const denoManifest = await readManifestFile(denoManifestPath);
        if (isPlainObject(denoManifest)) {
            metadata.denoManifestPath = denoManifestPath;

            if (metadata.name === null && typeof denoManifest.name === 'string') {
                metadata.name = denoManifest.name;
            }

            if (metadata.bin === undefined && 'bin' in denoManifest) {
                metadata.bin = denoManifest.bin;
            }

            if ('exports' in denoManifest) {
                metadata.exports = denoManifest.exports;
            }
        }
    }

    if (metadata.name === null && metadata.packageJsonPath === null && metadata.denoManifestPath === null) {
        return null;
    }

    return metadata;
}

/**
 * Builds the catalog of managed commands from the site manifests.
 *
 * @param {string} siteRoot
 */
export async function buildToolCatalog(siteRoot) {
    const configFiles = createConfigFiles(siteRoot);
    const sitePackageJson = await readManifestFile(configFiles.packageJson);
    const siteDenoJson = (await readManifestFile(configFiles.denoJson)) ?? (await readManifestFile(configFiles.denoJsonc));
    const repositoryRoot = await findRepositoryRoot(siteRoot);
    const localPackageDirectories = await discoverLocalPackageDirectories(repositoryRoot);
    /** @type {Set<string>} */
    const packageNames = new Set();
    /** @type {Map<string, ToolCandidate[]>} */
    const toolCatalog = new Map();

    if (isPlainObject(sitePackageJson)) {
        for (const packageName of collectPackageNamesFromPackageJson(sitePackageJson)) {
            packageNames.add(packageName);
        }
    }

    if (isPlainObject(siteDenoJson)) {
        for (const packageName of collectPackageNamesFromDenoManifest(siteDenoJson)) {
            packageNames.add(packageName);
        }
    }

    if (isPlainObject(sitePackageJson)) {
        const packageName = typeof sitePackageJson.name === 'string' ? sitePackageJson.name : null;
        const packageBinEntries = normalizeBinEntries(packageName ?? '', sitePackageJson.bin);

        if (packageName) {
            const sitePackageDirectories = localPackageDirectories.get(packageName) ?? [siteRoot];

            for (const sitePackageDirectory of sitePackageDirectories) {
                for (const binEntry of packageBinEntries) {
                    addToolCandidate(
                        toolCatalog,
                        createToolCandidate(
                            'site-bin',
                            packageName,
                            binEntry.binName,
                            path.resolve(sitePackageDirectory, binEntry.relativePath),
                            path.join(sitePackageDirectory, 'package.json')
                        )
                    );
                }
            }
        }
    }

    for (const packageName of packageNames) {
        const localPackageDirectoryList = localPackageDirectories.get(packageName) ?? [];
        if (localPackageDirectoryList.length > 0) {
            let hasLocalCandidates = false;

            for (const packageDirectory of localPackageDirectoryList) {
                const localMetadata = await loadLocalPackageMetadata(packageDirectory);
                if (!isPlainObject(localMetadata)) {
                    continue;
                }

                const packageMetadataName = typeof localMetadata.name === 'string' ? localMetadata.name : packageName;
                const toolEntries = collectLocalToolEntries(packageMetadataName, localMetadata);

                if (toolEntries.entries.length === 0) {
                    continue;
                }

                hasLocalCandidates = true;

                for (const binEntry of toolEntries.entries) {
                    addToolCandidate(
                        toolCatalog,
                        createToolCandidate(
                            'local-package',
                            packageMetadataName,
                            binEntry.binName,
                            path.resolve(packageDirectory, binEntry.relativePath),
                            toolEntries.sourcePath ?? path.join(packageDirectory, 'package.json')
                        )
                    );
                }
            }

            if (hasLocalCandidates) {
                continue;
            }
        }

        const packageMetadata = await loadPackageMetadata(packageName);
        if (!isPlainObject(packageMetadata)) {
            continue;
        }

        const binEntries = normalizeBinEntries(packageName, packageMetadata.bin);
        if (binEntries.length === 0) {
            continue;
        }

        for (const binEntry of binEntries) {
            addToolCandidate(
                toolCatalog,
                createToolCandidate(
                    'npm-package',
                    packageName,
                    binEntry.binName,
                    `npm:${packageName}`,
                    `npm:${packageName}/package.json`
                )
            );
        }
    }

    return toolCatalog;
}

function tokenizeCommand(commandText) {
    /** @type {string[]} */
    const tokens = [];
    let currentToken = '';
    let inSingleQuotes = false;
    let inDoubleQuotes = false;
    let escaped = false;

    for (let i = 0; i < commandText.length; i++) {
        const character = commandText[i];

        if (escaped) {
            currentToken += character;
            escaped = false;
            continue;
        }

        if (character === '\\') {
            escaped = true;
            continue;
        }

        if (inSingleQuotes) {
            if (character === "'") {
                inSingleQuotes = false;
            } else {
                currentToken += character;
            }

            continue;
        }

        if (inDoubleQuotes) {
            if (character === '"') {
                inDoubleQuotes = false;
            } else {
                currentToken += character;
            }

            continue;
        }

        if (/\s/.test(character)) {
            if (currentToken.length > 0) {
                tokens.push(currentToken);
                currentToken = '';
            }

            continue;
        }

        if (character === "'") {
            inSingleQuotes = true;
            continue;
        }

        if (character === '"') {
            inDoubleQuotes = true;
            continue;
        }

        currentToken += character;
    }

    if (escaped || inSingleQuotes || inDoubleQuotes) {
        return null;
    }

    if (currentToken.length > 0) {
        tokens.push(currentToken);
    }

    return tokens;
}

/**
 * @param {ToolCandidate[]} candidates
 */
function describeToolCandidates(candidates) {
    return candidates.map((candidate) => `${candidate.label} -> ${candidate.executeSpec}`);
}

/**
 * @param {string} targetName
 * @param {ToolCandidate[]} candidates
 */
function resolveExplicitToolTarget(targetName, candidates) {
    const matches = candidates.filter((candidate) => {
        return (
            candidate.packageName === targetName ||
            getUnscopedPackageName(candidate.packageName) === targetName ||
            candidate.binName === targetName
        );
    });

    if (matches.length === 0) {
        throw new Error(`Workspace tool "${targetName}" was not found.`);
    }

    if (matches.length > 1) {
        throw new Error(
            `Workspace tool "${targetName}" is ambiguous. Matches: ${describeToolCandidates(matches).join(', ')}.`
        );
    }

    return matches[0];
}

/**
 * @param {string} commandText
 */
function splitExplicitCommand(commandText) {
    const colonIndex = commandText.indexOf(':');
    if (colonIndex === -1) {
        return null;
    }

    const prefix = commandText.slice(0, colonIndex).trim();
    const remainder = commandText.slice(colonIndex + 1).trimStart();

    if (prefix === 'shell' || prefix === 'npm' || prefix === 'workspace') {
        return { prefix, remainder };
    }

    return null;
}

/**
 * Classifies a raw command string before execution.
 *
 * @param {string} commandText
 * @param {Record<string, unknown>} scriptConfig
 * @param {Map<string, ToolCandidate[]>} toolCatalog
 * @returns {CommandClassification}
 */
export function classifyCommand(commandText, scriptConfig, toolCatalog) {
    const trimmedCommand = commandText.trim();
    if (trimmedCommand.length === 0) {
        return {
            kind: 'shell',
            rawCommand: trimmedCommand,
        };
    }

    if (Object.prototype.hasOwnProperty.call(scriptConfig, trimmedCommand)) {
        return {
            kind: 'script',
            rawCommand: trimmedCommand,
            scriptName: trimmedCommand,
        };
    }

    const explicitCommand = splitExplicitCommand(trimmedCommand);
    if (explicitCommand) {
        const explicitTokens = tokenizeCommand(explicitCommand.remainder);
        if (explicitCommand.prefix === 'shell') {
            return {
                kind: 'shell',
                rawCommand: explicitCommand.remainder,
            };
        }

        if (!explicitTokens || explicitTokens.length === 0) {
            throw new Error(`Command "${trimmedCommand}" is missing a target.`);
        }

        const targetName = explicitTokens[0];
        const args = explicitTokens.slice(1);

        if (explicitCommand.prefix === 'npm') {
            return {
                kind: 'tool',
                rawCommand: trimmedCommand,
                firstToken: targetName,
                args,
                tool: {
                    kind: 'npm-package',
                    packageName: targetName,
                    binName: getUnscopedPackageName(targetName),
                    executeSpec: `npm:${targetName}`,
                    sourcePath: `npm:${targetName}/package.json`,
                    label: `npm-package:${targetName}:${getUnscopedPackageName(targetName)}`,
                },
            };
        }

        const resolvedTool = resolveExplicitToolTarget(targetName, Array.from(toolCatalog.values()).flat());
        return {
            kind: 'tool',
            rawCommand: trimmedCommand,
            firstToken: targetName,
            args,
            tool: resolvedTool,
        };
    }

    const tokens = tokenizeCommand(trimmedCommand);
    if (!tokens || tokens.length === 0) {
        return {
            kind: 'shell',
            rawCommand: trimmedCommand,
        };
    }

    const firstToken = tokens[0];

    if (Object.prototype.hasOwnProperty.call(scriptConfig, firstToken)) {
        return {
            kind: 'script',
            rawCommand: trimmedCommand,
            firstToken,
            args: tokens.slice(1),
            scriptName: firstToken,
        };
    }

    return {
        kind: 'script',
        rawCommand: trimmedCommand,
        firstToken,
        args: tokens.slice(1),
        scriptName: firstToken,
    };
}
