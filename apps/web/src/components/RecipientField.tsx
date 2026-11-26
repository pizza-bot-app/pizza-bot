import { L } from "../lexicon.js";
import type { RecipientOption } from "../lib/thread-agent.js";

/** The To: line of a conversation: a picker before the first message, fixed after. */
export function RecipientField({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options?: readonly RecipientOption[];
  value?: string;
  onChange?: (agentId: string | undefined) => void;
}) {
  return (
    <div className="recipient-field">
      <span className="recipient-label">{L.recipientLabel}:</span>
      {options && onChange ? (
        <select
          className="recipient-select"
          aria-label={L.recipientPickerLabel}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          {options.map((option) => (
            <option
              key={option.id ?? ""}
              value={option.id ?? ""}
              disabled={option.disabledReason !== undefined}
              title={option.disabledReason}
            >
              {option.disabledReason ? `${option.name} (${option.disabledReason})` : option.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="recipient-name">{name}</span>
      )}
    </div>
  );
}
