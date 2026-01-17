using NetDeploy.Config;
using Spectre.Console;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace NetDeploy;

class Program
{
    static async Task<int> Main(string[] args)
    {
        AnsiConsole.Write(new FigletText("NetDeploy").Color(Color.Green));

        try
        {
            var config = LoadConfig();
            var profileName = ParseProfile(args, config);

            if (string.IsNullOrEmpty(profileName))
            {
                AnsiConsole.MarkupLine("[red]No profile specified.[/]");
                AnsiConsole.MarkupLine("Usage: netdeploy --<profile> or --profile <profile>");
                AnsiConsole.MarkupLine("Available profiles: " + string.Join(", ", config.Deployments.Keys));
                return 1;
            }

            if (!config.Deployments.TryGetValue(profileName, out var profile))
            {
                AnsiConsole.MarkupLine($"[red]Profile '{profileName}' not found.[/]");
                return 1;
            }

            profile.MergeDefaults(config.Defaults);

            // Validation
            if (string.IsNullOrEmpty(profile.Host)) throw new Exception("Host is required");
            if (string.IsNullOrEmpty(profile.RemoteDir)) throw new Exception("RemoteDir is required");
            if (string.IsNullOrEmpty(profile.LocalDir)) throw new Exception("LocalDir is required");
            if (!Directory.Exists(profile.LocalDir)) throw new Exception($"Local directory '{profile.LocalDir}' does not exist");

            // Run Deployer
            var deployer = new Core.Deployer(profile);
            await deployer.RunAsync();

            return 0;
        }
        catch (Exception ex)
        {
            AnsiConsole.WriteException(ex);
            return 1;
        }
    }

    static DeployConfig LoadConfig()
    {
        var paths = new[] { "deploy.config.yaml", "deploy.config.yml", "deploy.config.json" };
        foreach (var path in paths)
        {
            if (File.Exists(path))
            {
                AnsiConsole.MarkupLine($"[grey]Loading config from {path}[/]");
                var yaml = File.ReadAllText(path);
                var deserializer = new DeserializerBuilder()
                    .WithNamingConvention(CamelCaseNamingConvention.Instance)
                    .Build();
                return deserializer.Deserialize<DeployConfig>(yaml);
            }
        }
        throw new FileNotFoundException("deploy.config.yaml not found");
    }

    static string? ParseProfile(string[] args, DeployConfig config)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--profile" && i + 1 < args.Length) return args[i + 1];
            if (args[i].StartsWith("--"))
            {
                var name = args[i].TrimStart('-');
                if (config.Deployments.ContainsKey(name)) return name;
            }
        }
        return null;
    }
}
