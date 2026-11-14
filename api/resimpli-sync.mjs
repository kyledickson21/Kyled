// ─── REsimpli sync — Vercel serverless function ────────────────────────────
//
// POST /api/resimpli-sync  { dryRun: boolean }
//
// Two ways to call this, both POST-only:
//   1. Vercel Cron (scheduled). Vercel automatically sends
//      `Authorization: Bearer <CRON_SECRET>` to a cron-configured endpoint —
//      see vercel.json. A cron call always applies for real (no dryRun — an
//      unattended run has no one to show a preview to); see CLAUDE.md for why
//      Vercel Cron only fires on Production, which matters during the HOLD.
//   2. The "Sync Now" button in the Properties page (manual). Sends the
//      logged-in Supabase access token instead; this function verifies it and
//      checks the email against an allowlist (same pattern as the existing
//      manage-lenders edge function), then honors `dryRun` from the body so
//      Kyle can preview before applying.
//
// Either way, the only thing this function can write is property.resimpli,
// data.resimpliReview, and data.resimpliLastSyncedAt — see
// supabase/resimpli_sync.sql's resimpli_sync_apply(), the sole write path this
// calls. It never writes to REsimpli itself (read-only against their API, see
// _resimpli-client.mjs), and never touches money/loans/lenders/draws.
//
// ⚠️ _resimpli-client.mjs's fetchLeads() has UNVERIFIED endpoint paths/shapes —
// see that file's header comment. This function is written defensively around
// that uncertainty but has not been run against the real API.

import { createClient } from "@supabase/supabase-js";
import { fetchLeads, fetchPipelineOrder } from "./_resimpli-client.mjs";
import { matchResimpliRecords } from "../src/resimpli-shared.mjs";

const ADMIN_EMAIL = "kyle@nexushomesoh.com";
const uid = () => Math.random().toString(36).slice(2, 9);

function supabaseAnon() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
}

async function isAuthorizedManualCaller(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return false;
  const supabase = supabaseAnon();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return false;
  return data.user.email === ADMIN_EMAIL;
}

function isCronCaller(req) {
  const auth = req.headers.authorization || "";
  const secret = process.env.CRON_SECRET;
  return !!secret && auth === `Bearer ${secret}`;
}

// Computes the full {changes, review, pipelineOrder} diff for the current state of REsimpli
// vs. what resimpli_sync_read() returns, without writing anything. pipelineOrder is REsimpli's
// live stage order (see _resimpli-client.mjs's fetchPipelineOrder — UNVERIFIED like the rest
// of the HTTP client), stored alongside the sync's other output so the UI can use it instead
// of the hardcoded RESIMPLI_PIPELINES default; a failure fetching it never blocks the rest of
// the sync — it's logged and the client falls back to its own hardcoded default.
async function computeDiff() {
  const supabase = supabaseAnon();
  const syncSecret = process.env.RESIMPLI_SYNC_SECRET;
  if (!syncSecret) throw new Error("RESIMPLI_SYNC_SECRET is not set");

  const { data: rows, error: readErr } = await supabase.rpc("resimpli_sync_read", { secret: syncSecret });
  if (readErr) throw new Error(`resimpli_sync_read failed: ${readErr.message}`);
  const properties = (rows || []).map(r => ({ id: r.id, address: r.address, resimpli: r.resimpli || null }));

  const leads = await fetchLeads();
  const result = matchResimpliRecords(properties, leads);
  let pipelineOrder = null;
  try { pipelineOrder = await fetchPipelineOrder(); }
  catch (e) { console.error("fetchPipelineOrder failed, falling back to hardcoded default:", e.message); }

  const now = new Date().toISOString();
  const changes = result.matched
    .map(({ property, record }) => {
      const existing = property.resimpli || {};
      const resimpli = {
        leadId: record.id,
        moduleId: existing.moduleId || null, // only the CSV import/future module lookup sets this
        stage: record.stage || null,
        recordType: record.recordType || null,
        url: record.url || existing.url || null,
        source: "sync",
        updatedAt: now,
      };
      const changed = JSON.stringify(resimpli) !== JSON.stringify({ ...existing, updatedAt: resimpli.updatedAt });
      return { id: property.id, address: property.address, oldStage: existing.stage || null, newStage: resimpli.stage, resimpli, changed };
    })
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

  return { changes, review, now, pipelineOrder };
}

export default async function handler(req, res) {
  const cron = isCronCaller(req);
  // Vercel Cron sends a GET request (with its own Authorization: Bearer CRON_SECRET header,
  // checked by isCronCaller) — only the manual "Sync Now" button needs POST, to carry dryRun.
  if (!cron && req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  let dryRun = !!req.body?.dryRun;
  if (cron) dryRun = false; // a scheduled run has no one to preview it to
  else if (!(await isAuthorizedManualCaller(req))) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const { changes, review, now, pipelineOrder } = await computeDiff();
    if (dryRun) {
      res.status(200).json({
        dryRun: true,
        changes: changes.map(({ id, address, oldStage, newStage }) => ({ id, address, oldStage, newStage })),
        review: review.map(({ kind, record, candidateAddresses }) => ({ kind, record, candidateAddresses })),
        pipelineOrderFetched: !!pipelineOrder,
      });
      return;
    }

    const supabase = supabaseAnon();
    const syncSecret = process.env.RESIMPLI_SYNC_SECRET;
    const { error: applyErr } = await supabase.rpc("resimpli_sync_apply", {
      secret: syncSecret,
      changes: changes.map(({ id, resimpli }) => ({ id, resimpli })),
      review,
      synced_at: now,
      pipeline_order: pipelineOrder, // null when the fetch failed — resimpli_sync_apply leaves the stored order untouched in that case
    });
    if (applyErr) throw new Error(`resimpli_sync_apply failed: ${applyErr.message}`);

    res.status(200).json({ dryRun: false, applied: changes.length, reviewCount: review.length, syncedAt: now, pipelineOrderUpdated: !!pipelineOrder });
  } catch (e) {
    res.status(500).json({ error: e.message || "Sync failed" });
  }
}
