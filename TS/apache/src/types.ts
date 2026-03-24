/* :: :: Types :: START :: */

export interface StartOptions {
    output?: boolean;
    port: string;
    config?: string;
    documentRoot?: string;
}

export interface KillOptions {
    all?: boolean;
}

export interface TrackedApacheProcess {
    pid: number;
    startedAtIso: string;
    port: string;
    output: boolean;
    documentRoot?: string;
    configDirectory?: string;
}

export interface TrackedVHost {
    id: string;
    pid: number;
    port: string;
    documentRoot: string;
    serverName: string;
    createdAtIso: string;
}

export interface SpawnProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export interface RuntimeState {
    processes: TrackedApacheProcess[];
    vhosts: TrackedVHost[];
}

/* :: :: Types :: END :: */
