// ─── Public TV Dashboard — nexus_data read ──────────────────────────────────
//
// GET /api/tv-data?key=<TV_DASHBOARD_SECRET>
//
// The one endpoint the public, no-login TV page (src/TvDashboard.jsx) uses to read
// {properties, unassigned, lenders, whiteboard, whiteboardOverrides} — the exact slice the
// Whiteboard forecast needs, nothing else (see supabase/tv_dashboard.sql for exactly what's
// excluded and why). Gated by a single shared secret, not a Supabase login — the secret is
// checked here (so a wrong/missing key never even reaches the database) AND again inside the
// tv_dashboard_read() Postgres function itself (so possessing the anon key alone, without the
// secret, still can't read anything through this path — same pattern as the REsimpli sync's
// RESIMPLI_SYNC_SECRET, see api/_sync-core.mjs).
//
// Deliberately uses only the Supabase anon key (never a service role key), same as every other
// secret-gated function in this app. Read-only — there is no corresponding write function.

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "GET") { res.status(405).json({ error: "GET only" }); return; }

  const expected = process.env.TV_DASHBOARD_SECRET;
  if (!expected) { res.status(503).json({ ok: false, reason: "TV_DASHBOARD_SECRET not set" }); return; }
  const key = req.query?.key;
  if (!key || key !== expected) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
    const { data, error } = await supabase.rpc("tv_dashboard_read", { secret: expected });
    if (error) throw new Error(`tv_dashboard_read failed: ${error.message}`);
    res.status(200).json({ ok: true, data: data || {} });
  } catch (e) {
    console.error("tv-data failed:", e.message); // structural text only — never the secret or any property data
    res.status(200).json({ ok: false, reason: e.message || "tv-data failed" });
  }
}
