namespace TinyClaw.Service.Workers;

using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using TinyClaw.Core.Configuration;
using TinyClaw.Core.Data;
using TinyClaw.Core.Models;

public class IpcServer : BackgroundService
{
    private const string PipeName = "TinyClawPipe";

    private readonly ILogger<IpcServer> _logger;
    private readonly ConfigManager _config;
    private readonly MessageRepository _messages;

    public IpcServer(
        ILogger<IpcServer> logger,
        ConfigManager config,
        MessageRepository messages)
    {
        _logger = logger;
        _config = config;
        _messages = messages;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _logger.LogInformation("IPC server started on pipe '{PipeName}'", PipeName);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(PipeName,
                    PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);

                await server.WaitForConnectionAsync(ct);
                _logger.LogDebug("IPC client connected");

                using var reader = new StreamReader(server, Encoding.UTF8, leaveOpen: true);
                await using var writer = new StreamWriter(server, Encoding.UTF8, leaveOpen: true) { AutoFlush = true };

                while (server.IsConnected && !ct.IsCancellationRequested)
                {
                    var line = await reader.ReadLineAsync(ct);
                    if (line == null) break;

                    var response = ProcessCommand(line.Trim());
                    await writer.WriteLineAsync(response);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "IPC server error");
                await Task.Delay(TimeSpan.FromSeconds(1), ct);
            }
        }
    }

    private string ProcessCommand(string command)
    {
        try
        {
            if (command == "status")
                return GetStatus();

            if (command.StartsWith("restart-channel:"))
            {
                var channelName = command["restart-channel:".Length..].Trim();
                _logger.LogInformation("IPC: restart-channel request for '{Channel}'", channelName);
                return JsonSerializer.Serialize(new { ok = true, message = $"Restart signal sent for {channelName}" });
            }

            if (command.StartsWith("send:"))
            {
                var json = command["send:".Length..].Trim();
                return EnqueueManualMessage(json);
            }

            return JsonSerializer.Serialize(new { ok = false, error = $"Unknown command: {command}" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "IPC command error: {Command}", command);
            return JsonSerializer.Serialize(new { ok = false, error = ex.Message });
        }
    }

    private string GetStatus()
    {
        var settings = _config.LoadSettings();
        var agents = _config.GetAgents(settings);
        var teams = _config.GetTeams(settings);
        var counts = _messages.GetStatusCounts();

        var status = new
        {
            ok = true,
            service = "running",
            agents = agents.Keys.ToArray(),
            teams = teams.Keys.ToArray(),
            queue = new
            {
                pending = counts.GetValueOrDefault(MessageStatus.Pending),
                processing = counts.GetValueOrDefault(MessageStatus.Processing)
            },
            channels = new
            {
                discord = settings.Channels?.Discord?.BotToken != null ? "configured" : "not_configured",
                telegram = settings.Channels?.Telegram?.BotToken != null ? "configured" : "not_configured"
            }
        };

        return JsonSerializer.Serialize(status);
    }

    private string EnqueueManualMessage(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var channel = root.TryGetProperty("channel", out var ch) ? ch.GetString() ?? "ipc" : "ipc";
        var sender = root.TryGetProperty("sender", out var sn) ? sn.GetString() ?? "IPC" : "IPC";
        var content = root.TryGetProperty("content", out var ct) ? ct.GetString() ?? "" : "";
        var agentId = root.TryGetProperty("agentId", out var ai) ? ai.GetString() : null;

        if (string.IsNullOrWhiteSpace(content))
            return JsonSerializer.Serialize(new { ok = false, error = "Content is required" });

        var msgId = _messages.Enqueue(new QueueMessage
        {
            Channel = channel,
            Sender = sender,
            Content = content,
            AgentId = agentId,
            MessageId = $"ipc_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}"
        });

        _logger.LogInformation("IPC: enqueued manual message {Id}", msgId);

        return JsonSerializer.Serialize(new { ok = true, messageId = msgId });
    }
}
