---
name: health-report
description: Produce a formatted health report of connected MCP servers and tools.
tools:
  - mcp:mcp-status:get_mcp_status
---

# MCP Health Report

1. Call `get_mcp_status`.
2. Summarize the returned server state and tool count.
3. Call out any server that is not connected.
