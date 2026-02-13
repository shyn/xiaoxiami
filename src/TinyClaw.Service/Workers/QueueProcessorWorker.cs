namespace TinyClaw.Service.Workers;

using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using TinyClaw.Core.Configuration;
using TinyClaw.Core.Data;
using TinyClaw.Core.Models;
using TinyClaw.Core.Services;

public class QueueProcessorWorker : BackgroundService
{
    private readonly ILogger<QueueProcessorWorker> _logger;
    private readonly MessageRepository _messages;
    private readonly LogRepository _logs;
    private readonly ConfigManager _config;
    private readonly MessageRouter _router;
    private readonly AgentInvoker _invoker;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _agentLocks = new();

    public QueueProcessorWorker(
        ILogger<QueueProcessorWorker> logger,
        MessageRepository messages,
        LogRepository logs,
        ConfigManager config,
        MessageRouter router,
        AgentInvoker invoker)
    {
        _logger = logger;
        _messages = messages;
        _logs = logs;
        _config = config;
        _router = router;
        _invoker = invoker;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _logger.LogInformation("Queue processor started");
        var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));

        while (await timer.WaitForNextTickAsync(ct))
        {
            try
            {
                await ProcessQueueAsync(ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Queue processing error");
            }
        }
    }

    private async Task ProcessQueueAsync(CancellationToken ct)
    {
        var settings = _config.LoadSettings();
        var agents = _config.GetAgents(settings);
        var teams = _config.GetTeams(settings);

        var pending = _messages.GetByStatus(MessageStatus.Pending, limit: 50);
        if (pending.Count == 0) return;

        var tasks = new List<Task>();
        foreach (var msg in pending)
        {
            if (string.IsNullOrEmpty(msg.AgentId))
            {
                var routing = _router.Route(msg.Content, agents, teams);
                msg.AgentId = routing.AgentId;
                msg.Content = routing.Message;

                if (routing.IsError)
                {
                    _messages.Complete(msg.Id, routing.Message);
                    continue;
                }
            }

            if (!agents.ContainsKey(msg.AgentId ?? ""))
                msg.AgentId = agents.ContainsKey("default") ? "default" : agents.Keys.First();

            var agentId = msg.AgentId!;
            var semaphore = _agentLocks.GetOrAdd(agentId, _ => new SemaphoreSlim(1, 1));

            tasks.Add(Task.Run(async () =>
            {
                await semaphore.WaitAsync(ct);
                try
                {
                    await ProcessSingleMessageAsync(msg, agentId, agents, teams, settings, ct);
                }
                finally
                {
                    semaphore.Release();
                }
            }, ct));
        }

        await Task.WhenAll(tasks);
    }

    private async Task ProcessSingleMessageAsync(QueueMessage msg, string agentId,
        Dictionary<string, AgentConfig> agents, Dictionary<string, TeamConfig> teams,
        Settings settings, CancellationToken ct)
    {
        var claimed = _messages.Dequeue(agentId);
        if (claimed == null) return;

        var agent = agents[agentId];
        var workspacePath = settings.Workspace?.Path ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "tinyclaw-workspace");

        _logger.LogInformation("Processing [{Channel}] from {Sender} → @{Agent}", claimed.Channel, claimed.Sender, agentId);

        try
        {
            var teamContext = FindTeamContext(agentId, teams);

            string response;
            var allFiles = new HashSet<string>();

            if (teamContext == null)
            {
                response = await _invoker.InvokeAsync(agent, agentId, claimed.Content, workspacePath, false, ct);
            }
            else
            {
                response = await ExecuteTeamChainAsync(agentId, claimed.Content, teamContext.Value.TeamId,
                    teamContext.Value.Team, agents, teams, workspacePath, allFiles, ct);
            }

            var filesOut = ParseFileReferences(ref response, allFiles);

            if (response.Length > 4000)
                response = response[..3900] + "\n\n[Response truncated...]";

            _messages.Complete(claimed.Id, response, filesOut);
            _logger.LogInformation("✓ Response ready [{Channel}] {Sender} via @{Agent} ({Length} chars)",
                claimed.Channel, claimed.Sender, agentId, response.Length);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing message for agent {Agent}", agentId);
            _messages.Fail(claimed.Id, ex.Message);
        }
    }

    private (string TeamId, TeamConfig Team)? FindTeamContext(string agentId, Dictionary<string, TeamConfig> teams)
    {
        return _router.FindTeamForAgent(agentId, teams);
    }

    private async Task<string> ExecuteTeamChainAsync(string initialAgentId, string message,
        string teamId, TeamConfig team, Dictionary<string, AgentConfig> agents,
        Dictionary<string, TeamConfig> teams, string workspacePath,
        HashSet<string> allFiles, CancellationToken ct)
    {
        _logger.LogInformation("Team context: {TeamName} (@{TeamId})", team.Name, teamId);

        var chainSteps = new List<(string AgentId, string Response)>();
        var currentAgentId = initialAgentId;
        var currentMessage = message;

        while (true)
        {
            if (!agents.TryGetValue(currentAgentId, out var currentAgent))
            {
                _logger.LogError("Agent {AgentId} not found during chain execution", currentAgentId);
                break;
            }

            _logger.LogInformation("Chain step {Step}: invoking @{AgentId}", chainSteps.Count + 1, currentAgentId);

            string stepResponse;
            try
            {
                stepResponse = await _invoker.InvokeAsync(currentAgent, currentAgentId, currentMessage, workspacePath, false, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Chain step error (agent: {AgentId})", currentAgentId);
                stepResponse = "Sorry, I encountered an error processing this request.";
            }

            chainSteps.Add((currentAgentId, stepResponse));

            CollectFileReferences(stepResponse, allFiles);

            var teammateMentions = _router.ExtractTeammateMentions(
                stepResponse, currentAgentId, teamId, teams, agents);

            if (teammateMentions.Count == 0)
            {
                _logger.LogInformation("Chain ended after {Steps} step(s) — no teammate mentioned", chainSteps.Count);
                break;
            }

            if (teammateMentions.Count == 1)
            {
                var mention = teammateMentions[0];
                _logger.LogInformation("@{From} mentioned @{To} — continuing chain", currentAgentId, mention.TeammateId);
                currentAgentId = mention.TeammateId;
                currentMessage = $"[Message from teammate @{chainSteps[^1].AgentId}]:\n{mention.Message}";
            }
            else
            {
                _logger.LogInformation("@{AgentId} mentioned {Count} teammates — fan-out", currentAgentId, teammateMentions.Count);

                var fanOutTasks = teammateMentions.Select(async mention =>
                {
                    if (!agents.TryGetValue(mention.TeammateId, out var mAgent))
                        return (mention.TeammateId, Response: $"Error: agent {mention.TeammateId} not found");

                    string mResponse;
                    try
                    {
                        var mMessage = $"[Message from teammate @{currentAgentId}]:\n{mention.Message}";
                        mResponse = await _invoker.InvokeAsync(mAgent, mention.TeammateId, mMessage, workspacePath, false, ct);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Fan-out error (agent: {AgentId})", mention.TeammateId);
                        mResponse = "Sorry, I encountered an error processing this request.";
                    }

                    return (mention.TeammateId, Response: mResponse);
                });

                var fanOutResults = await Task.WhenAll(fanOutTasks);

                foreach (var result in fanOutResults)
                {
                    chainSteps.Add(result);
                    CollectFileReferences(result.Response, allFiles);
                }

                _logger.LogInformation("Fan-out complete — {Count} responses collected", fanOutResults.Length);
                break;
            }
        }

        if (chainSteps.Count == 1)
            return chainSteps[0].Response;

        return string.Join("\n\n---\n\n",
            chainSteps.Select(step => $"@{step.AgentId}: {step.Response}"));
    }

    private static void CollectFileReferences(string response, HashSet<string> files)
    {
        foreach (Match match in Regex.Matches(response, @"\[send_file:\s*([^\]]+)\]"))
        {
            var filePath = match.Groups[1].Value.Trim();
            if (File.Exists(filePath))
                files.Add(filePath);
        }
    }

    private static string? ParseFileReferences(ref string response, HashSet<string> existingFiles)
    {
        response = response.Trim();

        foreach (Match match in Regex.Matches(response, @"\[send_file:\s*([^\]]+)\]"))
        {
            var filePath = match.Groups[1].Value.Trim();
            if (File.Exists(filePath))
                existingFiles.Add(filePath);
        }

        if (existingFiles.Count == 0)
            return null;

        response = Regex.Replace(response, @"\[send_file:\s*[^\]]+\]", "").Trim();

        return JsonSerializer.Serialize(existingFiles.ToArray());
    }
}
