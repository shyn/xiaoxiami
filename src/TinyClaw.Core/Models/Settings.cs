namespace TinyClaw.Core.Models;

using System.Text.Json.Serialization;

public record Settings
{
    public WorkspaceConfig? Workspace { get; init; }
    public ChannelsConfig? Channels { get; init; }
    public ModelsConfig? Models { get; init; }
    public Dictionary<string, AgentConfig>? Agents { get; init; }
    public Dictionary<string, TeamConfig>? Teams { get; init; }
    public MonitoringConfig? Monitoring { get; init; }
}

public record WorkspaceConfig
{
    public string? Path { get; init; }
    public string? Name { get; init; }
}

public record ChannelsConfig
{
    public List<string>? Enabled { get; init; }
    public DiscordConfig? Discord { get; init; }
    public TelegramConfig? Telegram { get; init; }
}

public record DiscordConfig
{
    [JsonPropertyName("bot_token")]
    public string? BotToken { get; init; }
}

public record TelegramConfig
{
    [JsonPropertyName("bot_token")]
    public string? BotToken { get; init; }

    [JsonPropertyName("proxy_url")]
    public string? ProxyUrl { get; init; }
}

public record ModelsConfig
{
    public string? Provider { get; init; }
    public AnthropicConfig? Anthropic { get; init; }
    [JsonPropertyName("openai")]
    public OpenAiConfig? OpenAi { get; init; }
}

public record AnthropicConfig
{
    public string? Model { get; init; }
}

public record OpenAiConfig
{
    public string? Model { get; init; }
}

public record AgentConfig
{
    public required string Name { get; init; }
    public required string Provider { get; init; }
    public required string Model { get; init; }

    [JsonPropertyName("working_directory")]
    public required string WorkingDirectory { get; init; }
}

public record TeamConfig
{
    public required string Name { get; init; }
    public required List<string> Agents { get; init; }

    [JsonPropertyName("leader_agent")]
    public required string LeaderAgent { get; init; }
}

public record MonitoringConfig
{
    [JsonPropertyName("heartbeat_interval")]
    public int HeartbeatInterval { get; init; } = 3600;
}
