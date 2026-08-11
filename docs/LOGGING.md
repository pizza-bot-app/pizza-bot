# Logging

Pizza Bot writes structured, local diagnostic records for the desktop shell, API
server, CLI, browser renderer, agent runs, plugins, and MCP servers.

## Location and retention

Records are newline-delimited JSON under:

```text
<PIZZA_DATA_ROOT>/logs/<process>-<date>-<pid>-<sequence>.ndjson
```

Files rotate at 5 MB. Records are retained for 7 days with a 50 MB total
directory budget. Each process owns a separate file to avoid cross-process
append corruption. Files are created with user-only permissions.

These environment variables adjust the defaults:

- `PIZZA_LOG_LEVEL`: `debug`, `info`, `warn`, or `error`
- `PIZZA_LOG_MAX_FILE_MB`
- `PIZZA_LOG_MAX_TOTAL_MB`
- `PIZZA_LOG_RETENTION_DAYS`

## Viewing logs

Open **Logs** from the utility rail, status bar, or mobile **More** menu. The
view supports live follow, search, level/process/component filters, expandable
structured details, filtered NDJSON download, and confirmed deletion of all log
files from disk.

Desktop reads the files through a sandboxed preload bridge, so diagnostics stay
available if the API sidecar fails. Browser clients use authenticated `/logs`
and `/logs/download` endpoints.

## Privacy boundary

Redaction happens before persistence. Sensitive keys, known environment secret
values, bearer credentials, and credential-bearing URL parameters are removed.

Operational logs intentionally exclude:

- request and response bodies
- authorization headers and cookies
- prompts and model message content
- MCP JSON-RPC stdout
- MCP tool arguments and results
- complete environment or provider configuration

MCP lifecycle, stderr, server/tool names, duration, and outcomes are recorded.
This gives enough information to diagnose failures without turning logs into a
second store for user data.

## Developer API

The API server and Electron main process capture existing
`console.debug/info/log/warn/error` calls automatically. Browser renderer logs
are forwarded through the browser logging bridge; the CLI writes its own
structured session and error records. Use a child logger for structured domain
events:

```ts
import { getLogger } from "@pizza-bot/logging";

const log = getLogger("sync");
log.info("Sync completed", {
  event: "sync.completed",
  durationMs,
  itemCount,
});
log.error("Sync failed", error, {
  event: "sync.failed",
  requestId,
});
```

Pass identifiers and counts as context. Do not pass request bodies, prompts,
tool payloads, credentials, or full configuration objects.
