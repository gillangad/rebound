"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, FileText, LockKeyhole, Mail } from "lucide-react";
import type { CustomerPageData } from "@/shared/types";
import { formatMoney } from "@/shared/formatters";

export function CustomerRecovery({ data, publicToken }: { data: CustomerPageData; publicToken: string }) {
  const [status, setStatus] = useState<"idle" | "paying" | "paid" | "error">(data.paymentLink.status === "paid" ? "paid" : "idle");
  const [message, setMessage] = useState("");
  const outstanding = Math.max(0, data.obligation.amountDue - data.obligation.amountPaid);
  const pay = async () => {
    if (!data.demo) return;
    setStatus("paying");
    try {
      const response = await fetch(`/api/fixture/pay/${encodeURIComponent(publicToken)}`, { method: "POST" });
      const result = await response.json() as { error?: { message?: string }; remainingAmount?: number; deduplicated?: boolean };
      if (!response.ok) throw new Error(result.error?.message || "Payment could not be completed.");
      setStatus("paid");
      setMessage(result.deduplicated ? "This payment was already verified; it was not counted twice." : "Payment verified and recorded once. Follow-up work has stopped.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Payment could not be completed.");
    }
  };

  return <main className="customer-page"><article className="customer-card"><div className="customer-brand"><span className="customer-brand-mark" aria-hidden="true">↗</span>{data.merchant.name}</div><div className="customer-kicker">Secure recovery page</div><h1>{data.obligation.kind === "invoice" ? `Invoice ${data.obligation.invoiceRef}` : "Your ergonomic chair order"}</h1><p className="customer-intro">Hi {data.customer.displayName.split(" ")[0]}, this page gives you one clear way to resolve the outstanding Northstar Office {data.obligation.kind === "invoice" ? "invoice" : "purchase"}. No account is required.</p><div className="customer-amount"><span className="customer-amount-label">Outstanding amount</span><strong>{formatMoney(outstanding, data.obligation.currency)}</strong></div><div className="customer-reason">{data.case.blocker === "missing_document" ? "The requested delivery confirmation is attached below so your finance team can release the invoice." : data.case.blocker === "payment_failed" ? "The earlier payment authorization did not complete. You can retry the original amount securely when convenient." : "This recovery page is linked to one Northstar Office obligation and cannot be used for another customer."}</div>{data.document && <a className="customer-document" href={`/api/documents/${data.document.id}?token=${encodeURIComponent(publicToken)}`} target="_blank" rel="noreferrer"><FileText size={17} aria-hidden="true" /><span>{data.document.name}<br /><small style={{ color: "var(--text-2)" }}>Matched and approved for this obligation</small></span><ArrowRight size={14} style={{ marginLeft: "auto" }} /></a>}{status === "paid" ? <div className="customer-result" role="status"><h2><CheckCircle2 size={16} style={{ verticalAlign: "-3px", marginRight: 5 }} />Payment verified</h2><p>{message || "Your payment is verified. Northstar Office will not send duplicate follow-ups."}</p></div> : <div className="customer-actions">{data.demo ? <button type="button" className="button primary" onClick={() => void pay()} disabled={status === "paying" || outstanding === 0}>{status === "paying" ? "Verifying demo payment…" : "Pay securely with Razorpay"}<LockKeyhole size={15} /></button> : <a className="button primary" href={data.paymentLink.url} target="_blank" rel="noreferrer">Pay securely with Razorpay<LockKeyhole size={15} /></a>}<a className="button" href={`mailto:collections@northstar.example?subject=${encodeURIComponent(`Reply about ${data.obligation.invoiceRef || data.obligation.orderRef}`)}`}><Mail size={15} />Reply by email</a></div>}{status === "error" && <p className="customer-footnote" role="alert" style={{ color: "var(--failed)" }}>{message}</p>}<p className="customer-footnote">{data.demo ? "Demo simulation · no real money moves in fixture mode." : "Razorpay owns the secure payment UI. Your card details are never shared with Northstar Office."}</p></article></main>;
}
