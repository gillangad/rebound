"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleHelp,
  FileText,
  History as HistoryIcon,
  Layers3,
  Mail,
  Moon,
  Pause,
  Plus,
  RefreshCcw,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  TriangleAlert,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BootstrapPayload, CaseView, Incident, Policy, Proposal, RuntimeCapabilities } from "@/shared/types";
import { NAV_ITEMS } from "@/shared/constants";
import { formatDateTime, formatMoney, formatRelative, titleCase } from "@/shared/formatters";
import { AgentOrb, findSafeFloatingPosition, FLOATING_INSET, type FloatingPosition, type OrbState } from "@/components/agent-orb";
import { CaseStatusLine, EmptyState, SourceChip, StatusBadge, initials } from "@/components/ui";
import type { ComponentProps, CSSProperties, Dispatch, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, SetStateAction } from "react";

type Section = "recovery" | "approvals" | "incidents" | "connections" | "history" | "policies";
const icons: Record<string, LucideIcon> = { pulse: Activity, check: CheckCircle2, triangle: TriangleAlert, layers: Layers3, history: HistoryIcon, sliders: SlidersHorizontal };
type AgentMessage = { id: string; role: "user" | "assistant"; text: string };

let bootstrapCache: BootstrapPayload | null = null;
let bootstrapRequest: Promise<BootstrapPayload> | null = null;

async function loadBootstrap(force = false) {
  if (!force && bootstrapCache) return bootstrapCache;
  if (bootstrapRequest) return bootstrapRequest;
  bootstrapRequest = fetch("/api/bootstrap", { cache: "no-store" }).then(async (response) => {
    const payload = await response.json() as BootstrapPayload & { error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || "Could not load workspace.");
    bootstrapCache = payload;
    return payload;
  }).finally(() => { bootstrapRequest = null; });
  return bootstrapRequest;
}

export function MerchantShell({ section }: { section: Section }) {
  const [data, setData] = useState<BootstrapPayload | null>(() => bootstrapCache);
  const [error, setError] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | undefined>();
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | undefined>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [tab, setTab] = useState<"evidence" | "messages" | "history">("evidence");
  const [instruction, setInstruction] = useState("");
  const [historyQuery, setHistoryQuery] = useState("");
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { subject: string; body: string }>>({});
  const [policyDraft, setPolicyDraft] = useState<Partial<Policy>>({});
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);

  const refresh = useCallback(async (force = false) => {
    try {
      const payload = await loadBootstrap(force);
      setData(payload);
      setError(null);
      setSelectedCaseId((current) => current && payload.cases.some((item) => item.id === current) ? current : payload.cases.find((item) => item.customer.displayName === "City Interiors")?.id || payload.cases.find((item) => item.blocker === "missing_document")?.id || payload.cases.find((item) => item.primary !== false)?.id);
      setPolicyDraft(payload.policy);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load workspace.");
    }
  }, []);

  useEffect(() => {
    void refresh(!bootstrapCache);
    const savedTheme = window.localStorage.getItem("recovery-theme") as "light" | "dark" | null;
    const initialTheme = savedTheme || "light";
    setTheme(initialTheme);
    document.documentElement.dataset.theme = initialTheme;
  }, [refresh]);

  const pollingState = data?.orb.state;
  useEffect(() => {
    if (!pollingState) return;
    const intervalMs = pollingState === "working" || pollingState === "inspecting" ? 1300 : 7000;
    const timer = window.setInterval(() => void refresh(true), intervalMs);
    return () => window.clearInterval(timer);
  }, [pollingState, refresh]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    window.requestAnimationFrame(() => document.getElementById("agent-orb-trigger")?.focus());
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && drawerOpen) closeDrawer(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDrawer, drawerOpen]);

  const mutate = async (key: string, url: string, body?: Record<string, unknown>, onError?: (message: string) => void) => {
    setBusyKey(key);
    setNotice(null);
    try {
      const response = await fetch(url, { method: body ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json() as { error?: { message?: string }; message?: string; agent?: { provider?: string; toolCallSummaries?: string[] } };
      if (!response.ok) throw new Error(result.error?.message || "Action could not be completed.");
      setNotice(typeof result.message === "string" ? result.message : "Saved.");
      await refresh(true);
      return result;
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : "Action could not be completed.";
      setNotice(message);
      onError?.(message);
      return null;
    } finally {
      setBusyKey(null);
    }
  };

  const selectedCase = data?.cases.find((item) => item.id === selectedCaseId);
  const selectedIncident = data?.incidents.find((item) => item.id === selectedIncidentId);
  const currentTitle = section === "recovery" ? data?.productName || "Rebound" : titleCase(section);
  const pendingApprovalCount = data?.proposals.filter((item) => item.status === "pending").length || 0;
  const activeIncidentCount = data?.incidents.filter((item) => item.status === "active").length || 0;
  const orbState = useMemo<OrbState>(() => {
    if (!data) return "idle";
    if (busyKey === "instruction") return "working";
    const reportedState = data.orb.state;
    if ((reportedState === "uncertain" || reportedState === "error") && (!selectedCase || !data.orb.caseId || data.orb.caseId === selectedCase.id)) return reportedState;
    if (selectedIncident?.status === "active") return "paused";
    if (!selectedCase) return reportedState;
    if (selectedCase.state === "awaiting_approval") return "approval";
    if (selectedCase.state === "paused") return "paused";
    if (selectedCase.state === "recovered") return "success";
    if (data.orb.caseId === selectedCase.id && (reportedState === "inspecting" || reportedState === "working")) return reportedState;
    if (selectedCase.state === "investigating") return reportedState === "inspecting" ? "inspecting" : "working";
    if (selectedCase.state === "proposed") return selectedCase.proposals.some((proposal) => proposal.status === "pending" && proposal.requiresApproval) ? "approval" : "working";
    return reportedState === "inspecting" || reportedState === "working" ? reportedState : "idle";
  }, [busyKey, data, selectedCase, selectedIncident]);
  const orbLabel = orbState === "approval" ? "Approval required" : orbState === "paused" ? "Paused" : orbState === "success" ? "Payment verified" : orbState === "working" || orbState === "inspecting" ? "Investigating" : orbState === "uncertain" ? "Needs review" : orbState === "error" ? "Provider needs attention" : "Agent idle";

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("recovery-theme", next);
  };

  const submitInstruction = async (event: FormEvent) => {
    event.preventDefault();
    const request = instruction.trim();
    if (!request) return;
    setAgentMessages((current) => [...current, { id: `${Date.now()}-user`, role: "user", text: request }]);
    setInstruction("");
    let failureMessage = "The configured agent could not complete this request.";
    const result = await mutate("instruction", "/api/instructions", { caseId: selectedCaseId, instruction: request }, (message) => { failureMessage = message; });
    if (result) {
      const activity = result.agent?.toolCallSummaries?.length ? `\n\nActivity: ${result.agent.toolCallSummaries.join(" → ")}.` : "";
      setAgentMessages((current) => [...current, { id: `${Date.now()}-assistant`, role: "assistant", text: `${typeof result.message === "string" ? result.message : "I could not produce a bounded response."}${activity}` }]);
      setDrawerOpen(true);
    } else {
      await refresh(true);
      setAgentMessages((current) => [...current, { id: `${Date.now()}-assistant-error`, role: "assistant", text: `I couldn't complete that agent request. ${failureMessage} No canned operational response was used, and authoritative state was left unchanged.` }]);
      setDrawerOpen(true);
    }
  };

  const resetDemo = async () => {
    const result = await mutate("reset-demo", "/api/demo/reset", {});
    if (result) {
      setSelectedCaseId(undefined);
      setSelectedIncidentId(undefined);
      setInstruction("");
      setDrawerOpen(false);
    }
  };

  const approveProposal = async (proposal: Proposal, recoveryCase?: CaseView) => {
    const draft = drafts[proposal.id];
    const result = await mutate(`approve-${proposal.id}`, `/api/proposals/${proposal.id}/decision`, { decision: "approve", expectedCaseVersion: recoveryCase?.version, editedPayload: draft ? { subject: draft.subject, body: draft.body } : undefined });
    if (result) { setEditingProposalId(null); setDrafts((current) => { const copy = { ...current }; delete copy[proposal.id]; return copy; }); }
  };

  const rejectProposal = async (proposal: Proposal, recoveryCase?: CaseView) => {
    await mutate(`reject-${proposal.id}`, `/api/proposals/${proposal.id}/decision`, { decision: "reject", expectedCaseVersion: recoveryCase?.version, rationale: "Merchant chose not to send this proposal." });
  };

  if (!data) return <div className="app-shell"><aside className="sidebar" /><main className="main-shell"><div className="topbar"><h1 className="page-title">Rebound</h1></div><div className="content"><div className="loading-state">{error || "Loading workspace…"}</div></div></main></div>;

  const primaryCases = data.cases.filter((item) => item.primary !== false).sort((left, right) => {
    const leftFlagship = left.customer.displayName === "City Interiors";
    const rightFlagship = right.customer.displayName === "City Interiors";
    if (leftFlagship !== rightFlagship) return leftFlagship ? -1 : 1;
    return left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0;
  });
  const activeIncidents = data.incidents.filter((item) => item.status === "active");

  return <div className="app-shell">
    <aside className="sidebar" aria-label="Merchant navigation">
      <div className="brand"><div className="brand-mark"><span aria-hidden="true">↗</span></div><div><div className="brand-name">{data.merchant.name}</div><div className="brand-caption">Revenue operations</div></div><span className="mode-label">{data.mode === "fixture" ? "Demo" : "Live"}</span></div>
      <nav className="nav" aria-label="Primary">
        {NAV_ITEMS.map((item) => { const Icon = icons[item.icon]; const itemSection = item.href.slice(1) as Section; return <Link href={item.href} key={item.href} className={`nav-item ${section === itemSection ? "active" : ""}`} aria-current={section === itemSection ? "page" : undefined}><Icon size={18} strokeWidth={1.7} aria-hidden="true" /><span>{item.label}</span>{itemSection === "approvals" && pendingApprovalCount > 0 && <span className="nav-badge">{pendingApprovalCount}</span>}{itemSection === "incidents" && activeIncidentCount > 0 && <span className="nav-badge">{activeIncidentCount}</span>}</Link>; })}
      </nav>
      <div className="sidebar-spacer" />
      <div className="connector-health"><span className={`health-dot ${data.capabilities.evidence.status === "unsupported" || data.capabilities.payment.status === "not_configured" ? "error" : data.capabilities.storage.status === "not_configured" ? "neutral" : ""}`} /> Evidence · payments · workspace<br /><span style={{ marginLeft: 13 }}>{data.merchant.demo ? "isolated demo workspace" : "provider status shown below"}</span></div>
      <div className="merchant-footer"><div className="merchant-avatar">NO</div><div><div className="merchant-name">Northstar Office</div><div className="merchant-role">Merchant admin</div></div></div>
    </aside>
    <main className="main-shell">
      <header className="topbar"><div className="topbar-title"><h1 className="page-title">{currentTitle}</h1><span className="mode-pill">{data.merchant.demo ? "Private demo workspace" : data.mode === "fixture" ? "Fixture providers" : "Selected live/test providers"}</span></div><div className="header-summaries"><span className="summary">Outstanding <strong>{formatMoney(data.summary.outstanding, data.summary.currency)}</strong></span><span className="summary">Verified recovered <strong>{formatMoney(data.summary.verifiedRecovered, data.summary.currency)}</strong></span></div><div className="topbar-actions"><button type="button" className="icon-button" onClick={() => void refresh(true)} aria-label="Refresh workspace"><RefreshCcw size={17} /></button><button type="button" className="icon-button" onClick={toggleTheme} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</button></div></header>
      <div className="content">
        {notice && <div className="error-banner" style={{ color: "var(--text-2)", marginBottom: 14 }} role="status"><CircleHelp size={15} />{notice}</div>}
        {error && <div className="error-banner" style={{ marginBottom: 14 }} role="alert"><AlertTriangle size={15} />{error}</div>}
        <CapabilityStrip capabilities={data.capabilities} />
        {section === "recovery" && <RecoveryView data={data} primaryCases={primaryCases} activeIncidents={activeIncidents} selectedCaseId={selectedCaseId} selectedIncidentId={selectedIncidentId} selectedCase={selectedCase} selectedIncident={selectedIncident} selectedTab={tab} setSelectedCaseId={(id) => { setSelectedCaseId(id); setSelectedIncidentId(undefined); setTab("evidence"); }} setSelectedIncidentId={(id) => { setSelectedIncidentId(id); setSelectedCaseId(undefined); }} setTab={setTab} busyKey={busyKey} editingProposalId={editingProposalId} setEditingProposalId={setEditingProposalId} drafts={drafts} setDrafts={setDrafts} onApprove={approveProposal} onReject={rejectProposal} onInvestigate={(id) => void mutate(`investigate-${id}`, `/api/cases/${id}/investigate`, {})} onResolveIncident={(id) => void mutate(`resolve-${id}`, `/api/incidents/${id}/resolve`, {})} onResetDemo={resetDemo} />}
        {section === "approvals" && <ApprovalsView data={data} busyKey={busyKey} editingProposalId={editingProposalId} setEditingProposalId={setEditingProposalId} drafts={drafts} setDrafts={setDrafts} onApprove={approveProposal} onReject={rejectProposal} />}
        {section === "incidents" && <IncidentsView data={data} busyKey={busyKey} onResolve={(id) => void mutate(`resolve-${id}`, `/api/incidents/${id}/resolve`, {})} />}
        {section === "connections" && <ConnectionsView data={data} />}
        {section === "history" && <HistoryView data={data} query={historyQuery} setQuery={setHistoryQuery} />}
        {section === "policies" && <PoliciesView data={data} draft={policyDraft} setDraft={setPolicyDraft} busyKey={busyKey} onSave={() => void mutate("policy", "/api/policies", policyDraft as Record<string, unknown>)} />}
      </div>
    </main>
    <AgentOrb state={orbState} label={orbLabel} onClick={() => { if (drawerOpen) closeDrawer(); else setDrawerOpen(true); }} open={drawerOpen} />
    {drawerOpen && <AgentDrawer data={data} selectedCase={selectedCase} messages={agentMessages} state={orbState} label={orbLabel} instruction={instruction} setInstruction={setInstruction} onSubmit={submitInstruction} onInvestigate={() => selectedCaseId && void mutate(`investigate-${selectedCaseId}`, `/api/cases/${selectedCaseId}/investigate`, {})} onPause={() => selectedCaseId && void mutate(`pause-${selectedCaseId}`, `/api/cases/${selectedCaseId}/pause`, { reason: "Merchant paused outreach from agent controls" })} onResume={() => selectedCaseId && void mutate(`resume-${selectedCaseId}`, `/api/cases/${selectedCaseId}/pause`, { reason: "Merchant resumed outreach from agent controls", resume: true })} onClose={closeDrawer} busy={busyKey === "instruction"} />}
  </div>;
}

