import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  generateThirdPartyLicenses,
  isLicenseFileName,
} from "./third-party-licenses.mjs";

test("recognizes attribution files without accepting source and build files", () => {
  for (const name of [
    "LICENSE",
    "LICENSE.md",
    "LICENCE.txt",
    "COPYING",
    "CopyrightNotice.txt",
    "NOTICE",
    "UNLICENSE",
    "LICENSE-MIT",
    "LICENSE-MIT.txt",
    "LICENSE.APACHE",
    "LICENSE.BSD",
    "LICENSE-MPL",
    "LICENSES.txt",
    "THIRD-PARTY-LICENSE",
    "THIRD_PARTY_LICENSES.txt",
    "THIRD_PARTY_NOTICES.md",
    "ThirdPartyNoticeText.txt",
    "LICENSES.chromium.html",
  ]) {
    assert.equal(isLicenseFileName(name), true, name);
  }
  for (const name of [
    "README.md",
    "license.ts",
    "copyright.js",
    "copyright.mjs",
    "copyright.mjs.map",
    "license-update.mjs",
    "licenses.js",
    "licenses.d.ts",
    "license.map",
    "license_header",
  ]) {
    assert.equal(isLicenseFileName(name), false, name);
  }
});

test("walks runtime closure through private packages and labels vendored texts", (t) => {
  const tempDir = makeTempDir(t);
  const appDir = path.join(tempDir, "app");
  writePackage(appDir, {
    name: "private-app",
    privatePackage: true,
    dependencies: { alpha: "1.0.0", "private-parent": "1.0.0" },
    optionalDependencies: { optional: "1.0.0" },
    peerDependencies: { peer: "1.0.0" },
  });
  writePackage(path.join(appDir, "node_modules", "alpha"), {
    name: "alpha",
    license: "Apache-2.0",
    files: {
      "vendor/parser/LICENSE": "vendored parser license",
      "src/license.ts": "not a license",
      "dist/copyright.mjs": "not a copyright notice",
      "dist/copyright.mjs.map": "not a source map notice",
      "scripts/license-update.mjs": "not a license update",
    },
  });
  const privateParent = path.join(appDir, "node_modules", "private-parent");
  writePackage(privateParent, {
    name: "private-parent",
    privatePackage: true,
    dependencies: { nested: "2.0.0" },
  });
  writePackage(path.join(privateParent, "node_modules", "nested"), {
    name: "nested",
    version: "2.0.0",
    license: "ISC",
    files: { LICENSE: "nested license" },
  });
  for (const name of ["optional", "peer"]) {
    writePackage(path.join(appDir, "node_modules", name), {
      name,
      files: { LICENSE: `${name} license` },
    });
  }

  const outputFile = path.join(tempDir, "licenses.txt");
  const result = generateThirdPartyLicenses(outputFile, {
    packageRoots: [appDir],
  });
  const output = readFileSync(outputFile, "utf8");

  assert.equal(result.packageCount, 4);
  assert.deepEqual(result.missingLicenseTexts, ["alpha@1.0.0"]);
  assert.match(
    output,
    /alpha@1\.0\.0[\s\S]*No package-level license file[\s\S]*Vendored component attribution: vendor\/parser\/LICENSE/,
  );
  assert.match(output, /nested@2\.0\.0[\s\S]*--- LICENSE ---[\s\S]*nested license/);
  assert.match(output, /optional@1\.0\.0/);
  assert.match(output, /peer@1\.0\.0/);
  assert.doesNotMatch(output, /private-app|private-parent/);
  assert.doesNotMatch(output, /not a license|not a copyright|not a source map/);
});

test("merges duplicate packages deterministically", (t) => {
  const tempDir = makeTempDir(t);
  const first = path.join(tempDir, "first");
  const second = path.join(tempDir, "second");
  writePackage(first, {
    name: "same",
    files: { LICENSE: "same license" },
  });
  writePackage(second, {
    name: "same",
    files: { NOTICE: "same notice" },
  });

  const firstOutput = path.join(tempDir, "first.txt");
  const secondOutput = path.join(tempDir, "second.txt");
  generateThirdPartyLicenses(firstOutput, {
    packageRoots: [first, second],
  });
  generateThirdPartyLicenses(secondOutput, {
    packageRoots: [second, first],
  });

  assert.equal(readFileSync(firstOutput, "utf8"), readFileSync(secondOutput, "utf8"));
  assert.match(
    readFileSync(firstOutput, "utf8"),
    /same@1\.0\.0[\s\S]*--- LICENSE ---[\s\S]*same license[\s\S]*--- NOTICE ---[\s\S]*same notice/,
  );
});

