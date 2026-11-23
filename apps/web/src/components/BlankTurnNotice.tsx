import { Info } from "lucide-react";
import type { BlankTurnReason } from "@pizza-bot/core";

const NOTICES: Record<BlankTurnReason, string> = {
  length: "Response was cut off (hit the token limit) — send a follow-up to continue.",
  content_filter:
    "The model provider's content filter blocked this response — rephrase or trim the message and try again.",
};

export function BlankTurnNotice({ reason }: { reason: BlankTurnReason }) {
  return (
    <div className="blank-turn-notice" role="status">
      <Info size={16} className="blank-turn-notice-icon" />
      <p className="blank-turn-notice-text">{NOTICES[reason]}</p>
    </div>
  );
}
