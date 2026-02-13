using TinyClaw.Core.Configuration;
using TinyClaw.Core.Data;
using TinyClaw.Core.Models;
using System.Diagnostics;
using System.Text.Json;

var config = new ConfigManager();
var db = new TinyClawDb(config.DbPath);
var messages = new MessageRepository(db);
var logs = new LogRepository(db);

void WriteColor(string text, ConsoleColor color) { Console.ForegroundColor = color; Console.Write(text); Console.ResetColor(); }
void WriteLineColor(string text, ConsoleColor color) { Console.ForegroundColor = color; Console.WriteLine(text); Console.ResetColor(); }
string? Prompt(string label) { WriteColor($"{label}: ", ConsoleColor.Cyan); return Console.ReadLine()?.Trim(); }
string PromptRequired(string label) { while (true) { var v = Prompt(label); if (!string.IsNullOrEmpty(v)) return v; WriteLineColor("  Required.", ConsoleColor.Red); } }

if (args.Length == 0)
{
    ShowHelp();
    return;
}

var command = args[0].ToLowerInvariant();

switch (command)
{
    case "start":
        RunServiceCommand("start");
        break;

    case "stop":
        RunServiceCommand("stop");
        break;

    case "restart":
        WriteLineColor("Stopping TinyClaw service...", ConsoleColor.Yellow);
        RunServiceCommand("stop", quiet: true);
        Thread.Sleep(2000);
        WriteLineColor("Starting TinyClaw service...", ConsoleColor.Yellow);
        RunServiceCommand("start", quiet: true);
        break;

    case "status":
        ShowStatus();
        break;

    case "send":
        SendMessage(args);
        break;

    case "agent":
        HandleAgent(args);
        break;

    case "team":
        HandleTeam(args);
        break;

    case "provider":
        HandleProvider(args);
        break;

    case "model":
        HandleModel(args);
        break;

    case "setup":
        RunSetup();
        break;

    case "logs":
        ShowLogs(args);
        break;

    default:
        WriteLineColor($"Unknown command: {command}", ConsoleColor.Red);
        Console.WriteLine();
        ShowHelp();
        break;
}

// ─── Service Commands ────────────────────────────────────────────────

void RunServiceCommand(string action, bool quiet = false)
{
    try
    {
        var psi = new ProcessStartInfo("sc.exe", $"{action} TinyClaw")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        var proc = Process.Start(psi)!;
        var output = proc.StandardOutput.ReadToEnd();
        var error = proc.StandardError.ReadToEnd();
        proc.WaitForExit();

        if (proc.ExitCode == 0)
        {
            if (!quiet)
            {
                WriteColor("  ✓ ", ConsoleColor.Green);
                Console.WriteLine($"Service {action} succeeded.");
            }
        }
        else
        {
            WriteColor("  ✗ ", ConsoleColor.Red);
            Console.WriteLine($"Service {action} failed (exit code {proc.ExitCode}).");
            if (!string.IsNullOrWhiteSpace(error))
                WriteLineColor($"    {error.Trim()}", ConsoleColor.Red);
            else if (!string.IsNullOrWhiteSpace(output))
                Console.WriteLine($"    {output.Trim()}");
        }
    }
    catch (Exception ex)
    {
        WriteColor("  ✗ ", ConsoleColor.Red);
        Console.WriteLine($"Failed to {action} service: {ex.Message}");
    }
}

// ─── Status ──────────────────────────────────────────────────────────

