import { AlertTriangle, RotateCw } from "lucide-react";

// Actionable follow-up per coarse error code; codes without an entry show the
// raw provider message alone.
const HINT_BY_CODE: Record<string, string> = {
  AUTH_EXPIRED:
    "Check the selected inference provider's credentials. For Bedrock, update the configured profile, access keys, or API key in Settings.",
  RATE_LIMIT: "The provider is throttling requests. Wait a moment and try again.",
  CONTEXT_LENGTH:
    "The conversation exceeds the model's context window. Start a new thread or fork earlier in the history.",
  MODEL_UNAVAILABLE:
    "The selected model is unavailable. Pick another model in the composer or check the provider.",
  TIMEOUT: "The request timed out before the model responded. Try again.",
};

export function RunErrorBanner({
  text,
  code,
  onRetry,
}: {
  text: string;
  code?: string;
  /** Offered only while the failed turn's message is still unanswered. */
  onRetry?: () => Promise<void>;
}) {
  const hint = code ? HINT_BY_CODE[code] : undefined;
  return (
    <div className="run-error" role="alert">
      <AlertTriangle size={16} className="run-error-icon" />
      <div className="run-error-body">
        <p className="run-error-text">{text}</p>
        {hint && <p className="run-error-hint">{hint}</p>}
      </div>
      {onRetry && (
        <button type="button" className="btn-secondary run-error-retry" onClick={() => void onRetry()}>
          <RotateCw size={14} />
          Retry
        </button>
      )}
    </div>
  );
}
