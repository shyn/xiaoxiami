namespace TinyClaw.App.ViewModels;

using System.IO;

using CommunityToolkit.Mvvm.ComponentModel;
using System.Collections.ObjectModel;
using TinyClaw.Core.Models;

public partial class LogsViewModel : ObservableObject
{
    [ObservableProperty] private bool _showInfo = true;
    [ObservableProperty] private bool _showWarn = true;
    [ObservableProperty] private bool _showError = true;

    public ObservableCollection<LogEntry> Logs { get; } = new();

    public void Refresh()
    {
        var levels = new List<string>();
        if (ShowInfo) levels.Add("INFO");
        if (ShowWarn) levels.Add("WARN");
        if (ShowError) levels.Add("ERROR");

        if (levels.Count == 0)
        {
            Logs.Clear();
            return;
        }

        // Sync from log file first
        try
        {
            var logFile = Path.Combine(App.Config.LogsDir, "queue.log");
            App.Logs.SyncFromFile(logFile);
        }
        catch { }

        var entries = App.Logs.GetByLevels(levels, 200);
        Logs.Clear();
        // Reverse to show oldest first (chronological order)
        for (int i = entries.Count - 1; i >= 0; i--)
            Logs.Add(entries[i]);
    }
}
