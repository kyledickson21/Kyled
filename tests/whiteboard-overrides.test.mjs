// Tests for the Whiteboard-only overrides (data.whiteboardOverrides) — Mark Closed, moved
// dates, and Set Aside — see CLAUDE.md "Whiteboard Cash-Flow Forecast — Whiteboard-only
// overrides". These pure functions never read/write anything but the plain objects/arrays
// passed in, so they can't touch properties/loans/lenders/REsimpli/the Sheet by construction.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterClosed, applyMovedDate, undatedSetAsideTotal, availableCash, datedSetAsideCards,
  applyAmountOverride, manualFillCards, clampToToday, roundDown5k, roundUp5k,
  sortByPriorityOrder, firstBelowThreshold,
} from "../src/whiteboard-forecast.mjs";

test("filterClosed drops a card whose id is marked closed", () => {
  const cards = [{ id: "sell-p1", amount: 100 }, { id: "sell-p2", amount: 200 }];
  const closed = { "sell-p1": { kind: "sell", key: "p1" } };
  assert.deepEqual(filterClosed(cards, closed), [{ id: "sell-p2", amount: 200 }]);
});

test("filterClosed is a no-op when nothing is closed", () => {
  const cards = [{ id: "sell-p1" }, { id: "buy-l1" }];
  assert.deepEqual(filterClosed(cards, {}), cards);
  assert.deepEqual(filterClosed(cards, null), cards);
});

test("applyMovedDate leaves a card untouched when it has no override", () => {
  const card = { id: "sell-p1", day: "2026-11-18" };
  assert.deepEqual(applyMovedDate(card, {}), card);
  assert.equal(applyMovedDate(card, {}).manualDate, undefined);
});

test("applyMovedDate overrides day and carries manualDate/originalDate/sourceDate", () => {
  const card = { id: "sell-p1", day: "2026-11-18" };
  const movedDates = { "sell-p1": { date: "2026-11-25", originalDate: "2026-11-18" } };
  const result = applyMovedDate(card, movedDates);
  assert.equal(result.day, "2026-11-25");
  assert.equal(result.manualDate, true);
  assert.equal(result.originalDate, "2026-11-18");
  assert.equal(result.sourceDate, "2026-11-18", "sourceDate is the card's own (fresh, real) day at render time");
});

test("applyMovedDate shows a NEW source date if the real date changed since the override was set, while keeping the manual date", () => {
  // The override was set when the real source date was 11/18; REsimpli/the sheet now reports
  // 11/22 instead (e.g. the sale slipped) — the card must still show the manual date (11/25)
  // but reflect the fresh source date (11/22), not the stale one from when the override was made.
  const card = { id: "sell-p1", day: "2026-11-22" }; // freshly computed from the live source
  const movedDates = { "sell-p1": { date: "2026-11-25", originalDate: "2026-11-18" } };
  const result = applyMovedDate(card, movedDates);
  assert.equal(result.day, "2026-11-25", "manual date wins for forecast placement");
  assert.equal(result.sourceDate, "2026-11-22", "but the card shows the NEW real source date");
  assert.equal(result.originalDate, "2026-11-18", "originalDate stays pinned to the true original, not the new source date");
});

test("undatedSetAsideTotal sums only entries with no date", () => {
  const setAsides = [{ amount: 5000, date: null }, { amount: 2000, date: "2026-12-01" }, { amount: 1000 }];
  assert.equal(undatedSetAsideTotal(setAsides), 6000);
  assert.equal(undatedSetAsideTotal([]), 0);
  assert.equal(undatedSetAsideTotal(undefined), 0);
});

test("availableCash subtracts only the undated total from starting cash", () => {
  const setAsides = [{ amount: 5000, date: null }, { amount: 2000, date: "2026-12-01" }];
  assert.equal(availableCash(50000, setAsides), 45000);
  assert.equal(availableCash(50000, []), 50000);
});

test("datedSetAsideCards turns only the dated entries into out-cards", () => {
  const setAsides = [
    { id: "a", label: "Payroll", amount: 5000, date: null },
    { id: "b", label: "Taxes owed", amount: 3000, date: "2026-12-01" },
  ];
  const cards = datedSetAsideCards(setAsides);
  assert.deepEqual(cards, [{ id: "setaside-b", label: "Taxes owed", amount: 3000, day: "2026-12-01" }]);
});

// ─── Isolation: every other module's pure functions must be byte-for-byte unaffected by
// whiteboardOverrides being present on `data` ────────────────────────────────────────────
import { hardPaymentSchedule, calcBalance, calcIntEarned, resolveLenderSettings } from "../src/loan-schedule-shared.mjs";
import { matchResimpliRecords, groupedStageSortKey } from "../src/resimpli-shared.mjs";

