using NetDeploy.Config;
using Renci.SshNet;
using Spectre.Console;
using System.Formats.Tar;
using System.IO.Compression;

namespace NetDeploy.Strategies;

public class RelayDeployment
{
    private readonly DeploymentProfile _config;
    private readonly string _localRoot;

    public RelayDeployment(DeploymentProfile config, string localRoot)
    {
        _config = config;
        _localRoot = localRoot;
    }

    public async Task UploadAsync(List<string> files, string remoteRoot)
    {
        // Validate Relay Config
        if (string.IsNullOrEmpty(_config.RelayHost)) 
            throw new Exception("RelayHost is required for 'relay' transfer mode.");

        var relayUser = _config.RelayUsername ?? _config.Username;
        // Use RelayPrivateKeyPath if provided, else fall back to the generic PrivateKeyPath
        var relayKeyPath = _config.RelayPrivateKeyPath ?? _config.PrivateKeyPath;
        var relayPort = _config.RelayPort ?? 22;

        AnsiConsole.MarkupLine($"[magenta]Preparing Relay Transfer via {_config.RelayHost}...[/]");

        // 1. Create Local Tarball
        var tempLocalTar = Path.GetTempFileName();
        
        await AnsiConsole.Status().StartAsync("Compressing files...", async ctx => 
        {
            using var fs = File.Create(tempLocalTar);
            using var gzip = new GZipStream(fs, CompressionLevel.Fastest);
            using var writer = new TarWriter(gzip);
            
            foreach (var file in files)
            {
                var relPath = Path.GetRelativePath(_localRoot, file).Replace('\\', '/');
                writer.WriteEntry(file, relPath);
            }
        });

        var timestamp = DateTime.UtcNow.Ticks;
        var tarName = $"deploy-{timestamp}.tar.gz";
        var keyName = $"deploy-key-{timestamp}.pem";
        var relayTmp = "/tmp"; // Assuming US server is Linux

        // 2. Connect to Relay Server
        var relayInfo = CreateConnectionInfo(_config.RelayHost!, relayPort, relayUser!, relayKeyPath!);
        using var relayClient = new SshClient(relayInfo);
        using var relaySftp = new SftpClient(relayInfo);

        try 
        {
            AnsiConsole.MarkupLine($"[grey]Connecting to Relay ({_config.RelayHost})...[/]");
            relayClient.Connect();
            relaySftp.Connect();

            // 3. Upload Artifacts to Relay
            await AnsiConsole.Progress().StartAsync(async ctx => 
            {
                // Upload Tar
                var task = ctx.AddTask($"[green]Uploading Bundle to Relay ({new FileInfo(tempLocalTar).Length / 1024} KB)[/]");
                using var fs = File.OpenRead(tempLocalTar);
                relaySftp.UploadFile(fs, $"{relayTmp}/{tarName}", (p) => task.Value = (double)p / fs.Length * 100);

                // Upload Target Key (So Relay can talk to Target)
                // Note: We upload the key defined for the Target, not the Relay (unless they are same)
                if (!string.IsNullOrEmpty(_config.PrivateKeyPath))
                {
                    var taskKey = ctx.AddTask($"[grey]Uploading ephemeral key...[/]");
                    using var ks = File.OpenRead(_config.PrivateKeyPath);
                    relaySftp.UploadFile(ks, $"{relayTmp}/{keyName}");
                    taskKey.Value = 100;
                    
                    // Secure the key immediately
                    relayClient.RunCommand($"chmod 600 {relayTmp}/{keyName}");
                }
            });

            // 4. Orchestrate Transfer (Relay -> Target)
            AnsiConsole.MarkupLine($"[yellow]Executing Jump on Relay...[/]");
            
            // Command 1: SCP Bundle from Relay to Target
            // We use -o StrictHostKeyChecking=no to avoid interactive prompts on the relay
            var targetHost = _config.Host; 
            var targetUser = _config.Username;
            
            // The relay needs to SCP the file to the target. 
            // We assume the Target trusts the key we just uploaded.
            var scpCmd = $"scp -o StrictHostKeyChecking=no -i {relayTmp}/{keyName} {relayTmp}/{tarName} {targetUser}@{targetHost}:/tmp/{tarName}";
            RunRelayCommand(relayClient, scpCmd, "Relaying Bundle to Target");

            // Command 2: SSH to Target to Extract
            // We SSH from Relay to Target, create dir, extract, and remove tar on target
            var extractCmd = $"ssh -o StrictHostKeyChecking=no -i {relayTmp}/{keyName} {targetUser}@{targetHost} " +
                             $"\"mkdir -p {remoteRoot} && tar -xzf /tmp/{tarName} -C {remoteRoot} && rm /tmp/{tarName}\"";
            RunRelayCommand(relayClient, extractCmd, "Extracting on Target");

            AnsiConsole.MarkupLine("[green]Relay Deployment Complete![/]");
        }
        finally
        {
            // Cleanup Relay
            if (relayClient.IsConnected)
            {
                AnsiConsole.MarkupLine("[grey]Cleaning up Relay...[/]");
                relayClient.RunCommand($"rm -f {relayTmp}/{tarName} {relayTmp}/{keyName}");
            }
            if (File.Exists(tempLocalTar)) File.Delete(tempLocalTar);
        }
    }

    private void RunRelayCommand(SshClient client, string command, string description)
    {
        AnsiConsole.MarkupLine($"[grey]> {description}[/]");
        var cmd = client.CreateCommand(command);
        var result = cmd.Execute();
        if (cmd.ExitStatus != 0)
        {
            throw new Exception($"Relay command failed: {cmd.Error}\nOutput: {result}");
        }
    }

    private ConnectionInfo CreateConnectionInfo(string host, int port, string user, string keyPath)
    {
        var auth = new List<AuthenticationMethod>();
        if (File.Exists(keyPath))
        {
            auth.Add(new PrivateKeyAuthenticationMethod(user, new PrivateKeyFile(keyPath, _config.Passphrase)));
        }
        else if (!string.IsNullOrEmpty(_config.Password))
        {
             auth.Add(new PasswordAuthenticationMethod(user, _config.Password));
        }

        return new ConnectionInfo(host, port, user, auth.ToArray());
    }
}
