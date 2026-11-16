// ─── Shared loan balance/interest math ──────────────────────────────────────
// Pure, dependency-free ES module (explicit .mjs extension, same reason as
// resimpli-shared.mjs: package.json has no "type":"module"). Extracted
// verbatim from src/Tracker.jsx so this money math can be unit-tested with
// plain Node and reused by the Whiteboard cash-flow forecast without
// re-deriving a second, potentially-drifting copy of it. Tracker.jsx imports
// these instead of defining them locally — nothing here changes what any
// existing screen computes or displays, except calcIntEarned's new optional
// third argument (see below), which every existing call site still omits.

// toISOString() converts to UTC first, so in the evening in a US timezone it
// can already be "tomorrow" in UTC while it's still today locally — use local
// date parts instead. (Same TODAY Tracker.jsx computes at module load.)
export const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

export const daysBetween = (d1, d2) => {
  if (!d1 || !d2) return 0;
  return Math.max(0, Math.floor((new Date(d2) - new Date(d1)) / 864e5));
};
export const yearDays = l => (l?.loanType === "hard" ? 360 : 365);

// A draw's `amount` is the NET that actually hits the account — whatever the lender takes as a
// `fee` is on top of that, not out of it, so what's actually drawn against the committed
// facility (and what interest accrues on) is amount + fee, never amount - fee.
export const drawGross = d => (d.amount || 0) + (d.fee || 0);

// Per-lender hard-money billing settings, editable on the lender's own page and applied to
// every loan from that lender. Defaults reproduce the app's existing behavior exactly (a
// loan's own loanType decides the defaults), so nothing changes for a lender until it's
// explicitly customized — see hardPaymentSchedule below for how these are used.
export const defaultLenderPaymentSettings = loanType => ({
  graceMonth: loanType === "hard",
  prorateStubAtClosing: false,
  firstFullMonthAtClosing: false,
  dayCountBasis: loanType === "hard" ? 360 : 365,
  monthlyMethod: loanType === "hard" ? "perDiem" : "flat",
  drawFee: 0,
});
export const resolveLenderSettings = (data, lenderName, loanType) => {
  const rec = (data?.lenders || []).find(l => l.name === lenderName);
  return { ...defaultLenderPaymentSettings(loanType), ...(rec?.paymentSettings || {}) };
};

export const calcBalance = (l, asOf = TODAY) => {
  if (!l?.startDate || !l?.principal) return l?.principal ?? 0;
  const pt = l.paymentType || "closing";
  if (pt === "monthly_rate" || pt === "monthly_fixed") return l.principal; // payoff = principal only
  if (l.interestType === "fixed") return l.principal + (l.interestRate || 0);
  const end = l.endDate && l.endDate <= asOf ? l.endDate : asOf;
  if (l.startDate > end) return l.principal;
  if (pt === "monthly_rate_split") {
    const totalOwed = (l.principal * (l.interestRate || 0)) / 100 * (daysBetween(l.startDate, end) / yearDays(l));
    return l.principal + Math.max(0, totalOwed - calcMonthlyPaidPortion(l, asOf));
  }
  return l.principal + (l.principal * (l.interestRate || 0)) / 100 * (daysBetween(l.startDate, end) / yearDays(l));
};

export const calcMonthlyPaidPortion = (l, asOf = TODAY) => {
  if (!l?.startDate || !l?.principal || l.paymentType !== "monthly_rate_split" || l.interestType === "fixed") return 0;
  const end = l.endDate && l.endDate <= asOf ? l.endDate : asOf;
  if (l.startDate > end) return 0;
  const rate = l.splitMonthlyRate || 0;
  const flatMonthly = (l.principal * rate) / 1200;
  const [sy, sm] = l.startDate.split("-").map(Number);
  let cy = sy, cm = sm + 1; if (cm > 12) { cm = 1; cy += 1; }
  let prevDate = l.startDate, total = 0, first = true;
  while (true) {
    const dateStr = `${cy}-${String(cm).padStart(2, "0")}-01`;
    if (dateStr > end) break;
    if (first) {
      const [dy, dm] = dateStr.split("-").map(Number);
      let py = dy, pm = dm - 1; if (pm < 1) { pm = 12; py -= 1; }
      const isFullMonth = prevDate === `${py}-${String(pm).padStart(2, "0")}-01`;
      total += isFullMonth ? flatMonthly : (l.principal * rate) / 100 * (daysBetween(prevDate, dateStr) / 360);
      first = false;
    } else {
      total += flatMonthly;
    }
    prevDate = dateStr;
    cm += 1; if (cm > 12) { cm = 1; cy += 1; }
  }
  return Math.round(total * 100) / 100;
};

