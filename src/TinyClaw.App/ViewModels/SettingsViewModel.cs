namespace TinyClaw.App.ViewModels;

using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using TinyClaw.Core.Models;

public partial class SettingsViewModel : ObservableObject
{
    [ObservableProperty] private string _discordToken = string.Empty;
    [ObservableProperty] private string _telegramToken = string.Empty;
    [ObservableProperty] private string _telegramProxyUrl = string.Empty;
    [ObservableProperty] private string _workspacePath = string.Empty;
    [ObservableProperty] private int _heartbeatInterval = 3600;
    [ObservableProperty] private bool _isAnthropic = true;
    [ObservableProperty] private bool _isOpenAi;
    [ObservableProperty] private string _defaultModel = "sonnet";
    [ObservableProperty] private bool _isDarkTheme = true;

    public void Load()
    {
        var settings = App.Config.LoadSettings();

        DiscordToken = settings.Channels?.Discord?.BotToken ?? string.Empty;
        TelegramToken = settings.Channels?.Telegram?.BotToken ?? string.Empty;
        TelegramProxyUrl = settings.Channels?.Telegram?.ProxyUrl ?? string.Empty;
        WorkspacePath = settings.Workspace?.Path ?? string.Empty;
        HeartbeatInterval = settings.Monitoring?.HeartbeatInterval ?? 3600;

        var provider = settings.Models?.Provider ?? "anthropic";
        IsAnthropic = provider == "anthropic";
        IsOpenAi = provider == "openai";

        DefaultModel = IsOpenAi
            ? settings.Models?.OpenAi?.Model ?? "gpt-5.3-codex"
            : settings.Models?.Anthropic?.Model ?? "sonnet";

        IsDarkTheme = true;
    }

    [RelayCommand]
    public void Save()
    {
        var settings = App.Config.LoadSettings();

        // Records are immutable — rebuild with updated values
        var newSettings = settings with
        {
            Channels = new ChannelsConfig
            {
                Enabled = settings.Channels?.Enabled,
                Discord = new DiscordConfig
                {
                    BotToken = string.IsNullOrWhiteSpace(DiscordToken) ? null : DiscordToken
                },
                Telegram = new TelegramConfig
                {
                    BotToken = string.IsNullOrWhiteSpace(TelegramToken) ? null : TelegramToken,
                    ProxyUrl = string.IsNullOrWhiteSpace(TelegramProxyUrl) ? null : TelegramProxyUrl
                }
            },
            Workspace = new WorkspaceConfig
            {
                Path = string.IsNullOrWhiteSpace(WorkspacePath) ? null : WorkspacePath,
                Name = settings.Workspace?.Name
            },
            Monitoring = new MonitoringConfig
            {
                HeartbeatInterval = HeartbeatInterval
            },
            Models = new ModelsConfig
            {
                Provider = IsOpenAi ? "openai" : "anthropic",
                Anthropic = IsAnthropic
                    ? new AnthropicConfig { Model = DefaultModel }
                    : settings.Models?.Anthropic,
                OpenAi = IsOpenAi
                    ? new OpenAiConfig { Model = DefaultModel }
                    : settings.Models?.OpenAi
            }
        };

        App.Config.SaveSettings(newSettings);
    }
}
