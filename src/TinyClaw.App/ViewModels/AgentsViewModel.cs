namespace TinyClaw.App.ViewModels;

using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using System.Collections.ObjectModel;

public partial class AgentDisplayItem : ObservableObject
{
    [ObservableProperty] private string _id = string.Empty;
    [ObservableProperty] private string _name = string.Empty;
    [ObservableProperty] private string _provider = string.Empty;
    [ObservableProperty] private string _model = string.Empty;
    [ObservableProperty] private string _workingDirectory = string.Empty;
}

public partial class AgentsViewModel : ObservableObject
{
    public ObservableCollection<AgentDisplayItem> Agents { get; } = new();

    [RelayCommand]
    public void Refresh()
    {
        var settings = App.Config.LoadSettings();
        var agents = App.Config.GetAgents(settings);
        Agents.Clear();
        foreach (var (id, config) in agents)
        {
            Agents.Add(new AgentDisplayItem
            {
                Id = id,
                Name = config.Name,
                Provider = config.Provider,
                Model = config.Model,
                WorkingDirectory = config.WorkingDirectory
            });
        }
    }
}
