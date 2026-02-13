namespace TinyClaw.App.ViewModels;

using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using System.Collections.ObjectModel;
using TinyClaw.Core.Models;

public partial class MessagesViewModel : ObservableObject
{
    [ObservableProperty] private string? _channelFilter;
    [ObservableProperty] private string? _statusFilter;

    public ObservableCollection<QueueMessage> Messages { get; } = new();
    public List<string> Channels { get; } = new() { "", "discord", "telegram", "whatsapp", "heartbeat" };
    public List<string> Statuses { get; } = new() { "", "Pending", "Processing", "Completed", "Failed" };

    [RelayCommand]
    public void Refresh()
    {
        var channel = string.IsNullOrEmpty(ChannelFilter) ? null : ChannelFilter;
        MessageStatus? status = null;
        if (!string.IsNullOrEmpty(StatusFilter) && Enum.TryParse<MessageStatus>(StatusFilter, out var s))
            status = s;

        var msgs = App.Messages.GetAll(channel, status);
        Messages.Clear();
        foreach (var msg in msgs)
            Messages.Add(msg);
    }
}
