// ─── REsimpli webhook receiver — Vercel serverless function ───────────────
//
// POST /api/resimpli-webhook?secret=<RESIMPLI_WEBHOOK_SECRET>
// (or header `X-Resimpli-Webhook-Secret: <RESIMPLI_WEBHOOK_SECRET>`)
//
// An endpoint a REsimpli automation can call on a lead's stage change, so a change shows up
// without waiting for the next scheduled sync. REsimpli sends these only from automations a
// person sets up by hand in REsimpli (max 10 per account) — there's no request signature, so
// the shared secret in the query string or header is the only gate here, checked against
// RESIMPLI_WEBHOOK_SECRET (separate from CRON_SECRET, used only for the scheduled sync, and
// RESIMPLI_SYNC_SECRET, the database-layer secret — see supabase/resimpli_sync.sql).
//
// ⚠️ No REsimpli automation has been created to call this yet, and REsimpli's own webhook
// payload shape is NOT verified (unlike the rest of the REsimpli contract — see
// _resimpli-client.mjs). So the payload is treated as a HINT ONLY, never trusted directly:
//   - if it contains a lead id (checked under several plausible field names, since the real
//     shape is unknown), that id is used to re-fetch the real record via /lead/details and run
//     a guarded single-property update from that, not from anything the payload itself claims
//     about address/stage/etc.
//   - if no id can be found in it at all, this just runs a full sync instead (same as the
//     scheduled/manual one) — still correct, just not as fast as a targeted update.
// The raw payload is logged (no secrets in it to redact) so its real shape can be confirmed
// once a REsimpli automation actually calls this.
//
// Writes only the single matched property's resimpli when an id is given (or the full diff
// when falling back to a full sync) — never creates a property, and never touches
// resimpliReview on the single-lead path (nothing new to report there from one lead).

import { fetchLeadDetails, fetchRawPipelineLists, seedStatusMap, classifyOneRecord } from "./_resimpli-client.mjs";
import { matchResimpliRecords, storedIdsFor } from "../src/resimpli-shared.mjs";
import { readProperties, applySync, buildResimpliChange, computeFullDiff } from "./_sync-core.mjs";

function isAuthorized(req) {
  const expected = process.env.RESIMPLI_WEBHOOK_SECRET;
  if (!expected) return false;
  const headerSecret = req.headers["x-resimpli-webhook-secret"];
  const querySecret = req.query?.secret;
  return headerSecret === expected || querySecret === expected;
}

// Every plausible field name an unverified payload might use for the lead id.
function extractLeadId(body) {
  const id = body?.leadId ?? body?.lead_id ?? body?.id ?? body?._id ?? body?.recordId ?? null;
  return id ? String(id) : null;
}

async function syncOneLead(leadId) {
  const properties = await readProperties();
  // Same broadened id check matchResimpliRecords uses (storedIdsFor) — not just leadId —
  // so this hint lookup doesn't miss a property whose stored id for this lead lives in
  // moduleId or only in its resimpli.url (see resimpli-shared.mjs).
  const existing = properties.find(p => storedIdsFor(p).has(leadId));
  const leadData = await fetchLeadDetails(leadId);
  const rawPipelineLists = await fetchRawPipelineLists();
  const statusMap = seedStatusMap(rawPipelineLists);
  const record = classifyOneRecord(
    { _id: leadId, address: leadData.address, mainStatusId: leadData.mainStatusId ?? leadData.pipelineData?.mainStatusId, mainStatusTitle: leadData.mainStatusTitle },
    statusMap,
    existing?.resimpli?.recordType || null, // preserve what we already knew about this property's pipeline if REsimpli's gap (Under Contract) makes it ambiguous
  );
  if (!record) return { matched: false, reason: "noAddress" };

  const result = matchResimpliRecords(properties, [record]);
  if (result.matched.length !== 1) {
    return { matched: false, reason: result.ambiguous.length ? "ambiguous" : "noPropertyMatch" };
  }
  const { property } = result.matched[0];
  const now = new Date().toISOString();
  const change = buildResimpliChange(property, record, now);
  if (!change.changed) return { matched: true, propertyId: property.id, applied: false };
  // review/pipelineOrder both omitted (undefined -> null in applySync) — a single lead has
  // nothing new to report about either, so neither is touched.
  await applySync({ changes: [change] });
  return { matched: true, propertyId: property.id, applied: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  if (!isAuthorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }

  const body = req.body || {};
  console.log("resimpli-webhook payload:", JSON.stringify(body)); // no secrets in this body to redact

  try {
    const leadId = extractLeadId(body);
    if (leadId) {
      const result = await syncOneLead(leadId);
      res.status(200).json(result);
      return;
    }

    // No id anywhere in the payload — can't narrow to one record, so just run a full sync.
    const { changes, review, pipelineOrder } = await computeFullDiff();
    await applySync({ changes, review, pipelineOrder });
    res.status(200).json({ matched: null, ranFullSync: true, applied: changes.length });
  } catch (e) {
    res.status(500).json({ error: e.message || "Webhook handling failed" });
  }
}
