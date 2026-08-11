// This parser is a UI preview; the server's cron engine is authoritative.
// Unsupported expressions fall back to raw text or no next-run estimate.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

interface CronDateFields {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const dom = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12);
  const dowRaw = parseField(fields[4]!, 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domStar: fields[2] === "*",
    dowStar: fields[4] === "*",
  };
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export function describeCron(expr: string): string {
  const p = parseCron(expr);
  if (!p) return expr;

  const oneMinute = p.minute.size === 1;
  const oneHour = p.hour.size === 1;
  const timeStr =
    oneMinute && oneHour ? `at ${pad([...p.hour][0]!)}:${pad([...p.minute][0]!)}` : undefined;

  const everyDay = p.domStar && p.dowStar;
  const specificDows = !p.dowStar && p.dow.size < 7;

  if (everyDay && timeStr) return `Daily ${timeStr}`;
  if (specificDows && timeStr) {
    const days = [...p.dow].sort((a, b) => a - b).map((d) => DOW[d]).join(", ");
    return `${days} ${timeStr}`;
  }
  if (!p.domStar && p.dom.size === 1 && timeStr) {
    const monthNote = p.month.size === 1 ? ` of ${MONTHS[[...p.month][0]! - 1]}` : "";
    return `Day ${[...p.dom][0]}${monthNote} ${timeStr}`;
  }
  if (timeStr) return timeStr;
  if (p.minute.size === 60 && oneHour) return `Hourly (min ${[...p.minute][0]})`;
  return expr;
}

function localDateFields(d: Date): CronDateFields {
  return {
    minute: d.getMinutes(),
    hour: d.getHours(),
    dom: d.getDate(),
    month: d.getMonth() + 1,
    dow: d.getDay(),
  };
}

function zonedDateFields(timezone: string): ((date: Date) => CronDateFields) | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
  } catch {
    return null;
  }

  return (date) => {
    const values = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return {
      minute: Number(values.minute),
      hour: Number(values.hour) % 24,
      dom: Number(values.day),
      month: Number(values.month),
      dow: DOW.indexOf(values.weekday!),
    };
  };
}

function matches(p: ParsedCron, fields: CronDateFields): boolean {
  if (!p.minute.has(fields.minute)) return false;
  if (!p.hour.has(fields.hour)) return false;
  if (!p.month.has(fields.month)) return false;
  const domOk = p.dom.has(fields.dom);
  const dowOk = p.dow.has(fields.dow);
  if (p.domStar && p.dowStar) return true;
  if (p.domStar) return dowOk;
  if (p.dowStar) return domOk;
  // Standard cron treats restricted day-of-month and day-of-week as OR.
  return domOk || dowOk;
}

export function nextCronRun(expr: string, now = new Date(), timezone?: string): Date | null {
  const p = parseCron(expr);
  if (!p) return null;
  const dateFields = timezone ? zonedDateFields(timezone) : localDateFields;
  if (!dateFields) return null;
  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  d.setTime(d.getTime() + 60_000);
  const limit = new Date(now.getTime());
  limit.setFullYear(limit.getFullYear() + 1);
  while (d <= limit) {
    if (matches(p, dateFields(d))) return d;
    d.setTime(d.getTime() + 60_000);
  }
  return null;
}

export function formatCronRun(date: Date, timezone?: string): string {
  return date.toLocaleString(undefined, {
    ...(timezone ? { timeZone: timezone, timeZoneName: "short" } : {}),
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const CRON_PRESETS: ReadonlyArray<{ label: string; cron: string }> = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily at 09:00", cron: "0 9 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Mondays at 09:00", cron: "0 9 * * 1" },
  { label: "1st of each month at 09:00", cron: "0 9 1 * *" },
];
