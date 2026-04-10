import crypto from "node:crypto";
import path from "node:path";

import {
    ensureRuntimeDir,
    getExecutableNameForPlatform,
    getExecutablePath,
    getRuntimeDir,
} from "./lib/runtime-paths.mjs";

/* :: :: Constants :: START :: */

const CADDY_VERSION = "2.11.2";
const RELEASE_BASE_URL = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}`;
const CHECKSUMS_URL = `${RELEASE_BASE_URL}/caddy_${CADDY_VERSION}_checksums.txt`;
const textDecoder = new TextDecoder();

const TARGET_ASSETS = {
    "windows:x86_64": `caddy_${CADDY_VERSION}_windows_amd64.zip`,
    "windows:aarch64": `caddy_${CADDY_VERSION}_windows_arm64.zip`,
    "linux:x86_64": `caddy_${CADDY_VERSION}_linux_amd64.tar.gz`,
    "linux:aarch64": `caddy_${CADDY_VERSION}_linux_arm64.tar.gz`,
};

/* :: :: Constants :: END :: */

// //

/* :: :: Helpers :: START :: */

function logInfo (message) {
    console.log(`[caddy-cli postinstall] ${message}`);
}

function logWarning (message) {
    console.warn(`[caddy-cli postinstall] warning: ${message}`);
}

function getPlatformKey () {
    return `${Deno.build.os}:${Deno.build.arch}`;
}

function getTargetAssetName () {
    const key = getPlatformKey();
    return TARGET_ASSETS[key] ?? null;
}

async function pathExists (inputPath) {
    try {
        await Deno.stat(inputPath);
        return true;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return false;
        }

        throw error;
    }
}

async function downloadText (url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} while downloading text from ${url}`);
    }

    return await response.text();
}

async function downloadFile (url, destinationPath) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} while downloading ${url}`);
    }

    const body = response.body;
    if (!body) {
        throw new Error(`Empty response while downloading ${url}`);
    }

    const file = await Deno.open(destinationPath, {
        create: true,
        write: true,
        truncate: true,
    });

    try {
        await body.pipeTo(file.writable);
    } finally {
        file.close();
    }
}

async function hashFile (filePath, algorithm) {
    const hash = crypto.createHash(algorithm);
    const file = await Deno.open(filePath, { read: true });

    try {
        for await (const chunk of file.readable) {
            hash.update(chunk);
        }
    } finally {
        file.close();
    }

    return hash.digest("hex");
}

function parseChecksumForAsset (checksumsText, assetName) {
    const lines = checksumsText.split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/^([a-fA-F0-9]{32,})\s+\*?(.+)$/);
        if (!match) {
            continue;
        }

        const hash = match[1].toLowerCase();
        const fileName = match[2].trim();
        if (fileName === assetName) {
            return hash;
        }
    }

    return null;
}

function getHashAlgorithmFromDigestLength (digestLength) {
    switch (digestLength) {
        case 64: {
            return "sha256";
        }
        case 96: {
            return "sha384";
        }
        case 128: {
            return "sha512";
        }
        default: {
            return null;
        }
    }
}

async function runCommand (command, args) {
    const result = await new Deno.Command(command, {
        args,
        stderr: "piped",
        stdout: "piped",
    }).output();

    if (!result.success) {
        const stderr = textDecoder.decode(result.stderr).trim();
        const stdout = textDecoder.decode(result.stdout).trim();
        throw new Error(stderr || stdout || `Command failed: ${command}`);
    }
}

async function extractArchive (archivePath, targetDir, assetName) {
    const extractDir = path.join(targetDir, `extract-${Date.now()}`);
    await Deno.mkdir(extractDir, { recursive: true });

    try {
        if (assetName.endsWith(".zip")) {
            const psScript = [
                "$ErrorActionPreference = 'Stop'",
                `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
            ].join("; ");

            await runCommand("powershell", ["-NoProfile", "-Command", psScript]);
        } else if (assetName.endsWith(".tar.gz")) {
            await runCommand("tar", ["-xzf", archivePath, "-C", extractDir]);
        } else {
            throw new Error(`Unsupported archive type for ${assetName}`);
        }

        const extractedExecutablePath = path.join(extractDir, getExecutableNameForPlatform());
        if (!await pathExists(extractedExecutablePath)) {
            throw new Error(`Archive did not contain ${getExecutableNameForPlatform()}`);
        }

        const finalExecutablePath = getExecutablePath();
        await Deno.copyFile(extractedExecutablePath, finalExecutablePath);

        if (Deno.build.os !== "windows") {
            await Deno.chmod(finalExecutablePath, 0o755);
        }

        logInfo(`Caddy is ready: ${getExecutablePath()}`);
    } finally {
        await Deno.remove(extractDir, { recursive: true, force: true });
    }
}

/* :: :: Helpers :: END :: */

// //

/* :: :: Main :: START :: */

async function main () {
    try {
        await ensureRuntimeDir();

        const executablePath = getExecutablePath();
        if (await pathExists(executablePath)) {
            logInfo(`Caddy binary already present at ${executablePath}. Skipping download.`);
            return;
        }

        const assetName = getTargetAssetName();
        if (!assetName) {
            logInfo(`Platform ${Deno.build.os}/${Deno.build.arch} is not in supported auto-download targets. Skipping.`);
            return;
        }

        const archivePath = path.join(getRuntimeDir(), assetName);
        const archiveUrl = `${RELEASE_BASE_URL}/${assetName}`;

        logInfo(`Downloading ${assetName} for ${Deno.build.os}/${Deno.build.arch}...`);
        await downloadFile(archiveUrl, archivePath);

        logInfo("Downloading checksums...");
        const checksumsText = await downloadText(CHECKSUMS_URL);

        const expectedChecksum = parseChecksumForAsset(checksumsText, assetName);
        if (!expectedChecksum) {
            logWarning(`No checksum entry found for ${assetName} in checksums file.`);
        } else {
            const hashAlgorithm = getHashAlgorithmFromDigestLength(expectedChecksum.length);
            if (!hashAlgorithm) {
                logWarning(`Unsupported checksum length (${expectedChecksum.length}) for ${assetName}.`);
            }

            const actualChecksum = hashAlgorithm
                ? await hashFile(archivePath, hashAlgorithm)
                : "";
            if (actualChecksum !== expectedChecksum) {
                logWarning([
                    `Checksum mismatch for ${assetName}.`,
                    `Algorithm: ${hashAlgorithm ?? "unknown"}`,
                    `Expected: ${expectedChecksum}`,
                    `Actual:   ${actualChecksum}`,
                    "Continuing because checksum policy is warn-only.",
                ].join("\n"));
            } else {
                logInfo(`Checksum verified (${hashAlgorithm}).`);
            }
        }

        logInfo("Extracting caddy executable...");
        await extractArchive(archivePath, getRuntimeDir(), assetName);

        await Deno.remove(archivePath, { force: true });
    } catch (error) {
        console.error(`[caddy-cli postinstall] failed: ${error instanceof Error ? error.message : String(error)}`);
        Deno.exit(1);
    }
}

await main();

/* :: :: Main :: END :: */
