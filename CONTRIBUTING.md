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
npm test           # license-generator tests, then capped Turbo tests
npm run lint       # eslint flat config
npm run dev        # downloads Playwright's browser revision if it is not cached
cp .env.example .env   # then fill in credentials for a model provider (see below)
```

On Windows, `npm install` does not require Visual Studio C++ build tools.
`better-sqlite3` ships a prebuilt binary, and the root `allowScripts` policy
disables its unused implicit `node-gyp rebuild`.

The root `npm run dev` command runs `npm run browser:install` first. On a fresh
machine this downloads Chrome for Testing for the bundled Playwright Plugin, so
it needs network access even when the rest of the workspace is already
installed. Playwright does not perform this download from an npm install or
postinstall script; `allowScripts` and `--ignore-scripts` do not affect it.

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

## How code ships

Four workflows, and only one of them publishes anything.

```
PULL REQUEST ────────────────────────────────────────────────────────────────
  ci.yml
    ├── code            build · typecheck · lint · test · audit
    ├── code-windows    build · typecheck · test
    ├── backend         bundle · smoke the standalone artifact
    ├── image           2 container images · 3 smokes         no push
    └── desktop         make --arch x64 · verify the payload  no signing
    all five required by branch protection

MERGE TO main ───────────────────────────────────────────────────────────────
  ci.yml, again. Nothing is published: no installers, no image, no release.

CUT A RELEASE ───────────────────────────────────────────────────────────────
  ① npm run release:prepare -- 1.1.0    bumps every manifest + both lockfiles
  ② open it as a PR and merge it        ci.yml runs on it as normal
  ③ push a signed tag                   git tag -s v1.1.0 && git push
       release.yml
         validate-release    tag on main? numeric? every version agrees?
               ▼
         ci                  the whole of ci.yml again
               ▼
         package             ⏸ waits for a reviewer, then signs
                               macos x64 · arm64    .dmg .zip  notarized
                               windows x64          Setup.exe  UNSIGNED
                               linux x64 · arm64    .deb .rpm   unsigned
               ▼
         draft-release       SHA256SUMS + a DRAFT release
               ▼
         image               ghcr.io :latest :1.1.0 :1.1 :sha-<sha>
               ▼
  ④ publish the draft

BUILD SOMETHING TO TEST ─────────────────────────────────────────────────────
  Actions ▸ Build on demand ▸ any branch
       build-on-demand.yml   version 0.0.<commits>, unsigned
                             5 installers as run artifacts, nothing published
