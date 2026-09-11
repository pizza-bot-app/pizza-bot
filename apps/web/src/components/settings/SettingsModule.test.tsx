import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsModule } from "./SettingsModule.js";

function renderSettings(maxToolCalls: number, maxSkillToolCalls: number): string {
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
      onMaxToolCallsChange={vi.fn()}
      maxSkillToolCalls={maxSkillToolCalls}
      onMaxSkillToolCallsChange={vi.fn()}
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
  it("shows separate limits for Pizza Bot and skill agents", () => {
    const html = renderSettings(40, 80);

    expect(html).toContain('aria-label="Pizza Bot tool calls per run"');
    expect(html).toContain('aria-label="Skill agent tool calls per run"');
    expect(html.match(/type="number" min="1"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="No limit: Pizza Bot tool calls per run"');
    expect(html).toContain('aria-label="No limit: Skill agent tool calls per run"');
  });

  it("disables each number field when its no-limit toggle is selected", () => {
    const html = renderSettings(-1, -1);

    expect(html).toMatch(/<input(?=[^>]*aria-label="Pizza Bot tool calls per run")(?=[^>]*disabled="")[^>]*>/);
    expect(html).toMatch(/<input(?=[^>]*aria-label="Skill agent tool calls per run")(?=[^>]*disabled="")[^>]*>/);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(2);
  });
});
