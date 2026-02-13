namespace TinyClaw.Core.Configuration;

using System.Text.Json;
using System.Text.Json.Serialization;
using TinyClaw.Core.Models;

public class ConfigManager
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public string ConfigDir { get; }
    public string SettingsPath => Path.Combine(ConfigDir, "settings.json");
    public string DbPath => Path.Combine(ConfigDir, "tinyclaw.db");
    public string FilesDir => Path.Combine(ConfigDir, "files");
    public string LogsDir => Path.Combine(ConfigDir, "logs");

    public ConfigManager(string? configDir = null)
    {
        ConfigDir = configDir ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "TinyClaw");
        Directory.CreateDirectory(ConfigDir);
        Directory.CreateDirectory(FilesDir);
        Directory.CreateDirectory(LogsDir);
    }

    public Settings LoadSettings()
    {
        if (!File.Exists(SettingsPath)) return new Settings();
        var json = File.ReadAllText(SettingsPath);
        return JsonSerializer.Deserialize<Settings>(json, JsonOptions) ?? new Settings();
    }

    public void SaveSettings(Settings settings)
    {
        var json = JsonSerializer.Serialize(settings, JsonOptions);
        File.WriteAllText(SettingsPath, json);
    }

    public Dictionary<string, AgentConfig> GetAgents(Settings settings)
    {
        if (settings.Agents is { Count: > 0 }) return settings.Agents;

        var provider = settings.Models?.Provider ?? "anthropic";
        var model = provider == "openai"
            ? settings.Models?.OpenAi?.Model ?? "gpt-5.3-codex"
            : settings.Models?.Anthropic?.Model ?? "sonnet";
        var workspacePath = settings.Workspace?.Path ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "tinyclaw-workspace");
        return new Dictionary<string, AgentConfig>
        {
            ["default"] = new()
            {
                Name = "Default",
                Provider = provider,
                Model = model,
                WorkingDirectory = Path.Combine(workspacePath, "default"),
            }
        };
    }

    public Dictionary<string, TeamConfig> GetTeams(Settings settings)
        => settings.Teams ?? new();
}