function CapabilityStrip({ capabilities }: { capabilities: RuntimeCapabilities }) {
  const entries = [["agent", capabilities.agent], ["evidence", capabilities.evidence], ["payment", capabilities.payment], ["storage", capabilities.storage]] as const;
  return <div className="capability-strip" aria-label="Runtime provider capabilities">{entries.map(([key, capability]) => <div className="capability-item" key={key}><span className={`capability-dot ${capability.status}`} /><div><span className="capability-key">{key}</span><strong>{capability.label}</strong></div><span className={`capability-status ${capability.status}`}>{capability.status === "fixture" ? "Fixture" : capability.status === "ready" ? "Ready" : capability.status === "unsupported" ? "Deferred" : titleCase(capability.status)}</span></div>)}</div>;
}

function RecoveryView(props: {
  data: BootstrapPayload;
  primaryCases: CaseView[];
  activeIncidents: Incident[];
  selectedCaseId?: string;
  selectedIncidentId?: string;
  selectedCase?: CaseView;
  selectedIncident?: Incident;
  selectedTab: "evidence" | "messages" | "history";
  setSelectedCaseId: (id: string) => void;
  setSelectedIncidentId: (id: string) => void;
  setTab: (tab: "evidence" | "messages" | "history") => void;
  busyKey: string | null;
  editingProposalId: string | null;
  setEditingProposalId: (id: string | null) => void;
  drafts: Record<string, { subject: string; body: string }>;
  setDrafts: Dispatch<SetStateAction<Record<string, { subject: string; body: string }>>>;
  onApprove: (proposal: Proposal, recoveryCase?: CaseView) => Promise<void>;
  onReject: (proposal: Proposal, recoveryCase?: CaseView) => Promise<void>;
  onInvestigate: (id: string) => void;
  onResolveIncident: (id: string) => void;
  onResetDemo: () => void;
}) {
  const { data, primaryCases, activeIncidents, selectedCase, selectedIncident } = props;
  const latestBatch = data.batchRuns[0];
  const batchActive = latestBatch && (latestBatch.status === "queued" || latestBatch.status === "running");
  return <>
    {data.merchant.demo && <div className="demo-banner"><div><span className="demo-banner-kicker">Private demo</span><strong>A resettable recovery workspace</strong><p>Evidence, approvals and simulated payments are isolated to this browser session. Nothing here moves real money.</p></div><button type="button" className="button small" onClick={props.onResetDemo}>Reset demo</button></div>}
    <div className="section-intro"><div><h2>Review these cases</h2><p>Recover what you can within policy, and bring anything uncertain here.</p></div><span className="demo-note">{data.merchant.demo ? "Demo simulation · no real money" : `${data.capabilities.agent.label} · server selected`}</span></div>
    {batchActive && latestBatch && <div className="batch-progress" role="status"><span className="batch-progress-pulse" /><div><strong>{latestBatch.status === "queued" ? "Review request queued" : "Investigation in progress"}</strong><span>{latestBatch.completedCaseIds.length}/{latestBatch.caseIds.length} cases processed · the persistent worker owns evidence retrieval and proposals.</span></div></div>}
    <div className="workspace">
      <section className="case-list" aria-label="Recovery cases"><div className="case-list-heading"><h2>Open work</h2><span className="case-count">{primaryCases.length} cases · {activeIncidents.length} incident</span></div><div className="case-rows">{primaryCases.slice(0, 3).map((item) => <button type="button" key={item.id} id={`case-anchor-${item.id}`} className={`case-row ${item.id === props.selectedCaseId ? "selected" : ""}`} onClick={() => props.setSelectedCaseId(item.id)} aria-pressed={item.id === props.selectedCaseId}><span className="person-avatar">{initials(item.customer.displayName)}</span><span className="case-row-main"><span className="case-row-title">{item.customer.displayName}</span><span className="case-row-subtitle">{item.obligation.kind === "invoice" ? item.invoice?.invoiceNumber || "Invoice" : "Ergonomic chair"} · {formatMoney(item.obligation.amountDue, item.obligation.currency)}</span><span className="case-row-reason">{item.reason}</span></span><span className="case-row-side"><span className="case-age">{formatRelative(item.updatedAt)}</span><span className={`quiet-indicator ${item.state === "recovered" ? "verified" : item.state === "escalated" ? "failed" : ""}`} title={titleCase(item.state)} /></span></button>)}</div>{activeIncidents.length > 0 && <><div className="case-list-divider" /><button type="button" id={`incident-anchor-${activeIncidents[0].id}`} className="incident-row" onClick={() => props.setSelectedIncidentId(activeIncidents[0].id)} aria-pressed={activeIncidents[0].id === props.selectedIncidentId}><span className="incident-icon"><TriangleAlert size={17} /></span><span><span className="incident-row-title">{activeIncidents[0].provider} authorization incident</span><span className="incident-row-detail">{data.cases.filter((item) => item.incidentId === activeIncidents[0].id).length} purchases · outreach paused</span></span><span className="incident-row-action">Review</span></button></>}</section>
       {selectedIncident ? <IncidentDetail incident={selectedIncident} cases={data.cases.filter((item) => item.incidentId === selectedIncident.id)} onResolve={() => props.onResolveIncident(selectedIncident.id)} busy={props.busyKey === `resolve-${selectedIncident.id}`} /> : selectedCase ? <CaseDetail {...props} recoveryCase={selectedCase} /> : <div className="case-detail"><EmptyState title="Select a case" detail="Choose a recovery case to inspect the evidence and next permitted action." icon={Search} /></div>}
    </div>
  </>;
}

