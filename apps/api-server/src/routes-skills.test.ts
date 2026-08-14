import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ContributionRegistry,
  FsPluginLoader,
  loadSkillCatalog,
  loadUserSkills,
  mergeSkillCatalogs,
} from "@pizza-bot/plugin-sdk";
import type { AgentHost } from "./agent-host.js";
import { skillRoutes } from "./routes-skills.js";
import { storedZip } from "./test-utils/stored-zip.js";
import { MAX_SKILL_ARCHIVE_BYTES } from "./skill-import.js";
import { multipartRequestLimit } from "./request-limits.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_FIXTURE = resolve(
  __dirname,
  "../../../examples/plugins/mcp-status",
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  skillFor: AgentHost["skillFor"] = async () => undefined,
) {
  const skillsDir = await mkdtemp(join(tmpdir(), "pizza-skill-routes-"));
  roots.push(skillsDir);
  const host = {
    skillsDirectory: async () => skillsDir,
    skillFor,
    reloadSkills: async () => {},
    clearUserSkillPreference: () => {},
  } as unknown as AgentHost;
  return { app: skillRoutes(host), skillsDir };
}

async function realPluginFixture() {
  const skillsDir = await mkdtemp(join(tmpdir(), "pizza-skill-routes-"));
  roots.push(skillsDir);

  const loader = new FsPluginLoader();
  const registry = new ContributionRegistry();
  const manifest = await loader.readManifest(
    join(PLUGIN_FIXTURE, ".claude-plugin", "plugin.json"),
  );
  await loader.load(manifest, PLUGIN_FIXTURE, registry);
  const pluginSkills = await loadSkillCatalog(registry);
  let catalog = pluginSkills;

  const host = {
    skillsDirectory: async () => skillsDir,
    skillFor: async (id: string) => catalog.get(id),
    reloadSkills: async () => {
      catalog = mergeSkillCatalogs(
        pluginSkills,
        await loadUserSkills(skillsDir),
      );
    },
    clearUserSkillPreference: () => {},
  } as unknown as AgentHost;
  return { app: skillRoutes(host), skillsDir };
}

const bundle = {
  name: "Review",
  description: "Reviews a change.",
  body: "# Review",
};

