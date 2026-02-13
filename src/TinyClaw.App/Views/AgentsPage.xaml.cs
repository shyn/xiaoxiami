namespace TinyClaw.App.Views;

using TinyClaw.App.ViewModels;
using System.Windows.Controls;

public partial class AgentsPage : Page
{
    private readonly AgentsViewModel _vm = new();

    public AgentsPage()
    {
        InitializeComponent();
        DataContext = _vm;
        _vm.Refresh();
    }

    private void OnRefreshClick(object sender, System.Windows.RoutedEventArgs e) => _vm.Refresh();
}
