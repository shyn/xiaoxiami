namespace TinyClaw.Service.Workers;

using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using Telegram.Bot;
using Telegram.Bot.Polling;
using Telegram.Bot.Types;
using Telegram.Bot.Types.Enums;
using TinyClaw.Core.Configuration;
using TinyClaw.Core.Data;
using TinyClaw.Core.Models;

public class TelegramChannelWorker : BackgroundService
{
    private readonly ILogger<TelegramChannelWorker> _logger;
    private readonly ConfigManager _config;
    private readonly MessageRepository _messages;

    private readonly ConcurrentDictionary<long, PendingTelegramMessage> _pending = new();

    public TelegramChannelWorker(
        ILogger<TelegramChannelWorker> logger,
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
        var token = settings.Channels?.Telegram?.BotToken;

        if (string.IsNullOrWhiteSpace(token))
        {
            _logger.LogWarning("Telegram bot token not configured, Telegram channel disabled");
            return;
        }

        var tgConfig = settings.Channels?.Telegram;
        
        // Configure HTTP client with proxy if specified
        HttpClient? httpClient = null;
        if (!string.IsNullOrWhiteSpace(tgConfig?.ProxyUrl))
        {
            var proxyUri = new Uri(tgConfig.ProxyUrl);
            var proxy = new WebProxy(proxyUri);
            var handler = new HttpClientHandler { Proxy = proxy, UseProxy = true };
            httpClient = new HttpClient(handler);
            _logger.LogInformation("Using HTTP proxy for Telegram: {Proxy}", proxyUri.Host);
        }

        var botClient = httpClient != null 
            ? new TelegramBotClient(token, httpClient) 
            : new TelegramBotClient(token);

        try
        {
            var me = await botClient.GetMe(ct);
            _logger.LogInformation("Telegram bot connected as @{Username}", me.Username);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to connect Telegram bot");
            return;
        }

        botClient.StartReceiving(
            updateHandler: (client, update, token) => HandleUpdateAsync(client, update, token),
            errorHandler: (client, exception, source, token) =>
            {
                _logger.LogError(exception, "Telegram polling error from {Source}", source);
                return Task.CompletedTask;
            },
            receiverOptions: new ReceiverOptions
            {
                AllowedUpdates = [UpdateType.Message]
            },
            cancellationToken: ct);

        var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (await timer.WaitForNextTickAsync(ct))
        {
            try
            {
                await DeliverResponsesAsync(botClient, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error delivering Telegram responses");
            }
        }
    }

    private async Task HandleUpdateAsync(ITelegramBotClient botClient, Update update, CancellationToken ct)
    {
        if (update.Message is not { } message) return;
        if (message.Chat.Type != ChatType.Private) return;

        var messageText = message.Text ?? message.Caption ?? "";
        var downloadedFiles = new List<string>();

        // Download media files
        if (message.Photo is { Length: > 0 })
        {
            var photo = message.Photo[^1];
            var path = await DownloadTelegramFileAsync(botClient, photo.FileId, ".jpg", ct);
            if (path != null) downloadedFiles.Add(path);
        }

        if (message.Document != null)
        {
            var ext = Path.GetExtension(message.Document.FileName ?? "") is { Length: > 0 } e ? e : ".bin";
            var path = await DownloadTelegramFileAsync(botClient, message.Document.FileId, ext, ct, message.Document.FileName);
            if (path != null) downloadedFiles.Add(path);
        }

        if (message.Audio != null)
        {
            var ext = ExtFromMime(message.Audio.MimeType) is { Length: > 0 } e ? e : ".mp3";
            var path = await DownloadTelegramFileAsync(botClient, message.Audio.FileId, ext, ct);
            if (path != null) downloadedFiles.Add(path);
        }

        if (message.Voice != null)
        {
            var path = await DownloadTelegramFileAsync(botClient, message.Voice.FileId, ".ogg", ct);
            if (path != null) downloadedFiles.Add(path);
        }

        if (message.Video != null)
        {
            var ext = ExtFromMime(message.Video.MimeType) is { Length: > 0 } e ? e : ".mp4";
            var path = await DownloadTelegramFileAsync(botClient, message.Video.FileId, ext, ct);
            if (path != null) downloadedFiles.Add(path);
        }

        if (message.VideoNote != null)
        {
            var path = await DownloadTelegramFileAsync(botClient, message.VideoNote.FileId, ".mp4", ct);
            if (path != null) downloadedFiles.Add(path);
        }

        if (message.Sticker != null)
        {
            var ext = message.Sticker.IsAnimated ? ".tgs" : message.Sticker.IsVideo ? ".webm" : ".webp";
            var path = await DownloadTelegramFileAsync(botClient, message.Sticker.FileId, ext, ct);
            if (path != null) downloadedFiles.Add(path);
            if (string.IsNullOrWhiteSpace(messageText))
                messageText = $"[Sticker: {message.Sticker.Emoji ?? "sticker"}]";
        }

        if (string.IsNullOrWhiteSpace(messageText) && downloadedFiles.Count == 0) return;

        var sender = message.From != null
            ? message.From.FirstName + (message.From.LastName != null ? $" {message.From.LastName}" : "")
            : "Unknown";
        var senderId = (message.From?.Id ?? message.Chat.Id).ToString();

        // Handle commands
        if (message.Text?.Trim() is "/agent" or "!agent")
        {
            var s = _config.LoadSettings();
            var agents = _config.GetAgents(s);
            await botClient.SendMessage(message.Chat.Id, FormatAgentList(agents),
                replyParameters: new ReplyParameters { MessageId = message.MessageId }, cancellationToken: ct);
            return;
        }

        if (message.Text?.Trim() is "/team" or "!team")
        {
            var s = _config.LoadSettings();
            var teams = _config.GetTeams(s);
            await botClient.SendMessage(message.Chat.Id, FormatTeamList(teams),
                replyParameters: new ReplyParameters { MessageId = message.MessageId }, cancellationToken: ct);
            return;
        }

        if (messageText.Trim() is "/reset" or "!reset")
        {
            await botClient.SendMessage(message.Chat.Id,
                "Conversation reset! Next message will start a fresh conversation.",
                replyParameters: new ReplyParameters { MessageId = message.MessageId }, cancellationToken: ct);
            return;
        }

        await botClient.SendChatAction(message.Chat.Id, ChatAction.Typing, cancellationToken: ct);

        // Build full message with file references
        var fullMessage = messageText;
        if (downloadedFiles.Count > 0)
        {
            var fileRefs = string.Join("\n", downloadedFiles.Select(f => $"[file: {f}]"));
            fullMessage = string.IsNullOrWhiteSpace(fullMessage) ? fileRefs : $"{fullMessage}\n\n{fileRefs}";
        }

        var queueMessageId = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Random.Shared.Next(100000, 999999)}";
        var filesJson = downloadedFiles.Count > 0 ? JsonSerializer.Serialize(downloadedFiles) : null;

        var dbId = _messages.Enqueue(new QueueMessage
        {
            Channel = "telegram",
            Sender = sender,
            SenderId = senderId,
            Content = fullMessage,
            FilesIn = filesJson,
            MessageId = queueMessageId
        });

        _pending[dbId] = new PendingTelegramMessage
        {
            ChatId = message.Chat.Id,
            ReplyToMessageId = message.MessageId,
            Timestamp = DateTimeOffset.UtcNow
        };

        _logger.LogInformation("Telegram: queued message {Id} from {Sender}", dbId, sender);

        // Clean up old pending
        var cutoff = DateTimeOffset.UtcNow.AddMinutes(-10);
        foreach (var key in _pending.Keys.ToList())
        {
            if (_pending.TryGetValue(key, out var p) && p.Timestamp < cutoff)
                _pending.TryRemove(key, out _);
        }
    }

