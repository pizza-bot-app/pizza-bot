import { useState } from "react";
import {
  KeyRound,
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
import { ConnectionSettings } from "./ConnectionSettings.js";

export interface SettingsModuleProps {
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
  onProviderUpdate: (id: string, config: { method: string; values: Record<string, string> }) => Promise<unknown>;
  onProviderRemove: (id: string) => Promise<unknown>;
  onProviderModelsChange: (
    id: string,
    preferences: import("@/api-client").ProviderModelPreferences,
  ) => Promise<unknown>;
  onRetryModels: () => Promise<unknown>;
  onSetDefaultModel: (model: string | null) => Promise<unknown>;
  enableMemories: boolean;
  enableAutomations: boolean;
  onFeatureToggle: (key: "enableMemories" | "enableAutomations", value: boolean) => void;
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

export type SettingsCategory = "general" | "providers" | "connection";

const SETTINGS_CATEGORIES: {
  id: SettingsCategory;
  label: string;
  icon: typeof Settings;
}[] = [
  { id: "general", label: L.settingsGeneralCategory, icon: Settings },
  { id: "providers", label: L.settingsProvidersCategory, icon: KeyRound },
];

export function SettingsModule({
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
  onProviderUpdate,
  onProviderRemove,
  onProviderModelsChange,
  onRetryModels,
  onSetDefaultModel,
  enableMemories,
  enableAutomations,
  onFeatureToggle,
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
              onUpdate={onProviderUpdate}
              onRemove={onProviderRemove}
              onSetModels={onProviderModelsChange}
              onRetryModels={onRetryModels}
              onSetDefault={onSetDefaultModel}
              selectedProviderId={selectedProviderId}
              onSelectProvider={setProviderId}
            />
          ) : connection ? (
            <ConnectionSettings connection={connection} runningCount={runningCount} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
