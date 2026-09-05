export interface BalanceResult {
  accepted: number;
  remaining: number;
  overpayment: number;
  status: "partial" | "paid" | "overpayment";
}

export function reconcilePayment(amountDue: number, amountPaid: number, paymentAmount: number): BalanceResult {
  const remainingBefore = Math.max(0, amountDue - amountPaid);
  const accepted = Math.min(remainingBefore, Math.max(0, paymentAmount));
  const overpayment = Math.max(0, paymentAmount - accepted);
  const remaining = Math.max(0, remainingBefore - accepted);
  return {
    accepted,
    remaining,
    overpayment,
    status: overpayment > 0 ? "overpayment" : remaining === 0 ? "paid" : "partial"
  };
}

export function isFullyPaid(amountDue: number, amountPaid: number) {
  return amountPaid >= amountDue;
}
