namespace TinyClaw.App.Services;

using System.Windows;
using Wpf.Ui;

public class PageService : IPageService
{
    public T? GetPage<T>() where T : class => Activator.CreateInstance<T>();
    public FrameworkElement? GetPage(Type pageType) => Activator.CreateInstance(pageType) as FrameworkElement;
}
