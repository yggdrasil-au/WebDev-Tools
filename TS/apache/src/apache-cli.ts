#!/usr/bin/env node

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';

import AdmZip from 'adm-zip';
import { Command } from 'commander';

import {
    APACHE_DIR,
    APACHE_URL,
    APACHE_ZIP_PATH,
    CORE_LISTEN_PORT_START,
    HTTPD_CONF_PATH,
    PHP_DIR,
    PHP_URL,
    PHP_ZIP_PATH,
    REQUEST_TIMEOUT_MS,
    RUNTIME_DIR,
} from './constants.js';
import {
    applyBuildPreset,
    applyStartConfig,
    clearVHostsConfigFile,
    writeManagedVHosts,
} from './apache-config.js';
import {
    isPortAvailable,
    isProcessAlive,
    terminateProcessByPid,
} from './process-control.js';
import {
    pruneRuntimeState,
    readProcessRegistry,
    readVHostRegistry,
    resetRuntimeRegistries,
    writeProcessRegistry,
    writeVHostRegistry,
} from './registry.js';
import {
    KillOptions,
    StartOptions,
    TrackedApacheProcess,
    TrackedVHost,
} from './types.js';
import {
    ensureDirectory,
    escapeRegExp,
    formatUnknownError,
    normalizePathForApache,
    safeUnlink,
} from './utils.js';

// //

/* :: :: Helpers :: START :: */

function createManagedVHostId (): string {
    const timePart: string = Date.now().toString(36);
    const randomPart: string = Math.random().toString(36).slice(2, 8);
    return `${timePart}${randomPart}`;
}

function createServerName (
    managedVHostId: string
): string {
    return `apache-cli-${managedVHostId}.local`;
}

async function downloadFile (
    urlValue: string,
    destinationPath: string,
    redirectDepth: number = 0
): Promise<void> {
    if (redirectDepth > 8) {
        throw new Error('Too many redirects while downloading runtime archive.');
    }

    await ensureDirectory(path.dirname(destinationPath));

    await new Promise<void>((resolve, reject) => {
        const parsedUrl: URL = new URL(urlValue);
        const httpClient: typeof https | typeof http = parsedUrl.protocol === 'https:' ? https : http;
        const requestOptions: https.RequestOptions = {
            protocol: parsedUrl.protocol,
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            family: 4,
            headers: {
                accept: '*/*',
                'user-agent': '@yggdrasil-au/apache-cli',
            },
        };

        const request: http.ClientRequest = httpClient.get(requestOptions, (response: http.IncomingMessage) => {
            const statusCode: number = response.statusCode ?? 0;

            if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
                const redirectTarget: string = new URL(response.headers.location, parsedUrl).toString();
                response.resume();
                void safeUnlink(destinationPath).then(() => {
                    return downloadFile(redirectTarget, destinationPath, redirectDepth + 1);
                }).then(resolve).catch(reject);
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(new Error(`Download failed for ${urlValue} with status ${statusCode}.`));
                return;
            }

            const fileStream: fs.WriteStream = fs.createWriteStream(destinationPath);

            fileStream.on('error', (streamError: Error) => {
                response.resume();
                void safeUnlink(destinationPath).then(() => {
                    reject(streamError);
                }).catch(reject);
            });

            response.on('error', (responseError: Error) => {
                fileStream.destroy(responseError);
            });

            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });

            response.pipe(fileStream);
        });

        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            request.destroy(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms while downloading ${urlValue}.`));
        });

        request.on('error', (requestError: Error) => {
            void safeUnlink(destinationPath).then(() => {
                reject(requestError);
            }).catch(reject);
        });
    });
}

async function getAllFiles (
    directoryPath: string,
    acc: string[] = []
): Promise<string[]> {
    const entries: fs.Dirent[] = await fsPromises.readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath: string = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            await getAllFiles(fullPath, acc);
        } else {
            acc.push(fullPath);
        }
    }

    return acc;
}

function extractArchive (
    zipPath: string,
    outputDirectory: string
): void {
    const archive: AdmZip = new AdmZip(zipPath);
    archive.extractAllTo(outputDirectory, true);
}

async function mapUserConfigIncludes (
    httpdConfContent: string,
    configDirectoryOption?: string
): Promise<string> {
    if (!configDirectoryOption) {
        return httpdConfContent;
    }

    const resolvedConfigDirectory: string = path.resolve(configDirectoryOption);
    const configDirectoryExists: boolean = fs.existsSync(resolvedConfigDirectory);

    if (!configDirectoryExists) {
        console.warn(`Warning: config directory '${configDirectoryOption}' does not exist.`);
        return httpdConfContent;
    }

    const userConfigFiles: string[] = await getAllFiles(resolvedConfigDirectory);
    let nextContent: string = httpdConfContent;

    for (const configFilePath of userConfigFiles) {
        const relativePath: string = normalizePathForApache(path.relative(resolvedConfigDirectory, configFilePath));
        const escapedRelativePath: string = escapeRegExp(relativePath);
        const includePattern: RegExp = new RegExp(`^#?(Include|IncludeOptional)\\s+conf/${escapedRelativePath}$`, 'gmi');

        if (includePattern.test(nextContent)) {
            const mappedAbsolutePath: string = normalizePathForApache(configFilePath);
            console.log(`Mapping user config: ${relativePath}`);
            nextContent = nextContent.replace(includePattern, `$1 "${mappedAbsolutePath}"`);
        }
    }

    return nextContent;
}

