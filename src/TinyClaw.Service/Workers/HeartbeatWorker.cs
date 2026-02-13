namespace TinyClaw.Service.Workers;

using TinyClaw.Core.Configuration;
using TinyClaw.Core.Data;
using TinyClaw.Core.Models;

public class HeartbeatWorker : BackgroundService
{
    private const string DefaultHeartbeatPrompt = "Quick status check: Any pending tasks? Keep response brief.";

    private readonly ILogger<HeartbeatWorker> _logger;
    private readonly ConfigManager _config;
    private readonly MessageRepository _messages;

    public HeartbeatWorker(
        ILogger<HeartbeatWorker> logger,
        ConfigManager config,
        MessageRepository messages)
    {
        _logger = logger;
        _config = config;
        _messages = messages;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _logger.LogInformation("Heartbeat worker started");

        await Task.Delay(TimeSpan.FromSeconds(30), ct);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var settings = _config.LoadSettings();
                var intervalSeconds = settings.Monitoring?.HeartbeatInterval ?? 3600;

                if (intervalSeconds <= 0)
                {
                    _logger.LogInformation("Heartbeat disabled (interval <= 0)");
                    await Task.Delay(TimeSpan.FromMinutes(5), ct);
                    continue;
                }

                var agents = _config.GetAgents(settings);
                var workspacePath = settings.Workspace?.Path ??
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "tinyclaw-workspace");

                foreach (var (agentId, agent) in agents)
                {
                    var prompt = LoadHeartbeatPrompt(agentId, workspacePath);

                    _messages.Enqueue(new QueueMessage
                    {
                        Channel = "heartbeat",
                        Sender = "System",
                        Content = $"@{agentId} {prompt}",
                        AgentId = agentId,
                        MessageId = $"hb_{agentId}_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}"
                    });

                    _logger.LogInformation("Heartbeat sent to @{AgentId}", agentId);
                }

                await Task.Delay(TimeSpan.FromSeconds(intervalSeconds), ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Heartbeat error");
                await Task.Delay(TimeSpan.FromMinutes(1), ct);
            }
        }
    }

    private static string LoadHeartbeatPrompt(string agentId, string workspacePath)
    {
        var heartbeatPath = Path.Combine(workspacePath, agentId, "heartbeat.md");
        if (File.Exists(heartbeatPath))
        {
            var content = File.ReadAllText(heartbeatPath).Trim();
            if (!string.IsNullOrEmpty(content))
                return content;
        }

        return DefaultHeartbeatPrompt;
    }
}