function CaseDetail(props: ComponentProps<typeof RecoveryView> & { recoveryCase: CaseView }) {
  const { recoveryCase: requestedCase, selectedTab: requestedTab, setTab, editingProposalId, setEditingProposalId, drafts, setDrafts, onApprove, onReject, onInvestigate, busyKey } = props;
  const visibleSignals = requestedCase.confidence === 0 && requestedCase.workflow === "invoice_resolution" ? requestedCase.signals.filter((signal) => signal.type !== "email_received") : requestedCase.signals;
  const recoveryCase = visibleSignals === requestedCase.signals ? requestedCase : { ...requestedCase, signals: visibleSignals };
  const hasRetrievedEvidence = recoveryCase.messages.length > 0 || recoveryCase.documents.length > 0;
  const selectedTab = requestedTab === "messages" && !hasRetrievedEvidence ? "evidence" : requestedTab;
  const proposal = recoveryCase.proposals.find((item) => item.status === "pending") || recoveryCase.proposals[0];
  const draft = proposal ? drafts[proposal.id] : undefined;
  const latestInbound = recoveryCase.messages.find((item) => item.direction === "inbound");
  const outstanding = Math.max(0, recoveryCase.obligation.amountDue - recoveryCase.obligation.amountPaid);
  const paymentLink = recoveryCase.paymentLink;
  const quote = recoveryCase.confidence === 0 ? "Evidence review is pending; no blocker has been classified yet." : recoveryCase.blocker === "missing_document" ? latestInbound?.body || "Finance is waiting for the signed delivery confirmation." : recoveryCase.blocker === "promise_to_pay" ? latestInbound?.body || "Payment was promised for Friday." : recoveryCase.blocker === "dispute" ? latestInbound?.body || "The customer has disputed the invoice." : "The earlier card authorization did not complete.";
  const beginEdit = () => { if (!proposal) return; setEditingProposalId(proposal.id); setDrafts((current) => ({ ...current, [proposal.id]: { subject: String(proposal.payload.subject || ""), body: String(proposal.payload.body || "") } })); };
  const toggleEdit = () => { if (!proposal) return; if (editingProposalId === proposal.id) { setEditingProposalId(null); return; } beginEdit(); };
  return <section className={`case-detail ${recoveryCase.messages.length === 0 ? "no-messages" : ""} ${recoveryCase.documents.length === 0 ? "no-documents" : ""}`} aria-label={`Case details for ${recoveryCase.customer.displayName}`}>
    <div className="case-detail-header"><div className="case-identity"><span className="person-avatar">{initials(recoveryCase.customer.displayName)}</span><div><h2>{recoveryCase.customer.displayName}</h2><p>{recoveryCase.obligation.kind === "invoice" ? `Invoice ${recoveryCase.invoice?.invoiceNumber || recoveryCase.obligation.invoiceRef}` : "Ergonomic chair purchase"} · {recoveryCase.customer.email}</p></div></div><div className="case-amount"><strong>{formatMoney(outstanding, recoveryCase.obligation.currency)}</strong><span>outstanding · {formatMoney(recoveryCase.obligation.amountPaid, recoveryCase.obligation.currency)} paid</span></div></div>
    <CaseStatusLine recoveryCase={recoveryCase} />
     <div className="detail-tabs" role="tablist" aria-label="Case information"><button type="button" className={`detail-tab ${selectedTab === "evidence" ? "active" : ""}`} onClick={() => setTab("evidence")} role="tab" aria-selected={selectedTab === "evidence"}>Overview</button>{hasRetrievedEvidence && <button type="button" className={`detail-tab ${selectedTab === "messages" ? "active" : ""}`} onClick={() => setTab("messages")} role="tab" aria-selected={selectedTab === "messages"}>Messages & documents</button>}<button type="button" className={`detail-tab ${selectedTab === "history" ? "active" : ""}`} onClick={() => setTab("history")} role="tab" aria-selected={selectedTab === "history"}>History</button></div>
      {selectedTab === "evidence" && <><div className="detail-section"><h3>{recoveryCase.confidence === 0 ? "Evidence review" : "What’s blocking this payment"}</h3><p className="blocker-quote">“{quote}”</p><div className="evidence-grid"><div className="evidence-item"><div className="evidence-item-label">Obligation</div><div className="evidence-item-value">{recoveryCase.obligation.orderRef || recoveryCase.obligation.invoiceRef}</div><div className="evidence-item-detail">{formatMoney(recoveryCase.obligation.amountDue, recoveryCase.obligation.currency)} due</div></div><div className="evidence-item"><div className="evidence-item-label">Identity confidence</div><div className="evidence-item-value">{recoveryCase.confidence > 0 ? `${Math.round(recoveryCase.confidence * 100)}% matched` : "Pending"}</div><div className="evidence-item-detail">{recoveryCase.confidence > 0 ? "Exact references preferred" : "Waiting for retrieved evidence"}</div></div><div className="evidence-item"><div className="evidence-item-label">Next action</div><div className="evidence-item-value">{recoveryCase.state === "awaiting_approval" ? "Merchant approval" : titleCase(recoveryCase.state)}</div><div className="evidence-item-detail">Policy enforced at execution</div></div></div><div className="source-list">{recoveryCase.paymentAttempt && <SourceChip label="Razorpay failure" type="webhook" />}{recoveryCase.signals?.map((signal) => <SourceChip key={signal.id} label={titleCase(signal.type)} type="source" />)}{latestInbound && <SourceChip label={`${latestInbound.providerMode === "fixture" ? "Fixture " : "Live "}Email thread`} type="email" href={latestInbound.providerUrl} />}{recoveryCase.documents.map((document) => <SourceChip key={document.id} label={`${document.providerMode === "fixture" ? "Fixture " : "Live "}delivery document`} type="document" href={`/api/documents/${document.id}?caseId=${encodeURIComponent(recoveryCase.id)}`} />)}</div></div><EvidencePath recoveryCase={recoveryCase} />{proposal && <ProposalBlock proposal={proposal} recoveryCase={recoveryCase} draft={draft} editing={editingProposalId === proposal.id} onEdit={toggleEdit} onDraftChange={(next) => setDrafts((current) => ({ ...current, [proposal.id]: next }))} onApprove={() => void onApprove(proposal, recoveryCase)} onReject={() => void onReject(proposal, recoveryCase)} busy={busyKey === `approve-${proposal.id}` || busyKey === `reject-${proposal.id}`} />}{paymentLink && <div className="payment-link-box"><span className="eyebrow">Customer payment page</span><p>{paymentLink.status === "paid" ? "Razorpay payment is verified." : "One Standard Payment Link is ready; customer authorization is still required."}</p><Link className="button link-button small" href={paymentLink.url} target="_blank" rel="noreferrer">{paymentLink.status === "paid" ? "View payment page" : "Open customer page"}<ArrowRight size={14} /></Link></div>}{!proposal && !paymentLink && recoveryCase.state !== "recovered" && <div className="next-action"><Sparkles size={16} /><div><strong>Investigate next</strong><span>Run a bounded evidence review before any customer-facing action.</span><button type="button" className="button small" onClick={() => onInvestigate(recoveryCase.id)} disabled={busyKey === `investigate-${recoveryCase.id}`} style={{ marginTop: 10 }}>{busyKey === `investigate-${recoveryCase.id}` ? "Investigating…" : "Investigate case"}</button></div></div>}</>}
    {selectedTab === "messages" && <div className="detail-section"><h3>Messages and permitted documents</h3><div className="message-list">{recoveryCase.messages.length === 0 ? <EmptyState title="No messages yet" detail="The customer has not shared an Email thread for this case." icon={Mail} /> : recoveryCase.messages.map((message) => <div className="message-item" key={message.id}><div className="message-top"><span>{message.direction === "inbound" ? "Inbound Email" : "Outbound Email"} · {message.providerMode || "provider"}</span><span>{formatDateTime(message.receivedAt || message.sentAt)}</span></div><div className="message-subject">{message.subject}</div><div className="message-provenance">{message.from || message.participants[0]} → {(message.to || message.participants.slice(1)).join(", ")} · thread {message.threadId || "not supplied"}{message.providerUrl && <> · <a href={message.providerUrl} target="_blank" rel="noreferrer">Open provider</a></>}</div><p className="message-body">{message.body}</p></div>)}</div><div style={{ marginTop: 20 }}><h3>Documents</h3>{recoveryCase.documents.length === 0 ? <p>No matching documents found.</p> : recoveryCase.documents.map((document) => <div className="document-row" key={document.id}><div className="document-name"><FileText size={15} /><span>{document.name}<small>{document.providerMode || "provider"} · {document.matchReason || "Scoped to this case"}</small></span></div><span className="document-permission">{document.permission === "approved_customer_share" ? "Share-safe" : "Merchant only"}</span><SourceChip label="Preview" type="document" href={`/api/documents/${document.id}?caseId=${encodeURIComponent(recoveryCase.id)}`} /></div>)}</div></div>}
    {selectedTab === "history" && <div className="detail-section"><h3>Case history</h3><div className="history-list">{recoveryCase.latestAudit.map((event) => <HistoryItem key={event.id} event={event} />)}</div></div>}
  </section>;
}

