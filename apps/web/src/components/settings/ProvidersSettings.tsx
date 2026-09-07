import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import { SECRET_UNCHANGED } from "@/api-client";
import type {
  ProviderView,
  ProviderConfigView,
  ProviderModelPreferences,
  ModelsInfo,
  StatusInfo,
} from "@/api-client";
import type {
  ModelCatalogStatus,
  ProviderAuthField,
  ProviderAuthMethod,
} from "@pizza-bot/core";
import { isEnvReference } from "@pizza-bot/core";
import { L } from "../../lexicon.js";
import { groupModelsByProvider, providerLabel } from "../../model-options.js";
import { useAppToast } from "../AppToast.js";

// Secret inputs never receive stored values. Desktop stores raw keys in the OS
// keychain; browser mode accepts only an environment-variable reference.
export interface ProvidersSettingsProps {
  providers: ProviderView[];
  models: ModelsInfo;
  allModels: ModelsInfo;
  defaultModel: string | null;
  onSave: (
    id: string,
    config: { method: string; values: Record<string, string> },
    preferences: ProviderModelPreferences,
  ) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
  onRetryModels: () => Promise<unknown>;
  onSetDefault: (model: string | null) => Promise<unknown>;
  selectedProviderId: string | null;
  onSelectProvider: (id: string | null) => void;
  providerStatuses?: StatusInfo["inference"]["providers"];
}

export function getProviderStatus(
  provider: ProviderView,
  catalog?: ModelCatalogStatus,
  health?: StatusInfo["inference"]["providers"][number],
): {
  label: string;
  tone: "configured" | "available" | "unconfigured" | "unavailable" | "error";
} {
  if (providerHasUnavailableSecret(provider)) {
    return { label: L.providerNeedsAttentionBadge, tone: "error" };
  }
  if (catalog?.status === "error" && (provider.config || provider.availableWithoutConfig)) {
    return {
      label: L.providerUnavailableBadge,
      tone: provider.config ? "error" : "unavailable",
    };
  }
  if (health?.status === "unavailable") {
    return { label: L.providerUnavailableBadge, tone: "unavailable" };
  }
  if (provider.config) return { label: L.providerConfiguredBadge, tone: "configured" };
  if (provider.availableWithoutConfig) {
    return { label: L.providerAvailableBadge, tone: "available" };
  }
  return { label: L.providerNotConfiguredBadge, tone: "unconfigured" };
}

export function ProvidersSettings({
  providers,
  models,
  allModels,
  defaultModel,
  onSave,
  onRemove,
  onRetryModels,
  onSetDefault,
  selectedProviderId,
  onSelectProvider,
  providerStatuses,
}: ProvidersSettingsProps) {
  return (
    <section className="settings-group">
      <h2 className="settings-group-title">{L.providersTitle}</h2>

      <div className="settings-provider-overview-panel" hidden={selectedProviderId !== null}>
        <DefaultModelRow models={models} defaultModel={defaultModel} onSetDefault={onSetDefault} />
        <div className="settings-provider-overview">
          {providers.map((provider) => (
            <ProviderSummary
              key={provider.id}
              provider={provider}
              catalog={allModels.providers?.find((catalog) => catalog.provider === provider.id)}
              modelCount={allModels.models.filter((model) => model.provider === provider.id).length}
              health={providerStatuses?.find((status) => status.name === provider.id)}
              onSelect={() => onSelectProvider(provider.id)}
            />
          ))}
        </div>
      </div>

      {providers.map((p) => (
        <div key={p.id} className="settings-provider-panel" hidden={selectedProviderId !== p.id}>
          <button
            type="button"
            className="module-detail-back settings-provider-back"
            onClick={() => onSelectProvider(null)}
          >
            <ArrowLeft size={15} />
            {L.providersTitle}
          </button>
          <ProviderRow
            provider={p}
            models={allModels.models.filter((model) => model.provider === p.id)}
            catalog={allModels.providers?.find((catalog) => catalog.provider === p.id)}
            onSave={onSave}
            onRemove={onRemove}
            onRetryModels={onRetryModels}
          />
        </div>
      ))}
    </section>
  );
}

