// ─── Whiteboard cash-flow forecast — pure helpers ───────────────────────────────────────
// Dependency-free ES module (same reason as resimpli-shared.mjs/loan-schedule-shared.mjs —
// no "type":"module" in package.json), so this arithmetic/date logic can be unit-tested with
// plain Node and imported by both Tracker.jsx's Whiteboard UI and the server-side api/*.mjs
// functions (sell-dates.mjs, upcoming-buys.mjs) without re-deriving it in each place.
//
// Deliberately narrow: this module only does arithmetic on numbers/dates ALREADY extracted
// from a property/loan/REsimpli record/Sheet row — it never reads nexus_data, REsimpli, Google
// Sheets, or Mercury itself, and it never writes anything. The complex, stateful pieces (the
// real hard-money billing schedule, REsimpli/Sheet/Mercury fetching) stay where they already
// live: loan-schedule-shared.mjs for the schedule, and the relevant api/*.mjs file for each
// external source. That keeps this module trivially pure and testable.

// Incoming money takes 1 business day to clear — same rule the existing manual Whiteboard
// cards use (see wbNextBusinessDay in Tracker.jsx). A sell card's `day` is pre-shifted to this
// settlement date (rather than left on the sale date and shifted again at render time), since
// it's placed automatically rather than dragged — "Card date = sale closing date + 1 business
// day" in the spec means the card's own day IS the shifted date.
export function nextBusinessDay(dateStr) {
  const addDays = (d, n) => {
    const [y, m, day] = d.split("-").map(Number);
    const dt = new Date(y, m - 1, day + n);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };
  const isWeekend = d => {
    const [y, m, day] = d.split("-").map(Number);
    const dow = new Date(y, m - 1, day).getDay();
    return dow === 0 || dow === 6;
  };
  let d = addDays(dateStr, 1);
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}

// The sell-side cash-in amount for a property under contract to sell: cost to buy (cash
// close) minus every hard-money loan's principal (draws excluded — this is a cash close, not
// the full facility) minus every CHECKED private loan's principal (an unchecked private loan,
// and the 0%-rate Nexus internal lines, are assumed to roll — not subtracted), plus whatever
// hard-money interest has already been paid (the real History-tab schedule total, draws
// included, through the sale closing date — never a bank-matched or at-closing figure).
//
// `purchasePrice` is the itemized Cost-to-Buy total (cashFromBorrower + depositEarnest +
// loanToTitle + rehabHoldback + loanPointsFees + prepaidInterest, i.e. the same total the rest
// of the app already computes for a property's "Cost to Buy"), not a raw list price.
export function sellCashAmount({ purchasePrice = 0, hardPrincipalTotal = 0, checkedPrivatePrincipalTotal = 0, hardInterestPaidTotal = 0 }) {
  return Math.round((purchasePrice - hardPrincipalTotal - checkedPrivatePrincipalTotal + hardInterestPaidTotal) * 100) / 100;
}

// Robust parse of a "Cash Needed for Closing" custom-question answer, which REsimpli stores
// as free text — "$43,810", "43810.00", "43,810.00 ", even "N/A" or blank. Strips every
// non-numeric character except a single leading minus sign and one decimal point; returns
// null (never 0, never NaN) when nothing numeric survives, so a caller can route it to
// "Needs info" instead of silently treating a blank as $0.
export function parseCashAmount(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  const negative = /^-/.test(s.replace(/^\$/, ""));
  const digits = s.replace(/[^0-9.]/g, "");
  if (!digits || digits === ".") return null;
  // Collapse any extra decimal points to just the first one (defends against "$43.810.00"-
  // style input, where a thousands separator was a period instead of a comma).
  const firstDot = digits.indexOf(".");
  const cleaned = firstDot === -1 ? digits : digits.slice(0, firstDot + 1) + digits.slice(firstDot + 1).replace(/\./g, "");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// REsimpli's `analyticsInfo.closingDate` is a ms-epoch timestamp representing midnight in
// America/New_York, so converting with a fixed UTC offset would land on the wrong calendar
// day across a DST boundary. Reads the date back out using the real IANA timezone instead.
export function etEpochToDateStr(epochMs) {
  if (epochMs == null || !Number.isFinite(Number(epochMs))) return null;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(new Date(Number(epochMs)));
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// The reverse of etEpochToDateStr — converts a "YYYY-MM-DD HH:MM:SS" (or with a "T" in place
// of the space) wall-clock timestamp, assumed to be America/New_York local time with no
// timezone marker (the Office Dashboard Sheet's "Last Checked" cell, confirmed by Kyle), to a
// UTC ISO string. DST-correct: re-derives the real UTC↔ET offset at that instant via Intl
// (formatToParts, never a hardcoded 4/5-hour guess), the same technique etEpochToDateStr uses
// in the other direction.
export function etLocalStringToUtcIso(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(guess));
  const get = type => Number(parts.find(p => p.type === type)?.value);
  const hour24 = get("hour") === 24 ? 0 : get("hour"); // some Intl implementations give "24" for midnight
  const shownInET = Date.UTC(get("year"), get("month") - 1, get("day"), hour24, get("minute"), get("second"));
  const offsetMs = guess - shownInET;
  return new Date(guess + offsetMs).toISOString();
}

// Earliest of any number of YYYY-MM-DD date strings (nulls/blanks ignored). Returns null when
// none are given — the caller routes that to "Needs info" rather than guessing a date.
export function soonestDate(...dates) {
  const valid = dates.flat().filter(Boolean).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!valid.length) return null;
  return valid.reduce((min, d) => (d < min ? d : min));
}

