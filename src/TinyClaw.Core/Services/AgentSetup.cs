namespace TinyClaw.Core.Services;

using System.Text;
using TinyClaw.Core.Models;

public class AgentSetup
{
    private readonly string _templateDir;

    public AgentSetup(string templateDir)
    {
        _templateDir = templateDir;
    }

    public bool EnsureAgentDirectory(string agentDir)
    {
        if (Directory.Exists(agentDir)) return false;
        Directory.CreateDirectory(agentDir);

        CopyIfExists(Path.Combine(_templateDir, "heartbeat.md"), Path.Combine(agentDir, "heartbeat.md"));
        CopyIfExists(Path.Combine(_templateDir, "AGENTS.md"), Path.Combine(agentDir, "AGENTS.md"));

        var claudeDir = Path.Combine(_templateDir, ".claude");
        if (Directory.Exists(claudeDir))
            CopyDirectory(claudeDir, Path.Combine(agentDir, ".claude"));

        var tinyClawDir = Path.Combine(agentDir, ".tinyclaw");
        Directory.CreateDirectory(tinyClawDir);
        CopyIfExists(Path.Combine(_templateDir, "SOUL.md"), Path.Combine(tinyClawDir, "SOUL.md"));

        return true;
    }

    public void UpdateAgentTeammates(string agentDir, string agentId,
        Dictionary<string, AgentConfig> agents, Dictionary<string, TeamConfig> teams)
    {
        var agentsMdPath = Path.Combine(agentDir, "AGENTS.md");
        if (!File.Exists(agentsMdPath)) return;

        var content = File.ReadAllText(agentsMdPath);
        const string startMarker = "<!-- TEAMMATES_START -->";
        const string endMarker = "<!-- TEAMMATES_END -->";
        var startIdx = content.IndexOf(startMarker);
        var endIdx = content.IndexOf(endMarker);
        if (startIdx < 0 || endIdx < 0) return;

        var teammates = new List<(string Id, string Name, string Model)>();
        foreach (var team in teams.Values)
        {
            if (!team.Agents.Contains(agentId)) continue;
            foreach (var tid in team.Agents)
            {
                if (tid == agentId) continue;
                if (agents.TryGetValue(tid, out var a) && !teammates.Any(t => t.Id == tid))
                    teammates.Add((tid, a.Name, a.Model));
            }
        }

        var sb = new StringBuilder();
        if (agents.TryGetValue(agentId, out var self))
            sb.AppendLine($"\n### You\n\n- `@{agentId}` — **{self.Name}** ({self.Model})");
        if (teammates.Count > 0)
        {
            sb.AppendLine("\n### Your Teammates\n");
            foreach (var t in teammates)
                sb.AppendLine($"- `@{t.Id}` — **{t.Name}** ({t.Model})");
        }

        var newContent = content[..(startIdx + startMarker.Length)] + sb.ToString() + content[endIdx..];
        File.WriteAllText(agentsMdPath, newContent);
    }

    private static void CopyIfExists(string src, string dest)
    {
        if (File.Exists(src)) File.Copy(src, dest, overwrite: true);
    }

    private static void CopyDirectory(string src, string dest)
    {
        Directory.CreateDirectory(dest);
        foreach (var file in Directory.GetFiles(src))
            File.Copy(file, Path.Combine(dest, Path.GetFileName(file)), overwrite: true);
        foreach (var dir in Directory.GetDirectories(src))
            CopyDirectory(dir, Path.Combine(dest, Path.GetFileName(dir)));
    }
}