    private async Task DeliverResponsesAsync(ITelegramBotClient botClient, CancellationToken ct)
    {
        var completed = _messages.GetCompleted("telegram");

        foreach (var msg in completed)
        {
            if (!_pending.TryRemove(msg.Id, out var pending))
            {
                _messages.Archive(msg.Id);
                continue;
            }

            try
            {
                if (!string.IsNullOrEmpty(msg.FilesOut))
                {
                    var files = JsonSerializer.Deserialize<string[]>(msg.FilesOut);
                    if (files != null)
                    {
                        foreach (var filePath in files)
                        {
                            if (!System.IO.File.Exists(filePath)) continue;
                            var ext = Path.GetExtension(filePath).ToLowerInvariant();

                            await using var stream = System.IO.File.OpenRead(filePath);
                            var inputFile = InputFile.FromStream(stream, Path.GetFileName(filePath));

                            if (ext is ".jpg" or ".jpeg" or ".png" or ".gif" or ".webp")
                                await botClient.SendPhoto(pending.ChatId, inputFile, cancellationToken: ct);
                            else if (ext is ".mp3" or ".ogg" or ".wav" or ".m4a")
                                await botClient.SendAudio(pending.ChatId, inputFile, cancellationToken: ct);
                            else if (ext is ".mp4" or ".avi" or ".mov" or ".webm")
                                await botClient.SendVideo(pending.ChatId, inputFile, cancellationToken: ct);
                            else
                                await botClient.SendDocument(pending.ChatId, inputFile, cancellationToken: ct);

                            _logger.LogInformation("Sent file to Telegram: {File}", Path.GetFileName(filePath));
                        }
                    }
                }

                var response = msg.Response ?? "";
                if (!string.IsNullOrEmpty(response))
                {
                    var chunks = SplitMessage(response, 4096);
                    if (chunks.Count > 0)
                    {
                        await botClient.SendMessage(pending.ChatId, chunks[0],
                            replyParameters: new ReplyParameters { MessageId = pending.ReplyToMessageId },
                            cancellationToken: ct);
                    }

                    for (var i = 1; i < chunks.Count; i++)
                        await botClient.SendMessage(pending.ChatId, chunks[i], cancellationToken: ct);
                }

                _logger.LogInformation("Telegram response delivered to chat {ChatId} ({Len} chars)", pending.ChatId, response.Length);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to deliver Telegram response for message {Id}", msg.Id);
            }

            _messages.Archive(msg.Id);
        }
    }

