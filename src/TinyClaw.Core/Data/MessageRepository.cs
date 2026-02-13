namespace TinyClaw.Core.Data;

using Microsoft.Data.Sqlite;
using TinyClaw.Core.Models;

public class MessageRepository
{
    private readonly TinyClawDb _db;

    public MessageRepository(TinyClawDb db) => _db = db;

    public long Enqueue(QueueMessage message)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO messages (status, channel, sender, sender_id, agent_id, content, files_in, message_id, max_retries, created_at)
            VALUES (@status, @channel, @sender, @senderId, @agentId, @content, @filesIn, @messageId, @maxRetries, @createdAt)
            RETURNING id;
            """;
        cmd.Parameters.AddWithValue("@status", message.Status.ToString());
        cmd.Parameters.AddWithValue("@channel", message.Channel);
        cmd.Parameters.AddWithValue("@sender", message.Sender);
        cmd.Parameters.AddWithValue("@senderId", (object?)message.SenderId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@agentId", (object?)message.AgentId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@content", message.Content);
        cmd.Parameters.AddWithValue("@filesIn", (object?)message.FilesIn ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@messageId", message.MessageId);
        cmd.Parameters.AddWithValue("@maxRetries", message.MaxRetries);
        cmd.Parameters.AddWithValue("@createdAt", message.CreatedAt.ToString("yyyy-MM-dd HH:mm:ss"));

        return (long)cmd.ExecuteScalar()!;
    }

    public QueueMessage? Dequeue(string? agentId = null)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE messages
            SET status = 'Processing', started_at = datetime('now')
            WHERE id = (
                SELECT id FROM messages
                WHERE status = 'Pending' AND (@agentId IS NULL OR agent_id = @agentId)
                ORDER BY id
                LIMIT 1
            )
            RETURNING *;
            """;
        cmd.Parameters.AddWithValue("@agentId", (object?)agentId ?? DBNull.Value);

