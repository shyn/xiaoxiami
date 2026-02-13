namespace TinyClaw.App;

using TinyClaw.App.Services;
using Wpf.Ui.Controls;

public partial class MainWindow : FluentWindow
{
    public MainWindow()
    {
        InitializeComponent();
        NavigationView.SetPageService(new PageService());
        NavigationView.Loaded += (_, _) =>
        {
            NavigationView.Navigate(typeof(Views.DashboardPage));
        };
    }
}
