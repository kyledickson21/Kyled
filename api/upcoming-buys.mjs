// ─── Upcoming buys (REsimpli Active Leads, Under Contract) — Vercel serverless function ──
//
// GET or POST /api/upcoming-buys
//
// Houses Nexus is buying: REsimpli leads whose status is "Under Contract"
// (statusId 6aa4dcfad18014f8fc6397f5) and whose investment type is Fix and Flip or Rental.
// Cash needed comes from the custom question "Cash Needed for Closing"
// (questionId 6abf1af80bf2ecf681afbacd), parsed from free text. Date is the soonest of
// analyticsInfo.closingDate (ms epoch, midnight ET) and the custom question "Closing Date on
// Contract" (questionId 6abf1b6d23cdc1569ad12218). Past/missing dates, and an unparseable/
// blank cash figure, go to "needsInfo" instead of the forecast — never guessed, never written
// to nexus_data (this is pure read-through from REsimpli; nothing here is persisted).
//
// ⚠️ /lead/details' custom-question-answer shape is NOT independently verified against a live
// call in this session (same caveat as resimpli-webhook.mjs's payload) — findCustomAnswer
// below searches every plausible location for a {questionId, answer} pair rather than
// hardcoding one path, and a lead whose answer can't be found this way lands in needsInfo
// with a clear reason instead of silently becoming $0. Confirm the real shape against a live
// response once this is deployed, and simplify findCustomAnswer if it turns out to live in
// one consistent place.

import { fetchAllRecords, fetchLeadDetails } from "./_resimpli-client.mjs";
import { parseCashAmount, etEpochToDateStr, soonestDate, isPastDate } from "../src/whiteboard-forecast.mjs";

const STATUS_ID_UNDER_CONTRACT = "6aa4dcfad18014f8fc6397f5";
const QUESTION_CASH_NEEDED = "6abf1af80bf2ecf681afbacd";
const QUESTION_CLOSING_DATE_ON_CONTRACT = "6abf1b6d23cdc1569ad12218";
const ADMIN_EMAIL = "kyle@nexushomesoh.com";
const IN_SCOPE_INVESTMENT_TYPES = /fix\s*(and|&)?\s*flip|rental/i;

async function isAuthorizedCaller(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return false;
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return false;
  return data.user.email === ADMIN_EMAIL;
}

// Searches every plausible shape a custom question's answer might come back in from
// /lead/details — see the file header caveat. Returns the raw answer value (string/number) or
// null if nothing matching questionId is found anywhere searched.
function findCustomAnswer(details, questionId) {
  const arrays = [
    details?.customQuestions, details?.customFieldAnswers, details?.customFields,
    details?.leadData?.customQuestions, details?.leadData?.customFieldAnswers, details?.leadData?.customFields,
    details?.pipelineData?.customQuestions, details?.leadData?.pipelineData?.customQuestions,
  ].filter(Array.isArray);
  for (const arr of arrays) {
    const hit = arr.find(q => String(q?.questionId ?? q?._id ?? q?.id ?? "") === questionId);
    if (hit) return hit.answer ?? hit.value ?? hit.response ?? hit.text ?? null;
  }
  return null;
}

function investmentTypeOf(details, lead) {
  return details?.investmentType || details?.leadData?.investmentType || details?.investment_type
    || lead?.investmentType || lead?.investment_type || null;
}

function closingDateEpochOf(details) {
  return details?.analyticsInfo?.closingDate ?? details?.leadData?.analyticsInfo?.closingDate ?? null;
}

// The contract-date custom question's own text format isn't verified either — handles the
// common forms (already YYYY-MM-DD, or MM/DD/YYYY) and returns null for anything else, which
// just means that date simply doesn't contribute to the soonest-of comparison.
function normalizeDateText(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) { const [, m, d, y] = mdy; return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
  return null;
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") { res.status(405).json({ error: "GET or POST only" }); return; }
  if (!(await isAuthorizedCaller(req))) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const items = await fetchAllRecords();
    const underContract = items.filter(i => String(i.mainStatusId ?? "") === STATUS_ID_UNDER_CONTRACT);
    const rows = [], needsInfo = [];
    const today = todayStr();

    for (const lead of underContract) {
      const address = lead.address || "(no address)";
      let details;
      try {
        details = await fetchLeadDetails(lead._id);
      } catch (e) {
        needsInfo.push({ leadId: String(lead._id), address, reason: `Could not fetch lead details: ${e.message}` });
        continue;
      }
      const investmentType = investmentTypeOf(details, lead);
      // Only Fix and Flip / Rental are in scope at all — anything else is silently out of
      // scope (not a "needs info" item; there was never anything to forecast here).
      if (investmentType && !IN_SCOPE_INVESTMENT_TYPES.test(investmentType)) continue;

      const cashText = findCustomAnswer(details, QUESTION_CASH_NEEDED);
      const amount = parseCashAmount(cashText);
      const dateFromAnalytics = etEpochToDateStr(closingDateEpochOf(details));
      const dateFromContract = normalizeDateText(findCustomAnswer(details, QUESTION_CLOSING_DATE_ON_CONTRACT));
      const date = soonestDate(dateFromAnalytics, dateFromContract);

      if (amount == null) { needsInfo.push({ leadId: String(lead._id), address, reason: "Cash Needed for Closing is missing or unparseable" }); continue; }
      if (!date) { needsInfo.push({ leadId: String(lead._id), address, reason: "No closing date found (neither analyticsInfo.closingDate nor the contract-date question)" }); continue; }
      if (isPastDate(date, today)) { needsInfo.push({ leadId: String(lead._id), address, reason: `Closing date ${date} is already in the past` }); continue; }

      rows.push({ leadId: String(lead._id), address, amount, date, dateFromAnalytics, dateFromContract });
    }
    res.status(200).json({ ok: true, rows, needsInfo });
  } catch (e) {
    console.error("upcoming-buys failed:", e.message);
    res.status(200).json({ ok: false, reason: e.message || "upcoming-buys failed", rows: [], needsInfo: [] });
  }
}
