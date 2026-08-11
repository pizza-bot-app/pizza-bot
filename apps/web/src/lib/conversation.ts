export function initials(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "PB";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
  "#ef4444",
  "#3b82f6",
  "#f97316",
  "#8b5cf6",
  "#10b981",
  "#ec4899",
  "#14b8a6",
  "#eab308",
];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

export function isEmoji(s: string | undefined): s is string {
  if (!s) return false;
  return /\p{Extended_Pictographic}/u.test(s) && [...s].length <= 3;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t === 0) return "";
  const diff = now - t;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return new Date(t).toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
}

export type DatePeriod =
  | "Today"
  | "Yesterday"
  | "This Week"
  | "Last Week"
  | "This Month"
  | "Older";

export const PERIOD_ORDER: DatePeriod[] = [
  "Today",
  "Yesterday",
  "This Week",
  "Last Week",
  "This Month",
  "Older",
];

export function datePeriod(iso: string, now = new Date()): DatePeriod {
  const t = new Date(iso).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const thisWeekStart = new Date(today);
  thisWeekStart.setDate(thisWeekStart.getDate() - today.getDay());
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const d = new Date(t);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (day >= today) return "Today";
  if (day >= yesterday) return "Yesterday";
  if (day >= thisWeekStart) return "This Week";
  if (day >= lastWeekStart) return "Last Week";
  if (day >= thisMonthStart) return "This Month";
  return "Older";
}
