// ─── Sell-side closing dates — Vercel serverless function ─────────────────────
//
// POST /api/sell-dates { properties: [{id, address, leadId}] }
//
// For each tracker property the Whiteboard already knows is selling (it decides that itself,
// client-side, from property.resimpli — this endpoint only answers "when"), returns the best
// available sale/closing date: primarily the Dashboard Bot Office Dashboard Google Sheet
// (tab "Properties", column "Sell_ClosingDate" — REsimpli's own sell-side Expected Closing
// Date), with a fallback to REsimpli's analyticsInfo.assignmentContractDate when the sheet has
// no date for that property, and "needs info" when neither does. If the Sheet itself can't be
// read at all (missing/invalid GOOGLE_SERVICE_ACCOUNT_JSON, a bad sheet id/range, or any other
// Sheets API error — confirmed live, Nov 16: "GOOGLE_SERVICE_ACCOUNT_JSON is not set"), that's
// logged and reported back as `sheetConnected:false` with `sheetError` — every property still
// gets a shot at the REsimpli fallback (readSheetDateMap/resolveSellDateRow below), and only
// lands in "needs info" if the fallback also comes up empty. The Whiteboard shows a
// board-level note naming the missing env var when sheetConnected is false.
//
// Deliberately takes the property list as input rather than reading nexus_data itself — the
// Whiteboard UI (Tracker.jsx) already has the live property data in the browser (including
// which properties are selling, their purchase price, and their loans) and does the actual
// cash-amount arithmetic there; this function's only job is the one piece that needs a
// server-side credential (the Sheet) or a REsimpli lookup: the date.
//
// ⚠️ The Office Dashboard Sheet's real column layout/header text and its "Dashboard Status"
// tab's last-refresh cell are NOT independently verified against the live sheet in this
// session (no access to view it) — built from Kyle's own description. Matches the header
// "Sell_ClosingDate" by name when present (robust to the sheet being reordered) and falls back
// to column H by position; the staleness check is skipped (never crashes) if "Dashboard
// Status" doesn't have a recognizable timestamp cell. Read-only: this never writes to the
// Sheet or to nexus_data.

import { fetchSheetValues } from "./_google-sheets-client.mjs";
import { fetchLeadDetails } from "./_resimpli-client.mjs";
import { normalizeAddressForMatch } from "../src/resimpli-shared.mjs";
import { etEpochToDateStr, etLocalStringToUtcIso } from "../src/whiteboard-forecast.mjs";
import { isTvKeyAuthorized } from "./_tv-auth.mjs";

const SHEET_ID = "1sLr3xx99bjWgE8njqfg84arzgHUmHoJaetmSji6TDD8";
const ADMIN_EMAIL = "kyle@nexushomesoh.com";
const STALE_HOURS = 26;

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

// Builds {normalizedAddress -> {date, rowLeadId}} from the "Properties" tab, matching the
// Sell_ClosingDate column by header name when the header row has it, else falling back to
// column H (index 7) by position, per the sheet layout Kyle described.
export function buildSheetDateMap(rows) {
  const map = new Map();
  if (!rows.length) return map;
  const header = rows[0].map(h => (h || "").trim().toLowerCase());
  let dateCol = header.findIndex(h => h.includes("sell_closingdate") || h === "sell_closingdate");
  if (dateCol === -1) dateCol = header.length > 7 ? 7 : -1; // column H, 0-indexed
  if (dateCol === -1) return map;
  const addrCol = header.findIndex(h => h.includes("address"));
  const idCol = header.findIndex(h => h.includes("leadid") || h.includes("resimpli"));
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const address = addrCol !== -1 ? row[addrCol] : row[0];
    const dateRaw = row[dateCol];
    if (!address || !dateRaw) continue;
    const date = normalizeSheetDate(dateRaw);
    if (!date) continue;
    const entry = { date, rowLeadId: idCol !== -1 ? row[idCol] : null };
    map.set(normalizeAddressForMatch(address), entry);
    if (entry.rowLeadId) map.set(`id:${String(entry.rowLeadId)}`, entry);
  }
  return map;
}

// The sheet may store a date as "2026-11-18", "11/18/2026", or a Sheets serial number (days
// since 1899-12-30) if the cell is formatted as a date and returned unformatted — handles all
// three, returns null (never guesses) for anything else.
function normalizeSheetDate(raw) {
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const dt = new Date(epoch.getTime() + serial * 864e5);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  }
  return null;
}

// Looks for the "Last Checked" timestamp on the "Dashboard Status" tab — confirmed by Kyle to
// be a cell literally labeled "Last Checked" with an adjacent value like "2026-11-16 14:11:12"
// (no "T", no timezone marker — a plain America/New_York wall-clock string). Falls back to a
// generic scan for anything timestamp-shaped in case the label text or layout ever differs.
// Returns null (staleness simply not shown) rather than guessing wrong.
async function fetchLastRefresh() {
  try {
    const rows = await fetchSheetValues(SHEET_ID, "Dashboard Status");
    for (const row of rows) {
      const labelIdx = row.findIndex(c => (c || "").trim().toLowerCase() === "last checked");
      if (labelIdx !== -1 && row[labelIdx + 1]) {
        const parsed = etLocalStringToUtcIso(row[labelIdx + 1]);
        if (parsed) return parsed;
      }
    }
    for (const row of rows) {
      for (const cell of row) {
        if (!cell) continue;
        const s = String(cell).trim();
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).toISOString();
        if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
          const parsed = etLocalStringToUtcIso(s);
          if (parsed) return parsed;
        }
        if (/^\d{10,13}$/.test(s)) return new Date(Number(s) > 1e12 ? Number(s) : Number(s) * 1000).toISOString();
      }
    }
  } catch (e) {
    console.error("sell-dates: couldn't read Dashboard Status tab:", e.message);
  }
  return null;
}