function EvidencePath({ recoveryCase }: { recoveryCase: CaseView }) {
  if (recoveryCase.confidence === 0 && recoveryCase.workflow === "invoice_resolution") return <div className="evidence-pending" role="status"><span className="eyebrow">Evidence status</span><strong>External evidence not retrieved yet.</strong><p>Use the Rebound orb to review this case. Email and Drive records will appear only after retrieval.</p></div>;
  if (recoveryCase.workflow === "failed_purchase") {
    const paymentAttempt = recoveryCase.paymentAttempt;
    const checkoutSignal = recoveryCase.signals.find((signal) => signal.type === "checkout_abandoned");
    return <div className="evidence-path" aria-label="Purchase correlation evidence"><div className="evidence-path-heading"><span className="eyebrow">Purchase correlation</span><span className="demo-note">Facts first · one canonical purchase</span></div><div className="evidence-path-grid"><div className="path-step"><span className="path-index">1</span><div><span className="eyebrow">Razorpay payment</span><strong>{paymentAttempt?.status === "failed" ? "Authorization failed" : "No failed attempt attached"}</strong>{paymentAttempt && <><small>{paymentAttempt.razorpayPaymentId} · {formatMoney(paymentAttempt.amount, recoveryCase.obligation.currency)}</small><p>{paymentAttempt.errorDescription || "The attempt did not complete."}</p></>}</div></div><div className="path-step"><span className="path-index">2</span><div><span className="eyebrow">Checkout signal</span><strong>{checkoutSignal ? "Checkout abandoned" : "No abandonment signal attached"}</strong>{checkoutSignal && <><small>{checkoutSignal.externalId} · {formatDateTime(checkoutSignal.occurredAt)}</small><p>Same order, cart, customer and amount as the failed payment.</p></>}</div></div><div className="path-step"><span className="path-index">3</span><div><span className="eyebrow">Canonical purchase</span><strong>{recoveryCase.obligation.orderRef || "Purchase identity"}</strong><small>{recoveryCase.obligation.cartRef || "Matched cart"} · {recoveryCase.customer.email}</small><p>These signals are correlated into one recovery case; no customer message is required.</p></div></div></div></div>;
  }
  if (recoveryCase.blocker !== "missing_document") return null;
  const inbound = recoveryCase.messages.find((item) => item.direction === "inbound");
  const document = recoveryCase.documents.find((item) => item.customerId === recoveryCase.customer.id && item.obligationId === recoveryCase.obligation.id && item.permission === "approved_customer_share");
  return <div className="evidence-path" aria-label="Evidence path"><div className="evidence-path-heading"><span className="eyebrow">Evidence path</span><span className="demo-note">Facts first · inference labelled</span></div><div className="evidence-path-grid"><div className="path-step"><span className="path-index">1</span><div><span className="eyebrow">Customer email</span><strong>{inbound?.subject || "No matching inbound thread"}</strong>{inbound && <><small>{inbound.from || inbound.participants[0]} → {(inbound.to || inbound.participants.slice(1)).join(", ")} · {formatDateTime(inbound.receivedAt)}</small><p>{inbound.body}</p><div className="path-meta"><span>{inbound.providerMode || "Provider"}</span>{inbound.threadId && <span>Thread {inbound.threadId}</span>}{inbound.providerUrl && <SourceChip label="Open provider" type="email" href={inbound.providerUrl} />}</div></>}</div></div><div className="path-step"><span className="path-index">2</span><div><span className="eyebrow">Matched delivery document</span><strong>{document?.name || "No share-safe match"}</strong>{document && <><small>{document.providerMode || "Provider"} · {document.mimeType} · {document.permission === "approved_customer_share" ? "share-safe" : "merchant only"}</small><p>{document.matchReason || `Matched on ${recoveryCase.obligation.invoiceRef || "invoice"} and customer identity.`}</p><div className="path-meta"><span>{document.providerId}</span><SourceChip label="Preview evidence" type="document" href={`/api/documents/${document.id}?caseId=${encodeURIComponent(recoveryCase.id)}`} /></div></>}</div></div><div className="path-step"><span className="path-index">3</span><div><span className="eyebrow">Proposed action</span><strong>{recoveryCase.proposals[0]?.status === "executed" ? "Approved response sent" : recoveryCase.proposals[0]?.intendedOutcome || "Investigation required"}</strong><small>{recoveryCase.proposals[0]?.recipient || recoveryCase.customer.email} · {recoveryCase.proposals[0]?.policy.reason || "Policy pending"}</small><p>{recoveryCase.proposals[0]?.uncertainty || "The agent must cite both the customer request and a permission-safe document before proposing a response."}</p></div></div></div></div>;
}

