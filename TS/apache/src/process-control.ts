import { spawn } from 'node:child_process';
import * as net from 'node:net';

import { SpawnProcessResult } from './types.js';

/* :: :: Process Helpers :: START :: */

export async function spawnProcessAndCollect (
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

export function isProcessAlive (
    pid: number
): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        const errorCode: string | undefined = (error as NodeJS.ErrnoException).code;
        return errorCode === 'EPERM';
    }
}

export async function terminateProcessByPid (
    pid: number
): Promise<boolean> {
    if (pid <= 0 || !Number.isInteger(pid)) {
        throw new Error(`Invalid PID '${pid}'.`);
    }

    if (process.platform === 'win32') {
        const result: SpawnProcessResult = await spawnProcessAndCollect('taskkill', ['/PID', String(pid), '/T', '/F']);
        const output: string = `${result.stdout} ${result.stderr}`.trim();

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

async function canBindToPort (
    port: number,
    host: string
): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        const server: net.Server = net.createServer();

        server.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                resolve(false);
                return;
            }

            reject(error);
        });

        server.once('listening', () => {
            server.close((closeError?: Error) => {
                if (closeError) {
                    reject(closeError);
                    return;
                }

                resolve(true);
            });
        });

        server.listen({ port, host, exclusive: true });
    });
}

export async function isPortAvailable (
    port: number
): Promise<boolean> {
    const v4Available: boolean = await canBindToPort(port, '0.0.0.0');
    if (!v4Available) {
        return false;
    }

    try {
        return await canBindToPort(port, '::');
    } catch {
        return true;
    }
}

/* :: :: Process Helpers :: END :: */
