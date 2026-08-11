import { describe, expect, it } from "vitest";
import { openAppDatabase } from "./app-db.js";

describe("CapabilityPreferencesStore", () => {
  it("stores enablement independently by kind, source, and id", () => {
    const app = openAppDatabase(":memory:");
    const pluginSkill = { kind: "skill" as const, source: "plugin:calendar", id: "review" };
    const userSkill = { kind: "skill" as const, source: "user", id: "review" };
    const pluginMcp = { kind: "mcp" as const, source: "plugin:calendar", id: "review" };

    expect(app.capabilityPreferences.get(pluginSkill)).toBeUndefined();
    app.capabilityPreferences.set(pluginSkill, false);
    app.capabilityPreferences.set(userSkill, true);
    app.capabilityPreferences.set(pluginMcp, true);

    expect(app.capabilityPreferences.get(pluginSkill)).toBe(false);
    expect(app.capabilityPreferences.get(userSkill)).toBe(true);
    expect(app.capabilityPreferences.get(pluginMcp)).toBe(true);
    app.close();
  });

  it("deletes an override so the source default can apply again", () => {
    const app = openAppDatabase(":memory:");
    const key = { kind: "mcp" as const, source: "user", id: "mail" };
    app.capabilityPreferences.set(key, false);
    app.capabilityPreferences.delete(key);
    expect(app.capabilityPreferences.get(key)).toBeUndefined();
    app.close();
  });

  it("deletes all preferences owned by a removed plugin", () => {
    const app = openAppDatabase(":memory:");
    app.capabilityPreferences.set(
      { kind: "skill", source: "plugin:calendar", id: "review" },
      false,
    );
    app.capabilityPreferences.set(
      { kind: "mcp", source: "plugin:calendar", id: "calendar" },
      false,
    );
    app.capabilityPreferences.set(
      { kind: "mcp", source: "user", id: "calendar" },
      false,
    );

    app.capabilityPreferences.deleteSource("plugin:calendar");

    expect(
      app.capabilityPreferences.get({
        kind: "skill",
        source: "plugin:calendar",
        id: "review",
      }),
    ).toBeUndefined();
    expect(
      app.capabilityPreferences.get({
        kind: "mcp",
        source: "plugin:calendar",
        id: "calendar",
      }),
    ).toBeUndefined();
    expect(
      app.capabilityPreferences.get({
        kind: "mcp",
        source: "user",
        id: "calendar",
      }),
    ).toBe(false);
    app.close();
  });
});
