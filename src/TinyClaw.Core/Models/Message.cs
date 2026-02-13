namespace TinyClaw.Core.Models;

public enum MessageStatus
{
    Pending,
    Processing,
    Completed,
    Archived,
    Failed
}

public class QueueMessage
{
    public long Id { get; set; }
    public MessageStatus Status { get; set; } = MessageStatus.Pending;
    public required string Channel { get; set; }
    public required string Sender { get; set; }
    public string? SenderId { get; set; }
    public string? AgentId { get; set; }
    public required string Content { get; set; }
    public string? Response { get; set; }
    public string? FilesIn { get; set; }
    public string? FilesOut { get; set; }
    public required string MessageId { get; set; }
    public int RetryCount { get; set; }
    public int MaxRetries { get; set; } = 3;
    public string? Error { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
}
