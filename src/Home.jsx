import { useState, useEffect } from "react";
import { loadData, saveData, subscribeToChanges } from "./supabase";

const uid = () => Math.random().toString(36).slice(2, 9);

const COLORS = {
  blue:   { bg: "bg-blue-500",    tint: "bg-blue-50 dark:bg-blue-950/30" },
  green:  { bg: "bg-emerald-500", tint: "bg-emerald-50 dark:bg-emerald-950/30" },
  violet: { bg: "bg-violet-500",  tint: "bg-violet-50 dark:bg-violet-950/30" },
  amber:  { bg: "bg-amber-500",   tint: "bg-amber-50 dark:bg-amber-950/30" },
  red:    { bg: "bg-red-500",     tint: "bg-red-50 dark:bg-red-950/30" },
  slate:  { bg: "bg-slate-500",   tint: "bg-slate-100 dark:bg-zinc-800" },
};

const normalizeUrl = u => /^https?:\/\//i.test(u) ? u : `https://${u}`;

function LinkModal({ init, onSave, onClose }) {
  const [label, setLabel] = useState(init?.label || "");
  const [url, setUrl] = useState(init?.url || "");
  const [icon, setIcon] = useState(init?.icon || "🔗");
  const [color, setColor] = useState(init?.color || "blue");

  const submit = e => {
    e.preventDefault();
    if (!label.trim() || !url.trim()) return;
    onSave({ id: init?.id || uid(), label: label.trim(), url: normalizeUrl(url.trim()), icon: icon.trim() || "🔗", color });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-md" onClick={onClose}>
      <div className="bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-2xl rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.25)] w-full max-w-sm" onClick={e=>e.stopPropagation()}>
        <div className="flex justify-between items-center px-6 py-4 border-b border-black/[0.06] dark:border-white/[0.06]">
          <h2 className="font-semibold text-slate-900 dark:text-zinc-100 text-base tracking-[-0.2px]">{init ? "Edit Link" : "Add Link"}</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-slate-500 dark:text-zinc-400 hover:bg-black/10 dark:hover:bg-white/15 transition-all text-xl leading-none">&times;</button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Label</label>
            <input value={label} onChange={e=>setLabel(e.target.value)} autoFocus placeholder="Closing Tracker Sheet"
              className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"/>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">URL</label>
            <input value={url} onChange={e=>setUrl(e.target.value)} placeholder="docs.google.com/..."
              className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"/>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Icon</label>
              <input value={icon} onChange={e=>setIcon(e.target.value)} placeholder="📊" maxLength={4}
                className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-center text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"/>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Color</label>
              <div className="flex gap-1.5 items-center h-[46px]">
                {Object.entries(COLORS).map(([k,v])=>(
                  <button type="button" key={k} onClick={()=>setColor(k)}
                    className={`w-7 h-7 rounded-full ${v.bg} transition-all ${color===k?"ring-2 ring-offset-2 ring-slate-900 dark:ring-white dark:ring-offset-[#1C1C1E]":""}`}/>
                ))}
              </div>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 rounded-xl py-2.5 text-sm font-semibold transition-all">Cancel</button>
            <button type="submit" className="flex-1 bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-2.5 text-sm font-semibold transition-all shadow-sm shadow-blue-500/30">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Home({ onOpenTracker, onSignOut, dark, onToggleDark }) {
  const [data, setData] = useState(null);
  const [modal, setModal] = useState(null); // null | "add" | {type:"edit", link}

  useEffect(() => {
    loadData().then(setData);
    const channel = subscribeToChanges(setData);
    return () => channel.unsubscribe();
  }, []);

  const links = data?.quickLinks || [];

  // Always re-fetch the latest blob right before writing, so this never clobbers
  // changes made elsewhere (e.g. the Tracker) since this component last loaded.
  const mutateLinks = fn => {
    loadData().then(fresh => {
      const payload = { ...fresh, quickLinks: fn(fresh.quickLinks || []) };
      saveData(payload);
      setData(payload);
    });
  };

  const saveLink = link => {
    mutateLinks(existing => existing.some(l=>l.id===link.id) ? existing.map(l=>l.id===link.id?link:l) : [...existing, link]);
    setModal(null);
  };

  const deleteLink = id => {
    if (!confirm("Remove this link?")) return;
    mutateLinks(existing => existing.filter(l=>l.id!==id));
  };

  return (
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-black transition-colors duration-300">
      <div className="bg-white/85 dark:bg-[#1C1C1E]/90 backdrop-blur-2xl border-b border-black/[0.08] dark:border-white/[0.07] sticky top-0 z-40">
        <div className="px-5 py-3.5 max-w-3xl mx-auto flex items-center gap-3">
          <div className="w-9 h-9 rounded-[11px] bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shrink-0 shadow-md shadow-blue-500/30">
            <span className="text-white font-black text-sm tracking-tight">N</span>
          </div>
          <div>
            <div className="font-semibold text-[15px] text-slate-900 dark:text-white leading-none tracking-[-0.3px]">Nexus Homes</div>
            <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5 font-medium">Dashboard</div>
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            <button onClick={onToggleDark}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-slate-600 dark:text-zinc-300 hover:bg-black/10 dark:hover:bg-white/15 transition-all"
              title={dark?"Switch to light":"Switch to dark"}>
              <span className="text-[15px] leading-none">{dark?"☀️":"🌙"}</span>
            </button>
            <button onClick={onSignOut} className="text-[12px] font-semibold text-blue-600 dark:text-blue-400 hover:opacity-75 transition-opacity">Sign out</button>
          </div>
        </div>
      </div>

      <div className="px-4 pt-6 max-w-3xl mx-auto pb-20">
        <div className="mb-7">
          <div className="text-[11px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-3 px-1">Apps</div>
          <button onClick={onOpenTracker}
            className="w-full flex items-center gap-4 bg-white dark:bg-[#1C1C1E] rounded-2xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none hover:shadow-[0_4px_20px_rgba(0,0,0,0.10)] dark:hover:bg-white/[0.04] transition-all text-left">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-2xl shrink-0 shadow-md shadow-blue-500/30">💰</div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-slate-900 dark:text-zinc-100 text-[15px]">Private Money Tracker</div>
              <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">Loans · Lenders · Closings</div>
            </div>
            <span className="text-slate-300 dark:text-zinc-600 text-lg">›</span>
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3 px-1">
            <div className="text-[11px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Quick Links</div>
            <button onClick={()=>setModal("add")} className="text-[12px] font-semibold text-blue-600 dark:text-blue-400 hover:opacity-75 transition-opacity">+ Add</button>
          </div>

          {data===null && <div className="text-center py-10 text-slate-400 dark:text-zinc-500 text-sm">Loading…</div>}

          {data!==null && links.length===0 && (
            <div className="text-center py-12 text-slate-400 dark:text-zinc-500 bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
              <div className="text-3xl mb-2">🔗</div>
              <p className="font-semibold text-sm">No links yet</p>
              <p className="text-xs mt-1">Add spreadsheets, software, anything you use often</p>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {links.map(link => {
              const c = COLORS[link.color] || COLORS.blue;
              return (
                <div key={link.id}
                  onClick={()=>window.open(link.url, "_blank", "noopener,noreferrer")}
                  className="group relative cursor-pointer bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none hover:shadow-[0_4px_20px_rgba(0,0,0,0.10)] dark:hover:bg-white/[0.04] transition-all">
                  <div className="flex items-center justify-between mb-2">
                    <div className={`w-9 h-9 rounded-xl ${c.tint} flex items-center justify-center text-lg`}>{link.icon}</div>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={e=>{e.stopPropagation();setModal({type:"edit",link});}} className="w-6 h-6 flex items-center justify-center rounded-md text-slate-300 dark:text-zinc-600 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all text-[11px]">✏️</button>
                      <button onClick={e=>{e.stopPropagation();deleteLink(link.id);}} className="w-6 h-6 flex items-center justify-center rounded-md text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all text-[11px]">🗑</button>
                    </div>
                  </div>
                  <div className="font-semibold text-slate-900 dark:text-zinc-100 text-sm truncate">{link.label}</div>
                  <div className="text-[10px] text-slate-400 dark:text-zinc-500 truncate mt-0.5">{link.url.replace(/^https?:\/\//,"")}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {(modal==="add"||modal?.type==="edit") && (
        <LinkModal init={modal?.type==="edit"?modal.link:null} onSave={saveLink} onClose={()=>setModal(null)}/>
      )}
    </div>
  );
}