    private async Task<string?> DownloadTelegramFileAsync(ITelegramBotClient botClient, string fileId,
        string ext, CancellationToken ct, string? originalName = null)
    {
        try
        {
            var file = await botClient.GetFile(fileId, ct);
            if (file.FilePath == null) return null;

            var filesDir = _config.FilesDir;
            var fileName = originalName ?? $"telegram_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}{ext}";
            var localPath = BuildUniqueFilePath(filesDir, $"telegram_{SanitizeFileName(fileName)}");

            await using var destStream = System.IO.File.Create(localPath);
            await botClient.DownloadFile(file.FilePath, destStream, ct);

            _logger.LogInformation("Downloaded Telegram file: {File}", Path.GetFileName(localPath));
            return localPath;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to download Telegram file {FileId}", fileId);
            return null;
        }
    }

    private static string FormatAgentList(Dictionary<string, AgentConfig> agents)
    {
        if (agents.Count == 0)
            return "No agents configured.";

        var lines = new List<string> { "Available Agents:" };
        foreach (var (id, agent) in agents)
        {
            lines.Add($"\n@{id} - {agent.Name}");
            lines.Add($"  Provider: {agent.Provider}/{agent.Model}");
            lines.Add($"  Directory: {agent.WorkingDirectory}");
        }
        lines.Add("\nUsage: Start your message with @agent_id to route to a specific agent.");
        return string.Join("\n", lines);
    }

    private static string FormatTeamList(Dictionary<string, TeamConfig> teams)
    {
        if (teams.Count == 0)
            return "No teams configured.";

        var lines = new List<string> { "Available Teams:" };
        foreach (var (id, team) in teams)
        {
            lines.Add($"\n@{id} - {team.Name}");
            lines.Add($"  Agents: {string.Join(", ", team.Agents)}");
            lines.Add($"  Leader: @{team.LeaderAgent}");
        }
        lines.Add("\nUsage: Start your message with @team_id to route to a team.");
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

    private static string ExtFromMime(string? mime) => mime switch
    {
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "audio/ogg" => ".ogg",
        "audio/mpeg" => ".mp3",
        "video/mp4" => ".mp4",
        "application/pdf" => ".pdf",
        _ => ""
    };

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
        while (System.IO.File.Exists(candidate))
        {
            candidate = Path.Combine(dir, $"{stem}_{counter}{ext}");
            counter++;
        }
        return candidate;
    }

    private class PendingTelegramMessage
    {
        public long ChatId { get; init; }
        public int ReplyToMessageId { get; init; }
        public DateTimeOffset Timestamp { get; init; }
    }
}