void ShowStatus()
{
    WriteLineColor("═══ TinyClaw Status ═══", ConsoleColor.Cyan);
    Console.WriteLine();

    // Service state
    WriteColor("  Service: ", ConsoleColor.White);
    try
    {
        var psi = new ProcessStartInfo("sc.exe", "query TinyClaw")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        var proc = Process.Start(psi)!;
        var output = proc.StandardOutput.ReadToEnd();
        proc.WaitForExit();

        if (output.Contains("RUNNING", StringComparison.OrdinalIgnoreCase))
            WriteLineColor("RUNNING", ConsoleColor.Green);
        else if (output.Contains("STOPPED", StringComparison.OrdinalIgnoreCase))
            WriteLineColor("STOPPED", ConsoleColor.Red);
        else if (output.Contains("PAUSED", StringComparison.OrdinalIgnoreCase))
            WriteLineColor("PAUSED", ConsoleColor.Yellow);
        else
            WriteLineColor("UNKNOWN", ConsoleColor.DarkGray);
    }
    catch
    {
        WriteLineColor("UNAVAILABLE", ConsoleColor.DarkGray);
    }

    // Message counts
    Console.WriteLine();
    WriteLineColor("  Messages:", ConsoleColor.White);
    var counts = messages.GetStatusCounts();
    var pending = counts.GetValueOrDefault(MessageStatus.Pending);
    var processing = counts.GetValueOrDefault(MessageStatus.Processing);
    var completed = counts.GetValueOrDefault(MessageStatus.Completed);
    var failed = counts.GetValueOrDefault(MessageStatus.Failed);

    Console.Write("    ");
    WriteColor($"Pending: {pending}", ConsoleColor.Yellow);
    Console.Write("  ");
    WriteColor($"Processing: {processing}", ConsoleColor.Cyan);
    Console.Write("  ");
    WriteColor($"Completed: {completed}", ConsoleColor.Green);
    Console.Write("  ");
    WriteLineColor($"Failed: {failed}", ConsoleColor.Red);

    // Settings info
    var settings = config.LoadSettings();
    var agents = config.GetAgents(settings);
    var teams = config.GetTeams(settings);

    Console.WriteLine();
    WriteLineColor("  Configuration:", ConsoleColor.White);
    Console.WriteLine($"    Agents:   {agents.Count}");
    Console.WriteLine($"    Teams:    {teams.Count}");

    var enabledChannels = settings.Channels?.Enabled ?? new List<string>();
    Console.WriteLine($"    Channels: {(enabledChannels.Count > 0 ? string.Join(", ", enabledChannels) : "none")}");

    var provider = settings.Models?.Provider ?? "anthropic";
    var model = provider == "openai"
        ? settings.Models?.OpenAi?.Model ?? "gpt-5.3-codex"
        : settings.Models?.Anthropic?.Model ?? "sonnet";
    Console.WriteLine($"    Provider: {provider} ({model})");

    // Last 5 messages
    Console.WriteLine();
    WriteLineColor("  Recent Messages:", ConsoleColor.White);
    var recent = messages.GetRecent(5);
    if (recent.Count == 0)
    {
        Console.WriteLine("    (none)");
    }
    else
    {
        foreach (var msg in recent)
        {
            var statusColor = msg.Status switch
            {
                MessageStatus.Completed => ConsoleColor.Green,
                MessageStatus.Failed => ConsoleColor.Red,
                MessageStatus.Processing => ConsoleColor.Cyan,
                _ => ConsoleColor.Yellow
            };
            Console.Write($"    [{msg.CreatedAt:HH:mm:ss}] ");
            WriteColor($"[{msg.Status}]", statusColor);
            var preview = msg.Content.Length > 60 ? msg.Content[..60] + "…" : msg.Content;
            Console.WriteLine($" {msg.Channel}/{msg.Sender}: {preview}");
        }
    }
    Console.WriteLine();
}

// ─── Send ────────────────────────────────────────────────────────────

void SendMessage(string[] args)
{
    if (args.Length < 2)
    {
        WriteLineColor("Usage: tinyclaw send <message>", ConsoleColor.Red);
        return;
    }

    var text = string.Join(' ', args.Skip(1));
    var msg = new QueueMessage
    {
        Channel = "cli",
        Sender = "CLI",
        Content = text,
        MessageId = $"cli-{DateTime.UtcNow:yyyyMMddHHmmssfff}-{Guid.NewGuid().ToString("N")[..8]}"
    };

    var id = messages.Enqueue(msg);
    WriteColor("  ✓ ", ConsoleColor.Green);
    Console.WriteLine($"Message queued (id: {id})");
    Console.WriteLine($"    \"{text}\"");
}

// ─── Agent Commands ──────────────────────────────────────────────────

