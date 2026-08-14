/** Electron Forge packaging for the renderer and bundled API sidecar. */
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
// @ts-expect-error -- plain .mjs helper outside this package's tsconfig rootDir.
import { resolveNpmCli } from "../../scripts/npm-cli.mjs";

const shellRoot = __dirname;
const repoRoot = path.resolve(shellRoot, "..", "..");

// Signing credentials come from the repo-root `.env`, which no other build step
// reads: the api-server's own loader runs in the sidecar at runtime, long after
// packaging. Without this, signing variables stored only in `.env` silently
// produce unsigned artifacts. `loadEnvFile` never overwrites an exported var, so
// a shell export or CI secret still wins.
for (const name of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(path.join(repoRoot, name));
  } catch {
    // Optional: a missing file leaves process.env untouched.
  }
}

const signingIdentity =
  process.env.APPLE_SIGNING_IDENTITY ??
  (process.env.APPLE_DEVELOPER_NAME && process.env.APPLE_TEAM_ID
    ? `Developer ID Application: ${process.env.APPLE_DEVELOPER_NAME} (${process.env.APPLE_TEAM_ID})`
    : undefined);
const isSigning = Boolean(signingIdentity);
const isNotarizing = Boolean(
  process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD && process.env.APPLE_TEAM_ID,
);
const windowsCertificateFile = process.env.WINDOWS_CERTIFICATE_FILE;
const windowsCertificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;
if (Boolean(windowsCertificateFile) !== Boolean(windowsCertificatePassword)) {
  throw new Error(
    "Windows signing requires WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD",
  );
}
const isWindowsSigning = Boolean(windowsCertificateFile && windowsCertificatePassword);
const windowsSign = isWindowsSigning
  ? {
      certificateFile: windowsCertificateFile,
      certificatePassword: windowsCertificatePassword,
      hashes: ["sha256" as const],
      timestampServer: "http://timestamp.digicert.com",
      description: "Pizza Bot OSS",
      website: "https://github.com/pizza-bot-app/pizza-bot",
    }
  : undefined;

// The macOS steps are env-gated and fail open to an unsigned build, so state the
// outcome up front rather than letting it surface as a Gatekeeper error later.
if (process.platform === "darwin") {
  console.log(
    isSigning ? `[forge] signing as: ${signingIdentity}` : "[forge] signing DISABLED",
  );
  console.log(
    isNotarizing
      ? `[forge] notarizing as: ${process.env.APPLE_ID}`
      : "[forge] notarization DISABLED",
  );
}
if (process.platform === "win32") {
  console.log(
    isWindowsSigning ? "[forge] Windows signing enabled" : "[forge] Windows signing DISABLED",
  );
}

const iconsDir = path.join(repoRoot, "assets", "icons");
// Forge appends the per-platform extension, so these stay extensionless. macOS
// uses its own variant, padded for the rounded-rect mask Apple applies.
const appIcon = path.join(iconsDir, process.platform === "darwin" ? "icon-mac" : "icon");

