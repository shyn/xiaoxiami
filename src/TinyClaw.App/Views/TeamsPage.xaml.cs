namespace TinyClaw.App.Views;

using TinyClaw.App.ViewModels;
using System.Windows.Controls;

public partial class TeamsPage : Page
{
    private readonly TeamsViewModel _vm = new();

    public TeamsPage()
    {
        InitializeComponent();
        DataContext = _vm;
        _vm.Refresh();
    }

    private void OnRefreshClick(object sender, System.Windows.RoutedEventArgs e) => _vm.Refresh();
}
