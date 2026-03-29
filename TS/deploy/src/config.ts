export interface DeployConfig {
    vars?: Record<string, string>;
    defaults?: DeploymentProfile;
    deployments?: Record<string, DeploymentProfile>;
}

export interface DeploymentProfile {
    host?: string;
    port?: number;
    username?: string;
    privateKeyPath?: string;
    passphrase?: string;
    password?: string;

    relayHost?: string;
    relayPort?: number;
    relayUsername?: string;
    relayPrivateKeyPath?: string;

    localDir?: string;
    localFile?: string;
    remoteDir?: string;
    remoteFile?: string;
    releasesDir?: string;
    minRemoteDepth?: number;

    strategy?: "inplace" | "symlink" | string;
    transfer?: "sftp" | "tar" | "relay" | string;

    batchSizeMB?: number;
    concurrency?: number;
    keepReleases?: number;
    cleanRemote?: boolean;

    archiveExisting?: boolean;
    archiveDir?: string;

    preCommands?: string[];
    postCommands?: string[];
    preserveFiles?: string[];
    preserveDir?: string;
}

export type DeploymentMode = "directory" | "file";

export interface DeploymentTarget {
    mode: DeploymentMode;
    localPath: string;
    remotePath: string;
}

/* :: :: Public Functions :: START :: */

export function mergeDefaults (
    profile: DeploymentProfile,
    defaults?: DeploymentProfile
): void {
    if (!defaults) {
        return;
    }

    profile.host ??= defaults.host;
    profile.port ??= defaults.port;
    profile.username ??= defaults.username;
    profile.privateKeyPath ??= defaults.privateKeyPath;
    profile.passphrase ??= defaults.passphrase;
    profile.password ??= defaults.password;

    profile.relayHost ??= defaults.relayHost;
    profile.relayPort ??= defaults.relayPort;
    profile.relayUsername ??= defaults.relayUsername;
    profile.relayPrivateKeyPath ??= defaults.relayPrivateKeyPath;

    const hasFileFields: boolean = Boolean(profile.localFile || profile.remoteFile);
    const hasDirectoryFields: boolean = Boolean(profile.localDir || profile.remoteDir);

    if (hasFileFields && !hasDirectoryFields) {
        profile.localFile ??= defaults.localFile;
        profile.remoteFile ??= defaults.remoteFile;
    } else if (hasDirectoryFields && !hasFileFields) {
        profile.localDir ??= defaults.localDir;
        profile.remoteDir ??= defaults.remoteDir;
    } else {
        profile.localDir ??= defaults.localDir;
        profile.remoteDir ??= defaults.remoteDir;
        profile.localFile ??= defaults.localFile;
        profile.remoteFile ??= defaults.remoteFile;
    }

    profile.releasesDir ??= defaults.releasesDir;
    profile.minRemoteDepth ??= defaults.minRemoteDepth ?? 2;

    profile.strategy ??= defaults.strategy;
    profile.transfer ??= defaults.transfer;

    profile.batchSizeMB ??= defaults.batchSizeMB;
    profile.concurrency ??= defaults.concurrency;
    profile.keepReleases ??= defaults.keepReleases;
    profile.cleanRemote ??= defaults.cleanRemote;

    profile.archiveExisting ??= defaults.archiveExisting;
    profile.archiveDir ??= defaults.archiveDir;

    profile.preserveDir ??= defaults.preserveDir;

    if (defaults.preCommands?.length && (!profile.preCommands || profile.preCommands.length === 0)) {
        profile.preCommands = [...defaults.preCommands];
    }

    if (defaults.postCommands?.length && (!profile.postCommands || profile.postCommands.length === 0)) {
        profile.postCommands = [...defaults.postCommands];
    }

    if (defaults.preserveFiles?.length && (!profile.preserveFiles || profile.preserveFiles.length === 0)) {
        profile.preserveFiles = [...defaults.preserveFiles];
    }
}

export function resolveDeploymentTarget(
    profile: DeploymentProfile
): DeploymentTarget | null {
    const hasDirectoryPair: boolean = Boolean(profile.localDir && profile.remoteDir);
    const hasFilePair: boolean = Boolean(profile.localFile && profile.remoteFile);

    if (hasDirectoryPair && !hasFilePair) {
        return {
            mode: "directory",
            localPath: profile.localDir as string,
            remotePath: profile.remoteDir as string,
        };
    }

    if (hasFilePair && !hasDirectoryPair) {
        return {
            mode: "file",
            localPath: profile.localFile as string,
            remotePath: profile.remoteFile as string,
        };
    }

    return null;
}

/* :: :: Public Functions :: END :: */
