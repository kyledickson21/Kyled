import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

const ORG_ID = 'nexus-homes'

export async function loadData() {
  const { data, error } = await supabase
    .from('nexus_data')
    .select('data, updated_at')
    .eq('org_id', ORG_ID)
    .single()
  if (error) throw error
  return { data: data.data, updatedAt: data.updated_at }
}

// For "Export Backup (JSON)" — a fresh, direct read of every nexus_data row for this org,
// straight from Supabase, not the app's in-memory `data` state. The in-memory state can
// briefly be a migrated/derived version of what's actually in the table (see applyMigrations
// in Tracker.jsx, run once per session on load and saved back) rather than the DB's current
// row verbatim, so the backup pulls its own copy instead of trusting whatever's already
// loaded. Returns every row for org_id (normally exactly one) with org_id/data/updated_at
// untouched, straight off the table.
export async function fetchBackupRows() {
  const { data, error } = await supabase
    .from('nexus_data')
    .select('org_id, data, updated_at')
    .eq('org_id', ORG_ID)
  if (error) throw error
  return data
}

// Optimistic concurrency: if `expectedUpdatedAt` is given, the write only lands when
// nobody else has saved since we last read. If another tab/device/session saved in the
// meantime, `updated_at` no longer matches, zero rows are updated, and we surface that as
// a conflict instead of silently overwriting whatever they just wrote.
export async function saveData(payload, expectedUpdatedAt) {
  const nowIso = new Date().toISOString()
  let query = supabase
    .from('nexus_data')
    .update({ data: payload, updated_at: nowIso })
    .eq('org_id', ORG_ID)
  if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt)
  const { data, error } = await query.select('updated_at')
  if (error) throw error
  if (expectedUpdatedAt && (!data || data.length === 0)) {
    const conflict = new Error('nexus_data was changed by another session since last read')
    conflict.isConflict = true
    throw conflict
  }
  return data?.[0]?.updated_at ?? nowIso
}

export function subscribeToChanges(callback) {
  return supabase
    .channel('nexus_data_changes')
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'nexus_data' },
      (payload) => callback(payload.new.data, payload.new.updated_at)
    )
    .subscribe()
}

const fnUrl = name => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`

async function authFetch(name, opts = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(fnUrl(name), {
    ...opts,
    headers: { Authorization: `Bearer ${session?.access_token}`, ...opts.headers },
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || res.statusText)
  return json
}

export const getLenderData = () => authFetch('lender-data')

// Returns { lenders: [...], bookkeepers: [...] } — one shared account-management endpoint
// for both portal roles (admin-only, see the edge function's own auth check).
export const listLenderAccounts = () => authFetch('manage-lenders')

export const createLenderAccount = ({ email, lenderName, password }) =>
  authFetch('manage-lenders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, lenderName, password }),
  })

export const createBookkeeperAccount = ({ email, password }) =>
  authFetch('manage-lenders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, role: 'bookkeeper' }),
  })

// Works for either a lender or a bookkeeper account — both are deleted by their auth user id.
export const deleteLenderAccount = (userId) =>
  authFetch(`manage-lenders?userId=${userId}`, { method: 'DELETE' })

// Manual "Sync Now" trigger for the REsimpli live sync — a Vercel serverless function
// (api/resimpli-sync.mjs), not a Supabase edge function, so it's a same-origin fetch rather
// than authFetch's functions/v1/* URL. Still sends the Supabase access token so the function
// can check it's really kyle@nexushomesoh.com calling (same allowlist pattern as
// manage-lenders), separate from the CRON_SECRET/webhook-secret gates used for the
// non-interactive triggers. dryRun:true computes and returns the diff without writing
// anything; dryRun:false (after Kyle reviews that diff) applies it.
export async function runResimpliSync({ dryRun }) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch('/api/resimpli-sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || res.statusText)
  return json
}

// Whiteboard cash-flow forecast's three read-only server functions (api/*.mjs, same
// same-origin-fetch + Supabase-bearer-token pattern as runResimpliSync above). Each one
// degrades gracefully on its own (returns ok:false with a reason) rather than throwing, so a
// missing env var or a failed external call never breaks the Whiteboard page — callers check
// `ok` instead of relying on a catch block here.
//
// `tvKey` (optional, 4th/2nd/1st-ish arg below) is the public TV dashboard's secret — passed
// only by src/TvDashboard.jsx, which has no Supabase session at all. When present, it's sent
// INSTEAD of a session bearer token (there isn't one to send); each endpoint's own
// isAuthorizedCaller accepts either (see api/_tv-auth.mjs). The normal, logged-in Tracker path
// never passes this, so its behavior is completely unchanged.
export async function fetchMercuryBalance(tvKey) {
  if (tvKey) {
    const res = await fetch(`/api/mercury-balance?key=${encodeURIComponent(tvKey)}`)
    return res.json()
  }
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch('/api/mercury-balance', { headers: { Authorization: `Bearer ${session?.access_token}` } })
  return res.json()
}

export async function fetchSellDates(properties, tvKey) {
  const body = tvKey ? { properties, key: tvKey } : { properties }
  const headers = { 'Content-Type': 'application/json' }
  if (!tvKey) {
    const { data: { session } } = await supabase.auth.getSession()
    headers.Authorization = `Bearer ${session?.access_token}`
  }
  const res = await fetch('/api/sell-dates', { method: 'POST', headers, body: JSON.stringify(body) })
  return res.json()
}

export async function fetchUpcomingBuys(tvKey) {
  if (tvKey) {
    const res = await fetch(`/api/upcoming-buys?key=${encodeURIComponent(tvKey)}`)
    return res.json()
  }
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch('/api/upcoming-buys', { headers: { Authorization: `Bearer ${session?.access_token}` } })
  return res.json()
}

// Public TV Dashboard (src/TvDashboard.jsx) — the no-login counterpart to loadData() above.
// Reads ONLY {properties, unassigned, lenders, whiteboard, whiteboardOverrides} through
// api/tv-data.mjs, which is gated by `tvKey` instead of a Supabase session (see
// supabase/tv_dashboard.sql for exactly what's excluded and why). Never touched by the normal,
// logged-in Tracker — this is the one function on this whole page that works with NO session.
export async function loadTvDashboardData(tvKey) {
  const res = await fetch(`/api/tv-data?key=${encodeURIComponent(tvKey)}`)
  const json = await res.json()
  if (!json.ok) throw new Error(json.reason || 'tv-data failed')
  return json.data
}
