using NetDeploy.Config;
using Renci.SshNet;
using Spectre.Console;
using System.Formats.Tar;
using System.IO.Compression;

namespace NetDeploy.Strategies;

public class TarDeployment
{
    private readonly DeploymentProfile _config;
    private readonly string _localRoot;

    public TarDeployment(DeploymentProfile config, string localRoot)
    {
        _config = config;
        _localRoot = localRoot;
    }

    public async Task UploadAsync(SshClient ssh, SftpClient sftp, List<string> files, string remoteRoot)
    {
        // 1. Creation of Batches
        var batches = CreateBatches(files);
        var totalSize = batches.Sum(b => b.Size);
        var fmtTotalSize = (totalSize / 1024.0 / 1024.0).ToString("0.00");

        AnsiConsole.MarkupLine($"[cyan]Found {files.Count} files ({fmtTotalSize} MB).[/]");
        AnsiConsole.MarkupLine($"[cyan]Split into {batches.Count} batches (Limit: {_config.BatchSizeMB}MB).[/]");
        AnsiConsole.MarkupLine($"[cyan]Concurrency: {_config.Concurrency ?? 1}[/]");

        // 2. Ensure remote root exists (using the main connection)
        ssh.CreateCommand($"mkdir -p \"{remoteRoot}\"").Execute();

        // 3. Process Batches in Parallel
        var parallelOptions = new ParallelOptions { MaxDegreeOfParallelism = _config.Concurrency ?? 1 };
        
        // We use a separate progress context for the operations
        await AnsiConsole.Progress()
            .Columns(new ProgressColumn[]
            {
                new TaskDescriptionColumn(),
                new ProgressBarColumn(),
                new PercentageColumn(),
                new SpinnerColumn(),
            })
            .StartAsync(async ctx =>
            {
                var mainTask = ctx.AddTask("[green]Overall Progress[/]", new ProgressTaskSettings { MaxValue = batches.Count });

                await Parallel.ForEachAsync(batches.Select((b, i) => (Batch: b, Index: i)), parallelOptions, async (item, cancel) =>
                {
                    try 
                    {
                        await ProcessBatchAsync(item.Batch, item.Index, remoteRoot, ctx);
                    }
                    finally
                    {
                        mainTask.Increment(1);
                    }
                });
            });
    }

    private async Task ProcessBatchAsync(FileBatch batch, int index, string remoteRoot, ProgressContext ctx)
    {
        var tempTar = Path.GetTempFileName();
        var batchLabel = $"Batch {index + 1}";
        
        // Setup a progress task for this batch
        var task = ctx.AddTask($"[yellow]{batchLabel}: Starting...[/]", new ProgressTaskSettings { MaxValue = 100 });

        // Create dedicated connections for this thread/task to allow true parallelism
        // Note: We don't use the 'ssh'/'sftp' passed in UploadAsync because they are not thread-safe.
        using var client = new SshClient(CreateConnectionInfo());
        using var sftp = new SftpClient(CreateConnectionInfo());

        client.KeepAliveInterval = TimeSpan.FromSeconds(60);
        sftp.KeepAliveInterval = TimeSpan.FromSeconds(60);

        try
        {
            task.Description = $"[yellow]{batchLabel}: Connecting...[/]";
            await Task.Run(() => 
            {
                client.Connect();
                sftp.Connect();
            });

            // 1. Compress
            task.Description = $"[yellow]{batchLabel}: Compressing ({batch.Files.Count} files)...[/]";
            // We can't easily track compression byte-progress without double-reading, so using indeterminate or stepped
            await Task.Run(() => 
            {
                using var fs = File.Create(tempTar);
                using var gzip = new GZipStream(fs, CompressionLevel.Fastest);
                using var writer = new TarWriter(gzip);
                
                // Track progress by file count
                int processed = 0;
                foreach (var file in batch.Files)
                {
                    var relPath = Path.GetRelativePath(_localRoot, file).Replace('\\', '/');
                    writer.WriteEntry(file, relPath);
                    processed++;
                    // Update progress occasionally to avoid lock contention
                    if (processed % 10 == 0) 
                    {
                        task.Value = (double)processed / batch.Files.Count * 40; // 0-40% is compression
                    }
                }
            });

            var remoteTarPath = $"{remoteRoot}/deploy-batch-{index}-{DateTime.Now.Ticks}.tar.gz";
            var fileInfo = new FileInfo(tempTar);

            // 2. Upload
            task.Description = $"[blue]{batchLabel}: Uploading ({fileInfo.Length / 1024} KB)...[/]";
            task.Value = 40; // Start upload at 40%

            await Task.Run(() => 
            {
                using var uploadStream = File.OpenRead(tempTar);
                sftp.UploadFile(uploadStream, remoteTarPath, (uploaded) => 
                {
                    // Map upload progress to 40-90% range
                    var pct = (double)uploaded / fileInfo.Length;
                    task.Value = 40 + (pct * 50);
                });
            });

            // 3. Extract
            task.Description = $"[magenta]{batchLabel}: Extracting...[/]";
            task.Value = 90;

            var cmdText = $"tar -xzf \"{remoteTarPath}\" -C \"{remoteRoot}\" && rm \"{remoteTarPath}\"";
            var cmd = client.CreateCommand(cmdText);
            
            await Task.Run(() => 
            {
                var result = cmd.Execute();
                if (cmd.ExitStatus != 0)
                {
                    throw new Exception($"Extraction failed for {batchLabel}: {cmd.Error}");
                }
            });

            task.Value = 100;
            task.Description = $"[green]{batchLabel}: Done[/]";
        }
        catch (Exception ex)
        {
            task.Description = $"[red]{batchLabel}: Failed: {ex.Message}[/]";
            throw; // Rethrow to stop deployment or handle? specific batch failure fails whole deploy usually.
        }
        finally
        {
            if (File.Exists(tempTar)) File.Delete(tempTar);
            if (client.IsConnected) client.Disconnect();
            if (sftp.IsConnected) sftp.Disconnect();
        }
    }

    private List<FileBatch> CreateBatches(List<string> files)
    {
        AnsiConsole.MarkupLine("[grey]Analyzing file sizes...[/]");
        var batches = new List<FileBatch>();
        var currentBatch = new FileBatch();
        long currentSize = 0;
        long limitBytes = (_config.BatchSizeMB ?? 50) * 1024 * 1024;

        foreach (var file in files)
        {
            // Simple batching
            var info = new FileInfo(file);
            if (currentBatch.Files.Count > 0 && currentSize + info.Length > limitBytes)
            {
                currentBatch.Size = currentSize;
                batches.Add(currentBatch);
                currentBatch = new FileBatch();
                currentSize = 0;
            }

            currentBatch.Files.Add(file);
            currentSize += info.Length;
        }

        if (currentBatch.Files.Count > 0)
        {
            currentBatch.Size = currentSize;
            batches.Add(currentBatch);
        }

        return batches;
    }

    private ConnectionInfo CreateConnectionInfo()
    {
        var authMethods = new List<AuthenticationMethod>();
        if (!string.IsNullOrEmpty(_config.PrivateKeyPath))
        {
            // Key file loading might need to be thread-safe or loaded once? 
            // PrivateKeyFile ctor reads the file.
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

    private class FileBatch
    {
        public List<string> Files { get; set; } = new();
        public long Size { get; set; }
    }
}