// A date string is "in the past" relative to a reference date (defaults to comparing
// lexically, which works for YYYY-MM-DD) — used to route an upcoming-buy whose contract
// closing date has already passed to "Needs info" instead of the forecast.
export function isPastDate(dateStr, today) {
  if (!dateStr) return false;
  return dateStr < today;
}

// Filters a list of day-bearing items down to the ones whose day falls inside dayCols — used
// so a headline total (Total In/Out) never includes a card scheduled beyond the visible
// 45/90-day forecast window, matching what the running balance itself already counts.
// `dayOf` defaults to reading `.day` directly; pass it explicitly when the item's settlement
// day isn't that field verbatim (e.g. a manual card whose day needs wbEffectiveDate first).
export function withinWindow(items, dayCols, dayOf = item => item.day) {
  const set = new Set(dayCols);
  return items.filter(item => set.has(dayOf(item)));
}

// ─── Whiteboard-only overrides (data.whiteboardOverrides) ──────────────────────────────────
// Everything below operates on data.whiteboardOverrides — a top-level key read ONLY by
// WhiteboardPage (see CLAUDE.md "Whiteboard Cash-Flow Forecast — Whiteboard-only overrides").
// No other screen/calculation in the app reads or writes it; these helpers never touch
// properties/loans/lenders/REsimpli/the Sheet, so a page that never calls them is guaranteed
// unaffected by whatever's stored here.

// Drops any auto card (sell/buy — never a manual card, never a loan-payment card) whose id
// has been marked closed. `closed` is data.whiteboardOverrides.closed, {[cardId]: {...}}.
export function filterClosed(cardsInfo, closed) {
  if (!closed) return cardsInfo;
  return cardsInfo.filter(c => !closed[c.id]);
}

// Applies a manual date override to one auto card. `movedDates` is
// data.whiteboardOverrides.movedDates, {[cardId]: {date, originalDate}}. The card's own `day`
// (as freshly computed from the real source — REsimpli/the Sheet) is preserved as
// `sourceDate` so the UI can show "moved manually, source is now <date>" even if that real
// source date has changed since the override was set — the override itself never changes
// until Reset is clicked.
export function applyMovedDate(card, movedDates) {
  const override = movedDates?.[card.id];
  if (!override) return card;
  return { ...card, day: override.date, manualDate: true, originalDate: override.originalDate, sourceDate: card.day };
}

// A manual $ override on an existing (real, auto-computed) sell/buy card — independent of,
// and composable with, applyMovedDate's date override. `amountOverrides` is
// data.whiteboardOverrides.amountOverrides, {[cardId]: amount}.
export function applyAmountOverride(card, amountOverrides) {
  const override = amountOverrides?.[card.id];
  if (override == null) return card;
  return { ...card, amount: override, originalAmount: card.amount, manualAmount: true };
}

