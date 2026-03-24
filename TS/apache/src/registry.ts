import * as fsPromises from 'node:fs/promises';

import {
    PROCESS_REGISTRY_PATH,
    VHOST_REGISTRY_PATH,
} from './constants.js';
import {
    RuntimeState,
    TrackedApacheProcess,
    TrackedVHost,
} from './types.js';
import {
    writeJsonFile,
} from './utils.js';

/* :: :: Registry Helpers :: START :: */

function isPositiveInteger (
    value: unknown
): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseTrackedProcesses (
    value: unknown
): TrackedApacheProcess[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const output: TrackedApacheProcess[] = [];

    for (const item of value) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const pid: unknown = (item as TrackedApacheProcess).pid;
        const startedAtIso: unknown = (item as TrackedApacheProcess).startedAtIso;
        const port: unknown = (item as TrackedApacheProcess).port;
        const outputEnabled: unknown = (item as TrackedApacheProcess).output;
        const documentRoot: unknown = (item as TrackedApacheProcess).documentRoot;
        const configDirectory: unknown = (item as TrackedApacheProcess).configDirectory;

        if (!isPositiveInteger(pid) || typeof startedAtIso !== 'string' || typeof port !== 'string') {
            continue;
        }

        const nextEntry: TrackedApacheProcess = {
            pid,
            startedAtIso,
            port,
            output: typeof outputEnabled === 'boolean' ? outputEnabled : false,
        };

        if (typeof documentRoot === 'string') {
            nextEntry.documentRoot = documentRoot;
        }

        if (typeof configDirectory === 'string') {
            nextEntry.configDirectory = configDirectory;
        }

        output.push(nextEntry);
    }

    return output;
}

function parseTrackedVHosts (
    value: unknown
): TrackedVHost[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const output: TrackedVHost[] = [];

    for (const item of value) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const id: unknown = (item as TrackedVHost).id;
        const pid: unknown = (item as TrackedVHost).pid;
        const port: unknown = (item as TrackedVHost).port;
        const documentRoot: unknown = (item as TrackedVHost).documentRoot;
        const serverName: unknown = (item as TrackedVHost).serverName;
        const createdAtIso: unknown = (item as TrackedVHost).createdAtIso;

        if (typeof id !== 'string' || typeof port !== 'string' || typeof documentRoot !== 'string' || typeof serverName !== 'string' || typeof createdAtIso !== 'string') {
            continue;
        }

        const sanitizedPid: number = isPositiveInteger(pid) ? pid : 0;

        output.push({
            id,
            pid: sanitizedPid,
            port,
            documentRoot,
            serverName,
            createdAtIso,
        });
    }

    return output;
}

async function readJsonFile (
    filePath: string
): Promise<unknown> {
    try {
        const raw: string = await fsPromises.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }

        throw error;
    }
}

export async function readProcessRegistry (): Promise<TrackedApacheProcess[]> {
    const content: unknown = await readJsonFile(PROCESS_REGISTRY_PATH);
    return parseTrackedProcesses(content);
}

export async function writeProcessRegistry (
    entries: TrackedApacheProcess[]
): Promise<void> {
    await writeJsonFile(PROCESS_REGISTRY_PATH, entries);
}

export async function readVHostRegistry (): Promise<TrackedVHost[]> {
    const content: unknown = await readJsonFile(VHOST_REGISTRY_PATH);
    return parseTrackedVHosts(content);
}

export async function writeVHostRegistry (
    entries: TrackedVHost[]
): Promise<void> {
    await writeJsonFile(VHOST_REGISTRY_PATH, entries);
}

export async function resetRuntimeRegistries (): Promise<void> {
    await writeProcessRegistry([]);
    await writeVHostRegistry([]);
}

export async function pruneRuntimeState (
    isPidAlive: (pid: number) => boolean
): Promise<RuntimeState> {
    const processEntries: TrackedApacheProcess[] = await readProcessRegistry();
    const aliveProcessEntries: TrackedApacheProcess[] = processEntries.filter((entry: TrackedApacheProcess) => {
        return isPidAlive(entry.pid);
    });

    const alivePidSet: Set<number> = new Set<number>(aliveProcessEntries.map((entry: TrackedApacheProcess) => {
        return entry.pid;
    }));

    const vhostEntries: TrackedVHost[] = await readVHostRegistry();
    const aliveVhostEntries: TrackedVHost[] = vhostEntries.filter((entry: TrackedVHost) => {
        return alivePidSet.has(entry.pid);
    });

    await writeProcessRegistry(aliveProcessEntries);
    await writeVHostRegistry(aliveVhostEntries);

    return {
        processes: aliveProcessEntries,
        vhosts: aliveVhostEntries,
    };
}

/* :: :: Registry Helpers :: END :: */
