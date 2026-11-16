// Tests for src/loan-schedule-shared.mjs — the extracted hardPaymentSchedule/calcIntEarned
// logic (the real History-tab billing schedule, draws included). Synthetic loan data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcBalance, calcMonthlyPaidPortion, calcIntEarned, hardPaymentSchedule, resolveLenderSettings,
} from "../src/loan-schedule-shared.mjs";

test("monthly_rate hard loan, per-diem, no draws — schedule dates and first-payment amount", () => {
  const loan = { id: "L1", loanType: "hard", paymentType: "monthly_rate", principal: 100000, interestRate: 12, startDate: "2026-01-15" };
  const data = { lenders: [] };
  const sched = hardPaymentSchedule(loan, data, "2026-05-31");
  assert.deepEqual(sched.map(p => p.rawDate), ["2026-03-01", "2026-04-01", "2026-05-01"]);
  const days0 = Math.floor((new Date("2026-03-01") - new Date("2026-01-15")) / 864e5);
  assert.ok(Math.abs(sched[0].amount - Math.round(100000 * 0.12 / 360 * days0 * 100) / 100) < 0.01);
});

test("monthly_fixed loan uses days/30.44, respecting the grace month", () => {
  const loan = { id: "L2", loanType: "hard", paymentType: "monthly_fixed", principal: 50000, monthlyPayment: 500, startDate: "2026-01-01" };
  const data = { lenders: [] };
  const sched = hardPaymentSchedule(loan, data, "2026-04-01");
  assert.deepEqual(sched.map(p => p.rawDate), ["2026-02-01", "2026-03-01", "2026-04-01"]);
  const days = Math.floor((new Date("2026-02-01") - new Date("2026-01-01")) / 864e5);
  assert.ok(Math.abs(sched[0].amount - 500 * days / 30.44) < 0.01);
});

test("a rehab draw accrues interest from its own draw date, folded into the next bill (B9)", () => {
  const loan = {
    id: "L3", loanType: "hard", paymentType: "monthly_rate", principal: 100000, interestRate: 12,
    startDate: "2026-01-01",
    drawFacility: { committed: 50000, draws: [{ id: "d1", date: "2026-02-10", amount: 10000 }] },
  };
  const data = { lenders: [] };
  const sched = hardPaymentSchedule(loan, data, "2026-04-01");
  assert.deepEqual(sched.map(p => p.rawDate), ["2026-02-01", "2026-03-01", "2026-04-01"]);
  const march = sched.find(p => p.rawDate === "2026-03-01");
  const baseDays = Math.floor((new Date("2026-03-01") - new Date("2026-02-01")) / 864e5);
  const baseAmt = 100000 * (12 / 100 / 360) * baseDays;
  const drawDays = Math.floor((new Date("2026-03-01") - new Date("2026-02-10")) / 864e5);
  const drawAmt = 10000 * (12 / 100 / 360) * drawDays;
  assert.ok(Math.abs(march.amount - (baseAmt + drawAmt)) < 0.01);
  const feb = sched.find(p => p.rawDate === "2026-02-01");
  const febBaseDays = Math.floor((new Date("2026-02-01") - new Date("2026-01-01")) / 864e5);
  assert.ok(Math.abs(feb.amount - 100000 * (12 / 100 / 360) * febBaseDays) < 0.01, "the Feb bill (before the draw existed) must not include it");
});

test("B9: the upcoming 1st's scheduled amount with a funded draw exceeds the flat principal*rate/12 estimate", () => {
  // This is the exact computation src/Tracker.jsx's scheduledLoanPaymentFor/scheduledHardPayment
  // now use for the Dashboard's 'Hard Money — Due 1st of Month' card and the Whiteboard's
  // 1st-of-month auto cards, in place of the old draw-blind monthlyLoanPayment() estimate.
  const loan = {
    id: "L4", loanType: "hard", paymentType: "monthly_rate", principal: 200000, interestRate: 10,
    startDate: "2026-01-01",
    drawFacility: { committed: 100000, draws: [{ id: "d1", date: "2026-02-05", amount: 40000 }] },
  };
  const data = { lenders: [] };
  const flatEstimate = Math.round((loan.principal || 0) * loan.interestRate / 100 / 12);
  const sched = hardPaymentSchedule(loan, data, "2026-03-01");
  const last = sched[sched.length - 1];
  assert.equal(last.rawDate, "2026-03-01");
  assert.ok(last.amount > flatEstimate, `schedule amount ${last.amount} should exceed the flat estimate ${flatEstimate} once a draw is funded`);
});

test("calcIntEarned with no data arg matches the old continuous-accrual formula (backward compatible)", () => {
  const loan = { id: "L5", loanType: "hard", paymentType: "monthly_rate", principal: 100000, interestRate: 12, startDate: "2026-01-01" };
  const asOf = "2026-04-01";
  const days = Math.floor((new Date(asOf) - new Date("2026-01-01")) / 864e5);
  const oldFormula = Math.round(100000 * 12 / 100 / 360 * days * 100) / 100;
  assert.ok(Math.abs(calcIntEarned(loan, asOf) - oldFormula) < 0.01);
});

test("calcIntEarned WITH data sums the real schedule (draw interest included)", () => {
  const loan = {
    id: "L6", loanType: "hard", paymentType: "monthly_rate", principal: 100000, interestRate: 12,
    startDate: "2026-01-01",
    drawFacility: { committed: 50000, draws: [{ id: "d1", date: "2026-02-10", amount: 10000 }] },
  };
  const data = { lenders: [] };
  const asOf = "2026-04-01";
  const schedSum = hardPaymentSchedule(loan, data, asOf).reduce((s, p) => s + p.amount, 0);
  assert.ok(Math.abs(calcIntEarned(loan, asOf, data) - Math.round(schedSum * 100) / 100) < 0.01);
  assert.ok(Math.abs(calcIntEarned(loan, asOf, data) - calcIntEarned(loan, asOf)) > 1, "data-aware figure should differ meaningfully once a draw exists");
});

test("B5: hardPaymentSchedule is $0 for a 'closing' paymentType loan (no interest paid monthly)", () => {
  const loan = { id: "L7", loanType: "hard", paymentType: "closing", principal: 150000, interestRate: 11, startDate: "2026-01-01" };
  const data = { lenders: [] };
  const sched = hardPaymentSchedule(loan, data, "2026-11-01");
  assert.deepEqual(sched, [], "a closing-type loan has no monthly schedule — all interest is due at closing, never 'already paid'");
});

test("calcBalance / calcMonthlyPaidPortion unaffected (closing-type private loan)", () => {
  const loan = { id: "L8", loanType: "private", paymentType: "closing", principal: 20000, interestRate: 10, startDate: "2026-01-01" };
  assert.ok(Math.abs(calcBalance(loan, "2026-04-01") - (20000 + 20000 * 10 / 100 * (90 / 365))) < 0.01);
  assert.equal(calcMonthlyPaidPortion(loan, "2026-04-01"), 0);
});

test("resolveLenderSettings merges a lender record's custom settings over the hard-money defaults", () => {
  const data = { lenders: [{ id: "x", name: "Acme", loanType: "hard", paymentSettings: { drawFee: 75 } }] };
  const settings = resolveLenderSettings(data, "Acme", "hard");
  assert.equal(settings.drawFee, 75);
  assert.equal(settings.graceMonth, true);
});
