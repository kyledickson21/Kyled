import { useState, useEffect } from 'react'
import { supabase } from './supabase'
import Tracker from './Tracker'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [dark, setDark] = useState(() => localStorage.getItem('nexus-theme') === 'dark')

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('nexus-theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  const signIn = async (e) => {
    e.preventDefault()
    setSigningIn(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setSigningIn(false)
  }

  const signOut = () => supabase.auth.signOut()

  if (loading) return (
    <div className="min-h-screen bg-slate-50 dark:bg-zinc-950 flex items-center justify-center transition-colors duration-300">
      <div className="text-slate-400 dark:text-zinc-500">Loading…</div>
    </div>
  )

  if (!session) return (
    <div className="min-h-screen bg-slate-50 dark:bg-zinc-950 flex items-center justify-center p-4 transition-colors duration-300">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl dark:shadow-zinc-950 p-8 w-full max-w-sm border border-transparent dark:border-zinc-800">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-slate-900 text-white font-bold flex items-center justify-center text-lg">N</div>
          <div>
            <div className="font-bold text-slate-900 dark:text-zinc-100">Nexus Homes</div>
            <div className="text-xs text-slate-400 dark:text-zinc-500 uppercase tracking-wide">Private Money Tracker</div>
          </div>
        </div>
        <form onSubmit={signIn} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-zinc-700 transition-all"/>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-zinc-700 transition-all"/>
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button type="submit" disabled={signingIn}
            className="w-full bg-slate-900 hover:bg-slate-800 text-white rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-50">
            {signingIn ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
        <p className="text-xs text-slate-400 dark:text-zinc-600 text-center mt-4">Contact your admin to get an account</p>
      </div>
    </div>
  )

  return <Tracker onSignOut={signOut} userEmail={session.user.email} dark={dark} onToggleDark={() => setDark(d => !d)} />
}