function ProposalBlock({ proposal, recoveryCase, draft, editing, onEdit, onDraftChange, onApprove, onReject, busy }: { proposal: Proposal; recoveryCase?: CaseView; draft?: { subject: string; body: string }; editing: boolean; onEdit: () => void; onDraftChange: (next: { subject: string; body: string }) => void; onApprove: () => void; onReject: () => void; busy: boolean }) {
  const payload = proposal.payload;
  return <div className="proposal-block"><div className="proposal-heading"><div><div className="proposal-kicker">Proposed next step · {titleCase(proposal.type)}</div><h3>{proposal.intendedOutcome}</h3></div><StatusBadge state={proposal.status === "pending" ? "pending" : proposal.status === "executed" ? "executed" : "escalated"} label={proposal.status === "pending" ? "Approval required" : titleCase(proposal.status)} /></div><p className="proposal-explanation">{proposal.explanation}</p><div className="proposal-meta"><span>Recipient <strong>{proposal.recipient}</strong></span><span>Channel <strong>{titleCase(proposal.channel)}</strong></span><span>Outstanding at proposal <strong>{payload.amountMinor ? formatMoney(Number(payload.amountMinor), recoveryCase?.obligation.currency) : "No payment action"}</strong></span><span>Policy <strong>{proposal.policy.reason}</strong></span></div>{Boolean(payload.documentId) && <div className="proposal-delivery"><FileText size={14} /><span>Document delivery is obligation-scoped and permission-checked at execution.</span></div>}{proposal.channel === "email" && <div className="proposal-preview"><strong>{String(payload.subject || "Email preview")}</strong>{String(payload.body || "")}</div>}{proposal.uncertainty && <div className="uncertainty"><CircleHelp size={14} />{proposal.uncertainty}</div>}{editing && draft && <div className="edit-form"><label className="field-label">Subject<input className="text-input" value={draft.subject} onChange={(event) => onDraftChange({ ...draft, subject: event.target.value })} /></label><label className="field-label">Message<textarea className="text-area" value={draft.body} onChange={(event) => onDraftChange({ ...draft, body: event.target.value })} /></label></div>}{proposal.status === "pending" && <div className="proposal-actions"><button type="button" className="button primary" onClick={onApprove} disabled={busy}>{busy ? "Applying policy…" : "Approve & send"}<ArrowRight size={14} /></button><button type="button" className="button" onClick={onEdit}>{editing ? "Close edit" : "Edit"}</button><button type="button" className="button danger" onClick={onReject} disabled={busy}>Reject</button></div>}{proposal.status === "executed" && <div className="proposal-actions"><span className="demo-note">{recoveryCase?.state === "recovered" || recoveryCase?.paymentLink?.status === "paid" ? "Sent · payment verified by Razorpay" : "Sent · payment remains unverified until Razorpay confirms it"}</span></div>}</div>;
}

function incidentMemberOutcome(item: CaseView, incident: Incident) {
  if (item.state === "recovered" || item.obligation.amountPaid >= item.obligation.amountDue) return "Excluded · already paid";
  if (item.blocker === "dispute") return "Excluded · customer dispute";
  if (item.blocker === "opted_out") return "Excluded · opted out";
  if (item.blocker === "inability_to_pay") return "Excluded · inability to pay";
  if (item.blocker === "promise_to_pay") return `Excluded · promised for ${formatDateTime(item.pauseUntil)}`;
  return incident.status === "active" ? "Outreach paused" : "Eligible · revalidation queued";
}

function IncidentDetail({ incident, cases, onResolve, busy }: { incident: Incident; cases: CaseView[]; onResolve: () => void; busy: boolean }) {
  const outstanding = cases.reduce((sum, item) => sum + Math.max(0, item.obligation.amountDue - item.obligation.amountPaid), 0);
  const excluded = cases.filter((item) => incidentMemberOutcome(item, incident).startsWith("Excluded"));
  const eligible = cases.length - excluded.length;
  return <section className="case-detail"><div className="case-detail-header"><div className="case-identity"><span className="incident-icon"><TriangleAlert size={20} /></span><div><h2>{incident.provider} card authorization</h2><p>{incident.method} · {incident.instrument} · started {formatRelative(incident.startedAt)}</p></div></div><div className="case-amount"><strong>{formatMoney(outstanding)}</strong><span>{cases.length} affected cases</span></div></div><div className="detail-status-line"><StatusBadge state={incident.status} label={incident.status === "active" ? "Paused outreach" : "Resolved"} /><StatusBadge state="pending" label={incident.confirmation === "simulated" ? "Demo simulation" : titleCase(incident.confirmation)} /></div><div className="detail-section"><h3>Shared payment incident</h3><p>{incident.summary}</p><div className="incident-metrics"><div className="metric"><strong>{cases.length}</strong><span>affected cases</span></div><div className="metric"><strong>{formatMoney(outstanding)}</strong><span>outstanding value</span></div><div className="metric"><strong>{incident.confirmation === "simulated" ? "Unavailable" : titleCase(incident.confirmation)}</strong><span>Razorpay signal</span></div></div><div className="source-list">{incident.evidence.slice(0, 4).map((id) => <SourceChip key={id} label={id.startsWith("pay_") ? "Failed authorization" : "Failure cluster"} type="webhook" />)}</div></div><div className="detail-section"><h3>Affected cases</h3><div className="affected-list">{cases.map((item) => <div className="affected-row" key={item.id}><div className="affected-row-main"><strong>{item.customer.displayName}</strong><span>{formatMoney(Math.max(0, item.obligation.amountDue - item.obligation.amountPaid))} · {incidentMemberOutcome(item, incident)}</span></div><StatusBadge state={item.state} label={item.state === "recovered" ? "Excluded" : item.state === "escalated" && incident.status === "resolved" ? "Excluded" : item.state === "paused" ? "Paused" : titleCase(item.state)} /></div>)}</div></div>{incident.status === "resolved" && <div className="incident-resolution-summary"><div><span>Eligible after revalidation</span><strong>{eligible}</strong></div><div><span>Excluded with reason</span><strong>{excluded.length}</strong></div></div>}{incident.status === "active" && <div className="proposal-block"><div className="proposal-heading"><div><div className="proposal-kicker">Fixture control</div><h3>Resolve simulated incident</h3></div><StatusBadge state="pending" label="Demo simulation" /></div><p className="proposal-explanation">Revalidation will run case by case. Paid, disputed and promised-later obligations stay excluded; only eligible cases can resume.</p><div className="proposal-actions"><button type="button" className="button primary" onClick={onResolve} disabled={busy}>Resolve & revalidate <ArrowRight size={14} /></button></div></div>}{incident.status === "resolved" && <div className="next-action"><Check size={16} /><div><strong>Revalidation complete</strong><span>Every affected obligation was checked before any recovery work could resume.</span></div></div>}</section>;
}