void HandleAgent(string[] args)
{
    if (args.Length < 2)
    {
        WriteLineColor("Usage: tinyclaw agent <list|add|remove|show|reset> [id]", ConsoleColor.Red);
        return;
    }

    var sub = args[1].ToLowerInvariant();
    var settings = config.LoadSettings();
    var agents = config.GetAgents(settings);

    switch (sub)
    {
        case "list":
            WriteLineColor("═══ Agents ═══", ConsoleColor.Cyan);
            if (agents.Count == 0)
            {
                Console.WriteLine("  (none configured)");
                return;
            }
            foreach (var (id, agent) in agents)
            {
                Console.WriteLine();
                WriteColor($"  {id}", ConsoleColor.White);
                Console.WriteLine($" — {agent.Name}");
                Console.WriteLine($"    Provider: {agent.Provider}/{agent.Model}");
                Console.WriteLine($"    WorkDir:  {agent.WorkingDirectory}");
            }
            Console.WriteLine();
            break;

        case "add":
            AgentAdd(settings);
            break;

        case "remove":
            if (args.Length < 3) { WriteLineColor("Usage: tinyclaw agent remove <id>", ConsoleColor.Red); return; }
            AgentRemove(settings, args[2]);
            break;

        case "show":
            if (args.Length < 3) { WriteLineColor("Usage: tinyclaw agent show <id>", ConsoleColor.Red); return; }
            AgentShow(agents, args[2]);
            break;

        case "reset":
            if (args.Length < 3) { WriteLineColor("Usage: tinyclaw agent reset <id>", ConsoleColor.Red); return; }
            AgentReset(agents, args[2]);
            break;

        default:
            WriteLineColor($"Unknown agent command: {sub}", ConsoleColor.Red);
            break;
    }
}

void AgentAdd(Settings settings)
{
    WriteLineColor("═══ Add Agent ═══", ConsoleColor.Cyan);
    Console.WriteLine();

    var id = PromptRequired("Agent ID");
    var name = PromptRequired("Name");

    string provider;
    while (true)
    {
        provider = PromptRequired("Provider (anthropic/openai)").ToLowerInvariant();
        if (provider is "anthropic" or "openai") break;
        WriteLineColor("  Must be 'anthropic' or 'openai'.", ConsoleColor.Red);
    }

    var model = PromptRequired("Model");
    var workDir = PromptRequired("Working directory");

    var agentsCopy = new Dictionary<string, AgentConfig>(config.GetAgents(settings))
    {
        [id] = new AgentConfig
        {
            Name = name,
            Provider = provider,
            Model = model,
            WorkingDirectory = workDir
        }
    };

    var updated = settings with { Agents = agentsCopy };
    config.SaveSettings(updated);

    Console.WriteLine();
    WriteColor("  ✓ ", ConsoleColor.Green);
    Console.WriteLine($"Agent '{id}' added.");
}

void AgentRemove(Settings settings, string id)
{
    var agentsCopy = new Dictionary<string, AgentConfig>(config.GetAgents(settings));
    if (!agentsCopy.Remove(id))
    {
        WriteColor("  ✗ ", ConsoleColor.Red);
        Console.WriteLine($"Agent '{id}' not found.");
        return;
    }

    var updated = settings with { Agents = agentsCopy };
    config.SaveSettings(updated);

    WriteColor("  ✓ ", ConsoleColor.Green);
    Console.WriteLine($"Agent '{id}' removed.");
}

void AgentShow(Dictionary<string, AgentConfig> agents, string id)
{
    if (!agents.TryGetValue(id, out var agent))
    {
        WriteColor("  ✗ ", ConsoleColor.Red);
        Console.WriteLine($"Agent '{id}' not found.");
        return;
    }

    WriteLineColor($"═══ Agent: {id} ═══", ConsoleColor.Cyan);
    Console.WriteLine($"  Name:     {agent.Name}");
    Console.WriteLine($"  Provider: {agent.Provider}");
    Console.WriteLine($"  Model:    {agent.Model}");
    Console.WriteLine($"  WorkDir:  {agent.WorkingDirectory}");
    Console.WriteLine();
}

void AgentReset(Dictionary<string, AgentConfig> agents, string id)
{
    if (!agents.TryGetValue(id, out var agent))
    {
        WriteColor("  ✗ ", ConsoleColor.Red);
        Console.WriteLine($"Agent '{id}' not found.");
        return;
    }

    try
    {
        Directory.CreateDirectory(agent.WorkingDirectory);
        var flagPath = Path.Combine(agent.WorkingDirectory, "reset_flag");
        File.WriteAllText(flagPath, DateTime.UtcNow.ToString("o"));

        WriteColor("  ✓ ", ConsoleColor.Green);
        Console.WriteLine($"Reset flag created for agent '{id}'.");
        Console.WriteLine($"    {flagPath}");
    }
    catch (Exception ex)
    {
        WriteColor("  ✗ ", ConsoleColor.Red);
        Console.WriteLine($"Failed to create reset flag: {ex.Message}");
    }
}

