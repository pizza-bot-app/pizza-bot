# AGENTS.md

Guidance for working in this repo. Start with [README.md](README.md) (layout +
how to run) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (seams, event model,
design decisions) — this file is the operational overlay, not a duplicate.

## The one-line mental model

A stateful agentic inbox running one runtime (DeepAgents/LangGraph). The runtime
emits native
`@langchain/protocol` `ProtocolEvent` frames via `streamEvents(v3)`; every
frontend consumes them through the `@langchain/langgraph-sdk`
`Client`/`ThreadStream`/`StreamController` over HTTP/SSE. The seam is that
**protocol + SDK projection** boundary; keep React coupling outside it.

## Layering discipline (don't break these)

- `packages/core` is **nearly pure** — no `node:*`, no DOM, no `deepagents` /
  `@langchain/langgraph`, no `ai` — but it MAY import `@langchain/core` model/agent
  **types** (`BaseChatModel`), because the app is coupled to LangGraph by design
  and the model seam is honestly typed, not laundered through `unknown`. Core also
  owns the pure protocol/wire types (`protocol-types.ts`). The framework-agnostic
  message/thread-slice projection helpers live in `apps/web/src/projection` — the
  only consumer is the web app, so they sit beside it rather than in a shared
  package. The eslint layering rule enforces core's purity.
