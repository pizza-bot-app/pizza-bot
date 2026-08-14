/** Generates artifact-specific dependency license inventories. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const ARTIFACTS = {
  backend: {
    workspaceRoots: ["apps/api-server"],
    standalonePackages: [],
  },
  desktop: {
    workspaceRoots: ["apps/desktop-shell", "apps/web"],
    // Electron's npm dependencies download/package the binary; they are not
    // part of the installed app, but Electron's own dist notices are.
    standalonePackages: [{ name: "electron", includeDependencies: false }],
  },
};

export function generateThirdPartyLicenses(
  outputFile,
  {
    artifact,
    repoRoot = defaultRepoRoot,
    pluginNodeModulesDirs = [],
    packageRoots,
    standalonePackages,
  } = {},
) {
  const packages = collectArtifactPackages({
    artifact,
    repoRoot,
    pluginNodeModulesDirs,
    packageRoots,
    standalonePackages,
  });
  const sortedPackages = [...packages.values()].sort(comparePackages);
  const missingLicenseTexts = sortedPackages
    .filter((pkg) => !pkg.hasPackageLicenseText)
    .map((pkg) => `${pkg.name}@${pkg.version}`);
  const sections = sortedPackages.map(formatPackage);
  const output = [
    "Pizza Bot OSS - Third-Party Licenses",
    "",
    "This inventory is generated from the runtime dependencies shipped in this artifact.",
    "Installed runtime peer dependencies are included conservatively.",
    "Project-specific notices remain in NOTICE.",
    ...(missingLicenseTexts.length > 0
      ? [
          "",
          "PACKAGING AUDIT: The following published packages did not include package-level license text.",
          "Their declared SPDX license and repository are recorded in their entries below:",
          ...missingLicenseTexts.map((name) => `- ${name}`),
        ]
      : []),
    "",
    ...sections,
  ].join("\n");

  mkdirSync(path.dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, `${output}\n`);
  return {
    packageCount: sortedPackages.length,
    missingLicenseTexts,
  };
}

export function collectArtifactPackages({
  artifact,
  repoRoot = defaultRepoRoot,
  pluginNodeModulesDirs = [],
  packageRoots,
  standalonePackages,
} = {}) {
  const definition = artifact ? ARTIFACTS[artifact] : undefined;
  if (artifact && !definition) {
    throw new Error(
      `unknown artifact "${artifact}"; expected one of: ${Object.keys(ARTIFACTS).join(", ")}`,
    );
  }
  if (!definition && !packageRoots) {
    throw new Error("artifact or packageRoots is required");
  }

  const packages = new Map();
  const visited = new Set();
  const roots = packageRoots ??
    definition.workspaceRoots.map((relative) => path.join(repoRoot, relative));
  for (const packageDir of roots) {
    visitPackage(packageDir, packages, visited, { includeDependencies: true });
  }

  const explicitPackages =
    standalonePackages ?? definition?.standalonePackages ?? [];
  for (const entry of explicitPackages) {
    const packageDir = resolveInstalledPackage(repoRoot, entry.name);
    if (!packageDir) {
      throw new Error(`artifact dependency is not installed: ${entry.name}`);
    }
    visitPackage(packageDir, packages, visited, {
      includeDependencies: entry.includeDependencies !== false,
    });
  }

  // Staged plugin manifests are roots; their dependencies resolve through the
  // shared production-only node_modules created by `npm ci --omit=dev`.
  for (const nodeModulesDir of pluginNodeModulesDirs) {
    visitStagedPlugins(path.dirname(nodeModulesDir), packages, visited);
  }
  return packages;
}

function visitStagedPlugins(stagingRoot, packages, visited) {
  let entries;
  try {
    entries = readdirSync(stagingRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) =>
    compareText(left.name, right.name)
  )) {
    if (
      entry.name !== "node_modules" &&
      (entry.isDirectory() || entry.isSymbolicLink()) &&
      existsSync(path.join(stagingRoot, entry.name, "package.json"))
    ) {
      const entryPath = path.join(stagingRoot, entry.name);
      visitPackage(entryPath, packages, visited, { includeDependencies: true });
    }
  }
}

function visitPackage(packageDir, packages, visited, { includeDependencies }) {
  let manifest;
  let realPackageDir;
  try {
    realPackageDir = realpathSync(packageDir);
    manifest = JSON.parse(
      readFileSync(path.join(realPackageDir, "package.json"), "utf8"),
    );
  } catch {
    return;
  }
  if (visited.has(realPackageDir)) return;
  visited.add(realPackageDir);

  if (
    manifest.private !== true &&
    typeof manifest.name === "string" &&
    typeof manifest.version === "string"
  ) {
    mergePackage(packages, manifest, realPackageDir);
  }

  // Private workspace/plugin packages are not attributed, but their shipped
  // dependency trees still must be traversed.
  if (!includeDependencies) return;
  const dependencyNames = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  for (const name of [...dependencyNames].sort(compareText)) {
    const dependencyDir = resolveInstalledPackage(realPackageDir, name);
    if (dependencyDir) {
      visitPackage(dependencyDir, packages, visited, {
        includeDependencies: true,
      });
    }
  }
}

function resolveInstalledPackage(fromDir, packageName) {
  let current = fromDir;
  try {
    if (!lstatSync(current).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  while (true) {
    const candidate = path.join(current, "node_modules", packageName);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function mergePackage(packages, manifest, packageDir) {
  const key = `${manifest.name}@${manifest.version}`;
  const licenseFiles = collectLicenseFiles(packageDir);
  const hasPackageLicenseText = licenseFiles.some((file) => file.kind === "package");
  const existing = packages.get(key);
  if (existing) {
    for (const file of licenseFiles) {
      if (
        !existing.licenseFiles.some(
          (candidate) =>
            candidate.name === file.name && candidate.content === file.content,
        )
      ) {
        existing.licenseFiles.push(file);
      }
    }
    existing.licenseFiles.sort(compareLicenseFiles);
    existing.hasPackageLicenseText ||= hasPackageLicenseText;
    return;
  }
  packages.set(key, {
    name: manifest.name,
    version: manifest.version,
    license: normalizeLicense(manifest.license),
    repository: normalizeRepository(manifest.repository),
    licenseFiles,
    hasPackageLicenseText,
  });
}

export function isLicenseFileName(name) {
  const normalized = name.toLowerCase();
  if (/^licenses\.chromium\.html?$/.test(normalized)) return true;
  if (
    /^(?:licen[cs]es?|copying|notices?|copyrights?|unlicense)(?:\.(?:txt|md|markdown|html?|rst))?$/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /^(?:copyrightnotice|third[-_ ]?party[-_ ]?(?:licen[cs]es?|notices?)|thirdpartynoticetext)(?:\.(?:txt|md|markdown|html?|rst))?$/.test(
      normalized,
    )
  ) {
    return true;
  }
  return /^(?:licen[cs]e)[-_. ](?:mit|apache|bsd|mpl|gpl|lgpl|agpl|isc|ofl|cc|chromium)(?:[-_. 0-9a-z]*?)(?:\.(?:txt|md|markdown|html?|rst))?$/.test(
    normalized,
  );
}

function collectLicenseFiles(packageDir) {
  const files = [];
  visit(packageDir, "");
  return files.sort(compareLicenseFiles);

  function visit(dir, relativeDir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) =>
      compareText(left.name, right.name)
    )) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") visit(absolutePath, relativePath);
      } else if (entry.isFile() && isLicenseFileName(entry.name)) {
        files.push({
          name: relativePath,
          content: readFileSync(absolutePath, "utf8"),
          kind: relativeDir ? "vendored" : "package",
        });
      }
    }
  }
}

function normalizeLicense(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.type === "string") return value.type;
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeLicense(entry))
      .filter(Boolean)
      .join(" OR ");
  }
  return "Not declared";
}

function normalizeRepository(value) {
  if (typeof value === "string") return value;
  return value && typeof value.url === "string" ? value.url : undefined;
}

function formatPackage(pkg) {
  const lines = [
    "=".repeat(80),
    `${pkg.name}@${pkg.version}`,
    `Declared license: ${pkg.license}`,
    ...(pkg.repository ? [`Repository: ${pkg.repository}`] : []),
  ];
  if (!pkg.hasPackageLicenseText) {
    lines.push("No package-level license file was included in the installed package.");
  }
  for (const file of pkg.licenseFiles) {
    const label = file.kind === "package"
      ? file.name
      : `Vendored component attribution: ${file.name}`;
    lines.push("", `--- ${label} ---`, file.content.trimEnd());
  }
  lines.push("");
  return lines.join("\n");
}

function comparePackages(left, right) {
  return compareText(
    `${left.name}@${left.version}`,
    `${right.name}@${right.version}`,
  );
}

function compareLicenseFiles(left, right) {
  return compareText(
    `${left.name}\0${left.content}`,
    `${right.name}\0${right.content}`,
  );
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCli(args) {
  let artifact;
  let outputFile;
  const pluginNodeModulesDirs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--artifact") {
      artifact = args[++index];
    } else if (arg === "--plugin-node-modules") {
      pluginNodeModulesDirs.push(path.resolve(args[++index]));
    } else if (!outputFile) {
      outputFile = path.resolve(arg);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (!artifact || !outputFile) {
    throw new Error(
      "usage: node scripts/third-party-licenses.mjs --artifact <backend|desktop> <output-file> [--plugin-node-modules <dir> ...]",
    );
  }
  return { artifact, outputFile, pluginNodeModulesDirs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { artifact, outputFile, pluginNodeModulesDirs } = parseCli(
    process.argv.slice(2),
  );
  const result = generateThirdPartyLicenses(outputFile, {
    artifact,
    pluginNodeModulesDirs,
  });
  if (result.missingLicenseTexts.length > 0) {
    console.warn(
      `[third-party-licenses] ${result.missingLicenseTexts.length} package(s) did not include package-level license text`,
    );
  }
}
