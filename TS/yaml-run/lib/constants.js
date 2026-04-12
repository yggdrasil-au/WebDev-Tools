import path from 'node:path';

const CONFIG_FILE_NAMES = {
    vars: 'vars.yaml',
    scripts: 'scripts.yaml',
    packageJson: 'package.json',
    denoJson: 'deno.json',
    denoJsonc: 'deno.jsonc',
};

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

async function findAncestorDirectoryWithFile(startDir, fileName) {
    let currentDir = path.resolve(startDir);

    while (true) {
        const candidatePath = path.join(currentDir, fileName);
        if (await pathExists(candidatePath)) {
            return currentDir;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            break;
        }

        currentDir = parentDir;
    }

    return null;
}

/**
 * Finds the site folder that owns scripts.yaml.
 *
 * @param {string} [startDir]
 */
export async function findSiteRoot(startDir = Deno.cwd()) {
    const siteRoot = await findAncestorDirectoryWithFile(startDir, CONFIG_FILE_NAMES.scripts);
    if (!siteRoot) {
        throw new Error('scripts.yaml not found in current directory or any parent directory.');
    }

    return siteRoot;
}

/**
 * Finds the repository root that contains the shared Tools/ and Sites/ folders.
 *
 * @param {string} [startDir]
 */
export async function findRepositoryRoot(startDir = Deno.cwd()) {
    let currentDir = path.resolve(startDir);
    let candidateDir = null;

    while (true) {
        const toolsDir = path.join(currentDir, 'Tools');
        const sitesDir = path.join(currentDir, 'Sites');

        if (await pathExists(toolsDir) && await pathExists(sitesDir)) {
            candidateDir = currentDir;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            break;
        }

        currentDir = parentDir;
    }

    return candidateDir ?? path.resolve(startDir);
}

/**
 * Returns the site-local config file paths for yaml-run.
 *
 * @param {string} siteRoot
 */
export function createConfigFiles(siteRoot) {
    return {
        vars: path.join(siteRoot, CONFIG_FILE_NAMES.vars),
        scripts: path.join(siteRoot, CONFIG_FILE_NAMES.scripts),
        packageJson: path.join(siteRoot, CONFIG_FILE_NAMES.packageJson),
        denoJson: path.join(siteRoot, CONFIG_FILE_NAMES.denoJson),
        denoJsonc: path.join(siteRoot, CONFIG_FILE_NAMES.denoJsonc),
    };
}