function ApprovalsView({ data, busyKey, editingProposalId, setEditingProposalId, drafts, setDrafts, onApprove, onReject }: { data: BootstrapPayload; busyKey: string | null; editingProposalId: string | null; setEditingProposalId: (id: string | null) => void; drafts: Record<string, { subject: string; body: string }>; setDrafts: Dispatch<SetStateAction<Record<string, { subject: string; body: string }>>>; onApprove: (proposal: Proposal, recoveryCase?: CaseView) => Promise<void>; onReject: (proposal: Proposal, recoveryCase?: CaseView) => Promise<void> }) {
  const pending = data.proposals.filter((item) => item.status === "pending");
  const startEdit = (proposal: Proposal) => { setEditingProposalId(proposal.id); setDrafts((current) => ({ ...current, [proposal.id]: { subject: String(proposal.payload.subject || ""), body: String(proposal.payload.body || "") } })); };
  return <div className="content-narrow"><div className="section-intro"><div><h2>Decisions waiting for you</h2><p>External messages and links stay behind merchant approval.</p></div><span className="eyebrow">{pending.length} pending</span></div><div className="approval-grid">{pending.length === 0 ? <div className="surface-panel"><EmptyState title="Approval queue is clear" detail="No customer-facing actions are waiting. New proposals will appear here with evidence and policy context." icon={CheckCircle2} /></div> : pending.map((proposal) => { const recoveryCase = data.cases.find((item) => item.id === proposal.caseId); const draft = drafts[proposal.id]; return <div className="approval-card" key={proposal.id}><div className="approval-card-header"><div><div className="eyebrow">{titleCase(proposal.type)}</div><h3>{proposal.intendedOutcome}</h3></div><StatusBadge state="pending" label="Approval required" /></div><p>{proposal.explanation}</p><div className="approval-data"><div className="approval-data-item"><span>Recipient / scope</span><strong>{proposal.recipient}</strong><small>{proposal.scope}</small></div><div className="approval-data-item"><span>Channel</span><strong>{titleCase(proposal.channel)}</strong><small>{proposal.requiresApproval ? "Review-first" : "Policy permitted"}</small></div><div className="approval-data-item"><span>Financial effect</span><strong>{recoveryCase ? formatMoney(Math.max(0, recoveryCase.obligation.amountDue - recoveryCase.obligation.amountPaid), recoveryCase.obligation.currency) : "—"}</strong><small>No discount proposed</small></div></div><div className="source-list">{proposal.evidenceIds.map((id) => <SourceChip key={id} label={id.includes("document") ? "Drive document" : id.includes("thread") ? "Email thread" : "Payment evidence"} type={id.includes("thread") ? "email" : id.includes("document") ? "document" : "webhook"} />)}</div><div className="uncertainty"><CircleHelp size={14} />{proposal.uncertainty}</div>{proposal.channel === "email" && <div className="proposal-preview"><strong>{String(draft?.subject || proposal.payload.subject || "Email preview")}</strong>{String(draft?.body || proposal.payload.body || "")}</div>}{editingProposalId === proposal.id && draft && <div className="edit-form"><label className="field-label">Subject<input className="text-input" value={draft.subject} onChange={(event) => setDrafts((current) => ({ ...current, [proposal.id]: { ...draft, subject: event.target.value } }))} /></label><label className="field-label">Message<textarea className="text-area" value={draft.body} onChange={(event) => setDrafts((current) => ({ ...current, [proposal.id]: { ...draft, body: event.target.value } }))} /></label></div>}<div className="card-actions"><button type="button" className="button primary" disabled={busyKey === `approve-${proposal.id}`} onClick={() => void onApprove(proposal, recoveryCase)}>{busyKey === `approve-${proposal.id}` ? "Applying policy…" : "Approve & send"}<ArrowRight size={14} /></button><button type="button" className="button" onClick={() => editingProposalId === proposal.id ? setEditingProposalId(null) : startEdit(proposal)}>{editingProposalId === proposal.id ? "Close edit" : "Edit"}</button><button type="button" className="button danger" disabled={busyKey === `reject-${proposal.id}`} onClick={() => void onReject(proposal, recoveryCase)}>Reject</button></div></div>; })}</div></div>;
}

function IncidentsView({ data, busyKey, onResolve }: { data: BootstrapPayload; busyKey: string | null; onResolve: (id: string) => void }) {
  return <div className="content-narrow"><div className="section-intro"><div><h2>Shared incidents</h2><p>Suppress harmful outreach while provider-wide failures are being understood.</p></div><span className="demo-note">Fixture incident is labelled</span></div><div className="incident-grid">{data.incidents.map((incident) => <div className="incident-card" key={incident.id}><div className="incident-card-header"><div><div className="eyebrow">{incident.status === "active" ? "Active" : "Resolved"} incident</div><h3>{incident.provider} {incident.method} authorization</h3></div><StatusBadge state={incident.confirmation === "simulated" ? "pending" : "active"} label={incident.confirmation === "simulated" ? "Demo simulation" : titleCase(incident.confirmation)} /></div><p>{incident.summary}</p><div className="incident-metrics"><div className="metric"><strong>{data.cases.filter((item) => item.incidentId === incident.id).length}</strong><span>affected cases</span></div><div className="metric"><strong>{formatMoney(data.cases.filter((item) => item.incidentId === incident.id).reduce((sum, item) => sum + Math.max(0, item.obligation.amountDue - item.obligation.amountPaid), 0))}</strong><span>outstanding value</span></div><div className="metric"><strong>{incident.status === "active" ? "Paused" : "Revalidated"}</strong><span>outreach state</span></div></div><div className="affected-list">{data.cases.filter((item) => item.incidentId === incident.id).map((item) => <div className="affected-row" key={item.id}><div className="affected-row-main"><strong>{item.customer.displayName}</strong><span>{formatMoney(Math.max(0, item.obligation.amountDue - item.obligation.amountPaid))} · {incidentMemberOutcome(item, incident)}</span></div><span className={`quiet-indicator ${item.state === "recovered" ? "verified" : item.state === "escalated" ? "failed" : ""}`} title={titleCase(item.state)} /></div>)}</div>{incident.status === "active" && <div className="card-actions"><button type="button" className="button primary" disabled={busyKey === `resolve-${incident.id}`} onClick={() => onResolve(incident.id)}>{busyKey === `resolve-${incident.id}` ? "Revalidating…" : "Resolve & revalidate"}<ArrowRight size={14} /></button></div>}{incident.status === "resolved" && <div className="demo-note" style={{ marginTop: 14 }}>Resolved {formatDateTime(incident.resolvedAt)}</div>}</div>)}</div></div>;
}

function ConnectionsView({ data }: { data: BootstrapPayload }) {
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const cardData = [{ type: "razorpay" as const, title: "Razorpay", icon: ShieldCheck, description: "Payment links and signed verification.", capability: data.capabilities.payment }, { type: "email" as const, title: "Email", icon: Mail, description: "Inbound context and approval-gated outbound replies.", capability: data.capabilities.evidence }, { type: "drive" as const, title: "Google Drive", icon: FileText, description: "Scoped document matching before a file can be shared.", capability: data.capabilities.evidence }];
  return <div className="content-narrow"><div className="section-intro"><div><h2>Connections</h2><p>Every connector shows its actual provider, mode and permission boundary.</p></div><span className="eyebrow">No secrets shown</span></div>{connectionNotice && <div className="error-banner" role="status" style={{ marginBottom: 14 }}><CircleHelp size={15} />{connectionNotice}</div>}<div className="connection-grid">{cardData.map((card) => { const account = data.connectors.find((item) => item.type === card.type); const Icon = card.icon; const provider = card.capability.label; const status = card.capability.status === "ready" ? account?.status || "healthy" : card.capability.status === "fixture" ? "fixture" : card.capability.status === "unsupported" ? "error" : "not_configured"; const dotClass = status === "error" ? "error" : status === "not_configured" ? "neutral" : ""; return <div className="connection-card" key={card.type}><div className="approval-card-header"><span className="connection-icon"><Icon size={18} /></span><span className="connection-status"><span className={`health-dot ${dotClass}`} />{status === "fixture" ? "Fixture healthy" : titleCase(status)}</span></div><h3>{card.title}</h3><p>{card.description}</p><div className="connection-meta"><span className="permission">{provider}</span><span className="permission">{card.capability.status === "fixture" ? "Demo simulation" : card.capability.status === "unsupported" ? "Deferred boundary" : card.capability.status}</span>{account?.scopes.map((scope) => <span className="permission" key={scope}>{scope}</span>)}</div><p style={{ fontSize: 11, marginTop: 16 }}>{card.capability.detail || `Last sync ${formatRelative(account?.lastSyncAt)}`}</p><button type="button" className="button small" style={{ marginTop: 12 }} onClick={() => setConnectionNotice(card.capability.status === "unsupported" ? "This provider is a declared boundary in the current build; no fallback connector is invoked." : card.type === "razorpay" ? "Razorpay test credentials are configured server-side; this screen never exposes them." : "Connector credentials are configured server-side; this screen never exposes them.")}><Plus size={14} />Configure locally</button></div>; })}</div><div className="surface-panel panel-pad" style={{ marginTop: 14 }}><div className={data.mode === "fixture" ? "demo-note" : "eyebrow"}>{data.mode === "fixture" ? "Fixture boundary" : "Selected provider boundary"}</div><p style={{ marginBottom: 0, color: "var(--text-2)", fontSize: 12, lineHeight: 1.55 }}>{data.mode === "fixture" ? "Fixture records use the same service and policy path as the selected provider boundary. No real money moves in this mode." : "Selected provider calls remain server-side; missing credentials fail closed and no fixture records are used as a fallback."}</p></div></div>;
}