async function assertRuntimeExists (): Promise<void> {
    if (!fs.existsSync(APACHE_DIR)) {
        throw new Error('Runtime not found. Run "apache-cli build" first.');
    }

    if (!fs.existsSync(HTTPD_CONF_PATH)) {
        throw new Error(`Apache config file not found at ${HTTPD_CONF_PATH}. Rebuild runtime.`);
    }
}

async function removeRuntimeStateForPid (
    pid: number
): Promise<void> {
    const processEntries: TrackedApacheProcess[] = await readProcessRegistry();
    const nextProcessEntries: TrackedApacheProcess[] = processEntries.filter((entry: TrackedApacheProcess) => {
        return entry.pid !== pid;
    });

    const vhostEntries: TrackedVHost[] = await readVHostRegistry();
    const nextVhostEntries: TrackedVHost[] = vhostEntries.filter((entry: TrackedVHost) => {
        return entry.pid !== pid;
    });

    await writeProcessRegistry(nextProcessEntries);
    await writeVHostRegistry(nextVhostEntries);
    await writeManagedVHosts(nextVhostEntries);
}

async function reserveManagedVHost (
    port: string,
    documentRoot: string
): Promise<string> {
    const id: string = createManagedVHostId();
    const entry: TrackedVHost = {
        id,
        pid: 0,
        port,
        documentRoot,
        serverName: createServerName(id),
        createdAtIso: new Date().toISOString(),
    };

    const vhostEntries: TrackedVHost[] = await readVHostRegistry();
    const nextVhostEntries: TrackedVHost[] = [...vhostEntries, entry];
    await writeVHostRegistry(nextVhostEntries);
    await writeManagedVHosts(nextVhostEntries);
    return id;
}

async function finalizeManagedVHost (
    vhostId: string,
    pid: number
): Promise<void> {
    const vhostEntries: TrackedVHost[] = await readVHostRegistry();
    const nextVhostEntries: TrackedVHost[] = vhostEntries.map((entry: TrackedVHost) => {
        if (entry.id === vhostId) {
            return {
                ...entry,
                pid,
            };
        }

        return entry;
    });

    await writeVHostRegistry(nextVhostEntries);
    await writeManagedVHosts(nextVhostEntries);
}

async function releaseManagedVHost (
    vhostId: string
): Promise<void> {
    const vhostEntries: TrackedVHost[] = await readVHostRegistry();
    const nextVhostEntries: TrackedVHost[] = vhostEntries.filter((entry: TrackedVHost) => {
        return entry.id !== vhostId;
    });

    await writeVHostRegistry(nextVhostEntries);
    await writeManagedVHosts(nextVhostEntries);
}

async function registerTrackedProcess (
    entry: TrackedApacheProcess
): Promise<void> {
    const processEntries: TrackedApacheProcess[] = await readProcessRegistry();
    const nextProcessEntries: TrackedApacheProcess[] = processEntries.filter((existing: TrackedApacheProcess) => {
        return existing.pid !== entry.pid;
    });
    nextProcessEntries.push(entry);
    await writeProcessRegistry(nextProcessEntries);
}

function parsePort (
    value: string
): number {
    const parsedPort: number = Number.parseInt(value, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error(`Invalid port '${value}'. Expected a number between 1 and 65535.`);
    }

    return parsedPort;
}

