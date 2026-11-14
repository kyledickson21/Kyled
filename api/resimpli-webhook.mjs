// ─── REsimpli webhook receiver — Vercel serverless function ───────────────
//
// POST /api/resimpli-webhook?secret=<RESIMPLI_WEBHOOK_SECRET>
// (or header `X-Resimpli-Webhook-Secret: <RESIMPLI_WEBHOOK_SECRET>`)
//
// An endpoint a REsimpli automation can call on a lead's stage change, so a
// change shows up without waiting for the next scheduled sync. REsimpli
// documents no request signature for its automations, so the shared secret in
// the query string or header is the only gate here — checked against
// RESIMPLI_WEBHOOK_SECRET, a separate secret from CRON_SECRET (used only for
// the scheduled sync) and RESIMPLI_SYNC_SECRET (the database-layer secret —
// see supabase/resimpli_sync.sql).
//
// ⚠️ No REsimpli automation has been created to call this yet — per Kyle's
// instruction, this repo creates the receiving endpoint only; setting up the
// automation on REsimpli's side (and learning its real payload shape) is a
// separate, explicit step for Kyle. The payload shape read below (`leadId`/
// `id`, `address`, `stage`, `url`) is a best guess, same caveat as
// _resimpli-client.mjs.
//
// Updates only the single matched property's resimpli — never creates a
// property, and an ambiguous/unmatched payload goes to the review list (via
// the same resimpli_sync_apply RPC used by the scheduled/manual sync) instead
// of guessing.

import { createClient } from "@supabase/supabase-js";
import { matchResimpliRecords } from "../src/resimpli-shared.mjs";

const uid = () => Math.random().toString(36).slice(2, 9);

function supabaseAnon() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
}

function isAuthorized(req) {
  const expected = process.env.RESIMPLI_WEBHOOK_SECRET;
  if (!expected) return false;
  const headerSecret = req.headers["x-resimpli-webhook-secret"];
  const querySecret = req.query?.secret;
  return headerSecret === expected || querySecret === expected;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  if (!isAuthorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const body = req.body || {};
    const record = {
      id: String(body.leadId ?? body.id ?? ""),
      idType: "lead",
      address: body.address || body.propertyAddress || "",
      stage: body.stage || body.pipelineStage || body.status || null,
      recordType: "lead",
      url: body.url || null,
    };

    const supabase = supabaseAnon();
    const syncSecret = process.env.RESIMPLI_SYNC_SECRET;
    if (!syncSecret) throw new Error("RESIMPLI_SYNC_SECRET is not set");

    const { data: rows, error: readErr } = await supabase.rpc("resimpli_sync_read", { secret: syncSecret });
    if (readErr) throw new Error(`resimpli_sync_read failed: ${readErr.message}`);
    const properties = (rows || []).map(r => ({ id: r.id, address: r.address, resimpli: r.resimpli || null }));

    const result = matchResimpliRecords(properties, [record]);
    const now = new Date().toISOString();

    if (result.matched.length === 1) {
      const { property } = result.matched[0];
      const existing = property.resimpli || {};
      const resimpli = {
        leadId: record.id, moduleId: existing.moduleId || null,
        stage: record.stage || null, recordType: record.recordType || null,
        url: record.url || existing.url || null, source: "sync", updatedAt: now,
      };
      const { error: applyErr } = await supabase.rpc("resimpli_sync_apply", {
        secret: syncSecret,
        changes: [{ id: property.id, resimpli }],
        review: [], // a single-lead webhook never touches the review list — only the full sync recomputes it
        synced_at: now,
      });
      if (applyErr) throw new Error(`resimpli_sync_apply failed: ${applyErr.message}`);
      res.status(200).json({ matched: true, propertyId: property.id });
      return;
    }

    // Ambiguous or no match — don't guess. (The review list itself is only ever fully
    // recomputed by the scheduled/manual sync, so a webhook hit that can't resolve cleanly
    // is just dropped here with a 200 — it'll show up in the review list on the next sync.)
    res.status(200).json({ matched: false, reason: result.ambiguous.length ? "ambiguous" : "noPropertyMatch" });
  } catch (e) {
    res.status(500).json({ error: e.message || "Webhook handling failed" });
  }
}
