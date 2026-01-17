
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
        await UploadContent(ssh, sftp, targetDir);

        // Preserve files (e.g., SQLite DBs) from the currently live release into the new release.
        // This is required for the symlink strategy: each release is a fresh folder.
        if (_config.PreserveFiles.Count > 0)
        {
            PreserveFilesFromPreviousRelease(ssh, remoteDir, targetDir);
        }

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
        if (_config.Transfer == "relay")
        {
             var strategy = new Strategies.RelayDeployment(_config, _config.LocalDir!);
             await strategy.UploadAsync(filesToUpload, targetDir);
        }
        else if (_config.Transfer == "tar")
        {
             var strategy = new Strategies.TarDeployment(_config, _config.LocalDir!);
             await strategy.UploadAsync(ssh, sftp, filesToUpload, targetDir);
        }
        else
        {
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
            AnsiConsole.MarkupLine($"[grey]> {Markup.Escape(command)}[/]");
            var cmd = client.CreateCommand(command);
            var result = cmd.Execute();
            
            if (cmd.ExitStatus == 0) return;

            AnsiConsole.MarkupLine($"[red]Command failed (Exit {cmd.ExitStatus})[/]");
            if (!string.IsNullOrWhiteSpace(cmd.Error)) AnsiConsole.MarkupLine($"[red]Error: {Markup.Escape(cmd.Error)}[/]");
            if (!string.IsNullOrWhiteSpace(result)) AnsiConsole.MarkupLine($"[grey]Output: {Markup.Escape(result)}[/]");

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

    private void PreserveFilesFromPreviousRelease(
        SshClient ssh,
        string remoteDir,
        string targetDir
    )
    {
        var preserveFiles = NormalizeAndValidatePreserveFiles(_config.PreserveFiles);
        if (preserveFiles.Count == 0)
        {
            return;
        }

        var remoteDirQuoted = EscapeForBashDoubleQuotes(remoteDir);
        var targetDirQuoted = EscapeForBashDoubleQuotes(targetDir);
        var preserveDir = _config.PreserveDir?.TrimEnd('/');
        var preserveDirQuoted = preserveDir != null ? EscapeForBashDoubleQuotes(preserveDir) : string.Empty;

        var filesList = string.Join(
            " ",
            preserveFiles.Select(f => $"\"{EscapeForBashDoubleQuotes(f)}\"")
        );

        // Note: remote commands run via /bin/sh on the target host. Keep this POSIX-compatible.
        // Behavior: if the destination exists, do not overwrite it.
        // Source preference: preserveDir (if set) then the currently-live release (remoteDir target).
        var cmd = new StringBuilder();
        cmd.Append("remoteDir=\"").Append(remoteDirQuoted).Append("\"; ");
        cmd.Append("targetDir=\"").Append(targetDirQuoted).Append("\"; ");
        cmd.Append("preserveDir=\"").Append(preserveDirQuoted).Append("\"; ");
        cmd.Append("active=\"\"; ");
        cmd.Append("active=$(readlink -f -- \"$remoteDir\" 2>/dev/null || true); ");
        cmd.Append("if [ -z \"$active\" ]; then active=\"$remoteDir\"; fi; ");
        cmd.Append("echo \"[preserve] active=$active\"; ");
        cmd.Append("for f in ").Append(filesList).Append("; do ");
        cmd.Append("src=\"\"; dst=\"$targetDir/$f\"; ");
        cmd.Append("if [ -n \"$preserveDir\" ] && [ -e \"$preserveDir/$f\" ]; then src=\"$preserveDir/$f\"; ");
        cmd.Append("elif [ -e \"$active/$f\" ]; then src=\"$active/$f\"; fi; ");
        cmd.Append("if [ -z \"$src\" ]; then echo \"[preserve] missing: $f\"; continue; fi; ");
        cmd.Append("if [ -e \"$dst\" ]; then echo \"[preserve] exists: $f\"; continue; fi; ");
        cmd.Append("mkdir -p -- \"$(dirname -- \"$dst\")\"; ");
        cmd.Append("cp -a -- \"$src\" \"$dst\"; ");
        cmd.Append("echo \"[preserve] copied: $f\"; ");
        cmd.Append("done");

        AnsiConsole.MarkupLine($"[cyan]Preserving {preserveFiles.Count} file(s)...[/]");
        RunCommand(ssh, cmd.ToString());
    }

    private List<string> NormalizeAndValidatePreserveFiles(List<string> preserveFiles)
    {
        var normalized = new List<string>();

        foreach (var entry in preserveFiles)
        {
            if (string.IsNullOrWhiteSpace(entry))
            {
                continue;
            }

            var p = entry.Trim().Replace('\\', '/');

            // Safety: prevent absolute paths and parent traversal from escaping the release root.
            if (p.StartsWith('/'))
            {
                throw new Exception($"preserveFiles entry must be relative, got '{entry}'");
            }

            if (p.Contains(".."))
            {
                throw new Exception($"preserveFiles entry must not contain '..', got '{entry}'");
            }

            if (p.Contains('\n') || p.Contains('\r') || p.Contains('\0'))
            {
                throw new Exception($"preserveFiles entry contains invalid characters, got '{entry}'");
            }

            normalized.Add(p);
        }

        return normalized;
    }

    private string EscapeForBashDoubleQuotes(string value)
    {
        // This is only used for values we embed inside double quotes in the remote shell.
        return value
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("$", "\\$")
            .Replace("`", "\\`");
    }
}
