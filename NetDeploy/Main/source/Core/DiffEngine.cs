using Renci.SshNet;
using Spectre.Console;

namespace NetDeploy.Core;

public class DiffEngine
{
    private readonly SshClient _ssh;
    private readonly string _localRoot;

    public DiffEngine(SshClient ssh, string localRoot)
    {
        _ssh = ssh;
        _localRoot = localRoot;
    }

    public async Task<List<string>> GetChangedFilesAsync(string remoteRoot)
    {
        var remoteFiles = new Dictionary<string, long>();

        await AnsiConsole.Status().StartAsync("Calculating diffs...", async ctx =>
        {
            // 1. Get Remote State
            // Only try if directory exists. If new directory (symlink strategy), remote is empty.
            var cmdText = $"[ -d \"{remoteRoot}\" ] && find \"{remoteRoot}\" -type f -printf '%P|%s\\n'";
            var checkCmd = _ssh.CreateCommand(cmdText);
            var output = checkCmd.Execute();

            if (checkCmd.ExitStatus == 0 && !string.IsNullOrWhiteSpace(output))
            {
                foreach(var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
                {
                    var parts = line.Split('|');
                    if (parts.Length >= 2 && long.TryParse(parts[1], out var size))
                    {
                        // Normalize path separators to forward slash
                        remoteFiles[parts[0].Replace('\\', '/')] = size;
                    }
                }
            }
        });

        // 2. Scan Local
        // GetRelativePath returns paths with OS separator
        var allLocalFiles = Directory.GetFiles(_localRoot, "*", SearchOption.AllDirectories);
        var toUpload = new List<string>();

        foreach (var file in allLocalFiles)
        {
            var relPath = Path.GetRelativePath(_localRoot, file).Replace('\\', '/');
            var info = new FileInfo(file);

            if (!remoteFiles.TryGetValue(relPath, out var remoteSize) || remoteSize != info.Length)
            {
                toUpload.Add(file);
            }
        }

        AnsiConsole.MarkupLine($"[grey]Remote: {remoteFiles.Count}, Local: {allLocalFiles.Length}, Changed: {toUpload.Count}[/]");
        return toUpload;
    }
}
