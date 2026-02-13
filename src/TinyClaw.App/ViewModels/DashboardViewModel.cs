namespace TinyClaw.App.ViewModels;

using System.IO;

using CommunityToolkit.Mvvm.ComponentModel;
using System.Collections.ObjectModel;
using TinyClaw.Core.Models;

public partial class DashboardViewModel : ObservableObject
{
    [ObservableProperty] private string _serviceStatus = "Unknown";
    [ObservableProperty] private string _serviceStatusColor = "Gray";
    [ObservableProperty] private int _messagesToday;
    [ObservableProperty] private int _activeAgents;
    [ObservableProperty] private int _pendingCount;
    [ObservableProperty] private string _discordStatusColor = "Gray";
    [ObservableProperty] private string _telegramStatusColor = "Gray";
    [ObservableProperty] private string _whatsAppStatusColor = "Gray";

    public ObservableCollection<QueueMessage> RecentMessages { get; } = new();

    public void Refresh()
    {
        try
        {
            var counts = App.Messages.GetStatusCounts();
            PendingCount = counts.GetValueOrDefault(MessageStatus.Pending);
            MessagesToday = App.Messages.GetTodayCount();

            var settings = App.Config.LoadSettings();
            var agents = App.Config.GetAgents(settings);
            ActiveAgents = agents.Count;

            var recent = App.Messages.GetRecent(10);
            RecentMessages.Clear();
            foreach (var msg in recent)
                RecentMessages.Add(msg);

            // Check service status via config directory existence
            ServiceStatus = Directory.Exists(App.Config.ConfigDir) ? "Running" : "Stopped";
            ServiceStatusColor = ServiceStatus == "Running" ? "LimeGreen" : "Tomato";

            // Channel status from settings
            var enabled = settings.Channels?.Enabled ?? new List<string>();

            DiscordStatusColor = enabled.Contains("discord") && !string.IsNullOrEmpty(settings.Channels?.Discord?.BotToken)
                ? "LimeGreen" : "Gray";
            TelegramStatusColor = enabled.Contains("telegram") && !string.IsNullOrEmpty(settings.Channels?.Telegram?.BotToken)
                ? "LimeGreen" : "Gray";
            WhatsAppStatusColor = enabled.Contains("whatsapp")
                ? "LimeGreen" : "Gray";
        }
        catch
        {
            ServiceStatus = "Error";
            ServiceStatusColor = "Tomato";
        }
    }
}
