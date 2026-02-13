namespace TinyClaw.App;

using System.Windows;
using TinyClaw.Core.Configuration;
using TinyClaw.Core.Data;

public partial class App : Application
{
    public static ConfigManager Config { get; private set; } = null!;
    public static TinyClawDb Db { get; private set; } = null!;
    public static MessageRepository Messages { get; private set; } = null!;
    public static LogRepository Logs { get; private set; } = null!;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        Config = new ConfigManager();
        Db = new TinyClawDb(Config.DbPath);
        Messages = new MessageRepository(Db);
        Logs = new LogRepository(Db);

        MainWindow = new MainWindow();
        MainWindow.Show();
    }
}