- **`packages/runtime-langgraph` is the ONLY production package that imports
  `deepagents` — the graph engine.** The `tests/langgraph-compat` workspace is a
  test-only exception because it pins DeepAgents' public exports. If the
  DeepAgents API churns, the runtime blast radius must stay one package. In
  production, two narrow, deliberate exceptions touch
  `@langchain/langgraph` WITHOUT the engine: `packages/storage` imports its
  `InMemoryStore` (a checkpoint-store primitive, kept out of runtime-langgraph
  because it's Node-bound), and `apps/api-server` imports `ProtocolEvent` as a
  TYPE only (the wire event). The conformance workspace may import upstream
  types for tests. The eslint layering guards enforce the core/ui purity +
  frontend rules; the `deepagents` "only" invariant is a convention, not
  lint-enforced.
- The frontend (`apps/web`) never imports a runtime or a model
  binding. It MAY import the transport SDK (`@langchain/langgraph-sdk`) — that's
  the wire — but never the runtime graph engine.
- The api-server assembles the concrete runtime through
  `createPizzaBotAgent` (`packages/runtime-langgraph`). Core knows only the
  minimal structural `AgentHandle` (`core/src/agent-run.ts`) the concrete agent
  satisfies (state read/write; the streaming method `streamProtocol` lives on
  the concrete `LangGraphAgent`, since its `ProtocolEvent`s can't be named
  without a `@langchain/langgraph` import). The runtime is stateful and
  checkpointer-backed.

## Where things live (for the common asks)

- **Runtime → protocol stream** (LangGraph → `ProtocolEvent` frames):
  `runtime-langgraph/src/stream-protocol.ts` holds `streamProtocolEvents` +
  `toLangGraphInput`; `index.ts`'s `LangGraphAgent.streamProtocol()` is the thin
  driver over it and the only streaming path. Native v3 correlation is
  reassembled client-side by the SDK `StreamController`. The offline conformance
  guard is `tests/langgraph-compat/protocol-stream-conformance.test.ts`.
- **The protocol/wire types**: `packages/core/src/protocol-types.ts`
  (`NormalizedMessage`, `ThreadStateValues`, HITL vocab, `ErrorCode`, `RunStatus`,
  `PROTOCOL_VERSION`, and wire schemas).
- **Runtime factory + agent handle**: `runtime-langgraph`'s `index.ts` exports
  `createPizzaBotAgent(systemPrompt, deps)` returning a `LangGraphAgent`; the run data
  types + the structural `AgentHandle` it satisfies live in
  `packages/core/src/agent-run.ts`.
- **Server composition root** (wires the runtime factory + storage + model):
  `apps/api-server` (`agent-host.ts` is the assembly; `index.ts` serves it). The
  in-process run registry is `ProtocolRunManager` (`protocol-run-manager.ts` —
  buffers frames per run, fans out to observers with `since`-based replay,
  cancels via `AbortSignal`); the SDK-facing wire is `routes-protocol.ts` (4
  Agent-Protocol endpoints: `POST /threads/:id/commands`, `POST
  /threads/:id/runs/:run_id/cancel` — what the SDK's `stop()` calls — `POST
  /threads/:id/stream/events`, `GET /threads/:id/state`).
- **Message/thread projection** (SDK projections → feed messages/cards): the
  pure helpers in `apps/web/src/projection` (`messages.ts` =
  `messagesToUI`/interrupt overlays/hydrate helpers, `thread-slice.ts` =
  `ThreadSlice`/`StreamStatus`). The web binds via
  `apps/web/src/protocol-stream-store.ts` (a headless SDK `StreamController` per
  thread) behind the thin `use-thread-slice.ts` hook;
  `components/ActivityRail.tsx` renders delegated work in the Activity panel.
- **Model providers**: `packages/inference-providers` (one adapter per provider
  under `src/providers/`, with flat files except for Bedrock's multi-file shim in
  `src/providers/bedrock/`).
- **Agent definition**: `packages/core/src/agent.ts` (`pizzaBotSystemPrompt` + the
  single `PIZZA_BOT_AGENT` orchestrator). Capabilities come from skills under
  `skills/<id>/SKILL.md`, projected into delegatable subagents by
  `resolveSkillSubagents` and seeded into run state by `buildSkillSeed` /
  `withSkillSeed` (`runtime-langgraph/src/index.ts`).

## Testing

- **`npm test` is the supported entrypoint** — it runs the license-generator
  tests, then `turbo run test --concurrency=2`; the cap is deliberate (uncapped,
  the parallel vitest+esbuild workers can exhaust file descriptors / memory and
  fail en masse). CI runs the same command.
- For a tight iteration loop, run one workspace directly:
  `npx vitest run --dir packages/<pkg>` (or `--dir apps/web`).
- Typecheck a package with `npx tsc --noEmit -p <path>/tsconfig.json`, or the
  whole graph with `npm run typecheck`. Lint with `npm run lint`
  (typescript-eslint flat config).

## Windows: constraints the suite has to respect

`npm test` is green on Windows. Four platform differences shape how these tests
are written — keep them in mind when adding assertions or temp-dir cleanup:

- **No POSIX mode bits.** Windows `chmod` only toggles the read-only bit, so
  `0o700`/`0o600` assertions can never hold. Gate them on
  `process.platform !== "win32"` (see `packages/logging` `file-store.test.ts` and
  `packages/storage` `app-db.test.ts`).
- **Symlinks need elevation.** `symlink()` throws `EPERM` without Developer Mode,
  so symlink-behavior tests use `it.skipIf(process.platform === "win32")`.
- **CRLF checkouts.** `core.autocrlf` yields CRLF and the repo has no
  `.gitattributes`, so never assert an exact `\n` against on-disk repo content —
  match `\r?\n`. Production parsers already tolerate both (e.g.
  `plugin-sdk/frontmatter.ts`).
- **Deleting a directory races the OS.** Windows keeps directory/file handles open
  briefly after a child process exits, so `rmSync` in an `afterAll` throws `EPERM`
  even though the owning process is gone. Always pass `maxRetries`/`retryDelay`
  (see `apps/desktop-shell` `sidecar.test.ts`). This surfaces under full-suite
  load and usually *not* in an isolated run, so reproduce with `npm test`.

`npm install` does not need MSVC — see CONTRIBUTING's setup note for how
`allowScripts` denies `better-sqlite3`'s implicit `node-gyp rebuild`, which
would otherwise be both mandatory (node-gyp fails at *configure* without a
toolchain) and unused (prebuilt binaries ship for every platform). Electron 43
has no `postinstall`; `index.js` downloads the binary lazily on first launch.

## Verify in the browser, not just tests

For frontend/runtime-seam work, passing unit tests are necessary but not
sufficient — tests inject fakes and have missed real cross-environment bugs.
Actually run it. Fastest loop for a runtime-side change: a small `tsx` script that
drives `createPizzaBotAgent(systemPrompt, deps).then(a => a.streamProtocol(input, opts))`
against live Bedrock and inspects the emitted `ProtocolEvent` frames (needs
`AWS_REGION` + Bedrock creds). For UI work,
launch the app per `docs/RUNNING.md` and drive it. Delete throwaway probe scripts
when done.

When driving the protocol endpoints by hand, two contracts fail *silently* rather
than erroring — both look like a broken server:

- `POST /threads/:id/commands` expects `{id, method, params}` (`run.start`,
  `input.respond`, …). An unrecognized body returns `204`, so nothing runs.
- `POST /threads/:id/stream/events` filters by `channels`, and an empty/absent
  array matches no frames (`frameMatchesFilter`). Name them explicitly:
  `values`, `messages`, `updates`, `lifecycle`, `tools`, `tasks`, `input`, `custom`.

`apps/api-server` needs `PIZZA_ALLOWED_ORIGINS` set to the web origin when Vite
runs on a non-default port, or every request fails `403 origin_not_allowed`. Point
`PIZZA_DATA_ROOT` at a scratch directory so probing never touches real threads.

## Comments

Comment to explain what the code cannot say about itself, nothing more. A comment
earns its place ONLY if it is one of: a non-obvious *why*, a workaround (name the
cause), a `TODO`/`FIXME`, an invariant lint/types don't enforce, or a
cross-environment gotcha. Default to no comment — clear names and types are the
first line of documentation.

- **Never narrate history.** No "was / now / no longer / used to / renamed /
  deleted in Pn / relocated from / survivor of". Git holds the past; the comment
  describes the present. This is a new project — there is no legacy to explain.
- **No roadmap breadcrumbs in code.** No `§x.y`, `Phase X`, `Pn`, `WSn`, or
  codenames like "Option A". If a plan section anchors a real invariant, state the
  invariant in plain terms instead of pointing at the doc.
- **Don't restate the signature.** If the comment just rephrases the name/type
  (`/** Cache key for the cache. */`), delete it.
- **One clause, not an essay.** Say the single surprising thing; cut the setup.
  File headers: ≤3 lines — what the file is plus its one load-bearing seam fact.
- When you change behavior at a seam, update its comment — replace the stale note,
  don't append a "now X" correction beside it.

## Conventions

- Match surrounding code (naming, idiom, structure).
- Don't add standalone design docs to `docs/` for routine work — fold durable
  decisions into `docs/ARCHITECTURE.md`, `README.md`, or the relevant
  `packages/*/README.md`. Keep the maintained-doc set small.

## Git workflow

Every agent-driven change MUST use a dedicated branch in an isolated worktree.
Make all edits in that worktree; keep the main checkout available for review.
Name branches `<type>/<kebab-case-description>` using an intent such as `fix`,
`feat`, `refactor`, `docs`, `test`, or `chore`. Branch names MUST describe the
change, not the implementation tool, agent, author, or worktree.

Create worktrees under the main checkout's repo-local
`.worktrees/<kebab-case-description>` directory. The worktree directory MUST
match the description portion of its branch name; omit the `<type>/` prefix.
For example:
`git worktree add .worktrees/skill-worker-bundled-files -b fix/skill-worker-bundled-files main`.

A fresh worktree needs its own `npm install` before building or testing;
otherwise workspace imports can resolve against stale output from another
checkout. Run `npm run build` before starting any application entrypoint:
`@pizza-bot/*` imports resolve to their built `dist/` output, while `typecheck`
and `test` build only their task dependencies. Keep the affected tests and
typecheck green, and run the full CI checks before opening a PR. Do not merge to
`main` or push a branch unless the repository owner asks.