const config: ForgeConfig = {
  packagerConfig: {
    name: "Pizza Bot OSS",
    executableName: "pizza-bot-oss",
    icon: appIcon,
    // Squirrel names the Start Menu folder after the exe's CompanyName. Without
    // this it stays Electron's stock "GitHub, Inc." resource, because the
    // packager only infers CompanyName from a root `author` field this repo
    // does not set.
    win32metadata: { CompanyName: "Pizza Bot OSS" },
    // Forked code and native modules must remain outside the asar.
    asar: { unpack: "{**/*.node,**/dist-server/**}" },
    // Package read-only built assets and contributions at explicit resource paths.
    extraResource: [
      path.join(repoRoot, "LICENSE"),
      path.join(repoRoot, "NOTICE"),
      path.join(repoRoot, "dist", "THIRD_PARTY_LICENSES.txt"),
      path.join(shellRoot, "dist-server"),
      path.join(repoRoot, "apps", "web", "dist"),
      path.join(iconsDir, "icon.ico"),
      path.join(iconsDir, "icon.png"),
      // Staged, not repo-root: shipped plugins need their own node_modules.
      path.join(shellRoot, "dist-plugins", "plugins"),
      path.join(repoRoot, "skills"),
    ],
    ...(isSigning && {
      osxSign: {
        identity: signingIdentity,
        continueOnError: false,
        optionsForFile: () => ({
          hardenedRuntime: true,
          entitlements: path.join(shellRoot, "entitlements.plist"),
        }),
      },
    }),
    ...(isNotarizing && {
      osxNotarize: {
        appleId: process.env.APPLE_ID!,
        appleIdPassword: process.env.APPLE_ID_PASSWORD!,
        teamId: process.env.APPLE_TEAM_ID!,
      },
    }),
    ...(windowsSign && { windowsSign }),
  },

  makers: [
    // Squirrel derives the NuGet package id from this name; the app's scoped
    // package name (@pizza-bot/desktop-shell) is not a valid id (the slash
    // becomes a path separator), so set a flat one explicitly. Underscores, not
    // hyphens: NuGet delimits id from version with a hyphen, so a hyphenated id
    // makes delta filenames ambiguous. This id is also the AppUserModelID
    // Squirrel stamps into the shortcuts it creates — `SQUIRREL_APP_ID` in
    // src/squirrel-startup.ts must match it. `authors` fills the nuspec's
    // required <authors>, which has no source in package.json.
    new MakerSquirrel({
      name: "pizza_bot_oss",
      authors: "Pizza Bot OSS",
      description: "Pizza Bot OSS desktop app",
      setupIcon: path.join(iconsDir, "icon.ico"),
      // Squirrel fetches this at build time into the install root as app.ico and
      // points the Programs & Features DisplayIcon at it; unset, it downloads
      // Electron's stock icon instead. Resolved on the build host, so a file:
      // URL avoids hosting one — but it is embedded verbatim in the published
      // nuspec, so override it with a public URL if that leak matters.
      iconUrl:
        process.env.PIZZA_ICON_URL ?? pathToFileURL(path.join(iconsDir, "icon.ico")).href,
      ...(windowsSign && { windowsSign }),
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerDMG({ format: "ULFO", icon: path.join(iconsDir, "icon-mac.icns") }, ["darwin"]),
    new MakerRpm({ options: { icon: path.join(iconsDir, "icon.png") } }),
    new MakerDeb({ options: { icon: path.join(iconsDir, "icon.png") } }),
  ],

  plugins: [new AutoUnpackNativesPlugin({})],

  hooks: {
    generateAssets: async () => {
      console.log("[forge] staging plugins -> dist-plugins/plugins");
      execFileSync("node", [path.join(shellRoot, "scripts", "stage-plugins.mjs")], {
        stdio: "inherit",
        cwd: repoRoot,
      });
      console.log("[forge] bundling api-server -> dist-server/index.js");
      execFileSync("node", [path.join(shellRoot, "scripts", "bundle-server.mjs")], {
        stdio: "inherit",
        cwd: repoRoot,
      });
      // Build through the root script, not `-w <pkg>`: a per-workspace build
      // skips turbo's dependency graph, so the renderer would compile against
      // whatever stale `dist/` its workspace deps happen to have on disk.
      console.log("[forge] building workspaces (renderer + deps)");
      execFileSync(process.execPath, [resolveNpmCli(), "run", "build"], {
        stdio: "inherit",
        cwd: repoRoot,
      });
      execFileSync(
        process.execPath,
        [
          path.join(repoRoot, "scripts", "third-party-licenses.mjs"),
          "--artifact",
          "desktop",
          path.join(repoRoot, "dist", "THIRD_PARTY_LICENSES.txt"),
          "--plugin-node-modules",
          path.join(shellRoot, "dist-plugins", "plugins", "node_modules"),
        ],
        { stdio: "inherit", cwd: repoRoot },
      );
    },
  },
};

export default config;
