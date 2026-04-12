import process from 'node:process';

import type { SpawnProcessResult } from './types.ts';

/* :: :: Process Helpers :: START :: */

export async function spawnProcessAndCollect (
    command: string,
    args: string[]
): Promise<SpawnProcessResult> {
    const output: Deno.CommandOutput = await new Deno.Command(command, {
        args,
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
    }).output();

    const decoder: TextDecoder = new TextDecoder();

    return {
        exitCode: output.code ?? 1,
        stdout: decoder.decode(output.stdout).trim(),
        stderr: decoder.decode(output.stderr).trim(),
    };
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

function canBindToPort (
    port: number,
    host: string
): boolean {
    let listener: Deno.TcpListener | null = null;

    try {
        listener = Deno.listen({
            port,
            hostname: host,
        });
        return true;
    } catch (error: unknown) {
        const errorCode: string | undefined = (error as { code?: string }).code;
        if (errorCode === 'EADDRINUSE' || error instanceof Deno.errors.AddrInUse) {
            return false;
        }

        throw error;
    } finally {
        if (listener) {
            listener.close();
        }
    }
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
