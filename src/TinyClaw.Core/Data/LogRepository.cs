namespace TinyClaw.Core.Data;

using Microsoft.Data.Sqlite;
using TinyClaw.Core.Models;

public class LogRepository
{
    private readonly TinyClawDb _db;

    public LogRepository(TinyClawDb db)
    {
        _db = db;
    }

    public void Write(string level, string message, string? source = null)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO logs (level, message, source, timestamp)
            VALUES (@level, @message, @source, @timestamp)
            """;
        cmd.Parameters.AddWithValue("@level", level);
        cmd.Parameters.AddWithValue("@message", message);
        cmd.Parameters.AddWithValue("@source", (object?)source ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@timestamp", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        cmd.ExecuteNonQuery();
    }

    public List<LogEntry> GetRecent(int limit = 100)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT id, level, message, source, timestamp FROM logs ORDER BY timestamp DESC LIMIT @limit;";
        cmd.Parameters.AddWithValue("@limit", limit);
        return ReadLogs(cmd);
    }

    public List<LogEntry> GetByLevels(IEnumerable<string> levels, int limit = 200)
    {
        using var conn = _db.CreateConnection();
        using var cmd = conn.CreateCommand();

        var levelList = levels.ToList();
        var placeholders = string.Join(",", levelList.Select((_, i) => $"@l{i}"));
        cmd.CommandText = $"SELECT id, level, message, source, timestamp FROM logs WHERE level IN ({placeholders}) ORDER BY timestamp DESC LIMIT @limit;";

        for (int i = 0; i < levelList.Count; i++)
            cmd.Parameters.AddWithValue($"@l{i}", levelList[i]);
        cmd.Parameters.AddWithValue("@limit", limit);

        return ReadLogs(cmd);
    }

    public void SyncFromFile(string logFilePath)
    {
        if (!File.Exists(logFilePath)) return;

        using var conn = _db.CreateConnection();

        // Get last known timestamp
        using var maxCmd = conn.CreateCommand();
        maxCmd.CommandText = "SELECT MAX(timestamp) FROM logs";
        var lastTs = maxCmd.ExecuteScalar();
        long lastTimestamp = lastTs is long l ? l : 0;

        var lines = File.ReadAllLines(logFilePath);
        foreach (var line in lines)
        {
            var match = System.Text.RegularExpressions.Regex.Match(
                line, @"^\[(.+?)\]\s+\[(\w+)\]\s+(.+)$");
            if (!match.Success) continue;

            if (DateTimeOffset.TryParse(match.Groups[1].Value, out var dto))
            {
                var ts = dto.ToUnixTimeMilliseconds();
                if (ts <= lastTimestamp) continue;

                using var cmd = conn.CreateCommand();
                cmd.CommandText = "INSERT INTO logs (level, message, source, timestamp) VALUES (@level, @message, @source, @timestamp)";
                cmd.Parameters.AddWithValue("@level", match.Groups[2].Value);
                cmd.Parameters.AddWithValue("@message", match.Groups[3].Value);
                cmd.Parameters.AddWithValue("@source", "file-sync");
                cmd.Parameters.AddWithValue("@timestamp", ts);
                cmd.ExecuteNonQuery();
            }
        }
    }

    private static List<LogEntry> ReadLogs(SqliteCommand cmd)
    {
        var list = new List<LogEntry>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            list.Add(new LogEntry
            {
                Id = reader.GetInt64(0),
                Level = reader.GetString(1),
                Message = reader.GetString(2),
                Source = reader.IsDBNull(3) ? null : reader.GetString(3),
                Timestamp = DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(4)).UtcDateTime
            });
        }
        return list;
    }
}