function HistoryView({ data, query, setQuery }: { data: BootstrapPayload; query: string; setQuery: (value: string) => void }) {
  const events = data.audit.filter((item) => !query || `${item.summary} ${item.eventType} ${item.actor}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="content-narrow"><div className="section-intro"><div><h2>History</h2><p>Append-only evidence trail across proposals, approvals, messages, webhooks and ledger entries.</p></div><span className="eyebrow">{events.length} events</span></div>{data.evaluation && <EvaluationPanel report={data.evaluation} proof={data.integrationProof} batchRuns={data.batchRuns} />}<div className="history-toolbar"><div style={{ position: "relative", maxWidth: 360, width: "100%" }}><Search size={15} style={{ position: "absolute", left: 10, top: 12, color: "var(--text-3)" }} /><input className="text-input" style={{ paddingLeft: 32 }} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter history" /></div></div><div className="surface-panel history-table"><div className="history-table-head"><span>Actor</span><span>Action</span><span>Evidence</span><span>When</span></div>{events.length === 0 ? <EmptyState title="No matching events" detail="Try a different actor, action or source." icon={HistoryIcon} /> : events.map((event) => <div className="history-table-row" key={event.id}><span className="history-actor">{event.actor}</span><span className="history-action">{titleCase(event.eventType)}</span><span className="history-source">{event.summary}</span><span className="history-source">{formatDateTime(event.createdAt)}</span></div>)}</div></div>;
}

function EvaluationPanel({ report, proof, batchRuns }: { report: BootstrapPayload["evaluation"]; proof: BootstrapPayload["integrationProof"]; batchRuns: BootstrapPayload["batchRuns"] }) {
  if (!report) return null;
  const metric = report.metrics;
  const unresolved = report.results.filter((result) => result.status === "unresolved" || result.status === "incorrect" || result.status === "error");
  return <section className="evaluation-panel surface-panel panel-pad" aria-label="Evaluation results"><div className="evaluation-heading"><div><span className="eyebrow">Measured evaluation · {report.datasetVersion}</span><h3>Decision quality, separated from live collection</h3></div><span className="demo-note">{report.mode === "fixture" ? "Fixture evaluation" : "Live model evaluation"}</span></div><div className="evaluation-metrics"><div className="metric"><strong>{metric.totalCases}</strong><span>cases · {formatMoney(metric.startingOutstanding)} starting</span></div><div className="metric"><strong>{metric.blockerClassification.correct}/{metric.blockerClassification.denominator}</strong><span>blocker classification</span></div><div className="metric"><strong>{metric.interventionAccuracy.correct}/{metric.interventionAccuracy.denominator}</strong><span>intervention accuracy</span></div><div className="metric"><strong>{metric.documentMatches.correct}/{metric.documentMatches.denominator}</strong><span>document matches</span></div><div className="metric"><strong>{metric.unnecessaryContactsAvoided.correct}/{metric.unnecessaryContactsAvoided.denominator}</strong><span>unnecessary contacts avoided</span></div><div className="metric"><strong>{formatMoney(metric.remainingValue)}</strong><span>remaining simulated exposure</span></div></div><div className="evaluation-proof"><div><span className="eyebrow">API-confirmed integration proof</span><p>{proof.mode === "fixture" ? "Fixture decisions and payments do not increment these counters." : proof.apiConfirmed ? "Live provider artifacts were observed and recorded." : "No live provider artifact has been confirmed yet."}</p></div><div className="proof-counts"><span>Messages {proof.connectorRetrievedMessages}</span><span>Documents {proof.connectorRetrievedDocuments}</span><span>Sent emails {proof.providerSentEmails}</span><span>Payment links {proof.razorpayCreatedLinks}</span><span>Signed payments {proof.signedRazorpayPayments}</span><span>Verified amount {formatMoney(proof.verifiedCollectedAmount)}</span></div></div>{batchRuns.length > 0 && <div className="batch-summary"><span className="eyebrow">Latest batch instruction</span>{batchRuns.slice(0, 1).map((batch) => <div className="batch-summary-row" key={batch.id}><strong>{titleCase(batch.status)} · {batch.completedCaseIds.length}/{batch.caseIds.length} case investigations</strong><span>Concurrency {batch.concurrency} · {batch.failedCaseIds.length} failed · {formatDateTime(batch.finishedAt || batch.startedAt)}</span></div>)}</div>}{unresolved.length > 0 && <details className="evaluation-failures"><summary>Inspect {unresolved.length} unresolved or non-perfect result{unresolved.length === 1 ? "" : "s"}</summary><div>{unresolved.map((result) => <div className="evaluation-failure" key={result.caseId}><strong>{result.caseId} · {result.label}</strong><span>{result.status} · expected {result.interventionExpected}, actual {result.interventionActual}{result.reason ? ` · ${result.reason}` : ""}</span></div>)}</div></details>}<small className="evaluation-footnote">Baseline: {report.baseline?.name || "none"} · {report.baseline?.unnecessaryContacts || 0} unnecessary reminder contacts out of {report.baseline?.denominator || metric.totalCases}. This is a policy comparison, not causal revenue uplift. Regenerate with <code>npm run evaluate</code>.</small></section>;
}

function PoliciesView({ data, draft, setDraft, busyKey, onSave }: { data: BootstrapPayload; draft: Partial<Policy>; setDraft: Dispatch<SetStateAction<Partial<Policy>>>; busyKey: string | null; onSave: () => void }) {
  const policy = { ...data.policy, ...draft };
  const emailAllowed = policy.allowedChannels?.includes("email") ?? false;
  const toggle = (key: "reviewFirst" | "discountsAllowed" | "incidentSuppression") => setDraft((current) => ({ ...current, [key]: !policy[key] }));
  return <div className="content-narrow"><div className="section-intro"><div><h2>Policies</h2><p>Controls are versioned and rechecked immediately before external actions.</p></div><span className="eyebrow">Version {data.policy.version}</span></div><div className="policy-layout"><div className="surface-panel panel-pad"><div className="policy-form"><div className="toggle-row"><div className="toggle-copy"><strong>Review-first mode</strong><span>Require merchant approval before customer-facing Email or Payment Link work.</span></div><button type="button" className={`toggle ${policy.reviewFirst ? "on" : ""}`} aria-pressed={policy.reviewFirst} aria-label="Toggle review-first mode" onClick={() => toggle("reviewFirst")} /></div><div className="toggle-row"><div className="toggle-copy"><strong>Incident suppression</strong><span>Pause unsent outreach when provider-wide failures are active.</span></div><button type="button" className={`toggle ${policy.incidentSuppression ? "on" : ""}`} aria-pressed={policy.incidentSuppression} aria-label="Toggle incident suppression" onClick={() => toggle("incidentSuppression")} /></div><div className="toggle-row"><div className="toggle-copy"><strong>Discounts</strong><span>Keep discounts disabled unless a merchant explicitly enables them.</span></div><button type="button" className={`toggle ${policy.discountsAllowed ? "on" : ""}`} aria-pressed={policy.discountsAllowed} aria-label="Toggle discounts" onClick={() => toggle("discountsAllowed")} /></div><div className="field-grid"><label className="field-label">Contact starts<input type="number" min={0} max={23} className="text-input" value={policy.contactStartHour} onChange={(event) => setDraft((current) => ({ ...current, contactStartHour: Number(event.target.value) }))} /></label><label className="field-label">Contact ends<input type="number" min={1} max={24} className="text-input" value={policy.contactEndHour} onChange={(event) => setDraft((current) => ({ ...current, contactEndHour: Number(event.target.value) }))} /></label><label className="field-label">Timezone<input type="text" className="text-input" value={policy.timezone} onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))} /></label><label className="field-label">Maximum attempts<input type="number" min={1} max={10} className="text-input" value={policy.maxAttempts} onChange={(event) => setDraft((current) => ({ ...current, maxAttempts: Number(event.target.value) }))} /></label><label className="field-label">Minimum spacing (hours)<input type="number" min={1} max={720} className="text-input" value={policy.minimumSpacingHours} onChange={(event) => setDraft((current) => ({ ...current, minimumSpacingHours: Number(event.target.value) }))} /></label></div><div><span className="eyebrow">Allowed channels</span><div className="toggle-row" style={{ marginTop: 8, paddingTop: 0 }}><div className="toggle-copy"><strong>Email</strong><span>{emailAllowed ? "Enabled for approved recovery messages." : "Disabled; email proposals will be blocked."}</span></div><button type="button" className={`toggle ${emailAllowed ? "on" : ""}`} aria-pressed={emailAllowed} aria-label="Toggle Email channel" onClick={() => setDraft((current) => ({ ...current, allowedChannels: emailAllowed ? [] : ["email"] }))} /></div><div className="connection-meta"><span className="permission">No automatic debit</span><span className="permission">No discount by default</span></div></div><button type="button" className="button primary" onClick={onSave} disabled={busyKey === "policy"}>Save policy v{data.policy.version + 1}<ArrowRight size={14} /></button></div></div><div className="surface-panel panel-pad"><span className="eyebrow">Consequence preview</span><h3 style={{ margin: "8px 0 0", fontSize: 15 }}>What this means in practice</h3><div className="consequence-list"><div className="consequence"><Check size={15} />A failed purchase produces one reviewable recovery action, not repeated reminders.</div><div className="consequence"><Check size={15} />Actions outside {policy.contactStartHour}:00–{policy.contactEndHour}:00 {policy.timezone} wait for the next permitted window.</div><div className="consequence"><Check size={15} />A payment promise pauses contact; it never authorizes a debit.</div><div className="consequence"><Check size={15} />A verified payment posts to the ledger once and cancels competing jobs.</div></div><div className="next-action" style={{ marginTop: 22 }}><ShieldCheck size={16} /><div><strong>Backend enforced</strong><span>These settings are evaluated on the server against the current case version.</span></div></div></div></div></div>;
}

function HistoryItem({ event }: { event: BootstrapPayload["audit"][number] }) {
  return <div className="history-item"><div className="history-top"><span>{event.actor} · {titleCase(event.eventType)}</span><span>{formatDateTime(event.createdAt)}</span></div><div className="message-body">{event.summary}</div>{event.demo && <span className="demo-note" style={{ marginTop: 7 }}>Demo simulation</span>}</div>;
}

interface AgentDrawerProps {
  data: BootstrapPayload;
  selectedCase?: CaseView;
  messages: AgentMessage[];
  state: OrbState;
  label: string;
  instruction: string;
  setInstruction: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onInvestigate: () => void;
  onPause: () => void;
  onResume: () => void;
  onClose: () => void;
  busy: boolean;
}

interface PanelDragSession {
  pointerId: number;
  startX: number;
  startY: number;
  startPosition: FloatingPosition;
}

const AGENT_PANEL_BOTTOM_GAP = FLOATING_INSET;

function AgentDrawer({ data, selectedCase, messages, state, label, instruction, setInstruction, onSubmit, onInvestigate, onPause, onResume, onClose, busy }: AgentDrawerProps) {
  const prompts = selectedCase ? [`What is blocking ${selectedCase.customer.displayName}?`, "Explain the current evidence and status."] : ["How many issues do we have?", "Which customers are affected?", "Summarize the highest-priority cases."];
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<PanelDragSession | null>(null);
  const positionRef = useRef<FloatingPosition | null>(null);
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const [dragging, setDragging] = useState(false);

  const setPanelPosition = useCallback((next: FloatingPosition) => {
    positionRef.current = next;
    setPosition(next);
  }, []);

  useLayoutEffect(() => {
    const placePanel = () => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      const preferred = positionRef.current || {
        x: window.innerWidth - rect.width - FLOATING_INSET,
        y: window.innerHeight - rect.height - AGENT_PANEL_BOTTOM_GAP
      };
      setPanelPosition(findSafeFloatingPosition(preferred, { width: rect.width, height: rect.height }, { ignoreSelectors: [".agent-drawer"] }));
    };

    placePanel();
    window.addEventListener("resize", placePanel);
    return () => window.removeEventListener("resize", placePanel);
  }, [setPanelPosition]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const panelSize = () => {
    const rect = panelRef.current?.getBoundingClientRect();
    return rect ? { width: rect.width, height: rect.height } : { width: 360, height: 520 };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startPosition: positionRef.current || { x: rect.left, y: rect.top } };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = { x: drag.startPosition.x + event.clientX - drag.startX, y: drag.startPosition.y + event.clientY - drag.startY };
    const size = panelSize();
    setPanelPosition(findSafeFloatingPosition(next, size, { ignoreSelectors: [".agent-drawer"] }));
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const delta = event.key === "ArrowUp" ? { x: 0, y: -step }
      : event.key === "ArrowDown" ? { x: 0, y: step }
        : event.key === "ArrowLeft" ? { x: -step, y: 0 }
          : event.key === "ArrowRight" ? { x: step, y: 0 }
            : null;
    if (!delta) return;
    event.preventDefault();
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = positionRef.current || { x: rect.left, y: rect.top };
    setPanelPosition(findSafeFloatingPosition({ x: current.x + delta.x, y: current.y + delta.y }, panelSize(), { ignoreSelectors: [".agent-drawer"] }));
  };

  const attentionTone = state === "success" ? "verified" : state === "approval" || state === "paused" || state === "inspecting" || state === "working" ? "waiting" : state === "uncertain" || state === "error" ? "failed" : "";
  const panelStyle = position ? { "--agent-panel-x": `${position.x}px`, "--agent-panel-y": `${position.y}px` } as CSSProperties : undefined;

  return <aside ref={panelRef} id="agent-drawer" className={`agent-drawer ${position ? "is-positioned" : ""} ${dragging ? "dragging" : ""}`} style={panelStyle} role="dialog" aria-labelledby="agent-drawer-title" aria-describedby="agent-drawer-description">
    <div className="drawer-header" tabIndex={0} role="group" aria-label="Move Rebound agent panel. Use arrow keys to move." onKeyDown={handleKeyDown} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={finishPointerDrag} onPointerCancel={finishPointerDrag}>
      <div className="drawer-heading"><span className="drawer-drag-grip" aria-hidden="true">⠿</span><div><h2 id="agent-drawer-title">Rebound agent</h2><p id="agent-drawer-description">Bounded evidence review · model proposes, code enforces.</p><div className={`drawer-state ${state}`} role="status" aria-live="polite"><span aria-hidden="true" />{label}</div></div></div>
      <button type="button" className="icon-button" onPointerDown={(event) => event.stopPropagation()} onClick={onClose} aria-label="Close Rebound agent"><X size={17} /></button>
    </div>
    <div className="drawer-body">
      <div className="eyebrow">Current attention</div>
      <div className="activity-line" style={{ marginTop: 15 }}><span className={`activity-line-mark ${attentionTone}`} /><div className="activity-line-copy"><strong>{selectedCase?.customer.displayName || "Northstar Office"}</strong><br />{selectedCase ? selectedCase.nextAction : label}</div></div>
      {selectedCase && <><div className="eyebrow" style={{ marginTop: 9 }}>Scoped sources</div><div className="source-list" style={{ marginTop: 12 }}>
        {selectedCase.paymentAttempt && <SourceChip label="Razorpay failure" type="webhook" />}
        {selectedCase.signals.map((signal) => <SourceChip key={signal.id} label={titleCase(signal.type)} type="source" />)}
        {selectedCase.messages.length > 0 && <SourceChip label="Email thread" type="email" />}
        {selectedCase.documents.map((document) => <SourceChip key={document.id} label={`${document.providerMode === "fixture" ? "Fixture · " : ""}${document.name}`} type="document" href={`/api/documents/${document.id}?caseId=${encodeURIComponent(selectedCase.id)}`} />)}
      </div></>}
      <div className="eyebrow" style={{ marginTop: 18 }}>Recent activity</div>
      <div style={{ marginTop: 15 }}>{data.audit.slice(0, 5).map((event) => <div className="activity-line" key={event.id}><span className={`activity-line-mark ${event.eventType.includes("verified") || event.eventType.includes("posted") ? "verified" : event.eventType.includes("paused") ? "waiting" : ""}`} /><div className="activity-line-copy">{event.summary}<br /><span style={{ color: "var(--text-3)", fontSize: 10 }}>{formatRelative(event.createdAt)}</span></div></div>)}</div>
      {selectedCase && <div className="drawer-controls"><h3>Case controls</h3><div className="drawer-control-grid"><button type="button" className="button full" onClick={onInvestigate} disabled={busy || selectedCase.state === "recovered"}><Search size={14} />Review evidence</button><button type="button" className="button full" onClick={selectedCase.state === "paused" ? onResume : onPause} disabled={busy || ["recovered", "closed"].includes(selectedCase.state)}><Pause size={14} />{selectedCase.state === "paused" ? "Resume outreach" : "Pause outreach"}</button></div></div>}
      <div className="drawer-controls"><h3>Bounded requests</h3><p className="drawer-help">Ask about current workspace state or request an implemented case review. External actions still require approval.</p><div className="agent-prompts">{prompts.map((prompt) => <button type="button" className="agent-prompt" key={prompt} onClick={() => setInstruction(prompt)}>{prompt}</button>)}</div><form onSubmit={onSubmit}><label className="sr-only" htmlFor="agent-instruction">Bounded agent request</label><div className="drawer-input-row"><input id="agent-instruction" className="text-input" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="Ask about this workspace…" aria-label="Bounded agent request" /><button type="submit" className="button primary" disabled={!instruction.trim() || busy} aria-label="Submit agent request">{busy ? <RefreshCcw size={15} className="spin" /> : <Send size={15} />}</button></div></form></div>
      {messages.length > 0 && <div className="agent-transcript" aria-live="polite">{messages.slice(-8).map((message) => <div className={`agent-message ${message.role}`} key={message.id}><span className="agent-message-role">{message.role === "user" ? "You" : "Rebound"}</span><p>{message.text}</p></div>)}</div>}
    </div>
    <div className="drawer-footer"><span className="demo-note">{data.mode === "fixture" ? "Demo simulation · no real money" : "Live guardrails active"}</span><small>Payment success is never inferred here. Only a signed, persisted and verified Razorpay event may recover money.</small></div>
  </aside>;
}
