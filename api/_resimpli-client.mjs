// ─── REsimpli Open API v6 client (server-side only) ────────────────────────────
//
// Base URL and the getPipelineList endpoint are CONFIRMED (Kyle gave the exact
// URL: POST https://api.resimpli.com/api/v6/openapi/getPipelineList). Every
// other path below — `fetchLeads()`'s list endpoint and its response field
// names — is still ⚠️ UNVERIFIED: developer.resimpli.com was not reachable from
// the environment this file was written in, so those are inferred from the
// confirmed facts (every call, reads included, is a POST — a GET returns
// 404 — and the header is `Authorization: <key>` with no "Bearer " prefix) and
// from the base path's own shape, not a confirmed copy of the real contract.
// Confirm against the real docs before trusting `fetchLeads()` against
// production data; it's written defensively around that uncertainty.
//
// Read-only: this module has no function that writes to REsimpli. Keep it that
// way — Kyle's spec is explicit that the sync never creates/updates anything in
// REsimpli itself, only reads from it.

import { RESIMPLI_PIPELINES } from "../src/resimpli-shared.mjs";

const BASE_URL = "https://api.resimpli.com/api/v6/openapi"; // CONFIRMED (per getPipelineList)

function apiKey() {
  const key = process.env.RESIMPLI_API_KEY;
  if (!key) throw new Error("RESIMPLI_API_KEY is not set");
  return key;
}

// Every REsimpli v6 Open API call is POST, reads included (GET 404s), with the
// key sent as a bare `Authorization` header — no "Bearer " prefix.
async function resimpliPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { Authorization: apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`REsimpli API ${path} returned ${res.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

// ⚠️ UNVERIFIED — path, pagination params, and response shape are all guesses
// (the confirmed base path is `/lead/details`-shaped singular nouns, so this
// guesses `/lead/list` rather than the earlier, less consistent `/leads/list`).
// The Open API can read Leads but (per Kyle) cannot list Inventory/Rental/Sold
// modules, so this is the only "list records" call this client makes; module
// ids/urls only ever arrive via the CSV import, never this API.
//
// Expected to return something iterable of lead-like objects; this function
// normalizes whatever comes back into the shape matchResimpliRecords() expects:
// {id, idType:"lead", address, stage, recordType, url}. Adjust the field-name
// guesses (`leadId`/`id`, `propertyAddress`/`address`, `pipelineStage`/`stage`)
// once a real response is seen.
export async function fetchLeads() {
  const leads = [];
  let page = 1;
  // UNVERIFIED pagination shape — assumes a page/hasMore cursor; cap at 50 pages
  // (5,000 leads at 100/page) as a sane upper bound against an infinite loop if
  // the real API's "no more pages" signal doesn't look like what's guessed here.
  for (; page <= 50; page++) {
    const json = await resimpliPost("/lead/list", { page, perPage: 100 }); // UNVERIFIED path/params
    const batch = json.leads || json.data || json.items || [];
    for (const raw of batch) {
      leads.push({
        id: String(raw.leadId ?? raw.id ?? ""),
        idType: "lead",
        address: raw.propertyAddress || raw.address || "",
        stage: raw.pipelineStage || raw.stage || raw.status || null,
        recordType: "lead",
        url: raw.url || (raw.leadId ? `https://app.resimpli.com/leads/${raw.leadId}` : null), // UNVERIFIED URL format
      });
    }
    const hasMore = json.hasMore ?? json.has_more ?? (batch.length === 100);
    if (!hasMore || batch.length === 0) break;
  }
  return leads;
}

// moduleType per Kyle: 1 = Leads, 6 = Inventory, 7 = Rental. getPipelineList's own path and
// moduleType values are CONFIRMED; the response field names below (mainStatusList/orderIndex/
// statusName — REsimpli's own terms, as Kyle described them) are the best read of his
// description, not a byte-verified response shape.
const PIPELINE_MODULE_TYPES = { lead: 1, inventory: 6, rental: 7 };

// Fetches REsimpli's real, live stage order for Lead/Inventory/Rental and returns it in the
// same {key, label, stages} shape as the hardcoded RESIMPLI_PIPELINES default, so the two are
// interchangeable everywhere (buildPipelineIndex, stageSortKey, etc.) — except moduleType 1/6
// each omit "Under Contract" and there's no Sold module at all, so those three stages are
// filled in from the hardcoded default per pipeline (Kyle's documented fallback), never
// guessed or fetched some other way.
export async function fetchPipelineOrder() {
  const result = [];
  for (const def of RESIMPLI_PIPELINES) {
    if (def.key === "sold") { result.push(def); continue; } // no Sold module to fetch — always the default
    const moduleType = PIPELINE_MODULE_TYPES[def.key];
    const json = await resimpliPost("/getPipelineList", { moduleType });
    const list = (json.mainStatusList || json.data?.mainStatusList || [])
      .slice()
      .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
      .map(s => s.statusName || s.name || s.stage)
      .filter(Boolean);
    // getPipelineList leaves out "Under Contract" for Lead and Inventory — fill it back in at
    // the end, matching its position in the hardcoded default, rather than guessing where
    // REsimpli would have put it.
    const stages = list.includes("Under Contract") ? list : [...list, "Under Contract"];
    result.push({ ...def, stages });
  }
  return result;
}
