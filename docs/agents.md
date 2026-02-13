# Agents

Agents are the core AI workers in TinyClaw. Each agent is configured with a specific AI provider (Claude or OpenAI), model, and working directory.

## Agent Configuration

### Default Agent

By default, TinyClaw creates a single "default" agent if no agents are configured. The default agent uses:
- Provider: Anthropic (Claude) or OpenAI based on settings
- Model: "sonnet" (Claude) or "gpt-5.3-codex" (OpenAI)
- Working Directory: `{workspace}/default`

### Custom Agents

You can define custom agents in `settings.json`:

```json
{
  "agents": {
    "frontend": {
      "name": "Frontend Developer",
      "provider": "anthropic",
      "model": "sonnet",
      "working_directory": "projects/frontend"
    },
    "backend": {
      "name": "Backend Developer", 
      "provider": "openai",
      "model": "gpt-5.3-codex",
      "working_directory": "projects/backend"
    },
    "devops": {
      "name": "DevOps Engineer",
      "provider": "anthropic", 
      "model": "opus",
      "working_directory": "infrastructure"
    }
  }
}
```

### Agent Properties

| Property | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Display name for the agent |
| `provider` | Yes | `"anthropic"` or `"openai"` |
| `model` | Yes | Model identifier (see below) |
| `working_directory` | Yes | Directory for agent file operations |

## Supported Models

### Anthropic (Claude)

| Model ID | Description |
|----------|-------------|
| `sonnet` | Claude Sonnet 4.5 - balanced performance |
| `opus` | Claude Opus 4.6 - most capable |

### OpenAI (Codex)

| Model ID | Description |
|----------|-------------|
| `gpt-5.2` | GPT-5.2 base model |
| `gpt-5.3-codex` | GPT-5.3 with Codex capabilities |

## Using Agents

### Direct Messaging

To route a message to a specific agent, prefix your message with `@agent_id`:

```
@frontend Create a React component for a login form
```

```
@backend Implement a JWT authentication middleware
```

### Without Agent Prefix

Messages without an `@agent_id` prefix are routed to the "default" agent.

## Agent Working Directory

Each agent operates within its own working directory:

- **Absolute paths**: Used as-is
- **Relative paths**: Resolved relative to the workspace root

Example structure:
```
C:\ProgramData\TinyClaw\workspace\
├── default\           # Default agent
├── projects\
│   ├── frontend\      # Frontend agent
│   └── backend\       # Backend agent
└── infrastructure\     # DevOps agent
```

## Creating Specialized Agents

### Code Review Agent
```json
{
  "code-reviewer": {
    "name": "Code Reviewer",
    "provider": "anthropic",
    "model": "opus",
    "working_directory": "reviews"
  }
}
```

### Documentation Agent
```json
{
  "docs": {
    "name": "Documentation Writer",
    "provider": "anthropic",
    "model": "sonnet",
    "working_directory": "docs"
  }
}
```

### Testing Agent
```json
{
  "qa": {
    "name": "QA Engineer",
    "provider": "openai",
    "model": "gpt-5.3-codex",
    "working_directory": "tests"
  }
}
```

## Agent Commands

Users can interact with agents using special commands:

| Command | Description |
|---------|-------------|
| `!agent` or `/agent` | List available agents |
| `!team` or `/team` | List available teams |
| `!reset` or `/reset` | Reset conversation context |

## Best Practices

1. **Separate Concerns**: Create different agents for different tasks (frontend, backend, devops)

2. **Working Directories**: Keep agent workspaces isolated to prevent file conflicts

3. **Model Selection**: 
   - Use `sonnet` for general tasks (faster, cheaper)
   - Use `opus` for complex reasoning tasks
   - Use OpenAI models if you prefer Codex integration

4. **Naming**: Use descriptive agent IDs (e.g., `frontend-dev` instead of `agent1`)

5. **Provider Consistency**: Agents in a team should ideally use the same provider for consistent behavior

## Troubleshooting

### Agent not responding
- Check if the agent is properly configured in settings
- Verify the provider CLI is installed (`claude` or `codex`)
- Check service logs for errors

### Working directory issues
- Ensure the service has write permissions to the workspace
- Use absolute paths if relative paths don't resolve correctly

### Model errors
- Verify the model ID is correct for the provider
- Check that your API keys are configured for the CLI tools

## Agent Personality (SOUL.md)

Define agent personality, behavior, and system instructions using a `SOUL.md` file.

### Location

```
{workspace}/{agentId}/.tinyclaw/SOUL.md
```

### Example SOUL.md

```markdown
# Frontend Developer Agent

You are an expert frontend developer specializing in React and TypeScript.

## Responsibilities
- Create responsive, accessible UI components
- Write clean, maintainable TypeScript code
- Follow modern React patterns (hooks, functional components)

## Communication Style
- Be concise but thorough
- Provide code examples when helpful
- Ask clarifying questions when requirements are unclear

## Tools & Technologies
- React 18+, TypeScript, Vite
- Tailwind CSS for styling
- React Query for data fetching

## Constraints
- Always use TypeScript (no JavaScript)
- Prefer functional components over classes
- Write tests for complex logic
```

### How it works

- SOUL.md is automatically copied from templates when an agent directory is created
- Content is passed as `--system-prompt` to Claude CLI
- Defines agent's persona, expertise, and constraints
- Applies to all messages processed by the agent

### Creating custom SOUL.md

1. Navigate to agent's `.tinyclaw/` directory:
   ```
   {workspace}/{agentId}/.tinyclaw/
   ```

2. Edit or create `SOUL.md`

3. Restart the service or wait for next message (no restart needed)

### Best practices

- **Be specific** about the agent's role and expertise
- **Define constraints** (what the agent should/shouldn't do)
- **Set communication style** (formal, casual, technical, etc.)
- **Include context** about tools and technologies
- **Keep it concise** (Claude has token limits for system prompts)

## Agent Heartbeat

TinyClaw can periodically send heartbeat messages to agents to keep them active or trigger scheduled tasks.

### How it works

- A heartbeat message is sent to all agents at a configurable interval (default: 1 hour)
- The message appears as a system message with `@agent_id` prefix
- Agents process heartbeats like normal messages

### Default heartbeat message

```
@{agentId} Quick status check: Any pending tasks? Keep response brief.
```

### Custom heartbeat prompt

Create a `heartbeat.md` file in the agent's working directory:

```
{workspace}/{agentId}/heartbeat.md
```

Example content:
```markdown
Review your current tasks and report any blockers. 
Check for overdue items and prioritize accordingly.
```

### Configuration

```json
{
  "monitoring": {
    "heartbeat_interval": 3600
  }
}
```

| Value | Behavior |
|-------|----------|
| `3600` | Heartbeat every hour (default) |
| `300` | Heartbeat every 5 minutes |
| `0` | Disable heartbeat |

### Use cases

- **Keep agents warm**: Prevent cold-start latency on infrequent agents
- **Periodic self-checks**: Agents review their own status
- **Scheduled tasks**: Trigger recurring maintenance or reporting
- **Health monitoring**: Detect unresponsive agents
