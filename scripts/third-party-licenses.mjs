/** Generates the dependency license inventory shipped with binary artifacts. */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function generateThirdPartyLicenses(outputFile) {
  const packages = new Map();
  visitNodeModules(path.join(repoRoot, "node_modules"), packages);

  const sections = [...packages.values()]
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
    )
    .map(formatPackage);
  const output = [
    "Pizza Bot OSS - Third-Party Licenses",
    "",
    "This inventory is generated from the dependency tree used to build the artifact.",
    "Project-specific notices remain in NOTICE.",
    "",
    ...sections,
  ].join("\n");

  mkdirSync(path.dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, output);
}

function visitNodeModules(nodeModulesDir, packages) {
  let entries;
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".bin") continue;
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const scoped of readdirSync(entryPath, { withFileTypes: true })) {
        if (scoped.isDirectory()) collectPackage(path.join(entryPath, scoped.name), packages);
      }
      continue;
    }
    if (entry.isDirectory()) collectPackage(entryPath, packages);
  }
}

function collectPackage(packageDir, packages) {
  const manifestPath = path.join(packageDir, "package.json");
  let manifest;
  try {
    if (lstatSync(packageDir).isSymbolicLink()) return;
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return;
  }
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return;

  const key = `${manifest.name}@${manifest.version}`;
  if (!packages.has(key)) {
    const licenseFiles = readdirSync(packageDir)
      .filter((name) => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name))
      .sort()
      .map((name) => ({
        name,
        content: readFileSync(path.join(packageDir, name), "utf8"),
      }));
    packages.set(key, {
      name: manifest.name,
      version: manifest.version,
      license: normalizeLicense(manifest.license),
      repository: normalizeRepository(manifest.repository),
      licenseFiles,
    });
  }
  visitNodeModules(path.join(packageDir, "node_modules"), packages);
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
  if (pkg.licenseFiles.length === 0) {
    lines.push("No license file was included in the installed package.");
  } else {
    for (const file of pkg.licenseFiles) {
      lines.push("", `--- ${file.name} ---`, file.content.trimEnd());
    }
  }
  lines.push("");
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputFile = process.argv[2];
  if (!outputFile) {
    throw new Error("usage: node scripts/third-party-licenses.mjs <output-file>");
  }
  generateThirdPartyLicenses(path.resolve(outputFile));
}
