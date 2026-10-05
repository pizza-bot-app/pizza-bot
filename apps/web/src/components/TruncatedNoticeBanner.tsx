import { Info } from "lucide-react";

const NOTICE = "Response was cut off (hit the token limit) — send a follow-up to continue.";

export function TruncatedNoticeBanner() {
  return (
    <div className="truncated-notice" role="status">
      <Info size={16} className="truncated-notice-icon" />
      <p className="truncated-notice-text">{NOTICE}</p>
    </div>
  );
}
