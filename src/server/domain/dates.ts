import type { Policy } from "@/shared/types";

type LocalParts = { year: number; month: number; day: number; weekday: number; hour: number; minute: number };

function partsAt(timezone: string, value: Date): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const number = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf((parts.find((part) => part.type === "weekday")?.value || "").slice(0, 3).toLowerCase());
  const result = { year: number("year"), month: number("month"), day: number("day"), weekday, hour: number("hour"), minute: number("minute") };
  if (!Number.isInteger(result.year) || !Number.isInteger(result.month) || !Number.isInteger(result.day) || weekday < 0) throw new Error("INVALID_TIMEZONE_OR_DATE");
  return result;
}

function utcForLocal(timezone: string, local: { year: number; month: number; day: number; hour: number; minute: number }) {
  const targetWall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let guess = targetWall;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = partsAt(timezone, new Date(guess));
    const observedWall = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    guess = targetWall - (observedWall - guess);
  }
  return new Date(guess);
}

export function resolveRelativeContactTime(value: string, now: Date, policy: Policy) {
  const normalized = value.trim().toLowerCase();
  const explicit = new Date(value);
  if (!Number.isNaN(explicit.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(value.trim())) return explicit;
  if (!/(?:^|\s)(?:fri|friday)(?:$|\s)/.test(normalized)) throw new Error("RELATIVE_DATE_UNSUPPORTED:Use an ISO timestamp or a weekday such as Friday.");
  const local = partsAt(policy.timezone, now);
  const daysAhead = (5 - local.weekday + 7) % 7 || 7;
  const target = new Date(Date.UTC(local.year, local.month - 1, local.day + daysAhead, policy.contactStartHour, 0));
  const targetParts = { year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate(), hour: policy.contactStartHour, minute: 0 };
  return utcForLocal(policy.timezone, targetParts);
}

export function formatContactTime(value: string | undefined, policy: Policy) {
  if (!value) return "Not scheduled";
  try { return new Intl.DateTimeFormat("en-IN", { timeZone: policy.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); } catch { return value; }
}
