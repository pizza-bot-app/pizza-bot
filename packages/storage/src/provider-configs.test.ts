import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ProviderConfigStore } from "./provider-configs.js";

describe("ProviderConfigStore model preferences", () => {
  it("persists, de-duplicates, and removes preferences", () => {
    const db = new Database(":memory:");
    const store = new ProviderConfigStore(db);

    store.setModelPreferences("openai", {
      mode: "selected",
      selected: ["gpt-5", "gpt-5", "gpt-4.1"],
    });
    expect(store.getModelPreferences("openai")).toEqual({
      mode: "selected",
      selected: ["gpt-5", "gpt-4.1"],
    });

    store.removeModelPreferences("openai");
    expect(store.getModelPreferences("openai")).toBeUndefined();
    db.close();
  });

  it("ignores corrupt persisted preferences", () => {
    const db = new Database(":memory:");
    const store = new ProviderConfigStore(db);
    db.prepare(
      "INSERT INTO provider_model_preferences (provider_id, preferences, updated_at) VALUES (?, ?, ?)",
    ).run("openai", "{\"mode\":\"selected\",\"selected\":\"nope\"}", new Date().toISOString());

    expect(store.getModelPreferences("openai")).toBeUndefined();
    db.close();
  });
});
