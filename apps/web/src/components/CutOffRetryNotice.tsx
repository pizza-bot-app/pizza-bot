import { RotateCw } from "lucide-react";

const NOTICE = "Retrying with smaller edits…";

export function CutOffRetryNotice() {
  return (
    <div className="blank-turn-notice" role="status">
      <RotateCw size={16} className="blank-turn-notice-icon" />
      <p className="blank-turn-notice-text">{NOTICE}</p>
    </div>
  );
}
