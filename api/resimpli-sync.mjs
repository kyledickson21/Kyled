// ─── REsimpli sync — Vercel serverless function ────────────────────────────
//
// POST /api/resimpli-sync  { dryRun: boolean }
//
// Three ways to call this:
//   1. Vercel Cron (scheduled, daily on the Hobby plan — see vercel.json). Vercel sends a GET
//      with `Authorization: Bearer <CRON_SECRET>`.
//   2. An outside scheduler, if Kyle wants more often than daily without upgrading to Vercel
//      Pro — same `Authorization: Bearer <CRON_SECRET>` header, GET or POST, both work
//      (isCronCaller below checks only the header, not the method).
//   3. The "Sync Now" button in the Properties page (manual, POST only). Sends the logged-in
//      Supabase access token instead; this function verifies it and checks the email against
//      an allowlist (same pattern as the existing manage-lenders edge function), then honors
//      `dryRun` from the body so Kyle can preview before applying.
// A cron/scheduler call always applies for real (no dryRun — nothing to show a preview to).
//
// Either way, the only thing this function can write is property.resimpli,
// data.resimpliReview, data.resimpliLastSyncedAt, and data.resimpliPipelineOrder — see
// supabase/resimpli_sync.sql's resimpli_sync_apply(), the sole write path this calls (via
// _sync-core.mjs's applySync, shared with the webhook). It never writes to REsimpli itself
// (read-only against their API, see _resimpli-client.mjs), and never touches
// money/loans/lenders/draws.
//
// _resimpli-client.mjs's contract (base URL, auth, every endpoint used here) is VERIFIED
// against live REsimpli calls — see that file's header comment.

import { createClient } from "@supabase/supabase-js";
import { computeFullDiff, applySync } from "./_sync-core.mjs";

const ADMIN_EMAIL = "kyle@nexushomesoh.com";

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

export default async function handler(req, res) {
  const cron = isCronCaller(req);
  // Vercel Cron (and any outside scheduler using the same CRON_SECRET) can call this with
  // either GET or POST — only the manual "Sync Now" button needs POST, to carry dryRun.
  if (!cron && req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  let dryRun = !!req.body?.dryRun;
  if (cron) dryRun = false; // an unattended run has no one to show a preview to
  else if (!(await isAuthorizedManualCaller(req))) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const { changes, review, pipelineOrder, matchedCount } = await computeFullDiff();
    if (dryRun) {
      res.status(200).json({
        dryRun: true,
        matched: matchedCount,
        changes: changes.map(({ id, address, oldStage, newStage }) => ({ id, address, oldStage, newStage })),
        review: review.map(({ kind, record, candidateAddresses }) => ({ kind, record, candidateAddresses })),
        pipelineOrderFetched: !!pipelineOrder,
      });
      return;
    }

    const syncedAt = await applySync({ changes, review, pipelineOrder });
    // matched/changed/review counts, logged by the GitHub Actions workflow on every scheduled
    // run — no secrets or PII in any of these, just counts.
    res.status(200).json({ dryRun: false, matched: matchedCount, changed: changes.length, review: review.length, syncedAt, pipelineOrderUpdated: !!pipelineOrder });
  } catch (e) {
    res.status(500).json({ error: e.message || "Sync failed" });
  }
}