describe("skill routes", () => {
  it("rejects oversized requests before parsing multipart data", async () => {
    const { app } = await fixture();
    const response = await app.request("/skills/import", {
      method: "POST",
      headers: {
        "content-length": String(multipartRequestLimit(MAX_SKILL_ARCHIVE_BYTES) + 1),
        "content-type": "multipart/form-data; boundary=test",
      },
      body: "--test--",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "request_too_large" });
  });

  it("imports a ZIP as a custom skill without rewriting its SKILL.md", async () => {
    const { app, skillsDir } = await fixture();
    const skillMd = [
      "---",
      "name: review-change",
      "description: Review a code change.",
      "license: Apache-2.0",
      "---",
      "",
      "# Review",
      "",
      "Inspect the diff.",
      "",
    ].join("\n");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const form = new FormData();
    form.set("file", new File([
      storedZip([
        { path: "review-change/SKILL.md", content: skillMd },
        { path: "review-change/assets/icon.png", content: png },
      ]),
    ], "review-change.zip", { type: "application/zip" }));

    const response = await app.request("/skills/import", { method: "POST", body: form });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      id: "review-change",
      source: "user",
      files: [{ path: "assets/icon.png", encoding: "base64", mimeType: "image/png" }],
    });
    expect(await readFile(join(skillsDir, "review-change", "SKILL.md"), "utf8")).toBe(skillMd);
    expect(new Uint8Array(await readFile(join(skillsDir, "review-change", "assets", "icon.png"))))
      .toEqual(png);
  });

  it("does not overwrite an existing custom skill during import", async () => {
    const { app, skillsDir } = await fixture();
    const dir = join(skillsDir, "review-change");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), "original", "utf8");
    const form = new FormData();
    form.set("file", new File([
      storedZip([{
        path: "review-change/SKILL.md",
        content: "---\nname: review-change\ndescription: Review a change.\n---\n\n# Review\n",
      }]),
    ], "review-change.zip", { type: "application/zip" }));

    const response = await app.request("/skills/import", { method: "POST", body: form });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "already_exists" });
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe("original");
  });

  it("creates recursive bundle files without flattening their paths", async () => {
    const { app, skillsDir } = await fixture();
    const response = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "review",
        ...bundle,
        files: [
          { path: "scripts/run.ts", content: "run();" },
          { path: "references/api.md", content: "# API" },
        ],
      }),
    });

    expect(response.status).toBe(201);
    expect(await readFile(join(skillsDir, "review", "scripts", "run.ts"), "utf8")).toBe("run();");
    expect(await readFile(join(skillsDir, "review", "references", "api.md"), "utf8")).toBe("# API");
  });

  it("persists declared tools into the SKILL.md frontmatter", async () => {
    const { app, skillsDir } = await fixture();
    const response = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "review",
        ...bundle,
        declaredTools: ["mcp:mcp-status:get_mcp_status", "builtin:eval"],
      }),
    });

    expect(response.status).toBe(201);
    const md = await readFile(join(skillsDir, "review", "SKILL.md"), "utf8");
    expect(md).toContain(
      'tools:\n  - "mcp:mcp-status:get_mcp_status"\n  - "builtin:eval"',
    );
  });

  it("creates a user override when patching a built-in skill", async () => {
    const source = "builtin";
    const { app, skillsDir } = await fixture(async (id) =>
      id === `${source}-reviewer`
        ? {
            id,
            name: "Shipped Reviewer",
            description: "Shipped review.",
            source,
            files: [],
            declaredTools: [],
            interruptOn: {},
          }
        : undefined,
    );

    const response = await app.request(`/skills/${source}-reviewer`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Shipped Reviewer",
        description: "Customized review.",
        body: "# Review",
      }),
    });

    expect(response.status).toBe(200);
    expect(
      await readFile(
        join(skillsDir, `${source}-reviewer`, "SKILL.md"),
        "utf8",
      ),
    ).toContain('description: "Customized review."');
  });

  it("reloads a patched plugin skill as a user override with plugin provenance", async () => {
    const { app, skillsDir } = await realPluginFixture();

    const response = await app.request("/skills/health-report", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Health Report",
        description: "Customized health report.",
        body: "# Customized Health Report",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "health-report",
      description: "Customized health report.",
      source: "user",
      overrides: "plugin",
    });
    expect(
      await readFile(join(skillsDir, "health-report", "SKILL.md"), "utf8"),
    ).toContain('description: "Customized health report."');

    const reloaded = await app.request("/skills/health-report");
    expect(await reloaded.json()).toMatchObject({
      id: "health-report",
      source: "user",
      overrides: "plugin",
    });
  });

  it("continues to patch an existing standalone custom skill", async () => {
    const { app, skillsDir } = await fixture();
    const dir = join(skillsDir, "custom-reviewer");
    await mkdir(dir);
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: custom-reviewer\ndescription: Original review.\n---\n",
      "utf8",
    );

    const response = await app.request("/skills/custom-reviewer", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Custom Reviewer",
        description: "Updated review.",
        body: "# Review",
      }),
    });

    expect(response.status).toBe(200);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toContain(
      'description: "Updated review."',
    );
  });

  it.each(["builtin", "plugin"] as const)(
    "exposes the %s source hidden by a user override",
    async (overrides) => {
      const { app } = await fixture(async (id) =>
        id === "customized-reviewer"
          ? {
              id,
              name: "Customized Reviewer",
              description: "Customized review.",
              source: "user",
              overrides,
              files: [],
              declaredTools: [],
              interruptOn: {},
            }
          : undefined,
      );

      const response = await app.request("/skills/customized-reviewer");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "customized-reviewer",
        source: "user",
        overrides,
      });
    },
  );

  it("writes a spec name, display metadata, and YAML-safe description", async () => {
    const { app, skillsDir } = await fixture();
    const response = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "web-researcher",
        name: "Web Researcher",
        description: "Use for web: searching and extraction.",
        body: "# Research",
      }),
    });

    expect(response.status).toBe(201);
    const md = await readFile(join(skillsDir, "web-researcher", "SKILL.md"), "utf8");
    expect(md).toContain('name: "web-researcher"');
    expect(md).toContain('description: "Use for web: searching and extraction."');
    expect(md).toContain('metadata:\n  display-name: "Web Researcher"');
  });

  it("persists approval policy for a declared tool", async () => {
    const { app, skillsDir } = await fixture();
    const response = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "review",
        ...bundle,
        declaredTools: ["mcp:outlook:send_email"],
        interruptOn: {
          "mcp:outlook:send_email": {
            allowedDecisions: ["approve", "edit", "reject"],
          },
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      interruptOn: {
        "mcp:outlook:send_email": {
          allowedDecisions: ["approve", "edit", "reject"],
        },
      },
    });
    const md = await readFile(join(skillsDir, "review", "SKILL.md"), "utf8");
    expect(md).toContain('interruptOn:\n  "mcp:outlook:send_email":');
  });

  it("rejects approval policy for a tool the skill does not declare", async () => {
    const { app } = await fixture();
    const response = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "review",
        ...bundle,
        declaredTools: [],
        interruptOn: { "mcp:outlook:send_email": true },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid",
      detail: expect.stringContaining("is not declared"),
    });
  });

  it("rejects a malformed tool ref", async () => {
    const { app } = await fixture();
    const response = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "review", ...bundle, declaredTools: ["not-a-ref"] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid" });
  });

  it("round-trips binary bundle files as base64 without changing bytes", async () => {
    const { app, skillsDir } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const response = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "review",
        ...bundle,
        files: [
          {
            path: "assets/sample.png",
            content: Buffer.from(png).toString("base64"),
            encoding: "base64",
            mimeType: "image/png",
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    expect(new Uint8Array(await readFile(join(skillsDir, "review", "assets", "sample.png"))))
      .toEqual(png);
    expect(await response.json()).toMatchObject({
      files: [
        {
          path: "assets/sample.png",
          content: Buffer.from(png).toString("base64"),
          encoding: "base64",
          mimeType: "image/png",
        },
      ],
    });
  });

  it("rejects malformed base64 without replacing an existing bundle", async () => {
    const { app, skillsDir } = await fixture();
    const dir = join(skillsDir, "review");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), "original", "utf8");

    const response = await app.request("/skills/review", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...bundle,
        files: [{ path: "assets/sample.png", content: "not base64!", encoding: "base64" }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe("original");
  });

  it.each([
    "../outside.md",
    "scripts/../../outside.md",
    "/tmp/outside.md",
    "C:\\tmp\\outside.md",
    "\\\\server\\share\\outside.md",
  ])("rejects non-portable or escaping bundle path %s", async (path) => {
    const { app } = await fixture();
    const response = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "review",
        ...bundle,
        files: [{ path, content: "no" }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid" });
  });

  it("validates route IDs before touching the filesystem", async () => {
    const { app } = await fixture();
    const response = await app.request("/skills/bad$id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_id" });
  });

  it("does not replace an existing bundle when a nested path is invalid", async () => {
    const { app, skillsDir } = await fixture();
    const dir = join(skillsDir, "review");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), "original", "utf8");

    const response = await app.request("/skills/review", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...bundle,
        files: [{ path: "C:\\tmp\\outside.md", content: "no" }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe("original");
  });
});
