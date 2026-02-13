# Deployment

This guide covers installing and running TinyClaw in various configurations.

## Prerequisites

- Windows 10/11 or Windows Server 2019+
- .NET 8.0 Runtime
- AI Provider CLI installed:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) for Anthropic
  - [Codex CLI](https://github.com/openai/codex) for OpenAI

## Installation Methods

### Method 1: Windows Service (Recommended for Production)

1. **Build the solution**:
   ```powershell
   dotnet publish src/TinyClaw.Service -c Release -o C:\TinyClaw
   dotnet publish src/TinyClaw.App -c Release -o C:\TinyClaw\UI
   ```

2. **Install as Windows Service**:
   ```powershell
   sc create TinyClaw binPath= "C:\TinyClaw\TinyClaw.Service.exe" start= auto
   sc start TinyClaw
   ```

3. **Configure**:
   - Run `C:\TinyClaw\UI\TinyClaw.App.exe`
   - Go to Settings
   - Add bot tokens and configure agents
   - Save settings

4. **Restart service**:
   ```powershell
   sc stop TinyClaw
   sc start TinyClaw
   ```

### Method 2: Standalone Application

Run the service as a console application:

```powershell
cd src/TinyClaw.Service
dotnet run
```

Or use the published executable:

```powershell
.\TinyClaw.Service.exe
```

### Method 3: Docker (Planned)

```dockerfile
FROM mcr.microsoft.com/dotnet/runtime:8.0
COPY bin/Release/net8.0/publish/ /app
WORKDIR /app
ENTRYPOINT ["dotnet", "TinyClaw.Service.dll"]
```

## File Locations

### Configuration Directory
`C:\ProgramData\TinyClaw\`

| File/Directory | Purpose |
|----------------|---------|
| `settings.json` | Main configuration file |
| `tinyclaw.db` | SQLite message queue database |
| `files\` | Downloaded attachments |
| `logs\` | Application logs |

### Application Directory
Default installation: `C:\TinyClaw\`

```
C:\TinyClaw\
├── TinyClaw.Service.exe    # Windows Service executable
├── TinyClaw.Core.dll       # Shared library
├── TinyClaw.App.exe        # WPF UI (in UI\ subfolder)
└── ...
```

## Configuration

### Initial Setup

1. **Create workspace directory**:
   ```powershell
   mkdir C:\TinyClawWorkspace
   ```

2. **Configure via UI**:
   - Run `TinyClaw.App.exe` as Administrator (first time only)
   - Set workspace path
   - Add bot tokens
   - Configure agents

3. **Or configure via settings.json**:
   ```json
   {
     "workspace": {
       "path": "C:\\TinyClawWorkspace"
     },
     "channels": {
       "telegram": {
         "bot_token": "YOUR_TOKEN"
       }
     },
     "models": {
       "provider": "anthropic",
       "anthropic": {
         "model": "sonnet"
       }
     }
   }
   ```

## Service Management

### Using sc.exe

```powershell
# Create service
sc create TinyClaw binPath= "C:\TinyClaw\TinyClaw.Service.exe" start= auto

# Start service
sc start TinyClaw

# Stop service
sc stop TinyClaw

# Delete service
sc delete TinyClaw
```

### Using PowerShell

```powershell
# Create service
New-Service -Name "TinyClaw" -BinaryPathName "C:\TinyClaw\TinyClaw.Service.exe" -StartupType Automatic

# Start service
Start-Service -Name "TinyClaw"

# Stop service
Stop-Service -Name "TinyClaw"

# Remove service
Remove-Service -Name "TinyClaw"
```

### Using Services.msc

1. Press `Win + R`, type `services.msc`
2. Find "TinyClaw" in the list
3. Right-click for Start/Stop/Restart options

## Permissions

### Service Account

By default, the service runs as `LocalSystem`. To use a specific account:

```powershell
sc config TinyClaw obj= "DOMAIN\Username" password= "Password"
```

### Required Permissions

| Resource | Permission |
|----------|------------|
| `C:\ProgramData\TinyClaw\` | Full Control |
| `C:\TinyClawWorkspace\` | Full Control |
| AI CLI tools (claude, codex) | Execute |

## Logging

Logs are stored in `C:\ProgramData\TinyClaw\logs\`

View logs:
```powershell
Get-Content "C:\ProgramData\TinyClaw\logs\tinyclaw.log" -Tail 50
```

Or use the WPF UI Logs page.

## Updating

1. **Stop the service**:
   ```powershell
   sc stop TinyClaw
   ```

2. **Backup configuration**:
   ```powershell
   Copy-Item "C:\ProgramData\TinyClaw\settings.json" "C:\ProgramData\TinyClaw\settings.json.bak"
   ```

3. **Replace binaries**:
   ```powershell
   dotnet publish src/TinyClaw.Service -c Release -o C:\TinyClaw
   ```

4. **Start the service**:
   ```powershell
   sc start TinyClaw
   ```

## Troubleshooting

### Service won't start

Check Event Viewer:
```powershell
Get-EventLog -LogName Application -Source "TinyClaw" -Newest 10
```

Common issues:
- Missing .NET 8.0 runtime
- Incorrect path in service configuration
- Missing permissions to config directory

### UI can't save settings

Run as Administrator:
```powershell
Start-Process "C:\TinyClaw\UI\TinyClaw.App.exe" -Verb RunAs
```

### Agents not responding

1. Check AI CLI is installed:
   ```powershell
   claude --version
   codex --version
   ```

2. Check service logs for errors

3. Verify working directories exist and have correct permissions

## Security Best Practices

1. **Use a dedicated service account** instead of LocalSystem
2. **Restrict config directory permissions** to service account only
3. **Use environment variables** for sensitive tokens in CI/CD
4. **Keep AI CLI tools updated** for security patches
5. **Enable Windows Firewall** and restrict access to necessary ports

## Uninstallation

1. Stop and remove service:
   ```powershell
   sc stop TinyClaw
   sc delete TinyClaw
   ```

2. Remove application files:
   ```powershell
   Remove-Item -Recurse "C:\TinyClaw"
   ```

3. Optionally remove data:
   ```powershell
   Remove-Item -Recurse "C:\ProgramData\TinyClaw"
   ```
