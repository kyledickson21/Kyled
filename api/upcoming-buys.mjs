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
// Verified against live data (Kyle, Nov 16): `details` (from fetchLeadDetails, which now
// unwraps the real {statusCode,data:{leadData}} response — see _resimpli-client.mjs) carries
// `investmentTitle` at its top level, and custom-question answers live at
// `details.questions.preferenceAnswers[]` as `{questionId, value}`. findCustomAnswer checks
// that confirmed path first, with the old guessed shapes kept only as a harmless fallback.

import { fetchAllRecords, fetchLeadDetails } from "./_resimpli-client.mjs";
import { parseCashAmount, etEpochToDateStr, soonestDate, isPastDate } from "../src/whiteboard-forecast.mjs";
import { isTvKeyAuthorized } from "./_tv-auth.mjs";

const STATUS_ID_UNDER_CONTRACT = "6aa4dcfad18014f8fc6397f5";
const QUESTION_CASH_NEEDED = "6abf1af80bf2ecf681afbacd";
const QUESTION_CLOSING_DATE_ON_CONTRACT = "6abf1b6d23cdc1569ad12218";
const ADMIN_EMAIL = "kyle@nexushomesoh.com";
const IN_SCOPE_INVESTMENT_TYPES = /fix\s*(and|&)?\s*flip|rental/i;

async function isAuthorizedCaller(req) {
  if (isTvKeyAuthorized(req)) return true; // the public, no-login TV page — see api/_tv-auth.mjs
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return false;
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return false;
  return data.user.email === ADMIN_EMAIL;
}

// Reads one custom question's answer from the confirmed real shape —
// details.questions.preferenceAnswers[], an array of {questionId, value} — falling back to a
// few other plausible shapes (never hit in practice, kept only as a defensive net) if REsimpli
// ever changes the wrapper again. Returns the raw answer value (string/number) or null.
export function findCustomAnswer(details, questionId) {
  const preferenceAnswers = details?.questions?.preferenceAnswers;
  if (Array.isArray(preferenceAnswers)) {
    const hit = preferenceAnswers.find(q => String(q?.questionId ?? "") === questionId);
    if (hit) return hit.value ?? null;
  }
  const arrays = [details?.customQuestions, details?.customFieldAnswers, details?.customFields, details?.pipelineData?.customQuestions].filter(Array.isArray);
  for (const arr of arrays) {
    const hit = arr.find(q => String(q?.questionId ?? q?._id ?? q?.id ?? "") === questionId);
    if (hit) return hit.answer ?? hit.value ?? hit.response ?? hit.text ?? null;
  }
  return null;
}

// Confirmed real field: details.investmentTitle (top level of the unwrapped leadData).
export function investmentTypeOf(details) {
  return details?.investmentTitle || null;
}

function closingDateEpochOf(details) {
  return details?.analyticsInfo?.closingDate ?? null;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// The contract-date custom question's text isn't constrained to one format — handles
// YYYY-MM-DD, MM/DD/YYYY, and "Mon D, YYYY" / "Month D, YYYY" (e.g. "Nov 21, 2026",
// "November 21, 2026", with or without the comma). Returns null for anything else, which just
// means that date simply doesn't contribute to the soonest-of comparison. Parsed by hand
// (never via `new Date(str)`) so the result doesn't depend on the server process's local
// timezone for a non-ISO, date-only string.
export function normalizeDateText(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) { const [, m, d, y] = mdy; return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
  const monthName = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (monthName) {
    const [, mon, d, y] = monthName;
    const idx = MONTH_NAMES.indexOf(mon.slice(0, 3).toLowerCase());
    if (idx !== -1) return `${y}-${String(idx + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

export const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// The pure per-lead decision: given one REsimpli lead (the /lead/list item — just used for its
// id/address) and its already-fetched, already-unwrapped /lead/details object, decide whether
// it's a scheduled buy, a "needs info" exclusion, or silently out of scope (wrong investment
// type) — extracted out of the handler below so it can be unit-tested directly with synthetic
// `details` objects, no network/REsimpli mocking required. Returns exactly one of
// {row} | {needsInfo} | {skip:true}.
export function classifyBuyLead(lead, details, today) {
  const address = lead.address || "(no address)";
  const leadId = String(lead._id);
  // Only Fix and Flip / Rental are in scope at all — wholesale, any other investment type,
  // and a lead with no investment type set are all silently out of scope (not a "needs info"
  // item; there was never anything to forecast here).
  const investmentType = investmentTypeOf(details);
  if (!IN_SCOPE_INVESTMENT_TYPES.test(investmentType || "")) return { skip: true };

  const cashText = findCustomAnswer(details, QUESTION_CASH_NEEDED);
  const amount = parseCashAmount(cashText);
  const dateFromAnalytics = etEpochToDateStr(closingDateEpochOf(details));
  const dateFromContract = normalizeDateText(findCustomAnswer(details, QUESTION_CLOSING_DATE_ON_CONTRACT));
  // Normally the soonest of the two. But when the contract-date answer has already slipped
  // into the past while REsimpli's own analytics date is still today or later, treat that as
  // the deal having been extended — use the analytics date instead of excluding the lead (and
  // still show both dates on the card below, same as every other case where they differ).
  const contractIsStale = dateFromContract && isPastDate(dateFromContract, today) && dateFromAnalytics && !isPastDate(dateFromAnalytics, today);
  const date = contractIsStale ? dateFromAnalytics : soonestDate(dateFromAnalytics, dateFromContract);

  // Shows both source dates when they differ — e.g. a stale contract date that's already past
  // while REsimpli's own analytics date is still upcoming — so Kyle can see the full picture
  // and decide by hand instead of either date being silently dropped.
  const bothDatesNote = (dateFromAnalytics && dateFromContract && dateFromAnalytics !== dateFromContract)
    ? ` (analytics ${dateFromAnalytics}, contract ${dateFromContract})` : "";

  if (amount == null) return { needsInfo: { leadId, address, reason: "Cash Needed for Closing is missing or unparseable", dateFromAnalytics, dateFromContract } };
  if (!date) return { needsInfo: { leadId, address, reason: "No closing date found (neither analyticsInfo.closingDate nor the contract-date question)", dateFromAnalytics, dateFromContract } };
  if (isPastDate(date, today)) return { needsInfo: { leadId, address, reason: `Closing date ${date} is already in the past${bothDatesNote}`, dateFromAnalytics, dateFromContract } };

  return { row: { leadId, address, amount, date, dateFromAnalytics, dateFromContract } };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") { res.status(405).json({ error: "GET or POST only" }); return; }
  if (!(await isAuthorizedCaller(req))) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const items = await fetchAllRecords();
    const underContract = items.filter(i => String(i.mainStatusId ?? "") === STATUS_ID_UNDER_CONTRACT);
    const rows = [], needsInfo = [];
    const today = todayStr();

    for (const lead of underContract) {
      let details;
      try {
        details = await fetchLeadDetails(lead._id);
      } catch (e) {
        needsInfo.push({ leadId: String(lead._id), address: lead.address || "(no address)", reason: `Could not fetch lead details: ${e.message}` });
        continue;
      }
      const result = classifyBuyLead(lead, details, today);
      if (result.row) rows.push(result.row);
      else if (result.needsInfo) needsInfo.push(result.needsInfo);
    }
    res.status(200).json({ ok: true, rows, needsInfo });
  } catch (e) {
    console.error("upcoming-buys failed:", e.message);
    res.status(200).json({ ok: false, reason: e.message || "upcoming-buys failed", rows: [], needsInfo: [] });
  }
}