// Synthesizes a sell/buy card from data.whiteboardOverrides.manualFill — Kyle's own pencilled-
// in amount+date for a property/lead the real data (REsimpli/the Sheet) couldn't find a date
// or amount for (a Needs Info item). `manualFill` is {[cardId]: {kind, key, address, amount,
// date}}; `existingIds` is every id that ALREADY has a real, auto-computed card — manual fill
// only ever stands in for a MISSING card, never duplicates or overrides a real one (once real
// data shows up, the caller drops the stale manualFill entry — see WhiteboardPage's auto-clear
// effect). Only produces a card once BOTH amount and date are filled in; either alone just
// stays as a note on the Needs Info row. `nextBusinessDayFn` mirrors a real sell card's own
// "sale date + 1 business day" clearing rule — passed in so this module never needs its own
// copy of nextBusinessDay's logic.
export function manualFillCards(manualFill, existingIds, kind, nextBusinessDayFn) {
  const existing = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  return Object.entries(manualFill || {})
    .filter(([id, entry]) => entry && entry.kind === kind && entry.amount != null && entry.date && !existing.has(id))
    .map(([id, entry]) => ({
      id,
      propId: kind === "sell" ? entry.key : undefined,
      address: entry.address,
      amount: entry.amount,
      day: kind === "sell" ? nextBusinessDayFn(entry.date) : entry.date,
      manualEntry: true,
      ...(kind === "sell"
        ? { breakdown: { purchasePrice: 0, hardLoans: [], hardInterestPaidTotal: 0, saleDate: entry.date, dateSource: "manual", privateLoans: [] } }
        : { date: entry.date, dateFromAnalytics: null, dateFromContract: null }),
    }));
}

// Total of every "Set aside" entry with NO date — subtracted straight from Starting Cash
// (money already spoken for, not yet scheduled to leave on any particular day).
export function undatedSetAsideTotal(setAsides) {
  return (setAsides || []).filter(s => !s.date).reduce((sum, s) => sum + (s.amount || 0), 0);
}

// "Available" cash — the Mercury (or manual) starting balance minus every undated set-aside.
export function availableCash(startingCash, setAsides) {
  return Math.round((startingCash - undatedSetAsideTotal(setAsides)) * 100) / 100;
}

// Every "Set aside" entry that DOES have a date becomes its own out-card on that day — same
// shape {id, day, amount} the other auto-card arrays use, so it can flow through withinWindow/
// netFor identically.
export function datedSetAsideCards(setAsides) {
  return (setAsides || []).filter(s => s.date).map(s => ({ id: `setaside-${s.id}`, label: s.label, amount: s.amount || 0, day: s.date }));
}

// ─── Ledger ("Board") view — a running-balance ledger table, the same data/rules as the
// calendar view, just laid out as rows instead of day columns. Deliberately built to REUSE the
// calendar view's own `balances` (from computeForecastSummary) rather than recomputing a
// running total independently — the two views can't drift apart on a single cent, because
// they're reading the exact same numbers, not two implementations of the same math.

// Just the street line of a full address ("123 Main St, Columbus, OH 43215" -> "123 Main St"),
// so the Board view's narrow Address column never truncates mid-word — the full address is
// still shown via a `title` tooltip by the caller. Returns the input unchanged (never throws)
// for a label that isn't an address at all (no comma) — a lender name, "Bill", etc.
export function shortAddress(address) {
  if (!address) return address;
  return address.split(",")[0].trim();
}

// Splits a day's entries into {loanPayments, other} and decides whether the loan-payment
// lines should collapse into one summary row — display-only grouping, never changes any
// amount: the row's own netIn/netOut/balance (from buildLedgerRows) already sum every entry
// regardless of how this groups them for display. `threshold` matches "more than ~3" per Kyle.
export function groupLoanPaymentEntries(entries, threshold = 3) {
  const loanPayments = entries.filter(e => e.kind === "loanPayment");
  const other = entries.filter(e => e.kind !== "loanPayment");
  const loanTotal = Math.round(loanPayments.reduce((s, e) => s + (e.amount || 0), 0) * 100) / 100;
  return { loanPayments, other, grouped: loanPayments.length > threshold, loanTotal };
}

// One row per day in `dayCols`. `entriesByDay` is {day: [{id,label,amount,direction}]} — built
// by the caller from the SAME per-day card arrays (manual cards settling that day, auto loan
// payments, sell/buy cards, Set Aside cards) the calendar view's own netFor(day) sums, so
// netIn-netOut here always equals netFor(day) by construction. `balances` is
// computeForecastSummary's own output — never recomputed here.
export function buildLedgerRows(dayCols, entriesByDay, balances) {
  return dayCols.map(day => {
    const entries = entriesByDay[day] || [];
    const netIn = Math.round(entries.filter(e => e.direction === "in").reduce((s, e) => s + (e.amount || 0), 0) * 100) / 100;
    const netOut = Math.round(entries.filter(e => e.direction === "out").reduce((s, e) => s + (e.amount || 0), 0) * 100) / 100;
    return { day, entries, netIn, netOut, balance: balances[day] };
  });
}