// Same calendar date N months later, with the day clamped to that month's length (Jan 31 + 1
// month -> Feb 28/29, not an overflow into March). Used by hardPaymentSchedule's grace-month
// handling.
export const monthsLater = (y, m, d, n) => {
  let nm = m + n;
  const ny = y + Math.floor((nm - 1) / 12);
  nm = ((nm - 1) % 12) + 1;
  const lastDay = new Date(ny, nm, 0).getDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
};

// Interest is requested/prorated as of the 1st, but the bank doesn't move money on a weekend —
// if the 1st is a Sat/Sun, it actually posts the next Monday. Purely a display-date shift;
// proration always uses the 1st itself. Used by hardPaymentSchedule.
export const firstBusinessDay = dateStr => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const add = dow === 6 ? 2 : dow === 0 ? 1 : 0;
  const dt = new Date(y, m - 1, d + add);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};

// The recurring monthly-interest payment schedule for one monthly-paid loan (monthly_rate,
// monthly_fixed, or monthly_rate_split) — the exact math the History tab's computeHistoryEvents
// uses (via its own addHardPayments, which now just calls this and pushes the full event shape
// History needs), extracted here so calcIntEarned and the Whiteboard cash-flow forecast can
// reuse it instead of re-deriving a second, potentially-drifting version. Any loan can be set
// up with monthly-paid interest, private or hard money. Billing mechanics (grace period,
// day-count basis, flat vs. per-diem, whether the first month is prepaid at closing, a
// per-draw fee) come from the lender's own Payment Settings (resolveLenderSettings), defaulting
// to plain per-diem/no-grace/no-stub when unset.
//
// `cutoff` bounds how far forward the schedule runs — capped at the loan's own endDate if it's
// already closed, same as the History tab (which passes TODAY); a forecast can pass any future
// date to see payments scheduled through then, including interest on active draws.
//
// Returns [{date, rawDate, amount}] — `date` is bank-holiday/weekend-shifted (matches what
// History displays); `rawDate` is the unshifted 1st-of-month bill date (used to build a stable
// event id). Amounts are rounded to the cent; zero/negative-amount periods are omitted.
export function hardPaymentSchedule(loan, data, cutoff) {
  if (!loan?.startDate) return [];
  const pt = loan.paymentType || "closing";
  if (pt !== "monthly_rate" && pt !== "monthly_fixed" && pt !== "monthly_rate_split") return [];
  const endBound = loan.endDate || cutoff;
  const [sy, sm, sd] = loan.startDate.split("-").map(Number);
  const settings = resolveLenderSettings(data, loan.lenderName, loan.loanType);
  const billRate = pt === "monthly_rate_split" ? (loan.splitMonthlyRate || 0) : (loan.interestRate || 0);
  const dailyRate = billRate / 100 / settings.dayCountBasis;
  const flatMonthly = pt === "monthly_fixed" ? (loan.monthlyPayment || 0) : (loan.principal || 0) * billRate / 1200;
  const feeFor = (periodStart, periodEndExclusive) =>
    (loan.drawFacility?.draws || []).filter(d => d.date && d.date >= periodStart && d.date < periodEndExclusive).length * (settings.drawFee || 0);
  const results = [];
  const pushPayment = (dateStr, amount) => {
    amount = Math.round(amount * 100) / 100;
    if (amount > 0) results.push({ date: firstBusinessDay(dateStr), rawDate: dateStr, amount });
  };

  if (settings.prorateStubAtClosing) {
    const skip = 1 + (settings.firstFullMonthAtClosing ? 1 : 0) + (settings.graceMonth ? 1 : 0);
    let cy = sy, cm = sm + skip; while (cm > 12) { cm -= 12; cy += 1; }
    let prevDate = `${cy}-${String(cm).padStart(2, "0")}-01`;
    while (true) {
      const periodStart = `${cy}-${String(cm).padStart(2, "0")}-01`;
      let billY = cy, billM = cm + 1; if (billM > 12) { billM = 1; billY += 1; }
      const dateStr = `${billY}-${String(billM).padStart(2, "0")}-01`;
      if (dateStr > endBound) break;
      const lastDay = new Date(cy, cm, 0).getDate();
      let amount = settings.monthlyMethod === "flat" ? flatMonthly : (loan.principal || 0) * dailyRate * lastDay;
      (loan.drawFacility?.draws || []).forEach(d => {
        if (!d.date || d.date >= periodStart) return;
        const drawStart = d.date > prevDate ? d.date : prevDate;
        amount += settings.monthlyMethod === "flat" ? drawGross(d) * billRate / 1200 : drawGross(d) * dailyRate * daysBetween(drawStart, periodStart);
      });
      pushPayment(dateStr, amount + feeFor(prevDate, periodStart));
      prevDate = periodStart;
      cm += 1; if (cm > 12) { cm = 1; cy += 1; }
    }
    return results;
  }

  const firstDue = settings.graceMonth ? monthsLater(sy, sm, sd, 1) : loan.startDate;
  let cy = sy, cm = sm + 1; if (cm > 12) { cm = 1; cy += 1; }
  const schedule = [];
  while (true) {
    const dateStr = `${cy}-${String(cm).padStart(2, "0")}-01`;
    if (dateStr > endBound) break;
    if (dateStr >= firstDue) schedule.push(dateStr);
    cm += 1; if (cm > 12) { cm = 1; cy += 1; }
  }
  let prevDate = loan.startDate;
  schedule.forEach(dateStr => {
    const days = daysBetween(prevDate, dateStr);
    let amount;
    if (settings.monthlyMethod === "flat") {
      const [dy, dm] = dateStr.split("-").map(Number);
      let py = dy, pm = dm - 1; if (pm < 1) { pm = 12; py -= 1; }
      const isFullMonth = prevDate === `${py}-${String(pm).padStart(2, "0")}-01`;
      amount = isFullMonth ? flatMonthly : (loan.principal || 0) * billRate / 100 * (days / 360);
      (loan.drawFacility?.draws || []).forEach(d => {
        if (!d.date || d.date >= dateStr || d.date < prevDate) return;
        amount += drawGross(d) * billRate / 1200;
      });
    } else if (pt === "monthly_fixed") {
      amount = (loan.monthlyPayment || 0) * days / 30.44;
    } else {
      amount = (loan.principal || 0) * dailyRate * days;
      // Rehab draw facility: each draw accrues its own interest from its actual draw date (not
      // the loan's origination date), folded into the same 1st-of-month payment.
      (loan.drawFacility?.draws || []).forEach(d => {
        if (!d.date || d.date >= dateStr) return;
        const drawStart = d.date > prevDate ? d.date : prevDate;
        amount += drawGross(d) * dailyRate * daysBetween(drawStart, dateStr);
      });
    }
    pushPayment(dateStr, amount + feeFor(prevDate, dateStr));
    prevDate = dateStr;
  });
  return results;
}

