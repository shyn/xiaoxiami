namespace TinyClaw.Core.Services;

using System.Text.RegularExpressions;
using TinyClaw.Core.Models;

public record RoutingResult(string AgentId, string Message, bool IsTeam = false, bool IsError = false);

public class MessageRouter
{
    public RoutingResult Route(string rawMessage, Dictionary<string, AgentConfig> agents, Dictionary<string, TeamConfig> teams)
    {
        var mentionedAgents = DetectMultipleAgents(rawMessage, agents, teams);
        if (mentionedAgents.Count > 1)
        {
            var agentList = string.Join(", ", mentionedAgents.Select(a => $"@{a}"));
            var perAgent = string.Join("\n", mentionedAgents.Select(a => $"• `@{a} [your message]`"));
            var errorMessage =
                $"🚀 **Agent-to-Agent Collaboration - Coming Soon!**\n\n" +
                $"You mentioned multiple agents: {agentList}\n\n" +
                "Right now, I can only route to one agent at a time. But we're working on something cool:\n\n" +
                "✨ **Multi-Agent Coordination** - Agents will be able to collaborate on complex tasks!\n" +
                "✨ **Smart Routing** - Send instructions to multiple agents at once!\n" +
                "✨ **Agent Handoffs** - One agent can delegate to another!\n\n" +
                "For now, please send separate messages to each agent:\n" +
                perAgent + "\n\n" +
                "_Stay tuned for updates! 🎉_";
            return new RoutingResult("error", errorMessage, IsError: true);
        }

        var match = Regex.Match(rawMessage, @"^@(\S+)\s+([\s\S]*)$");
        if (match.Success)
        {
            var candidateId = match.Groups[1].Value.ToLowerInvariant();
            var message = match.Groups[2].Value;

            if (agents.ContainsKey(candidateId))
                return new RoutingResult(candidateId, message);

            if (teams.TryGetValue(candidateId, out var team))
                return new RoutingResult(team.LeaderAgent, message, IsTeam: true);

            foreach (var (id, config) in agents)
            {
                if (config.Name.Equals(candidateId, StringComparison.OrdinalIgnoreCase))
                    return new RoutingResult(id, message);
            }

            foreach (var (id, teamConfig) in teams)
            {
                if (teamConfig.Name.Equals(candidateId, StringComparison.OrdinalIgnoreCase))
                    return new RoutingResult(teamConfig.LeaderAgent, message, IsTeam: true);
            }
        }

        return new RoutingResult("default", rawMessage);
    }

    public (string TeamId, TeamConfig Team)? FindTeamForAgent(string agentId, Dictionary<string, TeamConfig> teams)
    {
        foreach (var (teamId, team) in teams)
        {
            if (team.Agents.Contains(agentId))
                return (teamId, team);
        }
        return null;
    }

    public List<(string TeammateId, string Message)> ExtractTeammateMentions(
        string response, string currentAgentId, string teamId,
        Dictionary<string, TeamConfig> teams, Dictionary<string, AgentConfig> agents)
    {
        var results = new List<(string TeammateId, string Message)>();
        var seen = new HashSet<string>();

        var tagMatches = Regex.Matches(response, @"\[@(\S+?):\s*([\s\S]*?)\]");
        foreach (Match tagMatch in tagMatches)
        {
            var candidateId = tagMatch.Groups[1].Value.ToLowerInvariant();
            if (!seen.Contains(candidateId) && IsTeammate(candidateId, currentAgentId, teamId, teams, agents))
            {
                results.Add((candidateId, tagMatch.Groups[2].Value.Trim()));
                seen.Add(candidateId);
            }
        }

        if (results.Count > 0) return results;

        var mentions = Regex.Matches(response, @"@(\S+)");
        foreach (Match mention in mentions)
        {
            var candidateId = mention.Groups[1].Value.ToLowerInvariant();
            if (IsTeammate(candidateId, currentAgentId, teamId, teams, agents))
                return [(candidateId, response)];
        }

        return results;
    }

    private static List<string> DetectMultipleAgents(string message, Dictionary<string, AgentConfig> agents, Dictionary<string, TeamConfig> teams)
    {
        var mentions = Regex.Matches(message, @"@(\S+)");
        var validAgents = new List<string>();

        foreach (Match mention in mentions)
        {
            var agentId = mention.Groups[1].Value.ToLowerInvariant();
            if (agents.ContainsKey(agentId))
                validAgents.Add(agentId);
        }

        if (validAgents.Count > 1)
        {
            foreach (var team in teams.Values)
            {
                if (validAgents.All(a => team.Agents.Contains(a)))
                    return [];
            }
        }

        return validAgents;
    }

    private static bool IsTeammate(
        string mentionedId, string currentAgentId, string teamId,
        Dictionary<string, TeamConfig> teams, Dictionary<string, AgentConfig> agents)
    {
        if (!teams.TryGetValue(teamId, out var team)) return false;
        return mentionedId != currentAgentId
            && team.Agents.Contains(mentionedId)
            && agents.ContainsKey(mentionedId);
    }
}