// Chunks ledger rows into fixed 7-day weeks starting from the first row (today), each with its
// own IN/OUT subtotal — a plain display grouping, no effect on any balance.
export function groupLedgerRowsByWeek(rows) {
  const weeks = [];
  for (let i = 0; i < rows.length; i += 7) {
    const chunk = rows.slice(i, i + 7);
    if (!chunk.length) continue;
    const totalIn = Math.round(chunk.reduce((s, r) => s + r.netIn, 0) * 100) / 100;
    const totalOut = Math.round(chunk.reduce((s, r) => s + r.netOut, 0) * 100) / 100;
    weeks.push({ weekStart: chunk[0].day, rows: chunk, totalIn, totalOut });
  }
  return weeks;
}

// The summary strip at the top of the ledger: lowest balance + the date it happens, total in,
// total out, and the ending balance (the last row's balance, or the starting balance if there
// are no rows at all).
export function ledgerSummary(rows, startingBalance) {
  let lowest = null;
  let totalIn = 0, totalOut = 0;
  rows.forEach(r => {
    totalIn += r.netIn;
    totalOut += r.netOut;
    if (!lowest || r.balance < lowest.balance) lowest = { day: r.day, balance: r.balance };
  });
  return {
    lowest,
    totalIn: Math.round(totalIn * 100) / 100,
    totalOut: Math.round(totalOut * 100) / 100,
    ending: rows.length ? rows[rows.length - 1].balance : startingBalance,
    startingBalance,
  };
}

// Clamps a computed settlement date that's fallen into the past up to `today` — a sell/buy
// card's date is always inferred cash that HASN'T hit the bank account yet (if it had, it
// wouldn't need forecasting at all), so a date before today just means "this is overdue, show
// it as due today" rather than silently dropping it outside the forward-looking day window
// (dayCols never includes a day before today, so an unclamped past date just vanishes —
// amount, card, and all — from the forecast with no trace, which is the bug this fixes).
export function clampToToday(dateStr, today) {
  if (!dateStr || !today) return dateStr;
  return dateStr < today ? today : dateStr;
}

// Conservative "safety margin" rounding for the Whiteboard's headline cash-flow figures — an
// opt-in display toggle (data.whiteboardOverrides never stores it; it's a plain
// usePersistedState like boardView) that never touches the real stored amounts, only how the
// aggregate totals are displayed: a current/running account balance always rounds DOWN to the
// nearest $5k (assume you have less than the real number — floor handles a negative balance
// correctly too, since flooring a deficit makes it a BIGGER deficit, e.g. -$1,200 -> -$5,000,
// exactly as conservative as rounding a positive balance down); money coming IN rounds DOWN
// (assume less arrives than expected); money going OUT rounds UP (assume it costs more than
// expected). See CLAUDE.md "Whiteboard Cash-Flow Forecast" for exactly where each is applied.
export function roundDown5k(v) { return Math.floor((v || 0) / 5000) * 5000; }
export function roundUp5k(v) { return Math.ceil((v || 0) / 5000) * 5000; }

// Running cash balance across a day window, given a starting balance and a map of
// {day: netAmountThatDay}. Returns {balances: {day: balance}, firstShortfall: {day, amount}|null,
// largestShortfall: {day, amount}|null, positiveAgain: day|null} — the pieces the Whiteboard's
// summary bar needs, computed once instead of re-scanned by the UI in several places.
export function computeForecastSummary(dayCols, netByDay, startingBalance = 0) {
  const balances = {};
  let running = startingBalance;
  let firstShortfall = null, largestShortfall = null, wasNegative = false, positiveAgain = null;
  for (const day of dayCols) {
    running += netByDay[day] || 0;
    balances[day] = Math.round(running * 100) / 100;
    if (balances[day] < 0) {
      wasNegative = true;
      if (!firstShortfall) firstShortfall = { day, amount: -balances[day] };
      if (!largestShortfall || -balances[day] > largestShortfall.amount) largestShortfall = { day, amount: -balances[day] };
    } else if (wasNegative && !positiveAgain) {
      positiveAgain = day;
    }
  }
  return { balances, firstShortfall, largestShortfall, positiveAgain };
}