// ─── Team Commands ───────────────────────────────────────────────────

void HandleTeam(string[] args)
{
    if (args.Length < 2)
    {
        WriteLineColor("Usage: tinyclaw team <list|add|remove|show> [id]", ConsoleColor.Red);
        return;
    }

    var sub = args[1].ToLowerInvariant();
    var settings = config.LoadSettings();
    var teams = config.GetTeams(settings);

    switch (sub)
    {
        case "list":
            WriteLineColor("═══ Teams ═══", ConsoleColor.Cyan);
            if (teams.Count == 0)
            {
                Console.WriteLine("  (none configured)");
                return;
            }
            foreach (var (id, team) in teams)
            {
                Console.WriteLine();
                WriteColor($"  {id}", ConsoleColor.White);
                Console.WriteLine($" — {team.Name}");
                Console.WriteLine($"    Agents: {string.Join(", ", team.Agents)}");
                Console.WriteLine($"    Leader: {team.LeaderAgent}");
            }
            Console.WriteLine();
            break;

        case "add":
            TeamAdd(settings);
            break;

        case "remove":
            if (args.Length < 3) { WriteLineColor("Usage: tinyclaw team remove <id>", ConsoleColor.Red); return; }
            TeamRemove(settings, args[2]);
            break;

        case "show":
            if (args.Length < 3) { WriteLineColor("Usage: tinyclaw team show <id>", ConsoleColor.Red); return; }
            TeamShow(teams, args[2]);
            break;

        default:
            WriteLineColor($"Unknown team command: {sub}", ConsoleColor.Red);
            break;
    }
}

void TeamAdd(Settings settings)
{
    WriteLineColor("═══ Add Team ═══", ConsoleColor.Cyan);
    Console.WriteLine();

    var agents = config.GetAgents(settings);
    if (agents.Count > 0)
    {
        Console.WriteLine("  Available agents:");
        foreach (var (id, agent) in agents)
            Console.WriteLine($"    - {id} ({agent.Name})");
        Console.WriteLine();
    }

    var teamId = PromptRequired("Team ID");
    var name = PromptRequired("Name");
    var agentIds = PromptRequired("Agents (comma-separated IDs)")
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .ToList();

    if (agentIds.Count == 0)
    {
        WriteLineColor("  At least one agent is required.", ConsoleColor.Red);
        return;
    }

    string leader;
    if (agentIds.Count == 1)
    {
        leader = agentIds[0];
        Console.WriteLine($"  Leader auto-selected: {leader}");
    }
    else
    {
        leader = PromptRequired($"Leader agent ({string.Join("/", agentIds)})");
        if (!agentIds.Contains(leader))
        {
            WriteLineColor("  Leader must be one of the team agents.", ConsoleColor.Red);
            return;
        }
    }

    var teamsCopy = new Dictionary<string, TeamConfig>(config.GetTeams(settings))
    {
        [teamId] = new TeamConfig
        {
            Name = name,
            Agents = agentIds,
            LeaderAgent = leader
        }
    };

    var updated = settings with { Teams = teamsCopy };
    config.SaveSettings(updated);

    Console.WriteLine();
    WriteColor("  ✓ ", ConsoleColor.Green);
    Console.WriteLine($"Team '{teamId}' added with {agentIds.Count} agent(s).");
}

void TeamRemove(Settings settings, string id)
{
    var teamsCopy = new Dictionary<string, TeamConfig>(config.GetTeams(settings));
    if (!teamsCopy.Remove(id))
    {
        WriteColor("  ✗ ", ConsoleColor.Red);
        Console.WriteLine($"Team '{id}' not found.");
        return;
    }

    var updated = settings with { Teams = teamsCopy };
    config.SaveSettings(updated);

    WriteColor("  ✓ ", ConsoleColor.Green);
    Console.WriteLine($"Team '{id}' removed.");
}

void TeamShow(Dictionary<string, TeamConfig> teams, string id)
{
    if (!teams.TryGetValue(id, out var team))
    {
        WriteColor("  ✗ ", ConsoleColor.Red);
        Console.WriteLine($"Team '{id}' not found.");
        return;
    }

    WriteLineColor($"═══ Team: {id} ═══", ConsoleColor.Cyan);
    Console.WriteLine($"  Name:   {team.Name}");
    Console.WriteLine($"  Leader: {team.LeaderAgent}");
    Console.WriteLine($"  Agents:");
    foreach (var agentId in team.Agents)
    {
        var marker = agentId == team.LeaderAgent ? " ★" : "";
        Console.WriteLine($"    - {agentId}{marker}");
    }
    Console.WriteLine();
}

