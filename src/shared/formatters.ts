export function formatMoney(minorUnits: number, currency = "INR") {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(minorUnits / 100);
}

export function formatCompactMoney(minorUnits: number, currency = "INR") {
  const amount = minorUnits / 100;
  if (amount >= 10000000) return `${currency === "INR" ? "₹" : currency} ${(amount / 10000000).toFixed(1)}Cr`;
  if (amount >= 100000) return `${currency === "INR" ? "₹" : currency} ${(amount / 100000).toFixed(1)}L`;
  if (amount >= 1000) return `${currency === "INR" ? "₹" : currency} ${(amount / 1000).toFixed(1)}k`;
  return formatMoney(minorUnits, currency);
}

export function formatDate(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

export function formatDateTime(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function formatRelative(value?: string) {
  if (!value) return "—";
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(Math.abs(delta) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
