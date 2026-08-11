import { useState } from "react";
import { useAppToast } from "./AppToast.js";

export type CapabilityVisualState =
  | "active"
  | "crashed"
  | "disabled"
  | "loading"
  | "unavailable";

export function CapabilityStatusDot({
  state,
  label,
}: {
  state: CapabilityVisualState;
  label: string;
}) {
  return (
    <span
      className={`capability-status-dot ${state}`}
      title={label}
      aria-label={label}
    />
  );
}

export function CapabilityEnablement({
  enabled,
  noun,
  onChange,
  blockedReason,
  stateDescription,
}: {
  enabled: boolean;
  noun: string;
  onChange: (enabled: boolean) => Promise<unknown>;
  blockedReason?: string;
  stateDescription?: string;
}) {
  const notify = useAppToast();
  const [busy, setBusy] = useState(false);
  const next = !enabled;
  const blocked = Boolean(blockedReason);

  const change = async () => {
    if (busy || blocked) return;
    setBusy(true);
    try {
      await onChange(next);
      notify({
        title: `${noun} ${next ? "enabled" : "disabled"}`,
        tone: "success",
      });
    } catch (error) {
      notify({
        title: `Could not ${next ? "enable" : "disable"} ${noun.toLowerCase()}`,
        description: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="capability-enablement">
      <div className="capability-enablement-row">
        <div>
          <div className="capability-enablement-label">Enabled</div>
          <div className="capability-enablement-state">
            {stateDescription ??
              (enabled ? "Available to Pizza Bot" : "Not available to Pizza Bot")}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? "Disable" : "Enable"} ${noun.toLowerCase()}`}
          aria-busy={busy}
          disabled={busy || blocked}
          onClick={() => void change()}
        />
      </div>
      {blockedReason && <div className="capability-enablement-blocked">{blockedReason}</div>}
    </div>
  );
}
