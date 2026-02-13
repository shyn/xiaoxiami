namespace TinyClaw.App.Views;

using System.Windows.Threading;
using TinyClaw.App.ViewModels;
using System.Windows.Controls;

public partial class LogsPage : Page
{
    private readonly LogsViewModel _vm = new();
    private readonly DispatcherTimer _timer;

    public LogsPage()
    {
        InitializeComponent();
        DataContext = _vm;

        _vm.Refresh();
        ScrollToBottom();

        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _timer.Tick += (_, _) =>
        {
            _vm.Refresh();
            ScrollToBottom();
        };
        _timer.Start();
    }

    private void OnFilterChanged(object sender, System.Windows.RoutedEventArgs e) => _vm.Refresh();

    private void OnRefreshClick(object sender, System.Windows.RoutedEventArgs e)
    {
        _vm.Refresh();
        ScrollToBottom();
    }

    private void ScrollToBottom()
    {
        if (LogList.Items.Count > 0)
            LogList.ScrollIntoView(LogList.Items[^1]);
    }
}
