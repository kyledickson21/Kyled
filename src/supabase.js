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
