import { avatarColor, initials, isEmoji } from "../lib/conversation.js";

export function Avatar({
  label,
  avatar,
  size = 40,
}: {
  label: string;
  avatar?: string;
  size?: number;
}) {
  const emoji = isEmoji(avatar);
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: emoji ? "var(--panel-2)" : avatarColor(label),
        fontSize: emoji ? size * 0.5 : size * 0.34,
      }}
      aria-hidden="true"
    >
      {emoji ? avatar : initials(label)}
    </span>
  );
}