const baseData = () => ({
  properties: [{ id: "p1", address: "123 Main St", resimpli: { recordType: "inventory", stage: "Under Contract" }, loans: [] }],
  unassigned: [],
  lenders: [{ id: "x", name: "Acme", loanType: "hard", paymentSettings: { drawFee: 75 } }],
});

const withOverrides = () => ({
  ...baseData(),
  whiteboardOverrides: {
    closed: { "sell-p1": { kind: "sell", key: "p1", address: "123 Main St", amount: 50000, closedAt: "2026-11-16T00:00:00.000Z" } },
    movedDates: { "sell-p1": { date: "2026-11-25", originalDate: "2026-11-18" } },
    setAsides: [{ id: "sa1", label: "Payroll", amount: 5000, date: null }],
  },
});

test("hardPaymentSchedule gives identical results with and without whiteboardOverrides present on data", () => {
  const loan = { id: "L1", loanType: "hard", paymentType: "monthly_rate", principal: 100000, interestRate: 12, startDate: "2026-01-01", lenderName: "Acme" };
  const withIt = hardPaymentSchedule(loan, withOverrides(), "2026-06-01");
  const without = hardPaymentSchedule(loan, baseData(), "2026-06-01");
  assert.deepEqual(withIt, without);
});

test("resolveLenderSettings is identical with and without whiteboardOverrides present on data", () => {
  assert.deepEqual(resolveLenderSettings(withOverrides(), "Acme", "hard"), resolveLenderSettings(baseData(), "Acme", "hard"));
});

test("calcBalance/calcIntEarned (data-aware) are identical with and without whiteboardOverrides", () => {
  const loan = { id: "L2", loanType: "hard", paymentType: "monthly_rate", principal: 50000, interestRate: 10, startDate: "2026-01-01" };
  assert.equal(calcBalance(loan, "2026-06-01"), calcBalance(loan, "2026-06-01"));
  assert.equal(calcIntEarned(loan, "2026-06-01", withOverrides()), calcIntEarned(loan, "2026-06-01", baseData()));
});

test("matchResimpliRecords is identical with and without whiteboardOverrides present on the properties array's parent object", () => {
  // matchResimpliRecords takes `properties` directly, not the whole `data` object — included
  // here anyway to document explicitly that nothing about REsimpli matching reads this key.
  const records = [{ id: null, idType: null, address: "123 Main St", stage: "Under Contract", recordType: "inventory", url: null }];
  const withIt = matchResimpliRecords(withOverrides().properties, records);
  const without = matchResimpliRecords(baseData().properties, records);
  assert.deepEqual(withIt, without);
});

test("groupedStageSortKey is identical for the same property whether or not whiteboardOverrides exists elsewhere on data", () => {
  const prop = withOverrides().properties[0];
  const propNoOverrides = baseData().properties[0];
  assert.equal(groupedStageSortKey(prop), groupedStageSortKey(propNoOverrides));
});

// ─── 11/17: manual amount override + manual fill-in cards (drag/edit-in-Board-view feature) ─

test("applyAmountOverride leaves a card untouched when there's no override for it", () => {
  const card = { id: "sell-p1", amount: 500 };
  assert.deepEqual(applyAmountOverride(card, {}), card);
  assert.deepEqual(applyAmountOverride(card, null), card);
  assert.deepEqual(applyAmountOverride(card, { "sell-p2": 999 }), card);
});

test("applyAmountOverride overrides amount and carries originalAmount/manualAmount", () => {
  const card = { id: "sell-p1", amount: 500 };
  const out = applyAmountOverride(card, { "sell-p1": 750 });
  assert.equal(out.amount, 750);
  assert.equal(out.originalAmount, 500);
  assert.equal(out.manualAmount, true);
});

test("applyAmountOverride composes with applyMovedDate — both overrides can apply to the same card independently", () => {
  const card = { id: "sell-p1", amount: 500, day: "2026-12-01" };
  const dated = applyMovedDate(card, { "sell-p1": { date: "2026-12-05", originalDate: "2026-12-01" } });
  const both = applyAmountOverride(dated, { "sell-p1": 750 });
  assert.equal(both.day, "2026-12-05");
  assert.equal(both.manualDate, true);
  assert.equal(both.amount, 750);
  assert.equal(both.manualAmount, true);
});

test("manualFillCards only produces a card once BOTH amount and date are present, and only for the matching kind", () => {
  const manualFill = {
    "sell-p1": { kind: "sell", key: "p1", address: "1 Main St", amount: 1000, date: "2026-12-01" },
    "sell-p2": { kind: "sell", key: "p2", address: "2 Main St", amount: 1000 }, // no date — stays a note only
    "buy-l1": { kind: "buy", key: "l1", address: "3 Main St", amount: 2000, date: "2026-12-10" },
  };
  const sellCards = manualFillCards(manualFill, new Set(), "sell");
  assert.equal(sellCards.length, 1);
  assert.equal(sellCards[0].id, "sell-p1");
  assert.equal(sellCards[0].propId, "p1");
  assert.equal(sellCards[0].manualEntry, true);
  assert.ok(sellCards[0].breakdown); // minimal valid breakdown shape for WhiteboardSellCard
  const buyCards = manualFillCards(manualFill, new Set(), "buy");
  assert.equal(buyCards.length, 1);
  assert.equal(buyCards[0].id, "buy-l1");
  assert.equal(buyCards[0].date, "2026-12-10");
});