```

The two reused pieces are [`package.yml`](.github/workflows/package.yml) (desktop
installers, called by a release and by an on-demand build) and the
[`backend-image`](.github/actions/backend-image/action.yml) composite action
(container images, used by CI and by a release). Each artifact is therefore
defined once, and a release ships what CI already exercised.

## CI checks

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs for pushes to
`main` and for pull requests, as five jobs named for what they cover:

| Job | Covers | Reproduce locally |
| --- | --- | --- |
| `code` | compilation, types, lint, tests | `npm run build && npm run typecheck && npm run lint && npm test` |
| `code-windows` | the same build, types, and tests on Windows | as above, minus lint and audit |
| `backend` | the standalone artifact of [STANDALONE_BACKEND.md](docs/STANDALONE_BACKEND.md) | `npm run backend:bundle && npm run backend:smoke` |
| `image` | both container images and their three smokes | see [`backend-image`](.github/actions/backend-image/action.yml); needs BuildKit for `COPY --parents` |
| `desktop` | Forge packaging, the makers, and the payload | `npm run desktop:make -- --arch x64` (needs `fakeroot` and `rpm`) |

`image` and the release both run the
[`backend-image`](.github/actions/backend-image/action.yml) composite action, so
what ships is what CI exercised. The
Dockerfile installs from the manifests before copying source, so a source-only
change keeps the `npm ci` layer cached; only `main` and releases write the Buildx
cache, because a pull request's entry is scoped to its own ref and evicted with it.

`desktop` is what keeps `main` releasable: a broken `forge.config.ts` would
otherwise merge green and surface only when someone cuts a release. It runs `make`
rather than `package` so it exercises the DEB and RPM makers a release depends on,
and it asserts the stamped version reaches the manifest inside `app.asar`
alongside every expected entry under `resources/`. Signing is not involved, so it
needs no certificates.

`code`, `code-windows`, `backend`, `image`, and `desktop` are required by branch
protection. Renaming one means updating that setting in the same change, or merges
block on a check that no longer reports.

Dependency advisories live in [`audit.yml`](.github/workflows/audit.yml) rather
than in `code`, because an advisory is published against dependencies already
pinned here — a code change cannot cause one, so it should not be blocked by one.
It runs weekly, on demand, and on a pull request only when that pull request
touches a manifest or lockfile, which is the case where the change itself is the
cause. `code-windows` retries its test step once: nested `cmd.exe` processes
intermittently die with `STATUS_DLL_INIT_FAILED`, and a real failure still fails
both attempts.

For a tight loop while iterating, run one workspace:

```bash
npx vitest run --dir packages/<pkg>        # or --dir apps/web
npx tsc --noEmit -p packages/<pkg>/tsconfig.json
```

> **Why `npm test` caps concurrency at 2:** uncapped, the parallel vitest+esbuild
> workers can exhaust file descriptors/memory and fail en masse — that's a
> resource limit, not real failures. The cap is baked into the root script.

## Releases

A release is a pushed `v*` tag. Nothing is published on a merge to `main`: a
downloaded installer cannot be recalled, so a person decides when a commit
becomes a release. `main` is kept releasable instead — CI packages the desktop
app on every pull request, so a packaging break cannot reach it.

### Cutting a release

1. Bump every workspace and both lockfiles, which a release tag is rejected over
   if any of them disagree. The script refuses a version that is not
   `major.minor.patch`, is `0.x`, already exists as a tag, or does not come after
   the newest release:

   ```bash
   npm run release:prepare -- 1.1.0
   ```

2. Open that as a pull request and merge it, so the version change passes normal
   CI. The script prints these commands:

   ```bash
   git switch -c release/v1.1.0
   git commit -am "chore: release v1.1.0"
   git push -u origin release/v1.1.0
   ```

   It is a local script rather than a workflow on purpose: GitHub creates no
   workflow runs for events a `GITHUB_TOKEN` produces, so a pull request opened by
   a bot could never satisfy the checks that protect `main`.

3. Tag the merge commit and push only the tag. Read the version back from the
   manifest rather than retyping it, so the tag cannot disagree with the bump:

   ```bash
   git switch main && git pull
   version="v$(node -p "require('./package.json').version")"
   git tag -s "$version" && git push origin "$version"
   ```

   Signing the tag by hand is the intent of this step: it is the maintainer's
   attestation that this commit is the release, and a workflow-created tag cannot
   carry one. Use an annotated tag (`-a`) if signing is unavailable.

   Nothing currently enforces the signature — `release.yml` checks that the tag
   points at a commit on `main`, not who signed it, so anyone with push access can
   release from an unsigned tag. Making the attestation real means requiring
   GitHub to report the tag as verified, which in turn requires every maintainer
   who cuts a release to register a signing key on their account.

That tag starts [`release.yml`](.github/workflows/release.yml), which verifies
the tag points at a commit on `main`, that the version is three numeric fields,
and that every workspace agrees, runs the complete CI workflow, and then, in
order:

1. [`package.yml`](.github/workflows/package.yml) — notarized macOS DMG and ZIP
   files for Intel and Apple silicon, a Windows Squirrel installer, and DEB and RPM
   packages for Linux x64 and arm64. It pauses for a reviewer before any
   certificate is used. Signing is per platform: `sign-macos` is on and the job
   fails rather than emit an unsigned macOS app, while `sign-windows` is off until
   an Authenticode certificate exists. Linux packages are never signed here.
2. `draft-release` — SHA-256 checksums and a **draft** GitHub Release for a
   maintainer to inspect and publish.
3. the [`backend-image`](.github/actions/backend-image/action.yml) action again,
   then a push of `ghcr.io/pizza-bot-app/pizza-bot` as `latest`, `1.1.0`, `1.1`,
   and `sha-<sha>`.

The registry push is last because it is the one step that cannot be undone:
nothing reaches GHCR until signing has succeeded, its reviewer has approved, and
the draft exists. A release is also the only thing that publishes either
distribution, so `latest` only ever moves for a release that produced
installers.

Do not move a release tag after pushing it; fix the release in a new version.

### Builds for testing

**Build on demand** in the Actions tab packages any branch and attaches the
installers to the run, publishing nothing.
[`build-on-demand.yml`](.github/workflows/build-on-demand.yml) runs in an
`unsigned` environment that holds no secrets, so these builds cannot reach a
certificate. That means macOS refuses them under Gatekeeper — right-click **Open**
or `xattr -d com.apple.quarantine <app>` — and Windows shows a SmartScreen
warning. They are for testing, never for handing to a user.

Signing without notarizing would not help: since macOS 10.15 Gatekeeper blocks a
downloaded app that is not notarized, signed or not.

These builds are versioned **`0.0.<build>`**, where `<build>` is the commit count
(`git rev-list --count HEAD`), so `0.x` is reserved for them and any other
version is a release. The commit count is used rather than a CI run number so the
version is reproducible from a checkout. Every field stays numeric because macOS
`CFBundleVersion` accepts only numbers, RPM forbids `-` in a version, and Squirrel
does not order a prerelease label the way semver does — so neither a `b123` label
nor a `1.0.0-b123` suffix is a version this pipeline can carry. `release.yml`
rejects one in a tag for the same reason.

`scripts/build-version.mjs` derives the version and stamps it into
`apps/desktop-shell/package.json` — the manifest Forge reads for the bundle
version, the Squirrel/DEB/RPM metadata, and `app.getVersion()`:

```bash
node scripts/build-version.mjs           # print the version for this checkout
node scripts/build-version.mjs --write   # print it and stamp the manifest
```

### Signing environment

Create an environment named `release` under **Settings > Environments**. Limit
its deployment tags to `v*`, require a maintainer reviewer, and keep
administrator bypass disabled. Self-review is deliberately allowed, so one
maintainer can cut a release alone; with bypass off, every release still records
an approval. Add these as **environment secrets**, not files in the repository:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE_BASE64` | Base64-encoded Developer ID Application `.p12` export |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | Full identity, such as `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple Developer account email used for notarization |
| `APPLE_ID_PASSWORD` | App-specific password generated for that Apple ID |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |
| `WINDOWS_CERTIFICATE_BASE64` | Base64-encoded Authenticode code-signing `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password protecting the Windows `.pfx` |

