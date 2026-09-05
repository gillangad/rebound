export const PRODUCT_NAME = process.env.PRODUCT_NAME?.trim() || "Rebound";

export const DEMO_MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
export const DEMO_TIME_ZONE = "Asia/Kolkata";
export const DEMO_CURRENCY = "INR";
// Fixture time is intentionally fixed so policy decisions and demo records are
// reproducible even when the local machine is outside the merchant's contact window.
export const DEMO_CLOCK = "2026-09-05T05:00:00.000Z";

export const NAV_ITEMS = [
  { href: "/recovery", label: "Rebound", icon: "pulse" },
  { href: "/approvals", label: "Approvals", icon: "check" },
  { href: "/incidents", label: "Incidents", icon: "triangle" },
  { href: "/connections", label: "Connections", icon: "layers" },
  { href: "/history", label: "History", icon: "history" },
  { href: "/policies", label: "Policies", icon: "sliders" }
] as const;

export const CASE_STATES = [
  "detected",
  "investigating",
  "proposed",
  "awaiting_approval",
  "contacted",
  "recovered",
  "paused",
  "escalated",
  "closed"
] as const;

export const WORKFLOW_TYPES = ["failed_purchase", "invoice_resolution", "shared_incident"] as const;
export const BLOCKER_CATEGORIES = [
  "payment_failed",
  "missing_document",
  "dispute",
  "promise_to_pay",
  "partial_payment",
  "inability_to_pay",
  "no_response",
  "incident",
  "opted_out"
] as const;

export const SEMANTIC_COLORS = {
  verified: "#24855d",
  waiting: "#b7791f",
  failed: "#c84b45",
  link: "#345d9d"
} as const;