function wait (
    durationMs: number
): Promise<void> {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
    });
}

async function assertDocumentRootDirectory (
    documentRootOption: string | undefined
): Promise<string> {
    const trimmedValue: string = (documentRootOption ?? '').trim();

    if (!trimmedValue) {
        throw new Error('The start command requires --document-root <path>.');
    }

    const resolvedDocumentRoot: string = path.resolve(trimmedValue);

    let documentRootStats: fs.Stats;
    try {
        documentRootStats = await fsPromises.stat(resolvedDocumentRoot);
    } catch (error: unknown) {
        const errorCode: string | undefined = (error as NodeJS.ErrnoException).code;
        if (errorCode === 'ENOENT') {
            throw new Error(`Document root directory does not exist: ${resolvedDocumentRoot}`);
        }

        throw error;
    }

    if (!documentRootStats.isDirectory()) {
        throw new Error(`Document root path is not a directory: ${resolvedDocumentRoot}`);
    }

    return resolvedDocumentRoot;
}

async function waitForRequestedPortBinding (
    requestedPort: string,
    apachePid: number,
    maxAttempts: number = 120,
    delayMs: number = 250
): Promise<boolean> {
    const portNumber: number = parsePort(requestedPort);

    for (let attempt: number = 0; attempt < maxAttempts; attempt += 1) {
        if (!isProcessAlive(apachePid)) {
            return false;
        }

        const reachable: boolean = await isLocalhostPortReachable(portNumber);
        if (reachable) {
            return true;
        }

        await wait(delayMs);
    }

    return false;
}

async function isLocalhostPortReachable (
    port: number
): Promise<boolean> {
    const reachableOnIpv4: boolean = await tryConnect('127.0.0.1', port);
    if (reachableOnIpv4) {
        return true;
    }

    return tryConnect('::1', port);
}

async function tryConnect (
    host: string,
    port: number,
    timeoutMs: number = 300
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const socket: net.Socket = net.createConnection({
            host,
            port,
        });

        let settled: boolean = false;

        const finalize = (connected: boolean): void => {
            if (settled) {
                return;
            }

            settled = true;
            socket.destroy();
            resolve(connected);
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => {
            finalize(true);
        });
        socket.once('timeout', () => {
            finalize(false);
        });
        socket.once('error', () => {
            finalize(false);
        });
    });
}

async function assertPortCanBeUsed (
    port: string
): Promise<void> {
    const runtimeState = await pruneRuntimeState(isProcessAlive);
    await writeManagedVHosts(runtimeState.vhosts);

    const vhostConflict: TrackedVHost | undefined = runtimeState.vhosts.find((entry: TrackedVHost) => {
        return entry.port === port;
    });

    if (vhostConflict) {
        throw new Error(`Port ${port} is already used by another host (PID ${vhostConflict.pid}).`);
    }

    const numericPort: number = parsePort(port);
    const available: boolean = await isPortAvailable(numericPort);
    if (!available) {
        throw new Error(`Port ${port} is already in use by another host on this machine.`);
    }
}

async function findAvailableCoreListenPort (
    requestedPort: string
): Promise<number> {
    const requestedPortValue: number = parsePort(requestedPort);

    for (let candidate: number = CORE_LISTEN_PORT_START; candidate >= 1; candidate -= 1) {
        if (candidate === requestedPortValue) {
            continue;
        }

        const available: boolean = await isPortAvailable(candidate);
        if (available) {
            return candidate;
        }
    }

    throw new Error('Unable to find an available Apache core listener port.');
}

/* :: :: Helpers :: END :: */

// //

/* :: :: Commands :: START :: */

const program: Command = new Command();

program
    .name('apache-cli')
    .description('Builds and manages a local Apache/PHP runtime under .runtime/.')
    .version('1.0.0');

