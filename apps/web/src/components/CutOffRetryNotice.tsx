import { RotateCw } from "lucide-react";

const NOTICE = "Retrying with smaller edits…";

export function CutOffRetryNotice() {
  return (
    <div className="truncated-notice" role="status">
      <RotateCw size={16} className="truncated-notice-icon" />
      <p className="truncated-notice-text">{NOTICE}</p>
    </div>
  );
}
