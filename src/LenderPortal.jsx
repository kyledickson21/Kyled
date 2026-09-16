import { useState, useEffect } from 'react'
import { getLenderData, supabase } from './supabase'

const TODAY = new Date().toISOString().split('T')[0]
const $$ = n => "$" + Math.round(Math.abs(n ?? 0)).toLocaleString()
const daysBetween = (d1, d2) => {
  if (!d1 || !d2) return 0
  return Math.max(0, Math.floor((new Date(d2) - new Date(d1)) / 864e5))
}
const calcBalance = (l, asOf = TODAY) => {
  if (!l?.startDate || !l?.principal) return l?.principal ?? 0
  const pt = l.paymentType || "closing"
  if (pt === "monthly_rate" || pt === "monthly_fixed") return l.principal
  if (l.interestType === "fixed") return l.principal + (l.interestRate || 0)
  const end = l.endDate && l.endDate <= asOf ? l.endDate : asOf
  if (l.startDate > end) return l.principal
  const yearDays = l.loanType === "hard" ? 360 : 365
  return l.principal + l.principal * (l.interestRate || 0) / 100 * (daysBetween(l.startDate, end) / yearDays)
}
const calcInt = (l, asOf = TODAY) => Math.max(0, calcBalance(l, asOf) - (l.principal || 0))
const fmtRate = l => {
  if (!l) return ""
  if (l.interestType === "fixed") return "$" + Math.round(l.interestRate || 0).toLocaleString() + " fixed"
  if (l.paymentType === "monthly_fixed") return "$" + Math.round(l.monthlyPayment || 0).toLocaleString() + "/mo"
  return (l.interestRate || 0) + "%/yr"
}

