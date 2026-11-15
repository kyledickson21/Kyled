// ─── Shared REsimpli sync core ──────────────────────────────────────────────
// Used by both api/resimpli-sync.mjs (scheduled/manual, full sync) and
// api/resimpli-webhook.mjs (single-lead update, or a full sync when the
// payload gives no lead id to narrow to). Kept in one place so the two call
// paths can't silently drift on how a change/review/apply is built.

import { createClient } from "@supabase/supabase-js";
import { checkApiKey, fetchAllRecords, fetchRawPipelineLists, buildStatusMap, classifyRecords, pipelineOrderFromRaw } from "./_resimpli-client.mjs";
import { matchResimpliRecords } from "../src/resimpli-shared.mjs";

export const uid = () => Math.random().toString(36).slice(2, 9);

export function supabaseAnon() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
}

// {id, address, resimpli} per property — never a loan/lender/fund/draw/money field, by
// construction of resimpli_sync_read() (see supabase/resimpli_sync.sql).
export async function readProperties() {
  const supabase = supabaseAnon();
  const syncSecret = process.env.RESIMPLI_SYNC_SECRET;
  if (!syncSecret) throw new Error("RESIMPLI_SYNC_SECRET is not set");
  const { data: rows, error } = await supabase.rpc("resimpli_sync_read", { secret: syncSecret });
  if (error) throw new Error(`resimpli_sync_read failed: ${error.message}`);
  return (rows || []).map(r => ({ id: r.id, address: r.address, resimpli: r.resimpli || null }));
}

// The only write path. `review`/`pipelineOrder` left undefined (or explicitly null) mean
// "leave whatever's already stored untouched" — used by the webhook's single-lead path, which
// has nothing new to report about either. The full sync always passes both explicitly (even
// an empty review array is a deliberate "nothing to review right now", not an omission).
export async function applySync({ changes, review, pipelineOrder }) {
  const supabase = supabaseAnon();
  const syncSecret = process.env.RESIMPLI_SYNC_SECRET;
  if (!syncSecret) throw new Error("RESIMPLI_SYNC_SECRET is not set");
  const now = new Date().toISOString();
  const { error } = await supabase.rpc("resimpli_sync_apply", {
    secret: syncSecret,
    changes: changes.map(({ id, resimpli }) => ({ id, resimpli })),
    review: review ?? null,
    synced_at: now,
    pipeline_order: pipelineOrder ?? null,
  });
  if (error) {
    // The RPC's own exception text is a pure structural description (property counts,
    // "a field other than resimpli changed", an invalid secret, etc.) — never an address or
    // any other PII, and never a secret value — so it's safe to log as-is. Logged here (not
    // just thrown) so a blocked run shows up clearly in the Vercel function logs regardless of
    // which caller (cron, the GitHub Actions trigger, "Sync Now", or the webhook) hit it.
    console.error("resimpli_sync_apply RPC failed:", error.message);
    throw new Error(`resimpli_sync_apply failed: ${error.message}`);
  }
  return now;
}

// Builds the {resimpli} value for one matched property + classified record — the one rule
// every write path (full sync, webhook) uses, so moduleId/url preservation can't drift between
// them. `changed` is false when nothing about resimpli actually differs (ignoring the fresh
// updatedAt stamp), so callers can skip a no-op write.
export function buildResimpliChange(property, record, now) {
  const existing = property.resimpli || {};
  const resimpli = {
    leadId: record.id,
    moduleId: existing.moduleId || null, // only the CSV import sets this — never clobbered here
    stage: record.stage || null,
    recordType: record.recordType || null,
    url: record.url || existing.url || null, // never built from a guess — see _resimpli-client.mjs
    source: "sync",
    updatedAt: now,
  };
  const changed = JSON.stringify(resimpli) !== JSON.stringify({ ...existing, updatedAt: resimpli.updatedAt });
  return { id: property.id, address: property.address, oldStage: existing.stage || null, newStage: resimpli.stage, resimpli, changed };
}

// The full sync: every property vs. every REsimpli record, computed but not written. Used
// as-is by resimpli-sync.mjs, and by the webhook when a payload gives no lead id to narrow to.
export async function computeFullDiff() {
  await checkApiKey(); // fails fast with a clear error if RESIMPLI_API_KEY is bad/expired

  const properties = await readProperties();
  // /lead/list returns every record across every REsimpli module mixed together (there's no
  // per-module list endpoint) — classifyRecords() sorts out which pipeline each one belongs to
  // using the status map built from getPipelineList (+ the Under Contract backfill).
  const items = await fetchAllRecords();
  let pipelineOrder = null, records;
  try {
    const rawPipelineLists = await fetchRawPipelineLists();
    const statusMap = await buildStatusMap(rawPipelineLists, items);
    records = classifyRecords(items, statusMap);
    pipelineOrder = pipelineOrderFromRaw(rawPipelineLists);
  } catch (e) {
    console.error("buildStatusMap/pipelineOrderFromRaw failed, classifying by mainStatusTitle text only:", e.message);
    records = classifyRecords(items, new Map()); // still address-matches; just no pipeline classification
  }

  const result = matchResimpliRecords(properties, records);
  const now = new Date().toISOString();
  const changes = result.matched
    .map(({ property, record }) => buildResimpliChange(property, record, now))
    .filter(c => c.changed);
  const review = [
    ...result.ambiguous.map(({ record, candidates }) => ({
      id: uid(), kind: "ambiguous", record,
      candidateAddresses: candidates.map(c => c.address),
      detectedAt: now,
    })),
    ...result.noPropertyMatch.map(record => ({
      id: uid(), kind: "noPropertyMatch", record, candidateAddresses: [], detectedAt: now,
    })),
  ];

  return { changes, review, now, pipelineOrder, matchedCount: result.matched.length };
}