        using var reader = cmd.ExecuteReader();
        return reader.Read() ? ReadMessage(reader) : null;
    }

    public void Complete(long id, string response, string? filesOut = null)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE messages
            SET status = 'Completed', response = @response, files_out = @filesOut, completed_at = datetime('now')
            WHERE id = @id;
            """;
        cmd.Parameters.AddWithValue("@id", id);
        cmd.Parameters.AddWithValue("@response", response);
        cmd.Parameters.AddWithValue("@filesOut", (object?)filesOut ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    public void Fail(long id, string error)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE messages
            SET retry_count = retry_count + 1,
                error = @error,
                status = CASE WHEN retry_count + 1 < max_retries THEN 'Pending' ELSE 'Failed' END,
                started_at = NULL
            WHERE id = @id;
            """;
        cmd.Parameters.AddWithValue("@id", id);
        cmd.Parameters.AddWithValue("@error", error);
        cmd.ExecuteNonQuery();
    }

    public List<QueueMessage> GetCompleted(string channel)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT * FROM messages
            WHERE status = 'Completed' AND channel = @channel
            ORDER BY id;
            """;
        cmd.Parameters.AddWithValue("@channel", channel);
        return ReadMessages(cmd);
    }

    public void Archive(long id)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "UPDATE messages SET status = 'Archived' WHERE id = @id;";
        cmd.Parameters.AddWithValue("@id", id);
        cmd.ExecuteNonQuery();
    }

    public int RecoverStale(TimeSpan timeout)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE messages
            SET status = 'Pending', started_at = NULL
            WHERE status = 'Processing'
              AND started_at < @threshold
              AND retry_count < max_retries;
            """;
        cmd.Parameters.AddWithValue("@threshold", (DateTime.UtcNow - timeout).ToString("yyyy-MM-dd HH:mm:ss"));
        return cmd.ExecuteNonQuery();
    }

    public List<QueueMessage> GetRecent(int limit = 50)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM messages ORDER BY created_at DESC LIMIT @limit;";
        cmd.Parameters.AddWithValue("@limit", limit);
        return ReadMessages(cmd);
    }

    public List<QueueMessage> GetByStatus(MessageStatus status, int limit = 100)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM messages WHERE status = @status ORDER BY id DESC LIMIT @limit;";
        cmd.Parameters.AddWithValue("@status", status.ToString());
        cmd.Parameters.AddWithValue("@limit", limit);
        return ReadMessages(cmd);
    }

    public Dictionary<MessageStatus, int> GetStatusCounts()
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT status, COUNT(*) as cnt FROM messages GROUP BY status;";

        var counts = new Dictionary<MessageStatus, int>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            if (Enum.TryParse<MessageStatus>(reader.GetString(0), out var status))
                counts[status] = reader.GetInt32(1);
        }
        return counts;
    }

    public int GetTodayCount()
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM messages WHERE date(created_at) = date('now');";
        return Convert.ToInt32(cmd.ExecuteScalar());
    }

    public List<QueueMessage> GetAll(string? channelFilter = null, MessageStatus? statusFilter = null, int limit = 500)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();

        var where = new List<string>();
        if (channelFilter != null)
        {
            where.Add("channel = @channel");
            cmd.Parameters.AddWithValue("@channel", channelFilter);
        }
        if (statusFilter != null)
        {
            where.Add("status = @status");
            cmd.Parameters.AddWithValue("@status", statusFilter.ToString());
        }

        var whereClause = where.Count > 0 ? "WHERE " + string.Join(" AND ", where) : "";
        cmd.CommandText = $"SELECT * FROM messages {whereClause} ORDER BY created_at DESC LIMIT @limit;";
        cmd.Parameters.AddWithValue("@limit", limit);
        return ReadMessages(cmd);
    }

    private static List<QueueMessage> ReadMessages(SqliteCommand cmd)
    {
        var messages = new List<QueueMessage>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            messages.Add(ReadMessage(reader));
        return messages;
    }

    private static QueueMessage ReadMessage(SqliteDataReader reader)
    {
        return new QueueMessage
        {
            Id = reader.GetInt64(reader.GetOrdinal("id")),
            Status = Enum.TryParse<MessageStatus>(reader.GetString(reader.GetOrdinal("status")), out var s) ? s : MessageStatus.Pending,
            Channel = reader.GetString(reader.GetOrdinal("channel")),
            Sender = reader.GetString(reader.GetOrdinal("sender")),
            SenderId = reader.IsDBNull(reader.GetOrdinal("sender_id")) ? null : reader.GetString(reader.GetOrdinal("sender_id")),
            AgentId = reader.IsDBNull(reader.GetOrdinal("agent_id")) ? null : reader.GetString(reader.GetOrdinal("agent_id")),
            Content = reader.GetString(reader.GetOrdinal("content")),
            Response = reader.IsDBNull(reader.GetOrdinal("response")) ? null : reader.GetString(reader.GetOrdinal("response")),
            FilesIn = reader.IsDBNull(reader.GetOrdinal("files_in")) ? null : reader.GetString(reader.GetOrdinal("files_in")),
            FilesOut = reader.IsDBNull(reader.GetOrdinal("files_out")) ? null : reader.GetString(reader.GetOrdinal("files_out")),
            MessageId = reader.GetString(reader.GetOrdinal("message_id")),
            RetryCount = reader.GetInt32(reader.GetOrdinal("retry_count")),
            MaxRetries = reader.GetInt32(reader.GetOrdinal("max_retries")),
            Error = reader.IsDBNull(reader.GetOrdinal("error")) ? null : reader.GetString(reader.GetOrdinal("error")),
            CreatedAt = DateTime.Parse(reader.GetString(reader.GetOrdinal("created_at"))).ToUniversalTime(),
            StartedAt = reader.IsDBNull(reader.GetOrdinal("started_at")) ? null : DateTime.Parse(reader.GetString(reader.GetOrdinal("started_at"))).ToUniversalTime(),
            CompletedAt = reader.IsDBNull(reader.GetOrdinal("completed_at")) ? null : DateTime.Parse(reader.GetString(reader.GetOrdinal("completed_at"))).ToUniversalTime(),
        };
    }
}
