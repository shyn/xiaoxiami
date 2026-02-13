# Configuration

TinyClaw uses a single `settings.json` file for all configuration. The file is stored in:

**Windows**: `C:\ProgramData\TinyClaw\settings.json`

## Configuration File Structure

```json
{
  "workspace": {
    "path": "C:\\Projects\\TinyClaw",
    "name": "My Workspace"
  },
  "channels": {
    "enabled": ["discord", "telegram"],
    "discord": {
      "bot_token": "YOUR_DISCORD_BOT_TOKEN"
    },
    "telegram": {
      "bot_token": "YOUR_TELEGRAM_BOT_TOKEN",
      "proxy_url": "http://proxy.company.com:8080"
    }
  },
  "models": {
    "provider": "anthropic",
    "anthropic": {
      "model": "sonnet"
    },
    "openai": {
      "model": "gpt-5.3-codex"
    }
  },
  "agents": {
    "default": {
      "name": "Default",
      "provider": "anthropic",
      "model": "sonnet",
      "working_directory": "default"
    }
  },
  "teams": {},
  "monitoring": {
    "heartbeat_interval": 3600
  }
}
```

## Sections

### Workspace

Defines the workspace location for agent file operations.

```json
{
  "workspace": {
    "path": "C:\\Projects\\TinyClaw",
    "name": "My Workspace"
  }
}
```

| Property | Description |
|----------|-------------|
| `path` | Root directory for all agent working directories |
| `name` | Display name for the workspace |

### Channels

Configure Discord and Telegram bot integrations.

#### Discord

```json
{
  "channels": {
    "discord": {
      "bot_token": "YOUR_BOT_TOKEN"
    }
  }
}
```

#### Telegram

```json
{
  "channels": {
    "telegram": {
      "bot_token": "YOUR_BOT_TOKEN",
      "proxy_url": "http://proxy:8080"
    }
  }
}
```

| Property | Required | Description |
|----------|----------|-------------|
| `bot_token` | Yes | Bot token from @BotFather |
| `proxy_url` | No | HTTP/SOCKS proxy for API calls |

### Models

Configure the default AI provider and model.

```json
{
  "models": {
    "provider": "anthropic",
    "anthropic": {
      "model": "sonnet"
    },
    "openai": {
      "model": "gpt-5.3-codex"
    }
  }
}
```

| Property | Description |
|----------|-------------|
| `provider` | `"anthropic"` or `"openai"` |
| `anthropic.model` | Claude model: `sonnet` or `opus` |
| `openai.model` | OpenAI model: `gpt-5.2` or `gpt-5.3-codex` |

### Agents

Define custom agents. See [Agents](agents.md) for details.

### Teams

Define agent teams. See [Teams](teams.md) for details.

### Monitoring

```json
{
  "monitoring": {
    "heartbeat_interval": 3600
  }
}
```

| Property | Description |
|----------|-------------|
| `heartbeat_interval` | Health check interval in seconds (0 to disable) |

#### Heartbeat Mechanism

The heartbeat periodically sends a status check message to all agents to keep them active and responsive.

**Default behavior:**
- Interval: 3600 seconds (1 hour)
- Message: `"@{agentId} Quick status check: Any pending tasks? Keep response brief."`
- Sent to all configured agents

**Custom heartbeat prompt:**

Create a `heartbeat.md` file in the agent's working directory to customize the message:

```
{workspace}/{agentId}/heartbeat.md
```

Example `heartbeat.md`:
```markdown
Check for any incomplete tasks, review your todo list, and report status. Keep it brief.
```

**Configuration examples:**

```json
// Default: heartbeat every hour
{
  "monitoring": { "heartbeat_interval": 3600 }
}

// Frequent: every 5 minutes
{
  "monitoring": { "heartbeat_interval": 300 }
}

// Disabled
{
  "monitoring": { "heartbeat_interval": 0 }
}
```

**Use cases:**
- Keep agents "warm" and responsive
- Trigger periodic self-checks or maintenance tasks
- Monitor agent availability
- Schedule recurring agent operations

## Environment Variables

You can use environment variables for sensitive values:

```bash
# Windows
set TINYLAW_DISCORD_TOKEN=your_token
set TINYLAW_TELEGRAM_TOKEN=your_token

# PowerShell
$env:TINYLAW_DISCORD_TOKEN="your_token"
```

## Proxy Configuration

For environments behind corporate firewalls:

### HTTP Proxy
```json
{
  "telegram": {
    "proxy_url": "http://proxy.company.com:8080"
  }
}
```

### Authenticated Proxy
```json
{
  "telegram": {
    "proxy_url": "http://user:password@proxy.company.com:8080"
  }
}
```

### SOCKS5 Proxy
```json
{
  "telegram": {
    "proxy_url": "socks5://proxy.company.com:1080"
  }
}
```

## Configuration via WPF UI

The WPF application provides a graphical interface for common settings:

1. Launch `TinyClaw.App.exe`
2. Navigate to **Settings** page
3. Configure:
   - Channel tokens (Discord, Telegram)
   - Workspace path
   - Default AI provider and model
   - Heartbeat interval
   - Telegram proxy URL
4. Click **Save Settings**

## Configuration via CLI

```bash
# Set Discord token
TinyClaw.Cli.exe config set channels.discord.bot_token YOUR_TOKEN

# Set Telegram token
TinyClaw.Cli.exe config set channels.telegram.bot_token YOUR_TOKEN

# Set proxy
TinyClaw.Cli.exe config set channels.telegram.proxy_url http://proxy:8080

# View current config
TinyClaw.Cli.exe config get
```