function ChangePasswordModal({ onClose }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState(false)

  const handleSubmit = async e => {
    e.preventDefault()
    if (pw !== pw2) { setErr('Passwords do not match'); return }
    if (pw.length < 8) { setErr('Password must be at least 8 characters'); return }
    setSaving(true); setErr('')
    const { error } = await supabase.auth.updateUser({ password: pw })
    if (error) { setErr(error.message); setSaving(false); return }
    setOk(true)
    setTimeout(onClose, 1500)
  }

  return (
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
      <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-2xl w-full max-w-sm p-5">
        <div className="font-bold text-[15px] text-slate-900 dark:text-zinc-100 mb-4">Change Password</div>
        {ok ? (
          <div className="text-emerald-600 dark:text-emerald-400 text-sm font-semibold text-center py-4">Password updated ✓</div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">New Password</label>
              <input type="password" value={pw} onChange={e => setPw(e.target.value)} required autoFocus
                className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Confirm Password</label>
              <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} required
                className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            {err && <p className="text-red-500 text-xs font-medium">{err}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose}
                className="flex-1 border border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-400 rounded-xl py-2.5 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-zinc-800 transition-all">
                Cancel
              </button>
              <button type="submit" disabled={saving}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-50">
                {saving ? 'Saving…' : 'Update'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

export default function LenderPortal({ session, onSignOut, dark, onToggleDark }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [changingPw, setChangingPw] = useState(false)

  useEffect(() => {
    getLenderData().then(setData).catch(e => setErr(e.message)).finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-black flex items-center justify-center">
      <div className="w-8 h-8 rounded-full border-2 border-slate-200 dark:border-zinc-700 border-t-blue-500 animate-spin"/>
    </div>
  )

  if (err) return (
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-black flex items-center justify-center p-4">
      <div className="text-red-500 text-sm text-center">{err}</div>
    </div>
  )

  const { lenderName, activeLoans = [], closedLoans = [] } = data || {}
  const totalPrincipal = activeLoans.reduce((s, l) => s + (l.principal || 0), 0)
  const totalInterest = activeLoans.reduce((s, l) => s + calcInt(l), 0)
  const totalBalance = activeLoans.reduce((s, l) => s + calcBalance(l), 0)
  const lifetimeInterest = [...activeLoans, ...closedLoans].reduce((s, l) => s + calcInt(l, l.endDate || TODAY), 0)

  return (
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-black transition-colors duration-300">
      {changingPw && <ChangePasswordModal onClose={() => setChangingPw(false)}/>}
      <div className="bg-white/85 dark:bg-[#1C1C1E]/90 backdrop-blur-2xl border-b border-black/[0.08] dark:border-white/[0.07] sticky top-0 z-40">
        <div className="px-5 py-3.5 max-w-2xl mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-[11px] bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shrink-0 shadow-md shadow-blue-500/30">
            <span className="text-white font-black text-sm">N</span>
          </div>
          <div>
            <div className="font-semibold text-[15px] text-slate-900 dark:text-white leading-none tracking-[-0.3px]">Nexus Homes</div>
            <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5 font-medium">Lender Portal · {lenderName}</div>
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            <button onClick={onToggleDark}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-slate-600 dark:text-zinc-300 hover:bg-black/10 dark:hover:bg-white/15 transition-all">
              <span className="text-[15px] leading-none">{dark ? "☀️" : "🌙"}</span>
            </button>
            <button onClick={() => setChangingPw(true)} className="text-[12px] font-semibold text-slate-500 dark:text-zinc-400 hover:opacity-75 transition-opacity">Password</button>
            <button onClick={onSignOut} className="text-[12px] font-semibold text-blue-600 dark:text-blue-400 hover:opacity-75 transition-opacity">Sign out</button>
          </div>
        </div>
      </div>

      <div className="px-4 pt-5 max-w-2xl mx-auto pb-20 space-y-5">
        {/* Summary */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] p-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Outstanding Principal</div>
            <div className="text-2xl font-black text-slate-900 dark:text-zinc-100 tabular-nums">{$$(totalPrincipal)}</div>
          </div>
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] p-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Interest Accrued</div>
            <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400 tabular-nums">{$$(totalInterest)}</div>
          </div>
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] p-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Total Balance</div>
            <div className="text-xl font-black text-blue-600 dark:text-blue-400 tabular-nums">{$$(totalBalance)}</div>
          </div>
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] p-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">All-Time Interest</div>
            <div className="text-xl font-black text-violet-600 dark:text-violet-400 tabular-nums">{$$(lifetimeInterest)}</div>
          </div>
        </div>

        {/* Active Loans */}
        {activeLoans.length > 0 && (
          <div>
            <div className="text-[13px] font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-3">Active Loans ({activeLoans.length})</div>
            <div className="space-y-3">
              {activeLoans.map(l => {
                const balance = calcBalance(l)
                const interest = calcInt(l)
                const days = daysBetween(l.startDate, TODAY)
                return (
                  <div key={l.id} className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] p-4">
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="font-semibold text-[14px] text-slate-900 dark:text-zinc-100 leading-snug flex-1">
                        {l.propertyAddress || <span className="italic text-slate-400 dark:text-zinc-500">Unassigned</span>}
                      </div>
                      <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${l.loanType === "hard" ? "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400" : "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400"}`}>
                        {l.loanType === "hard" ? "Hard Money" : "Private"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-y-2.5 text-[12px]">
                      <div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-wide mb-0.5">Principal</div>
                        <div className="font-bold text-slate-800 dark:text-zinc-200 tabular-nums">{$$(l.principal)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-wide mb-0.5">Rate</div>
                        <div className="font-bold text-slate-800 dark:text-zinc-200">{fmtRate(l)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-wide mb-0.5">Start Date</div>
                        <div className="font-bold text-slate-800 dark:text-zinc-200">{l.startDate} <span className="text-slate-400 font-normal">({days}d)</span></div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-wide mb-0.5">Interest Earned</div>
                        <div className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">+{$$(interest)}</div>
                      </div>
                    </div>
                    <div className="mt-3 pt-3 border-t border-slate-100 dark:border-zinc-800 flex items-center justify-between">
                      <div className="text-[11px] text-slate-400 dark:text-zinc-500 font-medium">Current Balance</div>
                      <div className="text-[16px] font-black text-blue-600 dark:text-blue-400 tabular-nums">{$$(balance)}</div>
                    </div>
                    {l.specialTerms && (
                      <div className="mt-2 text-[11px] text-slate-400 dark:text-zinc-500 italic">{l.specialTerms}</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* History */}
        {closedLoans.length > 0 && (
          <div>
            <div className="text-[13px] font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-3">Loan History ({closedLoans.length})</div>
            <div className="space-y-3">
              {[...closedLoans].sort((a, b) => (b.endDate || '').localeCompare(a.endDate || '')).map(l => {
                const interest = calcInt(l, l.endDate || TODAY)
                return (
                  <div key={l.id} className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] p-4 opacity-80">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="font-semibold text-[13px] text-slate-700 dark:text-zinc-300 leading-snug flex-1">
                        {l.propertyAddress || <span className="italic text-slate-400">Unassigned</span>}
                      </div>
                      <span className="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-700 text-slate-500 dark:text-zinc-400">Paid Back</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[12px]">
                      <div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-wide mb-0.5">Principal</div>
                        <div className="font-bold text-slate-700 dark:text-zinc-300 tabular-nums">{$$(l.principal)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-wide mb-0.5">Period</div>
                        <div className="font-semibold text-slate-600 dark:text-zinc-400 text-[11px]">{l.startDate}<br/>→ {l.endDate}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-wide mb-0.5">Interest</div>
                        <div className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">+{$$(interest)}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {activeLoans.length === 0 && closedLoans.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="text-4xl">💼</div>
            <div className="text-slate-400 dark:text-zinc-500 text-sm font-medium">No loans found for {lenderName}</div>
            <div className="text-slate-300 dark:text-zinc-600 text-xs text-center max-w-xs">Contact Nexus Homes if you believe this is an error.</div>
          </div>
        )}
      </div>
    </div>
  )
}
