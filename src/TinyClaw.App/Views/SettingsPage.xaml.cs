namespace TinyClaw.App.Views;

using System.Windows;
using Microsoft.Win32;
using TinyClaw.App.ViewModels;
using Wpf.Ui.Appearance;
using System.Windows.Controls;

public partial class SettingsPage : Page
{
    private readonly SettingsViewModel _vm = new();

    public SettingsPage()
    {
        InitializeComponent();
        DataContext = _vm;
        _vm.Load();

        // PasswordBox can't be bound directly
        DiscordPasswordBox.Password = _vm.DiscordToken;
        TelegramPasswordBox.Password = _vm.TelegramToken;
    }

    private void OnDiscordPasswordChanged(object sender, RoutedEventArgs e)
        => _vm.DiscordToken = DiscordPasswordBox.Password;

    private void OnTelegramPasswordChanged(object sender, RoutedEventArgs e)
        => _vm.TelegramToken = TelegramPasswordBox.Password;

    private void OnBrowseClick(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog { Title = "Select Workspace Folder" };
        if (dialog.ShowDialog() == true)
            _vm.WorkspacePath = dialog.FolderName;
    }

    private void OnThemeToggle(object sender, RoutedEventArgs e)
    {
        var theme = _vm.IsDarkTheme
            ? ApplicationTheme.Dark
            : ApplicationTheme.Light;
        ApplicationThemeManager.Apply(theme);
    }

    private void OnSaveClick(object sender, RoutedEventArgs e)
    {
        _vm.Save();
        System.Windows.MessageBox.Show("Settings saved.", "TinyClaw",
            MessageBoxButton.OK, MessageBoxImage.Information);
    }
}
