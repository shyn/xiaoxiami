namespace TinyClaw.App.Views;

using System.Windows.Controls;
using TinyClaw.App.ViewModels;

public partial class MessagesPage : Page
{
    private readonly MessagesViewModel _vm = new();

    public MessagesPage()
    {
        InitializeComponent();
        DataContext = _vm;
        _vm.Refresh();
    }

    private void OnFilterChanged(object sender, SelectionChangedEventArgs e) => _vm.Refresh();

    private void OnRefreshClick(object sender, System.Windows.RoutedEventArgs e) => _vm.Refresh();
}
