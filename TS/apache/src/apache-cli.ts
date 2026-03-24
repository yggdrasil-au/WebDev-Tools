#!/usr/bin/env node

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import AdmZip from 'adm-zip';
import { Command } from 'commander';

/* :: :: Constants :: START :: */

const APACHE_URL: string = 'https://www.apachelounge.com/download/VS18/binaries/httpd-2.4.66-260223-Win64-VS18.zip';
const PHP_URL: string = 'https://downloads.php.net/~windows/releases/archives/php-8.5.4-Win32-vs17-x64.zip';

const CURRENT_MODULE_FILE_PATH: string = fileURLToPath(import.meta.url);
const PACKAGE_ROOT_DIR: string = path.resolve(path.dirname(CURRENT_MODULE_FILE_PATH), '..');

const RUNTIME_DIR: string = path.join(PACKAGE_ROOT_DIR, '.runtime');
const APACHE_DIR: string = path.join(RUNTIME_DIR, 'Apache24');
const PHP_DIR: string = path.join(RUNTIME_DIR, 'php');

const APACHE_ZIP_PATH: string = path.join(RUNTIME_DIR, 'apache.zip');
const PHP_ZIP_PATH: string = path.join(RUNTIME_DIR, 'php.zip');
const PROCESS_REGISTRY_PATH: string = path.join(RUNTIME_DIR, 'apache-processes.json');

const HTTPD_CONF_PATH: string = path.join(APACHE_DIR, 'conf', 'httpd.conf');
const REQUEST_TIMEOUT_MS: number = 30000;

/* :: :: Constants :: END :: */

// //

/* :: :: Types :: START :: */

interface StartOptions {
    output: boolean;
    port: string;
    config?: string;
    documentRoot?: string;
}

interface KillOptions {
    all?: boolean;
}

interface TrackedApacheProcess {
    pid: number;
    startedAtIso: string;
    port: string;
    output: boolean;
    documentRoot?: string;
    configDirectory?: string;
}

interface SpawnProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/* :: :: Types :: END :: */

// //

/* :: :: Helpers :: START :: */

function normalizePathForApache (
    inputPath: string
): string {
    return inputPath.replace(/\\/g, '/');
}

function escapeRegExp (
    value: string
): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatUnknownError (
    error: unknown
): string {
    if (error instanceof AggregateError) {
        const childMessages: string[] = [];

        for (const childError of error.errors) {
            childMessages.push(formatUnknownError(childError));
        }

        const aggregateBaseMessage: string = error.message || 'AggregateError';
        if (childMessages.length > 0) {
            return `${aggregateBaseMessage}: ${childMessages.join(' | ')}`;
        }
        return aggregateBaseMessage;
    }

    if (error instanceof Error) {
        const maybeCode: string | undefined = (error as NodeJS.ErrnoException).code;
        const maybeCauseMessage: string | undefined = error.cause instanceof Error ? error.cause.message : undefined;
        const coreMessage: string = error.message || error.name;

        if (maybeCode && maybeCauseMessage) {
            return `${coreMessage} [${maybeCode}] (cause: ${maybeCauseMessage})`;
        }

        if (maybeCode) {
            return `${coreMessage} [${maybeCode}]`;
        }

        return coreMessage;
    }

    return String(error);
}

async function ensureDirectory (
    directoryPath: string
): Promise<void> {
    await fsPromises.mkdir(directoryPath, { recursive: true });
}