test("selects backend and desktop runtime closures and staged plugin dependencies", (t) => {
  const repoRoot = makeTempDir(t);
  writePackage(path.join(repoRoot, "apps", "api-server"), {
    name: "@pizza-bot/api-server",
    privatePackage: true,
    dependencies: { "backend-runtime": "1.0.0" },
  });
  writePackage(path.join(repoRoot, "apps", "desktop-shell"), {
    name: "@pizza-bot/desktop-shell",
    privatePackage: true,
    dependencies: { "desktop-runtime": "1.0.0" },
  });
  writePackage(path.join(repoRoot, "apps", "web"), {
    name: "@pizza-bot/web",
    privatePackage: true,
    dependencies: { "web-runtime": "1.0.0" },
  });
  for (const name of [
    "backend-runtime",
    "desktop-runtime",
    "web-runtime",
    "unrelated-build-tool",
  ]) {
    writePackage(path.join(repoRoot, "node_modules", name), {
      name,
      files: { LICENSE: `${name} license` },
    });
  }
  writePackage(path.join(repoRoot, "node_modules", "electron"), {
    name: "electron",
    version: "43.3.0",
    files: {
      LICENSE: "electron license",
      "dist/LICENSES.chromium.html": "chromium notices",
    },
    dependencies: { "electron-download-tool": "1.0.0" },
  });
  writePackage(path.join(repoRoot, "node_modules", "electron-download-tool"), {
    name: "electron-download-tool",
    files: { LICENSE: "download tool license" },
  });

  const stagedPlugins = path.join(repoRoot, "dist", "plugins");
  writePackage(path.join(stagedPlugins, "browser"), {
    name: "@pizza-bot/plugin-browser",
    privatePackage: true,
    dependencies: { "@playwright/mcp": "0.0.79" },
  });
  writePackage(path.join(stagedPlugins, "node_modules", "@playwright", "mcp"), {
    name: "@playwright/mcp",
    version: "0.0.79",
    files: { LICENSE: "playwright mcp license" },
  });
  writePackage(path.join(stagedPlugins, "node_modules", "unused-hoist"), {
    name: "unused-hoist",
    files: { LICENSE: "unused license" },
  });

  const pluginNodeModulesDirs = [path.join(stagedPlugins, "node_modules")];
  const backendOutput = path.join(repoRoot, "backend.txt");
  generateThirdPartyLicenses(backendOutput, {
    artifact: "backend",
    repoRoot,
    pluginNodeModulesDirs,
  });
  const backend = readFileSync(backendOutput, "utf8");
  assert.match(backend, /backend-runtime@1\.0\.0/);
  assert.match(backend, /@playwright\/mcp@0\.0\.79/);
  assert.doesNotMatch(
    backend,
    /desktop-runtime|web-runtime|electron@|unrelated-build-tool|unused-hoist/,
  );

  const desktopOutput = path.join(repoRoot, "desktop.txt");
  generateThirdPartyLicenses(desktopOutput, {
    artifact: "desktop",
    repoRoot,
    pluginNodeModulesDirs,
  });
  const desktop = readFileSync(desktopOutput, "utf8");
  assert.match(desktop, /desktop-runtime@1\.0\.0/);
  assert.match(desktop, /web-runtime@1\.0\.0/);
  assert.match(
    desktop,
    /electron@43\.3\.0[\s\S]*Vendored component attribution: dist\/LICENSES\.chromium\.html[\s\S]*chromium notices/,
  );
  assert.match(desktop, /@playwright\/mcp@0\.0\.79/);
  assert.doesNotMatch(
    desktop,
    /backend-runtime|electron-download-tool|unrelated-build-tool|unused-hoist/,
  );
});

function makeTempDir(t) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "pizza-licenses-"));
  t.after(() =>
    rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  return tempDir;
}

function writePackage(
  packageDir,
  {
    name,
    version = "1.0.0",
    license = "MIT",
    privatePackage = false,
    dependencies,
    optionalDependencies,
    peerDependencies,
    files = {},
  },
) {
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version,
        license,
        ...(privatePackage ? { private: true } : {}),
        ...(dependencies ? { dependencies } : {}),
        ...(optionalDependencies ? { optionalDependencies } : {}),
        ...(peerDependencies ? { peerDependencies } : {}),
      },
      null,
      2,
    )}\n`,
  );
  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(packageDir, file);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${content}\n`);
  }
}
