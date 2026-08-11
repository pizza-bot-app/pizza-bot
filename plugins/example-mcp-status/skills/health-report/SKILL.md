---
name: health-report
description: Produce a formatted health report of all connected MCP servers and their tools. Use when the user asks for an overview, audit, or report of MCP/tool/server health, or whether integrations are connected.
tools:
  - mcp:mcp-status:get_mcp_status
---

# MCP Health Report

1. Call `get_mcp_status` to gather per-server state.
2. Group by status (connected / degraded / disconnected).
3. Render a compact table; flag any server with zero resolved tools.
4. For degraded/disconnected servers, cite the last error and a suggested fix.

Read `reference.md` when you need the field definitions used by the status
payload.
