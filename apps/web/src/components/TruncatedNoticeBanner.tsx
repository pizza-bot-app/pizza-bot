import { Info } from "lucide-react";

export function TruncatedNoticeBanner({ text }: { text: string }) {
  return (
    <div className="truncated-notice" role="status">
      <Info size={16} className="truncated-notice-icon" />
      <p className="truncated-notice-text">{text}</p>
    </div>
  );
}