// ─── Provider / Model ────────────────────────────────────────────────

void HandleProvider(string[] args)
{
    var settings = config.LoadSettings();
    var currentProvider = settings.Models?.Provider ?? "anthropic";

    if (args.Length < 2)
    {
        WriteColor("  Current provider: ", ConsoleColor.White);
        WriteLineColor(currentProvider, ConsoleColor.Green);
        return;
    }

    var newProvider = args[1].ToLowerInvariant();
    if (newProvider is not ("anthropic" or "openai"))
    {
        WriteLineColor("  Provider must be 'anthropic' or 'openai'.", ConsoleColor.Red);
        return;
    }

    var modelsConfig = settings.Models ?? new ModelsConfig();
    modelsConfig = modelsConfig with { Provider = newProvider };
    var updated = settings with { Models = modelsConfig };
    config.SaveSettings(updated);

    WriteColor("  ✓ ", ConsoleColor.Green);
    Console.WriteLine($"Provider switched to '{newProvider}'.");
}

void HandleModel(string[] args)
{
    var settings = config.LoadSettings();
    var provider = settings.Models?.Provider ?? "anthropic";
    var currentModel = provider == "openai"
        ? settings.Models?.OpenAi?.Model ?? "gpt-5.3-codex"
        : settings.Models?.Anthropic?.Model ?? "sonnet";

    if (args.Length < 2)
    {
        WriteColor("  Current model: ", ConsoleColor.White);
        WriteLineColor($"{currentModel} ({provider})", ConsoleColor.Green);
        return;
    }

    var newModel = args[1];
    var modelsConfig = settings.Models ?? new ModelsConfig();

    if (provider == "openai")
    {
        var oai = modelsConfig.OpenAi ?? new OpenAiConfig();
        modelsConfig = modelsConfig with { OpenAi = oai with { Model = newModel } };
    }
    else
    {
        var anth = modelsConfig.Anthropic ?? new AnthropicConfig();
        modelsConfig = modelsConfig with { Anthropic = anth with { Model = newModel } };
    }

    var updated = settings with { Models = modelsConfig };
    config.SaveSettings(updated);

    WriteColor("  ✓ ", ConsoleColor.Green);
    Console.WriteLine($"Model switched to '{newModel}' ({provider}).");
}

// ─── Setup Wizard ────────────────────────────────────────────────────

void RunSetup()
{
    WriteLineColor("═══ TinyClaw Setup Wizard ═══", ConsoleColor.Cyan);
    Console.WriteLine();

    var workspacePath = PromptRequired("Workspace path");

    var discordEnabled = Prompt("Enable Discord? (y/n)")?.ToLowerInvariant() == "y";
    string? discordToken = null;
    if (discordEnabled)
        discordToken = PromptRequired("Discord bot token");

    var telegramEnabled = Prompt("Enable Telegram? (y/n)")?.ToLowerInvariant() == "y";
    string? telegramToken = null;
    if (telegramEnabled)
        telegramToken = PromptRequired("Telegram bot token");

    var enabledChannels = new List<string> { "cli" };
    if (discordEnabled) enabledChannels.Add("discord");
    if (telegramEnabled) enabledChannels.Add("telegram");

    string provider;
    while (true)
    {
        provider = PromptRequired("Provider (anthropic/openai)").ToLowerInvariant();
        if (provider is "anthropic" or "openai") break;
        WriteLineColor("  Must be 'anthropic' or 'openai'.", ConsoleColor.Red);
    }

    var model = PromptRequired("Model name");
    var defaultAgent = Prompt("Default agent ID") ?? "default";

    var heartbeatStr = Prompt("Heartbeat interval in seconds (default: 3600)");
    var heartbeat = int.TryParse(heartbeatStr, out var hb) ? hb : 3600;

    var newSettings = new Settings
    {
        Workspace = new WorkspaceConfig
        {
            Path = workspacePath,
            Name = Path.GetFileName(workspacePath)
        },
        Channels = new ChannelsConfig
        {
            Enabled = enabledChannels,
            Discord = discordEnabled ? new DiscordConfig { BotToken = discordToken } : null,
            Telegram = telegramEnabled ? new TelegramConfig { BotToken = telegramToken } : null
        },
        Models = provider == "openai"
            ? new ModelsConfig { Provider = "openai", OpenAi = new OpenAiConfig { Model = model } }
            : new ModelsConfig { Provider = "anthropic", Anthropic = new AnthropicConfig { Model = model } },
        Agents = new Dictionary<string, AgentConfig>
        {
            [defaultAgent] = new AgentConfig
            {
                Name = "Default",
                Provider = provider,
                Model = model,
                WorkingDirectory = Path.Combine(workspacePath, defaultAgent)
            }
        },
        Monitoring = new MonitoringConfig { HeartbeatInterval = heartbeat }
    };

    config.SaveSettings(newSettings);

    Console.WriteLine();
    WriteColor("  ✓ ", ConsoleColor.Green);
    Console.WriteLine("Setup complete!");
    Console.WriteLine($"    Config: {config.SettingsPath}");
    Console.WriteLine($"    DB:     {config.DbPath}");
    Console.WriteLine();
}

