import { useState, useEffect } from "react";
import { loadData, saveData, subscribeToChanges } from "./supabase";

const uid = () => Math.random().toString(36).slice(2, 9);

const COLORS = {
  blue:   "from-blue-400 to-blue-600",
  green:  "from-emerald-400 to-emerald-600",
  violet: "from-violet-400 to-violet-600",
  amber:  "from-amber-400 to-amber-600",
  red:    "from-red-400 to-red-600",
  slate:  "from-slate-400 to-slate-600",
};

const normalizeUrl = u => /^https?:\/\//i.test(u) ? u : `https://${u}`;

// Pull a site's favicon from Google's public favicon service — no API key needed.
const faviconUrl = u => {
  try {
    const { hostname } = new URL(normalizeUrl(u));
    return `https://www.google.com/s2/favicons?sz=128&domain=${hostname}`;
  } catch {
    return null;
  }
};

function AppIcon({ label, emoji, logoUrl, gradient, onClick, jiggle, onDelete, dashed, delay = 0 }) {
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [logoUrl]);
  const showLogo = !!logoUrl && !logoFailed;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <button onClick={onClick} style={jiggle ? { animationDelay: `${delay}ms` } : undefined}
        className={`relative w-16 h-16 rounded-[18px] flex items-center justify-center text-[28px] active:scale-90 transition-transform duration-150 ${jiggle ? "icon-jiggle" : ""} ${
          dashed
            ? "border-2 border-dashed border-slate-300 dark:border-zinc-600 text-slate-300 dark:text-zinc-500 bg-white/40 dark:bg-white/[0.03]"
            : showLogo
              ? "bg-white dark:bg-zinc-100 shadow-[0_3px_8px_rgba(0,0,0,0.25)] dark:shadow-[0_3px_10px_rgba(0,0,0,0.55)]"
              : `bg-gradient-to-br ${gradient} shadow-[0_3px_8px_rgba(0,0,0,0.25)] dark:shadow-[0_3px_10px_rgba(0,0,0,0.55)]`
        }`}>
        {showLogo
          ? <img src={logoUrl} alt="" className="w-9 h-9 object-contain" onError={()=>setLogoFailed(true)}/>
          : <span style={{textShadow: dashed?undefined:"0 1px 2px rgba(0,0,0,0.15)"}}>{emoji}</span>}
        {onDelete && (
          <span onClick={e=>{e.stopPropagation();onDelete();}}
            className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-zinc-400 dark:bg-zinc-500 text-white flex items-center justify-center text-[14px] font-bold shadow-md leading-none">
            −
          </span>
        )}
      </button>
      <span className="text-[11px] font-medium text-slate-700 dark:text-zinc-200 text-center leading-tight line-clamp-2 max-w-[68px]">{label}</span>
    </div>
  );
}

