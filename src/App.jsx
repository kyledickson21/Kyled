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
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-slate-400">Loading…</div>
    </div>
  )

  if (!session) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-slate-800 text-white font-bold flex items-center justify-center text-lg">N</div>
          <div>
            <div className="font-bold text-slate-800">Nexus Homes</div>
            <div className="text-xs text-slate-400 uppercase tracking-wide">Private Money Tracker</div>
          </div>
        </div>
        <form onSubmit={signIn} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              className="w-full border border-slate-200 bg-slate-50 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white"/>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1">Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              className="w-full border border-slate-200 bg-slate-50 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white"/>
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button type="submit" disabled={signingIn}
            className="w-full bg-slate-800 hover:bg-slate-900 text-white rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-50">
            {signingIn ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
        <p className="text-xs text-slate-400 text-center mt-4">Contact your admin to get an account</p>
      </div>
    </div>
  )

  return <Tracker onSignOut={signOut} userEmail={session.user.email} />
}
