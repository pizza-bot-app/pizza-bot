# @pizza-bot/desktop-shell

The Electron desktop app. It renders the `apps/web` UI against either an
embedded api-server sidecar or a selected remote backend, using HTTP/SSE in both
cases.

## Architecture

```
Electron main (dist/main.js)
  ├─ startSidecar()  ── forks the api-server, negotiates a free port (PORT=0),
  │                     handshake { ready, port, pid, apiVersion }, bounded
  │                     health-ping loop + backoff restart + circuit breaker
  ├─ BrowserWindow   ── loads the renderer; preload injects the selected backend
  │                     origin/token plus scoped connection, secret, log, and
  │                     notification IPC
  └─ ConnectionStore ── persists embedded/remote selection and an encrypted
  │                     remote bearer token; switches replace the renderer
```

The main process uses `powerMonitor` to pause embedded cron timers on suspend.
After resume it checks the sidecar, restarts an unhealthy child, or asks a
healthy host to reconnect MCP servers before recovering one missed cron
occurrence. In-flight runs are not replayed because tool side effects may
already have completed.

Electron main also follows the durable terminal-run activity stream and owns
the `Notification` objects. Successful, failed, timed-out, and actionable runs
therefore notify while the app remains running even when no window is open.
Clicking an alert restores the window and opens its thread; preload buffers the
target until the renderer is ready.

### Two runtime modes (same code, chosen by `app.isPackaged`)

| | Server entry | Forked under | Renderer | Native modules |
|---|---|---|---|---|
| **dev** (`npm run dev`) | api-server **TS source** via `tsx` | **system Node** | Vite dev server `:5273` | system-Node ABI |
| **packaged** (`npm run make`) | **esbuild bundle** (`dist-server/index.js`) | **Electron's own Node** (`ELECTRON_RUN_AS_NODE`) | built static files (`file://`) | N-API prebuild |

The packaged **sidecar** is standalone: it is one bundle, so no external Node and
no `node_modules` resolution. `better-sqlite3` (the only native dep) runs on
N-API, so its bundled prebuild loads across Node and Electron ABIs — no
per-Electron rebuild, and no compiler toolchain needed to package. Forking the
bundled server under Electron's Node just works.

Shipped **plugins** are the deliberate exception. Their MCP servers are
independent child processes that resolve their own imports at runtime, and
workspace installs hoist dependencies to the repo root — which does not exist
beside the packaged plugin. So `scripts/stage-plugins.mjs` copies `plugins/` to
`dist-plugins/plugins` and runs a production `npm ci` from the committed
`plugins/package-lock.json`; `extraResource` ships that staged tree. Packaging
from the repo root directly would leave every plugin server dying on
`ERR_MODULE_NOT_FOUND`, which surfaces only as `MCP error -32000: Connection
closed`.

### Why the main process is bundled too (not just tsc'd)

Both the forked server **and the Electron main process** are esbuild-bundled
(`scripts/bundle-server.mjs` + `scripts/bundle-main.mjs`). Main *must* be bundled,
not left as plain `tsc` output: it imports `@pizza-bot/*` workspace packages by
bare specifier (e.g. `findSystemNode` from `@pizza-bot/plugin-sdk`), and every
source-exporting internal package uses **raw TS source** (`./src/index.ts`).
Those files re-export each other with `.js` specifiers
(`export * from "./manifest.js"`) that only resolve after a `tsc` build into
`dist/`. The bundle scripts enable the `source` export condition so dual-mode
packages such as `@pizza-bot/logging` also resolve to TypeScript during
bundling, while normal Node consumers resolve their compiled JavaScript.
esbuild resolves the whole graph at **build** time and inlines it, so no
cross-package specifier survives. (Bundling the Electron main process is a
standard electron-forge practice for the same reason.) The preload stays a
separate `tsc`→`.cjs` build — it imports only `electron`, so it has no
cross-package hazard. Type-checking is still done by `tsc --noEmit` (the
`typecheck` script); esbuild only owns the emit.

