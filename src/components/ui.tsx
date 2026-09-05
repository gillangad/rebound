import { ArrowUpRight, BadgeCheck, FileText, History, Mail, ShieldCheck } from "lucide-react";
import type { CaseState, RecoveryCase } from "@/shared/types";
import { formatMoney, titleCase } from "@/shared/formatters";

export function initials(label: string) {
  return label.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function StatusBadge({ state, label }: { state: CaseState | "pending" | "executed" | "active" | "resolved" | "fixture" | "healthy"; label?: string }) {
  const tone = state === "recovered" || state === "executed" || state === "healthy" ? "verified" : ["awaiting_approval", "pending", "paused", "active", "investigating"].includes(state) ? "waiting" : ["escalated"].includes(state) ? "failed" : "neutral";
  const text = label || (state === "awaiting_approval" ? "Approval required" : state === "recovered" ? "Payment verified" : state === "paused" ? "Paused" : titleCase(state));
  return <span className={`status-badge ${tone}`}>{text}</span>;
}

export function Amount({ value, currency = "INR", emphasis = false }: { value: number; currency?: string; emphasis?: boolean }) {
  return <span className={emphasis ? "amount emphasis" : "amount"}>{formatMoney(value, currency)}</span>;
}

export function SourceChip({ label, href, type = "source" }: { label: string; href?: string; type?: "source" | "document" | "email" | "webhook" }) {
  const Icon = type === "document" ? FileText : type === "email" ? Mail : type === "webhook" ? ShieldCheck : History;
  const content = <><Icon size={14} aria-hidden="true" /><span>{label}</span>{href && <ArrowUpRight size={12} aria-hidden="true" />}</>;
  if (href) return <a className="source-chip" href={href} target="_blank" rel="noreferrer">{content}</a>;
  return <span className="source-chip">{content}</span>;
}

export function EmptyState({ title, detail, icon: Icon = BadgeCheck }: { title: string; detail: string; icon?: typeof BadgeCheck }) {
  return <div className="empty-state"><div><Icon size={22} aria-hidden="true" /><p><strong>{title}</strong><br />{detail}</p></div></div>;
}

export function CaseStatusLine({ recoveryCase }: { recoveryCase: RecoveryCase }) {
  return <div className="detail-status-line"><StatusBadge state={recoveryCase.state} /><StatusBadge state={recoveryCase.confidence === 0 ? "pending" : recoveryCase.blocker === "payment_failed" ? "pending" : recoveryCase.blocker === "dispute" ? "escalated" : "investigating"} label={recoveryCase.confidence === 0 ? "Evidence pending" : titleCase(recoveryCase.blocker)} />{recoveryCase.confidence >= 0.95 && <span className="demo-note">Evidence confidence {Math.round(recoveryCase.confidence * 100)}%</span>}</div>;
}
