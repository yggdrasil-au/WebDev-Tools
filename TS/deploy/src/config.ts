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
    remoteDir?: string;
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

    profile.localDir ??= defaults.localDir;
    profile.remoteDir ??= defaults.remoteDir;
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

/* :: :: Public Functions :: END :: */