program
    .command('build')
    .description('Download and extract Apache and PHP into the local .runtime directory')
    .action(async (): Promise<void> => {
        try {
            await ensureDirectory(RUNTIME_DIR);
            await ensureDirectory(PHP_DIR);

            console.log('Downloading Apache...');
            await downloadFile(APACHE_URL, APACHE_ZIP_PATH);

            console.log('Downloading PHP...');
            await downloadFile(PHP_URL, PHP_ZIP_PATH);

            console.log('Extracting Apache...');
            extractArchive(APACHE_ZIP_PATH, RUNTIME_DIR);

            console.log('Extracting PHP...');
            extractArchive(PHP_ZIP_PATH, PHP_DIR);

            if (!fs.existsSync(HTTPD_CONF_PATH)) {
                throw new Error(`Expected Apache config file at ${HTTPD_CONF_PATH}, but it was not found after extraction.`);
            }

            console.log('Applying Apache/PHP preset...');
            const originalConf: string = await fsPromises.readFile(HTTPD_CONF_PATH, 'utf8');
            const updatedConf: string = applyBuildPreset(originalConf);
            await fsPromises.writeFile(HTTPD_CONF_PATH, updatedConf, 'utf8');

            await clearVHostsConfigFile();
            await resetRuntimeRegistries();

            const phpIniDevPath: string = path.join(PHP_DIR, 'php.ini-development');
            const phpIniPath: string = path.join(PHP_DIR, 'php.ini');
            if (fs.existsSync(phpIniDevPath)) {
                await fsPromises.copyFile(phpIniDevPath, phpIniPath);
            }

            await safeUnlink(APACHE_ZIP_PATH);
            await safeUnlink(PHP_ZIP_PATH);

            console.log('Runtime build complete.');
        } catch (error: unknown) {
            const message: string = formatUnknownError(error);
            console.error(`Build failed: ${message}`);
            process.exitCode = 1;
        }
    });

program
    .command('start')
    .description('Start the Apache server from the local .runtime directory')
    .option('--output', 'Run Apache in foreground and pipe output')
    .option('-p, --port <number>', 'Port to listen on', '8080')
    .option('-c, --config <path>', 'Path to custom Apache config directory')
    .requiredOption('-d, --document-root <path>', 'Path to the website root directory')
    .action(async (options: StartOptions): Promise<void> => {
        let managedVHostId: string | null = null;

        try {
            const outputEnabled: boolean = Boolean(options.output);
            const resolvedDocumentRoot: string = await assertDocumentRootDirectory(options.documentRoot);

            await assertRuntimeExists();
            await assertPortCanBeUsed(options.port);
            const coreListenPort: number = await findAvailableCoreListenPort(options.port);
            if (coreListenPort !== CORE_LISTEN_PORT_START) {
                console.log(`Core listener port ${CORE_LISTEN_PORT_START} is in use. Falling back to ${coreListenPort}.`);
            }

            const originalConf: string = await fsPromises.readFile(HTTPD_CONF_PATH, 'utf8');
            let updatedConf: string = applyStartConfig(originalConf, options.port, coreListenPort, resolvedDocumentRoot);
            updatedConf = await mapUserConfigIncludes(updatedConf, options.config);
            await fsPromises.writeFile(HTTPD_CONF_PATH, updatedConf, 'utf8');

            managedVHostId = await reserveManagedVHost(options.port, resolvedDocumentRoot);

            const httpdExecutablePath: string = path.join(APACHE_DIR, 'bin', 'httpd.exe');
            if (!fs.existsSync(httpdExecutablePath)) {
                throw new Error(`Apache executable not found at ${httpdExecutablePath}. Rebuild runtime.`);
            }

            const child = spawn(httpdExecutablePath, ['-DFOREGROUND'], {
                stdio: outputEnabled ? 'inherit' : 'ignore',
                detached: !outputEnabled,
                windowsHide: false,
            });

            const childPid: number | undefined = child.pid;
            if (!childPid || childPid <= 0) {
                throw new Error('Apache started without a valid PID.');
            }

            const requestedPortBound: boolean = await waitForRequestedPortBinding(options.port, childPid);
            if (!requestedPortBound) {
                const running: boolean = isProcessAlive(childPid);

                if (running) {
                    try {
                        await terminateProcessByPid(childPid);
                    } catch (stopError: unknown) {
                        console.error(`Failed to stop Apache process ${childPid} after port verification failure: ${formatUnknownError(stopError)}`);
                    }
                }

                if (running) {
                    throw new Error(`Apache process ${childPid} started, but requested port ${options.port} did not bind within startup timeout. Check Apache config and logs.`);
                }

                throw new Error(`Apache process ${childPid} exited before requested port ${options.port} became reachable. Check Apache output and logs.`);
            }

            const processRecord: TrackedApacheProcess = {
                pid: childPid,
                startedAtIso: new Date().toISOString(),
                port: options.port,
                output: outputEnabled,
                documentRoot: resolvedDocumentRoot,
            };

            if (options.config) {
                processRecord.configDirectory = path.resolve(options.config);
            }

            await registerTrackedProcess(processRecord);

            if (managedVHostId) {
                await finalizeManagedVHost(managedVHostId, childPid);
            }

            child.on('error', (error: Error) => {
                console.error(`Failed to launch Apache: ${error.message}`);
                process.exitCode = 1;
                void removeRuntimeStateForPid(childPid);
            });

            if (!outputEnabled) {
                child.unref();
                console.log(`Apache started in the background. Requested port ${options.port}, core listener ${coreListenPort} (PID ${childPid}).`);
                return;
            }

            let stopRequestedByUser: boolean = false;
            let stopInProgress: boolean = false;
            let lineInterface: readline.Interface | null = null;

            const stopApache = async (): Promise<void> => {
                if (stopInProgress) {
                    return;
                }

                stopInProgress = true;
                stopRequestedByUser = true;

                try {
                    const killed: boolean = await terminateProcessByPid(childPid);
                    if (killed) {
                        console.log(`Stopped Apache process ${childPid}.`);
                    } else {
                        console.log(`Apache process ${childPid} was already stopped.`);
                    }
                } catch (error: unknown) {
                    console.error(`Failed to stop Apache process ${childPid}: ${formatUnknownError(error)}`);
                }
            };

            if (process.stdin.isTTY) {
                lineInterface = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout,
                });

                lineInterface.on('line', () => {
                    void stopApache();
                });
            }

            console.log(`Apache started. Requested port ${options.port}, core listener ${coreListenPort} (PID ${childPid}). Press Enter to stop.`);

            await new Promise<void>((resolve) => {
                child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
                    if (lineInterface) {
                        lineInterface.close();
                        lineInterface = null;
                    }

                    void removeRuntimeStateForPid(childPid).finally(() => {
                        if (!stopRequestedByUser) {
                            const exitDetail: string = signal ? `signal ${signal}` : `code ${code ?? 0}`;
                            console.log(`Apache process ${childPid} exited with ${exitDetail}.`);

                            if (typeof code === 'number' && code !== 0) {
                                process.exitCode = code;
                            }
                        }

                        resolve();
                    });
                });
            });
        } catch (error: unknown) {
            if (managedVHostId) {
                await releaseManagedVHost(managedVHostId);
            }

            const message: string = formatUnknownError(error);
            console.error(`Start failed: ${message}`);
            process.exitCode = 1;
        }
    });

