using NetDeploy.Config;
using Renci.SshNet;
using Spectre.Console;
namespace NetDeploy.Strategies;
public class SftpDeployment
{
    private readonly DeploymentProfile _config;
    private readonly string _localRoot;
    public SftpDeployment(DeploymentProfile config, string localRoot)
    {
        _config = config;
        _localRoot = localRoot;
    }
    public async Task UploadAsync(SshClient ssh, SftpClient sftp, List<string> files, string remoteRoot)
    {
        AnsiConsole.MarkupLine($"[cyan]Uploading {files.Count} files via SFTP...[/]");

        // Normalize remoteRoot
        remoteRoot = remoteRoot.Replace('\\', '/').TrimEnd('/');

        // Ensure remote directories exist
        var dirs = files
            .Select(f => Path.GetDirectoryName(Path.GetRelativePath(_localRoot, f))!.Replace('\\', '/'))
            .Where(d => !string.IsNullOrEmpty(d) && d != ".")
            .Distinct()
            .OrderBy(d => d.Length)
            .ToList();

        if (dirs.Count > 0)
        {
            AnsiConsole.MarkupLine($"[grey]Ensuring {dirs.Count} remote directories exist...[/]");
            foreach (var d in dirs)
            {
                var parts = d.TrimStart('/').Split('/');
                var currentPath = remoteRoot;
                foreach (var part in parts)
                {
                    currentPath = $"{currentPath}/{part}";
                    if (!sftp.Exists(currentPath))
                    {
                        AnsiConsole.MarkupLine($"[grey]Creating remote directory: {currentPath}[/]");
                        sftp.CreateDirectory(currentPath);
                    }
                }
            }
        }

        // Upload files
        await AnsiConsole.Progress()
            .StartAsync(async ctx => 
            {
                var task = ctx.AddTask($"[green]Uploading[/]", new ProgressTaskSettings { MaxValue = files.Count });
                foreach (var file in files)
                {
                    var relPath = Path.GetRelativePath(_localRoot, file).Replace('\\', '/');
                    var remotePath = $"{remoteRoot}/{relPath.TrimStart('/')}";
                    using var fs = File.OpenRead(file);
                    sftp.UploadFile(fs, remotePath);
                    task.Increment(1);
                }
            });
    }
}
