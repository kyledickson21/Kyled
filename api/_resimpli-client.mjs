// ─── REsimpli Open API v6 client (server-side only) ────────────────────────────
//
// VERIFIED contract (live calls from our side, confirmed Nov 14 2026) — nothing in this file
// is a guess anymore. Key facts:
//   - Base URL: https://api.resimpli.com/api/v6/openapi
//   - Auth header: `Authorization: <key>` — the raw key, NO "Bearer " prefix.
//   - Every route is POST, reads included. A GET returns 404.
//   - Rate limit: 500 requests/min per key; over that returns HTTP 429. A single sync run here
//     makes roughly a dozen calls at most (3 getPipelineList + a couple of lead/details + a
//     handful of lead/list pages), nowhere near that limit — resimpliPost retries a 429 once
//     after a short delay as cheap insurance, not a full backoff system.
//   - There is no separate "list Inventory/Rental/Sold" endpoint. /lead/list with no filter
//     returns EVERY record across all of REsimpli's modules (lead, inventory, rental, sold
//     statuses all mixed together) — that's the only way this client reads those modules.
//
// Read-only: this module has no function that writes to REsimpli. Keep it that way — Kyle's
// spec is explicit that the sync never creates/updates anything in REsimpli itself, only reads.

import { RESIMPLI_PIPELINES } from "../src/resimpli-shared.mjs";

const BASE_URL = "https://api.resimpli.com/api/v6/openapi";

function apiKey() {
  const key = process.env.RESIMPLI_API_KEY;
  if (!key) throw new Error("RESIMPLI_API_KEY is not set");
  return key;
}

