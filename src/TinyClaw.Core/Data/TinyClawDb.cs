using Microsoft.Data.Sqlite;

namespace TinyClaw.Core.Data;

public class TinyClawDb : IDisposable
{
    private readonly string _connectionString;

    public TinyClawDb(string dbPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);
        _connectionString = $"Data Source={dbPath}";
        InitializeSchema();
    }

    public SqliteConnection CreateConnection()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
        return conn;
    }

    private void InitializeSchema()
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel TEXT NOT NULL,
                sender TEXT NOT NULL,
                sender_id TEXT,
                content TEXT NOT NULL,
                agent_id TEXT,
                status TEXT NOT NULL DEFAULT 'Pending',
                response TEXT,
                files_in TEXT,
                files_out TEXT,
                message_id TEXT NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0,
                max_retries INTEGER NOT NULL DEFAULT 3,
                error TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
            CREATE INDEX IF NOT EXISTS idx_messages_channel_status ON messages(channel, status);
            CREATE INDEX IF NOT EXISTS idx_messages_agent_status ON messages(agent_id, status);

            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                level TEXT NOT NULL,
                message TEXT NOT NULL,
                source TEXT,
                timestamp INTEGER NOT NULL
            );
            """;
        cmd.ExecuteNonQuery();
    }

    public void Dispose()
    {
        // Connection pooling handles cleanup
    }
}