function LinkModal({ init, onSave, onClose }) {
  const [label, setLabel] = useState(init?.label || "");
  const [url, setUrl] = useState(init?.url || "");
  const [icon, setIcon] = useState(init?.icon || "🔗");
  const [color, setColor] = useState(init?.color || "blue");
  const [useLogo, setUseLogo] = useState(init?.useLogo ?? true);
  const [logoFailed, setLogoFailed] = useState(false);

  const preview = useLogo ? faviconUrl(url) : null;

  const submit = e => {
    e.preventDefault();
    if (!label.trim() || !url.trim()) return;
    onSave({ id: init?.id || uid(), label: label.trim(), url: normalizeUrl(url.trim()), icon: icon.trim() || "🔗", color, useLogo });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-md" onClick={onClose}>
      <div className="bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-2xl rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.25)] w-full max-w-sm" onClick={e=>e.stopPropagation()}>
        <div className="flex justify-between items-center px-6 py-4 border-b border-black/[0.06] dark:border-white/[0.06]">
          <h2 className="font-semibold text-slate-900 dark:text-zinc-100 text-base tracking-[-0.2px]">{init ? "Edit App" : "Add App"}</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-slate-500 dark:text-zinc-400 hover:bg-black/10 dark:hover:bg-white/15 transition-all text-xl leading-none">&times;</button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div className="flex justify-center mb-1">
            <div className={`w-16 h-16 rounded-[18px] flex items-center justify-center text-[28px] shadow-[0_3px_8px_rgba(0,0,0,0.25)] ${preview && !logoFailed ? "bg-white" : `bg-gradient-to-br ${COLORS[color]}`}`}>
              {preview && !logoFailed
                ? <img src={preview} alt="" className="w-9 h-9 object-contain" onError={()=>setLogoFailed(true)}/>
                : (icon || "🔗")}
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Label</label>
            <input value={label} onChange={e=>setLabel(e.target.value)} autoFocus placeholder="Closing Tracker Sheet"
              className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"/>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">URL</label>
            <input value={url} onChange={e=>{setUrl(e.target.value); setLogoFailed(false);}} placeholder="docs.google.com/..."
              className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"/>
          </div>
          <label className="flex items-center gap-2 text-[13px] font-medium text-slate-600 dark:text-zinc-300 select-none">
            <input type="checkbox" checked={useLogo} onChange={e=>setUseLogo(e.target.checked)} className="w-4 h-4 accent-blue-600"/>
            Use the site's icon automatically
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Icon{useLogo && " (fallback)"}</label>
              <input value={icon} onChange={e=>setIcon(e.target.value)} placeholder="📊" maxLength={4}
                className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-center text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"/>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Color</label>
              <div className="flex gap-1.5 items-center h-[46px]">
                {Object.entries(COLORS).map(([k,grad])=>(
                  <button type="button" key={k} onClick={()=>setColor(k)}
                    className={`w-7 h-7 rounded-full bg-gradient-to-br ${grad} transition-all ${color===k?"ring-2 ring-offset-2 ring-slate-900 dark:ring-white dark:ring-offset-[#1C1C1E]":""}`}/>
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
  const [editMode, setEditMode] = useState(false);

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

  const deleteLink = id => mutateLinks(existing => existing.filter(l=>l.id!==id));

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#E8ECF4] to-[#DDE3ED] dark:from-black dark:to-[#0A0A0C] transition-colors duration-300">
      <div className="bg-white/70 dark:bg-[#1C1C1E]/80 backdrop-blur-2xl border-b border-black/[0.06] dark:border-white/[0.06] sticky top-0 z-40">
        <div className="px-5 py-3.5 max-w-3xl mx-auto flex items-center gap-3">
          <div className="font-semibold text-[17px] text-slate-900 dark:text-white leading-none tracking-[-0.3px]">Nexus Homes</div>
          <div className="ml-auto flex items-center gap-2.5">
            <button onClick={()=>setEditMode(e=>!e)} className="text-[12px] font-semibold text-blue-600 dark:text-blue-400 hover:opacity-75 transition-opacity">{editMode?"Done":"Edit"}</button>
            <button onClick={onToggleDark}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-slate-600 dark:text-zinc-300 hover:bg-black/10 dark:hover:bg-white/15 transition-all"
              title={dark?"Switch to light":"Switch to dark"}>
              <span className="text-[15px] leading-none">{dark?"☀️":"🌙"}</span>
            </button>
            <button onClick={onSignOut} className="text-[12px] font-semibold text-blue-600 dark:text-blue-400 hover:opacity-75 transition-opacity">Sign out</button>
          </div>
        </div>
      </div>

      <div className="px-6 pt-8 pb-16 max-w-3xl mx-auto">
        {data===null && <div className="text-center py-16 text-slate-400 dark:text-zinc-500 text-sm">Loading…</div>}

        {data!==null && (
          <div className="grid grid-cols-4 sm:grid-cols-5 gap-x-4 gap-y-7">
            <AppIcon label="Money Tracker" emoji="💰" gradient="from-blue-500 to-blue-700"
              jiggle={editMode} onClick={editMode ? undefined : onOpenTracker}/>

            {links.map((link,i)=>{
              const grad = COLORS[link.color] || COLORS.blue;
              return (
                <AppIcon key={link.id} label={link.label} emoji={link.icon}
                  logoUrl={link.useLogo!==false ? faviconUrl(link.url) : null}
                  gradient={grad}
                  jiggle={editMode} delay={((i+1)%5)*70}
                  onDelete={editMode ? ()=>deleteLink(link.id) : undefined}
                  onClick={()=> editMode ? setModal({type:"edit",link}) : window.open(link.url, "_blank", "noopener,noreferrer")}/>
              );
            })}
            <AppIcon label="Add" emoji="+" dashed onClick={()=>setModal("add")}/>
          </div>
        )}
      </div>

      {(modal==="add"||modal?.type==="edit") && (
        <LinkModal init={modal?.type==="edit"?modal.link:null} onSave={saveLink} onClose={()=>setModal(null)}/>
      )}
    </div>
  );
}
