using YamlDotNet.Serialization;

namespace NetDeploy.Config;


public class DeployConfig
{
    [YamlMember(Alias = "vars")]
    public Dictionary<string, string> Vars { get; set; } = new();

    [YamlMember(Alias = "defaults")]
    public DeploymentProfile Defaults { get; set; } = new();

    [YamlMember(Alias = "deployments")]
    public Dictionary<string, DeploymentProfile> Deployments { get; set; } = new();
}

public class DeploymentProfile
{
    [YamlMember(Alias = "host")]
    public string? Host { get; set; }

    [YamlMember(Alias = "port")]
    public int? Port { get; set; }

    [YamlMember(Alias = "username")]
    public string? Username { get; set; }

    [YamlMember(Alias = "privateKeyPath")]
    public string? PrivateKeyPath { get; set; }

    [YamlMember(Alias = "passphrase")]
    public string? Passphrase { get; set; }

    [YamlMember(Alias = "password")]
    public string? Password { get; set; }

    [YamlMember(Alias = "relayHost")]
    public string? RelayHost { get; set; }

    [YamlMember(Alias = "relayPort")]
    public int? RelayPort { get; set; }

    [YamlMember(Alias = "relayUsername")]
    public string? RelayUsername { get; set; }

    [YamlMember(Alias = "relayPrivateKeyPath")]
    public string? RelayPrivateKeyPath { get; set; }

    [YamlMember(Alias = "localDir")]
    public string? LocalDir { get; set; }

    [YamlMember(Alias = "remoteDir")]
    public string? RemoteDir { get; set; }

    [YamlMember(Alias = "releasesDir")]
    public string? ReleasesDir { get; set; }

    [YamlMember(Alias = "minRemoteDepth")]
    public int? MinRemoteDepth { get; set; } = 2;

    [YamlMember(Alias = "strategy")]
    public string? Strategy { get; set; } // 'inplace' | 'symlink'

    [YamlMember(Alias = "transfer")]
    public string? Transfer { get; set; } // 'sftp' | 'tar'

    [YamlMember(Alias = "batchSizeMB")]
    public int? BatchSizeMB { get; set; }

    [YamlMember(Alias = "concurrency")]
    public int? Concurrency { get; set; }

    [YamlMember(Alias = "keepReleases")]
    public int? KeepReleases { get; set; }

    [YamlMember(Alias = "cleanRemote")]
    public bool? CleanRemote { get; set; }

    [YamlMember(Alias = "archiveExisting")]
    public bool? ArchiveExisting { get; set; }

    [YamlMember(Alias = "archiveDir")]
    public string? ArchiveDir { get; set; }

    [YamlMember(Alias = "preCommands")]
    public List<string> PreCommands { get; set; } = new();

    [YamlMember(Alias = "postCommands")]
    public List<string> PostCommands { get; set; } = new();

    [YamlMember(Alias = "preserveFiles")]
    public List<string> PreserveFiles { get; set; } = new();

    [YamlMember(Alias = "preserveDir")]
    public string? PreserveDir { get; set; }

    public void MergeDefaults(DeploymentProfile defaults)
    {
        Host ??= defaults.Host;
        Port ??= defaults.Port;
        Username ??= defaults.Username;
        PrivateKeyPath ??= defaults.PrivateKeyPath;
        Passphrase ??= defaults.Passphrase;
        Password ??= defaults.Password;
        LocalDir ??= defaults.LocalDir;
        RemoteDir ??= defaults.RemoteDir;
        ReleasesDir ??= defaults.ReleasesDir;
        MinRemoteDepth ??= defaults.MinRemoteDepth;
        Strategy ??= defaults.Strategy;
        Transfer ??= defaults.Transfer;
        BatchSizeMB ??= defaults.BatchSizeMB;
        Concurrency ??= defaults.Concurrency;
        KeepReleases ??= defaults.KeepReleases;
        CleanRemote ??= defaults.CleanRemote;
        ArchiveExisting ??= defaults.ArchiveExisting;
        ArchiveDir ??= defaults.ArchiveDir;
        PreserveDir ??= defaults.PreserveDir;
        
        RelayHost ??= defaults.RelayHost;
        RelayPort ??= defaults.RelayPort;
        RelayUsername ??= defaults.RelayUsername;
        RelayPrivateKeyPath ??= defaults.RelayPrivateKeyPath;

        if (defaults.PreCommands.Count > 0 && PreCommands.Count == 0) PreCommands.AddRange(defaults.PreCommands);
        if (defaults.PostCommands.Count > 0 && PostCommands.Count == 0) PostCommands.AddRange(defaults.PostCommands);
        if (defaults.PreserveFiles.Count > 0 && PreserveFiles.Count == 0) PreserveFiles.AddRange(defaults.PreserveFiles);
    }
}
