import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsModule } from "./SettingsModule.js";

function renderSettings(maxToolCalls: number): string {
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
  it("shows a positive number field and a separate no-limit switch", () => {
    const html = renderSettings(40);

    expect(html).toContain('aria-label="Tool calls per run"');
    expect(html).toContain('type="number" min="1"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="No limit"');
    expect(html).toContain('aria-checked="false"');
  });

  it("disables the number field when no limit is selected", () => {
    const html = renderSettings(-1);

    expect(html).toMatch(/<input(?=[^>]*aria-label="Tool calls per run")(?=[^>]*disabled="")[^>]*>/);
    expect(html).toContain('aria-label="No limit"');
    expect(html).toContain('aria-checked="true"');
  });
});
