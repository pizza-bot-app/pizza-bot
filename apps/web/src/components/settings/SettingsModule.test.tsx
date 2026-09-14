import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsModule } from "./SettingsModule.js";

function renderSettings(maxToolCalls: number, maxSubagentToolCalls: number): string {
  return renderToStaticMarkup(
    <SettingsModule
      client={{} as never}
      theme="dark"
      onThemeChange={vi.fn()}
      persona=""
      personaStatus="idle"
      onPersonaChange={vi.fn()}
      onPersonaSave={vi.fn()}
      providers={[]}
      models={{ models: [] } as never}
      allModels={{ models: [] } as never}
      defaultModel={null}
      onProviderSave={async () => undefined}
      onProviderRemove={async () => undefined}
      onRetryModels={async () => undefined}
      onSetDefaultModel={async () => undefined}
      enableMemories={false}
      enableAutomations={false}
      onFeatureToggle={vi.fn()}
      maxToolCalls={maxToolCalls}
      maxSubagentToolCalls={maxSubagentToolCalls}
      onToolCallLimitChange={vi.fn()}
      notificationsAvailable={false}
      notifyOnRunCompletion={false}
      notifyOnActionRequired={false}
      onNotificationToggle={vi.fn()}
      category="general"
      onCategoryChange={vi.fn()}
      runningCount={0}
    />,
  );
}

describe("SettingsModule tool-call limit", () => {
  it("shows separate limits for the orchestrator and subagents", () => {
    const html = renderSettings(40, 80);

    expect(html).toContain('aria-label="Orchestrator tool calls per response"');
    expect(html).toContain('aria-label="Subagent tool calls per task"');
    expect(html.match(/placeholder="No limit"/g)).toHaveLength(2);
    expect(html.match(/Leave empty for no limit\./g)).toHaveLength(2);
  });

  // A number input reports "" for text it cannot parse, which the field must not read
  // as the empty "no limit" state.
  it("takes the raw draft rather than delegating parsing to a number input", () => {
    const html = renderSettings(40, 80);

    expect(html).not.toContain('type="number"');
    expect(html.match(/inputMode="numeric"/g)).toHaveLength(2);
  });

  it("shows an empty field when a limit is disabled", () => {
    const html = renderSettings(-1, -1);

    expect(html).toMatch(
      /<input(?=[^>]*aria-label="Orchestrator tool calls per response")(?=[^>]*value="")[^>]*>/,
    );
    expect(html).toMatch(
      /<input(?=[^>]*aria-label="Subagent tool calls per task")(?=[^>]*value="")[^>]*>/,
    );
  });

  it("reports no validation error until a draft is rejected", () => {
    const html = renderSettings(40, 80);

    expect(html).not.toContain("aria-invalid=\"true\"");
    expect(html).not.toContain("Enter a whole number");
  });
});
