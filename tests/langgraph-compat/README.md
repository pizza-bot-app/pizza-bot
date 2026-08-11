# LangGraph dependency conformance

Pizza Bot does not implement the LangGraph Agent Server API. It owns a
thread-centric commands/SSE protocol, while carrying native LangGraph
`ProtocolEvent` frames and exposing a small checkpoint-shaped state/history
surface.

This suite protects the dependency boundaries Pizza Bot actually uses:

1. **Protocol stream conformance** (`protocol-stream-conformance.test.ts`) drives
   the production `createDeepAgent` -> `streamEvents(v3)` path against a scripted
   model. It pins native event envelopes, namespaces, lifecycle completion,
   messages, tools, and durable state projections consumed by the SDK.
2. **DeepAgents API pins** (`deepagents-api.test.ts`) assert the backend and
   middleware exports used by the runtime, including FileDataV2-capable
   backends.

This test workspace is the only non-runtime import of `deepagents`; production
packages keep graph construction isolated in `packages/runtime-langgraph`.

There is deliberately no Agent Server OpenAPI route inventory or behavioral
parity suite. Standard Agent Server assistants, runs, stores, and crons are not a
Pizza Bot compatibility target.

## Running

```bash
npm run test:compat           # from repo root
```
