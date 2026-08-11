# What and why

<!-- What changes, and the reason. Link an issue if there is one. -->

## Gates

Run these checks locally before opening the PR:

- [ ] `npm run build`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`

## Verified how

Passing tests are necessary but not sufficient because the suite injects fakes
and has missed real cross-environment bugs. For any frontend or runtime boundary
change, say what you actually ran.

- [ ] Drove the change in a real app (web/desktop/CLI) - describe what you saw
- [ ] Tests only (explain why that is sufficient here)

<!-- e.g. "Sent a message that triggers a non-HITL tool call and watched the tool
     card reach a terminal state", or "approved a gated tool and confirmed the
     thread left the Action filter". -->

## Layering

- [ ] `packages/core` gained no `node:*`, DOM, `deepagents`, or `@langchain/langgraph` import
- [ ] Only `packages/runtime-langgraph` imports the graph engine
- [ ] `apps/web` imports no runtime and no model binding
- [ ] Docs touched by this change were updated (README / AGENTS.md / docs/ARCHITECTURE.md)
