namespace TinyClaw.App.ViewModels;

using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using System.Collections.ObjectModel;

public partial class TeamDisplayItem : ObservableObject
{
    [ObservableProperty] private string _id = string.Empty;
    [ObservableProperty] private string _name = string.Empty;
    [ObservableProperty] private string _leaderAgent = string.Empty;
    [ObservableProperty] private string _members = string.Empty;
    [ObservableProperty] private int _memberCount;
}

public partial class TeamsViewModel : ObservableObject
{
    public ObservableCollection<TeamDisplayItem> Teams { get; } = new();

    [RelayCommand]
    public void Refresh()
    {
        var settings = App.Config.LoadSettings();
        var teams = App.Config.GetTeams(settings);
        Teams.Clear();
        foreach (var (id, config) in teams)
        {
            Teams.Add(new TeamDisplayItem
            {
                Id = id,
                Name = config.Name,
                LeaderAgent = config.LeaderAgent,
                Members = string.Join(", ", config.Agents),
                MemberCount = config.Agents.Count
            });
        }
    }
}