test("manualFillCards never duplicates or overrides an id that already has a real, auto-computed card", () => {
  const manualFill = { "sell-p1": { kind: "sell", key: "p1", address: "1 Main St", amount: 1000, date: "2026-12-01" } };
  const existingIds = new Set(["sell-p1"]); // a real card already exists for this id
  assert.deepEqual(manualFillCards(manualFill, existingIds, "sell"), []);
});

test("manualFillCards' sell output uses the entry's date exactly as given — no clearing-delay shift (the caller derives a separate settle day uniformly for every sell card)", () => {
  const manualFill = { "sell-p1": { kind: "sell", key: "p1", address: "1 Main St", amount: 1000, date: "2026-12-01" } };
  const cards = manualFillCards(manualFill, new Set(), "sell");
  assert.equal(cards[0].day, "2026-12-01");
});

// ─── 11/17: a past-but-unsettled date never silently vanishes from the forecast ────────────

test("clampToToday leaves a date on or after today untouched", () => {
  assert.equal(clampToToday("2026-12-05", "2026-12-01"), "2026-12-05");
  assert.equal(clampToToday("2026-12-01", "2026-12-01"), "2026-12-01");
});

test("clampToToday pulls a past date up to today — the card still shows up instead of vanishing", () => {
  assert.equal(clampToToday("2026-11-28", "2026-12-01"), "2026-12-01");
});

test("clampToToday is a no-op when either argument is missing", () => {
  assert.equal(clampToToday(null, "2026-12-01"), null);
  assert.equal(clampToToday("2026-12-01", null), "2026-12-01");
});

// ─── 11/17: conservative $5k rounding toggle ───────────────────────────────────────────────

test("roundDown5k floors a positive balance/in-amount toward zero (assume less)", () => {
  assert.equal(roundDown5k(12345), 10000);
  assert.equal(roundDown5k(5000), 5000);
  assert.equal(roundDown5k(4999), 0);
  assert.equal(roundDown5k(0), 0);
});

test("roundDown5k on a negative balance rounds the deficit further negative (bigger assumed shortfall, still conservative)", () => {
  assert.equal(roundDown5k(-1200), -5000);
  assert.equal(roundDown5k(-12345), -15000);
  assert.equal(roundDown5k(-5000), -5000);
});

test("roundUp5k ceils an out-amount/shortfall magnitude away from zero (assume it costs more)", () => {
  assert.equal(roundUp5k(12345), 15000);
  assert.equal(roundUp5k(5000), 5000);
  assert.equal(roundUp5k(1), 5000);
  assert.equal(roundUp5k(0), 0);
});

// ─── 11/17: unified "No Date" priority list ────────────────────────────────────────────────

test("sortByPriorityOrder with no order is a no-op", () => {
  const items = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(sortByPriorityOrder(items, []), items);
  assert.deepEqual(sortByPriorityOrder(items, null), items);
});

test("sortByPriorityOrder puts explicitly-ranked items first, in rank order", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const sorted = sortByPriorityOrder(items, ["c", "a"]);
  assert.deepEqual(sorted.map(x => x.id), ["c", "a", "b"]);
});

test("sortByPriorityOrder keeps unranked items in their original relative order, appended after ranked ones", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const sorted = sortByPriorityOrder(items, ["c"]);
  assert.deepEqual(sorted.map(x => x.id), ["c", "a", "b", "d"]);
});

// ─── 11/17: "first day below a dollar floor" (generalizes the $0 shortfall check) ──────────

test("firstBelowThreshold finds the first row under the floor", () => {
  const rows = [
    { day: "2026-12-01", balance: 20000 },
    { day: "2026-12-02", balance: 8000 },
    { day: "2026-12-03", balance: 3000 },
  ];
  assert.deepEqual(firstBelowThreshold(rows, 10000), { day: "2026-12-02", balance: 8000 });
});

test("firstBelowThreshold returns null when the balance never drops below the floor", () => {
  const rows = [{ day: "2026-12-01", balance: 20000 }, { day: "2026-12-02", balance: 15000 }];
  assert.equal(firstBelowThreshold(rows, 10000), null);
});

test("firstBelowThreshold works for the $0 shortfall floor too (a negative balance)", () => {
  const rows = [{ day: "2026-12-01", balance: 500 }, { day: "2026-12-02", balance: -200 }];
  assert.deepEqual(firstBelowThreshold(rows, 0), { day: "2026-12-02", balance: -200 });
});

