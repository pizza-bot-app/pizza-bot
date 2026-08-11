# Status payload

- `generatedAt`: ISO 8601 time when the snapshot was produced.
- `query`: requested server name, or `*` for all servers.
- `servers`: matching servers with status, tool count, and last error.
- `summary`: totals grouped by connection status.
