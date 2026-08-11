import { describe, expect, it, vi } from "vitest";
import type { TriggerDef } from "@pizza-bot/core";
import {
  WEBHOOK_SECRET_PLACEHOLDER,
  curlWebhookSecret,
  initialWebhookSecret,
} from "./webhook-secret.js";

const existingWebhook: TriggerDef = {
  id: "trg_existing",
  kind: "webhook",
  enabled: true,
  hasWebhookSecret: true,
  createdAt: "2026-08-08T00:00:00.000Z",
};

describe("webhook secret editor state", () => {
  it("does not invent a secret when an existing webhook is opened", () => {
    const generate = vi.fn(() => "generated-secret");

    expect(initialWebhookSecret("webhook", existingWebhook, generate)).toBe("");
    expect(generate).not.toHaveBeenCalled();
  });

  it("generates a secret for a new webhook", () => {
    expect(initialWebhookSecret("webhook", null, () => "generated-secret")).toBe(
      "generated-secret",
    );
  });

  it("retains a secret revealed during the current editor session", () => {
    expect(
      initialWebhookSecret(
        "webhook",
        { ...existingWebhook, webhookSecret: "saved-in-this-session" },
        () => "unused",
      ),
    ).toBe("saved-in-this-session");
  });

  it("does not put an unsaved replacement into the curl sample", () => {
    expect(curlWebhookSecret("unsaved-replacement", true)).toBe(
      WEBHOOK_SECRET_PLACEHOLDER,
    );
    expect(curlWebhookSecret("active-secret", false)).toBe("active-secret");
  });
});
