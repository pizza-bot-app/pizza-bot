import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveLayout } from "./layout.js";

describe("data root layout", () => {
  it("places checkpoints and store as sqlite under the root", () => {
    const l = resolveLayout("/data");
    expect(l.checkpointsDb).toBe(join("/data", "checkpoints.sqlite"));
    expect(l.storeDb).toBe(join("/data", "store.sqlite"));
    expect(l.mcpConfig).toBe(join("/data", ".mcp.json"));
    expect(l.pluginMaterializationsDir).toBe(
      join("/data", "plugin-materializations"),
    );
    expect(l.skillsDir).toBe(join("/data", "skills"));
    expect(l.logsDir).toBe(join("/data", "logs"));
  });
});
