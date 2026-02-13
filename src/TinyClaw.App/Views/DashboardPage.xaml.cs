namespace TinyClaw.App.Views;

using System.Windows.Threading;
using TinyClaw.App.ViewModels;
using System.Windows.Controls;

public partial class DashboardPage : Page
{
    private readonly DashboardViewModel _vm = new();
    private readonly DispatcherTimer _timer;

    public DashboardPage()
    {
        InitializeComponent();
        DataContext = _vm;

        _vm.Refresh();

        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _timer.Tick += (_, _) => _vm.Refresh();
        _timer.Start();
    }
}
