namespace TinyClaw.Core.Services;

using System.Diagnostics;
using System.Text.Json;
using TinyClaw.Core.Models;

public class AgentInvoker
{
    private static readonly Dictionary<string, string> ClaudeModels = new()
    {
        ["sonnet"] = "claude-sonnet-4-5",
        ["opus"] = "claude-opus-4-6",
    };

    private static readonly Dictionary<string, string> CodexModels = new()
    {
        ["gpt-5.2"] = "gpt-5.2",
        ["gpt-5.3-codex"] = "gpt-5.3-codex",
    };

    public async Task<string> InvokeAsync(AgentConfig agent, string agentId, string message, string workspacePath, bool shouldReset, CancellationToken ct = default)
    {
        var workingDir = Path.IsPathRooted(agent.WorkingDirectory)
            ? agent.WorkingDirectory
            : Path.Combine(workspacePath, agent.WorkingDirectory);

        if (agent.Provider == "openai")
            return await InvokeCodexAsync(agent, message, workingDir, shouldReset, ct);
        else
            return await InvokeClaudeAsync(agent, message, workingDir, shouldReset, ct);
    }

    private async Task<string> InvokeClaudeAsync(AgentConfig agent, string message, string workingDir, bool shouldReset, CancellationToken ct)
    {
        var args = new List<string> { "--dangerously-skip-permissions" };
        var modelId = ResolveModel(agent.Model, ClaudeModels);
        if (!string.IsNullOrEmpty(modelId))
        {
            args.Add("--model");
            args.Add(modelId);
        }
        
        // Load SOUL.md as system prompt if it exists
        var soulPath = Path.Combine(workingDir, ".tinyclaw", "SOUL.md");
        if (File.Exists(soulPath))
        {
            var soulContent = await File.ReadAllTextAsync(soulPath, ct);
            if (!string.IsNullOrWhiteSpace(soulContent))
            {
                args.Add("--system-prompt");
                args.Add(soulContent.Trim());
            }
        }
        
        if (!shouldReset) args.Add("-c");
        args.Add("-p");
        args.Add(message);
        return await RunProcessAsync("claude", args, workingDir, ct);
    }

    private async Task<string> InvokeCodexAsync(AgentConfig agent, string message, string workingDir, bool shouldReset, CancellationToken ct)
    {
        var args = new List<string> { "exec" };
        if (!shouldReset)
        {
            args.Add("resume");
            args.Add("--last");
        }
        var modelId = ResolveModel(agent.Model, CodexModels);
        if (!string.IsNullOrEmpty(modelId))
        {
            args.Add("--model");
            args.Add(modelId);
        }
        args.Add("--skip-git-repo-check");
        args.Add("--dangerously-bypass-approvals-and-sandbox");
        args.Add("--json");
        args.Add(message);

        var output = await RunProcessAsync("codex", args, workingDir, ct);
        return ParseCodexResponse(output);
    }

    private static async Task<string> RunProcessAsync(string command, List<string> args, string workingDir, CancellationToken ct)
    {
        Directory.CreateDirectory(workingDir);
        
        // On Windows, prefer .cmd extension for CLI tools installed via npm/scoop
        if (OperatingSystem.IsWindows() && !Path.HasExtension(command))
        {
            command += ".cmd";
        }
        
        var psi = new ProcessStartInfo(command)
        {
            WorkingDirectory = workingDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);

        using var process = Process.Start(psi) ?? throw new InvalidOperationException($"Failed to start {command}");
        var stdout = await process.StandardOutput.ReadToEndAsync(ct);
        var stderr = await process.StandardError.ReadToEndAsync(ct);
        await process.WaitForExitAsync(ct);

        if (process.ExitCode != 0)
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(stderr) ? $"{command} exited with code {process.ExitCode}" : stderr.Trim());

        return stdout;
    }

    private static string ResolveModel(string model, Dictionary<string, string> map)
        => map.TryGetValue(model, out var resolved) ? resolved : model;

    private static string ParseCodexResponse(string output)
    {
        var response = "";
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (root.TryGetProperty("type", out var typeProp) && typeProp.GetString() == "item.completed"
                    && root.TryGetProperty("item", out var item)
                    && item.TryGetProperty("type", out var itemType) && itemType.GetString() == "agent_message"
                    && item.TryGetProperty("text", out var text))
                {
                    response = text.GetString() ?? "";
                }
            }
            catch
            {
            }
        }
        return string.IsNullOrEmpty(response) ? "Sorry, I could not generate a response." : response;
    }
}
