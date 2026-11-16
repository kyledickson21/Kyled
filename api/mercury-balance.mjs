// ─── Mercury account balance — Vercel serverless function ─────────────────────
//
// GET or POST /api/mercury-balance
//
// Returns the current balance of Mercury's "Master" checking account (••3564, account id
// d4aeaffe-6729-11f0-88e7-c7902c936c24) as the Whiteboard's starting-cash figure. Auth-gated
// the same way "Sync Now" is (resimpli-sync.mjs's isAuthorizedManualCaller): the caller sends
// the logged-in Supabase access token, checked against the kyle@nexushomesoh.com allowlist.
//
// ⚠️ Mercury's public API contract here is NOT independently verified against a live call the
// way _resimpli-client.mjs's REsimpli contract was (this session's network policy couldn't
// reach docs.mercury.com to confirm it directly) — it's built from Mercury's documented REST
// API (api.mercury.com/api/v1, Bearer token auth, GET /account/{id} returning
// currentBalance/availableBalance in dollars). Treated as read-only and best-effort: per the
// Whiteboard HARD RULES, a failed call or missing token degrades to the existing manual
// startingBalance input, never a crash — see the `ok:false` response shape below, which the
// UI checks before trusting `balance`.
//
// Never calls REsimpli's internal dashboard API, never stores a password — just this one
// read-only Mercury API token (MERCURY_API_TOKEN), server-side only.

const MASTER_ACCOUNT_ID = "d4aeaffe-6729-11f0-88e7-c7902c936c24";
const MASTER_ACCOUNT_LABEL = "Mercury Master ••3564";
const ADMIN_EMAIL = "kyle@nexushomesoh.com";

async function isAuthorizedCaller(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return false;
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return false;
  return data.user.email === ADMIN_EMAIL;
}

async function fetchAccountBalance(token) {
  const headers = { Authorization: `Bearer ${token}` };
  // Try the single-account endpoint first; fall back to listing every account and filtering,
  // in case the exact singular path differs from what's documented.
  let res = await fetch(`https://api.mercury.com/api/v1/account/${MASTER_ACCOUNT_ID}`, { headers });
  if (res.ok) {
    const json = await res.json();
    return json;
  }
  res = await fetch("https://api.mercury.com/api/v1/accounts", { headers });
  if (!res.ok) throw new Error(`Mercury API returned ${res.status}`);
  const json = await res.json();
  const account = (json.accounts || []).find(a => a.id === MASTER_ACCOUNT_ID);
  if (!account) throw new Error("Master account not found in Mercury accounts list");
  return account;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") { res.status(405).json({ error: "GET or POST only" }); return; }
  if (!(await isAuthorizedCaller(req))) { res.status(401).json({ error: "Unauthorized" }); return; }

  const token = process.env.MERCURY_API_TOKEN;
  if (!token) {
    res.status(200).json({ ok: false, reason: "MERCURY_API_TOKEN not set", source: MASTER_ACCOUNT_LABEL });
    return;
  }
  try {
    const account = await fetchAccountBalance(token);
    const balance = account.currentBalance ?? account.availableBalance ?? account.balance ?? null;
    if (balance == null) throw new Error("No recognizable balance field in Mercury response");
    res.status(200).json({ ok: true, balance, asOf: new Date().toISOString(), source: MASTER_ACCOUNT_LABEL });
  } catch (e) {
    console.error("mercury-balance failed:", e.message); // structural text only — no token, no balance value
    res.status(200).json({ ok: false, reason: e.message || "Mercury call failed", source: MASTER_ACCOUNT_LABEL });
  }
}
