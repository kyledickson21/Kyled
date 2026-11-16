import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextBusinessDay, sellCashAmount, parseCashAmount, etEpochToDateStr, etLocalStringToUtcIso,
  soonestDate, isPastDate, computeForecastSummary, withinWindow,
} from "../src/whiteboard-forecast.mjs";

test("Red Bank sanity check (from Kyle's spec, verbatim)", () => {
  // 1323 Red Bank = 226,031.18 - 173,000 + 25,058.50 (schedule: 5/1 3,892.50; 6/1 2,791.50;
  // 7/1 3,115; 8/1 3,621.50; 9/1 3,921.50; 10/1 3,795; 11/1 3,921.50) = 78,089.68, with Mike
  // Dickson (a private loan) unchecked, sale 11/18 -> card on 11/19.
  const schedule = [3892.50, 2791.50, 3115, 3621.50, 3921.50, 3795, 3921.50];
  const interestPaid = schedule.reduce((s, n) => s + n, 0);
  assert.equal(interestPaid, 25058.50);
  const amount = sellCashAmount({
    purchasePrice: 226031.18, hardPrincipalTotal: 173000, checkedPrivatePrincipalTotal: 0, hardInterestPaidTotal: interestPaid,
  });
  assert.equal(amount, 78089.68);
  assert.equal(nextBusinessDay("2026-11-18"), "2026-11-19");
});

test("a checked private lender's principal IS subtracted", () => {
  // Same Red Bank numbers, but with a private lender ("Mike Dickson") checked as paying back
  // $30,000 at closing instead of rolling — the amount drops by exactly that principal
  // (within a cent — these are each independently rounded-to-the-cent floats).
  const base = sellCashAmount({ purchasePrice: 226031.18, hardPrincipalTotal: 173000, checkedPrivatePrincipalTotal: 0, hardInterestPaidTotal: 25058.50 });
  const withChecked = sellCashAmount({ purchasePrice: 226031.18, hardPrincipalTotal: 173000, checkedPrivatePrincipalTotal: 30000, hardInterestPaidTotal: 25058.50 });
  assert.ok(Math.abs((base - withChecked) - 30000) < 0.01, `expected a $30,000 drop, got ${base - withChecked}`);
});

test("nextBusinessDay crosses a weekend", () => {
  assert.equal(nextBusinessDay("2026-11-20"), "2026-11-23"); // Fri -> Mon
  assert.equal(nextBusinessDay("2026-11-21"), "2026-11-23"); // Sat -> Mon
});

test('parseCashAmount: "$43,810" and other free-text forms', () => {
  assert.equal(parseCashAmount("$43,810"), 43810);
  assert.equal(parseCashAmount("43810.00"), 43810);
  assert.equal(parseCashAmount("43,810.00 "), 43810);
  assert.equal(parseCashAmount(""), null);
  assert.equal(parseCashAmount("   "), null);
  assert.equal(parseCashAmount("N/A"), null);
  assert.equal(parseCashAmount(null), null);
  assert.equal(parseCashAmount(undefined), null);
  assert.equal(parseCashAmount("-$500"), -500);
  assert.equal(parseCashAmount("$0"), 0);
});

test("etEpochToDateStr: DST-correct midnight-ET conversion", () => {
  // Nov 18 is EST (UTC-5) -> midnight ET = 05:00Z.
  assert.equal(etEpochToDateStr(Date.UTC(2026, 10, 18, 5, 0, 0)), "2026-11-18");
  // Jul 4 is EDT (UTC-4) -> midnight ET = 04:00Z, NOT 05:00Z (a hardcoded 05:00Z assumption
  // would be wrong here).
  assert.equal(etEpochToDateStr(Date.UTC(2026, 6, 4, 4, 0, 0)), "2026-07-04");
  assert.equal(etEpochToDateStr(null), null);
  assert.equal(etEpochToDateStr("not-a-number"), null);
});

test("etLocalStringToUtcIso: the Sheet's 'Last Checked' format, DST-correct both ways", () => {
  assert.equal(etLocalStringToUtcIso("2026-11-16 14:11:12"), "2026-11-16T19:11:12.000Z"); // EST, UTC-5
  assert.equal(etLocalStringToUtcIso("2026-07-04 14:11:12"), "2026-07-04T18:11:12.000Z"); // EDT, UTC-4
  assert.equal(etLocalStringToUtcIso(null), null);
  assert.equal(etLocalStringToUtcIso("garbage"), null);
});

test("soonestDate picks the earliest non-null date", () => {
  assert.equal(soonestDate("2026-12-01", "2026-11-15"), "2026-11-15");
  assert.equal(soonestDate(null, "2026-11-15"), "2026-11-15");
  assert.equal(soonestDate(null, null), null);
  assert.equal(soonestDate(["2026-12-01", null, "2026-10-01"]), "2026-10-01");
  assert.equal(soonestDate("2026-11-15", "2026-11-15"), "2026-11-15");
});

test("isPastDate", () => {
  assert.equal(isPastDate("2026-01-01", "2026-11-16"), true);
  assert.equal(isPastDate("2027-01-01", "2026-11-16"), false);
  assert.equal(isPastDate(null, "2026-11-16"), false);
  assert.equal(isPastDate("2026-11-16", "2026-11-16"), false, "today itself is not past");
});

test("computeForecastSummary: running balance, shortfalls, recovery date", () => {
  const dayCols = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"];
  const netByDay = { "2026-11-16": -1000, "2026-11-17": -500, "2026-11-18": 0, "2026-11-19": 2000, "2026-11-20": 0 };
  const { balances, firstShortfall, largestShortfall, positiveAgain } = computeForecastSummary(dayCols, netByDay, 1200);
  assert.deepEqual(balances, { "2026-11-16": 200, "2026-11-17": -300, "2026-11-18": -300, "2026-11-19": 1700, "2026-11-20": 1700 });
  assert.deepEqual(firstShortfall, { day: "2026-11-17", amount: 300 });
  assert.deepEqual(largestShortfall, { day: "2026-11-17", amount: 300 });
  assert.equal(positiveAgain, "2026-11-19");
});

test("computeForecastSummary: no shortfall when the balance never dips below 0", () => {
  const dayCols = ["2026-11-16", "2026-11-17"];
  const netByDay = { "2026-11-16": 100, "2026-11-17": 50 };
  const { firstShortfall, largestShortfall, positiveAgain } = computeForecastSummary(dayCols, netByDay, 1000);
  assert.equal(firstShortfall, null);
  assert.equal(largestShortfall, null);
  assert.equal(positiveAgain, null);
});

test("withinWindow (B7): excludes a card whose day falls outside the visible window", () => {
  const dayCols = ["2026-11-16", "2026-11-17", "2026-11-18"];
  const cards = [{ id: "a", day: "2026-11-17", amount: 100 }, { id: "b", day: "2026-12-25", amount: 999 }];
  const result = withinWindow(cards, dayCols);
  assert.deepEqual(result.map(c => c.id), ["a"]);
});

test("withinWindow (B7): supports a custom day accessor (e.g. a manual card's effective/cleared date)", () => {
  const dayCols = ["2026-11-16", "2026-11-17"];
  const cards = [{ id: "a", day: "2026-11-16", effective: "2026-11-17" }, { id: "b", day: "2026-11-16", effective: "2026-12-01" }];
  const result = withinWindow(cards, dayCols, c => c.effective);
  assert.deepEqual(result.map(c => c.id), ["a"]);
});