Encode the certificate without committing either form:

```bash
base64 < DeveloperIDApplication.p12 | tr -d '\n'
```

Encode the Windows PFX the same way, substituting its filename. The workflow
writes both certificates only to runner-temporary storage and removes them after
packaging. GitHub repository-level Actions secrets work technically, but
environment secrets are preferred because the approval and tag restrictions guard
access to the signing identities, and because only the release path selects that
environment. Each packaging job receives only its platform's secrets.

The current Forge configuration supports notarization with an Apple ID and
app-specific password. It does not pass App Store Connect API key options to
`@electron/notarize`; adding API-key secrets alone has no effect. Supporting
that authentication method requires a separate `forge.config.ts` change and
should define secret names only when the workflow consumes them.

With `sign-windows: true` the release verifies Authenticode signatures and
timestamps before upload, and fails rather than emit an unsigned installer. Linux
packages are not repository-signed. Automatic application updates are also not
configured; GitHub Releases are the download channel, not an update feed.

No Authenticode certificate is configured yet. Both routes worth considering
avoid an EV certificate and its hardware token — verify current terms before
committing to either:

- **SignPath Foundation** issues free certificates to open-source projects and
  has a GitHub Action that submits an artifact and returns it signed. This repo's
  Apache-2.0 license and public history should qualify; expect a review step.
- **Azure Trusted Signing** costs roughly ten dollars a month, needs no hardware
  token, and has a first-party action. It requires identity validation, with
  separate paths for organizations and individuals.

Wire either one through `windowsSign` in
[`forge.config.ts`](apps/desktop-shell/forge.config.ts) rather than signing after
`make`: Squirrel packages the app executable *into* `Setup.exe`, so the inner
binary has to be signed before the maker runs.

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
