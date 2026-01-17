using NetDeploy.Config;
using Spectre.Console;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;
using System.Text.RegularExpressions;

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

                // 1. First Pass: Extract Variables
                var firstPassDeserializer = new DeserializerBuilder()
                    .WithNamingConvention(CamelCaseNamingConvention.Instance)
                    .IgnoreUnmatchedProperties()
                    .Build();
                
                var varConfig = firstPassDeserializer.Deserialize<DeployConfig>(yaml);

                var vars = varConfig?.Vars ?? new Dictionary<string, string>();
                
                // 1.5. Validate and replace variables
                yaml = ApplyVarsWithValidation(yaml, vars, path);

                // 2. Second Pass: Full Deserialization
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

    private static string ApplyVarsWithValidation(string yaml, Dictionary<string, string> vars, string configPath)
    {
        var placeholderRegex = new Regex("{{([a-zA-Z0-9_]+)}}", RegexOptions.Compiled);
        var matches = placeholderRegex.Matches(yaml);

        if (matches.Count == 0)
        {
            return yaml;
        }

        var unknownNames = new HashSet<string>();
        var distinctPlaceholders = new HashSet<string>();

        foreach (Match match in matches)
        {
            if (match.Groups.Count > 1)
            {
                var name = match.Groups[1].Value;
                distinctPlaceholders.Add(name);

                if (!vars.ContainsKey(name))
                {
                    unknownNames.Add(name);
                }
            }
        }

        if (unknownNames.Count > 0)
        {
            var msg = $"Unknown template variables in deploy config '{configPath}':\n";
            foreach (var name in unknownNames)
            {
                // Find first occurrence for context
                var match = matches.FirstOrDefault(m => m.Groups[1].Value == name);
                var context = match != null ? $" (near: ...{match.Value}...)" : "";
                msg += $"- {name}{context}\n";
            }
            throw new Exception(msg);
        }

        if (vars.Count > 0)
        {
            AnsiConsole.MarkupLine($"[grey]Substituting {distinctPlaceholders.Count} variables...[/]");
            foreach (var kvp in vars)
            {
                var placeholder = "{{" + kvp.Key + "}}";
                if (yaml.Contains(placeholder))
                {
                    yaml = yaml.Replace(placeholder, kvp.Value);
                }
            }
        }
        
        return yaml;
    }
}
