using TinyClaw.Core.Configuration;
using TinyClaw.Core.Data;
using TinyClaw.Core.Services;
using TinyClaw.Service.Workers;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "TinyClaw";
});

// Register core services
builder.Services.AddSingleton<ConfigManager>();
builder.Services.AddSingleton(sp =>
{
    var config = sp.GetRequiredService<ConfigManager>();
    return new TinyClawDb(config.DbPath);
});
builder.Services.AddSingleton<MessageRepository>();
builder.Services.AddSingleton<LogRepository>();
builder.Services.AddSingleton<MessageRouter>();
builder.Services.AddSingleton<AgentInvoker>();

// Register workers
builder.Services.AddHostedService<QueueProcessorWorker>();
builder.Services.AddHostedService<HeartbeatWorker>();
builder.Services.AddHostedService<DiscordChannelWorker>();
builder.Services.AddHostedService<TelegramChannelWorker>();
builder.Services.AddHostedService<IpcServer>();

var host = builder.Build();

// Recover stale messages on startup
var msgRepo = host.Services.GetRequiredService<MessageRepository>();
var recovered = msgRepo.RecoverStale(TimeSpan.FromMinutes(10));
if (recovered > 0)
{
    var logger = host.Services.GetRequiredService<ILogger<Program>>();
    logger.LogWarning("Recovered {Count} stale messages from previous crash", recovered);
}

host.Run();