// Total interest "earned"/paid as of a date, matching the display elsewhere in the app. The
// `data` argument is new and optional: when omitted, every pre-existing call site in
// Tracker.jsx keeps its exact old behavior (continuous accrual from the loan's own rate, which
// does NOT reflect draws for a monthly_rate/monthly_fixed loan, or billing mechanics like a
// grace month). When `data` IS passed, a monthly_rate/monthly_fixed loan's figure instead sums
// hardPaymentSchedule(loan, data, asOf) — the real History-tab billing schedule, draws
// included — which is strictly more accurate and is what the one "loan card" display bug fix
// (and the Whiteboard cash-flow forecast's sell-side interest-already-paid figure) both use.
export const calcIntEarned = (l, asOf = TODAY, data = null) => {
  if (!l?.startDate || !l?.principal) return 0;
  const pt = l.paymentType || "closing";
  const end = l.endDate && l.endDate <= asOf ? l.endDate : asOf;
  const days = daysBetween(l.startDate, end);
  if (pt === "monthly_rate" || pt === "monthly_fixed") {
    if (data) return Math.round(hardPaymentSchedule(l, data, end).reduce((s, p) => s + p.amount, 0) * 100) / 100;
    if (pt === "monthly_rate") return Math.round((l.principal || 0) * (l.interestRate || 0) / 100 / yearDays(l) * days * 100) / 100;
    return Math.round((l.monthlyPayment || 0) * days / 30.44 * 100) / 100;
  }
  // Total earned either way — the monthly-paid portion (real cash already received) plus
  // whatever's still accruing onto the balance, due at closing.
  if (pt === "monthly_rate_split") return Math.round((calcMonthlyPaidPortion(l, asOf) + (calcBalance(l, asOf) - (l.principal || 0))) * 100) / 100;
  return Math.round((calcBalance(l, asOf) - (l.principal || 0)) * 100) / 100;
};
