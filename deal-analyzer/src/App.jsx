import { useState, useEffect } from 'react'
import DealAnalyzer from './DealAnalyzer'

export default function App() {
  const [dark, setDark] = useState(() => localStorage.getItem('da-theme') === 'dark')

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('da-theme', dark ? 'dark' : 'light')
  }, [dark])

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-zinc-950 transition-colors duration-200">
      {/* Header */}
      <div
        className="bg-white dark:bg-zinc-900 border-b border-slate-200 dark:border-zinc-800 sticky top-0 z-40"
        style={{ boxShadow: '0 1px 12px rgba(0,0,0,0.06)' }}
      >
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-slate-700 to-slate-950 dark:from-zinc-600 dark:to-zinc-800 flex items-center justify-center shadow-md shrink-0">
              <span className="text-white font-black text-sm tracking-tight">N</span>
            </div>
            <div>
              <div className="font-black text-slate-900 dark:text-zinc-100 leading-none tracking-tight">Nexus Homes</div>
              <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest font-semibold mt-0.5">Deal Analyzer</div>
            </div>
          </div>
          <button
            onClick={() => setDark(d => !d)}
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 dark:border-zinc-700 text-slate-500 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all"
          >
            {dark ? '☀️' : '🌙'}
          </button>
        </div>
      </div>

      {/* Page body */}
      <div className="max-w-3xl mx-auto px-4 py-5 pb-20">
        <DealAnalyzer />
      </div>
    </div>
  )
}
