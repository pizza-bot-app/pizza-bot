import { useEffect, useId, useState } from "react";
import {
  KeyRound,
  FolderOpen,
  LayoutGrid,
  Monitor,
  Moon,
  Server,
  Settings,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import type { ProviderView, ModelsInfo, StatusInfo } from "@/api-client";
import { ModuleHeader } from "../ModuleHeader.js";
import { getProviderStatus, ProvidersSettings } from "./ProvidersSettings.js";
import { L } from "../../lexicon.js";
import { providerLabel } from "../../model-options.js";
import type { ThemePreference } from "../../theme-storage.js";
import type { DesktopConnection } from "../../use-desktop-connection.js";
import type { ToolCallLimitKey } from "../../use-settings.js";
import { ConnectionSettings } from "./ConnectionSettings.js";
import { LocalFoldersSettings } from "./LocalFoldersSettings.js";
import { resolveToolCallLimitEdit, toolCallLimitDraft } from "./tool-call-limit.js";
import type { ApiClient } from "@/api-client";

export interface SettingsModuleProps {
  client: ApiClient;
  theme: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
  persona: string;
  personaStatus: "idle" | "saving" | "saved" | "error";
  onPersonaChange: (next: string) => void;
  onPersonaSave: () => void;
  providers: ProviderView[];
  providerStatuses?: StatusInfo["inference"]["providers"];
  models: ModelsInfo;
  allModels: ModelsInfo;
  defaultModel: string | null;
  onProviderSave: (
    id: string,
    config: { method: string; values: Record<string, string> },
    preferences: import("@/api-client").ProviderModelPreferences,
  ) => Promise<unknown>;
  onProviderRemove: (id: string) => Promise<unknown>;
  onRetryModels: () => Promise<unknown>;
  onSetDefaultModel: (model: string | null) => Promise<unknown>;
  enableMemories: boolean;
  enableAutomations: boolean;
  onFeatureToggle: (key: "enableMemories" | "enableAutomations", value: boolean) => void;
  maxToolCalls: number;
  maxSubagentToolCalls: number;
  onToolCallLimitChange: (key: ToolCallLimitKey, value: number) => void;
  notificationsAvailable: boolean;
  notifyOnRunCompletion: boolean;
  notifyOnActionRequired: boolean;
  onNotificationToggle: (
    key: "notifyOnRunCompletion" | "notifyOnActionRequired",
    value: boolean,
  ) => void;
  category: SettingsCategory;
  onCategoryChange: (category: SettingsCategory) => void;
  connection?: DesktopConnection;
  runningCount: number;
}

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: L.themeLight, icon: Sun },
  { value: "dark", label: L.themeDark, icon: Moon },
  { value: "system", label: L.themeSystem, icon: Monitor },
];

export type SettingsCategory = "general" | "providers" | "files" | "connection";

const SETTINGS_CATEGORIES: {
  id: SettingsCategory;
  label: string;
  icon: typeof Settings;
}[] = [
  { id: "general", label: L.settingsGeneralCategory, icon: Settings },
  { id: "providers", label: L.settingsProvidersCategory, icon: KeyRound },
  { id: "files", label: L.settingsFilesCategory, icon: FolderOpen },
];

interface ToolCallLimitSettingProps {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
}

function ToolCallLimitSetting({ label, hint, value, onChange }: ToolCallLimitSettingProps) {
  const [draft, setDraft] = useState(() => toolCallLimitDraft(value));
  const [invalid, setInvalid] = useState(false);
  const errorId = `${useId()}-error`;

  useEffect(() => {
    setDraft(toolCallLimitDraft(value));
    setInvalid(false);
  }, [value]);

  // A text input keeps the raw draft: `type="number"` reports "" for text it cannot
  // parse ("1e", "-"), which is indistinguishable from the empty "no limit" field.
  const save = () => {
    const edit = resolveToolCallLimitEdit(draft, value);
    setInvalid(edit.kind === "invalid");
    if (edit.kind === "invalid") return;
    setDraft(toolCallLimitDraft(edit.kind === "save" ? edit.value : value));
    if (edit.kind === "save") onChange(edit.value);
  };

  return (
    <div className="settings-row settings-row-adaptive">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        <div className="settings-row-hint">{hint}</div>
        {invalid && (
          <div className="settings-row-hint error" id={errorId}>
            {L.toolCallLimitInvalid}
          </div>
        )}
      </div>
      <div className="settings-limit-control">
        <input
          className={`settings-number-input${invalid ? " invalid" : ""}`}
          type="text"
          inputMode="numeric"
          value={draft}
          placeholder={L.noToolCallLimitLabel}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          aria-label={label}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
        />
      </div>
    </div>
  );
}