function ProviderSummary({
  provider,
  catalog,
  modelCount,
  health,
  onSelect,
}: {
  provider: ProviderView;
  catalog?: ModelCatalogStatus;
  modelCount: number;
  health?: StatusInfo["inference"]["providers"][number];
  onSelect: () => void;
}) {
  const status = getProviderStatus(provider, catalog, health);
  const modelSummary =
    provider.modelPreferences.mode === "selected"
      ? `${provider.modelPreferences.selected.length} selected`
      : `${modelCount} model${modelCount === 1 ? "" : "s"}`;

  return (
    <button type="button" className="settings-provider-summary" onClick={onSelect}>
      <span className="settings-provider-summary-main">
        <span className="settings-provider-summary-heading">
          <span className="settings-provider-name">{providerLabel(provider.id)}</span>
          <span className={`provenance-badge ${status.tone}`}>{status.label}</span>
        </span>
        <span className="settings-row-hint">{modelSummary}</span>
      </span>
      <ChevronRight size={17} aria-hidden="true" />
    </button>
  );
}

function DefaultModelRow({
  models,
  defaultModel,
  onSetDefault,
}: {
  models: ModelsInfo;
  defaultModel: string | null;
  onSetDefault: (model: string | null) => Promise<unknown>;
}) {
  const notify = useAppToast();
  const [busy, setBusy] = useState(false);
  const modelGroups = groupModelsByProvider(models.models);
  const automaticModel = models.models.find((model) => model.id === models.default);
  const savedModelUnavailable =
    defaultModel !== null && !models.models.some((model) => model.id === defaultModel);
  const change = async (value: string) => {
    setBusy(true);
    try {
      await onSetDefault(value === "" ? null : value);
      notify({ title: "Default model updated", tone: "success" });
    } catch (cause) {
      notify({
        title: "Could not update default model",
        description: cause instanceof Error ? cause.message : undefined,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-row settings-row-stacked">
      <div className="settings-row-text">
        <div className="settings-row-label">{L.defaultModelLabel}</div>
        <div className="settings-row-hint">{L.defaultModelHint}</div>
      </div>
      <select
        className="field-input settings-provider-default"
        value={defaultModel ?? ""}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
      >
        <option value="">
          {L.defaultModelServerFallback}
          {automaticModel ? ` - ${automaticModel.displayName}` : ""}
        </option>
        {savedModelUnavailable && (
          <option value={defaultModel} disabled>
            {defaultModel} (currently unavailable)
          </option>
        )}
        {modelGroups.map((group) => (
          <optgroup key={group.provider} label={providerLabel(group.provider)}>
            {group.models.map(({ model }) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function ProviderRow({
  provider,
  models,
  catalog,
  onSave,
  onRemove,
  onRetryModels,
}: {
  provider: ProviderView;
  models: ModelsInfo["models"];
  catalog?: ModelCatalogStatus;
  onSave: (
    id: string,
    config: { method: string; values: Record<string, string> },
    preferences: ProviderModelPreferences,
  ) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
  onRetryModels: () => Promise<unknown>;
}) {
  const notify = useAppToast();
  const methods = provider.authSchema ?? [];
  const configured = provider.config !== undefined;
  const status = getProviderStatus(provider, catalog);

  const [methodId, setMethodId] = useState(provider.config?.method ?? methods[0]?.id ?? "");
  const method = methods.find((m) => m.id === methodId) ?? methods[0];

  const [values, setValues] = useState<Record<string, string>>(() =>
    seedValues(method, provider.config),
  );
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [modelPreferences, setModelPreferences] = useState(provider.modelPreferences);
  const localSecretStore = isDesktop();

  useEffect(() => {
    setModelPreferences(provider.modelPreferences);
  }, [provider.modelPreferences]);

  const onMethodChange = (id: string) => {
    setMethodId(id);
    setValues(seedValues(methods.find((m) => m.id === id), provider.config));
  };

  const secretHasStored = useMemo(
    () => new Set(secretKeysWithStoredValue(method, provider.config, !localSecretStore)),
    [localSecretStore, method, provider.config],
  );
  const unavailableSecrets = useMemo(
    () => new Set(secretKeysWithUnavailableValue(method, provider.config)),
    [method, provider.config],
  );

  if (!provider.configurable || !method) {
    return (
      <div className="settings-provider">
        <div className="settings-provider-head">
          <span className="settings-provider-name">{providerLabel(provider.id)}</span>
          <span className="provenance-badge">{L.providerEnvBadge}</span>
        </div>
        <p className="settings-row-hint">{L.providerEnvNote}</p>
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const unavailableSecretError = unavailableLocalSecretValidationError(
        method,
        values,
        unavailableSecrets,
        localSecretStore,
      );
      if (unavailableSecretError) throw new Error(unavailableSecretError);
      const referenceError = secretReferenceValidationError(
        method,
        values,
        localSecretStore,
      );
      if (referenceError) throw new Error(referenceError);

      const out: Record<string, string> = {};
      for (const field of method.fields) {
        const raw = (values[field.key] ?? "").trim();
        if (field.type === "password") {
          if (raw === "" && secretHasStored.has(field.key)) {
            // Blank preserves a stored secret instead of replacing it.
            out[field.key] = SECRET_UNCHANGED;
          } else if (raw !== "") {
            out[field.key] = await materializeSecret(provider.id, field.key, raw);
          }
        } else if (raw !== "") {
          out[field.key] = raw;
        }
      }
      await onSave(
        provider.id,
        { method: method.id, values: out },
        modelPreferences,
      );
      notify({ title: `${provider.id} saved`, tone: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      notify({
        title: `Could not save ${provider.id}`,
        description: e instanceof Error ? e.message : undefined,
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      await onRemove(provider.id);
      setValues(seedValues(method, undefined));
      setModelPreferences({ mode: "all", selected: [] });
      notify({ title: `${provider.id} removed`, tone: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
      notify({
        title: `Could not remove ${provider.id}`,
        description: e instanceof Error ? e.message : undefined,
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-provider">
      <div className="settings-provider-head">
        <span className="settings-provider-name">{providerLabel(provider.id)}</span>
        {(configured || status.tone === "error") && (
          <span className={`provenance-badge ${status.tone}`}>{status.label}</span>
        )}
      </div>

      {methods.length > 1 && (
        <label className="field">
          <span className="field-label">Method</span>
          <select className="field-input" value={methodId} onChange={(e) => onMethodChange(e.target.value)}>
            {methods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {method.fields.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={values[field.key] ?? ""}
          hasStored={field.type === "password" && secretHasStored.has(field.key)}
          unavailable={field.type === "password" && unavailableSecrets.has(field.key)}
          localSecretStore={localSecretStore}
          onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
        />
      ))}

      {(configured || provider.availableWithoutConfig) && (
        <ProviderModelsField
          providerId={provider.id}
          models={models}
          query={modelQuery}
          preferences={modelPreferences}
          catalog={catalog}
          catalogTone={status.tone === "error" ? "error" : "unavailable"}
          retrying={retrying}
          onQueryChange={setModelQuery}
          onChange={setModelPreferences}
          onRetry={
            catalog && catalog.status !== "ready" && catalog.retryable
              ? async () => {
                  setRetrying(true);
                  try {
                    await onRetryModels();
                  } finally {
                    setRetrying(false);
                  }
                }
              : undefined
          }
        />
      )}

      {error && <div className="schedule-editor-error">{error}</div>}

      <div className="settings-provider-actions">
        {configured && (
          <button type="button" className="btn-secondary" onClick={() => void remove()} disabled={saving}>
            {L.providerRemove}
          </button>
        )}
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? L.providerSaving : L.providerSave}
        </button>
      </div>
    </div>
  );
}

function ProviderModelsField({
  providerId,
  models,
  query,
  preferences,
  catalog,
  catalogTone,
  retrying,
  onQueryChange,
  onChange,
  onRetry,
}: {
  providerId: string;
  models: ModelsInfo["models"];
  query: string;
  preferences: ProviderModelPreferences;
  catalog?: ModelCatalogStatus;
  catalogTone: "error" | "unavailable";
  retrying: boolean;
  onQueryChange: (query: string) => void;
  onChange: (preferences: ProviderModelPreferences) => void;
  onRetry?: () => Promise<void>;
}) {
  const selected = new Set(preferences.selected);
  const normalized = query.trim().toLowerCase();
  const rawId = (qualified: string) =>
    qualified.startsWith(`${providerId}:`)
      ? qualified.slice(providerId.length + 1)
      : qualified;
  const discovered = models.map((model) => ({
    id: rawId(model.id),
    displayName: model.displayName,
    savedOnly: false,
  }));
  const discoveredIds = new Set(discovered.map((model) => model.id));
  const choices = [
    ...discovered,
    ...preferences.selected
      .filter((id) => !discoveredIds.has(id))
      .map((id) => ({ id, displayName: id, savedOnly: true })),
  ];
  const visible = choices
    .filter((model) =>
      !normalized ||
      `${model.displayName} ${model.id}`.toLowerCase().includes(normalized)
    )
    .slice(0, 100);
  const toggle = (modelId: string) => {
    const next = new Set(selected);
    if (next.has(modelId)) next.delete(modelId);
    else next.add(modelId);
    onChange({ mode: "selected", selected: [...next] });
  };

  return (
    <div className="provider-models-field">
      <div className="provider-models-heading">
        <div className="field-label">Models</div>
        {catalog && catalog.status !== "ready" && catalog.stale && (
          <span className="provenance-badge">{L.modelCatalogStaleBadge}</span>
        )}
      </div>
      {catalog && catalog.status !== "ready" && (
        <div
          className={`provider-model-catalog-error ${
            catalog.status === "degraded" ? "unavailable" : catalogTone
          }`}
          role="status"
        >
          <span>{catalog.message}</span>
          {onRetry && (
            <button
              type="button"
              className="btn-secondary provider-model-retry"
              onClick={() => void onRetry()}
              disabled={retrying}
            >
              <RefreshCw size={14} className={retrying ? "spin" : undefined} />
              {retrying ? L.modelCatalogRetrying : L.modelCatalogRetry}
            </button>
          )}
        </div>
      )}
      <div className="segmented provider-model-mode" role="group" aria-label={`${providerId} models`}>
        <button
          type="button"
          className={`segmented-btn${preferences.mode === "all" ? " active" : ""}`}
          aria-pressed={preferences.mode === "all"}
          onClick={() => onChange({ ...preferences, mode: "all" })}
        >
          All
        </button>
        <button
          type="button"
          className={`segmented-btn${preferences.mode === "selected" ? " active" : ""}`}
          aria-pressed={preferences.mode === "selected"}
          onClick={() => onChange({ ...preferences, mode: "selected" })}
        >
          Selected
          <span className="segmented-count">{preferences.selected.length}</span>
        </button>
      </div>
      {preferences.mode === "selected" && (
        <>
          <div className="sidebar-search-wrap provider-model-search">
            <Search size={15} className="sidebar-search-icon" />
            <input
              className="sidebar-search"
              aria-label={`Search ${providerId} models`}
              placeholder="Search models..."
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className="sidebar-search-clear"
                aria-label="Clear model search"
                onClick={() => onQueryChange("")}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="provider-model-list">
            {visible.length === 0 && (
              <div className="provider-model-empty">{L.modelCatalogEmpty}</div>
            )}
            {visible.map((model) => {
              return (
                <label className="provider-model-option" key={model.id}>
                  <input
                    type="checkbox"
                    checked={selected.has(model.id)}
                    onChange={() => toggle(model.id)}
                  />
                  <span>
                    {model.displayName}
                    {model.savedOnly ? ` ${L.modelCatalogSavedOnly}` : ""}
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function FieldInput({
  field,
  value,
  hasStored,
  unavailable,
  localSecretStore,
  onChange,
}: {
  field: ProviderAuthField;
  value: string;
  hasStored: boolean;
  unavailable: boolean;
  localSecretStore: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {field.label}
        {!field.required && <span className="field-optional"> (optional)</span>}
      </span>
      {field.type === "select" ? (
        <select className="field-input" value={value} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="field-input"
          type={field.type === "password" && localSecretStore ? "password" : "text"}
          value={value}
          placeholder={
            field.type === "password"
              ? unavailable
                ? localSecretStore
                  ? L.secretUnavailablePlaceholder
                  : L.secretEnvUnavailablePlaceholder
                : hasStored
                  ? L.secretStoredPlaceholder
                  : localSecretStore
                    ? field.default ?? ""
                    : L.secretRefPlaceholder
              : field.default ?? ""
          }
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.type === "password" && (
        <span className={`field-hint${unavailable ? " error" : ""}`}>
          {unavailable
            ? localSecretStore
              ? L.secretUnavailableHint
              : L.secretEnvUnavailableHint
            : localSecretStore
              ? L.secretKeychainHint
              : L.secretRefHint}
        </span>
      )}
    </label>
  );
}

function isDesktop(): boolean {
  return typeof window !== "undefined" && window.__PIZZA_SECRETS__ !== undefined;
}

async function materializeSecret(providerId: string, fieldKey: string, typed: string): Promise<string> {
  const bridge = typeof window !== "undefined" ? window.__PIZZA_SECRETS__ : undefined;
  if (!bridge) return typed;
  // Only the generated reference leaves the desktop shell.
  const name = envRefName(providerId, fieldKey);
  await bridge.set(name, typed);
  return `\${${name}}`;
}

function envRefName(providerId: string, fieldKey: string): string {
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return `PIZZA_SECRET_${sanitize(providerId)}_${sanitize(fieldKey)}`;
}

function seedValues(method: ProviderAuthMethod | undefined, config: ProviderConfigView | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of method?.fields ?? []) {
    if (field.type === "password") {
      out[field.key] = "";
      continue;
    }
    const saved = config?.values[field.key];
    out[field.key] = typeof saved === "string" ? saved : field.default ?? "";
  }
  return out;
}

export function secretKeysWithStoredValue(
  method: ProviderAuthMethod | undefined,
  config: ProviderConfigView | undefined,
  preserveUnavailable = false,
): string[] {
  const keys: string[] = [];
  for (const field of method?.fields ?? []) {
    if (field.type !== "password") continue;
    const v = config?.values[field.key];
    if (
      v &&
      typeof v === "object" &&
      v.hasValue &&
      (v.available !== false || preserveUnavailable)
    ) {
      keys.push(field.key);
    }
  }
  return keys;
}

/**
 * Without a desktop secret store the server accepts only an `${ENV_REF}`, so a
 * pasted credential is rejected on save. Say so before it makes that round trip.
 */
export function secretReferenceValidationError(
  method: ProviderAuthMethod | undefined,
  values: Readonly<Record<string, string>>,
  localSecretStore: boolean,
): string | undefined {
  if (localSecretStore) return undefined;
  const literal = method?.fields.find((field) => {
    const typed = values[field.key]?.trim();
    return field.type === "password" && !!typed && !isEnvReference(typed);
  });
  return literal
    ? `${literal.label} must reference an environment variable, like \${MY_API_KEY} — not the value itself.`
    : undefined;
}

export function unavailableLocalSecretValidationError(
  method: ProviderAuthMethod | undefined,
  values: Readonly<Record<string, string>>,
  unavailableSecrets: ReadonlySet<string>,
  localSecretStore: boolean,
): string | undefined {
  if (!localSecretStore) return undefined;
  const missing = method?.fields.find(
    (field) =>
      field.type === "password" &&
      field.required &&
      unavailableSecrets.has(field.key) &&
      !values[field.key]?.trim(),
  );
  return missing ? `Re-enter ${missing.label} before saving.` : undefined;
}

function secretKeysWithUnavailableValue(
  method: ProviderAuthMethod | undefined,
  config: ProviderConfigView | undefined,
): string[] {
  const keys: string[] = [];
  for (const field of method?.fields ?? []) {
    if (field.type !== "password") continue;
    const value = config?.values[field.key];
    if (
      value &&
      typeof value === "object" &&
      value.hasValue &&
      value.available === false
    ) {
      keys.push(field.key);
    }
  }
  return keys;
}

function providerHasUnavailableSecret(provider: ProviderView): boolean {
  const method = provider.authSchema?.find(
    (candidate) => candidate.id === provider.config?.method,
  );
  return secretKeysWithUnavailableValue(method, provider.config).length > 0;
}
