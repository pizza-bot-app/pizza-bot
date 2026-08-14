# Workflows

## Inbox

Pizza Bot is built for work that may take longer than one chat turn. A run keeps
going when the user switches conversations or disconnects, as long as the
api-server remains running.

- **Unread** collects completed work that the user has not revisited.
- **Action** collects durable approval requests waiting for a decision.
- The Activity panel shows delegated work performed by skill workers.

## Delegation

Pizza Bot answers directly for ordinary work and delegates specialized tasks to
enabled, ready skills. Each skill runs as a tool-scoped worker with its own
instructions. A skill that depends on MCP tools becomes ready after those tools
are enabled and connected.

## Approvals

Skills can require human approval before consequential tools run. An approval
can allow approve, edit, or reject decisions according to the skill's policy.
The paused run is checkpointed so the decision can be made later.

## Scheduled and triggered work

Cron schedules and webhooks can start work without an open conversation. This is
useful for recurring summaries, checks, and other background tasks. The
api-server must be running when the trigger fires.

## Browser automation

The bundled Browser Automation Plugin can inspect pages, fill forms, capture
screenshots, and interact with sites through Playwright MCP. It uses an
installed Chrome, Edge, or Chromium browser. For consequential actions, keep a
human approval or a clear stop before the final submit, send, purchase, or delete
step.

Browser sessions and site access belong to the browser and MCP process, not
Pizza Bot's credential store. Use only sites and accounts the user is authorized
to automate.

## Memory

When memory is enabled, Pizza Bot can keep concise Markdown notes under the
configured memories directory and use them across conversations. Memory is for
durable preferences, decisions, and recurring context, not secrets.

## Attachments

Files and images can be attached to a conversation. Attachment support depends
on the selected model provider and model. Attachments are stored under the Pizza
Bot data root and are sent to the selected model when used in a request.