export function SettingsModule({
  client,
  theme,
  onThemeChange,
  persona,
  personaStatus,
  onPersonaChange,
  onPersonaSave,
  providers,
  providerStatuses,
  models,
  allModels,
  defaultModel,
  onProviderSave,
  onProviderRemove,
  onRetryModels,
  onSetDefaultModel,
  enableMemories,
  enableAutomations,
  onFeatureToggle,
  maxToolCalls,
  maxSubagentToolCalls,
  onToolCallLimitChange,
  notificationsAvailable,
  notifyOnRunCompletion,
  notifyOnActionRequired,
  onNotificationToggle,
  category,
  onCategoryChange,
  connection,
  runningCount,
}: SettingsModuleProps) {
  const [providerId, setProviderId] = useState<string | null>(null);
  const selectedProviderId = providers.some((provider) => provider.id === providerId)
    ? providerId
    : null;

  const showProviders = (nextProviderId: string | null) => {
    onCategoryChange("providers");
    setProviderId(nextProviderId);
  };
  const categories = connection
    ? [
        ...SETTINGS_CATEGORIES,
        { id: "connection" as const, label: L.settingsConnectionCategory, icon: Server },
      ]
    : SETTINGS_CATEGORIES;

  return (
    <div className="module">
      <ModuleHeader icon={<SlidersHorizontal size={18} />} title={L.settingsSection} />
      <div className="module-body settings-module-body">
        <nav className="settings-nav" aria-label={L.settingsCategoriesLabel}>
          {categories.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`settings-nav-item${category === id ? " active" : ""}`}
              aria-current={
                category === id && (id !== "providers" || selectedProviderId === null)
                  ? "page"
                  : undefined
              }
              aria-expanded={id === "providers" ? category === "providers" : undefined}
              onClick={() => {
                if (id === "providers") showProviders(null);
                else onCategoryChange(id);
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
          {category === "providers" && (
            <div
              className="settings-provider-nav"
              role="group"
              aria-label={L.providerNavigationLabel}
            >
              <button
                type="button"
                className={`settings-provider-nav-item${selectedProviderId === null ? " active" : ""}`}
                aria-current={selectedProviderId === null ? "page" : undefined}
                onClick={() => setProviderId(null)}
              >
                <LayoutGrid size={14} />
                <span>{L.providerOverview}</span>
              </button>
              {providers.map((provider) => {
                const status = getProviderStatus(
                  provider,
                  allModels.providers?.find((catalog) => catalog.provider === provider.id),
                  providerStatuses?.find((candidate) => candidate.name === provider.id),
                );
                return (
                  <button
                    type="button"
                    key={provider.id}
                    className={`settings-provider-nav-item${
                      selectedProviderId === provider.id ? " active" : ""
                    }`}
                    aria-current={selectedProviderId === provider.id ? "page" : undefined}
                    onClick={() => setProviderId(provider.id)}
                    title={`${providerLabel(provider.id)}: ${status.label}`}
                    aria-label={`${providerLabel(provider.id)}: ${status.label}`}
                  >
                    <span
                      className={`settings-provider-status-dot ${status.tone}`}
                      aria-hidden="true"
                    />
                    <span>{providerLabel(provider.id)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </nav>
        <div className="settings-body">
          {category === "general" ? (
            <>
              <section className="settings-group">
                <h2 className="settings-group-title">{L.appearanceTitle}</h2>
                <div className="settings-row settings-row-adaptive">
                  <div className="settings-row-text">
                    <div className="settings-row-label">{L.themeLabel}</div>
                    <div className="settings-row-hint">{L.themeHint}</div>
                  </div>
                  <div className="segmented settings-theme-toggle" role="group" aria-label={L.themeLabel}>
                    {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                      <button
                        key={value}
                        className={`segmented-btn${theme === value ? " active" : ""}`}
                        aria-pressed={theme === value}
                        onClick={() => onThemeChange(value)}
                      >
                        <Icon size={14} /> {label}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="settings-group">
                <h2 className="settings-group-title">{L.personaTitle}</h2>
                <div className="settings-row settings-row-stacked">
                  <div className="settings-row-text">
                    <div className="settings-row-label">{L.personaLabel}</div>
                    <div className="settings-row-hint">{L.personaHint}</div>
                  </div>
                  <textarea
                    className="settings-persona-input"
                    rows={5}
                    value={persona}
                    placeholder={L.personaPlaceholder}
                    onChange={(e) => onPersonaChange(e.target.value)}
                    onBlur={onPersonaSave}
                    aria-label={L.personaLabel}
                  />
                  <div className="settings-persona-status" aria-live="polite">
                    {personaStatus === "saving" ? L.personaSaving : personaStatus === "saved" ? L.personaSaved : ""}
                  </div>
                </div>
              </section>

              <section className="settings-group settings-stack">
                <h2 className="settings-group-title">{L.featuresTitle}</h2>
                {(
                  [
                    { key: "enableMemories", label: L.enableMemoriesLabel, hint: L.enableMemoriesHint, value: enableMemories },
                    { key: "enableAutomations", label: L.enableAutomationsLabel, hint: L.enableAutomationsHint, value: enableAutomations },
                  ] as const
                ).map(({ key, label, hint, value }) => (
                  <div className="settings-row" key={key}>
                    <div className="settings-row-text">
                      <div className="settings-row-label">{label}</div>
                      <div className="settings-row-hint">{hint}</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      className="switch"
                      aria-checked={value}
                      aria-label={label}
                      onClick={() => onFeatureToggle(key, !value)}
                    />
                  </div>
                ))}
              </section>

              <section className="settings-group settings-stack">
                <h2 className="settings-group-title">{L.agentTitle}</h2>
                <ToolCallLimitSetting
                  label={L.maxToolCallsLabel}
                  hint={L.maxToolCallsHint}
                  value={maxToolCalls}
                  onChange={(value) => onToolCallLimitChange("maxToolCalls", value)}
                />
                <ToolCallLimitSetting
                  label={L.maxSubagentToolCallsLabel}
                  hint={L.maxSubagentToolCallsHint}
                  value={maxSubagentToolCalls}
                  onChange={(value) => onToolCallLimitChange("maxSubagentToolCalls", value)}
                />
              </section>

              {notificationsAvailable && (
                <section className="settings-group settings-stack">
                  <h2 className="settings-group-title">{L.notificationsTitle}</h2>
                  {(
                    [
                      {
                        key: "notifyOnRunCompletion",
                        label: L.notifyOnRunCompletionLabel,
                        hint: L.notifyOnRunCompletionHint,
                        value: notifyOnRunCompletion,
                      },
                      {
                        key: "notifyOnActionRequired",
                        label: L.notifyOnActionRequiredLabel,
                        hint: L.notifyOnActionRequiredHint,
                        value: notifyOnActionRequired,
                      },
                    ] as const
                  ).map(({ key, label, hint, value }) => (
                    <div className="settings-row" key={key}>
                      <div className="settings-row-text">
                        <div className="settings-row-label">{label}</div>
                        <div className="settings-row-hint">{hint}</div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        className="switch"
                        aria-checked={value}
                        aria-label={label}
                        onClick={() => onNotificationToggle(key, !value)}
                      />
                    </div>
                  ))}
                </section>
              )}
            </>
          ) : category === "providers" ? (
            <ProvidersSettings
              providers={providers}
              providerStatuses={providerStatuses}
              models={models}
              allModels={allModels}
              defaultModel={defaultModel}
              onSave={onProviderSave}
              onRemove={onProviderRemove}
              onRetryModels={onRetryModels}
              onSetDefault={onSetDefaultModel}
              selectedProviderId={selectedProviderId}
              onSelectProvider={setProviderId}
            />
          ) : category === "files" ? (
            <LocalFoldersSettings
              client={client}
              canPickDirectory={connection?.state?.mode === "local"}
            />
          ) : connection ? (
            <ConnectionSettings connection={connection} runningCount={runningCount} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
