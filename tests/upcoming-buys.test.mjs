// Tests for api/upcoming-buys.mjs's pure helpers — no network/REsimpli calls, synthetic
// `details` objects shaped like the confirmed real /lead/details (already unwrapped) response.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBuyLead, findCustomAnswer, investmentTypeOf, normalizeDateText } from "../api/upcoming-buys.mjs";

const CASH_Q = "6abf1af80bf2ecf681afbacd";
const CONTRACT_DATE_Q = "6abf1b6d23cdc1569ad12218";

test("B2: findCustomAnswer reads details.questions.preferenceAnswers[] by questionId", () => {
  const details = { questions: { preferenceAnswers: [{ questionId: CASH_Q, value: "$43,810" }, { questionId: "other", value: "ignored" }] } };
  assert.equal(findCustomAnswer(details, CASH_Q), "$43,810");
  assert.equal(findCustomAnswer(details, "nonexistent"), null);
});

test("B2: findCustomAnswer falls back gracefully when preferenceAnswers is missing", () => {
  assert.equal(findCustomAnswer({}, CASH_Q), null);
  assert.equal(findCustomAnswer(null, CASH_Q), null);
});

test("B4: investmentTypeOf reads details.investmentTitle directly", () => {
  assert.equal(investmentTypeOf({ investmentTitle: "Fix and Flip" }), "Fix and Flip");
  assert.equal(investmentTypeOf({ investmentTitle: "Rental" }), "Rental");
  assert.equal(investmentTypeOf({}), null);
  assert.equal(investmentTypeOf({ investmentType: "Fix and Flip" }), null, "the old wrong field name must NOT be read");
});

test('B3: normalizeDateText parses "Nov 21, 2026" and "November 21, 2026"', () => {
  assert.equal(normalizeDateText("Nov 21, 2026"), "2026-11-21");
  assert.equal(normalizeDateText("November 21, 2026"), "2026-11-21");
  assert.equal(normalizeDateText("Nov 21 2026"), "2026-11-21"); // no comma
  assert.equal(normalizeDateText("2026-11-21"), "2026-11-21");
  assert.equal(normalizeDateText("11/21/2026"), "2026-11-21");
  assert.equal(normalizeDateText("not a date"), null);
  assert.equal(normalizeDateText(null), null);
});

test("classifyBuyLead: a complete Fix and Flip lead becomes a scheduled row (8730 Colvin-shaped)", () => {
  const lead = { _id: "lead1", address: "8730 Colvin" };
  const details = {
    investmentTitle: "Fix and Flip",
    questions: { preferenceAnswers: [{ questionId: CASH_Q, value: "$43,810" }, { questionId: CONTRACT_DATE_Q, value: "Nov 21, 2026" }] },
    analyticsInfo: {},
  };
  const result = classifyBuyLead(lead, details, "2026-11-16");
  assert.ok(result.row, "should produce a row, not needsInfo/skip");
  assert.equal(result.row.amount, 43810);
  assert.equal(result.row.date, "2026-11-21");
  assert.equal(result.row.address, "8730 Colvin");
});

test("B4: a wholesale lead is silently skipped, not needsInfo", () => {
  const lead = { _id: "lead2", address: "1 Wholesale Way" };
  const details = { investmentTitle: "Wholesale", questions: { preferenceAnswers: [{ questionId: CASH_Q, value: "$10,000" }] } };
  const result = classifyBuyLead(lead, details, "2026-11-16");
  assert.deepEqual(result, { skip: true });
});

test("B4: a lead with no investment type at all is also skipped (strict allowlist, not default-in-scope)", () => {
  const lead = { _id: "lead3", address: "2 Unknown St" };
  const details = { questions: { preferenceAnswers: [] } };
  const result = classifyBuyLead(lead, details, "2026-11-16");
  assert.deepEqual(result, { skip: true });
});

test("a missing/unparseable cash figure goes to Needs Info (840 Francis / 521 E Stanton-shaped)", () => {
  const lead = { _id: "lead4", address: "840 Francis" };
  const details = { investmentTitle: "Fix and Flip", questions: { preferenceAnswers: [] }, analyticsInfo: { closingDate: Date.UTC(2026, 11, 1, 5, 0, 0) } };
  const result = classifyBuyLead(lead, details, "2026-11-16");
  assert.ok(result.needsInfo, "should go to needsInfo");
  assert.match(result.needsInfo.reason, /Cash Needed for Closing/);
});

test("a past closing date goes to Needs Info (Garston-shaped)", () => {
  const lead = { _id: "lead5", address: "Garston" };
  const details = {
    investmentTitle: "Rental",
    questions: { preferenceAnswers: [{ questionId: CASH_Q, value: "$20,000" }] },
    analyticsInfo: { closingDate: Date.UTC(2026, 9, 1, 4, 0, 0) }, // Oct 1, already past relative to "today"
  };
  const result = classifyBuyLead(lead, details, "2026-11-16");
  assert.ok(result.needsInfo);
  assert.match(result.needsInfo.reason, /already in the past/);
});

test("3434 Reaver-shaped: contract date past, analytics date future -> Needs Info showing BOTH dates", () => {
  const lead = { _id: "lead6", address: "3434 Reaver" };
  const details = {
    investmentTitle: "Fix and Flip",
    questions: { preferenceAnswers: [{ questionId: CASH_Q, value: "$25,000" }, { questionId: CONTRACT_DATE_Q, value: "10/28/2026" }] },
    // Nov 20, 2026 5:00Z = midnight ET (EST) on the 20th.
    analyticsInfo: { closingDate: Date.UTC(2026, 10, 20, 5, 0, 0) },
  };
  const result = classifyBuyLead(lead, details, "2026-11-16");
  assert.ok(result.needsInfo, "soonest-of picks the past contract date, so this must be excluded, not auto-scheduled on the future analytics date");
  assert.equal(result.needsInfo.dateFromContract, "2026-10-28");
  assert.equal(result.needsInfo.dateFromAnalytics, "2026-11-20");
  assert.match(result.needsInfo.reason, /2026-10-28/);
  assert.match(result.needsInfo.reason, /analytics 2026-11-20, contract 2026-10-28/, "the reason must surface both dates, per Kyle's request");
});

test("no closing date anywhere goes to Needs Info with a clear reason", () => {
  const lead = { _id: "lead7", address: "No Date St" };
  const details = { investmentTitle: "Rental", questions: { preferenceAnswers: [{ questionId: CASH_Q, value: "$5,000" }] } };
  const result = classifyBuyLead(lead, details, "2026-11-16");
  assert.ok(result.needsInfo);
  assert.match(result.needsInfo.reason, /No closing date found/);
});
