import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

const TARGET_ASSETS = {
    "win32:x64": `caddy_${CADDY_VERSION}_windows_amd64.zip`,
    "win32:arm64": `caddy_${CADDY_VERSION}_windows_arm64.zip`,
    "linux:x64": `caddy_${CADDY_VERSION}_linux_amd64.tar.gz`,
    "linux:arm64": `caddy_${CADDY_VERSION}_linux_arm64.tar.gz`,
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

function getTargetAssetName () {
    const key = `${process.platform}:${process.arch}`;
    return TARGET_ASSETS[key] ?? null;
}

function downloadText (url) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, (response) => {
            if (response.statusCode && response.statusCode >= 400) {
                reject(new Error(`HTTP ${response.statusCode} while downloading text from ${url}`));
                return;
            }

            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                resolve(downloadText(response.headers.location));
                return;
            }

            let content = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                content += chunk;
            });
            response.on("end", () => {
                resolve(content);
            });
        });

        request.on("error", (error) => {
            reject(error);
        });
    });
}

function downloadFile (url, destinationPath) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, (response) => {
            if (response.statusCode && response.statusCode >= 400) {
                reject(new Error(`HTTP ${response.statusCode} while downloading ${url}`));
                return;
            }

            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                resolve(downloadFile(response.headers.location, destinationPath));
                return;
            }

            const fileStream = fs.createWriteStream(destinationPath);
            response.pipe(fileStream);

            fileStream.on("finish", () => {
                fileStream.close(() => resolve());
            });
            fileStream.on("error", (error) => {
                reject(error);
            });
        });

        request.on("error", (error) => {
            reject(error);
        });
    });
}

function hashFile (filePath, algorithm) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(algorithm);
        const stream = fs.createReadStream(filePath);

        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", (error) => reject(error));
    });
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

function extractArchive (archivePath, targetDir, assetName) {
    const extractDir = path.join(targetDir, `extract-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });

    if (assetName.endsWith(".zip")) {
        const psScript = [
            "$ErrorActionPreference = 'Stop'",
            `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
        ].join("; ");

        const result = spawnSync("powershell", ["-NoProfile", "-Command", psScript], {
            stdio: "pipe",
            encoding: "utf8",
        });

        if (result.status !== 0) {
            throw new Error(`Zip extraction failed: ${result.stderr || result.stdout}`);
        }
    } else if (assetName.endsWith(".tar.gz")) {
        const result = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], {
            stdio: "pipe",
            encoding: "utf8",
        });

        if (result.status !== 0) {
            throw new Error(`Tar extraction failed: ${result.stderr || result.stdout}`);
        }
    } else {
        throw new Error(`Unsupported archive type for ${assetName}`);
    }

    const extractedExecutablePath = path.join(extractDir, getExecutableNameForPlatform());
    if (!fs.existsSync(extractedExecutablePath)) {
        throw new Error(`Archive did not contain ${getExecutableNameForPlatform()}`);
    }

    const finalExecutablePath = getExecutablePath();
    fs.copyFileSync(extractedExecutablePath, finalExecutablePath);

    if (process.platform !== "win32") {
        fs.chmodSync(finalExecutablePath, 0o755);
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
}

/* :: :: Helpers :: END :: */

// //

/* :: :: Main :: START :: */

async function main () {
    try {
        ensureRuntimeDir();

        const executablePath = getExecutablePath();
        if (fs.existsSync(executablePath)) {
            logInfo(`Caddy binary already present at ${executablePath}. Skipping download.`);
            return;
        }

        const assetName = getTargetAssetName();
        if (!assetName) {
            logInfo(`Platform ${process.platform}/${process.arch} is not in supported auto-download targets. Skipping.`);
            return;
        }

        const archivePath = path.join(getRuntimeDir(), assetName);
        const archiveUrl = `${RELEASE_BASE_URL}/${assetName}`;

        logInfo(`Downloading ${assetName} for ${process.platform}/${process.arch}...`);
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
        extractArchive(archivePath, getRuntimeDir(), assetName);

        fs.rmSync(archivePath, { force: true });
        logInfo(`Caddy is ready: ${getExecutablePath()}`);
    } catch (error) {
        console.error(`[caddy-cli postinstall] failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

await main();

/* :: :: Main :: END :: */