async function safeUnlink (
    filePath: string
): Promise<void> {
    try {
        await fsPromises.unlink(filePath);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

async function readTrackedProcesses (): Promise<TrackedApacheProcess[]> {
    try {
        const rawContent: string = await fsPromises.readFile(PROCESS_REGISTRY_PATH, 'utf8');
        const parsedContent: unknown = JSON.parse(rawContent);

        if (!Array.isArray(parsedContent)) {
            return [];
        }

        const records: TrackedApacheProcess[] = [];
        for (const record of parsedContent) {
            if (!record || typeof record !== 'object') {
                continue;
            }

            const pidValue: unknown = (record as TrackedApacheProcess).pid;
            const startedAtIsoValue: unknown = (record as TrackedApacheProcess).startedAtIso;
            const portValue: unknown = (record as TrackedApacheProcess).port;
            const outputValue: unknown = (record as TrackedApacheProcess).output;
            const documentRootValue: unknown = (record as TrackedApacheProcess).documentRoot;
            const configDirectoryValue: unknown = (record as TrackedApacheProcess).configDirectory;

            if (typeof pidValue !== 'number' || !Number.isInteger(pidValue) || pidValue <= 0) {
                continue;
            }

            if (typeof startedAtIsoValue !== 'string' || typeof portValue !== 'string' || typeof outputValue !== 'boolean') {
                continue;
            }

            const nextRecord: TrackedApacheProcess = {
                pid: pidValue,
                startedAtIso: startedAtIsoValue,
                port: portValue,
                output: outputValue,
            };

            if (typeof documentRootValue === 'string') {
                nextRecord.documentRoot = documentRootValue;
            }

            if (typeof configDirectoryValue === 'string') {
                nextRecord.configDirectory = configDirectoryValue;
            }

            records.push(nextRecord);
        }

        return records;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function writeTrackedProcesses (
    processes: TrackedApacheProcess[]
): Promise<void> {
    await ensureDirectory(path.dirname(PROCESS_REGISTRY_PATH));
    await fsPromises.writeFile(PROCESS_REGISTRY_PATH, JSON.stringify(processes, null, 4), 'utf8');
}

function isProcessAlive (
    pid: number
): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        const errorCode: string | undefined = (error as NodeJS.ErrnoException).code;
        if (errorCode === 'EPERM') {
            return true;
        }
        return false;
    }
}

async function pruneTrackedProcesses (): Promise<TrackedApacheProcess[]> {
    const trackedProcesses: TrackedApacheProcess[] = await readTrackedProcesses();
    const aliveProcesses: TrackedApacheProcess[] = [];

    for (const trackedProcess of trackedProcesses) {
        if (isProcessAlive(trackedProcess.pid)) {
            aliveProcesses.push(trackedProcess);
        }
    }

    await writeTrackedProcesses(aliveProcesses);
    return aliveProcesses;
}

async function addTrackedProcess (
    processInfo: TrackedApacheProcess
): Promise<void> {
    const trackedProcesses: TrackedApacheProcess[] = await pruneTrackedProcesses();
    const withoutCurrentPid: TrackedApacheProcess[] = trackedProcesses.filter((entry: TrackedApacheProcess) => {
        return entry.pid !== processInfo.pid;
    });
    withoutCurrentPid.push(processInfo);
    await writeTrackedProcesses(withoutCurrentPid);
}

async function removeTrackedProcess (
    pid: number
): Promise<void> {
    const trackedProcesses: TrackedApacheProcess[] = await readTrackedProcesses();
    const nextProcesses: TrackedApacheProcess[] = trackedProcesses.filter((entry: TrackedApacheProcess) => {
        return entry.pid !== pid;
    });
    await writeTrackedProcesses(nextProcesses);
}

async function spawnProcessAndCollect (
    command: string,
    args: string[]
): Promise<SpawnProcessResult> {
    return new Promise<SpawnProcessResult>((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let stdout: string = '';
        let stderr: string = '';

        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on('error', (error: Error) => {
            reject(error);
        });

        child.on('close', (exitCode: number | null) => {
            resolve({
                exitCode: exitCode ?? 1,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
            });
        });
    });
}

async function terminateProcessByPid (
    pid: number
): Promise<boolean> {
    if (pid <= 0 || !Number.isInteger(pid)) {
        throw new Error(`Invalid PID '${pid}'.`);
    }

    if (process.platform === 'win32') {
        const result: SpawnProcessResult = await spawnProcessAndCollect('taskkill', ['/PID', String(pid), '/T', '/F']);
        const output: string = `${result.stdout} ${result.stderr}`;

        if (result.exitCode === 0) {
            return true;
        }

        if (/not found|no running instance|not exist/i.test(output)) {
            return false;
        }

        throw new Error(`taskkill failed for PID ${pid}: ${output || `exit code ${result.exitCode}`}`);
    }

    try {
        process.kill(pid, 'SIGTERM');
        return true;
    } catch (error: unknown) {
        const errorCode: string | undefined = (error as NodeJS.ErrnoException).code;
        if (errorCode === 'ESRCH') {
            return false;
        }
        throw error;
    }
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

function applyBuildPreset (
    httpdConfContent: string
): string {
    const apachePathPosix: string = normalizePathForApache(APACHE_DIR);
    const phpPathPosix: string = normalizePathForApache(PHP_DIR);

    let nextContent: string = httpdConfContent;

    nextContent = nextContent.replace(/c:\/Apache24/gi, apachePathPosix);
    nextContent = nextContent.replace(/^LoadModule\s+cgi_module/gm, '#LoadModule cgi_module');
    nextContent = nextContent.replace(/^LoadModule\s+userdir_module/gm, '#LoadModule userdir_module');

    const phpMarker: string = '# Apache CLI Custom PHP Setup';
    if (!nextContent.includes(phpMarker)) {
        const phpSetupBlock: string = `\n${phpMarker}\nLoadModule php_module "${phpPathPosix}/php8apache2_4.dll"\nAddHandler application/x-httpd-php .php\nPHPIniDir "${phpPathPosix}"\n`;
        nextContent = `${nextContent.trimEnd()}\n${phpSetupBlock}`;
    }

    return nextContent;
}

function applyStartConfig (
    httpdConfContent: string,
    options: StartOptions
): string {
    let nextContent: string = httpdConfContent;

    nextContent = nextContent.replace(/^Listen\s+\d+/gm, `Listen ${options.port}`);
    nextContent = nextContent.replace(/^#?ServerName\s+localhost:\d+/gm, `ServerName localhost:${options.port}`);

    if (options.documentRoot) {
        const resolvedDocumentRoot: string = normalizePathForApache(path.resolve(options.documentRoot));

        nextContent = nextContent.replace(/^DocumentRoot\s+".*"/gm, `DocumentRoot "${resolvedDocumentRoot}"`);
        nextContent = nextContent.replace(/^<Directory\s+".*htdocs">/gm, `<Directory "${resolvedDocumentRoot}">`);
    }

    return nextContent;
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

async function spawnApache (
    options: StartOptions
): Promise<void> {
    const httpdExecutablePath: string = path.join(APACHE_DIR, 'bin', 'httpd.exe');

    if (!fs.existsSync(httpdExecutablePath)) {
        throw new Error(`Apache executable not found at ${httpdExecutablePath}. Rebuild runtime.`);
    }

    // Keep Apache attached to a single process model so PID tracking and kill operations stay deterministic.
    const args: string[] = ['-DFOREGROUND'];

    const child = spawn(httpdExecutablePath, args, {
        stdio: options.output ? 'inherit' : 'ignore',
        detached: !options.output,
        windowsHide: false,
    });

    const childPid: number | undefined = child.pid;
    if (!childPid || childPid <= 0) {
        throw new Error('Apache started without a valid PID.');
    }

    const trackedProcess: TrackedApacheProcess = {
        pid: childPid,
        startedAtIso: new Date().toISOString(),
        port: options.port,
        output: options.output,
    };

    if (options.documentRoot) {
        trackedProcess.documentRoot = path.resolve(options.documentRoot);
    }

    if (options.config) {
        trackedProcess.configDirectory = path.resolve(options.config);
    }

    await addTrackedProcess(trackedProcess);

    child.on('error', (error: Error) => {
        console.error(`Failed to launch Apache: ${error.message}`);
        process.exitCode = 1;
        void removeTrackedProcess(childPid);
    });

    if (!options.output) {
        child.unref();
        console.log(`Apache started in the background on port ${options.port} (PID ${childPid}).`);
    } else {
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

        console.log(`Apache started on port ${options.port} (PID ${childPid}). Press Enter to stop.`);

        await new Promise<void>((resolve) => {
            child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
                if (lineInterface) {
                    lineInterface.close();
                    lineInterface = null;
                }

                void removeTrackedProcess(childPid).finally(() => {
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
    }
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
    .option('-d, --document-root <path>', 'Path to the website root directory')
    .action(async (options: StartOptions): Promise<void> => {
        try {
            await assertRuntimeExists();

            const originalConf: string = await fsPromises.readFile(HTTPD_CONF_PATH, 'utf8');
            let updatedConf: string = applyStartConfig(originalConf, options);
            updatedConf = await mapUserConfigIncludes(updatedConf, options.config);
            await fsPromises.writeFile(HTTPD_CONF_PATH, updatedConf, 'utf8');

            await spawnApache(options);
        } catch (error: unknown) {
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
            const trackedProcesses: TrackedApacheProcess[] = await pruneTrackedProcesses();

            if (id && options.all) {
                throw new Error('Provide either a specific id or --all, not both.');
            }

            if (id) {
                const pid: number = Number.parseInt(id, 10);
                if (!Number.isInteger(pid) || pid <= 0) {
                    throw new Error(`Invalid id '${id}'. Expected a positive integer PID.`);
                }

                const killed: boolean = await terminateProcessByPid(pid);
                await removeTrackedProcess(pid);

                if (killed) {
                    console.log(`Killed Apache process ${pid}.`);
                } else {
                    console.log(`Apache process ${pid} is not running.`);
                }
                return;
            }

            if (trackedProcesses.length === 0) {
                console.log('No tracked Apache processes are currently running.');
                return;
            }

            const targetProcesses: TrackedApacheProcess[] = options.all ? trackedProcesses : trackedProcesses;
            let killedCount: number = 0;
            let alreadyStoppedCount: number = 0;

            for (const trackedProcess of targetProcesses) {
                const killed: boolean = await terminateProcessByPid(trackedProcess.pid);
                await removeTrackedProcess(trackedProcess.pid);

                if (killed) {
                    killedCount += 1;
                    console.log(`Killed Apache process ${trackedProcess.pid}.`);
                } else {
                    alreadyStoppedCount += 1;
                    console.log(`Apache process ${trackedProcess.pid} is not running.`);
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
