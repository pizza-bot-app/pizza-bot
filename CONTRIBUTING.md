# Contributing

Thanks for your interest in improving Pizza Bot. This is a TypeScript monorepo
(npm workspaces + Turborepo) for a stateful DeepAgents/LangGraph inbox. Start
with the [README](README.md) for layout and how to run, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the seams and design decisions.

## Getting started

```bash
node -v            # need >= 24
npm install        # installs workspaces; better-sqlite3 uses a shipped prebuild
npm run build      # required before running an app from a fresh clone
npm run typecheck  # tsc across the whole project-reference graph
npm test           # turbo run test --concurrency=2
npm run lint       # eslint flat config
cp .env.example .env   # then fill in credentials for a model provider (see below)
```

On Windows, `npm install` does not require Visual Studio C++ build tools.
`better-sqlite3` ships a prebuilt binary, and the root `allowScripts` policy
disables its unused implicit `node-gyp rebuild`.

The `@pizza-bot/*` workspace packages resolve to built `dist/` output. Run
`npm run build` once after a fresh clone or clean before starting an app directly
from source. Every workspace build replaces its own `dist/` directory before
emitting, so files for deleted or renamed sources cannot survive a pull or branch
switch.

`npm run clean` cascades through the workspaces and removes generated outputs
without removing installed dependencies or the root Turbo cache. Use
`npm run clean:all` only when dependencies or cached build artifacts must also be
discarded; run `npm install` afterward.

A running api-server needs access to at least one model provider; the CLI and a
desktop app connected to a remote backend do not. Amazon Bedrock, Anthropic,
Google Gemini, OpenAI, OpenRouter, and Ollama are supported as peer adapters.
See [`.env.example`](.env.example). Without credentials for a selected provider,
the code builds and tests pass, but live runs fail at the first model call.

## CI checks

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs for pushes to
`main` and for pull requests. Reproduce it locally before opening a PR:

1. **`npm run build`** — validates production bundles and package compilation.
2. **`npm run typecheck`** — `tsc` over the project references (the deep gate).
3. **`npm run lint`** — `typescript-eslint` (fast, non-type-checked) plus a
   layering guard (below).
4. **`npm test`** — the full suite.
5. **`npm run backend:bundle && npm run backend:smoke`** — builds and exercises
   the standalone artifact.
6. **`docker build --file deploy/linux/Dockerfile --tag pizza-bot-backend:ci .`**
   — validates the Linux container.
7. **`npm audit --omit=dev --audit-level=high`** — blocks high-severity
   production dependency advisories.

CI also repeats install, build, typecheck, and tests on Windows.

For a tight loop while iterating, run one workspace:

```bash
npx vitest run --dir packages/<pkg>        # or --dir apps/web
npx tsc --noEmit -p packages/<pkg>/tsconfig.json
```

> **Why `npm test` caps concurrency at 2:** uncapped, the parallel vitest+esbuild
> workers can exhaust file descriptors/memory and fail en masse — that's a
> resource limit, not real failures. The cap is baked into the root script.

## Layering discipline (enforced)

The value of this codebase is one clean seam: the runtime emits native
`@langchain/protocol` frames, and every frontend consumes them through the
`@langchain/langgraph-sdk` `StreamController`/`ThreadStream` over HTTP/SSE.
React code stays outside that transport boundary. Please keep it intact:

- **`packages/core`** is nearly pure but may reference
  `@langchain/core` model/agent **types** (`BaseChatModel`) — the app is coupled to
  LangGraph by design, so the model seam is typed rather than laundered through
  `unknown`; core also owns the pure protocol/wire types. ESLint enforces the split
  via `no-restricted-imports`; a violating import fails `npm run lint`.
- **`packages/runtime-langgraph` is the only production package that may import
  `deepagents`.** The `tests/langgraph-compat` workspace is the test-only
  exception because it pins DeepAgents' public exports. Storage may use
  LangGraph checkpoint/store primitives, and the api-server may import protocol
  event types; runtime graph construction stays in one package.
- The frontend (`apps/web`) never imports a runtime or a model
  binding. It MAY import the transport SDK (`@langchain/langgraph-sdk`) — but not
  the runtime graph engine. Its pure projection helpers live in
  `apps/web/src/projection`.

See AGENTS.md → "Layering discipline" and ARCHITECTURE §2/§11 for the rationale.

## Commits & PRs

- Work on a branch off `main`; keep each commit a coherent, self-contained step
  with a clear message.
- Keep the tree green — run the CI checks (or at least the affected workspaces'
  `vitest` + `tsc`) before pushing.
- For changes at a seam (the runtime↔event mapping, the protocol types, the UI
  folding), keep comments focused on current, non-obvious constraints. Put
  system-level design decisions in ARCHITECTURE.md instead of source-file essays.
- Verify UI/runtime-seam changes in the browser, not just via tests: the tests
  inject fakes and have missed real cross-environment bugs. See AGENTS.md →
  "Verify in the browser".

## Working in a git worktree

If you develop in a `git worktree`, run `npm install` **inside the worktree**
first. A fresh worktree starts with an empty `node_modules`, and without a local
install the `@pizza-bot/*` workspace symlinks resolve against the main checkout — so
your cross-package edits appear to have no effect and tests can pass against stale
code. After installing, `npx tsc -b <pkg>` builds a package's project-reference
dependencies before typechecking it.

## License

By contributing, you agree that your contributions are licensed under the
project's [Apache-2.0](LICENSE) license.
