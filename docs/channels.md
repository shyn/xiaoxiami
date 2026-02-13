# Channels

Channels are the communication interfaces that connect TinyClaw to external messaging platforms.

## Supported Channels

| Channel | Status | Features |
|---------|--------|----------|
| Discord | ✅ Ready | Text, files, DMs |
| Telegram | ✅ Ready | Text, files, photos, voice |
| Slack | 🚧 Planned | - |
| Web API | 🚧 Planned | REST API endpoint |

## Discord

### Setup

1. Create a Discord application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a Bot user
3. Copy the Bot Token
4. Add the bot to your server with appropriate permissions

### Configuration

```json
{
  "channels": {
    "discord": {
      "bot_token": "YOUR_BOT_TOKEN"
    }
  }
}
```

### Permissions Required

- Send Messages
- Read Message History
- Attach Files
- Embed Links
- Add Reactions (optional)

### Usage

The bot responds to:
- **Direct Messages**: Any DM to the bot
- **Mentions**: Messages that @mention the bot in servers
- **Commands**: `!agent`, `!team`, `!reset`

Example:
```
@TinyClawBot @backend Create an API endpoint for user authentication
```

## Telegram

### Setup

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Create a new bot with `/newbot`
3. Copy the API token provided

### Configuration

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

### Proxy Support

For environments behind firewalls:

```json
{
  "telegram": {
    "bot_token": "YOUR_TOKEN",
    "proxy_url": "http://proxy.company.com:8080"
  }
}
```

### Supported Media Types

Telegram channel supports various media attachments:

| Type | Extension | Notes |
|------|-----------|-------|
| Photos | `.jpg`, `.png` | Automatically downloaded |
| Documents | Any | Original filename preserved |
| Audio | `.mp3`, `.ogg` | Music files |
| Voice | `.ogg` | Voice messages |
| Video | `.mp4` | Video files |
| Stickers | `.webp`, `.tgs` | Static and animated |

### Usage

Start a private chat with your bot and send messages:

```
@frontend Create a responsive navigation bar
```

Commands:
- `/agent` or `!agent` - List agents
- `/team` or `!team` - List teams
- `/reset` or `!reset` - Reset conversation

## Channel Commands

All channels support these commands:

| Command | Description |
|---------|-------------|
| `!agent` / `/agent` | List available agents |
| `!team` / `/team` | List available teams |
| `!reset` / `/reset` | Reset conversation context |

## Message Routing

```
Incoming Message
      │
      ▼
┌─────────────┐
│  Parse for  │
│  @agent_id  │
└──────┬──────┘
       │
   ┌───┴───┐
   │       │
   ▼       ▼
@agent  no @agent
   │       │
   ▼       ▼
Specific  Default
 Agent     Agent
```

## File Handling

Files received through channels are:
1. Downloaded to `{config_dir}/files/`
2. Stored with unique filenames
3. Passed to agents as `[file: path]` references
4. Automatically cleaned up after processing

## Security Considerations

1. **Token Storage**: Keep bot tokens secure
   - Don't commit tokens to version control
   - Use environment variables for CI/CD

2. **Permissions**: Grant only necessary permissions

3. **Rate Limiting**: Be aware of API rate limits
   - Discord: 50 requests/second
   - Telegram: 30 messages/second

4. **File Uploads**: Limit file sizes to prevent abuse
   - Currently: No size limit enforced (planned)

## Troubleshooting

### Bot not responding

**Discord:**
- Verify bot token is correct
- Check bot is online in Discord
- Ensure bot has permissions in the channel
- Check if bot was mentioned correctly

**Telegram:**
- Verify bot token is correct
- Start a conversation with `/start`
- Check proxy settings if behind firewall
- Verify webhook is not configured (uses polling)

### Files not downloading
- Check disk space in config directory
- Verify write permissions
- Review logs for download errors

### Rate limiting
- Reduce message frequency
- Implement backoff strategies (planned)

## Adding New Channels

To add a new channel:

1. Create a new worker in `src/TinyClaw.Service/Workers/`
2. Implement `BackgroundService`
3. Add configuration to `ChannelsConfig`
4. Register in `Program.cs`

See existing workers for implementation examples.
