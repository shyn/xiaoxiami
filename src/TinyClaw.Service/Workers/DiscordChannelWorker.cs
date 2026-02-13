namespace TinyClaw.Service.Workers;

using System.Collections.Concurrent;
using System.Text.Json;
using Discord;
using Discord.WebSocket;
using TinyClaw.Core.Configuration;
using TinyClaw.Core.Data;
using TinyClaw.Core.Models;

public class DiscordChannelWorker : BackgroundService
{
    private readonly ILogger<DiscordChannelWorker> _logger;
    private readonly ConfigManager _config;
    private readonly MessageRepository _messages;
    private DiscordSocketClient? _client;

    private readonly ConcurrentDictionary<long, PendingDiscordMessage> _pending = new();

    public DiscordChannelWorker(
        ILogger<DiscordChannelWorker> logger,
        ConfigManager config,
        MessageRepository messages)
    {
        _logger = logger;
        _config = config;
        _messages = messages;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var settings = _config.LoadSettings();
        var token = settings.Channels?.Discord?.BotToken;

        if (string.IsNullOrWhiteSpace(token))
        {
            _logger.LogWarning("Discord bot token not configured, Discord channel disabled");
            return;
        }

        _client = new DiscordSocketClient(new DiscordSocketConfig
        {
            GatewayIntents = GatewayIntents.DirectMessages | GatewayIntents.Guilds | GatewayIntents.MessageContent,
        });

        _client.Log += msg =>
        {
            _logger.LogDebug("[Discord.Net] {Message}", msg.ToString());
            return Task.CompletedTask;
        };

        _client.Ready += () =>
        {
            _logger.LogInformation("Discord bot connected as {User}", _client.CurrentUser?.Username);
            return Task.CompletedTask;
        };

        _client.MessageReceived += HandleMessageAsync;

        try
        {
            await _client.LoginAsync(TokenType.Bot, token);
            await _client.StartAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to start Discord client");
            return;
        }

        var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (await timer.WaitForNextTickAsync(ct))
        {
            try
            {
                await DeliverResponsesAsync();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error delivering Discord responses");
            }
        }

        await _client.StopAsync();
    }

    private async Task HandleMessageAsync(SocketMessage socketMessage)
    {
        if (socketMessage is not SocketUserMessage message) return;
        if (message.Author.IsBot) return;
        if (message.Channel is not IDMChannel dmChannel) return;

        var content = message.Content ?? "";
        var hasAttachments = message.Attachments.Count > 0;

        if (string.IsNullOrWhiteSpace(content) && !hasAttachments) return;

        var sender = message.Author.Username;

        // Handle commands
        if (content.Trim() is "/agent" or "!agent")
        {
            var settings = _config.LoadSettings();
            var agents = _config.GetAgents(settings);
            await message.ReplyAsync(FormatAgentList(agents));
            return;
        }

        if (content.Trim() is "/team" or "!team")
        {
            var settings = _config.LoadSettings();
            var teams = _config.GetTeams(settings);
            await message.ReplyAsync(FormatTeamList(teams));
            return;
        }

        if (content.Trim() is "/reset" or "!reset")
        {
            await message.ReplyAsync("Conversation reset! Next message will start a fresh conversation.");
            return;
        }

        // Download attachments
        var downloadedFiles = new List<string>();
        if (hasAttachments)
        {
            foreach (var attachment in message.Attachments)
            {
                try
                {
                    var localPath = await DownloadAttachmentAsync(attachment);
                    if (localPath != null)
                        downloadedFiles.Add(localPath);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to download Discord attachment {Name}", attachment.Filename);
                }
            }
        }

        // Build full message with file references
        var fullMessage = content;
        if (downloadedFiles.Count > 0)
        {
            var fileRefs = string.Join("\n", downloadedFiles.Select(f => $"[file: {f}]"));
            fullMessage = string.IsNullOrWhiteSpace(fullMessage) ? fileRefs : $"{fullMessage}\n\n{fileRefs}";
        }

        var messageId = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Random.Shared.Next(100000, 999999)}";
        var filesJson = downloadedFiles.Count > 0 ? JsonSerializer.Serialize(downloadedFiles) : null;

        var dbId = _messages.Enqueue(new QueueMessage
        {
            Channel = "discord",
            Sender = sender,
            SenderId = message.Author.Id.ToString(),
            Content = fullMessage,
            FilesIn = filesJson,
            MessageId = messageId
        });

        _pending[dbId] = new PendingDiscordMessage
        {
            Channel = dmChannel,
            OriginalMessage = message,
            Timestamp = DateTimeOffset.UtcNow
        };

        _logger.LogInformation("Discord: queued message {Id} from {Sender}", dbId, sender);

        await dmChannel.TriggerTypingAsync();