async function resimpliPost(path, body, attempt = 0) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { Authorization: apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 429 && attempt === 0) {
    await new Promise(r => setTimeout(r, 1500));
    return resimpliPost(path, body, attempt + 1);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`REsimpli API ${path} returned ${res.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

// The key-check endpoint — 200 when the key is valid. Called once at the top of a sync run
// (see resimpli-sync.mjs) so a bad/expired key fails fast and clearly, rather than surfacing
// as a confusing error partway through pagination.
export async function checkApiKey() {
  await resimpliPost("/getUserInfo", {});
}

// Pages through EVERY record across EVERY module (lead/inventory/rental/sold statuses all
// mixed together — there's no per-module list endpoint) via /lead/list, body
// {searchStr:"", page, limit:1000}, response shape data.{items, page, limit, count}. ~3,500
// records come back in ~4 pages at this limit. Returns the raw items, unfiltered/unmapped —
// buildStatusMap()/classifyRecords() below turn them into matchResimpliRecords() input.
export async function fetchAllRecords() {
  const items = [];
  let page = 1;
  for (; page <= 50; page++) { // sane cap — 50k records at limit:1000
    const json = await resimpliPost("/lead/list", { searchStr: "", page, limit: 1000 });
    const batch = json.data?.items || json.items || [];
    items.push(...batch);
    const count = json.data?.count ?? json.count;
    if (batch.length < 1000 || (count != null && items.length >= count)) break;
  }
  return items;
}

// moduleType per Kyle (confirmed by live calls): 1 = Leads, 6 = Inventory, 7 = Rental (6/7
// aren't documented but work; 8 returns 400). There is no Sold module — "Sold" items are
// matched by mainStatusTitle text instead (see classifyRecords below), since there's no
// pipeline to query for it.
const PIPELINE_MODULE_TYPES = { lead: 1, inventory: 6, rental: 7 };

// Fetches the raw getPipelineList result for lead/inventory/rental ONCE per sync run — shared
// by buildStatusMap() (below) and fetchPipelineOrder() (near the bottom of this file) so a
// single sync doesn't call getPipelineList twice for the same thing. Each value is
// data.items[] of {title, orderIndex, mainStatusList:[{title, orderIndex, _id}]}.
export async function fetchRawPipelineLists() {
  const raw = {};
  for (const [recordType, moduleType] of Object.entries(PIPELINE_MODULE_TYPES)) {
    const json = await resimpliPost("/getPipelineList", { moduleType, page: 1, limit: 100 });
    raw[recordType] = json.data?.items || json.items || [];
  }
  return raw;
}

// Builds the status map this sync matches every record against: mainStatusId -> {recordType,
// stage, orderIndex}. Seeded from `rawPipelineLists` (see fetchRawPipelineLists), which is
// missing "Under Contract" for lead and inventory (REsimpli's own getPipelineList gap,
// confirmed by Kyle) — backfilled below via buildStatusMap(), not here.
// Exported for the webhook's single-record path (resimpli-webhook.mjs), which has no bulk
// item list to bootstrap backfillUnderContract() from — it resolves the Under Contract
// ambiguity via classifyOneRecord's recordTypeHint instead, using just this seeded map.
export function seedStatusMap(rawPipelineLists) {
  const map = new Map();
  for (const [recordType, pipelines] of Object.entries(rawPipelineLists)) {
    pipelines.forEach(pipeline =>
      (pipeline.mainStatusList || []).forEach(s => {
        if (s._id) map.set(s._id, { recordType, stage: s.title, orderIndex: s.orderIndex ?? 0 });
      })
    );
  }
  return map;
}

// Backfills the "Under Contract" gap for lead and inventory: finds one record from `items`
// already resolved (via the seeded map) to each of those two recordTypes, calls /lead/details
// on it, and reads ITS pipelineData.mainStatusList — the full, unfiltered status list for that
// record's own pipeline, Under Contract included — to learn the real mainStatusId REsimpli
// uses for "Under Contract" in that specific pipeline. One extra call per pipeline, exactly as
// Kyle described, bootstrapped off a record we can already classify rather than guessing.
// "Sold" has no pipeline to query this way (no module for it) — left to classifyRecords'
// mainStatusTitle text fallback instead.
async function backfillUnderContract(map, items) {
  for (const recordType of ["lead", "inventory"]) {
    if ([...map.values()].some(v => v.recordType === recordType && v.stage === "Under Contract")) continue;
    const sample = items.find(i => i.mainStatusId && map.get(i.mainStatusId)?.recordType === recordType);
    if (!sample) continue; // no classified record in this pipeline yet to bootstrap from — leave the gap, text fallback below still catches it for display purposes
    try {
      const details = await resimpliPost("/lead/details", { leadId: sample._id });
      const mainStatusList = details.leadData?.pipelineData?.mainStatusList || details.pipelineData?.mainStatusList || [];
      mainStatusList.forEach(s => {
        if (s._id && !map.has(s._id)) map.set(s._id, { recordType, stage: s.title, orderIndex: s.orderIndex ?? 0 });
      });
    } catch (e) {
      console.error(`backfillUnderContract(${recordType}) failed:`, e.message);
    }
  }
}

// Builds the full mainStatusId -> {recordType, stage, orderIndex} map for one sync run, from
// the already-fetched raw pipeline lists plus the Under Contract backfill above.
export async function buildStatusMap(rawPipelineLists, items) {
  const map = seedStatusMap(rawPipelineLists);
  await backfillUnderContract(map, items);
  return map;
}

// Builds REsimpli's live pipeline/stage order in the same {key, label, stages} shape as the
// hardcoded RESIMPLI_PIPELINES default (see resimpli-shared.mjs), from the same raw
// getPipelineList data buildStatusMap() used — sorted by orderIndex, with "Under Contract"
// (lead/inventory) and the whole "sold" pipeline filled in from the hardcoded default, since
// getPipelineList never returns either (confirmed by Kyle). A failure anywhere here is caught
// by the caller (resimpli-sync.mjs) and just falls back to the hardcoded default entirely.
export function pipelineOrderFromRaw(rawPipelineLists) {
  return RESIMPLI_PIPELINES.map(def => {
    if (def.key === "sold") return def; // no Sold module to fetch — always the default
    const pipelines = rawPipelineLists[def.key] || [];
    const stages = pipelines
      .flatMap(p => p.mainStatusList || [])
      .slice()
      .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
      .map(s => s.title)
      .filter(Boolean);
    return { ...def, stages: stages.includes("Under Contract") ? stages : [...stages, "Under Contract"] };
  });
}

// Single-record lookup — used by the webhook (see resimpli-webhook.mjs), which treats a
// webhook payload as a hint only and always re-fetches the real record rather than trusting
// payload fields directly (the payload's own shape isn't verified). Returns leadData
// (address, mainStatusTitle, mainStatusId, pipelineData, ...) or the raw response if the
// "leadData" wrapper isn't there.
export async function fetchLeadDetails(leadId) {
  const json = await resimpliPost("/lead/details", { leadId });
  return json.leadData || json;
}

// Classifies one raw record (a /lead/list item, or the leadData from /lead/details) into the
// generic {id, idType, address, stage, recordType, url} shape matchResimpliRecords() expects.
// Per Kyle:
//   - a null/blank address returns null — never guess one (callers filter these out)
//   - id/idType are always "lead"/the record's own _id — REsimpli's Open API only ever gives
//     us a lead id, regardless of which module the record is actually sitting in
//   - recordType/stage come from the status map by mainStatusId; "Sold" has no module to map
//     from, so a record whose mainStatusId isn't in the map at all is classified as "sold"
//     when its own mainStatusTitle says so (text fallback, the one case Kyle explicitly
//     sanctioned given there's no Sold pipeline to query). If it's unmapped AND its title is
//     "Under Contract" (ambiguous between Lead and Inventory — see resimpli-shared.mjs),
//     `recordTypeHint` (the tracker's own already-stored recordType for this property, if
//     any — passed by the webhook's single-lead path) is used instead of guessing; with no
//     hint it's left recordType:null, which still gets address-matched, just unclassified.
//   - url is never built from a guess — left null here so the caller preserves whatever the
//     CSV import (or a prior sync) already stored, exactly like moduleId
export function classifyOneRecord(record, statusMap, recordTypeHint = null) {
  if (!record?.address) return null;
  const known = record.mainStatusId ? statusMap.get(record.mainStatusId) : null;
  const title = record.mainStatusTitle ? record.mainStatusTitle.trim() : null;
  const soldStage = RESIMPLI_PIPELINES.find(p => p.key === "sold")?.stages?.[0]; // "Sold"
  let recordType = known?.recordType || null;
  if (!recordType && title === soldStage) recordType = "sold";
  else if (!recordType && title === "Under Contract" && recordTypeHint) recordType = recordTypeHint;
  return {
    id: String(record._id ?? ""),
    idType: "lead",
    address: record.address,
    stage: known?.stage || title || null,
    recordType,
    url: null, // never built from a guess — see comment above
  };
}

// Bulk version for /lead/list's items — see classifyOneRecord for the per-record rules.
export function classifyRecords(items, statusMap) {
  return items.map(i => classifyOneRecord(i, statusMap)).filter(Boolean);
}