// ─── Logs ────────────────────────────────────────────────────────────

void ShowLogs(string[] args)
{
    WriteLineColor("═══ Logs ═══", ConsoleColor.Cyan);
    Console.WriteLine();

    string? sourceFilter = args.Length >= 2 ? args[1] : null;

    var entries = logs.GetRecent(50);

    if (sourceFilter != null)
        entries = entries.Where(e => string.Equals(e.Source, sourceFilter, StringComparison.OrdinalIgnoreCase)).ToList();

    if (entries.Count == 0)
    {
        Console.WriteLine("  (no log entries)");
        return;
    }

    foreach (var entry in entries.OrderBy(e => e.Timestamp))
    {
        var levelColor = entry.Level.ToUpperInvariant() switch
        {
            "ERROR" => ConsoleColor.Red,
            "WARN" or "WARNING" => ConsoleColor.Yellow,
            _ => ConsoleColor.Gray
        };

        Console.Write($"  [{entry.Timestamp:yyyy-MM-dd HH:mm:ss}] ");
        WriteColor($"[{entry.Level,-5}]", levelColor);
        if (entry.Source != null)
            WriteColor($" [{entry.Source}]", ConsoleColor.DarkGray);
        Console.WriteLine($" {entry.Message}");
    }
    Console.WriteLine();
}

// ─── Help ────────────────────────────────────────────────────────────

void ShowHelp()
{
    WriteLineColor("TinyClaw CLI", ConsoleColor.Cyan);
    Console.WriteLine("Manage the TinyClaw Windows Service.");
    Console.WriteLine();

    WriteLineColor("Service:", ConsoleColor.White);
    Console.WriteLine("  start                  Start the TinyClaw service");
    Console.WriteLine("  stop                   Stop the TinyClaw service");
    Console.WriteLine("  restart                Restart the TinyClaw service");
    Console.WriteLine("  status                 Show service status and message queue");
    Console.WriteLine();

    WriteLineColor("Messages:", ConsoleColor.White);
    Console.WriteLine("  send <message>         Send a message to the queue");
    Console.WriteLine();

    WriteLineColor("Agents:", ConsoleColor.White);
    Console.WriteLine("  agent list             List all configured agents");
    Console.WriteLine("  agent add              Add a new agent (interactive)");
    Console.WriteLine("  agent remove <id>      Remove an agent");
    Console.WriteLine("  agent show <id>        Show agent details");
    Console.WriteLine("  agent reset <id>       Reset an agent (create reset flag)");
    Console.WriteLine();

    WriteLineColor("Teams:", ConsoleColor.White);
    Console.WriteLine("  team list              List all configured teams");
    Console.WriteLine("  team add               Add a new team (interactive)");
    Console.WriteLine("  team remove <id>       Remove a team");
    Console.WriteLine("  team show <id>         Show team details");
    Console.WriteLine();

    WriteLineColor("Configuration:", ConsoleColor.White);
    Console.WriteLine("  provider [name]        Show or switch AI provider");
    Console.WriteLine("  model [name]           Show or switch AI model");
    Console.WriteLine("  setup                  Run the setup wizard");
    Console.WriteLine();

    WriteLineColor("Diagnostics:", ConsoleColor.White);
    Console.WriteLine("  logs [source]          Show recent log entries");
    Console.WriteLine();
}