        // Clean up old pending messages
        var cutoff = DateTimeOffset.UtcNow.AddMinutes(-10);
        foreach (var key in _pending.Keys.ToList())
        {
            if (_pending.TryGetValue(key, out var p) && p.Timestamp < cutoff)
                _pending.TryRemove(key, out _);
        }
    }

    private async Task DeliverResponsesAsync()
    {
        var completed = _messages.GetCompleted("discord");

        foreach (var msg in completed)
        {
            if (!_pending.TryRemove(msg.Id, out var pending))
            {
                _messages.Archive(msg.Id);
                continue;
            }

            try
            {
                // Send file attachments
                if (!string.IsNullOrEmpty(msg.FilesOut))
                {
                    var files = JsonSerializer.Deserialize<string[]>(msg.FilesOut);
                    if (files != null)
                    {
                        foreach (var filePath in files)
                        {
                            if (!File.Exists(filePath)) continue;
                            await pending.Channel.SendFileAsync(filePath);
                            _logger.LogInformation("Sent file to Discord: {File}", Path.GetFileName(filePath));
                        }
                    }
                }

                // Send response text, split at 2000 chars
                var response = msg.Response ?? "";
                if (!string.IsNullOrEmpty(response))
                {
                    var chunks = SplitMessage(response, 2000);
                    if (chunks.Count > 0)
                        await pending.OriginalMessage.ReplyAsync(chunks[0]);

                    for (var i = 1; i < chunks.Count; i++)
                        await pending.Channel.SendMessageAsync(chunks[i]);
                }

                _logger.LogInformation("Discord response delivered to {Sender} ({Len} chars)", msg.Sender, response.Length);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to deliver Discord response for message {Id}", msg.Id);
            }

            _messages.Archive(msg.Id);
        }
    }

    private async Task<string?> DownloadAttachmentAsync(Attachment attachment)
    {
        var filesDir = _config.FilesDir;
        var safeName = SanitizeFileName(attachment.Filename ?? $"file_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.bin");
        var localPath = BuildUniqueFilePath(filesDir, $"discord_{safeName}");

        using var httpClient = new HttpClient();
        var bytes = await httpClient.GetByteArrayAsync(attachment.Url);
        await File.WriteAllBytesAsync(localPath, bytes);

        _logger.LogInformation("Downloaded Discord attachment: {File}", Path.GetFileName(localPath));
        return localPath;
    }

    private static string FormatAgentList(Dictionary<string, AgentConfig> agents)
    {
        if (agents.Count == 0)
            return "No agents configured.";

        var lines = new List<string> { "**Available Agents:**" };
        foreach (var (id, agent) in agents)
        {
            lines.Add($"\n**@{id}** - {agent.Name}");
            lines.Add($"  Provider: {agent.Provider}/{agent.Model}");
            lines.Add($"  Directory: {agent.WorkingDirectory}");
        }
        lines.Add("\nUsage: Start your message with `@agent_id` to route to a specific agent.");
        return string.Join("\n", lines);
    }

    private static string FormatTeamList(Dictionary<string, TeamConfig> teams)
    {
        if (teams.Count == 0)
            return "No teams configured.";

        var lines = new List<string> { "**Available Teams:**" };
        foreach (var (id, team) in teams)
        {
            lines.Add($"\n**@{id}** - {team.Name}");
            lines.Add($"  Agents: {string.Join(", ", team.Agents)}");
            lines.Add($"  Leader: @{team.LeaderAgent}");
        }
        lines.Add("\nUsage: Start your message with `@team_id` to route to a team.");
        return string.Join("\n", lines);
    }

    private static List<string> SplitMessage(string text, int maxLength)
    {
        if (text.Length <= maxLength)
            return [text];

        var chunks = new List<string>();
        var remaining = text;

        while (remaining.Length > 0)
        {
            if (remaining.Length <= maxLength)
            {
                chunks.Add(remaining);
                break;
            }

            var splitIndex = remaining.LastIndexOf('\n', maxLength);
            if (splitIndex <= 0)
                splitIndex = remaining.LastIndexOf(' ', maxLength);
            if (splitIndex <= 0)
                splitIndex = maxLength;

            chunks.Add(remaining[..splitIndex]);
            remaining = remaining[splitIndex..].TrimStart('\n');
        }

        return chunks;
    }

    private static string SanitizeFileName(string fileName)
    {
        var baseName = Path.GetFileName(fileName);
        foreach (var c in Path.GetInvalidFileNameChars())
            baseName = baseName.Replace(c, '_');
        return string.IsNullOrWhiteSpace(baseName) ? "file.bin" : baseName;
    }

    private static string BuildUniqueFilePath(string dir, string preferredName)
    {
        var ext = Path.GetExtension(preferredName);
        var stem = Path.GetFileNameWithoutExtension(preferredName);
        var candidate = Path.Combine(dir, preferredName);
        var counter = 1;
        while (File.Exists(candidate))
        {
            candidate = Path.Combine(dir, $"{stem}_{counter}{ext}");
            counter++;
        }
        return candidate;
    }

    private class PendingDiscordMessage
    {
        public required IDMChannel Channel { get; init; }
        public required SocketUserMessage OriginalMessage { get; init; }
        public DateTimeOffset Timestamp { get; init; }
    }
}
