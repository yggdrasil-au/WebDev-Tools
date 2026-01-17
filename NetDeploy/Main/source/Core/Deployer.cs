
using NetDeploy.Config;
using Renci.SshNet;
using Spectre.Console;
using System.Text;

namespace NetDeploy.Core;

public class Deployer
{
    private readonly DeploymentProfile _config;

    public Deployer(DeploymentProfile config)
    {
        _config = config;
    }

    public async Task RunAsync()
    {
        var connInfo = CreateConnectionInfo();

        using var client = new SshClient(connInfo);
        using var sftp = new SftpClient(connInfo);

        client.KeepAliveInterval = TimeSpan.FromSeconds(60);
        sftp.KeepAliveInterval = TimeSpan.FromSeconds(60);

        try
        {
            await AnsiConsole.Status().StartAsync($"Connecting to {_config.Host}...", async ctx =>
            {
                client.Connect();
                sftp.Connect();
                ctx.Status("Connected.");
            });

            // Pre-commands
            if (_config.PreCommands.Count > 0)
            {
                AnsiConsole.MarkupLine("[yellow]Executing Pre-commands...[/]");
                foreach(var cmd in _config.PreCommands) RunCommand(client, cmd);
            }

            // Strategy Selection
            if (_config.Strategy == "symlink")
            {
                await RunSymlinkStrategy(client, sftp);
            }
            else
            {
                await UploadContent(client, sftp, _config.RemoteDir!);
            }

            // Post-commands
            if (_config.PostCommands.Count > 0)
            {
                AnsiConsole.MarkupLine("[yellow]Executing Post-commands...[/]");
                foreach(var cmd in _config.PostCommands) RunCommand(client, cmd);
            }

            AnsiConsole.MarkupLine("[green bold]Deployment Success![/]");
        }
        finally
        {
            if (client.IsConnected) client.Disconnect();
            if (sftp.IsConnected) sftp.Disconnect();
        }
    }

    private async Task RunSymlinkStrategy(SshClient ssh, SftpClient sftp)
    {
        var ts = DateTime.UtcNow.ToString("yyyyMMddHHmmss");
        // Simple remote path handling logic
        var remoteDir = _config.RemoteDir!.TrimEnd('/');
        var idx = remoteDir.LastIndexOf('/');
        var parent = idx > 0 ? remoteDir.Substring(0, idx) : remoteDir;

        var releasesRoot = _config.ReleasesDir ?? $"{parent}/releases";
        var targetDir = $"{releasesRoot}/{ts}";

        RunCommand(ssh, $"mkdir -p \"{targetDir}\"");

        // TODO: Preserve files copying could go here

        await UploadContent(ssh, sftp, targetDir);

        AnsiConsole.MarkupLine("[cyan]Updating symlink...[/]");
        RunCommand(ssh, $"ln -sfn \"{targetDir}\" \"{_config.RemoteDir}\"");

        // Cleanup old releases logic would be here
    }

    private async Task UploadContent(SshClient ssh, SftpClient sftp, string targetDir)
    {
        // 1. Calculate Diff
        var diffEngine = new DiffEngine(ssh, _config.LocalDir!);
        var filesToUpload = await diffEngine.GetChangedFilesAsync(targetDir);

        if (filesToUpload.Count == 0)
        {
            AnsiConsole.MarkupLine("[green]No changes detected.[/]");
            return;
        }

        // 2. Transfer
        if (_config.Transfer == "tar")
        {
            // Note: TarDeployment does not exist yet
             var strategy = new Strategies.TarDeployment(_config, _config.LocalDir!);
             await strategy.UploadAsync(ssh, sftp, filesToUpload, targetDir);
        }
        else
        {
             // Note: SftpDeployment does not exist yet
             var strategy = new Strategies.SftpDeployment(_config, _config.LocalDir!);
             await strategy.UploadAsync(ssh, sftp, filesToUpload, targetDir);
        }
    }

    private ConnectionInfo CreateConnectionInfo() {
        var authMethods = new List<AuthenticationMethod>();
        if (!string.IsNullOrEmpty(_config.PrivateKeyPath))
        {
            var keyFile = new PrivateKeyFile(_config.PrivateKeyPath, _config.Passphrase);
            authMethods.Add(new PrivateKeyAuthenticationMethod(_config.Username, keyFile));
        }
        if (!string.IsNullOrEmpty(_config.Password))
        {
            authMethods.Add(new PasswordAuthenticationMethod(_config.Username, _config.Password));
        }

        return new ConnectionInfo(_config.Host, _config.Port ?? 22, _config.Username, authMethods.ToArray())
        {
            Timeout = TimeSpan.FromHours(4)
        };
    }

    private void RunCommand(SshClient client, string command)
    {
        while (true)
        {
            AnsiConsole.MarkupLine($"[grey]> {command}[/]");
            var cmd = client.CreateCommand(command);
            var result = cmd.Execute();
            
            if (cmd.ExitStatus == 0) return;

            AnsiConsole.MarkupLine($"[red]Command failed (Exit {cmd.ExitStatus})[/]");
            if (!string.IsNullOrWhiteSpace(cmd.Error)) AnsiConsole.MarkupLine($"[red]Error: {cmd.Error}[/]");
            if (!string.IsNullOrWhiteSpace(result)) AnsiConsole.MarkupLine($"[grey]Output: {result}[/]");

            var choice = AnsiConsole.Prompt(
                new SelectionPrompt<string>()
                    .Title("How do you want to proceed?")
                    .AddChoices("Retry", "Skip", "Quit"));

            if (choice == "Skip") 
            {
                AnsiConsole.MarkupLine("[yellow]Skipping...[/]");
                return;
            }
            if (choice == "Quit") throw new Exception($"Command failed (Exit {cmd.ExitStatus}): {cmd.Error}");
            
            AnsiConsole.MarkupLine("[yellow]Retrying...[/]");
        }
    }
}
