import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

const ORG_ID = 'nexus-homes'

export async function loadData() {
  const { data, error } = await supabase
    .from('nexus_data')
    .select('data')
    .eq('org_id', ORG_ID)
    .single()
  if (error) throw error
  return data.data
}

export async function saveData(payload) {
  const { error } = await supabase
    .from('nexus_data')
    .update({ data: payload, updated_at: new Date().toISOString() })
    .eq('org_id', ORG_ID)
  if (error) throw error
}

export function subscribeToChanges(callback) {
  return supabase
    .channel('nexus_data_changes')
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'nexus_data' },
      (payload) => callback(payload.new.data)
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