## Packaging prerequisites (important)

- **Use Node 24 or 25 to package** (`npm run make`/`package`). The repo requires
  Node `>=24`; Node 26 and newer are affected by an Electron Forge extraction hang
  ([electron/forge#4277]). On
  macOS the root
  `npm run desktop:package` / `desktop:make` scripts use Homebrew's `node@24`
  binary automatically. On other platforms they fail early unless the selected
  runtime is Node 24, so prefer those scripts. To invoke directly:
  `PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm run make -w @pizza-bot/desktop-shell`.
- **Linux packaging needs `dpkg` and `fakeroot` for deb, `rpmbuild` for rpm.**
  Forge checks a maker's external binaries while resolving targets, so a host
  missing one fails before packaging starts, naming the binary. Debian/Ubuntu:
  `sudo apt install dpkg fakeroot rpm`. To build only what a host can produce,
  pass the maker's **short** name — `npm run desktop:make -- --targets deb`.
  Forge matches `--targets` against `maker.name` (`deb`, `rpm`, `zip`, `dmg`,
  `squirrel`), and an unmatched value is treated as a fresh maker with default
  options rather than an error, which silently discards this repo's `bin` and
  `name` settings.
- **No compiler toolchain required to package.** `better-sqlite3` (v13+) runs on
  N-API and bundles prebuilt binaries for every packaged platform, so packaging does
  not compile natives — it just stages the module into `dist-server/node_modules`.
  `npm install` on Windows also needs no compiler: the root `allowScripts`
  policy disables npm's unused implicit `node-gyp rebuild` (see
  [Contributing](../../CONTRIBUTING.md#getting-started)).

Packaging is supported on macOS, Windows, and Linux; each `npm run make` host
produces installers for its own platform (see the makers in `forge.config.ts`).

[electron/forge#4277]: https://github.com/electron/forge/issues/4277

## Commands

```bash
npm run dev      -w @pizza-bot/desktop-shell   # dev: build main/preload, launch Electron (needs vite running for the renderer)
npm run bundle:main   -w @pizza-bot/desktop-shell   # esbuild the Electron main process -> dist/main.js
npm run bundle:server -w @pizza-bot/desktop-shell   # esbuild the api-server -> dist-server/index.js
npm run package  -w @pizza-bot/desktop-shell   # produce an unpacked app (bundles server, builds renderer, stages the native)
npm run make     -w @pizza-bot/desktop-shell   # build installers (DMG/ZIP on macOS, Squirrel on Windows, deb/rpm on Linux)
```

When launching only this workspace, run `npm run dev -w @pizza-bot/web` (Vite on
`:5173`) alongside it. The root `npm run dev` coordinates both on `:5273`.

## Packaging and signing

1. Set signing environment variables (optional; absent means unsigned artifacts).
   `forge.config.ts` reads the repo-root `.env`/`.env.local` itself — no other
   build step does — and an exported shell var still wins. See `.env.example`.
   - macOS signing: `APPLE_SIGNING_IDENTITY` **or** `APPLE_DEVELOPER_NAME` + `APPLE_TEAM_ID`
   - macOS notarization: `APPLE_ID`, `APPLE_ID_PASSWORD` (an app-specific
     password), `APPLE_TEAM_ID`
   - Windows signing: `WINDOWS_CERTIFICATE_FILE` (a PFX path) and
     `WINDOWS_CERTIFICATE_PASSWORD`
2. Bump the workspace versions and both lockfiles together with
   `npm run release:prepare -- 1.0.1`. A release tag is rejected unless all of
   them agree, which a bare `npm version` does not achieve.
3. Run `npm run desktop:make` from the repository root on each target OS.

Signing and notarization are gated independently. When their credentials are
absent, the corresponding step is skipped and the artifact is unsigned; invalid
configured credentials fail packaging. Confirm the `[forge] signing as:` /
`[forge] notarizing as:` lines at the start of the run. Notarization uploads the
app to Apple and typically adds several minutes. `@electron/notarize` staples the
ticket to the `.app` before the makers run, so the DMG and ZIP carry it too;
verify the result with `spctl -a -vvv --type install <path>.app` (expect
`source=Notarized Developer ID`).

A pushed `v*` tag drives [`release.yml`](../../.github/workflows/release.yml),
which packages and verifies signatures through
[`package.yml`](../../.github/workflows/package.yml); see
[Contributing](../../CONTRIBUTING.md#releases) for signing secrets and the
release process. Automatic updates are not configured, so installers must not be
presented as self-updating. A release requires Authenticode signing and verifies
the installer signature and timestamp before uploading it.

## Windows installer lifecycle

Squirrel owns the Start Menu and Desktop shortcuts, and it drives them by
relaunching the installed exe with a lifecycle flag (`--squirrel-install`,
`--squirrel-updated`, `--squirrel-uninstall`, `--squirrel-obsolete`), allowing
~15s before it kills the process. `src/squirrel-startup.ts` answers those flags
by delegating to `Update.exe --createShortcut`/`--removeShortcut`, and `main.ts`
calls it as its **first statement** — ahead of logging setup and sidecar boot, so
an install never seeds a data root or starts a server. Packaging inherits the
`SquirrelAwareVersion` resource from `electron.exe`, so these flags do get sent;
dropping the guard silently costs shortcuts on install *and* leaves a stray app
window running mid-install.

Three identifiers have to agree, and nothing checks them at build time:
`SQUIRREL_APP_ID` in `src/squirrel-startup.ts` must equal
`com.squirrel.<maker name>.<executableName minus ".exe" and spaces>` — the
AppUserModelID Squirrel stamps into every shortcut. If the running app's id
differs, Windows treats it as a different app: the taskbar button splits in two
and pinning the shortcut breaks.

The Programs & Features icon comes from the maker's `iconUrl`, which Squirrel
fetches **at build time** into the install root as `app.ico`. It defaults to a
`file:` URL for `assets/icons/icon.ico` — no hosting needed — but the build host's
absolute path is then embedded in the published nuspec; set `PIZZA_ICON_URL` to a
public URL for releases where that matters. Leaving it unset entirely makes
Squirrel download Electron's stock icon.

Nothing registers a URL scheme. Forge's `packagerConfig.protocols` is macOS-only
(`@electron/packager` writes it to `CFBundleURLTypes`), so a scheme also needs
`app.setAsDefaultProtocolClient` plus `open-url`/`second-instance` handling on
Windows and Linux. Deep linking is not implemented on any platform.

## Config

`forge.config.ts` — makers (zip/dmg/squirrel/deb/rpm), `AutoUnpackNativesPlugin`,
env-gated signing/notarization, and a `generateAssets` hook that bundles the
server + builds the workspaces before packaging, fitted to the monorepo's sidecar
model. That build goes through the root `npm run build` rather than
`-w @pizza-bot/web`, so turbo rebuilds the renderer's workspace dependencies
instead of letting it compile against a stale `dist/`.

The saved backend selection lives at
`<PIZZA_DATA_ROOT>/desktop-connection.json`. The URL and mode are ordinary
configuration; the bearer token is encrypted with Electron `safeStorage`.
`PIZZA_API_BASE` overrides the saved selection and skips sidecar startup.
`PIZZA_API_TOKEN` supplies its bearer token.

Notification preferences live only on the current device at
`<PIZZA_DATA_ROOT>/desktop-notifications.json`; both finished-run and
action-required alerts default on and can be changed under **Settings >
General**. Finished-run alerts include errors and timeouts but not explicit
cancellation. Browser builds do not expose these settings. Native delivery
follows the operating system's notification policy; macOS production builds
must be signed for reliable delivery.

See [Running a standalone backend](../../docs/STANDALONE_BACKEND.md) for the
server command, Connection settings, CORS origins, authentication, and
remote-host guidance.