// Reads the Properties sheet and builds the date map, or reports why it couldn't — a missing/
// invalid GOOGLE_SERVICE_ACCOUNT_JSON, a bad sheet id/range, or any other Sheets API error.
// Kept separate from the per-property loop below so a sheet failure degrades to "sheet not
// connected" (REsimpli fallback still runs for every property) instead of aborting the whole
// request — see the Nov 16 4:34pm fix: the sheet failing used to skip the REsimpli fallback
// entirely and send every property straight to Needs Info.
async function readSheetDateMap() {
  try {
    const sheetRows = await fetchSheetValues(SHEET_ID, "Properties!A:H");
    return { dateMap: buildSheetDateMap(sheetRows), connected: true, error: null };
  } catch (e) {
    console.error("sell-dates: Properties sheet unreadable (sheet disconnected, falling back to REsimpli for every property):", e.message);
    return { dateMap: new Map(), connected: false, error: e.message || "Sheet unreadable" };
  }
}

// The REsimpli fallback for one property — its own Expected Profit Date
// (analyticsInfo.assignmentContractDate). Tried whenever the sheet had no date for a property,
// whether because that property genuinely has no sheet row/date, or because the sheet itself
// couldn't be read at all.
async function resimpliFallbackDate(prop) {
  if (!prop.leadId) return null;
  try {
    const details = await fetchLeadDetails(prop.leadId);
    const epoch = details?.analyticsInfo?.assignmentContractDate ?? null;
    return etEpochToDateStr(epoch);
  } catch (e) {
    console.error(`sell-dates: REsimpli fallback failed for leadId ${prop.leadId}:`, e.message);
    return null;
  }
}

// The pure per-property decision, given what's already been looked up — a sheet hit (or
// null), the REsimpli fallback date (or null), and whether the sheet itself was reachable at
// all. Extracted so this can be unit-tested directly without mocking the Sheets/REsimpli HTTP
// calls. Returns the same {id,address,date,source[,reason]} row shape the handler returns.
export function resolveSellDateRow(prop, { sheetHit, fallbackDate, sheetConnected }) {
  if (sheetHit) return { id: prop.id, address: prop.address, date: sheetHit.date, source: "sheet" };
  if (fallbackDate) return { id: prop.id, address: prop.address, date: fallbackDate, source: "resimpli-fallback" };
  return {
    id: prop.id, address: prop.address, date: null, source: null,
    reason: sheetConnected ? "No sheet date and no REsimpli fallback date" : "Sheet not connected (GOOGLE_SERVICE_ACCOUNT_JSON) and no REsimpli fallback date",
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  if (!(await isAuthorizedCaller(req))) { res.status(401).json({ error: "Unauthorized" }); return; }

  const properties = Array.isArray(req.body?.properties) ? req.body.properties : [];
  try {
    const { dateMap, connected: sheetConnected, error: sheetError } = await readSheetDateMap();
    // Staleness is meaningless with no sheet connection — skip the extra call rather than let
    // it fail too (fetchLastRefresh already self-degrades to null, but there's nothing to ask).
    const lastRefresh = sheetConnected ? await fetchLastRefresh() : null;
    const isStale = lastRefresh ? (Date.now() - new Date(lastRefresh).getTime()) / 36e5 > STALE_HOURS : null;

    const results = [];
    for (const prop of properties) {
      const byId = prop.leadId ? dateMap.get(`id:${String(prop.leadId)}`) : null;
      const byAddress = dateMap.get(normalizeAddressForMatch(prop.address));
      const sheetHit = byId || byAddress;
      // Fallback: REsimpli's own Expected Profit Date — always tried once the sheet has no
      // date for this property, regardless of WHY (no row for it, or the sheet is down).
      const fallbackDate = sheetHit ? null : await resimpliFallbackDate(prop);
      results.push(resolveSellDateRow(prop, { sheetHit, fallbackDate, sheetConnected }));
    }
    res.status(200).json({ ok: true, rows: results, lastRefresh, isStale, sheetConnected, sheetError });
  } catch (e) {
    console.error("sell-dates failed:", e.message);
    // Degrades gracefully per the HARD RULES — every property goes to "needs info" with a
    // reason, rather than the Whiteboard crashing. This is the last-resort path for a genuinely
    // unexpected error (not a sheet-connection failure, which readSheetDateMap already handles
    // without aborting the REsimpli fallback above).
    res.status(200).json({ ok: false, reason: e.message || "sell-dates failed", rows: properties.map(p => ({ id: p.id, address: p.address, date: null, source: null, reason: "sell-dates lookup failed" })) });
  }
}