program
    .command('kill [id]')
    .description('Kill tracked Apache process(es). With an id, kills that specific PID. Without id, kills all tracked PIDs.')
    .option('--all', 'Kill all tracked Apache processes')
    .action(async (id: string | undefined, options: KillOptions): Promise<void> => {
        try {
            const runtimeState = await pruneRuntimeState(isProcessAlive);
            await writeManagedVHosts(runtimeState.vhosts);

            if (id && options.all) {
                throw new Error('Provide either a specific id or --all, not both.');
            }

            const pidsToKill: number[] = [];

            if (id) {
                const pid: number = Number.parseInt(id, 10);
                if (!Number.isInteger(pid) || pid <= 0) {
                    throw new Error(`Invalid id '${id}'. Expected a positive integer PID.`);
                }
                pidsToKill.push(pid);
            } else {
                for (const processEntry of runtimeState.processes) {
                    pidsToKill.push(processEntry.pid);
                }
            }

            if (pidsToKill.length === 0) {
                console.log('No tracked Apache processes are currently running.');
                return;
            }

            let killedCount: number = 0;
            let alreadyStoppedCount: number = 0;

            for (const pid of pidsToKill) {
                const killed: boolean = await terminateProcessByPid(pid);
                await removeRuntimeStateForPid(pid);

                if (killed) {
                    killedCount += 1;
                    console.log(`Killed Apache process ${pid}.`);
                } else {
                    alreadyStoppedCount += 1;
                    console.log(`Apache process ${pid} is not running.`);
                }
            }

            console.log(`Kill complete. Killed: ${killedCount}. Already stopped: ${alreadyStoppedCount}.`);
        } catch (error: unknown) {
            const message: string = formatUnknownError(error);
            console.error(`Kill failed: ${message}`);
            process.exitCode = 1;
        }
    });

void program.parseAsync(process.argv);

/* :: :: Commands :: END :: */
