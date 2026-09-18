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

export const listLenderAccounts = () => authFetch('manage-lenders')

export const createLenderAccount = ({ email, lenderName, password }) =>
  authFetch('manage-lenders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, lenderName, password }),
  })

export const deleteLenderAccount = (userId) =>
  authFetch(`manage-lenders?userId=${userId}`, { method: 'DELETE' })
