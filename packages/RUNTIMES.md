# The runtime: how LangGraph is wired

The app is **coupled to one runtime by design**: DeepAgents / LangGraph
(`@pizza-bot/runtime-langgraph`), always **stateful and checkpointer-backed**
(every agent persists and resumes from a checkpointer). There is no
`RuntimeProvider` abstraction or capability matrix — a producer indirection over a
single implementation buys nothing and costs type-safety (see
`docs/ARCHITECTURE.md` §11). The deliberate seam is the native
`@langchain/protocol` stream consumed by the frontend/CLI through the
`@langchain/langgraph-sdk` transport, not a swappable producer.

## How it's wired

- **Factory, not interface.** `runtime-langgraph` exports
  `createPizzaBotAgent(systemPrompt, deps): Promise<LangGraphAgent>`. The
  api-server's `AgentHost` calls it with the concrete dependencies it built: a
  `BaseChatModel` (from a `ModelProvider`), `SqliteSaver`, an optional store,
  resolved tools, and the skill catalog. The CLI is an HTTP client and never
  constructs a runtime or checkpointer.
- **`AgentHandle` is the seam core knows.** `LangGraphAgent` structurally
  satisfies core's minimal `AgentHandle` (`core/src/agent-run.ts`) — the state
  read/write methods `getState` / `getStateHistory` / `updateState`. The streaming
  method `streamProtocol` is deliberately NOT on that interface: it returns
  `@langchain/protocol` `ProtocolEvent`s, which pure core can't name without a
  `@langchain/langgraph` import — so it lives only on the concrete
  `LangGraphAgent`. The api-server holds that concrete agent and drives `streamProtocol` through
  a `ProtocolRunManager`.
- **The one runtime precondition** — HITL needs a checkpointer — is a plain `if`
  inside `createPizzaBotAgent`, not a capability gate.

## If a second runtime ever materializes

A new runtime would have to emit `@langchain/protocol` frames (or be adapted to).
A thin producer interface can be re-introduced at that point — cheaply, and with a
concrete second implementation in hand to shape it correctly (which is when you'd
actually know its shape). Only stateful, checkpointer-backed runtimes are
supported: a runtime that can't persist and resume from a checkpointer does not
fit the model.
