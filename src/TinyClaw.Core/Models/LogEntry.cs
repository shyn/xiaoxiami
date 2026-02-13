namespace TinyClaw.Core.Models;

public class LogEntry
{
    public long Id { get; set; }
    public string Level { get; set; } = "INFO";
    public string Message { get; set; } = string.Empty;
    public string? Source { get; set; }
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
}
