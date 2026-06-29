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

function FolderIcon({ folder, members, onClick, jiggle, onDelete, delay = 0 }) {
  const preview = members.slice(0, 4);
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button onClick={onClick} style={jiggle ? { animationDelay: `${delay}ms` } : undefined}
        className={`relative w-16 h-16 rounded-[18px] grid grid-cols-2 gap-[3px] p-2 bg-slate-300/50 dark:bg-white/[0.08] backdrop-blur-sm shadow-[0_3px_8px_rgba(0,0,0,0.25)] dark:shadow-[0_3px_10px_rgba(0,0,0,0.55)] active:scale-90 transition-transform duration-150 ${jiggle ? "icon-jiggle" : ""}`}>
        {preview.map(m => {
          const logo = m.useLogo !== false ? faviconUrl(m.url) : null;
          return (
            <span key={m.id} className={`rounded-[5px] flex items-center justify-center text-[10px] overflow-hidden ${logo ? "bg-white" : `bg-gradient-to-br ${COLORS[m.color] || COLORS.blue}`}`}>
              {logo ? <img src={logo} alt="" className="w-full h-full object-contain p-0.5"/> : m.icon}
            </span>
          );
        })}
        {Array.from({ length: Math.max(0, 4 - preview.length) }).map((_, i) => <span key={`empty-${i}`}/>)}
        {onDelete && (
          <span onClick={e=>{e.stopPropagation();onDelete();}}
            className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-zinc-400 dark:bg-zinc-500 text-white flex items-center justify-center text-[14px] font-bold shadow-md leading-none z-10">
            −
          </span>
        )}
      </button>
      <span className="text-[11px] font-medium text-slate-700 dark:text-zinc-200 text-center leading-tight line-clamp-2 max-w-[68px]">{folder.name}</span>
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

function NewFolderModal({ links, onSave, onClose }) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState([]);

  const toggle = id => setSelected(s => s.includes(id) ? s.filter(x=>x!==id) : [...s, id]);

  const submit = e => {
    e.preventDefault();
    if (!name.trim() || selected.length===0) return;
    onSave({ id: uid(), name: name.trim(), linkIds: selected });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-md" onClick={onClose}>
      <div className="bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-2xl rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.25)] w-full max-w-sm max-h-[85vh] flex flex-col" onClick={e=>e.stopPropagation()}>
        <div className="flex justify-between items-center px-6 py-4 border-b border-black/[0.06] dark:border-white/[0.06]">
          <h2 className="font-semibold text-slate-900 dark:text-zinc-100 text-base tracking-[-0.2px]">New Folder</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-slate-500 dark:text-zinc-400 hover:bg-black/10 dark:hover:bg-white/15 transition-all text-xl leading-none">&times;</button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Name</label>
            <input value={name} onChange={e=>setName(e.target.value)} autoFocus placeholder="Spreadsheets"
              className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"/>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Apps to include</label>
            {links.length === 0 ? (
              <p className="text-sm text-slate-400 dark:text-zinc-500">Add some apps first, then group them into a folder.</p>
            ) : (
              <div className="flex flex-col gap-1 max-h-52 overflow-y-auto">
                {links.map(link => (
                  <label key={link.id} className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all cursor-pointer">
                    <input type="checkbox" checked={selected.includes(link.id)} onChange={()=>toggle(link.id)} className="w-4 h-4 accent-blue-600"/>
                    <span className="text-lg leading-none">{link.icon}</span>
                    <span className="text-sm text-slate-700 dark:text-zinc-200">{link.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 rounded-xl py-2.5 text-sm font-semibold transition-all">Cancel</button>
            <button type="submit" disabled={!name.trim()||selected.length===0} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-xl py-2.5 text-sm font-semibold transition-all shadow-sm shadow-blue-500/30">Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FolderSheet({ folder, members, availableLinks, editMode, onClose, onOpenLink, onRename, onRemoveMember, onAddMember, onDeleteFolder }) {
  const [name, setName] = useState(folder.name);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-md" onClick={onClose}>
      <div className="bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-2xl rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.25)] w-full max-w-sm max-h-[85vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="flex justify-between items-center px-6 py-4 border-b border-black/[0.06] dark:border-white/[0.06]">
          {editMode ? (
            <input value={name} onChange={e=>setName(e.target.value)}
              onBlur={()=>{ if (name.trim() && name.trim()!==folder.name) onRename(name.trim()); }}
              className="font-semibold text-slate-900 dark:text-zinc-100 text-base tracking-[-0.2px] bg-transparent border-b border-dashed border-slate-300 dark:border-zinc-600 focus:outline-none flex-1 mr-3"/>
          ) : (
            <h2 className="font-semibold text-slate-900 dark:text-zinc-100 text-base tracking-[-0.2px]">{folder.name}</h2>
          )}
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-slate-500 dark:text-zinc-400 hover:bg-black/10 dark:hover:bg-white/15 transition-all text-xl leading-none">&times;</button>
        </div>
        <div className="px-6 py-5">
          <div className="grid grid-cols-4 gap-x-4 gap-y-6">
            {members.map(link => (
              <AppIcon key={link.id} label={link.label} emoji={link.icon}
                logoUrl={link.useLogo!==false ? faviconUrl(link.url) : null}
                gradient={COLORS[link.color] || COLORS.blue}
                onDelete={editMode ? ()=>onRemoveMember(link.id) : undefined}
                onClick={()=> editMode ? undefined : onOpenLink(link.url)}/>
            ))}
          </div>

          {editMode && (
            <>
              <div className="text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mt-6 mb-2">Add to folder</div>
              {availableLinks.length === 0 ? (
                <p className="text-sm text-slate-400 dark:text-zinc-500">No other apps to add.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {availableLinks.map(link => (
                    <button key={link.id} type="button" onClick={()=>onAddMember(link.id)}
                      className="flex items-center gap-2.5 text-left px-3 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all">
                      <span className="text-lg leading-none">{link.icon}</span>
                      <span className="text-sm text-slate-700 dark:text-zinc-200">{link.label}</span>
                      <span className="ml-auto text-blue-600 dark:text-blue-400 text-lg leading-none">+</span>
                    </button>
                  ))}
                </div>
              )}
              <button onClick={onDeleteFolder} className="w-full mt-6 text-red-500 text-sm font-semibold py-2">Delete Folder</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Home({ onOpenTracker, onSignOut, dark, onToggleDark }) {
  const [data, setData] = useState(null);
  const [modal, setModal] = useState(null); // null | "add" | {type:"editLink", link} | "addFolder" | {type:"folder", folder}
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    loadData().then(setData);
    const channel = subscribeToChanges(setData);
    return () => channel.unsubscribe();
  }, []);

  const links = data?.quickLinks || [];
  const folders = data?.folders || [];
  const folderedIds = new Set(folders.flatMap(f => f.linkIds));
  const looseLinks = links.filter(l => !folderedIds.has(l.id));

  // Always re-fetch the latest blob right before writing, so this never clobbers
  // changes made elsewhere (e.g. the Tracker) since this component last loaded.
  const mutate = fn => {
    loadData().then(fresh => {
      const payload = fn(fresh);
      saveData(payload);
      setData(payload);
    });
  };

  const saveLink = link => {
    mutate(fresh => {
      const existing = fresh.quickLinks || [];
      return { ...fresh, quickLinks: existing.some(l=>l.id===link.id) ? existing.map(l=>l.id===link.id?link:l) : [...existing, link] };
    });
    setModal(null);
  };

  const deleteLink = id => mutate(fresh => ({
    ...fresh,
    quickLinks: (fresh.quickLinks || []).filter(l=>l.id!==id),
    folders: (fresh.folders || []).map(f => ({ ...f, linkIds: f.linkIds.filter(lid=>lid!==id) })),
  }));

  const saveFolder = folder => {
    mutate(fresh => {
      const existing = fresh.folders || [];
      return { ...fresh, folders: [...existing, folder] };
    });
    setModal(null);
  };

  const deleteFolder = id => mutate(fresh => ({ ...fresh, folders: (fresh.folders || []).filter(f=>f.id!==id) }));

  const renameFolder = (id, name) => mutate(fresh => ({ ...fresh, folders: (fresh.folders || []).map(f=>f.id===id?{...f,name}:f) }));

  const updateFolderMembers = (id, linkIds) => mutate(fresh => ({ ...fresh, folders: (fresh.folders || []).map(f=>f.id===id?{...f,linkIds}:f) }));

  const liveFolder = modal?.type === "folder" ? folders.find(f=>f.id===modal.folder.id) : null;

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

            {folders.map((folder,i) => (
              <FolderIcon key={folder.id} folder={folder} members={links.filter(l=>folder.linkIds.includes(l.id))}
                jiggle={editMode} delay={((i+1)%5)*70}
                onDelete={editMode ? ()=>deleteFolder(folder.id) : undefined}
                onClick={()=>setModal({type:"folder", folder})}/>
            ))}

            {looseLinks.map((link,i) => (
              <AppIcon key={link.id} label={link.label} emoji={link.icon}
                logoUrl={link.useLogo!==false ? faviconUrl(link.url) : null}
                gradient={COLORS[link.color] || COLORS.blue}
                jiggle={editMode} delay={((folders.length+i+1)%5)*70}
                onDelete={editMode ? ()=>deleteLink(link.id) : undefined}
                onClick={()=> editMode ? setModal({type:"editLink", link}) : window.open(link.url, "_blank", "noopener,noreferrer")}/>
            ))}

            <AppIcon label="Add" emoji="+" dashed onClick={()=>setModal("add")}/>
            {editMode && <AppIcon label="New Folder" emoji="📁" dashed onClick={()=>setModal("addFolder")}/>}
          </div>
        )}
      </div>

      {(modal==="add"||modal?.type==="editLink") && (
        <LinkModal init={modal?.type==="editLink"?modal.link:null} onSave={saveLink} onClose={()=>setModal(null)}/>
      )}

      {modal==="addFolder" && (
        <NewFolderModal links={looseLinks} onSave={saveFolder} onClose={()=>setModal(null)}/>
      )}

      {liveFolder && (
        <FolderSheet folder={liveFolder} members={links.filter(l=>liveFolder.linkIds.includes(l.id))}
          availableLinks={looseLinks} editMode={editMode}
          onClose={()=>setModal(null)}
          onOpenLink={url=>window.open(url, "_blank", "noopener,noreferrer")}
          onRename={name=>renameFolder(liveFolder.id, name)}
          onRemoveMember={linkId=>updateFolderMembers(liveFolder.id, liveFolder.linkIds.filter(id=>id!==linkId))}
          onAddMember={linkId=>updateFolderMembers(liveFolder.id, [...liveFolder.linkIds, linkId])}
          onDeleteFolder={()=>{deleteFolder(liveFolder.id); setModal(null);}}/>
      )}
    </div>
  );
}
