import { useState, useEffect } from 'react'
import { loadTvDashboardData } from './supabase'
import { WhiteboardPage, ReadOnlyContext, PrivacyContext, PanelContext } from './Tracker'

// The public, no-login TV dashboard — for AbleSign or any other kiosk display, pointed at a
// URL with a long secret in it instead of a real login (see CLAUDE.md "Public TV Dashboard"
// and supabase/tv_dashboard.sql for the full security design). Renders the exact same
// WhiteboardPage/Board view Kyle sees when logged in, just:
//   - fed data from api/tv-data.mjs (gated by the secret, not a Supabase session) instead of
//     the normal authenticated loadData(),
//   - always read-only (there's no user identity to attribute a write to, and the data this
//     page reads doesn't even include a writable session to begin with),
//   - always in Board view, TV-mode layout, from the very first render (no toggle to click —
//     nobody's there to click it).
// `update` is a plain no-op — WhiteboardPage calls it in a few places (e.g. toggling a "paying
// back at closing" checkbox), but every one of those call sites is already hidden by
// readOnly=true, so it's never actually invoked; it exists only because WhiteboardPage expects
// the prop to be a function.
const noop = () => {}

export default function TvDashboard({ tvKey }) {
  const [data, setData] = useState(null)
  const [loadedAt, setLoadedAt] = useState(0)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const load = () => loadTvDashboardData(tvKey)
      .then(d => { if (!cancelled) { setData(d); setLoadedAt(t => t + 1); setError(null) } })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load') })
    load()
    // A kiosk page stays open for days/weeks — refresh the underlying nexus_data slice
    // periodically so a new loan/property/override Kyle adds eventually shows up here too,
    // without anyone ever reloading the page by hand. WhiteboardPage refetches Mercury/sell-
    // dates/upcoming-buys on its OWN mount only (it has no polling of its own), so remounting
    // it (the `key={}` below) on each refresh is what keeps THOSE fresh as well.
    const interval = setInterval(load, 5 * 60 * 1000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [tvKey])

  if (error) return (
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-[#14161F] flex items-center justify-center p-6">
      <div className="text-center text-slate-400 dark:text-zinc-500 text-sm max-w-sm">
        <div className="text-2xl mb-2">⚠️</div>
        Couldn't load the dashboard: {error}
      </div>
    </div>
  )

  if (!data) return (
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-[#14161F] flex items-center justify-center">
      <div className="text-slate-400 dark:text-zinc-500 text-sm">Loading…</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-[#14161F] p-3">
      <ReadOnlyContext.Provider value={true}>
      <PrivacyContext.Provider value={false}>
      <PanelContext.Provider value={null}>
        <WhiteboardPage key={loadedAt} data={data} update={noop} publicMode tvKey={tvKey} />
      </PanelContext.Provider>
      </PrivacyContext.Provider>
      </ReadOnlyContext.Provider>
    </div>
  )
}
