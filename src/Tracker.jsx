import { useState, useEffect, useRef, createContext, useContext, Fragment } from "react";
import { loadData, saveData, subscribeToChanges, listLenderAccounts, createLenderAccount, deleteLenderAccount } from './supabase'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, arrayMove, rectSortingStrategy, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const load = loadData
const save = saveData

const TODAY = new Date().toISOString().split("T")[0];
const uid   = () => Math.random().toString(36).slice(2, 9);
const $$    = n  => "$" + Math.round(Math.abs(n ?? 0)).toLocaleString();
const $$s   = n  => { if (n==null) return "—"; const a=Math.round(Math.abs(n)).toLocaleString(); return n>=0?`+$${a}`:`-$${a}`; };
const $$c   = n  => { const a=Math.round(Math.abs(n??0)); if(a>=1e6){const m=a/1e6;return "$"+(m>=10?m.toFixed(1):m.toFixed(2)).replace(/\.?0+$/,"")+"M";} if(a>=1e3)return "$"+Math.round(a/1e3)+"K"; return "$"+a; };
// Penny-precise formatters for the closing modal
const $$p   = n  => "$" + Math.abs(n??0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
const $$ps  = n  => { if(n==null) return "—"; const a=Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,','); return n>=0?`+$${a}`:`-$${a}`; };
const pct   = (a,b) => b>0 ? Math.min(100, Math.round(a/b*100)) : 0;

// Sort key for an address that ignores the house number and a leading directional
// abbreviation (N/S/E/W/NE/NW/SE/SW), so "1024 E Paint St" sorts under "Paint", not "E".
const streetSortKey = address => {
  if (!address) return "";
  const street = address.split(',')[0].trim();
  const noNumber = street.replace(/^\d+[\w-]*\s+/, '');
  const noDirection = noNumber.replace(/^(N|S|E|W|NE|NW|SE|SW)\.?\s+/i, '');
  return noDirection.toLowerCase();
};

const daysBetween = (d1, d2) => {
  if (!d1||!d2) return 0;
  return Math.max(0, Math.floor((new Date(d2)-new Date(d1))/864e5));
};
const nextDay = d => { const [y,m,day]=d.split('-').map(Number); const dt=new Date(y,m-1,day+1); return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`; };
const yearDays = l => l?.loanType==="hard" ? 360 : 365;

const calcBalance = (l, asOf=TODAY) => {
  if (!l?.startDate||!l?.principal) return l?.principal??0;
  const pt = l.paymentType||"closing";
  if (pt==="monthly_rate"||pt==="monthly_fixed") return l.principal; // payoff = principal only
  if (l.interestType === "fixed") return l.principal + (l.interestRate || 0);
  const end = l.endDate && l.endDate<=asOf ? l.endDate : asOf;
  if (l.startDate>end) return l.principal;
  return l.principal + l.principal*(l.interestRate||0)/100*(daysBetween(l.startDate,end)/yearDays(l));
};

const calcIntEarned = (l, asOf=TODAY) => {
  if (!l?.startDate||!l?.principal) return 0;
  const pt = l.paymentType||"closing";
  const end = l.endDate&&l.endDate<=asOf ? l.endDate : asOf;
  const days = daysBetween(l.startDate, end);
  if (pt==="monthly_rate") return Math.round((l.principal||0)*(l.interestRate||0)/100/yearDays(l)*days*100)/100;
  if (pt==="monthly_fixed") return Math.round((l.monthlyPayment||0)*days/30.44*100)/100;
  return Math.round((calcBalance(l,asOf)-(l.principal||0))*100)/100;
};

const effectiveMonths = prop => {
  if (prop?.projectMonths!=null&&prop.projectMonths!=="") return Math.max(0.5,parseFloat(prop.projectMonths)||2);
  const rehab = prop?.rehabBudget||0;
  if (!rehab) return 2;
  return Math.ceil((rehab/1000+60)/30);
};

const monthlyLoanPayment = loan => {
  if (!loan||loan.endDate) return 0;
  const pt = loan.paymentType||"closing";
  if (pt==="monthly_rate") return Math.round((loan.principal||0)*(loan.interestRate||0)/100/12);
  if (pt==="monthly_fixed") return Math.round(loan.monthlyPayment||0);
  return 0;
};

const drawRemaining = loan => {
  if (!loan?.drawFacility) return 0;
  const drawn=(loan.drawFacility.draws||[]).reduce((s,d)=>s+(d.amount||0),0);
  return Math.max(0,(loan.drawFacility.committed||0)-drawn);
};

const propNeeded = (prop, activeLoans) => {
  if (!prop?.purchasePrice&&!prop?.rehabBudget) return prop?.fundingNeeded||0;
  const months = effectiveMonths(prop);
  const monthlyInt = activeLoans.reduce((s,l)=>s+monthlyLoanPayment(l),0);
  return (prop.purchasePrice||0)+(prop.rehabBudget||0)+(prop.monthlyHolding??500)*months+monthlyInt*months;
};

const fmtRate = (l) => {
  if (!l) return "";
  const pt = l.paymentType||"closing";
  if (l.interestType === "fixed") return "$" + Math.round(l.interestRate||0).toLocaleString() + " fixed";
  if (pt==="monthly_rate") return (l.interestRate||0) + "%/yr · monthly";
  if (pt==="monthly_fixed") return "$" + Math.round(l.monthlyPayment||0).toLocaleString() + "/mo";
  return (l.interestRate||0) + "%/yr";
};

// ─── Privacy context ──────────────────────────────────────────────────────────
const PrivacyContext = createContext(false);
const usePrivacy = () => useContext(PrivacyContext);
// ─── Panel context (entity detail slide-in) ───────────────────────────────────
const PanelContext = createContext(null);
const usePanel = () => useContext(PanelContext);
// Replace digits with ∙ (integer) or · (decimal), strip commas, keep K/M suffix
const maskMoney = s => s.replace(/[\d,]+(\.\d+)?([KM])?/g, (m, dec, sfx) => {
  const intPart = m.slice(0, m.length - (dec||'').length - (sfx||'').length);
  const intDots = '∙'.repeat(intPart.replace(/[^0-9]/g,'').length);
  const decDots = dec ? '·'.repeat(dec.replace(/[^0-9]/g,'').length) : '';
  return intDots + decDots + (sfx||'');
});

// ─── Persisted state helper ───────────────────────────────────────────────────
const usePersistedState = (key, def) => {
  const [val, setVal] = useState(() => {
    try { const s=localStorage.getItem(key); return s!==null?JSON.parse(s):def; } catch { return def; }
  });
  const set = v => { setVal(prev => { const next=typeof v==="function"?v(prev):v; try{localStorage.setItem(key,JSON.stringify(next));}catch{} return next; }); };
  return [val, set];
};

// ─── Address autocomplete ─────────────────────────────────────────────────────
const STATE_ABBR={"Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA","Colorado":"CO","Connecticut":"CT","Delaware":"DE","Florida":"FL","Georgia":"GA","Hawaii":"HI","Idaho":"ID","Illinois":"IL","Indiana":"IN","Iowa":"IA","Kansas":"KS","Kentucky":"KY","Louisiana":"LA","Maine":"ME","Maryland":"MD","Massachusetts":"MA","Michigan":"MI","Minnesota":"MN","Mississippi":"MS","Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND","Ohio":"OH","Oklahoma":"OK","Oregon":"OR","Pennsylvania":"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD","Tennessee":"TN","Texas":"TX","Utah":"UT","Vermont":"VT","Virginia":"VA","Washington":"WA","West Virginia":"WV","Wisconsin":"WI","Wyoming":"WY"};
const fmtAddr = item => {
  const a=item.address||{};
  const street=[a.house_number,a.road||a.pedestrian||a.path].filter(Boolean).join(" ");
  const city=a.city||a.town||a.village||a.hamlet||a.suburb||"";
  const state=STATE_ABBR[a.state]||a.state||"";
  const zip=(a.postcode||"").split("-")[0];
  return [street,city,[state,zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
};

function AddressField({ value, onChange }) {
  const [q,setQ]=useState(value||"");
  const [sugg,setSugg]=useState([]);
  const [loading,setLoading]=useState(false);
  const [open,setOpen]=useState(false);
  const [activeIdx,setActiveIdx]=useState(-1);
  const debRef=useRef(null);
  const wrapRef=useRef(null);

  useEffect(()=>{ const h=e=>{if(wrapRef.current&&!wrapRef.current.contains(e.target))setOpen(false);}; document.addEventListener("mousedown",h); return()=>document.removeEventListener("mousedown",h); },[]);

  const search = async q => {
    if(q.length<3){setSugg([]);return;}
    setLoading(true);
    try {
      const r=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=6&countrycodes=us`,{headers:{"Accept-Language":"en-US,en"}});
      const data=await r.json();
      setSugg(data.map(i=>({label:fmtAddr(i)})).filter(o=>o.label.split(",").length>=2));
    } catch { setSugg([]); }
    setLoading(false);
  };

  const handleChange = val => { setQ(val); onChange(val); setOpen(true); setActiveIdx(-1); clearTimeout(debRef.current); debRef.current=setTimeout(()=>search(val),420); };
  const pick = label => { setQ(label); onChange(label); setSugg([]); setOpen(false); };
  const onKey = e => {
    if(!open||!sugg.length) return;
    if(e.key==="ArrowDown"){e.preventDefault();setActiveIdx(i=>Math.min(i+1,sugg.length-1));}
    if(e.key==="ArrowUp"){e.preventDefault();setActiveIdx(i=>Math.max(i-1,0));}
    if(e.key==="Enter"&&activeIdx>=0){e.preventDefault();pick(sugg[activeIdx].label);}
    if(e.key==="Escape") setOpen(false);
  };

  return (
    <div className="mb-4" ref={wrapRef}>
      <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Property Address</label>
      <div className="relative">
        <input value={q} onChange={e=>handleChange(e.target.value)} onFocus={()=>sugg.length>0&&setOpen(true)} onKeyDown={onKey}
          placeholder="Start typing an address…"
          className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 pr-10 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"/>
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 dark:text-zinc-600 pointer-events-none text-sm">
          {loading ? <span className="animate-spin inline-block">⟳</span> : "📍"}
        </div>
        {open && sugg.length>0 && (
          <div className="absolute z-50 mt-1 w-full bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-xl shadow-xl overflow-hidden">
            {sugg.map((s,i)=>(
              <button key={i} onMouseDown={e=>{e.preventDefault();pick(s.label);}}
                className={`w-full text-left px-4 py-3 text-sm border-b border-slate-50 dark:border-zinc-800 last:border-0 transition-colors ${i===activeIdx?"bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800"}`}>
                <span className="text-slate-300 dark:text-zinc-600 mr-1.5 text-xs">📍</span>{s.label}
              </button>
            ))}
            <div className="px-4 py-1.5 text-[10px] text-slate-400 dark:text-zinc-500 bg-slate-50 dark:bg-zinc-800 border-t border-slate-100 dark:border-zinc-700">Powered by OpenStreetMap</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── UI primitives ────────────────────────────────────────────────────────────
const Inp = ({label,type="text",value,onChange,placeholder,helpText}) => (
  <div className="mb-3">
    <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">{label}</label>
    <input type={type} value={value??""} onChange={e=>onChange(e.target.value)}
      onWheel={e=>e.target.blur()}
      placeholder={placeholder}
      className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"/>
    {helpText&&<p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-1.5">{helpText}</p>}
  </div>
);

const Sel = ({label,value,onChange,options}) => (
  <div className="mb-3">
    <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">{label}</label>
    <select value={value??""} onChange={e=>onChange(e.target.value)}
      className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all appearance-none">
      {options.map(([v,l])=><option key={v} value={v}>{l}</option>)}
    </select>
  </div>
);

const DateInp = ({label,value,onChange,helpText}) => (
  <div className="mb-3">
    <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">{label}</label>
    <div className="relative">
      <input type="date" value={value??""} onChange={e=>onChange(e.target.value)}
        className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all pr-10"/>
      {value && <button type="button" onClick={()=>onChange("")}
        className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-slate-100 dark:bg-zinc-700 hover:bg-red-100 dark:hover:bg-red-900/50 hover:text-red-500 text-slate-400 dark:text-zinc-400 flex items-center justify-center text-[10px] font-bold transition-colors">✕</button>}
    </div>
    {helpText&&<p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-1.5">{helpText}</p>}
  </div>
);

// Drag wrapper for manual property sorting — reuses the whole element as the drag
// surface (tap still works normally via the PointerSensor's activation distance).
// `children` can be a node (whole item is the drag handle) or a render-prop
// `(handleProps) => node` so the caller can put the handle on just part of
// the item (e.g. a header bar) instead of the whole thing.
const SortableItem = ({id,disabled,as:Tag="div",className,children}) => {
  const {attributes,listeners,setNodeRef,transform,transition,isDragging}=useSortable({id,disabled});
  const isRenderProp = typeof children==="function";
  const handleProps = disabled ? {} : {...attributes,...listeners};
  return (
    <Tag ref={setNodeRef} className={className}
      style={{transform:CSS.Transform.toString(transform),transition,opacity:isDragging?0.5:1,zIndex:isDragging?10:undefined,cursor:(!isRenderProp&&!disabled)?"grab":undefined}}
      {...(isRenderProp?{}:handleProps)}>
      {isRenderProp ? children(handleProps) : children}
    </Tag>
  );
};

const TypeBadge = ({type,sm}) => {
  const c = type==="hard"
    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
    : "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400";
  const dot = type==="hard" ? "bg-amber-400" : "bg-sky-400";
  return <span className={`inline-flex items-center gap-1 ${c} rounded-full font-semibold ${sm?"text-[10px] px-2 py-0.5":"text-xs px-2.5 py-1"}`}>
    <span className={`w-1.5 h-1.5 rounded-full ${dot} shrink-0`}/>{type==="hard"?"Hard Money":"Private Money"}
  </span>;
};

const TypeLabel = ({type}) => (
  <span className={`text-[10px] font-semibold ${type==="hard"?"text-amber-600 dark:text-amber-400":"text-sky-600 dark:text-sky-400"}`}>
    {type==="hard"?"Hard":"Private"}
  </span>
);

const Chip = ({children,color}) => {
  const cls={
    green: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800",
    red:   "bg-red-50 text-red-600 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800",
    gray:  "bg-slate-100 text-slate-500 border-slate-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700",
    violet:"bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/20 dark:text-violet-400 dark:border-violet-800",
    amber: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800",
  };
  return <span className={`inline-flex items-center text-[11px] font-semibold border rounded-full px-2.5 py-0.5 ${cls[color]||cls.gray}`}>{children}</span>;
};

function Modal({title,onClose,children}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-md" onClick={onClose}>
      <div className="bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-2xl rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.25)] w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="flex justify-between items-center px-6 py-4 border-b border-black/[0.06] dark:border-white/[0.06] sticky top-0 bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur-2xl rounded-t-2xl z-10">
          <h2 className="font-semibold text-slate-900 dark:text-zinc-100 text-base tracking-[-0.2px]">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-slate-500 dark:text-zinc-400 hover:bg-black/10 dark:hover:bg-white/15 transition-all text-xl leading-none">&times;</button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

const Btn = ({onClick,children,color="blue",full,sm,disabled}) => {
  const cls={
    blue:  "bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-sm shadow-blue-200 dark:shadow-none",
    green: "bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white shadow-sm shadow-emerald-200 dark:shadow-none",
    purple:"bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white shadow-sm shadow-violet-200 dark:shadow-none",
    red:   "bg-red-500 hover:bg-red-600 active:bg-red-700 text-white shadow-sm shadow-red-200 dark:shadow-none",
    ghost: "bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-200",
    navy:  "bg-slate-900 hover:bg-slate-800 text-white dark:bg-zinc-700 dark:hover:bg-zinc-600",
  };
  return <button onClick={onClick} disabled={disabled}
    className={`${cls[color]} ${full?"w-full":""} ${sm?"px-3 py-1.5 text-xs":"px-5 py-2.5 text-sm"} rounded-xl font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed`}>{children}</button>;
};

// ─── Lender Name Autocomplete ─────────────────────────────────────────────────
function LenderAutocomplete({ value, onChange, properties }) {
  const [show, setShow] = useState(false);
  const wrapRef = useRef(null);
  const allNames = [...new Set(properties.flatMap(p => p.loans.map(l => l.lenderName)))].filter(Boolean).sort();
  const matches = allNames.filter(n => value.length > 0 && n.toLowerCase().includes(value.toLowerCase()) && n.toLowerCase() !== value.toLowerCase());

  useEffect(() => {
    const h = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setShow(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <div className="mb-3 relative" ref={wrapRef}>
      <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">
        Lender Name <span className="text-red-400">*</span>
      </label>
      <input value={value} onChange={e=>{ onChange(e.target.value); setShow(true); }} onFocus={()=>setShow(true)}
        placeholder="Mike Dixon"
        className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"/>
      {show && matches.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-xl shadow-xl overflow-hidden">
          {matches.map(name => (
            <button key={name} onMouseDown={e=>{ e.preventDefault(); onChange(name); setShow(false); }}
              className="w-full text-left px-4 py-3 text-sm text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors border-b border-slate-50 dark:border-zinc-800 last:border-0 flex items-center gap-2.5">
              <span className="w-6 h-6 rounded-full bg-slate-100 dark:bg-zinc-700 text-slate-500 dark:text-zinc-400 flex items-center justify-center text-[10px] font-bold shrink-0">{name[0]?.toUpperCase()}</span>{name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Lender Money Form ────────────────────────────────────────────────────────
function LenderMoneyForm({ properties, lenders = [], unassigned = [], init, onSave, onMerge, onClose }) {
  const activeProps = properties.filter(p=>!p.dateSold);

  const initName = init?.lenderName || "";
  const initExisting = lenders.find(l=>l.name===initName);
  const [lenderSel, setLenderSel] = useState(
    initExisting ? initExisting.id : (initName ? "_new_" : "")
  );
  const [newName, setNewName] = useState(initExisting ? "" : initName);
  const [newType, setNewType] = useState(
    initExisting ? "private" : (init?.loanType||"private")
  );

  const activeLender = (lenderSel && lenderSel !== "_new_")
    ? lenders.find(l=>l.id===lenderSel) : null;
  const currentLoanType = activeLender ? activeLender.loanType
    : (lenderSel === "_new_" ? newType : "private");

  const [f, sf] = useState(()=>({
    principal:"",
    startDate:TODAY, interestType:"percentage", interestRate:"", specialTerms:"", endDate:"", dueDate:"",
    destination:"unassigned",
    paymentType:"closing", monthlyPayment:"", drawFacility:null,
    ...(init??{}),
    paymentType: init?.paymentType || (init?.loanType==="hard" ? "monthly_rate" : "closing"),
    monthlyPayment: String(init?.monthlyPayment||""),
    drawFacility: init?.drawFacility||null,
  }));
  const [drawDate,setDrawDate]=useState(TODAY);
  const [drawAmt,setDrawAmt]=useState("");
  const [blockMsg,setBlockMsg]=useState("");
  const s = k => v => sf(p=>({...p,[k]:v}));

  const isFixed = (f.interestType || "percentage") === "fixed";
  const addDraw = () => {
    const amount = parseFloat(drawAmt);
    if (!amount||!drawDate) return;
    sf(p=>({...p,drawFacility:{...p.drawFacility,draws:[...(p.drawFacility?.draws||[]),{id:uid(),date:drawDate,amount}]}}));
    setDrawAmt("");
  };
  const handleSave = () => {
    const lenderName = activeLender ? activeLender.name : (lenderSel === "_new_" ? newName.trim() : "");
    if (!lenderName) { alert("Please select or enter a lender."); return; }
    if (!(parseFloat(f.principal) > 0)) { alert("Please enter an amount greater than zero."); return; }
    if (!f.startDate) { alert("Please enter a start date."); return; }
    const destProp = f.destination && f.destination!=="unassigned"
      ? activeProps.find(x=>x.id===f.destination) : null;
    if (destProp) {
      const c = propConflict(f.startDate, parseFloat(f.principal)||0, destProp);
      if (c) {
        setBlockMsg(c==='date'
          ? "Cannot place here — this property was acquired after this loan started. The loan would have been uncollateralized during that period."
          : "Cannot place here — not enough funding gap on this property (including 10% contingency). Consider splitting this loan or choosing a property with a larger funding need.");
        sf(p=>({...p,destination:"unassigned"}));
        return;
      }
    }
    const loanType = currentLoanType;
    const newLender = (lenderSel === "_new_" && lenderName)
      ? {id: uid(), name: lenderName, loanType: newType}
      : null;
    onSave({...f, lenderName, loanType, newLender});
  };

  // Duplicate unassigned funds from the same lender, same start date, same rate/terms —
  // only offered while editing an existing unassigned fund.
  const mergeCandidates = (onMerge && init?.id && f.destination === "unassigned")
    ? unassigned.filter(u =>
        u.id !== init.id && !u.endDate &&
        u.lenderName === (activeLender ? activeLender.name : (lenderSel === "_new_" ? newName.trim() : "")) &&
        u.loanType === currentLoanType &&
        u.startDate === f.startDate &&
        (u.interestType || "percentage") === (f.interestType || "percentage") &&
        String(u.interestRate || "") === String(f.interestRate || "") &&
        (u.paymentType || "closing") === (f.paymentType || "closing")
      )
    : [];

  const handleMerge = candidate => {
    const lenderName = activeLender ? activeLender.name : (lenderSel === "_new_" ? newName.trim() : "");
    if (!lenderName) { alert("Please select or enter a lender."); return; }
    if (!window.confirm(`Merge this ${$$(parseFloat(f.principal)||0)} fund with the ${$$(candidate.principal)} fund started ${candidate.startDate}? This can't be undone.`)) return;
    const loanType = currentLoanType;
    const newLender = (lenderSel === "_new_" && lenderName)
      ? {id: uid(), name: lenderName, loanType: newType}
      : null;
    onMerge({...f, lenderName, loanType, newLender}, candidate.id);
  };

  // Property picker: categorise based on entered amount + startDate
  const loanAmt = parseFloat(f.principal) || 0;
  const canShowConflicts = loanAmt > 0 && !!f.startDate;
  const available=[], blockedSize=[], blockedDate=[];
  if (canShowConflicts) {
    for (const p of activeProps) {
      const c = propConflict(f.startDate, loanAmt, p);
      if (!c) available.push(p);
      else if (c==='size') blockedSize.push(p);
      else blockedDate.push(p);
    }
    // Most available (biggest funding gap) first, so the best fits surface at the top.
    available.sort((a,b)=>propGap(b)-propGap(a));
    blockedSize.sort((a,b)=>propGap(b)-propGap(a));
    blockedDate.sort((a,b)=>propGap(b)-propGap(a));
  }

  // Changing amount/date can invalidate an already-picked property — drop it.
  const setAndRevalidate = k => v => sf(p=>{
    const next = {...p,[k]:v};
    const amt = parseFloat(next.principal)||0;
    if (next.destination && next.destination!=="unassigned" && amt>0 && next.startDate) {
      const dp = activeProps.find(x=>x.id===next.destination);
      if (dp && propConflict(next.startDate, amt, dp)) next.destination = "unassigned";
    }
    return next;
  });

  const handleDestClick = pid => {
    if (!canShowConflicts) { s("destination")(pid); return; }
    const p = activeProps.find(x=>x.id===pid);
    if (!p) { s("destination")(pid); return; }
    const c = propConflict(f.startDate, loanAmt, p);
    if (c==='date') { setBlockMsg("Cannot place here — this property was acquired after this loan started. The loan would have been uncollateralized during that period."); return; }
    if (c==='size') { setBlockMsg("Cannot place here — not enough funding gap on this property (including 10% contingency). Consider splitting this loan or choosing a property with a larger funding need."); return; }
    setBlockMsg("");
    s("destination")(pid);
  };

  return (
    <div>
      {/* Lender */}
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">
          Lender <span className="text-red-400">*</span>
        </label>
        <select value={lenderSel} onChange={e=>setLenderSel(e.target.value)}
          className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all appearance-none">
          <option value="">— Select a lender —</option>
          {lenders.map(l=>(
            <option key={l.id} value={l.id}>{l.name} ({l.loanType==="hard"?"Hard Money":"Private Money"})</option>
          ))}
          <option value="_new_">➕ Add New Lender</option>
        </select>
      </div>
      {lenderSel==="_new_"&&(
        <div className="mb-3 p-3.5 rounded-xl bg-blue-50/50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/40 space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-widest text-blue-500 dark:text-blue-400 mb-2">New Lender Info</div>
          <Inp label="Lender Name *" value={newName} onChange={setNewName} placeholder="Mike Dixon"/>
          <Sel label="Lender Type *" value={newType} onChange={setNewType} options={[
            ["private","Private Money — individual lender"],
            ["hard","Hard Money — institutional / company lender"],
          ]}/>
        </div>
      )}
      {activeLender&&(
        <div className="mb-3 flex items-center gap-2 px-1">
          <TypeBadge type={activeLender.loanType}/>
          <span className="text-xs text-slate-400 dark:text-zinc-500">
            {activeLender.loanType==="hard"?"Hard Money Lender":"Private Money Lender"}
          </span>
        </div>
      )}

      {/* Amount + Dates */}
      <div className="border-t border-slate-100 dark:border-zinc-800 pt-3 mt-1">
        <Inp label="Amount ($) *" type="number" value={f.principal} onChange={v=>{setAndRevalidate("principal")(v);setBlockMsg("");}} placeholder="100000"/>
        <DateInp label="Start Date *" value={f.startDate} onChange={v=>{setAndRevalidate("startDate")(v);setBlockMsg("");}}/>
        <DateInp label="End / Payoff Date" value={f.endDate} onChange={s("endDate")} helpText="Leave blank while the loan is active"/>
        <DateInp label="Due Date (optional)" value={f.dueDate} onChange={s("dueDate")} helpText="Only if this loan has a fixed maturity — leave blank if it's just paid off whenever the property sells."/>
      </div>

      {mergeCandidates.length>0&&(
        <div className="mb-3 p-3.5 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
          <div className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-1">🔗 Possible Duplicate{mergeCandidates.length>1?"s":""} Found</div>
          <div className="text-[11px] text-amber-700/80 dark:text-amber-400/80 mb-2">Same lender, start date, and rate — sitting unassigned. Merge into one loan?</div>
          <div className="space-y-1.5">
            {mergeCandidates.map(c=>(
              <div key={c.id} className="flex items-center justify-between gap-2 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2">
                <span className="text-xs text-slate-700 dark:text-zinc-200 tabular-nums">{$$(c.principal)} · started {c.startDate}</span>
                <button type="button" onClick={()=>handleMerge(c)}
                  className="text-[11px] font-bold text-amber-700 dark:text-amber-300 hover:underline shrink-0">Merge →</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Where does this money go? */}
      <div className="mt-3 mb-1">
        <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-2">
          Where Does This Money Go?
        </label>
        {blockMsg&&<div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 mb-2">{blockMsg}</div>}
        {/* Unassigned option */}
        <button type="button" onClick={()=>{setBlockMsg("");s("destination")("unassigned");}}
          className={`w-full text-left px-3 py-2.5 rounded-xl mb-1.5 border transition-all ${f.destination==="unassigned"?"bg-violet-50 dark:bg-violet-900/20 border-violet-400 dark:border-violet-600":"bg-slate-50 dark:bg-zinc-800 border-slate-200 dark:border-zinc-700 hover:bg-violet-50/40 dark:hover:bg-violet-900/10 hover:border-violet-300 dark:hover:border-violet-700"}`}>
          <span className={`font-medium text-[13px] ${f.destination==="unassigned"?"text-violet-700 dark:text-violet-300":"text-slate-700 dark:text-zinc-300"}`}>💼 Unassigned — not yet placed on a property</span>
        </button>
        {!canShowConflicts&&activeProps.length>0&&(
          <div className="text-[11px] text-slate-400 dark:text-zinc-500 italic px-1 mb-2">Enter amount and start date above to see property availability.</div>
        )}
        {canShowConflicts&&(
          <div className="space-y-3">
            {available.length>0&&(
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1.5">Available</div>
                <div className="space-y-1.5">
                  {available.map(p=>(
                    <button key={p.id} type="button" onClick={()=>handleDestClick(p.id)}
                      className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all flex items-center justify-between gap-2 ${f.destination===p.id?"bg-emerald-50 dark:bg-emerald-900/20 border-emerald-400 dark:border-emerald-600":"bg-slate-50 dark:bg-zinc-800 border-slate-200 dark:border-zinc-700 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:border-blue-300 dark:hover:border-blue-700"}`}>
                      <span className={`font-medium text-[13px] truncate ${f.destination===p.id?"text-emerald-700 dark:text-emerald-300":"text-slate-800 dark:text-zinc-200"}`}>🏠 {p.address}</span>
                      <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$(propGap(p))} avail</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {blockedSize.length>0&&(
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-amber-500 dark:text-amber-400 mb-1.5">No Funding Gap — Consider Splitting</div>
                <div className="space-y-1.5">
                  {blockedSize.map(p=>(
                    <button key={p.id} type="button" disabled
                      className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-50 cursor-not-allowed pointer-events-none flex items-center justify-between gap-2">
                      <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500 truncate">📐 {p.address}</span>
                      <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$(propGap(p))} avail</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {blockedDate.length>0&&(
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1.5">Timing Conflict — Cannot Place</div>
                <div className="space-y-1.5">
                  {blockedDate.map(p=>(
                    <button key={p.id} type="button" disabled
                      className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-50 cursor-not-allowed pointer-events-none flex items-center justify-between gap-2">
                      <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500 truncate">🕐 {p.address}</span>
                      <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$(propGap(p))} avail</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {available.length===0&&blockedSize.length===0&&blockedDate.length===0&&(
              <div className="text-[11px] text-slate-400 dark:text-zinc-500 italic px-1">No active properties. Add one first.</div>
            )}
          </div>
        )}
        {!canShowConflicts&&activeProps.length>0&&(
          <div className="space-y-1.5">
            {[...activeProps].sort((a,b)=>propGap(b)-propGap(a)).map(p=>(
              <button key={p.id} type="button" onClick={()=>handleDestClick(p.id)}
                className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all flex items-center justify-between gap-2 ${f.destination===p.id?"bg-emerald-50 dark:bg-emerald-900/20 border-emerald-400 dark:border-emerald-600":"bg-slate-50 dark:bg-zinc-800 border-slate-200 dark:border-zinc-700 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:border-blue-300 dark:hover:border-blue-700"}`}>
                <span className={`font-medium text-[13px] truncate ${f.destination===p.id?"text-emerald-700 dark:text-emerald-300":"text-slate-800 dark:text-zinc-200"}`}>🏠 {p.address}</span>
                <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$(propGap(p))} avail</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Loan terms */}
      <div className="border-t border-slate-100 dark:border-zinc-800 pt-3 mt-3">
        <Sel label="Interest Type *" value={f.interestType||"percentage"} onChange={s("interestType")} options={[
          ["percentage","% Rate — accrues daily (e.g. 10%/yr)"],
          ["fixed","Fixed Amount — flat dollar return (e.g. lend $100k, get back $105k)"],
        ]}/>
        {isFixed
          ? <Inp label="Fixed Interest Amount ($) *" type="number" value={f.interestRate} onChange={s("interestRate")} placeholder="5000" helpText="Total interest they receive — e.g. lend $100k, get back $105k → enter 5000."/>
          : <Inp label="Annual Interest Rate (%) *" type="number" value={f.interestRate} onChange={s("interestRate")} placeholder="10" helpText="Enter 0 for no interest."/>
        }
        <Sel label="How Is Interest Paid? *" value={f.paymentType||"closing"} onChange={s("paymentType")} options={[
          ["closing",       "Pay at Closing — all interest owed when deal closes"],
          ["monthly_rate",  "Monthly Interest-Only — pay rate monthly, principal at closing"],
          ["monthly_fixed", "Monthly Fixed Amount — set dollar amount each month"],
        ]}/>
        {f.paymentType==="monthly_fixed"&&(
          <Inp label="Monthly Payment Amount ($) *" type="number" value={f.monthlyPayment} onChange={s("monthlyPayment")} placeholder="500" helpText="Fixed dollar amount lender receives each month"/>
        )}
        <Inp label="Special Terms (optional)" value={f.specialTerms} onChange={s("specialTerms")} placeholder="Balloon, prepayment penalty, etc."/>
      </div>
      {currentLoanType==="hard"&&(
        <div className="mt-2 mb-4 p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800">
          <label className="flex items-center gap-3 cursor-pointer mb-1">
            <input type="checkbox" checked={!!f.drawFacility}
              onChange={e=>sf(p=>({...p,drawFacility:e.target.checked?{committed:"",draws:[]}:null}))}
              className="w-4 h-4 rounded border-slate-300 dark:border-zinc-600 accent-blue-600 cursor-pointer"/>
            <div>
              <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Rehab Draw Facility</div>
              <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">Lender committed rehab funding, drawn in stages</div>
            </div>
          </label>
          {f.drawFacility&&(
            <div className="mt-3 space-y-3">
              <Inp label="Total Committed ($)" type="number" value={String(f.drawFacility.committed||"")}
                onChange={v=>sf(p=>({...p,drawFacility:{...p.drawFacility,committed:v}}))} placeholder="100000"/>
              {(f.drawFacility.draws||[]).length>0&&(
                <div>
                  <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Draws Taken</div>
                  {f.drawFacility.draws.map(d=>(
                    <div key={d.id} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-200 dark:border-zinc-700 last:border-0">
                      <span className="text-slate-600 dark:text-zinc-300 tabular-nums">{d.date} · {$$(d.amount)}</span>
                      <button type="button" onClick={()=>sf(p=>({...p,drawFacility:{...p.drawFacility,draws:p.drawFacility.draws.filter(x=>x.id!==d.id)}}))}
                        className="text-red-400 hover:text-red-600 text-xs p-1 transition-colors">✕</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="pt-1 border-t border-slate-200 dark:border-zinc-700">
                <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Add Draw</div>
                <DateInp label="Draw Date" value={drawDate} onChange={setDrawDate}/>
                <Inp label="Amount ($)" type="number" value={drawAmt} onChange={setDrawAmt} placeholder="25000"/>
                <Btn onClick={addDraw} sm color="navy" full>+ Record Draw</Btn>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <Btn onClick={handleSave} color={f.destination==="unassigned"?"purple":"green"} full>
          {f.destination==="unassigned" ? "💼  Save as Unassigned" : "🏠  Place on Property"}
        </Btn>
        <Btn onClick={onClose} color="ghost">Cancel</Btn>
      </div>
    </div>
  );
}

// ─── Place on Property Modal ──────────────────────────────────────────────────
const propAcquiredDate = p => p.purchaseDate || (p.loans.map(l=>l.startDate).filter(Boolean).sort()[0]) || null;
const loanPropConflict = (loanStartDate, prop) => {
  const pd = propAcquiredDate(prop);
  if (!pd || !loanStartDate || loanStartDate >= pd) return 0;
  return daysBetween(loanStartDate, pd);
};
// Funding gap remaining on a property — how much more it can still take
const propGap = prop => {
  const active = prop.loans.filter(l=>!l.endDate);
  const needed = propNeeded(prop, active);
  const funded = active.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);
  return Math.max(0, needed - funded);
};
const propSizeConflict = (loanAmount, prop) => {
  const needed = propNeeded(prop, prop.loans.filter(l=>!l.endDate));
  if (needed <= 0) return false;
  return loanAmount > propGap(prop) + needed * 0.10; // allow 10% of total needed over the gap
};
// Returns 'date' | 'size' | null — date takes priority if both apply
const propConflict = (loanStartDate, loanAmount, prop) => {
  if (loanPropConflict(loanStartDate, prop) > 0) return 'date';
  if (propSizeConflict(loanAmount, prop)) return 'size';
  return null;
};

function PlaceOnPropertyModal({ fund, properties, onPlace, onClose }) {
  const activeProps = properties.filter(p=>!p.dateSold);
  const loanAmt = fund.principal||fund.amount||0;
  const [blockMsg, setBlockMsg] = useState('');

  if (!activeProps.length) return (
    <Modal title="Place on Property" onClose={onClose}>
      <p className="text-sm text-slate-500 dark:text-zinc-400 mb-4">No active properties. Add one first.</p>
      <Btn onClick={onClose} color="ghost" full>Close</Btn>
    </Modal>
  );

  const available=[], blockedDate=[], blockedSize=[];
  for (const p of activeProps) {
    const c=propConflict(fund.startDate,loanAmt,p);
    if (!c) available.push(p);
    else if (c==='date') blockedDate.push(p);
    else blockedSize.push(p);
  }

  const handleClick = p => {
    const c=propConflict(fund.startDate,loanAmt,p);
    if (c==='date') { setBlockMsg("Cannot place here — this property was acquired after this loan started. The loan would have been uncollateralized during that period. Please pick a property that started before this loan."); return; }
    if (c==='size') { setBlockMsg("Cannot place here — not enough funding gap on this property (including 10% contingency). Consider splitting this loan or choosing a property with a larger funding need."); return; }
    onPlace(p.id);
  };

  return (
    <Modal title={`Place ${fund.lenderName}'s Money`} onClose={onClose}>
      <div className="mb-4 p-4 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-100 dark:border-zinc-700">
        <div className="font-bold text-slate-900 dark:text-zinc-100">{fund.lenderName}</div>
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$(loanAmt)} · {fmtRate(fund)} · <TypeLabel type={fund.loanType}/></div>
      </div>
      {blockMsg&&<div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 mb-3">{blockMsg}</div>}
      <div className="space-y-4">
        {available.length>0&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">Available</div>
            <div className="space-y-1.5">
              {available.map(p=>(
                <button key={p.id} onClick={()=>{setBlockMsg('');handleClick(p);}}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 border border-slate-200 dark:border-zinc-700 hover:border-blue-300 dark:hover:border-blue-700 transition-all">
                  <span className="font-medium text-[13px] text-slate-800 dark:text-zinc-200">🏠 {p.address}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {blockedSize.length>0&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">No Funding Gap — Consider Splitting</div>
            <div className="space-y-1.5">
              {blockedSize.map(p=>(
                <button key={p.id} disabled
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-40 cursor-not-allowed">
                  <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500">📐 {p.address}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {blockedDate.length>0&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">Timing Conflict — Cannot Place</div>
            <div className="space-y-1.5">
              {blockedDate.map(p=>(
                <button key={p.id} disabled
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-40 cursor-not-allowed">
                  <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500">🕐 {p.address}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="pt-3"><Btn onClick={onClose} color="ghost" full>Cancel</Btn></div>
    </Modal>
  );
}

// ─── Move Modal ───────────────────────────────────────────────────────────────
function MoveModal({ item, properties, onMove, onClose }) {
  const activeProps = properties.filter(p=>!p.dateSold);
  const lenderName = item.type==="loan" ? item.loan.lenderName : item.fund.lenderName;
  const amount = item.type==="loan" ? item.loan.principal : item.fund.principal;
  const loanStartDate = item.type==="loan" ? item.loan.startDate : item.fund?.startDate;
  const currentLoc = item.type==="loan" ? (properties.find(p=>p.id===item.propId)?.address||"a property") : "Unassigned";
  const [blockMsg, setBlockMsg] = useState('');

  const candidateProps = activeProps.filter(p=>item.type!=="loan"||p.id!==item.propId);

  const available=[], blockedDate=[], blockedSize=[];
  for (const p of candidateProps) {
    const c=propConflict(loanStartDate,amount,p);
    if (!c) available.push(p);
    else if (c==='date') blockedDate.push(p);
    else blockedSize.push(p);
  }

  const hasViableDestination = available.length > 0 || blockedSize.length > 0 || blockedDate.length > 0;
  const showUnassigned = item.type==="loan" && hasViableDestination;

  if (!hasViableDestination && !showUnassigned) return (
    <Modal title="Move Lender Money" onClose={onClose}>
      <div className="mb-4 p-4 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-100 dark:border-zinc-700">
        <div className="font-bold text-slate-900 dark:text-zinc-100">{lenderName}</div>
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$(amount)} · on <span className="font-medium">{currentLoc}</span></div>
      </div>
      <p className="text-sm text-slate-500 dark:text-zinc-400 mb-4">No valid destination — all other properties have a timing conflict with this loan's start date.</p>
      <Btn onClick={onClose} color="ghost" full>Close</Btn>
    </Modal>
  );

  const handleClick = id => {
    if (id==='unassigned') { onMove('unassigned'); return; }
    const p=properties.find(x=>x.id===id);
    const c=propConflict(loanStartDate,amount,p);
    if (c==='size') { setBlockMsg("Cannot move here — not enough funding gap on this property (including 10% contingency). Consider splitting this loan or choosing a property with a larger funding need."); return; }
    onMove(id);
  };

  return (
    <Modal title="Move Lender Money" onClose={onClose}>
      <div className="mb-4 p-4 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-100 dark:border-zinc-700">
        <div className="font-bold text-slate-900 dark:text-zinc-100">{lenderName}</div>
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$(amount)} · on <span className="font-medium">{currentLoc}</span></div>
      </div>
      {blockMsg&&<div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 mb-3">{blockMsg}</div>}
      <div className="space-y-4">
        {showUnassigned&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">Remove from Property</div>
            <button onClick={()=>handleClick('unassigned')}
              className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 border border-slate-200 dark:border-zinc-700 hover:border-blue-300 dark:hover:border-blue-700 transition-all">
              <span className="font-medium text-[13px] text-slate-800 dark:text-zinc-200">💼 Move to Unassigned</span>
            </button>
          </div>
        )}
        {available.length>0&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">Available Properties</div>
            <div className="space-y-1.5">
              {available.map(p=>(
                <button key={p.id} onClick={()=>{setBlockMsg('');handleClick(p.id);}}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 border border-slate-200 dark:border-zinc-700 hover:border-blue-300 dark:hover:border-blue-700 transition-all">
                  <span className="font-medium text-[13px] text-slate-800 dark:text-zinc-200">🏠 {p.address}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {blockedSize.length>0&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">No Funding Gap — Consider Splitting</div>
            <div className="space-y-1.5">
              {blockedSize.map(p=>(
                <button key={p.id} disabled
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-40 cursor-not-allowed">
                  <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500">📐 {p.address}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {blockedDate.length>0&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">Timing Conflict — Cannot Move</div>
            <div className="space-y-1.5">
              {blockedDate.map(p=>(
                <button key={p.id} disabled
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-40 cursor-not-allowed">
                  <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500">🕐 {p.address}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="pt-3"><Btn onClick={onClose} color="ghost" full>Cancel</Btn></div>
    </Modal>
  );
}

// ─── Quick Draw Modal ─────────────────────────────────────────────────────────
function QuickDrawModal({ data, onSave, onClose }) {
  const drawLoans = (data.properties||[]).filter(p=>!p.dateSold).flatMap(prop=>
    (prop.loans||[]).filter(l=>!l.endDate&&l.drawFacility).map(l=>({
      ...l, propId:prop.id, propAddress:prop.address, remaining:drawRemaining(l),
    }))
  );
  const [selId,setSelId]=useState(drawLoans[0]?.id??'');
  const [date,setDate]=useState(TODAY);
  const [amount,setAmount]=useState('');

  const sel=drawLoans.find(l=>l.id===selId);
  const maxDraw=sel?.remaining??0;
  const totalCommitted=sel?.drawFacility?.committed??0;
  const totalDrawn=(sel?.drawFacility?.draws||[]).reduce((s,d)=>s+(d.amount||0),0);
  const amt=parseFloat(amount)||0;
  const valid=sel&&amt>0&&amt<=maxDraw&&date;

  if(drawLoans.length===0) return(
    <Modal title="Record Draw" onClose={onClose}>
      <p className="text-sm text-slate-500 dark:text-zinc-400 py-4 text-center">No active draw facilities found. Add a draw facility to a loan first.</p>
      <Btn onClick={onClose} color="ghost" full>Close</Btn>
    </Modal>
  );

  return(
    <Modal title="Record Draw" onClose={onClose}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest">Select Draw Facility</label>
          <select value={selId} onChange={e=>setSelId(e.target.value)}
            className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
            {drawLoans.map(l=>(
              <option key={l.id} value={l.id}>{l.propAddress} — {l.lenderName} (${Math.round(l.remaining).toLocaleString()} avail)</option>
            ))}
          </select>
        </div>

        {sel&&(
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-slate-50 dark:bg-zinc-800 p-3 text-center">
              <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold mb-1">Committed</div>
              <div className="text-sm font-bold text-slate-800 dark:text-zinc-100 tabular-nums">{$$(totalCommitted)}</div>
            </div>
            <div className="rounded-xl bg-slate-50 dark:bg-zinc-800 p-3 text-center">
              <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold mb-1">Drawn</div>
              <div className="text-sm font-bold text-amber-600 dark:text-amber-400 tabular-nums">{$$(totalDrawn)}</div>
            </div>
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-900/20 p-3 text-center">
              <div className="text-[10px] text-emerald-600 dark:text-emerald-400 uppercase font-semibold mb-1">Available</div>
              <div className="text-sm font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">{$$(maxDraw)}</div>
            </div>
          </div>
        )}

        <DateInp label="Draw Date" value={date} onChange={setDate}/>
        <Inp label="Draw Amount" type="number" value={amount} onChange={setAmount} placeholder="0"/>

        {amt>maxDraw&&maxDraw>0&&(
          <p className="text-xs text-red-500 dark:text-red-400">Amount exceeds available balance of {$$(maxDraw)}</p>
        )}

        <div className="flex gap-2 pt-1">
          <Btn onClick={()=>valid&&onSave({propId:sel.propId,loanId:sel.id,date,amount:amt})} color={valid?"green":"ghost"} full>Record Draw →</Btn>
          <Btn onClick={onClose} color="ghost">Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}

// ─── Split Loan Modal ─────────────────────────────────────────────────────────
function SplitLoanModal({ fund, properties, onConfirm, onClose }) {
  const loan = fund;
  const activeProps = properties.filter(p => !p.dateSold);
  const [splits, setSplits] = useState([
    { propId: activeProps[0]?.id ?? "", amount: "" },
    { propId: activeProps[1]?.id ?? "", amount: "" },
  ]);
  const addRow = () => setSplits(s=>[...s,{propId:"",amount:""}]);
  const removeRow = i => setSplits(s=>s.filter((_,j)=>j!==i));
  const setRow = (i,field,val) => setSplits(s=>s.map((r,j)=>j===i?{...r,[field]:val}:r));

  const totalSplit = splits.reduce((s,r)=>s+(parseFloat(r.amount)||0),0);
  const remaining = (loan.principal||loan.amount||0) - totalSplit;
  const valid = splits.every(r=>r.propId&&parseFloat(r.amount)>0) && Math.abs(remaining)<0.01;

  const availableProps = activeProps.filter(p=>loanPropConflict(loan.startDate,p)===0);
  const blockedProps = activeProps.filter(p=>loanPropConflict(loan.startDate,p)>0);
  return (
    <Modal title={`Split Funds — ${loan.lenderName}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="p-3 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-sm space-y-1">
          <div className="flex justify-between"><span className="text-slate-500 dark:text-zinc-400">Total available</span><span className="tabular-nums font-semibold text-slate-900 dark:text-zinc-100">{$$(loan.principal||loan.amount||0)}</span></div>
          <div className="flex justify-between"><span className="text-slate-500 dark:text-zinc-400">Rate / Terms</span><span className="text-slate-700 dark:text-zinc-200">{loan.interestRate||0}{loan.interestType==="fixed"?" (fixed fee)":"%"} · {loan.paymentType||"closing"}</span></div>
        </div>

        <div className="space-y-3">
          <div className="text-xs font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-wider">Split Into</div>
          {splits.map((row,i)=>{
            const rowAmt=parseFloat(row.amount)||0;
            const destProp=row.propId&&row.propId!=="unassigned"?activeProps.find(p=>p.id===row.propId):null;
            let gapInfo=null;
            if(destProp){
              const active=destProp.loans.filter(l=>!l.endDate);
              const needed=propNeeded(destProp,active);
              const funded=active.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);
              const shortage=Math.max(0,needed-funded);
              const afterSplit=Math.max(0,shortage-rowAmt);
              if(needed>0) gapInfo={shortage,afterSplit};
            }
            return(
              <div key={i} className="space-y-1.5">
                <div className="flex gap-2 items-center">
                  <div className="w-32 shrink-0">
                    <input type="number" placeholder="Amount $" value={row.amount} onChange={e=>setRow(i,"amount",e.target.value)}
                      className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-2 py-1.5 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500 tabular-nums"/>
                  </div>
                  <div className="flex-1">
                    <select value={row.propId} onChange={e=>setRow(i,"propId",e.target.value)}
                      className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-2 py-1.5 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="">— pick destination —</option>
                      <option value="unassigned">💼 Leave unassigned</option>
                      {availableProps.map(p=><option key={p.id} value={p.id}>🏠 {p.address}</option>)}
                      {blockedProps.length>0&&<optgroup label="— Not Available (Loan predates property) —">
                        {blockedProps.map(p=><option key={p.id} value={p.id} disabled>🕐 {p.address}</option>)}
                      </optgroup>}
                    </select>
                  </div>
                  {splits.length>1&&<button onClick={()=>removeRow(i)} className="text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 text-base transition-colors shrink-0">✕</button>}
                </div>
                {gapInfo&&(
                  <div className="ml-[136px] flex items-center gap-2 text-[10px]">
                    <span className="text-slate-400 dark:text-zinc-500">Equity gap: <span className="font-semibold text-amber-600 dark:text-amber-400">{$$(gapInfo.shortage)}</span></span>
                    {rowAmt>0&&<span className="text-slate-300 dark:text-zinc-600">→</span>}
                    {rowAmt>0&&<span className={gapInfo.afterSplit<=0?"text-emerald-600 dark:text-emerald-400 font-semibold":"text-slate-500 dark:text-zinc-400"}>
                      {gapInfo.afterSplit<=0?"Fully covered":""+$$(gapInfo.afterSplit)+" remaining"}
                    </span>}
                  </div>
                )}
              </div>
            );
          })}
          <button onClick={addRow} className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-semibold">+ Add destination</button>
        </div>

        <div className={`flex justify-between text-sm font-semibold border-t border-slate-200 dark:border-zinc-700 pt-3 ${Math.abs(remaining)<0.01?"text-emerald-600 dark:text-emerald-400":remaining<0?"text-red-500 dark:text-red-400":"text-amber-600 dark:text-amber-400"}`}>
          <span>Unallocated</span>
          <span className="tabular-nums">{$$(remaining)} {Math.abs(remaining)<0.01?"✓":remaining<0?"(over!)":""}</span>
        </div>

        {!valid&&<p className="text-xs text-slate-400 dark:text-zinc-500">All rows need a property and amount, and amounts must sum to {$$(loan.principal||0)}.</p>}

        <div className="flex gap-2 pt-1">
          <Btn onClick={()=>valid&&onConfirm(splits.map(r=>({propId:r.propId,amount:parseFloat(r.amount)})))} color={valid?"blue":"ghost"} full>Split Funds →</Btn>
          <Btn onClick={onClose} color="ghost">Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}

// ─── Place / Split Modal ──────────────────────────────────────────────────────
function PlaceSplitModal({ loan, currentPropId=null, properties, onConfirm, onClose }) {
  const activeProps = properties.filter(p=>!p.dateSold);
  const candidateProps = currentPropId ? activeProps.filter(p=>p.id!==currentPropId) : activeProps;
  const loanAmt = loan.principal||loan.amount||0;
  const [mode, setMode] = useState("place");
  const [blockMsg, setBlockMsg] = useState("");
  const [openPicker, setOpenPicker] = useState(null);

  const available=[], blockedDate=[], blockedSize=[];
  for (const p of candidateProps) {
    const c=propConflict(loan.startDate,loanAmt,p);
    if(!c) available.push(p);
    else if(c==='date') blockedDate.push(p);
    else blockedSize.push(p);
  }
  // Most available (biggest funding gap) first, so the best fits surface at the top.
  available.sort((a,b)=>propGap(b)-propGap(a));
  blockedSize.sort((a,b)=>propGap(b)-propGap(a));
  blockedDate.sort((a,b)=>propGap(b)-propGap(a));
  const hasViableDest = available.length>0||blockedSize.length>0||blockedDate.length>0;
  const showUnassigned = currentPropId!==null && (available.length>0||blockedSize.length>0);

  const [splits,setSplits] = useState([
    {propId:"",amount:""},
    {propId:"",amount:""},
  ]);
  const addRow=()=>setSplits(s=>[...s,{propId:"",amount:""}]);
  const removeRow=i=>setSplits(s=>s.filter((_,j)=>j!==i));
  const setRow=(i,field,val)=>setSplits(s=>s.map((r,j)=>j===i?{...r,[field]:val}:r));
  const totalSplit=splits.reduce((s,r)=>s+(parseFloat(r.amount)||0),0);
  const remaining=loanAmt-totalSplit;
  const rowConflict=r=>{
    if(!r.propId||r.propId==="unassigned") return null;
    const p=activeProps.find(x=>x.id===r.propId);
    return p?propConflict(loan.startDate,parseFloat(r.amount)||0,p):null;
  };
  const splitValid=splits.every(r=>r.propId&&parseFloat(r.amount)>0&&!rowConflict(r))&&Math.abs(remaining)<0.01;

  if(!hasViableDest&&!showUnassigned) return (
    <Modal title={`${currentPropId?"Move":"Place"} — ${loan.lenderName}`} onClose={onClose}>
      <div className="mb-4 p-4 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-100 dark:border-zinc-700">
        <div className="font-bold text-slate-900 dark:text-zinc-100">{loan.lenderName}</div>
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$(loanAmt)} · {fmtRate(loan)}</div>
      </div>
      <p className="text-sm text-slate-500 dark:text-zinc-400 mb-4">No valid destination — all other properties have a timing conflict with this loan's start date.</p>
      <Btn onClick={onClose} color="ghost" full>Close</Btn>
    </Modal>
  );

  const handlePlace=propId=>{
    if(propId!=="unassigned"){
      const p=activeProps.find(x=>x.id===propId);
      const c=propConflict(loan.startDate,loanAmt,p);
      if(c==='size'){setBlockMsg("Cannot place here — not enough funding gap. Switch to ⚡ Split to divide this loan across properties.");return;}
    }
    setBlockMsg("");
    onConfirm({type:propId==="unassigned"?"unassigned":"place",propId});
  };

  const title=`${currentPropId?"Move":"Place"} — ${loan.lenderName}`;
  return (
    <Modal title={title} onClose={onClose}>
      <div className="mb-4 p-4 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-100 dark:border-zinc-700">
        <div className="font-bold text-slate-900 dark:text-zinc-100">{loan.lenderName}</div>
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$(loanAmt)} · {fmtRate(loan)} · <TypeLabel type={loan.loanType}/></div>
      </div>
      <div className="flex gap-1 mb-4 bg-slate-100 dark:bg-zinc-800 p-1 rounded-xl">
        <button type="button" onClick={()=>{setMode("place");setBlockMsg("");}}
          className={`flex-1 text-xs font-semibold py-1.5 rounded-lg transition-all ${mode==="place"?"bg-white dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-300"}`}>
          🏠 Place All
        </button>
        <button type="button" onClick={()=>{setMode("split");setBlockMsg("");}}
          className={`flex-1 text-xs font-semibold py-1.5 rounded-lg transition-all ${mode==="split"?"bg-white dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-300"}`}>
          ⚡ Split
        </button>
      </div>
      {mode==="place"&&(
        <div className="space-y-3">
          {blockMsg&&<div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">{blockMsg}</div>}
          {showUnassigned&&(
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1.5">Remove from Property</div>
              <button type="button" onClick={()=>handlePlace("unassigned")}
                className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-violet-50 dark:hover:bg-violet-900/20 border border-slate-200 dark:border-zinc-700 hover:border-violet-300 dark:hover:border-violet-700 transition-all">
                <span className="font-medium text-[13px] text-slate-800 dark:text-zinc-200">💼 Move to Unassigned</span>
              </button>
            </div>
          )}
          {available.length>0&&(
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1.5">Available Properties</div>
              <div className="space-y-1.5">
                {available.map(p=>(
                  <button key={p.id} type="button" onClick={()=>{setBlockMsg("");handlePlace(p.id);}}
                    className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 border border-slate-200 dark:border-zinc-700 hover:border-blue-300 dark:hover:border-blue-700 transition-all flex items-center justify-between gap-2">
                    <span className="font-medium text-[13px] text-slate-800 dark:text-zinc-200 truncate">🏠 {p.address}</span>
                    <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$(propGap(p))} avail</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {blockedSize.length>0&&(
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-amber-500 dark:text-amber-400 mb-1.5">No Funding Gap — Consider Splitting</div>
              <div className="space-y-1.5">
                {blockedSize.map(p=>(
                  <button key={p.id} type="button" disabled
                    className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-40 cursor-not-allowed flex items-center justify-between gap-2">
                    <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500 truncate">📐 {p.address}</span>
                    <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$(propGap(p))} avail</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {blockedDate.length>0&&(
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1.5">Timing Conflict — Cannot Place</div>
              <div className="space-y-1.5">
                {blockedDate.map(p=>(
                  <button key={p.id} type="button" disabled
                    className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-40 cursor-not-allowed flex items-center justify-between gap-2">
                    <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500 truncate">🕐 {p.address}</span>
                    <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$(propGap(p))} avail</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="pt-1"><Btn onClick={onClose} color="ghost" full>Cancel</Btn></div>
        </div>
      )}
      {mode==="split"&&(
        <div className="space-y-4">
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-sm">
            <div className="flex justify-between"><span className="text-slate-500 dark:text-zinc-400">Total to split</span><span className="tabular-nums font-semibold text-slate-900 dark:text-zinc-100">{$$(loanAmt)}</span></div>
          </div>
          {openPicker!==null&&<div className="fixed inset-0 z-40" onClick={()=>setOpenPicker(null)}/>}
          <div className="space-y-3">
            <div className="text-xs font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-wider">Split Into</div>
            {splits.map((row,i)=>{
              const rowAmt=parseFloat(row.amount)||0;
              const hasAmt=row.amount!==""&&rowAmt>0;
              const destProp=row.propId&&row.propId!=="unassigned"?activeProps.find(p=>p.id===row.propId):null;
              // Pickable properties first (most available first), grayed-out ones pushed below.
              const propOptions=candidateProps
                .map(p=>({prop:p,c:propConflict(loan.startDate,rowAmt,p)}))
                .sort((a,b)=>{
                  const aBlocked=a.c!==null, bBlocked=b.c!==null;
                  if(aBlocked!==bBlocked) return aBlocked?1:-1;
                  return propGap(b.prop)-propGap(a.prop);
                });
              const pickerLabel=row.propId===""?(hasAmt?"— pick destination —":"Enter amount first"):row.propId==="unassigned"?"💼 Leave unassigned":(()=>{const p=activeProps.find(x=>x.id===row.propId);const c=propConflict(loan.startDate,rowAmt,p);return`${c==="date"?"🕐":c==="size"?"📐":"🏠"} ${p?.address||"?"}`;})();
              return(
                <div key={i} className="space-y-1.5">
                  <div className="flex gap-2 items-center">
                    <div className="w-32 shrink-0">
                      <input type="number" placeholder="$ Amount" value={row.amount}
                        onChange={e=>{
                          const val=e.target.value;
                          const newAmt=parseFloat(val)||0;
                          let newPropId=row.propId;
                          if(row.propId&&row.propId!=="unassigned"){
                            const p=activeProps.find(x=>x.id===row.propId);
                            if(p&&propConflict(loan.startDate,newAmt,p)!==null) newPropId="";
                          }
                          setSplits(s=>s.map((r,j)=>j===i?{...r,amount:val,propId:newPropId}:r));
                        }}
                        className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-2 py-1.5 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500 tabular-nums"/>
                    </div>
                    <div className="flex-1 relative">
                      <button type="button" disabled={!hasAmt} onClick={()=>setOpenPicker(openPicker===i?null:i)}
                        className={`w-full text-left px-2 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs flex items-center justify-between gap-1 ${!hasAmt?"opacity-40 cursor-not-allowed text-slate-400 dark:text-zinc-500":"text-slate-800 dark:text-zinc-100 hover:border-blue-400 dark:hover:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"}`}>
                        <span className="truncate">{pickerLabel}</span>
                        <span className="shrink-0 text-slate-400 dark:text-zinc-500">▾</span>
                      </button>
                      {openPicker===i&&(
                        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-slate-200 dark:border-zinc-700 overflow-hidden max-h-52 overflow-y-auto">
                          <button type="button" onClick={()=>{setRow(i,"propId","unassigned");setOpenPicker(null);}}
                            className="w-full text-left px-3 py-2.5 text-xs font-medium text-slate-800 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 border-b border-slate-100 dark:border-zinc-700 transition-colors">
                            💼 Leave unassigned
                          </button>
                          {propOptions.map(({prop,c})=>{
                            const disabled=c!==null;
                            const emoji=c==="date"?"🕐":c==="size"?"📐":"🏠";
                            const suffix=c==="date"?" — timing conflict":"";
                            return(
                              <button key={prop.id} type="button" disabled={disabled}
                                onClick={()=>{setRow(i,"propId",prop.id);setOpenPicker(null);}}
                                className={`w-full text-left px-3 py-2.5 text-xs font-medium transition-colors flex items-center justify-between gap-2 ${disabled?"opacity-40 cursor-not-allowed pointer-events-none text-slate-500 dark:text-zinc-500":"text-slate-800 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700"}`}>
                                <span className="truncate">{emoji} {prop.address}{suffix}</span>
                                <span className="text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$(propGap(prop))} avail</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {splits.length>1&&<button type="button" onClick={()=>removeRow(i)} className="text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 text-base transition-colors shrink-0">✕</button>}
                  </div>
                </div>
              );
            })}
            <button type="button" onClick={addRow} className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-semibold">+ Add destination</button>
          </div>
          <div className={`flex justify-between text-sm font-semibold border-t border-slate-200 dark:border-zinc-700 pt-3 ${Math.abs(remaining)<0.01?"text-emerald-600 dark:text-emerald-400":remaining<0?"text-red-500 dark:text-red-400":"text-amber-600 dark:text-amber-400"}`}>
            <span>Unallocated</span>
            <span className="tabular-nums">{$$(remaining)} {Math.abs(remaining)<0.01?"✓":remaining<0?"(over!)":""}</span>
          </div>
          {!splitValid&&<p className="text-xs text-slate-400 dark:text-zinc-500 mt-1">{splits.some(r=>rowConflict(r))?"A destination has a conflict — reduce that amount or pick another property.":`All rows need a destination and amount, and must sum to ${$$(loanAmt)}.`}</p>}
          <div className="flex gap-2 pt-1">
            <Btn onClick={()=>onConfirm({type:"split",splits:splits.map(r=>({propId:r.propId,amount:parseFloat(r.amount)}))})} color={splitValid?"blue":"ghost"} full disabled={!splitValid}>Split Funds →</Btn>
            <Btn onClick={onClose} color="ghost">Cancel</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Close Loan Modal ─────────────────────────────────────────────────────────
function CloseLoanModal({ loan, onConfirm, onClose }) {
  const [closeDate, setCloseDate] = useState(TODAY);
  const payoff = Math.round(calcBalance(loan, closeDate) * 100) / 100;
  const intEarned = Math.round(calcIntEarned(loan, closeDate) * 100) / 100;
  const inputCls = "flex-1 border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500";
  return (
    <Modal title={`Close Loan — ${loan.lenderName}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="w-32 text-sm text-slate-600 dark:text-zinc-300 shrink-0">Close Date</span>
          <input type="date" value={closeDate} onChange={e=>setCloseDate(e.target.value)} className={inputCls}/>
        </div>
        <div className="rounded-xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-zinc-700 p-4 space-y-2 text-sm">
          <div className="flex justify-between text-slate-600 dark:text-zinc-300">
            <span>Principal</span>
            <span className="tabular-nums font-medium">{$$p(loan.principal)}</span>
          </div>
          {intEarned > 0 && (
            <div className="flex justify-between text-slate-600 dark:text-zinc-300">
              <span>Accrued Interest</span>
              <span className="tabular-nums font-medium text-emerald-600 dark:text-emerald-400">+{$$p(intEarned)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold text-slate-900 dark:text-zinc-100 border-t border-slate-200 dark:border-zinc-700 pt-2">
            <span>Total Payoff</span>
            <span className="tabular-nums">{$$p(payoff)}</span>
          </div>
          {intEarned > 0 && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 pt-1">
              Use <span className="font-semibold">{$$p(payoff)}</span> as the new loan principal when you re-add this lender's funds.
            </p>
          )}
        </div>
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 text-sm font-semibold text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors">Cancel</button>
          <button type="button" onClick={()=>onConfirm(closeDate)}
            className="flex-1 py-2.5 rounded-xl bg-orange-500 hover:bg-orange-600 text-white text-sm font-bold transition-colors">
            Close Loan as of {closeDate}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Mark Property Sold Modal ─────────────────────────────────────────────────
function MarkSoldModal({ prop, allProperties, onConfirm, onClose }) {
  const activeLoans=prop.loans.filter(l=>!l.endDate);
  const preClosedLoans=prop.loans.filter(l=>!!l.endDate);
  const otherProps=allProperties.filter(p=>!p.dateSold&&p.id!==prop.id);
  const [step,setStep]=useState(1);
  const [soldDate,setSoldDate]=useState(TODAY);
  const [isRental,setIsRental]=useState(false);

  // Per-lender rows — includes principal/interest/fees breakdown
  const [rows,setRows]=useState(()=>[
    ...activeLoans.map(l=>{
      const monthly=(l.paymentType||"closing")!=="closing";
      const calcP=Math.round(calcBalance(l,soldDate)*100)/100; // cent precision
      // calcInterest: interest owed AT CLOSING (0 for monthly since it was paid during hold)
      const calcI=monthly?0:Math.round((calcP-(l.principal||0))*100)/100;
      // intEarned: total interest earned on this loan (paid monthly OR accrued to closing)
      const intEarned=calcIntEarned(l,soldDate); // already cent-precise
      return {
        loanId:l.id,lenderName:l.lenderName,loanType:l.loanType,
        principal:l.principal||0,calcPayoff:calcP,calcInterest:calcI,
        isMonthly:monthly,isPreClosed:false,
        interestRate:l.interestRate||0,interestType:l.interestType||"percentage",
        paymentType:l.paymentType||"closing",specialTerms:l.specialTerms||"",
        principalPayoff:String(l.principal||0),
        interestPayoff:String(intEarned),
        lenderFees:"0",overageRefund:"0",titleMoneyCosts:"0",paidAtTitle:false,
        customRolling:String(l.principal||0),
        origStartDate:l.startDate||soldDate,
        type:"paidOut",destination:otherProps[0]?.id||"unassigned",newStartDate:nextDay(soldDate),
      };
    }),
    // Loans closed early: principal already returned, but interest is still a cost of this deal
    ...preClosedLoans.map(l=>({
      loanId:l.id,lenderName:l.lenderName,loanType:l.loanType,
      principal:l.principal||0,isPreClosed:true,isMonthly:false,
      calcPayoff:0,calcInterest:0,
      interestRate:l.interestRate||0,interestType:l.interestType||"percentage",
      paymentType:l.paymentType||"closing",specialTerms:l.specialTerms||"",
      principalPayoff:"0", // already returned to lender
      interestPayoff:String(Math.round(calcIntEarned(l,l.endDate)*100)/100), // editable in case actual amount differed
      lenderFees:"0",overageRefund:"0",titleMoneyCosts:"0",paidAtTitle:false,
      customRolling:"0",origStartDate:l.startDate||"",
      type:"alreadyPaid",destination:"",newStartDate:"",
    })),
  ]);
  const upd=(id,patch)=>setRows(rs=>rs.map(r=>r.loanId===id?{...r,...patch}:r));

  // When soldDate changes: recalculate interest to that date; reset newStartDate to day after
  useEffect(()=>{
    const startDate=nextDay(soldDate);
    setRows(rs=>rs.map(r=>{
      const l=activeLoans.find(loan=>loan.id===r.loanId);
      if(!l) return r;
      const monthly=(l.paymentType||"closing")!=="closing";
      const calcP=Math.round(calcBalance(l,soldDate)*100)/100;
      const calcI=monthly?0:Math.round((calcP-(l.principal||0))*100)/100;
      const intEarned=calcIntEarned(l,soldDate);
      // waiveInterest: interest not paid, so original start date carries forward (don't reset)
      const newSD=r.type==="waiveInterest"?r.origStartDate:startDate;
      return {...r,calcPayoff:calcP,calcInterest:calcI,interestPayoff:String(intEarned),newStartDate:newSD};
    }));
  },[soldDate]);

  // How much each lender is paid FROM the wire (0 if paid at title)
  // Rolling lenders' principals flow through the wire (Nexus receives then reinvests them)
  const wireContrib=r=>{
    if(r.type==="alreadyPaid") return 0; // paid out before closing; principal & interest already settled
    if(r.paidAtTitle) return 0;
    const fees=parseFloat(r.lenderFees)||0;
    if(r.type==="paidOut"){
      const intFromWire=r.isMonthly?0:(parseFloat(r.interestPayoff)||0);
      return (parseFloat(r.principalPayoff)||0)+intFromWire+fees;
    }
    if(r.type==="rollFull") return r.calcPayoff+fees; // full balance flows through wire, reinvested
    if(r.type==="rollPrincipal") return r.principal+fees; // principal flows through; Nexus keeps interest
    if(r.type==="waiveInterest") return r.principal+fees; // principal flows through; interest forgiven
    if(r.type==="payInterest") return (parseFloat(r.interestPayoff)||0)+fees; // interest from wire; principal stays on loan
    if(r.type==="custom") return Math.max(0,r.calcPayoff-(parseFloat(r.customRolling)||0))+fees;
    return 0;
  };
  // Total paid at title (gross — includes overage title actually sent to lender)
  const titleTotal=rows.reduce((s,r)=>{
    if(!r.paidAtTitle) return s;
    const principal=parseFloat(r.principalPayoff)||0;
    const fees=parseFloat(r.lenderFees)||0;
    const overage=parseFloat(r.overageRefund)||0;
    // monthly+paidAtTitle: titleMoneyCosts covers interest+fees title sent; rest was paid monthly
    if(r.isMonthly) return s+principal+(parseFloat(r.titleMoneyCosts)||0)+fees+overage;
    return s+principal+(parseFloat(r.interestPayoff)||0)+fees+overage;
  },0);

  const lenderTotal=rows.reduce((s,r)=>s+wireContrib(r),0);

  // Step 2 cost fields
  const [cashToCloseIn,setCashToCloseIn]=useState(String(prop.purchasePrice||""));
  const [rehabIn,setRehabIn]=useState(String(prop.rehabBudget||""));
  const [miscIn,setMiscIn]=useState(String(Math.round((prop.monthlyHolding??500)*effectiveMonths(prop))));
  const [wireIn,setWireIn]=useState("");

  const cashToClose=parseFloat(cashToCloseIn)||0;
  const rehab=parseFloat(rehabIn)||0;
  // Money Costs = interest + lender fees for all applicable types
  // rollPrincipal: Nexus keeps interest (income), but fees are still a cost
  // waiveInterest: interest forgiven, but fees still apply
  const moneyCosts=Math.round(rows.reduce((s,r)=>{
    const fees=parseFloat(r.lenderFees)||0;
    const interest=parseFloat(r.interestPayoff)||0;
    if(r.type==="rollPrincipal"||r.type==="waiveInterest") return s+fees;
    if(r.isMonthly||r.type==="paidOut"||r.type==="payInterest"||r.type==="rollFull"||r.type==="alreadyPaid") return s+interest+fees;
    return s+fees; // custom: fees still cost, interest not
  },0)*100)/100;
  const baseCosts=cashToClose+rehab+moneyCosts;
  const wire=parseFloat(wireIn)||0;
  const misc=parseFloat(miscIn)||0;
  const totalCosts=baseCosts+misc;
  // wire + titleTotal = totalCosts + dealProfit  (user's double-sided equation)
  // nexusCapital = what Nexus recovers from wire after paying lenders (totalCosts - titleTotal - lenderTotal)
  const overageRefund=Math.round(rows.reduce((s,r)=>s+(parseFloat(r.overageRefund)||0),0)*100)/100;
  const nexusCapital=totalCosts-titleTotal-lenderTotal;
  const dealProfit=(wire+titleTotal)-totalCosts+overageRefund;
  const balanced=wire>0&&nexusCapital>=-0.01;

  const handleWireChange=v=>setWireIn(v);
  const handleMiscChange=v=>setMiscIn(v);

  const handleConfirm=()=>{
    const dispositions={};
    rows.forEach(r=>{
      dispositions[r.loanId]={
        type:r.type,
        principalPayoff:parseFloat(r.principalPayoff)||0,
        interestPayoff:parseFloat(r.interestPayoff)||0,
        lenderFees:parseFloat(r.lenderFees)||0,
        overageRefund:parseFloat(r.overageRefund)||0,
        wireAmount:wireContrib(r),
        customRolling:r.customRolling,
        destination:r.destination,
        newStartDate:r.newStartDate||soldDate,
        newRate:String(r.interestRate),
        interestType:r.interestType,
        paymentType:r.paymentType,
        specialTerms:r.specialTerms,
      };
    });
    onConfirm(soldDate,dispositions,{
      wire,cashToClose,rehab,moneyCosts,misc,totalCosts,
      overageRefund,
      profit:dealProfit,selfFunded:nexusCapital,
      titleTotal,
      lenderPayoffs:rows.map(r=>({
        loanId:r.loanId,lenderName:r.lenderName,type:r.type,
        paidAtTitle:r.paidAtTitle||false,
        principalPayoff:parseFloat(r.principalPayoff)||0,
        interestPayoff:parseFloat(r.interestPayoff)||0,
        lenderFees:parseFloat(r.lenderFees)||0,
        wireAmount:wireContrib(r),
        totalPayoff:(parseFloat(r.principalPayoff)||0)+(parseFloat(r.interestPayoff)||0)+(parseFloat(r.lenderFees)||0),
      })),
    }, isRental);
  };

  const inputCls="flex-1 border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-right text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums";
  const autoCls="flex-1 border border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/50 rounded-lg px-3 py-2 text-sm text-right text-slate-400 dark:text-zinc-500 tabular-nums select-none";
  const labelCls="w-40 text-sm text-slate-600 dark:text-zinc-300 shrink-0 leading-tight";
  const numIn="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums text-slate-800 dark:text-zinc-100";
  const autoNum="w-full border border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/50 rounded-lg px-3 py-2 text-sm text-right text-slate-400 dark:text-zinc-500 tabular-nums select-none";

  return (
    <Modal title={`Close: ${prop.address}`} onClose={onClose}>
      <div>

        {/* Step tabs */}
        <div className="flex gap-2 mb-5">
          {[["1 · Settle Lenders",1],["2 · Wire & Costs",2]].map(([label,s])=>(
            <button key={s} type="button" onClick={()=>s<step?setStep(s):undefined}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${s===step?"bg-blue-600 text-white":s<step?"bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 cursor-pointer":"bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-500 cursor-not-allowed"}`}>
              {label}
            </button>
          ))}
        </div>

        {/* ── Step 1: Settle Lenders ── */}
        {step===1&&(
          <div className="space-y-4">
            <DateInp label="Date Sold" value={soldDate} onChange={setSoldDate}/>

            <div>
              <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-3">Settle Lenders</div>
              {activeLoans.length===0&&(
                <p className="text-sm text-slate-400 dark:text-zinc-500 text-center py-4">No active loans on this property.</p>
              )}
              <div className="space-y-3">
                {rows.filter(r=>!r.isPreClosed).map(r=>{
                  const isRolling=["rollFull","rollPrincipal","payInterest","waiveInterest","custom"].includes(r.type);
                  const autoWireForCustom=Math.max(0,r.calcPayoff-(parseFloat(r.customRolling)||0));
                  const totalFromWire=wireContrib(r);
                  return (
                    <div key={r.loanId} className="rounded-xl border border-slate-200 dark:border-zinc-700 p-4 bg-white dark:bg-zinc-900">
                      {/* Header */}
                      <div className="flex items-start gap-2 mb-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="font-bold text-slate-900 dark:text-zinc-100 truncate">{r.lenderName}</span>
                            <TypeLabel type={r.loanType}/>
                          </div>
                          {/* Paid at title toggle */}
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <div onClick={()=>upd(r.loanId,{paidAtTitle:!r.paidAtTitle})}
                              className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${r.paidAtTitle?"bg-amber-500":"bg-slate-200 dark:bg-zinc-600"}`}>
                              <div className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${r.paidAtTitle?"translate-x-4":""}`}/>
                            </div>
                            <span className={`text-[10px] font-semibold ${r.paidAtTitle?"text-amber-600 dark:text-amber-400":"text-slate-400 dark:text-zinc-500"}`}>
                              {r.paidAtTitle?"Paid at title (not from wire)":"Paid from wire"}
                            </span>
                          </label>
                        </div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 tabular-nums text-right leading-tight shrink-0">
                          <div>Principal: {$$p(r.principal)}</div>
                          {r.calcInterest>0&&<div>Accrued Int: {$$p(r.calcInterest)}</div>}
                          <div className="font-semibold text-slate-600 dark:text-zinc-300">Payoff: {$$p(r.calcPayoff)}</div>
                        </div>
                      </div>

                      {/* Disposition dropdown */}
                      <div className="mb-3">
                        <label className="block text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-1.5">Disposition</label>
                        <select value={r.type}
                          onChange={e=>{
                            const t=e.target.value;
                            const patch={type:t};
                            if(t==="paidOut") patch.principalPayoff=String(r.principal);
                            if(t==="payInterest") patch.interestPayoff=String(r.calcInterest);
                            if(t==="custom") patch.customRolling=String(r.principal);
                            // waiveInterest: keep original start date so accrued interest isn't lost
                            if(t==="waiveInterest") patch.newStartDate=r.origStartDate;
                            // switching away from waiveInterest: reset to day after sold
                            else if(r.type==="waiveInterest") patch.newStartDate=nextDay(soldDate);
                            upd(r.loanId,patch);
                          }}
                          className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                          <option value="paidOut">💰 Paid Out — {$$p(r.calcPayoff)} leaves Nexus</option>
                          <option value="rollFull">🔄 Roll Full {$$p(r.calcPayoff)} to next deal</option>
                          {r.calcInterest>0.01&&<>
                            <option value="rollPrincipal">🔄 Roll {$$p(r.principal)}, Nexus keeps {$$p(r.calcInterest)}</option>
                            <option value="payInterest">💸 Pay {$$p(r.calcInterest)} interest, roll {$$p(r.principal)}</option>
                          </>}
                          <option value="waiveInterest">⚡ Waive interest, roll {$$p(r.principal)}</option>
                          <option value="custom">✏️ Custom split</option>
                        </select>
                      </div>

                      {/* paidOut: full principal / interest / fees breakdown */}
                      {r.type==="paidOut"&&(
                        <div className="space-y-2 mb-3 p-3 bg-slate-50 dark:bg-zinc-800/40 rounded-lg">
                          <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Payoff Breakdown</div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Principal</div>
                              <input type="number" value={r.principalPayoff} onChange={e=>upd(r.loanId,{principalPayoff:e.target.value})} onWheel={e=>e.target.blur()} className={numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">
                                {r.isMonthly?"Total Interest (full period)":"Interest"}
                              </div>
                              <input type="number" value={r.interestPayoff} onChange={e=>upd(r.loanId,{interestPayoff:e.target.value})} onWheel={e=>e.target.blur()}
                                className={r.isMonthly?"w-full border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-amber-400 tabular-nums text-amber-700 dark:text-amber-400":numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Lender Fees</div>
                              <input type="number" value={r.lenderFees} onChange={e=>upd(r.loanId,{lenderFees:e.target.value})} onWheel={e=>e.target.blur()} className={numIn}/>
                            </div>
                          </div>
                          {r.isMonthly&&!r.paidAtTitle&&<p className="text-[10px] text-amber-600 dark:text-amber-400">Total interest over hold period — not deducted from closing wire</p>}
                          {r.isMonthly&&r.paidAtTitle&&(
                            <div className="mt-2 pt-2 border-t border-amber-200 dark:border-amber-800/40 space-y-2">
                              <div className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-widest">Of that interest, split:</div>
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <div className="text-[10px] text-amber-600 dark:text-amber-400 mb-1">Prorated interest from title</div>
                                  <input type="number" value={r.titleMoneyCosts} onChange={e=>upd(r.loanId,{titleMoneyCosts:e.target.value})} onWheel={e=>e.target.blur()} className={numIn}/>
                                </div>
                                <div>
                                  <div className="text-[10px] text-amber-600 dark:text-amber-400 mb-1">Already paid monthly</div>
                                  <div className={autoNum}>{$$p(Math.max(0,(parseFloat(r.interestPayoff)||0)-(parseFloat(r.titleMoneyCosts)||0)))}</div>
                                </div>
                              </div>
                            </div>
                          )}
                          <div className="flex items-center justify-between pt-1">
                            <span className="text-[10px] font-semibold text-slate-500 dark:text-zinc-400">Total from wire</span>
                            <span className="text-sm font-bold tabular-nums text-slate-800 dark:text-zinc-100">{$$p(totalFromWire)}</span>
                          </div>
                        </div>
                      )}

                      {/* payInterest: interest + fees from wire, principal rolls */}
                      {r.type==="payInterest"&&(
                        <div className="space-y-2 mb-3 p-3 bg-slate-50 dark:bg-zinc-800/40 rounded-lg">
                          <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Interest Payment from Wire</div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Interest</div>
                              <input type="number" value={r.interestPayoff} onChange={e=>upd(r.loanId,{interestPayoff:e.target.value})} onWheel={e=>e.target.blur()} className={numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Lender Fees</div>
                              <input type="number" value={r.lenderFees} onChange={e=>upd(r.loanId,{lenderFees:e.target.value})} onWheel={e=>e.target.blur()} className={numIn}/>
                            </div>
                          </div>
                          <div className="text-[10px] text-slate-400 dark:text-zinc-500">Principal {$$p(r.principal)} rolls to next deal</div>
                        </div>
                      )}

                      {/* Custom split */}
                      {r.type==="custom"&&(
                        <div className="space-y-2 mb-3 p-3 bg-slate-50 dark:bg-zinc-800/40 rounded-lg">
                          <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Custom Split</div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Amount Rolling</div>
                              <input type="number" value={r.customRolling} onChange={e=>upd(r.loanId,{customRolling:e.target.value})} onWheel={e=>e.target.blur()} className={numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">From Wire</div>
                              <div className={autoNum}>{$$p(autoWireForCustom)}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Lender Fees</div>
                              <input type="number" value={r.lenderFees} onChange={e=>upd(r.loanId,{lenderFees:e.target.value})} onWheel={e=>e.target.blur()} className={numIn}/>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Rolling type: show wire amount and optional fees */}
                      {(r.type==="rollFull"||r.type==="rollPrincipal"||r.type==="waiveInterest")&&(
                        <div className="mb-3 p-3 bg-slate-50 dark:bg-zinc-800/40 rounded-lg space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Flows Through Wire</span>
                            <span className="text-sm font-bold tabular-nums text-slate-800 dark:text-zinc-100">
                              {$$p(r.type==="rollFull"?r.calcPayoff:r.principal)}
                              {r.type==="rollPrincipal"&&<span className="text-[10px] font-normal text-slate-400 dark:text-zinc-500 ml-1">(principal; Nexus keeps int)</span>}
                              {r.type==="waiveInterest"&&<span className="text-[10px] font-normal text-slate-400 dark:text-zinc-500 ml-1">(principal; interest forgiven)</span>}
                            </span>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Misc Fees from Wire (if any)</div>
                            <input type="number" value={r.lenderFees} onChange={e=>upd(r.loanId,{lenderFees:e.target.value})} onWheel={e=>e.target.blur()} placeholder="0" className={numIn}/>
                          </div>
                        </div>
                      )}

                      {/* Overage refund (post-close) */}
                      <div className="mt-3 pt-3 border-t border-slate-100 dark:border-zinc-800 flex items-center gap-3">
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 leading-tight">Overage Refund<br/><span className="text-[9px]">(post-close, from this lender)</span></div>
                        <input type="number" value={r.overageRefund} onChange={e=>upd(r.loanId,{overageRefund:e.target.value})} onWheel={e=>e.target.blur()} placeholder="0" className={numIn}/>
                      </div>

                      {/* Roll destination */}
                      {isRolling&&(
                        <div className="pt-3 border-t border-slate-100 dark:border-zinc-800 grid grid-cols-2 gap-2">
                          <div>
                            <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase mb-1">Roll To</div>
                            <select value={r.destination} onChange={e=>upd(r.loanId,{destination:e.target.value})}
                              className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-2 py-1.5 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500">
                              <option value="unassigned">💼 Unassigned</option>
                              {otherProps.map(p=><option key={p.id} value={p.id}>🏠 {p.address}</option>)}
                            </select>
                          </div>
                          <div>
                            <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase mb-1">New Start Date</div>
                            <input type="date" value={r.newStartDate} onChange={e=>upd(r.loanId,{newStartDate:e.target.value})}
                              className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-2 py-1.5 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"/>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Pre-closed loans — interest paid out early, still a cost of this deal */}
              {preClosedLoans.length>0&&(
                <div className="mt-4">
                  <div className="text-[10px] font-semibold text-orange-500 dark:text-orange-400 uppercase tracking-widest mb-2">Paid Out Early — interest charged to this deal</div>
                  <div className="space-y-2">
                    {rows.filter(r=>r.isPreClosed).map(r=>(
                      <div key={r.loanId} className="rounded-xl border border-orange-200 dark:border-orange-800/40 p-3 bg-orange-50/60 dark:bg-orange-900/10">
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <TypeLabel type={r.loanType}/>
                            <span className="font-semibold text-slate-800 dark:text-zinc-100 truncate">{r.lenderName}</span>
                            <span className="text-[10px] bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 font-semibold rounded px-1.5 py-0.5 shrink-0">paid early</span>
                          </div>
                          <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0">Principal {$$p(r.principal)} — already returned</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-[11px] text-slate-500 dark:text-zinc-400 shrink-0">Interest charged to deal:</span>
                          <input type="number" value={r.interestPayoff}
                            onChange={e=>upd(r.loanId,{interestPayoff:e.target.value})}
                            onWheel={e=>e.target.blur()}
                            className="flex-1 border border-orange-200 dark:border-orange-800/50 bg-white dark:bg-zinc-800 rounded-lg px-3 py-1.5 text-sm text-right text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-orange-400 tabular-nums"/>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Step 1 summary: lenders + estimated costs */}
            {(()=>{
              const estC2C=parseFloat(prop.purchasePrice)||0;
              const estRehab=parseFloat(prop.rehabBudget)||0;
              const estMoney=moneyCosts; // derived from step 1 interest fields
              const estMisc=Math.round((prop.monthlyHolding??500)*effectiveMonths(prop));
              const estCosts=estC2C+estRehab+estMoney+estMisc;
              const minWire=estCosts-titleTotal; // break-even: wire = totalCosts - titleTotal
              return (
                <div className="rounded-xl bg-slate-50 dark:bg-zinc-800/30 border border-slate-200 dark:border-zinc-700 px-4 py-4 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500 dark:text-zinc-400">Lenders (from wire)</span>
                    <span className="font-semibold tabular-nums text-slate-700 dark:text-zinc-200">{$$p(lenderTotal)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500 dark:text-zinc-400">Est. project costs</span>
                    <span className="font-semibold tabular-nums text-slate-700 dark:text-zinc-200">{$$p(estCosts)}</span>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-zinc-700">
                    <span className="text-sm font-bold text-slate-700 dark:text-zinc-200">Break-even wire</span>
                    <span className="font-bold text-base tabular-nums text-slate-900 dark:text-zinc-100">{$$p(minWire)}</span>
                  </div>
                </div>
              );
            })()}

            <div className="flex gap-2 pt-1">
              <Btn onClick={()=>setStep(2)} color="navy" full>Next: Wire &amp; Costs →</Btn>
              <Btn onClick={onClose} color="ghost">Cancel</Btn>
            </div>
          </div>
        )}

        {/* ── Step 2: Wire & Costs ── */}
        {step===2&&(
          <div className="space-y-5 pb-2">

            {/* Lender reference from step 1 */}
            <div className="rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-semibold text-blue-500 dark:text-blue-400 uppercase tracking-widest">Lender Settlements (Step 1)</div>
                <div className="text-right">
                  {titleTotal>0&&<div className="text-[10px] text-amber-600 dark:text-amber-400 tabular-nums">🏛 Title: {$$p(titleTotal)}</div>}
                  <div className="font-bold text-lg tabular-nums text-blue-700 dark:text-blue-300">Wire: {$$p(lenderTotal)}</div>
                </div>
              </div>
              <div className="text-[11px] text-blue-600 dark:text-blue-400 space-y-0.5">
                {rows.map(r=>{
                  let label;
                  if(r.paidAtTitle){
                    const principal=parseFloat(r.principalPayoff)||0;
                    const atTitleCosts=r.isMonthly?(parseFloat(r.titleMoneyCosts)||0)+(parseFloat(r.lenderFees)||0):(parseFloat(r.interestPayoff)||0)+(parseFloat(r.lenderFees)||0);
                    const overage=parseFloat(r.overageRefund)||0;
                    label=`${$$p(principal+atTitleCosts+overage)} at title 🏛${overage>0?` (incl. ${$$p(overage)} overage)`:""}`;
                  }
                  else if(r.type==="rollFull") label=`${$$p(wireContrib(r))} → rolls full`;
                  else if(r.type==="rollPrincipal") label=`${$$p(wireContrib(r))} → principal rolls`;
                  else if(r.type==="waiveInterest") label=`${$$p(wireContrib(r))} → rolls (int waived)`;
                  else if(r.type==="payInterest") label=`${$$p(wireContrib(r))} from wire + principal rolls`;
                  else label=$$p(wireContrib(r));
                  return (
                    <div key={r.loanId} className="flex justify-between gap-2">
                      <span>{r.lenderName}</span>
                      <span className="tabular-nums text-right">{label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Project Costs */}
            <div>
              <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-3">Project Costs</div>
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <span className={labelCls}>Cash to Close</span>
                  <input type="number" value={cashToCloseIn} onChange={e=>setCashToCloseIn(e.target.value)} onWheel={e=>e.target.blur()} className={inputCls}/>
                </div>
                <div className="flex items-center gap-3">
                  <span className={labelCls}>Rehab</span>
                  <input type="number" value={rehabIn} onChange={e=>setRehabIn(e.target.value)} onWheel={e=>e.target.blur()} className={inputCls}/>
                </div>
                <div className="flex items-center gap-3">
                  <span className={labelCls}>Money Costs <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-normal">(from step 1)</span></span>
                  <div className={autoCls} title="Auto-derived from lender interest in step 1">{$$p(moneyCosts)}</div>
                  <button type="button" onClick={()=>setStep(1)} className="shrink-0 text-[10px] font-semibold text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors whitespace-nowrap">edit ↑</button>
                </div>
                <div className="flex items-center gap-3">
                  <span className={labelCls}>Misc <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-normal">(utilities, insurance)</span></span>
                  <input type="number" value={miscIn} onChange={e=>handleMiscChange(e.target.value)} onWheel={e=>e.target.blur()} className={inputCls}/>
                </div>
                <div className="flex items-center gap-3 pt-2 border-t border-slate-200 dark:border-zinc-700">
                  <span className="w-40 text-sm font-bold text-slate-800 dark:text-zinc-100 shrink-0">Total Deployed</span>
                  <span className="flex-1 text-right font-bold text-slate-900 dark:text-zinc-100 tabular-nums">{$$p(totalCosts)}</span>
                </div>
              </div>
            </div>

            {/* Wire Received */}
            <div className="flex items-center gap-3">
              <span className="w-40 text-sm font-bold text-slate-800 dark:text-zinc-100 shrink-0">Wire Received</span>
              <input type="number" value={wireIn} onChange={e=>handleWireChange(e.target.value)} onWheel={e=>e.target.blur()} placeholder="0"
                  className="flex-1 border-2 border-blue-400 dark:border-blue-600 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-right font-bold text-blue-700 dark:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"/>
            </div>

            {/* Deal Profit — always visible */}
            {wire>0?(
              <div className={`rounded-xl p-4 ${dealProfit>=0?"bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900":"bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900"}`}>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-3">Profit Calculation</div>
                {/* Proceeds side */}
                <div className="space-y-1 mb-2">
                  <div className="flex justify-between text-sm text-slate-600 dark:text-zinc-300">
                    <span>Wire received</span>
                    <span className="tabular-nums font-medium">{$$p(wire)}</span>
                  </div>
                  {titleTotal>0&&(
                    <div className="flex justify-between text-sm text-slate-600 dark:text-zinc-300">
                      <span>+ Title paid to lenders</span>
                      <span className="tabular-nums font-medium">{$$p(titleTotal)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-semibold text-slate-700 dark:text-zinc-200 border-t border-slate-200 dark:border-zinc-700 pt-1">
                    <span>= Total proceeds</span>
                    <span className="tabular-nums">{$$p(wire+titleTotal)}</span>
                  </div>
                </div>
                {/* Costs side */}
                <div className="space-y-1 mb-2">
                  <div className="flex justify-between text-sm text-slate-600 dark:text-zinc-300">
                    <span>− Cash to close</span>
                    <span className="tabular-nums font-medium">{$$p(cashToClose)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-slate-600 dark:text-zinc-300">
                    <span>− Rehab</span>
                    <span className="tabular-nums font-medium">{$$p(rehab)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-slate-600 dark:text-zinc-300">
                    <span>− Money costs <span className="text-[10px] font-normal text-slate-400 dark:text-zinc-500">(interest + fees)</span></span>
                    <span className="tabular-nums font-medium">{$$p(moneyCosts)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-slate-600 dark:text-zinc-300">
                    <span>− Misc</span>
                    <span className="tabular-nums font-medium">{$$p(misc)}</span>
                  </div>
                  <div className="flex justify-between text-sm font-semibold text-slate-700 dark:text-zinc-200 border-t border-slate-200 dark:border-zinc-700 pt-1">
                    <span>= Total costs</span>
                    <span className="tabular-nums">{$$p(totalCosts)}</span>
                  </div>
                </div>
                {/* Overage refund added to profit */}
                {overageRefund>0&&(
                  <div className="flex justify-between text-sm text-emerald-600 dark:text-emerald-400 mb-1">
                    <span>+ Overage refund <span className="text-[10px] font-normal opacity-70">(post-close)</span></span>
                    <span className="tabular-nums font-medium">{$$p(overageRefund)}</span>
                  </div>
                )}
                {/* Result */}
                <div className="flex justify-between items-center border-t-2 border-slate-300 dark:border-zinc-600 pt-2 mt-1">
                  <span className="font-bold text-slate-800 dark:text-zinc-100">Deal Profit</span>
                  <span className={`text-2xl font-bold tabular-nums ${dealProfit>=0?"text-emerald-700 dark:text-emerald-400":"text-red-600 dark:text-red-400"}`}>{$$ps(dealProfit)}</span>
                </div>
              </div>
            ):(
              <div className="rounded-xl p-3 text-center bg-slate-50 dark:bg-zinc-800/30 border border-slate-200 dark:border-zinc-700">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Deal Profit</div>
                <div className="text-lg font-bold text-slate-400 dark:text-zinc-500">— Enter wire above —</div>
                <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-1">Break-even wire: {$$p(baseCosts-titleTotal)}</div>
              </div>
            )}

            {/* Nexus self-funding recovered = total costs deployed */}
            <div className="rounded-xl border-2 border-dashed border-slate-200 dark:border-zinc-700 p-4 bg-slate-50/50 dark:bg-zinc-800/20 flex items-center justify-between">
              <div>
                <span className="font-bold text-slate-800 dark:text-zinc-100">🏢 Nexus Self-Funding</span>
                <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5">Wire kept after paying lenders (costs − title − lenders)</div>
              </div>
              <span className="font-bold text-xl tabular-nums text-slate-800 dark:text-zinc-100">{$$p(nexusCapital)}</span>
            </div>

            {/* Reconciliation */}
            {wire>0&&(
              <div className={`rounded-xl px-4 py-3 border ${balanced?"bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800":"bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800"}`}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className={`font-bold text-sm shrink-0 ${balanced?"text-emerald-700 dark:text-emerald-300":"text-amber-700 dark:text-amber-300"}`}>{balanced?"✓ Balanced":"⚠ Check numbers"}</span>
                  <span className="text-slate-500 dark:text-zinc-400 tabular-nums text-[11px]">
                    {$$p(wire)}{titleTotal>0?` + Title ${$$p(titleTotal)}`:""}{overageRefund>0?` + Overage ${$$p(overageRefund)}`:""} = Lenders {$$p(lenderTotal)} + Costs {$$p(nexusCapital)} + Profit {$$ps(dealProfit)}
                  </span>
                </div>
              </div>
            )}

            {/* Rental toggle */}
            <div className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-zinc-700 px-4 py-3 bg-white dark:bg-zinc-900">
              <div>
                <div className="font-semibold text-sm text-slate-800 dark:text-zinc-100">Mark as Rental</div>
                <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5">Rentals are tracked separately in Closed Deals and excluded from flip stats</div>
              </div>
              <div onClick={()=>setIsRental(r=>!r)}
                className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer shrink-0 ml-4 ${isRental?"bg-purple-500":"bg-slate-200 dark:bg-zinc-600"}`}>
                <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${isRental?"translate-x-5":""}`}/>
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <Btn onClick={handleConfirm} color="navy" full>✓ Confirm &amp; Close Property</Btn>
              <Btn onClick={()=>setStep(1)} color="ghost">← Back</Btn>
              <Btn onClick={onClose} color="ghost">Cancel</Btn>
            </div>
          </div>
        )}

      </div>
    </Modal>
  );
}

// ─── Property Form ────────────────────────────────────────────────────────────
function PropertyForm({ init, onSave, onClose }) {
  const [f,sf]=useState(()=>({
    address:init?.address||"",
    purchasePrice:String(init?.purchasePrice||(!init?.rehabBudget&&init?.fundingNeeded?init.fundingNeeded:"")||""),
    rehabBudget:String(init?.rehabBudget||""),
    projectMonths:init?.projectMonths!=null?String(init.projectMonths):"",
    monthlyHolding:String(init?.monthlyHolding??500),
    purchaseDate:init?.purchaseDate||"",
  }));
  const s=k=>v=>sf(p=>({...p,[k]:v}));
  const rehab=parseFloat(f.rehabBudget)||0;
  const autoMonths=rehab?Math.ceil((rehab/1000+60)/30):2;
  const months=f.projectMonths!==""?Math.max(0.5,parseFloat(f.projectMonths)||2):autoMonths;
  const holding=parseFloat(f.monthlyHolding)||500;
  const purchase=parseFloat(f.purchasePrice)||0;
  const totalBase=purchase+rehab+holding*months;
  return (
    <div>
      <Inp label="Property Address" value={f.address} onChange={s("address")} placeholder="123 Oak Ave, Nashville, TN"/>
      <DateInp label="Purchase Date" value={f.purchaseDate} onChange={s("purchaseDate")} helpText="Reference only — does not affect calculations"/>
      <div className="grid grid-cols-2 gap-3">
        <Inp label="Cost to Buy ($)" type="number" value={f.purchasePrice} onChange={s("purchasePrice")} placeholder="150000"/>
        <Inp label="Rehab Budget ($)" type="number" value={f.rehabBudget} onChange={s("rehabBudget")} placeholder="50000"/>
      </div>
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5 flex items-center gap-2">
          Project Length (months)
          {f.projectMonths!==""&&parseFloat(f.projectMonths)!==autoMonths&&(
            <button type="button" onClick={()=>s("projectMonths")("")}
              className="text-blue-500 hover:text-blue-700 dark:text-blue-400 text-[10px] font-semibold transition-colors normal-case">
              ↺ Reset ({autoMonths} mo)
            </button>
          )}
        </label>
        <input type="number" step="0.5" min="0.5" onWheel={e=>e.target.blur()}
          value={f.projectMonths!==""?f.projectMonths:autoMonths}
          onChange={e=>s("projectMonths")(e.target.value)}
          className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"/>
        {rehab>0&&<p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-1.5">Formula: {Math.floor(rehab/1000)} rehab days + 60 listing days = {autoMonths} mo</p>}
      </div>
      <Inp label="Monthly Utilities & Insurance ($)" type="number" value={f.monthlyHolding} onChange={s("monthlyHolding")} helpText="Pre-filled at $500/mo — covers utilities, insurance, etc."/>
      {totalBase>0&&(
        <div className="mb-4 p-4 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-200 dark:border-zinc-700 text-xs space-y-1">
          <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Estimated Capital Need</div>
          {[["Cost to Buy",purchase],["Rehab",rehab],[`Holding (${months} mo × $${holding}/mo)`,holding*months]].filter(([,v])=>v>0).map(([l,v])=>(
            <div key={l} className="flex justify-between text-slate-600 dark:text-zinc-300"><span>{l}</span><span className="tabular-nums">{$$(v)}</span></div>
          ))}
          <div className="flex justify-between font-bold text-slate-900 dark:text-zinc-100 border-t border-slate-200 dark:border-zinc-700 pt-2 mt-1">
            <span>Base Total</span><span className="tabular-nums">{$$(totalBase)}</span>
          </div>
          <p className="text-[10px] text-slate-400 dark:text-zinc-500 pt-1">+ monthly interest × {months} mo added once loans are entered</p>
        </div>
      )}
      <div className="flex gap-2 pt-2">
        <Btn onClick={()=>onSave(f)} full>Save Property</Btn>
        <Btn onClick={onClose} color="ghost">Cancel</Btn>
      </div>
    </div>
  );
}

// ─── Shared page toolbar components ───────────────────────────────────────────
const SEARCH_CLS = "ml-auto w-52 px-3 py-1.5 rounded-xl text-xs bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 shrink-0";

function SortDropdown({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = e => { if(ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const label = options.find(([v]) => v === value)?.[1] ?? value;
  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen(o=>!o)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-all border border-slate-200 dark:border-zinc-700">
        <span>Sort: {label}</span>
        <span className="text-slate-400 dark:text-zinc-500">{open?"▲":"▼"}</span>
      </button>
      {open&&(
        <div className="absolute left-0 top-9 w-44 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-30 py-1">
          {options.map(([v,l])=>(
            <button key={v} onClick={()=>{onChange(v);setOpen(false);}}
              className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${value===v?"bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-semibold":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700"}`}>
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Collapsible Unassigned Funds ─────────────────────────────────────────────
function CollapsibleUnassigned({ funds, total, onPlace, onEdit, onDelete }) {
  const prv=usePrivacy();
  const openPanel=usePanel();
  const h$=v=>prv?maskMoney($$(v)):$$(v);
  const hr=l=>{if(!prv)return fmtRate(l);const s=fmtRate(l);return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s);};
  const [open,setOpen]=useState(false);
  const sorted=[...funds].sort((a,b)=>(a.startDate||"").localeCompare(b.startDate||""));

  return (
    <div className="mb-3 rounded-2xl overflow-hidden bg-white dark:bg-[#1C1C1E] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
      <button onClick={()=>setOpen(o=>!o)}
        className="w-full px-5 py-3.5 flex items-center justify-between transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center text-sm">💼</div>
          <span className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Ready to Place</span>
          <span className="text-sm font-bold text-violet-600 dark:text-violet-400 tabular-nums">{h$(total)}</span>
          <span className="text-xs text-slate-400 dark:text-zinc-500">{funds.length} lender{funds.length!==1?"s":""}</span>
        </div>
        <span className="text-slate-300 dark:text-zinc-600 text-xs font-semibold">{open?"▲":"▼"}</span>
      </button>
      {open && (
        <div className="border-t border-black/[0.06] dark:border-white/[0.06] divide-y divide-black/[0.05] dark:divide-white/[0.05]">
          {sorted.map(u=>{
            const principal=u.principal||u.amount||0;
            const bal=calcBalance({...u,principal});
            const earned=bal-principal;
            const days=daysBetween(u.startDate,TODAY);
            return (
              <div key={u.id} className="px-5 py-3.5 flex items-center justify-between gap-2 bg-white dark:bg-[#1C1C1E] hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                  <button onClick={()=>openPanel({type:'loan',loanId:u.id,propId:null})} className="font-semibold text-slate-900 dark:text-zinc-100 text-sm hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left">{u.lenderName}</button>
                  <span className="font-bold text-violet-700 dark:text-violet-300 text-sm tabular-nums">{h$(principal)}</span>
                  {(u.interestRate!=null)&&<span className="text-xs text-slate-400 dark:text-zinc-500">{hr(u)}</span>}
                  {earned>0.01&&<span className="text-xs text-emerald-600 dark:text-emerald-400 tabular-nums">+{h$(earned)}</span>}
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${days>60?"bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800":days>30?"bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800":"bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border-slate-200 dark:border-zinc-700"}`}>
                    {days}d
                  </span>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={()=>onPlace(u)} className="text-[11px] font-bold text-white bg-violet-600 hover:bg-violet-700 rounded-lg px-2.5 py-1 transition-colors">Place →</button>
                  <button onClick={()=>onEdit(u)}  className="p-1.5 text-slate-300 dark:text-zinc-600 hover:text-blue-500 dark:hover:text-blue-400 text-sm transition-colors">✏️</button>
                  <button onClick={()=>onDelete(u.id)} className="p-1.5 text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 text-sm transition-colors">🗑</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const loanFields = f => ({
  lenderName:f.lenderName, loanType:f.loanType, principal:parseFloat(f.principal)||0,
  startDate:f.startDate, interestRate:parseFloat(f.interestRate)||0,
  interestType:f.interestType||"percentage",
  paymentType:f.paymentType||"closing",
  monthlyPayment:parseFloat(f.monthlyPayment)||0,
  drawFacility:f.drawFacility?{committed:parseFloat(f.drawFacility.committed)||0,draws:f.drawFacility.draws||[]}:null,
  specialTerms:f.specialTerms||"", endDate:f.endDate||null,
  dueDate:f.dueDate||null,
});
// When a loan is split across destinations, a FIXED-dollar interest term (a flat total
// fee, or a flat monthly payment) has to be prorated by each piece's share of the
// original principal — otherwise every piece would carry the full fixed amount,
// multiplying the real interest owed by however many ways it's split.
const splitPiece = (fund, amount) => {
  const origPrincipal = fund.principal || 0;
  const share = origPrincipal > 0 ? amount / origPrincipal : 0;
  const interestRate = fund.interestType==="fixed"
    ? Math.round((fund.interestRate||0) * share * 100) / 100
    : fund.interestRate;
  const monthlyPayment = fund.paymentType==="monthly_fixed"
    ? Math.round((fund.monthlyPayment||0) * share * 100) / 100
    : fund.monthlyPayment;
  return {...fund, id:uid(), principal:amount, interestRate, monthlyPayment, drawFacility:null};
};
const upsertLender = (d, newLender) => {
  if (!newLender) return d;
  return {...d, lenders:[...(d.lenders||[]).filter(x=>x.name!==newLender.name), newLender]};
};

// ─── Properties Page ──────────────────────────────────────────────────────────
function PropertiesPage({ data, update, pendingAction, onClearPendingAction }) {
  const prv=usePrivacy();
  const openPanel=usePanel();
  const h$=v=>prv?maskMoney($$(v)):$$(v);
  const hc=v=>prv?maskMoney($$c(v)):$$c(v);
  const hn=n=>n??"";
  const hr=l=>{if(!prv)return fmtRate(l);const s=fmtRate(l);return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s);};
  const [modal,setModal]=useState(null);
  const [expanded,setExpanded]=useState({});
  const [showSold,setShowSold]=useState(false);
  const [viewMode,setViewMode]=usePersistedState("nx-propViewMode","expanded");
  const [propSort,setPropSort]=usePersistedState("nx-propSort",{col:null,dir:"asc"});
  const [propSearch,setPropSearch]=useState("");
  const [propSortMode,setPropSortMode]=usePersistedState("nx-propSortMode","shortage");
  const [propSortDir,setPropSortDir]=usePersistedState("nx-propSortDir","asc");
  const [inlineDraw,setInlineDraw]=useState(null); // {propId, loanId, date, amt}
  const [fundsOpen,setFundsOpen]=usePersistedState("nx-propFundsOpen",true);
  const [menuOpen,setMenuOpen]=useState(null);
  const toggle = id => setExpanded(e=>({...e,[id]:!e[id]}));
  const togglePropSort = col => setPropSort(s=>({col,dir:s.col===col&&s.dir==="asc"?"desc":"asc"}));
  const unassignedFunds = (data.unassigned||[]).filter(l=>!l.endDate);
  const unassignedTotal = unassignedFunds.reduce((s,u)=>s+(u.principal||u.amount||0),0);
  const sortedFunds = [...unassignedFunds].sort((a,b)=>(a.startDate||"").localeCompare(b.startDate||""));
  const manualOrder = data.propertyOrder||[];
  const dragSensors = useSensors(useSensor(PointerSensor,{activationConstraint:{distance:8}}));
  const handleDragEnd = ({active,over}) => {
    if(!over||active.id===over.id) return;
    const ids = visible.map(p=>p.id);
    const oldIndex = ids.indexOf(active.id), newIndex = ids.indexOf(over.id);
    if(oldIndex===-1||newIndex===-1) return;
    const reordered = arrayMove(visible,oldIndex,newIndex).map(p=>p.id);
    const rest = manualOrder.filter(id=>!reordered.includes(id) && data.properties.some(p=>p.id===id));
    const untouched = data.properties.map(p=>p.id).filter(id=>!reordered.includes(id) && !rest.includes(id));
    update(d=>({...d,propertyOrder:[...reordered,...rest,...untouched]}));
  };

  const commitInlineDraw = () => {
    if (!inlineDraw) return;
    const amount = parseFloat(inlineDraw.amt);
    if (!amount || !inlineDraw.date) return;
    update(d=>({...d,properties:d.properties.map(p=>p.id!==inlineDraw.propId?p:{...p,
      loans:p.loans.map(l=>l.id!==inlineDraw.loanId?l:{...l,
        drawFacility:{...l.drawFacility,draws:[...(l.drawFacility.draws||[]),{id:uid(),date:inlineDraw.date,amount}]}
      })
    })}));
    setInlineDraw(null);
  };

  useEffect(()=>{
    if(!pendingAction) return;
    setModal(pendingAction);
    onClearPendingAction?.();
  },[pendingAction]);

  const saveMoneyForm = (f, force=false) => {
    const base=loanFields(f);
    if(f.destination==="unassigned"){
      update(d=>upsertLender({...d,unassigned:[...d.unassigned,{id:uid(),...base}]},f.newLender));
      setModal(null);
    } else {
      const destProp=data.properties.find(p=>p.id===f.destination);
      const conflict=destProp?loanPropConflict(base.startDate,destProp):0;
      if(conflict>0&&!force){
        if(!window.confirm(`⚠️ This loan started ${conflict} days before the property was acquired — the money would be uncollateralized for that period.\n\nPlace it anyway?`))return;
      }
      update(d=>upsertLender({...d,properties:d.properties.map(p=>p.id!==f.destination?p:{...p,loans:[...p.loans,{id:uid(),...base}]})},f.newLender));
      setModal(null);
    }
  };

  const saveProp = (f,existing) => {
    const purchasePrice=parseFloat(f.purchasePrice)||0;
    const rehabBudget=parseFloat(f.rehabBudget)||0;
    const projectMonths=f.projectMonths!==""&&f.projectMonths!=null?parseFloat(f.projectMonths)||null:null;
    const monthlyHolding=parseFloat(f.monthlyHolding)||500;
    const p={...(existing??{id:uid(),loans:[]}),address:f.address,purchasePrice,rehabBudget,projectMonths,monthlyHolding,fundingNeeded:purchasePrice+rehabBudget,dateSold:existing?.dateSold??null,purchaseDate:f.purchaseDate||null};
    update(d=>({...d,properties:existing?d.properties.map(x=>x.id===p.id?p:x):[...d.properties,p]}));
    setModal(null);
  };

  const saveEditedLoan = (propId,f,existing) => {
    const l={...existing,...loanFields(f)};
    update(d=>upsertLender({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,loans:p.loans.map(x=>x.id===l.id?l:x)})},f.newLender));
    setModal(null);
  };

  const handleCloseLoan = (propId, loan, closeDate) => {
    update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,loans:p.loans.map(l=>l.id!==loan.id?l:{...l,endDate:closeDate})})}));
    setModal(null);
  };

  const placeOnProperty = (fund,propId) => {
    const loan={id:uid(),lenderName:fund.lenderName,loanType:fund.loanType,principal:fund.principal||fund.amount||0,startDate:fund.startDate||fund.date||TODAY,interestRate:fund.interestRate||0,interestType:fund.interestType||"percentage",paymentType:fund.paymentType||"closing",monthlyPayment:fund.monthlyPayment||0,drawFacility:fund.drawFacility||null,specialTerms:fund.specialTerms||fund.notes||"",endDate:fund.endDate||null,dueDate:fund.dueDate||null};
    update(d=>({...d,unassigned:d.unassigned.filter(u=>u.id!==fund.id),properties:d.properties.map(p=>p.id!==propId?p:{...p,loans:[...p.loans,loan]})}));
    setExpanded(e=>({...e,[propId]:true}));
    setModal(null);
  };

  const handleMove = (item,dest) => {
    if(item.type==="loan"){
      if(dest==="unassigned"){
        const fund={id:uid(),...item.loan,amount:item.loan.principal};
        update(d=>({...d,properties:d.properties.map(p=>p.id!==item.propId?p:{...p,loans:p.loans.filter(l=>l.id!==item.loan.id)}),unassigned:[...d.unassigned,fund]}));
      } else {
        update(d=>({...d,properties:d.properties.map(p=>{if(p.id===item.propId)return{...p,loans:p.loans.filter(l=>l.id!==item.loan.id)};if(p.id===dest)return{...p,loans:[...p.loans,item.loan]};return p;})}));
        setExpanded(e=>({...e,[dest]:true}));
      }
    } else if(item.type==="unassigned"){placeOnProperty(item.fund,dest);return;}
    setModal(null);
  };

  const delProp = id => { if(!confirm("Delete this property and all its loans?"))return; update(d=>({...d,properties:d.properties.filter(p=>p.id!==id)})); };
  const delLoan = (propId,loanId) => { if(!confirm("Delete this loan?"))return; update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,loans:p.loans.filter(l=>l.id!==loanId)})})); };
  const delUnassigned = id => { if(!confirm("Remove this unassigned fund?"))return; update(d=>({...d,unassigned:d.unassigned.filter(u=>u.id!==id)})); };

  const handleQuickDraw = ({propId,loanId,date,amount}) => {
    update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,
      loans:p.loans.map(l=>l.id!==loanId?l:{...l,
        drawFacility:{...l.drawFacility,draws:[...(l.drawFacility.draws||[]),{id:uid(),date,amount}]}
      })
    })}));
    setModal(null);
  };

  const handleSplitLoan = (fund, splits, srcPropId=null) => {
    const newUnassigned = splits
      .filter(s=>s.propId==="unassigned")
      .map(s=>splitPiece(fund, s.amount));
    update(d=>({
      ...d,
      unassigned: srcPropId
        ? [...(d.unassigned||[]), ...newUnassigned]
        : [...(d.unassigned||[]).filter(u=>u.id!==fund.id), ...newUnassigned],
      properties: d.properties.map(p=>{
        if(srcPropId && p.id===srcPropId){
          const withoutLoan = p.loans.filter(l=>l.id!==fund.id);
          const piece = splits.find(s=>s.propId===p.id);
          const added = piece ? [splitPiece(fund, piece.amount)] : [];
          return {...p,loans:[...withoutLoan,...added]};
        }
        const piece=splits.find(s=>s.propId===p.id);
        if(!piece) return p;
        return{...p,loans:[...p.loans,splitPiece(fund, piece.amount)]};
      }),
    }));
    splits.filter(s=>s.propId!=="unassigned").forEach(s=>setExpanded(e=>({...e,[s.propId]:true})));
    setModal(null);
  };

  const handleMarkSold = (prop, soldDate, dispositions, closingData, isRental) => {
    const activeLoans=prop.loans.filter(l=>!l.endDate);
    const newUnassigned=[]; const newLoansForProps={};
    activeLoans.forEach(loan=>{
      const d=dispositions[loan.id]; if(!d||d.type==="paidOut") return;
      // Determine rolling principal by type
      let np;
      if(d.type==="rollFull") np=Math.round(calcBalance(loan,soldDate));
      else if(d.type==="rollPrincipal") np=loan.principal;
      else if(d.type==="payInterest") np=loan.principal;
      else if(d.type==="waiveInterest") np=loan.principal;
      else if(d.type==="custom") np=parseFloat(d.customRolling)||0;
      else np=loan.principal;
      const entry={
        id:uid(),lenderName:loan.lenderName,loanType:loan.loanType,principal:np,
        startDate:d.newStartDate||soldDate,
        interestRate:d.newRate!==""?parseFloat(d.newRate):(loan.interestRate||0),
        interestType:d.interestType||loan.interestType||"percentage",
        paymentType:d.paymentType||loan.paymentType||"closing",
        specialTerms:d.specialTerms||loan.specialTerms||"",endDate:null,
      };
      if(d.destination==="unassigned"){newUnassigned.push(entry);}
      else{if(!newLoansForProps[d.destination])newLoansForProps[d.destination]=[];newLoansForProps[d.destination].push(entry);}
    });
    update(d=>({...d,
      properties:d.properties.map(p=>{
        if(p.id===prop.id)return{...p,dateSold:soldDate,isRental:isRental||false,closingData:closingData||null,loans:p.loans.map(l=>l.endDate?l:{...l,endDate:soldDate})};
        if(newLoansForProps[p.id])return{...p,loans:[...p.loans,...newLoansForProps[p.id]]};
        return p;
      }),
      unassigned:[...d.unassigned,...newUnassigned],
    }));
    setModal(null);
  };

  const propPurchaseDate=p=>p.purchaseDate||(p.loans.map(l=>l.startDate).filter(Boolean).sort()[0])||"";
  const propSellDate=p=>{
    const pd=propPurchaseDate(p);
    if(!pd) return "9999-99-99";
    const [y,m,d]=pd.split('-').map(Number);
    const dt=new Date(y,m-1+Math.round(effectiveMonths(p)),d);
    return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  };
  const rehabBurn=prop=>{
    const rolling=data.rollingLoans||[];
    return prop.loans.filter(l=>!l.endDate).reduce((s,l)=>{
      if(l.interestType==="fixed")return s;
      if(l.loanType==="private"&&rolling.includes(l.id))return s;
      const pt=l.paymentType||"closing";
      if(pt==="monthly_fixed")return s+Math.round(l.monthlyPayment||0);
      return s+Math.round((l.principal||0)*(l.interestRate||0)/100/12);
    },0);
  };
  const visible=data.properties
    .filter(p=>showSold||!p.dateSold)
    .filter(p=>{
      if(!propSearch)return true;
      const q=propSearch.toLowerCase();
      return p.address?.toLowerCase().includes(q)||p.loans.some(l=>l.lenderName?.toLowerCase().includes(q));
    })
    .sort((a,b)=>{
      const d=propSortDir==="asc"?1:-1;
      if(propSortMode==="manual"){
        const ia=manualOrder.indexOf(a.id), ib=manualOrder.indexOf(b.id);
        return (ia===-1?Infinity:ia)-(ib===-1?Infinity:ib)||(a.id||"").localeCompare(b.id||"");
      }
      if(propSortMode==="shortage"){
        const shortOf=p=>{const al=p.loans.filter(l=>!l.endDate);const f=al.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);return Math.max(0,propNeeded(p,al)-f);};
        return d*(shortOf(b)-shortOf(a))||(a.id||"").localeCompare(b.id||"");
      }
      if(propSortMode==="rehabPriority")return d*(rehabBurn(b)-rehabBurn(a));
      if(propSortMode==="dateAcquired")return d*propPurchaseDate(a).localeCompare(propPurchaseDate(b));
      if(propSortMode==="address")return d*streetSortKey(a.address).localeCompare(streetSortKey(b.address));
      if(propSortMode==="dateSold")return d*(a.dateSold||"0000").localeCompare(b.dateSold||"0000");
      return d*propSellDate(a).localeCompare(propSellDate(b));
    });
  const rankMap=Object.fromEntries(
    [...visible].sort((a,b)=>{
      if(propSortMode==="manual"){
        const ia=manualOrder.indexOf(a.id), ib=manualOrder.indexOf(b.id);
        return (ia===-1?Infinity:ia)-(ib===-1?Infinity:ib)||(a.id||"").localeCompare(b.id||"");
      }
      if(propSortMode==="shortage"){const shortOf=p=>{const al=p.loans.filter(l=>!l.endDate);const f=al.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);return Math.max(0,propNeeded(p,al)-f);};return shortOf(b)-shortOf(a)||(a.id||"").localeCompare(b.id||"");}
      if(propSortMode==="rehabPriority")return rehabBurn(b)-rehabBurn(a);
      if(propSortMode==="dateAcquired")return propPurchaseDate(a).localeCompare(propPurchaseDate(b));
      if(propSortMode==="address")return streetSortKey(a.address).localeCompare(streetSortKey(b.address));
      if(propSortMode==="dateSold")return (a.dateSold||"0000").localeCompare(b.dateSold||"0000");
      return propSellDate(a).localeCompare(propSellDate(b));
    }).map((p,i)=>[p.id,i+1])
  );
  const activeCount=data.properties.filter(p=>!p.dateSold).length;
  const totalCount=data.properties.length;

  return (
    <div>
      {menuOpen && <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(null)}/>}
      <div className="flex justify-between items-center mb-5">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Properties</h2>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-400 cursor-pointer select-none">
            <input type="checkbox" checked={showSold} onChange={e=>setShowSold(e.target.checked)} className="rounded"/> Show Sold
          </label>
          <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-lg p-0.5 gap-0.5">
            {[["condensed","≡"],["grid","▦"],["expanded","⊞"]].map(([v,icon])=>(
              <button key={v} onClick={()=>setViewMode(v)} title={v==="condensed"?"Condensed view":v==="grid"?"Card view":"Expanded view"}
                className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all ${viewMode===v?"bg-white dark:bg-zinc-700 text-slate-900 dark:text-zinc-100 shadow-sm":"text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300"}`}>
                {icon}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Sort + Search */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <SortDropdown value={propSortMode} onChange={setPropSortMode}
          options={[["shortage","Shortage"],["rehabPriority","🔥 Priority"],["estClose","Est. Close"],["dateAcquired","Acquired"],["address","A–Z"],["manual","✋ Manual (drag)"]]}/>
        {propSortMode!=="manual"&&(
          <button onClick={()=>setPropSortDir(d=>d==="asc"?"desc":"asc")}
            className="px-3 py-1.5 rounded-xl text-[11px] font-bold bg-white dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-all shrink-0 border border-slate-200 dark:border-zinc-700">
            {propSortDir==="asc"?"↑ Asc":"↓ Desc"}
          </button>
        )}
        {propSortMode==="manual"&&(
          <span className="text-[11px] text-slate-400 dark:text-zinc-500 italic">Drag properties below to reorder</span>
        )}
        <input type="text" value={propSearch} onChange={e=>setPropSearch(e.target.value)}
          placeholder="Search address or lender…" className={SEARCH_CLS}/>
      </div>

      {/* ── HERO: Unassigned Money ── */}
      {unassignedFunds.length > 0 ? (
        <div className="mb-4 rounded-2xl overflow-hidden bg-gradient-to-br from-violet-600 to-purple-700 shadow-[0_4px_24px_rgba(124,58,237,0.30)] dark:shadow-[0_4px_24px_rgba(124,58,237,0.20)]">
          {/* Collapsible header */}
          <button onClick={() => setFundsOpen(o => !o)}
            className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-white/5 transition-colors">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm shrink-0">⚠️</span>
              <div className="text-left min-w-0">
                <div className="text-[9px] font-bold uppercase tracking-widest text-violet-200/70 leading-none">Money Ready to Place</div>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-lg font-black text-white tabular-nums tracking-tight leading-none">{h$(unassignedTotal)}</span>
                  <span className="text-[11px] text-violet-200/70 leading-none">{unassignedFunds.length} fund{unassignedFunds.length !== 1 ? "s" : ""} idle</span>
                </div>
              </div>
            </div>
            <span className="text-white/40 text-xs font-bold ml-3 shrink-0">{fundsOpen ? "▲" : "▼"}</span>
          </button>
          {fundsOpen && (
            <div className="border-t border-white/15 divide-y divide-white/10">
              {sortedFunds.map(u => {
                const principal = u.principal || u.amount || 0;
                const days = daysBetween(u.startDate, TODAY);
                return (
                  <div key={u.id} className="px-4 py-2 flex items-center justify-between gap-2 hover:bg-white/5 transition-colors">
                    <div className="flex-1 min-w-0 flex items-center gap-2.5 flex-wrap">
                      <button onClick={() => openPanel({ type: 'loan', loanId: u.id, propId: null })}
                        className="font-semibold text-white text-sm hover:text-violet-200 transition-colors text-left">{u.lenderName}</button>
                      <span className="font-bold text-white/90 text-sm tabular-nums">{h$(principal)}</span>
                      {u.interestRate != null && <span className="text-xs text-violet-200/60">{fmtRate(u)}</span>}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        days > 60 ? "bg-red-500/30 text-red-200" :
                        days > 30 ? "bg-amber-400/25 text-amber-200" :
                        "bg-white/10 text-white/60"
                      }`}>{days}d idle</span>
                    </div>
                    <div className="flex gap-1.5 shrink-0 items-center">
                      {u.loanType!=="hard"&&<button onClick={() => setModal({ type: "place", fund: u })}
                        className="text-[11px] font-bold text-violet-700 bg-white hover:bg-violet-50 rounded-lg px-2.5 py-1 transition-colors shadow-sm whitespace-nowrap">Place →</button>}
                      {/* ⋯ menu */}
                      <div className="relative z-20">
                        <button onClick={() => setMenuOpen(o => o === u.id ? null : u.id)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white/70 hover:text-white text-sm font-bold transition-colors">⋯</button>
                        {menuOpen === u.id && (
                          <div className="absolute right-0 top-8 w-36 bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-slate-100 dark:border-zinc-700 overflow-hidden z-20 py-1">
                            <button onClick={() => { setMenuOpen(null); setModal({ type: "editUnassigned", fund: u }); }}
                              className="w-full text-left px-3 py-2 text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors">
                              ✏️ Edit
                            </button>
                            <button onClick={() => { setMenuOpen(null); delUnassigned(u.id); }}
                              className="w-full text-left px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                              🗑 Remove
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="mb-4 rounded-2xl border border-dashed border-violet-300 dark:border-violet-800 px-4 py-2.5 flex items-center justify-center gap-1.5 bg-violet-50/50 dark:bg-violet-900/10">
          <span className="text-sm font-semibold text-violet-700 dark:text-violet-400">✅ All Money Placed</span>
          <span className="text-xs text-slate-400 dark:text-zinc-500">— no idle funds</span>
        </div>
      )}

      {visible.length===0&&(
        <div className="text-center py-12 text-slate-400 dark:text-zinc-500 border-2 border-dashed border-slate-200 dark:border-zinc-800 rounded-2xl">
          <div className="text-4xl mb-3">🏠</div>
          <p className="font-semibold text-sm">No active properties</p>
          <p className="text-xs mt-1">Add a property to get started</p>
        </div>
      )}

      {viewMode==="condensed"&&visible.length>0&&(()=>{
        const rows=visible.map(prop=>{
          const active=prop.loans.filter(l=>!l.endDate);
          const funded=active.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);
          const needed=propNeeded(prop,active);
          const short=Math.max(0,needed-funded);
          const _f=!prop.dateSold&&funded>0&&pct(funded,needed)>=95;
          const over=needed>0?Math.max(0,funded-needed):0;
          return{prop,active,funded,needed,short,over,full:_f,under:!prop.dateSold&&short>0&&!_f};
        });
        // No column header actively clicked — keep rows' order, which already reflects the
        // sort dropdown (propSortMode/propSortDir) via visible[]. A clicked column overrides it.
        const sorted=!propSort.col ? rows : [...rows].sort((a,b)=>{
          const d=propSort.dir==="asc"?1:-1;
          switch(propSort.col){
            case"Address": return d*streetSortKey(a.prop.address).localeCompare(streetSortKey(b.prop.address));
            case"Loans":   return d*(a.active.length-b.active.length);
            case"Funded":  return d*(a.funded-b.funded);
            case"Needed":  return d*(a.needed-b.needed);
            case"Status":  return d*(a.short-b.short);
            default:       return 0;
          }
        });
        const COLS=[
          {h:"Address",left:true},
          {h:"Loans",  left:false},
          {h:"Funded", left:false},
          {h:"Needed", left:false},
          {h:"Status", left:false},
        ];
        return (
          <div className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1C1E] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#F9F9FB] dark:bg-black/20 text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-wider text-[10px] border-b border-black/[0.05] dark:border-white/[0.05]">
                    <th className="py-2.5 px-4 text-left w-6">#</th>
                    {COLS.map(({h,left})=>{
                      const isActive=propSort.col===h;
                      return (
                        <th key={h} onClick={()=>togglePropSort(h)}
                          className={`py-2.5 px-4 ${left?"text-left":"text-right"} cursor-pointer select-none hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors ${isActive?"text-slate-700 dark:text-zinc-200":""}`}>
                          <span className={`inline-flex items-center gap-0.5 ${left?"":"justify-end w-full"}`}>
                            {h}
                            {isActive
                              ? <span className="text-blue-500 ml-0.5">{propSort.dir==="asc"?"↑":"↓"}</span>
                              : <span className="opacity-40 ml-0.5">↕</span>
                            }
                          </span>
                        </th>
                      );
                    })}
                    <th className="py-2.5 px-2"></th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-[#1C1C1E] divide-y divide-black/[0.04] dark:divide-white/[0.05]">
                  {sorted.map(({prop,active,funded,needed,short,over,under,full},i)=>{
                    return(
                    <tr key={prop.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors">
                      <td className="py-2.5 px-4 tabular-nums text-[11px] text-slate-300 dark:text-zinc-600">{rankMap[prop.id]}</td>
                      <td className="py-2.5 px-4 font-semibold text-slate-800 dark:text-zinc-100 max-w-[160px] truncate">{prop.address||"Unnamed"}</td>
                      <td className="py-2.5 px-4 text-right text-slate-500 dark:text-zinc-400">{active.length}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-slate-700 dark:text-zinc-200 font-medium">{funded>0?$$(funded):"—"}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-slate-400 dark:text-zinc-500">{needed>0?$$(needed):"—"}</td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap">
                        {prop.dateSold&&<span className="text-slate-400 dark:text-zinc-500 font-semibold">Sold</span>}
                        {full&&short===0&&over>needed*0.05&&<span className="text-amber-600 dark:text-amber-400 font-semibold tabular-nums">+{$$(over)} over</span>}
                        {full&&short===0&&over<=needed*0.05&&<span className="text-emerald-600 dark:text-emerald-400 font-semibold">✓ Full</span>}
                        {full&&short>0&&<span className="text-emerald-600 dark:text-emerald-400 font-bold tabular-nums">−{$$(short)}</span>}
                        {under&&<span className="text-red-500 dark:text-red-400 font-bold tabular-nums">−{$$(short)}</span>}
                        {!prop.dateSold&&!full&&!under&&funded===0&&<span className="text-slate-300 dark:text-zinc-600">—</span>}
                      </td>
                      <td className="py-2.5 px-2 text-right">
                        <div className="flex gap-0.5 justify-end items-center">
                          <button onClick={()=>setModal({type:"editProp",prop})} className="w-6 h-6 flex items-center justify-center rounded-md text-slate-300 dark:text-zinc-600 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all text-xs">✏️</button>
                          <button onClick={()=>delProp(prop.id)} className="w-6 h-6 flex items-center justify-center rounded-md text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all text-xs">🗑</button>
                        </div>
                      </td>
                    </tr>
                  );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {viewMode==="grid"&&visible.length>0&&(
        <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visible.map(p=>p.id)} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {visible.map(prop=>{
            const active=prop.loans.filter(l=>!l.endDate);
            const funded=active.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);
            const needed=propNeeded(prop,active);
            const short=Math.max(0,needed-funded);
            const full=!prop.dateSold&&funded>0&&pct(funded,needed)>=95;
            const under=!prop.dateSold&&short>0&&!full;
            const over=needed>0?Math.max(0,funded-needed):0;
            const pd=prop.purchaseDate||(prop.loans.map(l=>l.startDate).filter(Boolean).sort()[0]);
            const daysOwned=pd?Math.floor((new Date(TODAY)-new Date(pd))/86400000):null;
            return (
              <SortableItem key={prop.id} id={prop.id} disabled={propSortMode!=="manual"}>
              <button onClick={()=>openPanel?.({type:'property',id:prop.id})}
                className={`w-full text-left rounded-2xl overflow-hidden transition-all hover:-translate-y-0.5 bg-white dark:bg-[#1C1C1E] ${prop.dateSold?"opacity-50":"shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none hover:shadow-[0_4px_20px_rgba(0,0,0,0.10)]"}`}>
                <div className={`px-4 py-3 ${under?"bg-red-50/60 dark:bg-red-950/15":""}`}>
                  <div className="flex justify-between items-start gap-2 mb-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[11px] text-slate-300 dark:text-zinc-600 tabular-nums font-medium shrink-0">{rankMap[prop.id]}</span>
                      <span className="font-semibold text-slate-900 dark:text-zinc-100 truncate text-sm">{prop.address?.split(',')[0]||"Unnamed Property"}</span>
                    </div>
                    <div className="shrink-0 text-[11px] whitespace-nowrap">
                      {prop.dateSold&&<span className="text-slate-400 dark:text-zinc-500 font-semibold">Sold</span>}
                      {full&&short===0&&over>needed*0.05&&<span className="text-amber-600 dark:text-amber-400 font-bold tabular-nums">+{h$(over)}</span>}
                      {full&&short===0&&over<=needed*0.05&&<span className="text-emerald-600 dark:text-emerald-400 font-bold">✓ Full</span>}
                      {full&&short>0&&<span className="text-emerald-600 dark:text-emerald-400 font-bold tabular-nums">-{h$(short)}</span>}
                      {under&&<span className="text-red-600 dark:text-red-400 font-bold tabular-nums">-{h$(short)}</span>}
                    </div>
                  </div>
                  {needed>0&&!prop.dateSold?(
                    <>
                      <div className="h-1.5 bg-slate-200 dark:bg-zinc-700 rounded-full overflow-hidden mb-1.5">
                        <div className={`h-full transition-all rounded-full ${full?"bg-emerald-500":under?"bg-red-400":"bg-blue-500"}`} style={{width:`${pct(funded,needed)}%`}}/>
                      </div>
                      <div className="flex justify-between text-[10px]">
                        <span className={`font-semibold tabular-nums ${under?"text-red-600 dark:text-red-400":full?"text-emerald-600 dark:text-emerald-400":"text-slate-500 dark:text-zinc-400"}`}>{h$(funded)}</span>
                        <span className="text-slate-400 dark:text-zinc-500 tabular-nums">of {h$(needed)}</span>
                      </div>
                    </>
                  ):(
                    <div className="text-[11px] text-slate-400 dark:text-zinc-500">{prop.dateSold?`Sold ${prop.dateSold}`:"No funding target set"}</div>
                  )}
                </div>
                <div className="px-4 pb-3 pt-2.5 flex items-center justify-between text-[11px] text-slate-400 dark:text-zinc-500 border-t border-black/[0.04] dark:border-white/[0.04]">
                  <span>{active.length} loan{active.length!==1?"s":""}</span>
                  {daysOwned!==null&&<span className="tabular-nums">{daysOwned}d owned</span>}
                </div>
              </button>
              </SortableItem>
            );
          })}
        </div>
        </SortableContext>
        </DndContext>
      )}

      {viewMode==="expanded"&&(
      <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={visible.map(p=>p.id)} strategy={verticalListSortingStrategy}>
      <div className="space-y-3">
        {visible.map((prop,visIdx)=>{
          const active=prop.loans.filter(l=>!l.endDate);
          const funded=active.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);
          const needed=propNeeded(prop,active);
          const short=Math.max(0,needed-funded);
          const full=!prop.dateSold&&funded>0&&pct(funded,needed)>=95;
          const under=!prop.dateSold&&short>0&&!full;
          const over=needed>0?Math.max(0,funded-needed):0;
          const rawPct=needed>0?Math.round(funded/needed*100):0;
          const isOpen=!!expanded[prop.id];
          const months=effectiveMonths(prop);
          const monthlyInt=active.reduce((s,l)=>s+monthlyLoanPayment(l),0);
          const holdingMo=prop.monthlyHolding??500;
          const purchaseAmt=prop.purchasePrice||0;
          const rehabAmt=prop.rehabBudget||0;
          const holdIntAmt=holdingMo*months+monthlyInt*months;
          const d1=purchaseAmt/needed*100;
          const d2=(purchaseAmt+rehabAmt)/needed*100;
          const hasBreakdown=purchaseAmt>0||rehabAmt>0||holdIntAmt>0;
          const pd=prop.purchaseDate||(prop.loans.map(l=>l.startDate).filter(Boolean).sort()[0]);
          const daysOwned=pd?Math.floor((new Date(TODAY)-new Date(pd))/86400000):null;
          const manualMode=propSortMode==="manual";

          return (
            <SortableItem key={prop.id} id={prop.id} disabled={!manualMode}
              className={`rounded-2xl overflow-hidden transition-all ${prop.dateSold?"opacity-50":"shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none"} bg-white dark:bg-[#1C1C1E]`}>
            {handleProps => (<>

              {/* Header — clean PropDash style, click anywhere to expand (drag handle in manual mode) */}
              <div className={`px-5 py-3.5 cursor-pointer ${under?"bg-red-50/60 dark:bg-red-950/15":""} ${manualMode?"cursor-grab":""}`}
                onClick={()=>toggle(prop.id)} {...handleProps}>
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-center gap-2 min-w-0 mr-3">
                    <span className="text-[11px] text-slate-300 dark:text-zinc-600 tabular-nums font-medium shrink-0">{rankMap[prop.id]}</span>
                    <button onClick={e=>{e.stopPropagation();openPanel?.({type:'property',id:prop.id});}} className="font-semibold text-slate-900 dark:text-zinc-100 truncate hover:text-blue-600 dark:hover:text-blue-400 text-left transition-colors">{isOpen?(prop.address||"Unnamed Property"):(prop.address?.split(',')[0]||"Unnamed Property")}</button>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    {prop.dateSold&&<span className="text-slate-400 dark:text-zinc-500 text-xs font-semibold">Sold</span>}
                    {full&&short===0&&over>needed*0.05&&<span className="text-amber-600 dark:text-amber-400 font-bold tabular-nums">+{h$(over)} over</span>}
                    {full&&short===0&&over<=needed*0.05&&<span className="text-emerald-600 dark:text-emerald-400 font-bold">✓ Full</span>}
                    {full&&short>0&&<span className="text-emerald-600 dark:text-emerald-400 font-bold tabular-nums">-{h$(short)}</span>}
                    {under&&<span className="text-red-600 dark:text-red-400 font-bold tabular-nums">-{h$(short)}</span>}
                  </div>
                </div>
                {needed>0&&!prop.dateSold&&(
                  <>
                    <div className="h-1.5 bg-slate-200 dark:bg-zinc-700 rounded-full overflow-hidden mb-1.5 relative">
                      <div className={`h-full absolute left-0 top-0 transition-all rounded-full ${full?"bg-emerald-500":under?"bg-red-400":"bg-blue-500"}`} style={{width:`${pct(funded,needed)}%`}}/>
                      {hasBreakdown&&purchaseAmt>0&&(rehabAmt>0||holdIntAmt>0)&&<div className="absolute top-0 h-full w-[2px] bg-white/80 dark:bg-black/40" style={{left:`${d1}%`}}/>}
                      {hasBreakdown&&(purchaseAmt+rehabAmt)>0&&holdIntAmt>0&&<div className="absolute top-0 h-full w-[2px] bg-white/80 dark:bg-black/40" style={{left:`${d2}%`}}/>}
                    </div>
                    <div className="flex justify-between text-[10px]">
                      <span className={`font-semibold tabular-nums ${under?"text-red-600 dark:text-red-400":full?"text-emerald-600 dark:text-emerald-400":"text-slate-500 dark:text-zinc-400"}`}>{h$(funded)} funded</span>
                      <span className="text-slate-400 dark:text-zinc-500 tabular-nums">{h$(needed)} needed</span>
                    </div>
                  </>
                )}
              </div>

              {/* Collapsed: lender pills */}
              {!isOpen&&(active.length>0||daysOwned!==null)&&(
                <div className="px-5 pb-3 flex flex-wrap gap-1.5">
                  {daysOwned!==null&&<span className="text-[11px] bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-500 dark:text-zinc-400 rounded-full px-2.5 py-1 font-medium tabular-nums">{daysOwned}d</span>}
                  {active.map(l=>(
                    <span key={l.id} className="text-[11px] bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 rounded-full px-2.5 py-1 font-medium tabular-nums">
                      {hn(l.lenderName)} · {h$(l.principal)}
                    </span>
                  ))}
                </div>
              )}

              {isOpen&&(
                <div className="border-t border-black/[0.06] dark:border-white/[0.06]">
                  {/* Cost breakdown — only shown when expanded */}
                  {hasBreakdown&&(
                    <div className="px-5 py-3 bg-[#F9F9FB] dark:bg-black/20 border-b border-black/[0.04] dark:border-white/[0.04]">
                      <div className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-1.5">Cost Breakdown</div>
                      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
                        {purchaseAmt>0&&<span className="text-slate-500 dark:text-zinc-400">Cost to Buy <strong className="text-slate-800 dark:text-zinc-200 tabular-nums">{h$(purchaseAmt)}</strong></span>}
                        {rehabAmt>0&&<span className="text-slate-500 dark:text-zinc-400">Rehab <strong className="text-slate-800 dark:text-zinc-200 tabular-nums">{h$(rehabAmt)}</strong></span>}
                        {holdIntAmt>0&&<span className="text-slate-500 dark:text-zinc-400">Hold+Int <strong className="text-slate-800 dark:text-zinc-200 tabular-nums">{hc(holdIntAmt)}</strong><span className="opacity-60 ml-1">({months}mo)</span></span>}
                        {daysOwned!==null&&<span className="text-slate-400 dark:text-zinc-500">{daysOwned} days owned</span>}
                      </div>
                    </div>
                  )}
                  {/* Loans header */}
                  <div className="px-4 py-2.5 bg-[#F9F9FB] dark:bg-black/20">
                    <span className="text-[11px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Loans · {prop.loans.length}</span>
                  </div>
                  {prop.loans.length===0&&<div className="text-center py-8 text-slate-400 dark:text-zinc-500 text-sm bg-[#F9F9FB] dark:bg-black/20">No loans on this property yet</div>}
                  <div className="divide-y divide-black/[0.05] dark:divide-white/[0.05]">
                    {prop.loans.map(loan=>{
                      const bal=calcBalance(loan);
                      const earned=calcIntEarned(loan);
                      const monthly=monthlyLoanPayment(loan);
                      const drawn=(loan.drawFacility?.draws||[]).reduce((s,d)=>s+(d.amount||0),0);
                      return (
                        <div key={loan.id} className={`px-4 py-3 bg-white dark:bg-[#1C1C1E] transition-all ${loan.endDate?"opacity-55":""}`}>
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap mb-1">
                                <button onClick={()=>openPanel?.({type:'loan',loanId:loan.id,propId:prop.id})} className="font-semibold text-slate-900 dark:text-zinc-100 text-[13px] hover:text-blue-600 dark:hover:text-blue-400 text-left transition-colors">{hn(loan.lenderName)}</button>
                                {loan.endDate&&<Chip color="gray">Closed {loan.endDate}</Chip>}
                              </div>
                              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                                <span className="text-slate-500 dark:text-zinc-400"><strong className="text-slate-800 dark:text-zinc-200 tabular-nums">{h$(loan.principal)}</strong> principal</span>
                                <span className="text-slate-400 dark:text-zinc-500">{hr(loan)}</span>
                                <span className="text-slate-400 dark:text-zinc-500">from {loan.startDate}</span>
                                <span className="text-slate-500 dark:text-zinc-400">bal <strong className="text-blue-600 dark:text-blue-400 tabular-nums">{h$(bal)}</strong></span>
                                {monthly>0&&<span className="text-slate-400 dark:text-zinc-500"><strong className="text-orange-500 dark:text-orange-400 tabular-nums">{h$(monthly)}/mo</strong></span>}
                                <span className="text-slate-400 dark:text-zinc-500">{monthly>0?"paid":"earned"} <strong className="text-emerald-600 dark:text-emerald-400 tabular-nums">{h$(earned)}</strong></span>
                              </div>
                              {loan.specialTerms&&<div className="text-[10px] text-slate-400 dark:text-zinc-500 italic mt-1">{loan.specialTerms}</div>}
                              {loan.drawFacility&&(
                                <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-100 dark:border-blue-900/50">
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-widest">Rehab Draw Facility</div>
                                    {!loan.endDate&&(inlineDraw?.loanId===loan.id
                                      ? <button type="button" onClick={()=>setInlineDraw(null)} className="text-[10px] font-medium px-2 py-0.5 rounded-md border border-slate-300 dark:border-zinc-600 text-slate-500 dark:text-zinc-400 hover:border-red-400 hover:text-red-500 transition-colors">Cancel</button>
                                      : <button type="button" onClick={()=>setInlineDraw({propId:prop.id,loanId:loan.id,date:TODAY,amt:""})} className="text-[10px] font-semibold px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white transition-colors">+ Add Draw</button>
                                    )}
                                  </div>
                                  <div className="grid grid-cols-3 gap-2 text-center text-xs mb-2">
                                    {[["Committed",h$(loan.drawFacility.committed),"text-blue-700 dark:text-blue-300"],["Drawn",h$(drawn),"text-slate-700 dark:text-zinc-200"],["Available",h$(drawRemaining(loan)),"text-emerald-600 dark:text-emerald-400"]].map(([l,v,c])=>(
                                      <div key={l}><div className="text-[9px] text-blue-400 dark:text-blue-500 uppercase mb-1">{l}</div><div className={`font-bold tabular-nums ${c}`}>{v}</div></div>
                                    ))}
                                  </div>
                                  {(loan.drawFacility.draws||[]).map(d=>(
                                    <div key={d.id} className="flex justify-between text-[11px] text-slate-500 dark:text-zinc-400 pt-1 border-t border-blue-100 dark:border-blue-900/40 first:border-0 mt-1">
                                      <span>{d.date}</span><span className="tabular-nums">{h$(d.amount)} drawn</span>
                                    </div>
                                  ))}
                                  {inlineDraw?.loanId===loan.id&&(
                                    <div className="mt-2 pt-2 border-t border-blue-200 dark:border-blue-800/60 space-y-2">
                                      <div>
                                        <div className="text-[9px] font-semibold text-blue-400 dark:text-blue-500 uppercase mb-1">Draw Date</div>
                                        <input type="date" value={inlineDraw.date} onChange={e=>setInlineDraw(p=>({...p,date:e.target.value}))}
                                          className="w-full border border-blue-200 dark:border-blue-800 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"/>
                                      </div>
                                      <div>
                                        <div className="text-[9px] font-semibold text-blue-400 dark:text-blue-500 uppercase mb-1">Amount ($)</div>
                                        <input type="number" value={inlineDraw.amt} onChange={e=>setInlineDraw(p=>({...p,amt:e.target.value}))}
                                          placeholder="25000" onWheel={e=>e.target.blur()}
                                          className="w-full border border-blue-200 dark:border-blue-800 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-xs text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"/>
                                      </div>
                                      <button type="button" onClick={commitInlineDraw}
                                        className="w-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg py-2 transition-colors">
                                        Record Draw
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="flex gap-1 shrink-0 items-center">
                              {loan.loanType!=="hard"&&<button onClick={()=>setModal({type:"moveLoan",propId:prop.id,loan})} className="text-[11px] font-bold text-white bg-violet-600 hover:bg-violet-700 rounded-lg px-2.5 py-1 transition-colors" title="Move">Move →</button>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>)}
            </SortableItem>
          );
        })}
      </div>
      </SortableContext>
      </DndContext>
      )}

      {(modal==="addMoney"||modal?.type==="addMoney")&&<Modal title="Add Lender Money" onClose={()=>setModal(null)}><LenderMoneyForm properties={data.properties} lenders={data.lenders||[]} init={modal?.propId?{destination:modal.propId}:undefined} onSave={saveMoneyForm} onClose={()=>setModal(null)}/></Modal>}
      {modal==="addProp"&&<Modal title="Add Property" onClose={()=>setModal(null)}><PropertyForm onSave={f=>saveProp(f,null)} onClose={()=>setModal(null)}/></Modal>}
      {modal?.type==="editProp"&&<Modal title="Edit Property" onClose={()=>setModal(null)}><PropertyForm init={modal.prop} onSave={f=>saveProp(f,modal.prop)} onClose={()=>setModal(null)}/></Modal>}
      {modal?.type==="editLoan"&&<Modal title="Edit Loan" onClose={()=>setModal(null)}>
        <LenderMoneyForm properties={data.properties} lenders={data.lenders||[]} init={{...modal.loan,destination:modal.propId,principal:String(modal.loan.principal),interestRate:String(modal.loan.interestRate||""),interestType:modal.loan.interestType||"percentage",paymentType:modal.loan.paymentType||"closing",monthlyPayment:String(modal.loan.monthlyPayment||""),drawFacility:modal.loan.drawFacility||null}}
          onSave={f=>saveEditedLoan(modal.propId,f,modal.loan)} onClose={()=>setModal(null)}/>
      </Modal>}
      {modal?.type==="editUnassigned"&&<Modal title="Edit Unassigned Fund" onClose={()=>setModal(null)}>
        <LenderMoneyForm properties={data.properties} lenders={data.lenders||[]} unassigned={data.unassigned}
          init={{...modal.fund,destination:"unassigned",principal:String(modal.fund.principal||modal.fund.amount||""),interestRate:String(modal.fund.interestRate||""),interestType:modal.fund.interestType||"percentage"}}
          onSave={f=>{
            const updated={...modal.fund,lenderName:f.lenderName,loanType:f.loanType,principal:parseFloat(f.principal)||0,startDate:f.startDate,interestRate:parseFloat(f.interestRate)||0,interestType:f.interestType||"percentage",specialTerms:f.specialTerms||"",endDate:f.endDate||null,dueDate:f.dueDate||null};
            const doUpdate = d => f.newLender
              ? {...d,lenders:[...(d.lenders||[]).filter(x=>x.name!==f.newLender.name),f.newLender]}
              : d;
            if(f.destination!=="unassigned"){update(d=>doUpdate({...d,unassigned:d.unassigned.filter(u=>u.id!==modal.fund.id),properties:d.properties.map(p=>p.id!==f.destination?p:{...p,loans:[...p.loans,{id:uid(),...updated}]})}));}
            else{update(d=>doUpdate({...d,unassigned:d.unassigned.map(u=>u.id===modal.fund.id?updated:u)}));}
            setModal(null);
          }}
          onMerge={(f,mergeId)=>{
            const merged={...modal.fund,lenderName:f.lenderName,loanType:f.loanType,principal:(parseFloat(f.principal)||0)+(data.unassigned.find(u=>u.id===mergeId)?.principal||0),startDate:f.startDate,interestRate:parseFloat(f.interestRate)||0,interestType:f.interestType||"percentage",specialTerms:f.specialTerms||"",endDate:f.endDate||null,dueDate:f.dueDate||null};
            const doUpdate = d => f.newLender
              ? {...d,lenders:[...(d.lenders||[]).filter(x=>x.name!==f.newLender.name),f.newLender]}
              : d;
            update(d=>doUpdate({...d,unassigned:d.unassigned.filter(u=>u.id!==mergeId).map(u=>u.id===modal.fund.id?merged:u)}));
            setModal(null);
          }}
          onClose={()=>setModal(null)}/>
      </Modal>}
      {modal?.type==="closeLoan"&&<CloseLoanModal loan={modal.loan} onConfirm={date=>handleCloseLoan(modal.propId,modal.loan,date)} onClose={()=>setModal(null)}/>}
      {(modal?.type==="place"||modal?.type==="moveLoan")&&(()=>{
        const fund=modal.fund||modal.loan;
        const srcPropId=modal.type==="moveLoan"?modal.propId:null;
        return <PlaceSplitModal
          loan={fund} currentPropId={srcPropId} properties={data.properties}
          onConfirm={result=>{
            if(result.type==="split") handleSplitLoan(fund,result.splits,srcPropId);
            else if(result.type==="unassigned") handleMove({type:"loan",propId:srcPropId,loan:fund},"unassigned");
            else if(srcPropId) handleMove({type:"loan",propId:srcPropId,loan:fund},result.propId);
            else placeOnProperty(fund,result.propId);
          }}
          onClose={()=>setModal(null)}/>;
      })()}
      {modal?.type==="markSold"&&<MarkSoldModal prop={modal.prop} allProperties={data.properties} onConfirm={(d,disp,cd,ir)=>handleMarkSold(modal.prop,d,disp,cd,ir)} onClose={()=>setModal(null)}/>}
      {modal==="closeLender"&&<CloseLenderModal data={data} update={update} onClose={()=>setModal(null)}/>}
      {modal?.type==="closePropPicker"&&<ClosePropertyPickerModal properties={data.properties} onPick={prop=>setModal({type:"markSold",prop})} onClose={()=>setModal(null)}/>}
      {modal?.type==="quickDraw"&&<QuickDrawModal data={data} onSave={handleQuickDraw} onClose={()=>setModal(null)}/>}
    </div>
  );
}

// ─── Lender Dashboard ─────────────────────────────────────────────────────────
function LenderDashboard({ data }) {
  const prv = usePrivacy();
  const navigate = usePanel();
  const h$ = v => prv ? maskMoney($$(v)) : $$(v);
  const [search, setSearch] = useState("");
  const [lenderFilter, setLenderFilter] = usePersistedState("nx-lenderFilter", "active");
  const [sortBy, setSortBy] = usePersistedState("nx-lenderSortBy2", "name");
  const [sortDir, setSortDir] = usePersistedState("nx-lenderSortDir", "asc");

  const allActive = [
    ...data.properties.flatMap(prop =>
      prop.loans.filter(l => !l.endDate).map(l => ({...l, propAddress:prop.address, propId:prop.id}))
    ),
    ...(data.unassigned||[]).map(u => {const p=u.principal||u.amount||0;const l={...u,principal:p};return{...l,propAddress:null,propId:null};}),
  ];

  const byLender = {};
  allActive.forEach(l => {
    if (!byLender[l.lenderName]) byLender[l.lenderName] = {name:l.lenderName, activeLoans:[], totalPrin:0, totalBal:0, totalInt:0, props:new Set(), types:new Set()};
    const ld = byLender[l.lenderName];
    ld.activeLoans.push(l);
    ld.totalPrin += (l.principal||0);
    ld.totalBal += calcBalance(l);
    ld.totalInt += calcIntEarned(l);
    if (l.propAddress) ld.props.add(l.propAddress);
    ld.types.add(l.loanType);
  });

  // Also count all historical loans
  const allHistorical = data.properties.flatMap(p => p.loans.filter(l => l.endDate).map(l => ({...l, propAddress:p.address})));
  allHistorical.forEach(l => {
    if (!byLender[l.lenderName]) byLender[l.lenderName] = {name:l.lenderName, activeLoans:[], totalPrin:0, totalBal:0, totalInt:0, props:new Set(), types:new Set()};
    byLender[l.lenderName].types.add(l.loanType);
  });
  const closedByLender = {};
  allHistorical.forEach(l => { closedByLender[l.lenderName] = (closedByLender[l.lenderName]||0) + 1; });

  let lenders = Object.values(byLender).map(ld => ({
    ...ld,
    props: [...ld.props],
    types: [...ld.types],
    closedCount: closedByLender[ld.name] || 0,
  }));

  const lenderCounts = {
    active: lenders.filter(ld=>ld.activeLoans.length>0).length,
    inactive: lenders.filter(ld=>ld.activeLoans.length===0).length,
    all: lenders.length,
  };

  if (lenderFilter === "active") lenders = lenders.filter(ld=>ld.activeLoans.length>0);
  else if (lenderFilter === "inactive") lenders = lenders.filter(ld=>ld.activeLoans.length===0);

  if (search) {
    const q = search.toLowerCase();
    lenders = lenders.filter(ld => ld.name?.toLowerCase().includes(q) || ld.props.some(p => p.toLowerCase().includes(q)));
  }

  lenders.sort((a,b) => {
    const d = sortDir==="asc" ? 1 : -1;
    if (sortBy === "principal") return d*(a.totalPrin - b.totalPrin);
    if (sortBy === "balance") return d*(a.totalBal - b.totalBal);
    if (sortBy === "loans") return d*(a.activeLoans.length - b.activeLoans.length);
    if (sortBy === "type") {
      const ta = a.types.includes("hard") ? "hard" : "private";
      const tb = b.types.includes("hard") ? "hard" : "private";
      return d*ta.localeCompare(tb);
    }
    return d*(a.name||"").localeCompare(b.name||"");
  });

  const totalPrin = Object.values(byLender).reduce((s,ld) => s + ld.totalPrin, 0);
  const totalBal = Object.values(byLender).reduce((s,ld) => s + ld.totalBal, 0);
  const totalInt = Object.values(byLender).reduce((s,ld) => s + ld.totalInt, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Lenders</h2>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4">
        {[["active","Active"],["inactive","Inactive"],["all","All"]].map(([val,label])=>(
          <button key={val} onClick={()=>setLenderFilter(val)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${lenderFilter===val?"bg-blue-600 text-white shadow-sm":"bg-white dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 hover:text-slate-700 dark:hover:text-zinc-200"}`}>
            {label}{lenderFilter===val?` (${lenderCounts[val]})`:null}
          </button>
        ))}
      </div>

      {/* Summary — hidden for inactive-only view */}
      {lenderFilter!=="inactive"&&<div className="grid grid-cols-3 gap-3 mb-5">
        {[
          ["Total Principal", h$(totalPrin), "text-slate-900 dark:text-zinc-100"],
          ["Total Balance", h$(totalBal), "text-blue-600 dark:text-blue-400"],
          ["Interest Accrued", h$(totalInt), "text-emerald-600 dark:text-emerald-400"],
        ].map(([label, val, color]) => (
          <div key={label} className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">{label}</div>
            <div className={`text-xl font-bold tabular-nums ${color}`}>{val}</div>
          </div>
        ))}
      </div>}

      {/* Sort + search */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <SortDropdown value={sortBy} onChange={setSortBy}
          options={[["name","A–Z"],["principal","By Principal"],["balance","By Balance"],["loans","By # Loans"],["type","By Type"]]}/>
        <button onClick={()=>setSortDir(d=>d==="asc"?"desc":"asc")}
          className="px-3 py-1.5 rounded-xl text-[11px] font-bold bg-white dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-all shrink-0 border border-slate-200 dark:border-zinc-700">
          {sortDir==="asc"?"↑ Asc":"↓ Desc"}
        </button>
        <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Search lenders or properties…" className={SEARCH_CLS}/>
      </div>

      {/* Lender cards */}
      <div className="space-y-2">
        {lenders.length === 0 ? (
          <div className="py-12 text-center text-slate-400 dark:text-zinc-500 text-sm">No lenders yet</div>
        ) : lenders.map(ld => (
          <button key={ld.name} onClick={() => navigate({type:'lender', name:ld.name})}
            className="w-full text-left bg-white dark:bg-[#1C1C1E] rounded-2xl px-5 py-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)] hover:shadow-[0_4px_20px_rgba(0,0,0,0.1)] dark:shadow-none dark:hover:bg-[#2C2C2E] transition-all group">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold text-slate-900 dark:text-zinc-100 text-[15px] group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{ld.name}</span>
                  {ld.types.map(t => <TypeLabel key={t} type={t}/>)}
                </div>
                <div className="text-xs text-slate-400 dark:text-zinc-500">
                  {ld.activeLoans.length} active loan{ld.activeLoans.length!==1?"s":""}
                  {ld.closedCount > 0 && ` · ${ld.closedCount} closed`}
                  {ld.props.length > 0 && ` · ${ld.props.slice(0,2).join(", ")}${ld.props.length>2?` +${ld.props.length-2} more`:""}`}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold">Balance</div>
                <div className="font-bold text-blue-600 dark:text-blue-400 tabular-nums text-sm">{h$(ld.totalBal)}</div>
              </div>
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-300 dark:text-zinc-600 shrink-0 group-hover:text-blue-400 transition-colors">
                <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd"/>
              </svg>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── All Loans Page ────────────────────────────────────────────────────────────
function AllLoansPage({ data, update, pendingTypeFilter, onClearPendingTypeFilter }) {
  const prv = usePrivacy();
  const navigate = usePanel();
  const h$ = v => prv ? maskMoney($$(v)) : $$(v);
  const hr = l => { if(!prv) return fmtRate(l); const s=fmtRate(l); return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s); };
  const [filter, setFilter] = usePersistedState("nx-loansFilter", "active");
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = usePersistedState("nx-loansSortBy", "date");
  const [sortDir, setSortDir] = usePersistedState("nx-loansSortDir", "desc");
  const [moveLoan, setMoveLoan] = useState(null);

  const handleMoveConfirm = (loanRow, result) => {
    const { prop, propAddress, propId: srcPropId, ...loan } = loanRow; // strip UI-only fields before persisting
    if (result.type === "split") {
      const newUnassigned = result.splits.filter(s=>s.propId==="unassigned").map(s=>splitPiece(loan, s.amount));
      update(d=>({
        ...d,
        unassigned: srcPropId
          ? [...(d.unassigned||[]), ...newUnassigned]
          : [...(d.unassigned||[]).filter(u=>u.id!==loan.id), ...newUnassigned],
        properties: d.properties.map(p=>{
          if(srcPropId && p.id===srcPropId){
            const withoutLoan = p.loans.filter(l=>l.id!==loan.id);
            const piece = result.splits.find(s=>s.propId===p.id);
            const added = piece ? [splitPiece(loan, piece.amount)] : [];
            return {...p,loans:[...withoutLoan,...added]};
          }
          const piece = result.splits.find(s=>s.propId===p.id);
          if(!piece) return p;
          return {...p,loans:[...p.loans,splitPiece(loan, piece.amount)]};
        }),
      }));
    } else if (result.type === "unassigned") {
      if (srcPropId) {
        const fund={id:uid(),...loan};
        update(d=>({...d,properties:d.properties.map(p=>p.id!==srcPropId?p:{...p,loans:p.loans.filter(l=>l.id!==loan.id)}),unassigned:[...(d.unassigned||[]),fund]}));
      }
    } else if (srcPropId) {
      update(d=>({...d,properties:d.properties.map(p=>{
        if(p.id===srcPropId) return {...p,loans:p.loans.filter(l=>l.id!==loan.id)};
        if(p.id===result.propId) return {...p,loans:[...p.loans,loan]};
        return p;
      })}));
    } else {
      const placed={id:uid(),...loan};
      update(d=>({...d,unassigned:(d.unassigned||[]).filter(u=>u.id!==loan.id),properties:d.properties.map(p=>p.id!==result.propId?p:{...p,loans:[...p.loans,placed]})}));
    }
    setMoveLoan(null);
  };
  useEffect(() => {
    if (pendingTypeFilter) { setTypeFilter(pendingTypeFilter); onClearPendingTypeFilter?.(); }
  }, [pendingTypeFilter]);

  const allLoans = [
    ...data.properties.flatMap(p => p.loans.map(l => ({...l, prop:p, propAddress:p.address, propId:p.id}))),
    ...(data.unassigned||[]).map(l => ({...l, prop:null, propAddress:null, propId:null})),
  ];

  const loanNumMap = Object.fromEntries(
    [...allLoans].sort((a,b)=>(a.startDate||"").localeCompare(b.startDate||""))
      .map((l,i)=>[l.id,i+1])
  );
  const filterCounts = {
    active: allLoans.filter(l=>!l.endDate).length,
    closed: allLoans.filter(l=>!!l.endDate).length,
    all: allLoans.length,
  };

  const filtered = allLoans.filter(l => {
    const matchFilter = filter === "all" || (filter === "active" ? !l.endDate : !!l.endDate);
    const matchType = typeFilter === "all" || l.loanType === typeFilter;
    const q = search.toLowerCase();
    const matchSearch = !search || l.lenderName?.toLowerCase().includes(q) || l.propAddress?.toLowerCase().includes(q);
    return matchFilter && matchType && matchSearch;
  }).sort((a,b) => {
    const d = sortDir==="asc" ? 1 : -1;
    if(sortBy==="lender") return d*(a.lenderName||"").localeCompare(b.lenderName||"");
    if(sortBy==="principal") return d*((a.principal||0)-(b.principal||0));
    if(sortBy==="balance") return d*(calcBalance(a)-calcBalance(b));
    if(sortBy==="property") return d*(a.propAddress||"").localeCompare(b.propAddress||"");
    if(sortBy==="type") return d*(a.loanType||"private").localeCompare(b.loanType||"private");
    if(sortBy==="num") return d*(loanNumMap[a.id]-loanNumMap[b.id]);
    return d*(a.startDate||"").localeCompare(b.startDate||"");
  });

  const totalPrin = filtered.filter(l=>!l.endDate).reduce((s,l) => s + (l.principal||0), 0);
  const totalBal = filtered.filter(l=>!l.endDate).reduce((s,l) => s + calcBalance(l), 0);
  const toggleSort = col => {
    if (sortBy === col) setSortDir(d => d==="asc"?"desc":"asc");
    else { setSortBy(col); setSortDir("desc"); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Loans</h2>
      </div>

      {/* Summary */}
      {filter !== "closed" && (
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Active Principal</div>
            <div className="text-xl font-bold tabular-nums text-slate-900 dark:text-zinc-100">{h$(totalPrin)}</div>
          </div>
          <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Active Balance</div>
            <div className="text-xl font-bold tabular-nums text-blue-600 dark:text-blue-400">{h$(totalBal)}</div>
          </div>
        </div>
      )}

      {/* Filters + search */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {["active","closed","all"].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors ${filter===f?"bg-blue-600 text-white":"bg-white dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700"}`}>
            {f.charAt(0).toUpperCase()+f.slice(1)}{filter===f?` (${filterCounts[f]})` : ""}
          </button>
        ))}
        <div className="h-4 w-px bg-slate-200 dark:bg-zinc-700 mx-0.5"/>
        {[["all","All Types"],["hard","Hard Money"],["private","Private Money"]].map(([t,l]) => (
          <button key={t} onClick={() => setTypeFilter(t)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors ${typeFilter===t?"bg-slate-800 dark:bg-zinc-100 text-white dark:text-zinc-900":"bg-white dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700"}`}>
            {l}
          </button>
        ))}
        <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Search lender or property…" className={SEARCH_CLS}/>
      </div>

      {/* Loans table */}
      <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-slate-400 dark:text-zinc-500 text-sm">No loans match this filter</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest border-b border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-900/20">
                <th onClick={()=>toggleSort("num")} className="pl-4 pr-2 pb-2.5 pt-3 text-left font-semibold cursor-pointer select-none hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors">
                  <span className="inline-flex items-center gap-0.5">#
                    {sortBy==="num"?<span className="text-blue-500 ml-0.5">{sortDir==="asc"?"↑":"↓"}</span>:<span className="opacity-30 ml-0.5">↕</span>}
                  </span>
                </th>
                {[["lender","Lender","left","px-3"],["property","Property","left","px-3"],["principal","Principal","right","px-3"],["balance","Balance","right","px-3"],["type","Type","left","px-3"]].map(([col,label,align,px])=>(
                  <th key={col} onClick={()=>toggleSort(col)}
                    className={`${px} pb-2.5 pt-3 text-${align} font-semibold cursor-pointer select-none hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors`}>
                    <span className={`inline-flex items-center gap-0.5 ${align==="right"?"justify-end w-full":""}`}>
                      {label}
                      {sortBy===col
                        ? <span className="text-blue-500 ml-0.5">{sortDir==="asc"?"↑":"↓"}</span>
                        : <span className="opacity-30 ml-0.5">↕</span>}
                    </span>
                  </th>
                ))}
                <th className="px-3 pb-2.5 pt-3 text-right font-semibold">Rate</th>
                <th onClick={()=>toggleSort("date")}
                  className="px-3 pb-2.5 pt-3 text-right font-semibold cursor-pointer select-none hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors">
                  <span className="inline-flex items-center gap-0.5 justify-end w-full">
                    Started
                    {sortBy==="date"
                      ? <span className="text-blue-500 ml-0.5">{sortDir==="asc"?"↑":"↓"}</span>
                      : <span className="opacity-30 ml-0.5">↕</span>}
                  </span>
                </th>
                <th className="px-4 pb-2.5 pt-3 text-right font-semibold">Status</th>
                <th className="px-3 pb-2.5 pt-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800">
              {filtered.map(l => {
                const bal = calcBalance(l);
                return (
                  <tr key={l.id} className="hover:bg-slate-50 dark:hover:bg-zinc-900/30 transition-colors cursor-pointer" onClick={() => navigate({type:'loan', loanId:l.id, propId:l.propId})}>
                    <td className="pl-4 pr-2 py-3 tabular-nums text-[11px] text-slate-300 dark:text-zinc-600">{loanNumMap[l.id]}</td>
                    <td className="px-3 py-3">
                      <button onClick={e=>{e.stopPropagation();navigate({type:'loan',loanId:l.id,propId:l.propId});}} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline text-left">
                        {l.lenderName||"Unknown"}
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      {l.prop
                        ? <button onClick={e=>{e.stopPropagation();navigate({type:'property',id:l.propId});}} className="text-slate-600 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400 hover:underline text-left max-w-[160px] truncate block">{l.propAddress}</button>
                        : <span className="text-slate-400 dark:text-zinc-500 italic">Unassigned</span>
                      }
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-semibold text-slate-800 dark:text-zinc-200">{h$(l.principal)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-blue-600 dark:text-blue-400">{h$(bal)}</td>
                    <td className="px-3 py-3"><TypeLabel type={l.loanType}/></td>
                    <td className="px-3 py-3 text-right text-slate-500 dark:text-zinc-400">{hr(l)}</td>
                    <td className="px-3 py-3 text-right text-slate-500 dark:text-zinc-400">{l.startDate||"—"}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${l.endDate?"bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400":"bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"}`}>
                        {l.endDate ? "Closed" : "Active"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      {!l.endDate&&l.loanType!=="hard"&&(
                        <button onClick={e=>{e.stopPropagation();setMoveLoan(l);}} className="text-[11px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 whitespace-nowrap transition-colors">Move →</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {moveLoan&&(
        <PlaceSplitModal loan={moveLoan} currentPropId={moveLoan.propId} properties={data.properties}
          onConfirm={result=>handleMoveConfirm(moveLoan,result)} onClose={()=>setMoveLoan(null)}/>
      )}
    </div>
  );
}

// ─── Property Dashboard ───────────────────────────────────────────────────────
function PropertyDashboard({ data }) {
  const prv=usePrivacy();
  const h$=v=>prv?maskMoney($$(v)):$$(v);
  const hc=v=>prv?maskMoney($$c(v)):$$c(v);
  const hn=n=>n??"";
  const hr=l=>{if(!prv)return fmtRate(l);const s=fmtRate(l);return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s);};
  const [deployPct,setDeployPct]=useState(75);
  const active=data.properties.filter(p=>!p.dateSold);
  const rows=active.map(prop=>{
    const loans=prop.loans.filter(l=>!l.endDate);
    const funded=loans.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);
    const needed=propNeeded(prop,loans);
    const short=Math.max(0,needed-funded);
    return{prop,loans,funded,needed,short,under:short>0&&pct(funded,needed)<95};
  }).sort((a,b)=>b.short-a.short);

  const totalDeployed=rows.reduce((s,r)=>s+r.funded,0);
  const unassignedTotal=data.unassigned.reduce((s,u)=>s+(u.principal||u.amount||0),0);
  const totalPortfolio=rows.reduce((s,r)=>s+r.needed,0);
  const needNow=Math.round(totalPortfolio*deployPct/100);
  const haveNow=totalDeployed+unassignedTotal;
  const goFindThis=Math.max(0,needNow-haveNow);
  const idleCapital=Math.max(0,haveNow-needNow);
  const allActiveLoans=active.flatMap(p=>p.loans.filter(l=>!l.endDate));
  const monthlyLenderBurn=allActiveLoans.reduce((s,l)=>s+monthlyLoanPayment(l),0);
  const monthlyHoldingBurn=active.reduce((s,p)=>s+(p.monthlyHolding??500),0);
  const totalMonthlyBurn=monthlyLenderBurn+monthlyHoldingBurn;

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Dashboard</h2>
      </div>

      {/* Monthly burn banner */}
      {totalMonthlyBurn>0&&(
        <div className="mb-4 rounded-2xl bg-orange-50 dark:bg-orange-950/30 px-5 py-4 flex items-center justify-between shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
          <div>
            <div className="text-[10px] font-semibold text-orange-500 dark:text-orange-400 uppercase tracking-widest mb-0.5">Monthly Cash Needed</div>
            <div className="text-[11px] text-orange-400 dark:text-orange-500">{h$(monthlyLenderBurn)}/mo interest · {h$(monthlyHoldingBurn)}/mo holding</div>
          </div>
          <div className="text-2xl font-black text-orange-600 dark:text-orange-400 tabular-nums">{h$(totalMonthlyBurn)}<span className="text-sm font-semibold">/mo</span></div>
        </div>
      )}

      {/* Top 3 stat cards */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="bg-slate-900 dark:bg-zinc-800 rounded-2xl p-4 text-white text-center">
          <div className="text-[9px] font-semibold text-slate-400 uppercase tracking-widest mb-2">Under Mgmt</div>
          <div className="text-xl font-bold tabular-nums">{hc(haveNow)}</div>
          <div className="text-[10px] text-slate-500 mt-1">deployed + ready</div>
        </div>
        <div className="bg-blue-600 rounded-2xl p-4 text-white text-center">
          <div className="text-[9px] font-semibold text-blue-200 uppercase tracking-widest mb-2">On Deals</div>
          <div className="text-xl font-bold tabular-nums">{hc(totalDeployed)}</div>
          <div className="text-[10px] text-blue-200 mt-1">{rows.length} propert{rows.length===1?"y":"ies"}</div>
        </div>
        <div className="bg-violet-600 rounded-2xl p-4 text-white text-center">
          <div className="text-[9px] font-semibold text-violet-200 uppercase tracking-widest mb-2">Ready</div>
          <div className="text-xl font-bold tabular-nums">{hc(unassignedTotal)}</div>
          <div className="text-[10px] text-violet-200 mt-1">{data.unassigned.length} unassigned</div>
        </div>
      </div>

      {/* Capital calculator */}
      <div className="rounded-2xl overflow-hidden mb-5 shadow-[0_2px_16px_rgba(0,0,0,0.10)] dark:shadow-none">
        <div className="bg-slate-900 dark:bg-zinc-800 px-6 py-5">
          <div className="flex justify-between items-start mb-4">
            <div>
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-1.5">Total Portfolio Size</div>
              <div className="text-3xl font-bold text-white tabular-nums">{h$(totalPortfolio)}</div>
              <div className="text-xs text-slate-400 mt-1">{active.length} active deal{active.length!==1?"s":""}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-1.5">Available Now</div>
              <div className="text-2xl font-bold text-white tabular-nums">{h$(haveNow)}</div>
            </div>
          </div>
          <div className="bg-white/10 rounded-xl px-4 py-3">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-semibold text-slate-300">Deployment rate assumption</span>
              <span className="text-sm font-bold text-white">{deployPct}%</span>
            </div>
            <input type="range" min={50} max={100} step={5} value={deployPct} onChange={e=>setDeployPct(Number(e.target.value))}
              className="w-full accent-blue-400 cursor-pointer"/>
            <div className="flex justify-between text-[10px] text-slate-500 mt-1">
              <span>50% — large pipeline</span>
              <span>100% — fully deployed</span>
            </div>
          </div>
        </div>

        {/* The hero number */}
        <div className={`px-6 py-6 ${goFindThis>0?"bg-red-500 dark:bg-red-600":"bg-emerald-500 dark:bg-emerald-600"}`}>
          <div className="flex justify-between items-center">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-white/70 mb-2">
                {goFindThis>0 ? "You Need to Find" : "✓ You're Fully Covered"}
              </div>
              <div className="text-5xl font-black text-white tabular-nums tracking-tight">
                {goFindThis>0 ? h$(goFindThis) : "All good"}
              </div>
              <div className="text-xs text-white/60 mt-2">
                Need {h$(needNow)} ({deployPct}% of {h$(totalPortfolio)}) · Have {h$(haveNow)}
              </div>
            </div>
            {idleCapital>0&&(
              <div className="text-right bg-white/20 rounded-2xl px-4 py-3">
                <div className="text-[10px] font-semibold text-white/70 uppercase tracking-widest mb-1">Idle Capital</div>
                <div className="text-2xl font-bold text-white tabular-nums">{h$(idleCapital)}</div>
                <div className="text-[10px] text-white/50 mt-0.5">not needed yet</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {active.length===0&&<div className="text-center text-slate-400 dark:text-zinc-500 py-12 text-sm">No active properties.</div>}
      <div className="space-y-3">
        {rows.map(({prop,loans,funded,needed,short,under})=>(
          <div key={prop.id} className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1C1E] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
            <div className={`px-5 py-3.5 border-b border-black/[0.06] dark:border-white/[0.06] ${under?"bg-red-50/60 dark:bg-red-950/15":""}`}>
              <div className="flex justify-between items-center mb-2">
                <span className="font-semibold text-slate-900 dark:text-zinc-100">{prop.address}</span>
                {under&&<span className="text-red-600 dark:text-red-400 font-bold tabular-nums">-{h$(short)}</span>}
              </div>
              <div className="h-1.5 bg-slate-200 dark:bg-zinc-700 rounded-full overflow-hidden mb-1.5">
                <div className={`h-full rounded-full ${under?"bg-red-400":pct(funded,needed)>=95?"bg-emerald-500":"bg-blue-500"}`} style={{width:`${pct(funded,needed)}%`}}/>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className={`font-semibold tabular-nums ${under?"text-red-600 dark:text-red-400":"text-emerald-600 dark:text-emerald-400"}`}>{h$(funded)} funded</span>
                <span className="text-slate-400 dark:text-zinc-500 tabular-nums">{h$(needed)} needed</span>
              </div>
            </div>
            {loans.length>0&&(
              <div className="overflow-x-auto">
              <table className="w-full text-xs bg-white dark:bg-[#1C1C1E]">
                <tbody className="divide-y divide-black/[0.04] dark:divide-white/[0.04]">
                  {loans.map(l=>(
                    <tr key={l.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                      <td className="px-5 py-2.5 font-semibold text-slate-800 dark:text-zinc-100">{hn(l.lenderName)}</td>
                      <td className="px-3 py-2.5"><TypeLabel type={l.loanType}/></td>
                      <td className="px-3 py-2.5 text-right text-slate-600 dark:text-zinc-300 tabular-nums">{h$(l.principal)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400 dark:text-zinc-500 whitespace-nowrap">{hr(l)}</td>
                      <td className="px-5 py-2.5 text-right font-bold text-blue-700 dark:text-blue-400 tabular-nums">{h$(calcBalance(l))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Edit Closing Modal ───────────────────────────────────────────────────────
function EditClosingModal({ prop, onSave, onClose }) {
  const cd=prop.closingData||{};
  const [dateSold,setDateSold]=useState(prop.dateSold||"");
  const [isRental,setIsRental]=useState(prop.isRental||false);
  const [wireIn,setWireIn]=useState(String(cd.wire||""));
  const [cashToCloseIn,setCashToCloseIn]=useState(String(cd.cashToClose||""));
  const [rehabIn,setRehabIn]=useState(String(cd.rehab||""));
  const [miscIn,setMiscIn]=useState(String(cd.misc||""));
  const [overageIn,setOverageIn]=useState(String(cd.overageRefund||""));

  const wire=parseFloat(wireIn)||0;
  const cashToClose=parseFloat(cashToCloseIn)||0;
  const rehab=parseFloat(rehabIn)||0;
  const misc=parseFloat(miscIn)||0;
  const overage=parseFloat(overageIn)||0;
  const moneyCosts=cd.moneyCosts||0;
  const titleTotal=cd.titleTotal||0;
  const totalCosts=cashToClose+rehab+moneyCosts+misc;
  const profit=(wire+titleTotal)-totalCosts+overage;

  const numCls="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums text-slate-800 dark:text-zinc-100";
  const row=(label,val,setVal)=>(
    <div>
      <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">{label}</label>
      <input type="number" value={val} onChange={e=>setVal(e.target.value)} className={numCls} placeholder="0"/>
    </div>
  );

  return (
    <Modal title={`Edit Closing: ${prop.address}`} onClose={onClose}>
      <div className="space-y-3">
        <DateInp label="Date Sold" value={dateSold} onChange={setDateSold}/>

        {/* Rental toggle */}
        <div className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-zinc-700 px-4 py-3">
          <div>
            <div className="font-semibold text-sm text-slate-800 dark:text-zinc-100">Rental Property</div>
            <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5">Excludes from flip stats</div>
          </div>
          <div onClick={()=>setIsRental(r=>!r)}
            className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer shrink-0 ml-4 ${isRental?"bg-purple-500":"bg-slate-200 dark:bg-zinc-600"}`}>
            <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${isRental?"translate-x-5":""}`}/>
          </div>
        </div>

        {row("Wire Received",wireIn,setWireIn)}
        {row("Cash to Close",cashToCloseIn,setCashToCloseIn)}
        {row("Rehab",rehabIn,setRehabIn)}
        {row("Misc / Holding",miscIn,setMiscIn)}
        {row("Overage Refund (post-close)",overageIn,setOverageIn)}

        {moneyCosts>0&&(
          <div className="flex justify-between text-sm bg-slate-50 dark:bg-zinc-800/50 rounded-xl px-4 py-3">
            <span className="text-slate-500 dark:text-zinc-400">Money costs (int. + fees) — from lender settlement</span>
            <span className="font-semibold tabular-nums text-slate-700 dark:text-zinc-200">{$$p(moneyCosts)}</span>
          </div>
        )}

        <div className={`flex justify-between items-center rounded-xl px-4 py-3 ${profit>=0?"bg-emerald-50 dark:bg-emerald-900/20":"bg-red-50 dark:bg-red-900/20"}`}>
          <span className="font-bold text-sm text-slate-800 dark:text-zinc-100">Deal Profit</span>
          <span className={`text-xl font-bold tabular-nums ${profit>=0?"text-emerald-700 dark:text-emerald-400":"text-red-600 dark:text-red-400"}`}>{$$ps(profit)}</span>
        </div>

        <div className="flex gap-2 pt-1">
          <Btn onClick={()=>onSave({dateSold,isRental,closingData:{...cd,wire,cashToClose,rehab,misc,totalCosts,overageRefund:overage,profit}})} color="navy" full>Save Changes</Btn>
          <Btn onClick={onClose} color="ghost">Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}

// ─── Closed Deals ─────────────────────────────────────────────────────────────
function ClosedDealsPage({ data, update }) {
  const prv=usePrivacy();
  const openPanel=usePanel();
  const h$=v=>prv?maskMoney($$(v)):$$(v);
  const hc=v=>prv?maskMoney($$c(v)):$$c(v);
  const hs=v=>prv?maskMoney($$s(v)):$$s(v);
  const hn=n=>n??"";
  const hr=l=>{if(!prv)return fmtRate(l);const s=fmtRate(l);return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s);};
  const [view,setView]=usePersistedState("nx-closedView","flips");
  const [expanded,setExpanded]=useState({});
  const [search,setSearch]=useState("");
  const [sortMode,setSortMode]=usePersistedState("nx-closedSortMode","dateSold");
  const [flipSortDir,setFlipSortDir]=usePersistedState("nx-flipSortDir","desc");
  const [rentalSortDir,setRentalSortDir]=usePersistedState("nx-rentalSortDir","desc");
  const [editModal,setEditModal]=useState(null);
  const [closeModal,setCloseModal]=useState(null);
  const [showClosePicker,setShowClosePicker]=useState(false);

  const toggle=id=>setExpanded(e=>({...e,[id]:!e[id]}));
  const toggleRental=id=>update(d=>({...d,properties:d.properties.map(p=>p.id===id?{...p,isRental:!p.isRental}:p)}));

  const handleMarkSold=(prop,soldDate,dispositions,closingData,isRental)=>{
    const activeLoans=prop.loans.filter(l=>!l.endDate);
    const newUnassigned=[];const newLoansForProps={};
    activeLoans.forEach(loan=>{
      const d=dispositions[loan.id];if(!d||d.type==="paidOut")return;
      let np;
      if(d.type==="rollFull")np=Math.round(calcBalance(loan,soldDate));
      else if(d.type==="rollPrincipal")np=loan.principal;
      else if(d.type==="payInterest")np=loan.principal;
      else if(d.type==="waiveInterest")np=loan.principal;
      else if(d.type==="custom")np=parseFloat(d.customRolling)||0;
      else np=loan.principal;
      const entry={id:uid(),lenderName:loan.lenderName,loanType:loan.loanType,principal:np,startDate:d.newStartDate||soldDate,interestRate:d.newRate!==""?parseFloat(d.newRate):(loan.interestRate||0),interestType:d.interestType||loan.interestType||"percentage",paymentType:d.paymentType||loan.paymentType||"closing",specialTerms:d.specialTerms||loan.specialTerms||"",endDate:null};
      if(d.destination==="unassigned"){newUnassigned.push(entry);}
      else{if(!newLoansForProps[d.destination])newLoansForProps[d.destination]=[];newLoansForProps[d.destination].push(entry);}
    });
    update(d=>({...d,
      properties:d.properties.map(p=>{
        if(p.id===prop.id)return{...p,dateSold:soldDate,isRental:isRental||false,closingData:closingData||null,loans:p.loans.map(l=>l.endDate?l:{...l,endDate:soldDate})};
        if(newLoansForProps[p.id])return{...p,loans:[...p.loans,...newLoansForProps[p.id]]};
        return p;
      }),
      unassigned:[...d.unassigned,...newUnassigned],
    }));
    setCloseModal(null);
    setShowClosePicker(false);
  };

  const handleEditSave=(prop,updates)=>{
    update(d=>({...d,
      properties:d.properties.map(p=>p.id!==prop.id?p:{...p,dateSold:updates.dateSold,isRental:updates.isRental,closingData:updates.closingData})
    }));
    setEditModal(null);
  };

  const allClosed=data.properties.filter(p=>p.dateSold);
  const flips=allClosed.filter(p=>!p.isRental);
  const rentals=allClosed.filter(p=>p.isRental);
  const activeProps=data.properties.filter(p=>!p.dateSold);
  const current=view==="flips"?flips:rentals;
  const currentDir=view==="flips"?flipSortDir:rentalSortDir;
  const setCurrentDir=view==="flips"?setFlipSortDir:setRentalSortDir;

  const applyFilter=(arr,dir)=>{
    const q=search.toLowerCase();
    const d=dir==="asc"?1:-1;
    return arr
      .filter(p=>!search||p.address?.toLowerCase().includes(q)||p.loans.some(l=>l.lenderName?.toLowerCase().includes(q)))
      .sort((a,b)=>{
        if(sortMode==="profit")return d*((a.closingData?.profit||0)-(b.closingData?.profit||0));
        if(sortMode==="address")return d*(a.address||"").localeCompare(b.address||"");
        if(sortMode==="dateAcquired"){
          const da=a.purchaseDate||(a.loans.map(l=>l.startDate).filter(Boolean).sort()[0])||"";
          const db=b.purchaseDate||(b.loans.map(l=>l.startDate).filter(Boolean).sort()[0])||"";
          return d*da.localeCompare(db);
        }
        return d*(a.dateSold||"").localeCompare(b.dateSold||"");
      });
  };

  const vis=applyFilter(current,currentDir);
  const withData=current.filter(p=>p.closingData);
  const n=withData.length||1;
  const avgC2C=Math.round(withData.reduce((s,p)=>s+(p.closingData.cashToClose||0),0)/n);
  const avgRehab=Math.round(withData.reduce((s,p)=>s+(p.closingData.rehab||0),0)/n);
  const avgProfit=Math.round(withData.reduce((s,p)=>s+(p.closingData.profit||0),0)/n);
  const totalProfit=withData.reduce((s,p)=>s+(p.closingData.profit||0),0);

  const PropCard=({prop})=>{
    const cd=prop.closingData;
    const isOpen=!!expanded[prop.id];
    const profit=cd?.profit??null;
    return(
      <div className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1C1E] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
        <div className="px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <button onClick={()=>openPanel({type:'property',propId:prop.id})} className="font-semibold text-slate-900 dark:text-zinc-100 truncate hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left">{prop.address||"Unnamed"}</button>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span className="text-[11px] text-slate-400 dark:text-zinc-500">Sold {prop.dateSold}</span>
                <button
                  onClick={e=>{e.stopPropagation();toggleRental(prop.id);}}
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full border transition-all shrink-0 whitespace-nowrap ${prop.isRental?"bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 border-purple-300 dark:border-purple-700":"bg-slate-50 dark:bg-zinc-800 text-slate-400 dark:text-zinc-500 border-slate-200 dark:border-zinc-600 hover:border-purple-300 dark:hover:border-purple-600 hover:text-purple-600 dark:hover:text-purple-400"}`}>
                  {prop.isRental?"● Rental":"○ Mark Rental"}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {cd?(
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase font-semibold">Cash to Close</div>
                    <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200 tabular-nums">{h$(cd.cashToClose||0)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase font-semibold">Rehab</div>
                    <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200 tabular-nums">{h$(cd.rehab||0)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase font-semibold">Profit</div>
                    <div className={`text-sm font-bold tabular-nums ${profit>=0?"text-emerald-600 dark:text-emerald-400":"text-red-500 dark:text-red-400"}`}>{hs(profit)}</div>
                  </div>
                </div>
              ):(
                <span className="text-xs text-slate-400 dark:text-zinc-500 italic">No data</span>
              )}
              <button onClick={()=>setEditModal(prop)}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 dark:text-zinc-600 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all text-sm" title="Edit closing">✏️</button>
              <button onClick={()=>toggle(prop.id)}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 dark:text-zinc-600 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all text-[10px] font-bold">
                {isOpen?"▲":"▼"}
              </button>
            </div>
          </div>
        </div>
        {isOpen&&(
          <div className="border-t border-black/[0.06] dark:border-white/[0.06] bg-[#F9F9FB] dark:bg-black/20 px-5 py-4">
            <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-3">Lenders</div>
            {prop.loans.length===0
              ?<div className="text-xs text-slate-400 dark:text-zinc-500">No loans recorded</div>
              :<div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest border-b border-black/[0.06] dark:border-white/[0.06]">
                    <th className="pb-1.5 text-left font-semibold">Lender</th>
                    <th className="pb-1.5 text-right font-semibold">Amount</th>
                    <th className="pb-1.5 text-right font-semibold">Rate</th>
                    <th className="pb-1.5 text-right font-semibold">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.04] dark:divide-white/[0.04]">
                  {prop.loans.map(l=>(
                    <tr key={l.id}>
                      <td className="py-2 font-semibold text-slate-800 dark:text-zinc-100"><button onClick={()=>openPanel({type:'lender',name:l.lenderName})} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left">{hn(l.lenderName)}</button></td>
                      <td className="py-2 text-right tabular-nums text-slate-700 dark:text-zinc-200">{h$(l.principal)}</td>
                      <td className="py-2 text-right tabular-nums text-slate-500 dark:text-zinc-400">{hr(l)}</td>
                      <td className="py-2 text-right"><TypeLabel type={l.loanType}/></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            }
          </div>
        )}
      </div>
    );
  };

  return(
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Closed Deals</h2>
        </div>
        <div className="relative">
          <button onClick={()=>setShowClosePicker(v=>!v)}
            className="text-[12px] font-semibold text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 rounded-xl px-3.5 py-2 transition-colors whitespace-nowrap shadow-sm">
            + Close a Property
          </button>
          {showClosePicker&&(
            <div className="absolute right-0 top-full mt-2 bg-white dark:bg-[#2C2C2E] rounded-2xl shadow-2xl border border-black/[0.08] dark:border-white/[0.08] z-30 min-w-[220px] overflow-hidden">
              {activeProps.length===0?(
                <div className="px-4 py-3 text-sm text-slate-400 dark:text-zinc-500 text-center">No active properties to close</div>
              ):(
                <>
                  <div className="px-4 pt-3 pb-1.5 text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Pick a property to close</div>
                  {activeProps.map(p=>(
                    <button key={p.id} onClick={()=>{setCloseModal(p);setShowClosePicker(false);}}
                      className="w-full text-left px-4 py-2.5 text-sm font-medium text-slate-800 dark:text-zinc-100 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors border-t border-black/[0.04] dark:border-white/[0.04] first:border-t-0">
                      {p.address||"Unnamed Property"}
                    </button>
                  ))}
                </>
              )}
              <div className="border-t border-black/[0.06] dark:border-white/[0.06]">
                <button onClick={()=>setShowClosePicker(false)}
                  className="w-full text-center px-4 py-2.5 text-xs font-semibold text-slate-400 dark:text-zinc-500 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Flip / Rental tabs */}
      <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-2xl p-1 gap-1 mb-4">
        <button onClick={()=>setView("flips")}
          className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all ${view==="flips"?"bg-white dark:bg-zinc-700 text-slate-900 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-300"}`}>
          🏠 Flips <span className="text-[11px] opacity-60 ml-1">{flips.length}</span>
        </button>
        <button onClick={()=>setView("rentals")}
          className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all ${view==="rentals"?"bg-white dark:bg-zinc-700 text-slate-900 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-300"}`}>
          🏘 Rentals <span className="text-[11px] opacity-60 ml-1">{rentals.length}</span>
        </button>
      </div>

      {/* Per-tab stats */}
      {withData.length>0&&(
        <div className="grid grid-cols-4 gap-2 mb-4">
          <div className="bg-slate-900 dark:bg-zinc-800 rounded-2xl p-4 text-center text-white">
            <div className="text-[9px] font-semibold text-slate-400 uppercase tracking-widest mb-2">{view==="flips"?"Flips":"Rentals"}</div>
            <div className="text-2xl font-bold">{withData.length}</div>
          </div>
          <div className="bg-blue-600 rounded-2xl p-4 text-center text-white">
            <div className="text-[9px] font-semibold text-blue-200 uppercase tracking-widest mb-2">Avg Cash to Close</div>
            <div className="text-xl font-bold tabular-nums">{hc(avgC2C)}</div>
          </div>
          <div className="bg-slate-700 dark:bg-zinc-700 rounded-2xl p-4 text-center text-white">
            <div className="text-[9px] font-semibold text-slate-400 uppercase tracking-widest mb-2">Avg Rehab</div>
            <div className="text-xl font-bold tabular-nums">{hc(avgRehab)}</div>
          </div>
          <div className={`${totalProfit>=0?"bg-emerald-600":"bg-red-600"} rounded-2xl p-4 text-center text-white`}>
            <div className="text-[9px] font-semibold text-white/70 uppercase tracking-widest mb-2">Avg Profit</div>
            <div className="text-xl font-bold tabular-nums">{hc(avgProfit)}</div>
            <div className="text-[10px] text-white/60 mt-1">Total {hc(totalProfit)}</div>
          </div>
        </div>
      )}

      {/* Empty states */}
      {current.length===0&&(
        <div className="text-center text-slate-400 dark:text-zinc-500 py-12 text-sm mb-4">
          {view==="flips"?"No flips closed yet.":`No rentals yet. Close a property and toggle "● Rental" to add rentals here.`}
        </div>
      )}
      {withData.length===0&&current.length>0&&(
        <div className="text-center text-slate-400 dark:text-zinc-500 py-4 text-sm mb-2">No closing data recorded yet.</div>
      )}

      {/* Sort + search */}
      {current.length>0&&(
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <SortDropdown value={sortMode} onChange={setSortMode}
            options={[["dateSold","Date Sold"],["dateAcquired","Acquired"],["profit","Profit"],["address","A–Z"]]}/>
          <button onClick={()=>setCurrentDir(d=>d==="asc"?"desc":"asc")}
            className="px-3 py-1.5 rounded-xl text-[11px] font-bold bg-white dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-all shrink-0 border border-slate-200 dark:border-zinc-700">
            {currentDir==="asc"?"↑ Asc":"↓ Desc"}
          </button>
          <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search address or lender…" className={SEARCH_CLS}/>
        </div>
      )}

      {/* List */}
      <div className="space-y-2">
        {vis.length===0&&current.length>0&&<div className="text-center text-slate-400 dark:text-zinc-500 py-8 text-sm">No results match your search.</div>}
        {vis.map(prop=><PropCard key={prop.id} prop={prop}/>)}
      </div>

      {/* Modals */}
      {editModal&&<EditClosingModal prop={editModal} onSave={updates=>handleEditSave(editModal,updates)} onClose={()=>setEditModal(null)}/>}
      {closeModal&&<MarkSoldModal prop={closeModal} allProperties={data.properties} onConfirm={(d,disp,cd,ir)=>handleMarkSold(closeModal,d,disp,cd,ir)} onClose={()=>setCloseModal(null)}/>}
    </div>
  );
}

// ─── History ──────────────────────────────────────────────────────────────────
function HistoryPage({ data }) {
  const prv=usePrivacy();
  const openPanel=usePanel();
  const h$=v=>prv?maskMoney($$(v)):$$(v);
  const hs=v=>prv?maskMoney($$s(v)):$$s(v);
  const hn=n=>n??"";
  const [view,setView]=usePersistedState("nx-histView","trail");
  const [lf,setLf]=usePersistedState("nx-histLender","all");
  const [tf,setTf]=usePersistedState("nx-histType","all");
  const [propSearch,setPropSearch]=useState("");
  const [ledgerSort,setLedgerSort]=usePersistedState("nx-ledgerSort",{col:"endDate",dir:"desc"});
  const raw=[];
  data.properties.forEach(prop=>{
    prop.loans.forEach(loan=>{
      raw.push({date:loan.startDate,sx:"b",lender:loan.lenderName,loanType:loan.loanType,interestType:loan.interestType||"percentage",etype:"start",amount:loan.principal||0,principal:loan.principal||0,property:prop.address,propId:prop.id,rate:loan.interestRate||0,loanId:loan.id});
      const end=loan.endDate||prop.dateSold;
      if(end){
        const finBal=calcBalance(loan,end);
        const disp=prop.closingData?.lenderPayoffs?.find(lp=>lp.loanId===loan.id);
        const rollingTypes=["rollFull","rollPrincipal","payInterest","waiveInterest","custom"];
        const isRoll=disp&&rollingTypes.includes(disp.type);
        const etype=isRoll?"rolled":(prop.dateSold&&!loan.endDate?"sold":"closed");
        // waiveInterest: interest forgiven, principal unchanged — show principal only as amount
        const dispAmt=disp?.type==="waiveInterest"?loan.principal:finBal;
        raw.push({date:end,sx:"a",lender:loan.lenderName,loanType:loan.loanType,interestType:loan.interestType||"percentage",etype,disposition:disp?.type||null,amount:dispAmt,principal:loan.principal||0,interest:finBal-(loan.principal||0),property:prop.address,propId:prop.id,rate:loan.interestRate||0,loanId:loan.id});
      }
    });
    if(prop.dateSold&&prop.closingData){
      raw.push({date:prop.dateSold,sx:"c",etype:"saleSummary",property:prop.address,propId:prop.id,closingData:prop.closingData,loanId:`sale-${prop.id}`});
    }
  });
  // Detect implicit rollovers: loan closed → same lender starts next day (no explicit disposition)
  const startMap={};
  raw.forEach(ev=>{if(ev.etype==="start"&&ev.lender)startMap[`${ev.lender}||${ev.date}`]=ev;});
  raw.forEach(ev=>{
    if((ev.etype!=="closed"&&ev.etype!=="sold")||ev.disposition||!ev.lender)return;
    const follow=startMap[`${ev.lender}||${nextDay(ev.date)}`]||startMap[`${ev.lender}||${ev.date}`];
    if(!follow)return;
    const aBalance=ev.amount,aPrin=ev.principal,bPrin=follow.amount;
    const disposition=Math.abs(bPrin-aBalance)<1?"rollFull":Math.abs(bPrin-aPrin)<1?"rollPrincipal":"custom";
    ev.etype="rolled";ev.disposition=disposition;ev._implicitRoll=true;
  });
  raw.sort((a,b)=>((a.date||"")+a.sx).localeCompare((b.date||"")+b.sx));
  const lp={},lc={};
  const events=raw.map(ev=>{
    lp[ev.lender]=lp[ev.lender]??0;lc[ev.lender]=lc[ev.lender]??0;
    let nc,pp;
    if(ev.etype==="saleSummary"){nc=ev.closingData?.profit??0;}
    else if(ev.etype==="start"){lc[ev.lender]+=ev.amount;pp=lp[ev.lender];nc=pp>0?ev.amount-pp:ev.amount;lp[ev.lender]=0;}
    else{
      const waived=ev.disposition==="waiveInterest";
      if(ev.etype==="rolled"){
        nc=0; // principal continues into next loan, no cash leaves the system
        lp[ev.lender]+=(waived?ev.principal:ev.amount);
      } else {
        nc=-(ev.principal||0); // principal returned to lender (negative = cash out)
      }
    }
    return{...ev,nc,pp,cumLent:lc[ev.lender]};
  });
  const allL=[...new Set(events.map(e=>e.lender))].sort();
  const filtered=events.filter(e=>{
    if(lf!=="all"&&e.lender!==lf)return false;
    if(tf!=="all"&&e.loanType!==tf)return false;
    if(!propSearch)return true;
    const q=propSearch.toLowerCase();
    return[e.property,e.lender,e.date,e.etype,e.loanType,e.disposition,e.interestType].filter(Boolean).join(" ").toLowerCase().includes(q);
  });
  const cfg={
    start:       {label:"Loan Started",  icon:"↙", cls:"bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400"},
    closed:      {label:"Paid Back",     icon:"↗", cls:"bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400"},
    sold:        {label:"Paid Back",     icon:"↗", cls:"bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400"},
    saleSummary: {label:"Sale Closed",   icon:"🏡",cls:"bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"},
    rolled:      {label:"Rolled",        icon:"🔄",cls:"bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400"},
  };
  const rollLabel={rollFull:"Rolled Full",rollPrincipal:"Principal Rolled",payInterest:"Interest Paid — Rolled",waiveInterest:"Interest Waived — Rolled",custom:"Partial Roll"};
  const rollingTypes=["rollFull","rollPrincipal","payInterest","waiveInterest","custom"];
  const closedLoans=[];
  data.properties.forEach(prop=>{
    prop.loans.forEach(loan=>{
      const endDate=loan.endDate||prop.dateSold;
      if(!endDate)return;
      const disp=prop.closingData?.lenderPayoffs?.find(lp=>lp.loanId===loan.id);
      const isRoll=disp&&rollingTypes.includes(disp.type);
      const finBal=calcBalance(loan,endDate);
      closedLoans.push({
        id:loan.id,lenderName:loan.lenderName,property:prop.address,propId:prop.id,loanType:loan.loanType,
        principal:loan.principal||0,rate:loan.interestRate||0,interestType:loan.interestType||"percentage",
        startDate:loan.startDate||"",endDate,
        days:daysBetween(loan.startDate,endDate),
        interestEarned:Math.max(0,finBal-(loan.principal||0)),
        disposition:isRoll?(disp.type):(prop.dateSold&&!loan.endDate?"sold":"closed"),
        dispLabel:isRoll?(rollLabel[disp.type]||"Rolled"):(prop.dateSold&&!loan.endDate?"Paid at Sale":"Paid Back"),
      });
    });
  });
  const allLedgerLenders=[...new Set(closedLoans.map(l=>l.lenderName))].sort();
  const ledgerFiltered=closedLoans.filter(l=>{
    if(lf!=="all"&&l.lenderName!==lf)return false;
    if(tf!=="all"&&l.loanType!==tf)return false;
    return true;
  });
  const sortFn=(a,b)=>{
    const d=ledgerSort.dir==="asc"?1:-1;
    const col=ledgerSort.col;
    if(col==="lenderName")return d*(a.lenderName||"").localeCompare(b.lenderName||"");
    if(col==="property")return d*(a.property||"").localeCompare(b.property||"");
    if(col==="principal")return d*(a.principal-b.principal);
    if(col==="days")return d*(a.days-b.days);
    if(col==="interest")return d*(a.interestEarned-b.interestEarned);
    return d*(a.endDate||"").localeCompare(b.endDate||"");
  };
  const ledgerRows=[...ledgerFiltered].sort(sortFn);
  const toggleSort=col=>setLedgerSort(s=>s.col===col?{col,dir:s.dir==="asc"?"desc":"asc"}:{col,dir:"desc"});
  const SortHd=({col,label})=>{
    const active=ledgerSort.col===col;
    return<button onClick={()=>toggleSort(col)} className={`text-left text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded transition-colors ${active?"text-blue-600 dark:text-blue-400":"text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300"}`}>{label}{active?(ledgerSort.dir==="desc"?" ↓":" ↑"):""}</button>;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">History</h2>
        <span className="text-xs font-semibold text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 px-2.5 py-1 rounded-full">{view==="trail"?`${filtered.length} events`:`${ledgerRows.length} loans`}</span>
      </div>
      <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-xl p-1 mb-4 self-start gap-1">
        {[["trail","📋 Money Trail"],["ledger","🗂 Loan Ledger"]].map(([v,l])=>(
          <button key={v} onClick={()=>setView(v)}
            className={`flex-1 px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${view===v?"bg-white dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300"}`}>
            {l}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <select value={lf} onChange={e=>setLf(e.target.value)}
          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="all">All Lenders</option>
          {(view==="trail"?allL:allLedgerLenders).map((l,i)=><option key={l} value={l}>{prv?`Lender ${i+1}`:l}</option>)}
        </select>
        <select value={tf} onChange={e=>setTf(e.target.value)}
          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="all">All Types</option><option value="private">Private</option><option value="hard">Hard</option>
        </select>
        {view==="trail"&&<input type="text" value={propSearch} onChange={e=>setPropSearch(e.target.value)}
          placeholder="Search address, lender, date…" className={SEARCH_CLS}/>}
      </div>
      {view==="ledger"&&(
        <div>
          {!ledgerRows.length&&<div className="text-center py-16 text-slate-400 dark:text-zinc-500"><div className="text-5xl mb-3">🗂</div><p className="font-semibold">No closed loans yet</p></div>}
          {ledgerRows.length>0&&(
            <div className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1C1E] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
              <div className="grid grid-cols-[1fr_1fr_auto_auto_auto_auto] gap-x-3 px-5 py-2 border-b border-black/[0.06] dark:border-white/[0.06] bg-slate-50 dark:bg-zinc-800/50">
                <SortHd col="lenderName" label="Lender"/>
                <SortHd col="property" label="Property"/>
                <SortHd col="endDate" label="Dates"/>
                <SortHd col="principal" label="Principal"/>
                <SortHd col="interest" label="Interest"/>
                <SortHd col="days" label="Days"/>
              </div>
              <div className="divide-y divide-black/[0.05] dark:divide-white/[0.05]">
                {ledgerRows.map(l=>{
                  const dispCls=l.disposition==="closed"||l.disposition==="sold"
                    ?"text-slate-500 dark:text-zinc-400 bg-slate-100 dark:bg-zinc-800"
                    :"text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30";
                  const rateLabel=l.interestType==="fixed"?"$"+Math.round(l.rate).toLocaleString()+" fixed":l.rate+"%/yr";
                  return(
                    <div key={l.id} className="grid grid-cols-[1fr_1fr_auto_auto_auto_auto] gap-x-3 px-5 py-3.5 items-center hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button onClick={()=>openPanel?.({type:'lender',name:l.lenderName})} className="font-semibold text-slate-900 dark:text-zinc-100 text-sm hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left">{hn(l.lenderName)}</button>
                          <TypeLabel type={l.loanType}/>
                        </div>
                        <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">{rateLabel}</div>
                      </div>
                      <div className="text-sm text-slate-600 dark:text-zinc-300 truncate"><button onClick={()=>openPanel?.({type:'property',id:l.propId})} className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left truncate max-w-full block">{l.property}</button></div>
                      <div className="text-right">
                        <div className="text-xs font-mono text-slate-500 dark:text-zinc-400">{l.startDate}</div>
                        <div className="text-[10px] text-slate-300 dark:text-zinc-600">↓</div>
                        <div className="text-xs font-mono text-slate-500 dark:text-zinc-400">{l.endDate}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-semibold text-slate-900 dark:text-zinc-100 text-sm tabular-nums">{h$(l.principal)}</div>
                      </div>
                      <div className="text-right">
                        {l.interestEarned>0.01
                          ?<div className="text-sm font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">+{h$(l.interestEarned)}</div>
                          :<div className="text-sm text-amber-500 dark:text-amber-400">waived</div>}
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200 tabular-nums">{l.days}d</div>
                        <div className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full mt-1 ${dispCls}`}>{l.dispLabel}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="px-5 py-3 bg-slate-50 dark:bg-zinc-800/50 border-t border-black/[0.06] dark:border-white/[0.06] flex justify-between items-center">
                <span className="text-xs text-slate-400 dark:text-zinc-500">{ledgerRows.length} closed loan{ledgerRows.length!==1?"s":""}</span>
                <div className="flex gap-6 text-right">
                  <div><div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Total Principal</div><div className="font-bold text-slate-900 dark:text-zinc-100 tabular-nums">{h$(ledgerRows.reduce((s,l)=>s+l.principal,0))}</div></div>
                  <div><div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Total Interest</div><div className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">+{h$(ledgerRows.reduce((s,l)=>s+l.interestEarned,0))}</div></div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {view==="trail"&&<>
      {!filtered.length&&<div className="text-center py-16 text-slate-400 dark:text-zinc-500"><div className="text-5xl mb-3">📋</div><p className="font-semibold">No transactions yet</p></div>}
      <div className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1C1E] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none divide-y divide-black/[0.05] dark:divide-white/[0.05]">
        {[...filtered].reverse().map((ev,i)=>{
          const c=cfg[ev.etype]??cfg.closed;const pos=ev.nc>=0;const roll=ev.etype==="start"&&ev.pp>0;
          const rateLabel=ev.interestType==="fixed"?"$"+Math.round(ev.rate).toLocaleString()+" fixed":ev.rate+"%/yr";
          if(ev.etype==="saleSummary"){
            const cd=ev.closingData;
            const lenderPrincipals=(cd.lenderPayoffs||[]).reduce((s,lp)=>s+(lp.principalPayoff||0),0);
            const nexusFunded=Math.max(0,(cd.totalCosts||0)-lenderPrincipals);
            const wireLenders=(cd.lenderPayoffs||[]).filter(lp=>(lp.wireAmount||0)>0.01);
            const profitAtClose=(cd.profit||0)-(cd.overageRefund||0);
            return(
              <div key={ev.loanId} className="bg-blue-50/70 dark:bg-blue-950/15 border-l-4 border-blue-400 dark:border-blue-500 px-5 py-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">🏡</span>
                  <div>
                    <div className="font-bold text-blue-900 dark:text-blue-100">Sale Closed — <button onClick={()=>ev.propId&&openPanel?.({type:'property',id:ev.propId})} className="hover:underline text-left">{ev.property}</button></div>
                    <div className="text-xs text-blue-500 dark:text-blue-400">{ev.date} · For Bookkeepers</div>
                  </div>
                  <div className="ml-auto text-right">
                    <div className="text-[10px] text-blue-400 dark:text-blue-500 uppercase font-semibold">Wire Received</div>
                    <div className="font-bold text-xl text-blue-700 dark:text-blue-300 tabular-nums">{h$(cd.wire)}</div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div className="bg-black/[0.02] dark:bg-white/[0.04] rounded-xl p-3 space-y-1.5">
                    <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Total Disbursed</div>
                    {cd.cashToClose>0&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Cash to Close</span><span className="tabular-nums">{h$(cd.cashToClose)}</span></div>}
                    {cd.rehab>0&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Rehab</span><span className="tabular-nums">{h$(cd.rehab)}</span></div>}
                    {cd.moneyCosts>0&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Money Costs</span><span className="tabular-nums">{h$(cd.moneyCosts)}</span></div>}
                    {cd.misc>0&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Misc / Holding</span><span className="tabular-nums">{h$(cd.misc)}</span></div>}
                    <div className="flex justify-between font-bold text-slate-900 dark:text-zinc-100 border-t border-black/[0.06] dark:border-white/[0.06] pt-1.5 mt-0.5"><span>Total</span><span className="tabular-nums">{h$(cd.totalCosts)}</span></div>
                  </div>
                  <div className="bg-black/[0.02] dark:bg-white/[0.04] rounded-xl p-3 space-y-1.5">
                    <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Funded By</div>
                    {(cd.lenderPayoffs||[]).map(lp=>(
                      <div key={lp.loanId} className="flex justify-between text-slate-600 dark:text-zinc-300">
                        <span className="truncate mr-1">{lp.lenderName}{lp.type==="waiveInterest"&&<span className="text-amber-500 dark:text-amber-400 ml-1 text-[10px]">(waived int.)</span>}{lp.type==="alreadyPaid"&&<span className="text-orange-500 dark:text-orange-400 ml-1 text-[10px]">(paid early)</span>}</span>
                        <span className="tabular-nums shrink-0">{h$(lp.principalPayoff)}</span>
                      </div>
                    ))}
                    {nexusFunded>0.01&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Nexus Capital</span><span className="tabular-nums">{h$(nexusFunded)}</span></div>}
                    <div className="flex justify-between font-bold text-slate-900 dark:text-zinc-100 border-t border-black/[0.06] dark:border-white/[0.06] pt-1.5 mt-0.5"><span>Total</span><span className="tabular-nums">{h$(cd.totalCosts)}</span></div>
                  </div>
                  <div className="bg-black/[0.02] dark:bg-white/[0.04] rounded-xl p-3 space-y-1.5">
                    <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Wire Breakdown</div>
                    {wireLenders.map(lp=>(
                      <div key={lp.loanId} className="flex justify-between text-slate-600 dark:text-zinc-300">
                        <span className="truncate mr-1">{lp.lenderName}</span>
                        <span className="tabular-nums shrink-0">{h$(lp.wireAmount)}</span>
                      </div>
                    ))}
                    {(cd.selfFunded||0)>0.01&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Nexus Capital</span><span className="tabular-nums">{h$(cd.selfFunded)}</span></div>}
                    <div className="flex justify-between font-semibold text-emerald-600 dark:text-emerald-400">
                      <span>Profit</span>
                      <span className="tabular-nums">{h$(profitAtClose)}</span>
                    </div>
                    {(cd.overageRefund||0)>0.01&&(
                      <div className="flex justify-between text-amber-600 dark:text-amber-400 text-[10px]">
                        <span>+ Overage refund <span className="opacity-70">(post-close)</span></span>
                        <span className="tabular-nums">{h$(cd.overageRefund)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-bold text-blue-700 dark:text-blue-300 border-t border-black/[0.06] dark:border-white/[0.06] pt-1.5 mt-0.5"><span>= Wire</span><span className="tabular-nums">{h$(cd.wire)}</span></div>
                  </div>
                </div>
              </div>
            );
          }
          return(
            <div key={`${ev.loanId}-${ev.etype}-${i}`} className="flex items-start gap-3 px-5 py-4 bg-white dark:bg-[#1C1C1E] hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm shrink-0 mt-0.5 ${c.cls}`}>{c.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                      <span className="font-mono text-[10px] text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 rounded-md px-1.5 py-0.5">{ev.date}</span>
                      <span className={`text-[10px] font-semibold uppercase ${c.cls} rounded-full px-2 py-0.5`}>{ev.etype==="rolled"?(rollLabel[ev.disposition]||"Rolled"):c.label}</span>
                      <TypeLabel type={ev.loanType}/>
                      {roll&&<span className="text-[10px] font-semibold text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30 rounded-full px-2 py-0.5">Rollover</span>}
                    </div>
                    <button onClick={()=>ev.lender&&openPanel?.({type:'lender',name:ev.lender})} className="font-bold text-slate-900 dark:text-zinc-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left">{hn(ev.lender)}</button>
                    <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5"><button onClick={()=>ev.propId&&openPanel?.({type:'property',id:ev.propId})} className={`${ev.propId?"hover:text-blue-600 dark:hover:text-blue-400 transition-colors":""} text-left`}>{ev.property}</button> · {rateLabel}</div>
                    {ev.etype!=="start"&&(ev.interest||0)>0.01&&(
                      ev.disposition==="waiveInterest"?(
                        <div className="text-xs text-amber-500 dark:text-amber-400 mt-0.5 tabular-nums">{h$(ev.interest)} interest waived</div>
                      ):ev.etype==="rolled"?(
                        <div className="text-xs text-violet-500 dark:text-violet-400 mt-0.5 tabular-nums">{h$(ev.interest)} interest rolled in</div>
                      ):(
                        <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5 tabular-nums">incl. {h$(ev.interest)} interest earned</div>
                      )
                    )}
                    {roll&&ev.pp>0&&<div className="text-xs text-violet-500 dark:text-violet-400 mt-0.5 tabular-nums">Rolled from {h$(ev.pp)}</div>}
                  </div>
                  <div className="text-right shrink-0 min-w-[90px]">
                    {ev.etype==="start"?(
                      <>
                        <div className="font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">+{h$(ev.amount)}</div>
                        {ev.nc>0
                          ?<div className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{hs(ev.nc)}</div>
                          :<div className="text-sm font-bold tabular-nums text-violet-500 dark:text-violet-400">→ Rollover</div>
                        }
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase tracking-wide">{ev.nc>0?"lent in":"no new funds"}</div>
                      </>
                    ):ev.etype==="rolled"?(
                      <>
                        <div className="font-bold text-slate-900 dark:text-zinc-100 tabular-nums">{h$(ev.amount)}</div>
                        <div className="text-sm font-bold tabular-nums text-violet-500 dark:text-violet-400">→ Continues</div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase tracking-wide">no cash out</div>
                      </>
                    ):(
                      <>
                        <div className="font-bold text-red-600 dark:text-red-400 tabular-nums">−{h$(ev.amount)}</div>
                        <div className="text-sm font-bold tabular-nums text-red-500 dark:text-red-400">{hs(ev.nc)}</div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase tracking-wide">returned</div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {filtered.length>0&&(()=>{
        const principalNet=filtered.reduce((s,e)=>e.etype==="saleSummary"?s:s+(e.nc||0),0);
        return(
          <div className="mt-3 rounded-2xl bg-white dark:bg-[#1C1C1E] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none px-5 py-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Net Outstanding{lf!=="all"?` — ${lf}`:""}</div>
              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5">Sum of principal in/out for events shown above</div>
            </div>
            <div className={`text-2xl font-bold tabular-nums ${principalNet>=0?"text-emerald-600 dark:text-emerald-400":"text-red-600 dark:text-red-400"}`}>{hs(principalNet)}</div>
          </div>
        );
      })()}
      </>}
    </div>
  );
}

// ─── Rehab Priority ───────────────────────────────────────────────────────────
function RehabPriorityPage({ data, update }) {
  const prv=usePrivacy();
  const h$=v=>prv?maskMoney($$(v)):$$(v);
  const [dir,setDir]=usePersistedState("nx-rehabDir","desc");
  const [rehabSearch,setRehabSearch]=useState("");
  const [projectFull,setProjectFull]=usePersistedState("nx-rehabProject",false);
  const [avgDaysBehind,setAvgDaysBehind]=usePersistedState("nx-rehabDaysBehind","");
  // Stored in Supabase so all sessions/devices stay in sync
  const rollingLoans=data.rollingLoans||[];
  const PROJ_RATE=14;

  const toggleRolling=id=>update(d=>({
    ...d,
    rollingLoans:(d.rollingLoans||[]).includes(id)
      ?(d.rollingLoans||[]).filter(x=>x!==id)
      :[...(d.rollingLoans||[]),id]
  }));

  // Hard money always exits at sale and counts toward burn.
  // Private money defaults to exiting (counts) unless marked rolling. Fixed-fee = no monthly cost.
  const monthlyBurn=loan=>{
    if(loan.endDate)return 0;
    if(loan.interestType==="fixed")return 0;
    if(loan.loanType==="private"&&rollingLoans.includes(loan.id))return 0;
    const pt=loan.paymentType||"closing";
    if(pt==="monthly_fixed")return Math.round(loan.monthlyPayment||0);
    return Math.round((loan.principal||0)*(loan.interestRate||0)/100/12);
  };

  const rows=data.properties
    .filter(p=>!p.dateSold)
    .map(prop=>{
      const active=prop.loans.filter(l=>!l.endDate);
      const burn=active.reduce((s,l)=>s+monthlyBurn(l),0);
      const funded=active.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);
      const needed=propNeeded(prop,active);
      const gap=Math.max(0,needed-funded);
      const projBurn=projectFull&&gap>0?Math.round(gap*PROJ_RATE/100/12):0;
      const totalBurn=burn+projBurn;
      const daysOwned=prop.purchaseDate?daysBetween(prop.purchaseDate,TODAY):null;
      return{prop,active,burn,projBurn,totalBurn,gap,needed,funded,daysOwned};
    })
    .sort((a,b)=>dir==="desc"?b.totalBurn-a.totalBurn:a.totalBurn-b.totalBurn)
    .filter(r=>!rehabSearch||r.prop.address?.toLowerCase().includes(rehabSearch.toLowerCase()));

  const grandTotal=rows.reduce((s,r)=>s+r.totalBurn,0);
  const daysNum=parseFloat(avgDaysBehind)||0;
  const extraFromDelay=daysNum!==0?Math.round(grandTotal*(daysNum/30.44)):0;
  const extraPerYear=Math.round(extraFromDelay*12);

  return(
    <div>
      <div className="flex justify-between items-center mb-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Rehab Priority</h2>
        </div>
        {grandTotal>0&&<span className="text-xs font-semibold text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 px-2.5 py-1 rounded-full">{h$(grandTotal)}/mo total</span>}
      </div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button onClick={()=>setDir(d=>d==="desc"?"asc":"desc")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-all border border-slate-200 dark:border-zinc-700">
          {dir==="desc"?"Highest First ↓":"Lowest First ↑"}
        </button>
        <input type="text" value={rehabSearch} onChange={e=>setRehabSearch(e.target.value)}
          placeholder="Search by address…" className={SEARCH_CLS}/>
      </div>

      {/* Project fully funded toggle */}
      <label className={`flex items-center gap-3 px-4 py-3 mb-4 rounded-2xl cursor-pointer transition-colors ${projectFull?"bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800":"bg-white dark:bg-[#1C1C1E] shadow-[0_1px_6px_rgba(0,0,0,0.06)] dark:shadow-none border border-transparent"}`}>
        <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${projectFull?"bg-blue-600 border-blue-600":"border-slate-300 dark:border-zinc-600"}`}
          onClick={()=>setProjectFull(p=>!p)}>
          {projectFull&&<svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
        </div>
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-zinc-100">Project fully funded at {PROJ_RATE}%</div>
          <div className="text-[11px] text-slate-400 dark:text-zinc-500">Fill any funding gap with a hypothetical {PROJ_RATE}% loan to see true worst-case monthly cost</div>
        </div>
      </label>

      {/* Average delay input + cost impact */}
      <div className={`px-4 py-3 mb-4 rounded-2xl bg-white dark:bg-[#1C1C1E] shadow-[0_1px_6px_rgba(0,0,0,0.06)] dark:shadow-none`}>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-sm font-semibold text-slate-800 dark:text-zinc-100 mb-0.5">Average days behind schedule</div>
            <div className="text-[11px] text-slate-400 dark:text-zinc-500">How far behind are rehabs running on average?</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input type="number" value={avgDaysBehind}
              onChange={e=>setAvgDaysBehind(e.target.value)}
              onWheel={e=>e.target.blur()}
              placeholder="0"
              className="w-20 text-right border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-3 py-2 text-sm font-semibold text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-400 tabular-nums"/>
            <span className="text-sm text-slate-400 dark:text-zinc-500">days</span>
          </div>
        </div>
        {extraFromDelay!==0&&(()=>{
          const ahead=daysNum<0;
          const tileClx=ahead?"bg-emerald-50 dark:bg-emerald-900/20":"bg-red-50 dark:bg-red-900/20";
          const labelClx=ahead?"text-emerald-600 dark:text-emerald-400":"text-red-500 dark:text-red-400";
          const valClx=ahead?"text-emerald-700 dark:text-emerald-400":"text-red-600 dark:text-red-400";
          const absDays=Math.abs(daysNum);
          return(
            <div className="mt-3 pt-3 border-t border-slate-100 dark:border-zinc-800 grid grid-cols-2 gap-3">
              <div className={`rounded-xl px-3 py-2.5 ${tileClx}`}>
                <div className={`text-[10px] font-semibold uppercase tracking-widest mb-1 ${labelClx}`}>{ahead?`Saved from ${absDays}d ahead`:`Extra from ${absDays}d delay`}</div>
                <div className={`text-lg font-bold tabular-nums ${valClx}`}>{ahead?"−":""}{h$(Math.abs(extraFromDelay))}</div>
              </div>
              <div className={`rounded-xl px-3 py-2.5 ${tileClx}`}>
                <div className={`text-[10px] font-semibold uppercase tracking-widest mb-1 ${labelClx}`}>{ahead?"Annualized savings":"Annualized at this slippage"}</div>
                <div className={`text-lg font-bold tabular-nums ${valClx}`}>{ahead?"−":""}{h$(Math.abs(extraPerYear))}/yr</div>
              </div>
            </div>
          );
        })()}
      </div>

      {rows.length===0&&<div className="text-center py-16 text-slate-400 dark:text-zinc-500"><div className="text-5xl mb-3">🔥</div><p className="font-semibold">No active properties</p></div>}

      <div className="space-y-3">
        {rows.map(({prop,active,burn,projBurn,totalBurn,gap,funded,needed,daysOwned},i)=>{
          const rankColor=i===0?"text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20":i===1?"text-orange-500 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20":i===2?"text-amber-500 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20":"text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800";
          const burnColor=i===0?"text-red-600 dark:text-red-400":i===1?"text-orange-500 dark:text-orange-400":i===2?"text-amber-500 dark:text-amber-400":"text-slate-600 dark:text-zinc-300";
          const fundedPct=needed>0?Math.min(100,Math.round(funded/needed*100)):0;
          const gapPct=needed>0?Math.min(100-fundedPct,Math.round(gap/needed*100)):0;
          const dailyBurn=Math.round(totalBurn/30.4);
          return(
            <div key={prop.id} className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1C1E] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
              <div className="px-5 py-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-start gap-3">
                    <span className={`text-xs font-bold w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${rankColor}`}>#{i+1}</span>
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-zinc-100">{prop.address||"Unnamed Property"}</div>
                      <div className="flex flex-wrap gap-2 mt-1 text-[11px] text-slate-400 dark:text-zinc-500">
                        {daysOwned!==null&&<span className={`font-medium ${daysOwned>90?"text-red-500 dark:text-red-400":daysOwned>60?"text-amber-500 dark:text-amber-400":"text-slate-400 dark:text-zinc-500"}`}>{daysOwned}d owned</span>}
                        {dailyBurn>0&&<span>{h$(dailyBurn)}/day</span>}
                        <span>{active.length} active loan{active.length!==1?"s":""}</span>
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {totalBurn>0?(
                      <>
                        <div className={`text-2xl font-bold tabular-nums ${burnColor}`}>{h$(totalBurn)}</div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest mt-0.5">per month</div>
                      </>
                    ):<div className="text-sm text-slate-300 dark:text-zinc-600 font-semibold">No carry cost</div>}
                  </div>
                </div>
                {needed>0&&(
                  <div className="mb-2">
                    <div className="h-1.5 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden mb-1 relative">
                      <div className="absolute left-0 top-0 h-full bg-emerald-500 dark:bg-emerald-500 rounded-full transition-all" style={{width:`${fundedPct}%`}}/>
                      {projectFull&&gapPct>0&&<div className="absolute top-0 h-full bg-blue-300 dark:bg-blue-600 rounded-r-full transition-all" style={{left:`${fundedPct}%`,width:`${gapPct}%`}}/>}
                    </div>
                    <div className="flex justify-between text-[10px]">
                      <span className={`tabular-nums font-medium ${gap>0?"text-red-500 dark:text-red-400":"text-emerald-600 dark:text-emerald-400"}`}>{h$(funded)} funded{gap>0?` · ${h$(gap)} short`:` · ✓ Full`}</span>
                      <span className="text-slate-400 dark:text-zinc-500 tabular-nums">{h$(needed)} needed</span>
                    </div>
                  </div>
                )}
                {active.length>0&&(
                  <div className="space-y-1 mt-1">
                    {/* Column header for the roll checkbox */}
                    <div className="flex justify-end pr-0.5 mb-0.5">
                      <span className="text-[10px] text-slate-400 dark:text-zinc-500">roll?</span>
                    </div>
                    {active.map(loan=>{
                      const lb=monthlyBurn(loan);
                      const isPrivate=loan.loanType==="private";
                      const isRolling=isPrivate&&rollingLoans.includes(loan.id);
                      return(
                        <div key={loan.id} className="flex items-center justify-between text-[11px]">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <TypeLabel type={loan.loanType}/>
                            <span className={`font-medium truncate ${isRolling?"text-slate-400 dark:text-zinc-500":"text-slate-600 dark:text-zinc-300"}`}>{prv?"—":loan.lenderName}</span>
                            <span className="text-slate-400 dark:text-zinc-500 shrink-0">{h$(loan.principal)} · {loan.interestRate}%</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-2">
                            {lb>0?(
                              <span className={`font-semibold tabular-nums ${burnColor}`}>{h$(lb)}/mo</span>
                            ):isRolling?(
                              <span className="text-slate-400 dark:text-zinc-500 text-[10px] italic">↻ rolling</span>
                            ):(
                              <span className="text-slate-300 dark:text-zinc-600 text-[10px]">flat fee</span>
                            )}
                            {isPrivate?(
                              <button onClick={()=>toggleRolling(loan.id)}
                                className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${rollingLoans.includes(loan.id)?"bg-violet-500 border-violet-500":"border-slate-300 dark:border-zinc-600"}`}>
                                {rollingLoans.includes(loan.id)&&<svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                              </button>
                            ):(
                              <div className="w-4"/>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {projectFull&&projBurn>0&&(
                      <div className="flex items-center justify-between text-[11px] border-t border-dashed border-blue-200 dark:border-blue-800 pt-1 mt-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold text-blue-500 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded px-1.5 py-0.5">projected</span>
                          <span className="text-blue-500 dark:text-blue-400">{h$(gap)} gap @ {PROJ_RATE}%/yr</span>
                        </div>
                        <span className="font-semibold tabular-nums text-blue-500 dark:text-blue-400">+{h$(projBurn)}/mo</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Close Lender Loans Modal ────────────────────────────────────────────────
function CloseLenderModal({ data, update, onClose }) {
  const [lenderName, setLenderName] = useState('');
  const [date, setDate] = useState(TODAY);
  const [selectedIds, setSelectedIds] = useState([]);

  const allActiveLoans = [
    ...(data.properties||[]).filter(p=>!p.dateSold).flatMap(p=>
      (p.loans||[]).filter(l=>!l.endDate).map(l=>({...l,propAddress:p.address,propId:p.id}))
    ),
    ...(data.unassigned||[]).filter(l=>!l.endDate).map(l=>({...l,propAddress:null,propId:null}))
  ];
  const lenderNames=[...new Set(allActiveLoans.map(l=>l.lenderName).filter(Boolean))].sort();
  const lenderLoans=allActiveLoans.filter(l=>l.lenderName===lenderName);
  const allSelected=lenderLoans.length>0&&selectedIds.length===lenderLoans.length;

  useEffect(()=>{
    if(lenderName) setSelectedIds(lenderLoans.map(l=>l.id));
  },[lenderName]);

  const toggle=id=>setSelectedIds(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);

  const handleClose=()=>{
    if(!date||!selectedIds.length) return;
    update(d=>({
      ...d,
      properties:d.properties.map(p=>({...p,loans:p.loans.map(l=>selectedIds.includes(l.id)?{...l,endDate:date}:l)})),
      unassigned:(d.unassigned||[]).map(l=>selectedIds.includes(l.id)?{...l,endDate:date}:l),
    }));
    onClose();
  };

  return (
    <Modal title="Close Lender Loans" onClose={onClose}>
      <Sel label="Lender" value={lenderName} onChange={v=>setLenderName(v)}
        options={[['','— select lender —'],...lenderNames.map(n=>[n,n])]}/>
      {lenderName&&lenderLoans.length===0&&(
        <p className="text-sm text-slate-400 dark:text-zinc-500 text-center py-3">No active loans for {lenderName}.</p>
      )}
      {lenderName&&lenderLoans.length>0&&(
        <>
          <DateInp label="Close Date" value={date} onChange={setDate}/>
          <div className="mt-3">
            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">
              <span>Loans to Close</span>
              <button onClick={()=>setSelectedIds(allSelected?[]:lenderLoans.map(l=>l.id))}
                className="text-blue-600 dark:text-blue-400 font-semibold text-[11px] normal-case tracking-normal">
                {allSelected?'Deselect all':'Select all'}
              </button>
            </div>
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {lenderLoans.map(l=>(
                <button key={l.id} onClick={()=>toggle(l.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all flex items-center justify-between gap-3 ${selectedIds.includes(l.id)?'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700':'bg-slate-50 dark:bg-zinc-800 border-slate-200 dark:border-zinc-700'}`}>
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-slate-800 dark:text-zinc-200 truncate">{l.propAddress||'Unassigned'}</div>
                    <div className="text-[11px] text-slate-500 dark:text-zinc-400">{$$(l.principal)} · started {l.startDate}</div>
                  </div>
                  <div className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${selectedIds.includes(l.id)?'bg-blue-500 border-blue-500':'border-slate-300 dark:border-zinc-600'}`}>
                    {selectedIds.includes(l.id)&&<span className="text-white text-[10px] leading-none">✓</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <Btn onClick={handleClose} color="red" full disabled={!selectedIds.length}>
            Close {allSelected?'All':selectedIds.length} Loan{selectedIds.length!==1?'s':''} →
          </Btn>
        </>
      )}
      <Btn onClick={onClose} color="ghost" full>Cancel</Btn>
    </Modal>
  );
}

// ─── Close Property Picker Modal ─────────────────────────────────────────────
function ClosePropertyPickerModal({ properties, onPick, onClose }) {
  const active=(properties||[]).filter(p=>!p.dateSold);
  return (
    <Modal title="Close a Property" onClose={onClose}>
      {active.length===0
        ? <><p className="text-sm text-slate-400 dark:text-zinc-500 mb-3">No active properties to close.</p><Btn onClick={onClose} color="ghost" full>Close</Btn></>
        : <>
            <p className="text-xs text-slate-400 dark:text-zinc-500 mb-3">Select the property to mark as sold:</p>
            <div className="space-y-1.5 mb-3">
              {active.map(p=>(
                <button key={p.id} onClick={()=>onPick(p)}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 border border-slate-200 dark:border-zinc-700 hover:border-blue-300 dark:hover:border-blue-700 transition-all">
                  <span className="font-medium text-[13px] text-slate-800 dark:text-zinc-200">🏠 {p.address}</span>
                </button>
              ))}
            </div>
            <Btn onClick={onClose} color="ghost" full>Cancel</Btn>
          </>
      }
    </Modal>
  );
}

// ─── Manage Lenders Page ─────────────────────────────────────────────────────
function ManageLendersPage({ data }) {
  const [lenders, setLenders] = useState(null)
  const [fetching, setFetching] = useState(true)
  const [form, setForm] = useState({ lenderName: '', email: '', password: '' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')

  const allNames = [...new Set([
    ...(data.properties || []).flatMap(p => (p.loans || []).map(l => l.lenderName)),
    ...(data.unassigned || []).map(l => l.lenderName),
  ].filter(Boolean))].sort()

  const load = () => {
    setFetching(true)
    listLenderAccounts().then(r => setLenders(r.lenders || [])).catch(e => setErr(e.message)).finally(() => setFetching(false))
  }
  useEffect(load, [])

  const handleCreate = async e => {
    e.preventDefault()
    setSaving(true); setErr(''); setOk('')
    try {
      await createLenderAccount(form)
      setOk(`Account created for ${form.lenderName} — they can now log in at this URL.`)
      setForm({ lenderName: '', email: '', password: '' })
      load()
    } catch(ex) { setErr(ex.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async (userId, name) => {
    if (!window.confirm(`Remove portal access for ${name}? They will no longer be able to log in.`)) return
    setErr('')
    try { await deleteLenderAccount(userId); load() }
    catch(ex) { setErr(ex.message) }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Accounts</h2>
      </div>
      <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] p-4">
        <div className="font-bold text-[14px] text-slate-800 dark:text-zinc-100 mb-1">Create Lender Account</div>
        <div className="text-[12px] text-slate-400 dark:text-zinc-500 mb-4">Give a lender their own login to see only their loans.</div>
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Lender Name</label>
            <select value={form.lenderName} onChange={e => setForm(f => ({...f, lenderName: e.target.value}))} required
              className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— select lender —</option>
              {allNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Email</label>
            <input type="email" value={form.email} onChange={e => setForm(f => ({...f, email: e.target.value}))} required placeholder="their@email.com"
              className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Password</label>
            <input type="text" value={form.password} onChange={e => setForm(f => ({...f, password: e.target.value}))} required placeholder="temporary password"
              className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          </div>
          {err && <p className="text-red-500 text-xs font-medium">{err}</p>}
          {ok  && <p className="text-emerald-600 dark:text-emerald-400 text-xs font-medium">{ok}</p>}
          <button type="submit" disabled={saving}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-50">
            {saving ? 'Creating…' : 'Create Account'}
          </button>
        </form>
      </div>

      <div>
        <div className="text-[13px] font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-3">
          Lender Accounts {lenders ? `(${lenders.length})` : ''}
        </div>
        {fetching ? (
          <div className="text-slate-400 dark:text-zinc-500 text-sm text-center py-8">Loading…</div>
        ) : !lenders?.length ? (
          <div className="text-slate-300 dark:text-zinc-600 text-sm text-center py-8">No lender accounts yet</div>
        ) : (
          <div className="space-y-2">
            {lenders.map(l => (
              <div key={l.id} className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-[13px] text-slate-800 dark:text-zinc-200 truncate">{l.lender_name}</div>
                  <div className="text-[11px] text-slate-400 dark:text-zinc-500 truncate">{l.email}</div>
                </div>
                <button onClick={() => handleDelete(l.auth_user_id, l.lender_name)}
                  className="shrink-0 text-[11px] font-semibold text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 transition-colors">
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Draws Page ───────────────────────────────────────────────────────────────
function DrawsPage({ data }) {
  const privacy = usePrivacy();
  const h$ = v => { const s=$$(v); return privacy?maskMoney(s):s; };
  const [drawSearch,setDrawSearch]=useState("");
  const [drawSort,setDrawSort]=usePersistedState("nx-drawSort","chance");
  const [drawSortDir,setDrawSortDir]=usePersistedState("nx-drawSortDir","desc");

  // Collect all active properties that have at least one draw-facility loan
  const rows = (data.properties||[])
    .filter(p => !p.dateSold && (!drawSearch||p.address?.toLowerCase().includes(drawSearch.toLowerCase())))
    .map(p => {
      const drawLoans = (p.loans||[]).filter(l => !l.endDate && l.drawFacility);
      if (!drawLoans.length) return null;

      // Aggregate across all draw-facility loans
      const totalCommitted = drawLoans.reduce((s,l) => s+(l.drawFacility.committed||0), 0);
      const allDraws = drawLoans.flatMap(l => (l.drawFacility.draws||[]).map(d=>({...d, lenderName:l.lenderName})));
      const totalDrawn = allDraws.reduce((s,d) => s+(d.amount||0), 0);
      const totalAvailable = Math.max(0, totalCommitted - totalDrawn);

      // Last draw date across all loans
      const drawDates = allDraws.map(d=>d.date).filter(Boolean).sort();
      const lastDrawDate = drawDates.length ? drawDates[drawDates.length-1] : null;
      const daysSinceDraw = lastDrawDate ? daysBetween(lastDrawDate, TODAY) : null;

      // "Last event" = later of last draw or purchase date (both count for 14-day window)
      const lastEventDate = [lastDrawDate, p.purchaseDate].filter(Boolean).sort().pop() ?? null;
      const daysSinceEvent = lastEventDate ? daysBetween(lastEventDate, TODAY) : null;
      const eligible = !lastEventDate || daysSinceEvent >= 14;

      return { prop: p, drawLoans, totalCommitted, totalDrawn, totalAvailable, lastDrawDate, daysSinceDraw, lastEventDate, daysSinceEvent, eligible, allDraws };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const d = drawSortDir==="asc" ? 1 : -1;
      if(drawSort==="available") return d*(a.totalAvailable-b.totalAvailable);
      if(drawSort==="drawn") return d*(a.totalDrawn-b.totalDrawn);
      if(drawSort==="address") return d*(a.prop.address||"").localeCompare(b.prop.address||"");
      if(drawSort==="overdue") {
        const da = a.daysSinceDraw ?? 99999;
        const db = b.daysSinceDraw ?? 99999;
        return d*(da-db);
      }
      // "chance" — longest since last event (draw or purchase), eligible first
      const ea = a.daysSinceEvent ?? 99999;
      const eb = b.daysSinceEvent ?? 99999;
      if(a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return d*(ea-eb);
    });

  if (!rows.length) return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <div className="text-4xl">🏗️</div>
      <div className="text-slate-400 dark:text-zinc-500 text-sm font-medium">No active draw facilities</div>
      <div className="text-slate-300 dark:text-zinc-600 text-xs text-center max-w-xs">Add a loan with a draw facility on the Active Properties tab to track construction draws here.</div>
    </div>
  );

  const totalAvailableAll = rows.reduce((s,r)=>s+r.totalAvailable, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Draws</h2>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <SortDropdown value={drawSort} onChange={setDrawSort}
          options={[["chance","Highest Chance"],["overdue","Most Overdue"],["available","By Available"],["drawn","By Drawn"],["address","A–Z"]]}/>
        <button onClick={()=>setDrawSortDir(d=>d==="asc"?"desc":"asc")}
          className="px-3 py-1.5 rounded-xl text-[11px] font-bold bg-white dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-all shrink-0 border border-slate-200 dark:border-zinc-700">
          {drawSortDir==="asc"?"↑ Asc":"↓ Desc"}
        </button>
        <input type="text" value={drawSearch} onChange={e=>setDrawSearch(e.target.value)}
          placeholder="Search by address…" className={SEARCH_CLS}/>
      </div>
      {/* Summary bar */}
      <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] p-4 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Total Available Draws</div>
          <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400 tabular-nums">{h$(totalAvailableAll)}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Properties</div>
          <div className="text-2xl font-black text-slate-700 dark:text-zinc-200">{rows.length}</div>
        </div>
      </div>

      {rows.map(({ prop, drawLoans, totalCommitted, totalDrawn, totalAvailable, lastDrawDate, daysSinceDraw, lastEventDate, daysSinceEvent, eligible }) => {
        const pct_drawn = totalCommitted > 0 ? Math.min(100, Math.round(totalDrawn/totalCommitted*100)) : 0;
        // urgency based on time since last event (draw or purchase)
        const urgency = !eligible ? "wait"
          : daysSinceEvent === null ? "new"
          : daysSinceEvent >= 21 ? "high"
          : daysSinceEvent >= 14 ? "med"
          : "low";
        const urgencyColor = urgency==="wait" ? "text-slate-500 dark:text-zinc-400 bg-slate-100 dark:bg-zinc-800"
          : urgency==="new" ? "text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30"
          : urgency==="high" ? "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30"
          : urgency==="med" ? "text-amber-600 dark:text-amber-500 bg-amber-50 dark:bg-amber-900/30"
          : "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30";

        // Label for the badge: show days since the relevant event
        const eventLabel = !eligible
          ? `Wait ${14 - (daysSinceEvent??0)}d`
          : daysSinceEvent === null ? "No prior event"
          : `${daysSinceEvent}d ago`;

        // Sub-label explaining what the event was
        const eventSub = lastDrawDate && prop.purchaseDate
          ? (lastDrawDate >= prop.purchaseDate ? `Last draw ${lastDrawDate}` : `Purchased ${prop.purchaseDate}`)
          : lastDrawDate ? `Last draw ${lastDrawDate}`
          : prop.purchaseDate ? `Purchased ${prop.purchaseDate}`
          : null;

        return (
          <div key={prop.id} className={`bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] overflow-hidden ${!eligible?"opacity-60":""}`}>
            {/* Property header */}
            <div className="px-4 pt-4 pb-3 border-b border-slate-100 dark:border-zinc-800">
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold text-[14px] text-slate-900 dark:text-zinc-100 leading-snug flex-1">{prop.address}</div>
                <div className={`shrink-0 text-[11px] font-bold px-2 py-0.5 rounded-full ${urgencyColor}`}>
                  {eventLabel}
                </div>
              </div>
              {eventSub && (
                <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">{eventSub}</div>
              )}
            </div>

            {/* Available amount */}
            <div className="px-4 py-3">
              <div className="flex items-end justify-between mb-2">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Available to Draw</div>
                  <div className={`text-2xl font-black tabular-nums ${totalAvailable > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-slate-300 dark:text-zinc-600"}`}>
                    {h$(totalAvailable)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Drawn / Committed</div>
                  <div className="text-[13px] font-semibold text-slate-500 dark:text-zinc-400 tabular-nums">{h$(totalDrawn)} / {h$(totalCommitted)}</div>
                </div>
              </div>
              {/* Progress bar */}
              <div className="h-2 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${pct_drawn>=90?"bg-red-500":pct_drawn>=60?"bg-amber-500":"bg-emerald-500"}`}
                  style={{width:`${pct_drawn}%`}}/>
              </div>
              <div className="flex justify-between text-[10px] text-slate-400 dark:text-zinc-600 mt-1">
                <span>{pct_drawn}% drawn</span>
                <span>{100-pct_drawn}% remaining</span>
              </div>
            </div>

            {/* Per-loan breakdown */}
            {drawLoans.length > 1 && (
              <div className="px-4 pb-3 space-y-1.5">
                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">By Lender</div>
                {drawLoans.map(l => {
                  const drawn = (l.drawFacility.draws||[]).reduce((s,d)=>s+(d.amount||0),0);
                  const avail = Math.max(0,(l.drawFacility.committed||0)-drawn);
                  return (
                    <div key={l.id} className="flex items-center justify-between text-[12px]">
                      <span className="text-slate-600 dark:text-zinc-400 font-medium">{l.lenderName}</span>
                      <span className={`font-semibold tabular-nums ${avail>0?"text-emerald-600 dark:text-emerald-400":"text-slate-300 dark:text-zinc-600"}`}>
                        {h$(avail)} avail
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Entity Detail Pages ──────────────────────────────────────────────────────
function PropertyDetailPage({ propId, data, update, onBack, navigate }) {
  const prv = usePrivacy();
  const h$ = v => prv ? maskMoney($$(v)) : $$(v);
  const hs = v => prv ? maskMoney($$s(v)) : $$s(v);
  const hr = l => { if(!prv) return fmtRate(l); const s=fmtRate(l); return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s); };
  const [editing, setEditing] = useState(false);
  const [moveLoan, setMoveLoan] = useState(null);

  const prop = data.properties.find(p => p.id === propId);
  if (!prop) return (
    <div className="flex flex-col items-center justify-center py-20 gap-3 px-5">
      <div className="text-slate-400 dark:text-zinc-500 text-sm">Property not found</div>
      <button onClick={onBack} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">← Back</button>
    </div>
  );

  const active = prop.loans.filter(l => !l.endDate);
  const closed = prop.loans.filter(l => l.endDate).sort((a,b) => (b.endDate||"").localeCompare(a.endDate||""));
  const needed = propNeeded(prop, active);
  const funded = active.reduce((s,l) => s + (l.principal||0) + (l.drawFacility?.committed||0), 0);
  const shortage = Math.max(0, needed - funded);
  const cd = prop.closingData;

  const handleMoveConfirm = (loan, result) => {
    if (result.type === "split") {
      const newUnassigned = result.splits.filter(s=>s.propId==="unassigned").map(s=>splitPiece(loan, s.amount));
      update(d=>({
        ...d,
        unassigned: [...(d.unassigned||[]), ...newUnassigned],
        properties: d.properties.map(p=>{
          if(p.id===propId){
            const withoutLoan = p.loans.filter(l=>l.id!==loan.id);
            const piece = result.splits.find(s=>s.propId===p.id);
            const added = piece ? [splitPiece(loan, piece.amount)] : [];
            return {...p,loans:[...withoutLoan,...added]};
          }
          const piece = result.splits.find(s=>s.propId===p.id);
          if(!piece) return p;
          return {...p,loans:[...p.loans,splitPiece(loan, piece.amount)]};
        }),
      }));
    } else if (result.type === "unassigned") {
      const fund={id:uid(),...loan};
      update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,loans:p.loans.filter(l=>l.id!==loan.id)}),unassigned:[...(d.unassigned||[]),fund]}));
    } else {
      update(d=>({...d,properties:d.properties.map(p=>{
        if(p.id===propId) return {...p,loans:p.loans.filter(l=>l.id!==loan.id)};
        if(p.id===result.propId) return {...p,loans:[...p.loans,loan]};
        return p;
      })}));
    }
    setMoveLoan(null);
  };

  const SectionHead = ({title, count}) => (
    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-3 flex items-center gap-2">
      {title}{count != null && <span className="text-slate-300 dark:text-zinc-600">({count})</span>}
    </div>
  );

  return (
    <div className="px-5 pt-4 pb-8 w-full max-w-5xl mx-auto">
      {/* Back + header */}
      <div className="mb-5">
        <button onClick={onBack} className="flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-3">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
          Back
        </button>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${prop.dateSold ? "bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400" : "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"}`}>
                {prop.dateSold ? `Sold ${prop.dateSold}` : "Active"}
              </span>
              {prop.isRental && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400">Rental</span>}
            </div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">{prop.address || "Unnamed Property"}</h1>
            {prop.purchaseDate && <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">Acquired {prop.purchaseDate}</p>}
          </div>
          <button onClick={()=>setEditing(e=>!e)}
            className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-700 shadow-sm transition-all">
            {editing?"✕ Cancel":"✏️ Edit"}
          </button>
        </div>
      </div>
      {editing&&(
        <div className="mb-6 bg-white dark:bg-[#1C1C1E] rounded-2xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
          <div className="text-[10px] font-bold uppercase tracking-widest text-blue-500 dark:text-blue-400 mb-4">Edit Property Details</div>
          <PropertyForm init={prop} onSave={f=>{
            update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{
              ...p,
              address:f.address||p.address,
              purchaseDate:f.purchaseDate,
              purchasePrice:f.purchasePrice!==""?parseFloat(f.purchasePrice)||0:p.purchasePrice,
              rehabBudget:f.rehabBudget!==""?parseFloat(f.rehabBudget)||0:p.rehabBudget,
              monthlyHolding:f.monthlyHolding!==""?parseFloat(f.monthlyHolding)||500:p.monthlyHolding,
              projectMonths:f.projectMonths!==""?parseFloat(f.projectMonths)||null:p.projectMonths,
            })}));
            setEditing(false);
          }} onClose={()=>setEditing(false)}/>
        </div>
      )}

      {/* Stats */}
      {!prop.dateSold ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[
            ["Purchase Price", h$(prop.purchasePrice||0), ""],
            ["Rehab Budget", h$(prop.rehabBudget||0), ""],
            ["Funded", h$(funded), "text-blue-600 dark:text-blue-400"],
            ["Shortage", h$(shortage), shortage>0?"text-red-500 dark:text-red-400":"text-emerald-600 dark:text-emerald-400"],
          ].map(([label, val, color]) => (
            <div key={label} className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">{label}</div>
              <div className={`text-lg font-bold tabular-nums ${color || "text-slate-900 dark:text-zinc-100"}`}>{val}</div>
            </div>
          ))}
        </div>
      ) : cd ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[
            ["Cash to Close", h$(cd.cashToClose||0), ""],
            ["Rehab", h$(cd.rehab||0), ""],
            ["Money Costs", h$(cd.moneyCosts||0), ""],
            ["Profit", hs(cd.profit||0), (cd.profit||0)>=0?"text-emerald-600 dark:text-emerald-400":"text-red-500 dark:text-red-400"],
          ].map(([label, val, color]) => (
            <div key={label} className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">{label}</div>
              <div className={`text-lg font-bold tabular-nums ${color || "text-slate-900 dark:text-zinc-100"}`}>{val}</div>
            </div>
          ))}
        </div>
      ) : null}

      {/* Active loans */}
      {active.length > 0 && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800">
            <SectionHead title="Active Loans" count={active.length}/>
          </div>
          <div className="divide-y divide-slate-50 dark:divide-zinc-800">
            {active.map(l => {
              const bal = calcBalance(l);
              const earned = calcIntEarned(l);
              const draws = l.drawFacility?.draws || [];
              const drawn = draws.reduce((s,d) => s + (d.amount||0), 0);
              return (
                <div key={l.id} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button onClick={() => navigate({type:'loan', loanId:l.id, propId:prop.id})} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline text-sm text-left">
                        {l.lenderName || "Unknown Lender"}
                      </button>
                      <TypeLabel type={l.loanType}/>
                    </div>
                    {l.loanType!=="hard"&&<button onClick={()=>setMoveLoan(l)} className="text-[11px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 shrink-0 whitespace-nowrap transition-colors">Move →</button>}
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
                    {[
                      ["Principal", h$(l.principal)],
                      ["Balance", h$(bal)],
                      ["Interest", h$(earned)],
                      ["Rate", hr(l)],
                      ["Since", l.startDate||"—"],
                      ["Days", String(daysBetween(l.startDate, TODAY))],
                    ].map(([lbl, val]) => (
                      <div key={lbl}>
                        <div className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase font-semibold mb-0.5">{lbl}</div>
                        <div className="font-semibold text-slate-800 dark:text-zinc-200 tabular-nums">{val}</div>
                      </div>
                    ))}
                  </div>
                  {l.drawFacility && (
                    <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-950/30 rounded-xl border border-blue-100 dark:border-blue-900/40">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest">Draw Facility</span>
                      </div>
                      <div className="grid grid-cols-3 gap-3 text-xs text-center mb-2">
                        {[["Committed", h$(l.drawFacility.committed||0),"text-blue-700 dark:text-blue-300"],["Drawn",h$(drawn),"text-amber-600 dark:text-amber-400"],["Available",h$(drawRemaining(l)),"text-emerald-600 dark:text-emerald-400"]].map(([lbl,val,c])=>(
                          <div key={lbl}><div className="text-[9px] text-blue-400 dark:text-blue-500 uppercase mb-0.5">{lbl}</div><div className={`font-bold tabular-nums ${c}`}>{val}</div></div>
                        ))}
                      </div>
                      {draws.length > 0 && (
                        <div className="space-y-1">
                          {[...draws].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map(d => (
                            <div key={d.id} className="flex justify-between text-[11px] text-slate-500 dark:text-zinc-400">
                              <span>{d.date}</span><span className="tabular-nums font-medium">{h$(d.amount)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {l.specialTerms && <div className="mt-2 text-xs text-slate-400 dark:text-zinc-500 italic">{l.specialTerms}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Loan history */}
      {closed.length > 0 && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800">
            <SectionHead title="Loan History" count={closed.length}/>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest border-b border-slate-100 dark:border-zinc-800">
                <th className="px-5 pb-2 pt-3 text-left font-semibold">Lender</th>
                <th className="px-3 pb-2 pt-3 text-right font-semibold">Principal</th>
                <th className="px-3 pb-2 pt-3 text-right font-semibold">Rate</th>
                <th className="px-3 pb-2 pt-3 text-right font-semibold">Started</th>
                <th className="px-5 pb-2 pt-3 text-right font-semibold">Closed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800">
              {closed.map(l => (
                <tr key={l.id} className="hover:bg-slate-50 dark:hover:bg-zinc-900/40 transition-colors">
                  <td className="px-5 py-3">
                    <button onClick={() => navigate({type:'loan', loanId:l.id, propId:prop.id})} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline text-left">{l.lenderName||"Unknown"}</button>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums font-semibold text-slate-700 dark:text-zinc-200">{h$(l.principal)}</td>
                  <td className="px-3 py-3 text-right text-slate-500 dark:text-zinc-400">{hr(l)}</td>
                  <td className="px-3 py-3 text-right text-slate-500 dark:text-zinc-400">{l.startDate||"—"}</td>
                  <td className="px-5 py-3 text-right text-slate-500 dark:text-zinc-400">{l.endDate||"—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Closing data lender payoffs */}
      {cd?.lenderPayoffs?.length > 0 && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800">
            <SectionHead title="Payoffs at Close"/>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest border-b border-slate-100 dark:border-zinc-800">
                <th className="px-5 pb-2 pt-3 text-left font-semibold">Lender</th>
                <th className="px-3 pb-2 pt-3 text-right font-semibold">Principal</th>
                <th className="px-5 pb-2 pt-3 text-right font-semibold">Wire Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800">
              {cd.lenderPayoffs.map((lp,i) => (
                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-zinc-900/40 transition-colors">
                  <td className="px-5 py-3">
                    {lp.loanId
                      ? <button onClick={() => navigate({type:'loan', loanId:lp.loanId, propId:prop.id})} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline text-left">{lp.lenderName||"Unknown"}</button>
                      : <span className="font-semibold text-slate-700 dark:text-zinc-200">{lp.lenderName||"Unknown"}</span>
                    }
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums font-semibold text-slate-700 dark:text-zinc-200">{h$(lp.principalPayoff||0)}</td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold text-slate-700 dark:text-zinc-200">{h$(lp.wireAmount||0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {prop.loans.length === 0 && (
        <div className="text-center py-12 text-slate-400 dark:text-zinc-500 text-sm">No loans recorded for this property.</div>
      )}

      {moveLoan&&(
        <PlaceSplitModal loan={moveLoan} currentPropId={propId} properties={data.properties}
          onConfirm={result=>handleMoveConfirm(moveLoan,result)} onClose={()=>setMoveLoan(null)}/>
      )}
    </div>
  );
}

function LenderDetailPage({ name, data, update, onBack, navigate }) {
  const prv = usePrivacy();
  const h$ = v => prv ? maskMoney($$(v)) : $$(v);
  const hr = l => { if(!prv) return fmtRate(l); const s=fmtRate(l); return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s); };
  const [editing, setEditing] = useState(false);
  const [expandedYears, setExpandedYears] = useState({});
  const [moveLoan, setMoveLoan] = useState(null);
  const [editName, setEditName] = useState(name);
  const [editType, setEditType] = useState(() => {
    const loans = [
      ...data.properties.flatMap(p => p.loans),
      ...(data.unassigned||[]),
    ].filter(l => l.lenderName === name);
    return loans[0]?.loanType || "private";
  });

  const allLoans = [
    ...data.properties.flatMap(p => p.loans.map(l => ({...l, prop:p}))),
    ...(data.unassigned||[]).map(l => ({...l, prop:null})),
  ].filter(l => l.lenderName === name);
  const active = allLoans.filter(l => !l.endDate);
  const hist = allLoans.filter(l => l.endDate).sort((a,b) => (b.endDate||"").localeCompare(a.endDate||""));

  const handleMoveConfirm = (loanWithProp, result) => {
    const { prop, ...loan } = loanWithProp; // strip the UI-only `prop` augmentation before persisting
    const srcPropId = prop?.id || null;
    if (result.type === "split") {
      const newUnassigned = result.splits.filter(s=>s.propId==="unassigned").map(s=>splitPiece(loan, s.amount));
      update(d=>({
        ...d,
        unassigned: srcPropId
          ? [...(d.unassigned||[]), ...newUnassigned]
          : [...(d.unassigned||[]).filter(u=>u.id!==loan.id), ...newUnassigned],
        properties: d.properties.map(p=>{
          if(srcPropId && p.id===srcPropId){
            const withoutLoan = p.loans.filter(l=>l.id!==loan.id);
            const piece = result.splits.find(s=>s.propId===p.id);
            const added = piece ? [splitPiece(loan, piece.amount)] : [];
            return {...p,loans:[...withoutLoan,...added]};
          }
          const piece = result.splits.find(s=>s.propId===p.id);
          if(!piece) return p;
          return {...p,loans:[...p.loans,splitPiece(loan, piece.amount)]};
        }),
      }));
    } else if (result.type === "unassigned") {
      if (srcPropId) {
        const fund={id:uid(),...loan};
        update(d=>({...d,properties:d.properties.map(p=>p.id!==srcPropId?p:{...p,loans:p.loans.filter(l=>l.id!==loan.id)}),unassigned:[...(d.unassigned||[]),fund]}));
      }
    } else if (srcPropId) {
      update(d=>({...d,properties:d.properties.map(p=>{
        if(p.id===srcPropId) return {...p,loans:p.loans.filter(l=>l.id!==loan.id)};
        if(p.id===result.propId) return {...p,loans:[...p.loans,loan]};
        return p;
      })}));
    } else {
      const placed={id:uid(),...loan};
      update(d=>({...d,unassigned:(d.unassigned||[]).filter(u=>u.id!==loan.id),properties:d.properties.map(p=>p.id!==result.propId?p:{...p,loans:[...p.loans,placed]})}));
    }
    setMoveLoan(null);
  };

  const totPrin = active.reduce((s,l) => s + (l.principal||0), 0);
  const totInt = active.reduce((s,l) => s + calcIntEarned(l), 0);
  const histByYear = {};
  hist.forEach(l => {
    const y = l.endDate.slice(0,4);
    (histByYear[y] ||= []).push(l);
  });
  const isWaived = l => {
    const payoff = l.prop?.closingData?.lenderPayoffs?.find(lp => lp.loanId===l.id);
    return !!(payoff && (payoff.type==="rollPrincipal" || payoff.type==="waiveInterest"));
  };

  // ── Annual breakdown (for taxes) ──
  // Interest paid at closing counts toward the year the loan actually closes (cash basis) —
  // still-active closing-type loans have accrued-but-unpaid interest, tracked separately below.
  // Monthly-paid interest (rate or fixed) is prorated across every calendar year it was active in.
  const yearStats = {};
  const bumpYear = (y, field, amt) => {
    if (!yearStats[y]) yearStats[y] = { interest: 0, loanCount: 0 };
    yearStats[y][field] += amt;
  };
  let pendingInterest = 0, pendingCount = 0;
  let waivedInterest = 0, waivedCount = 0;
  allLoans.forEach(l => {
    if (l.endDate) {
      bumpYear(l.endDate.slice(0,4), "loanCount", 1);
    }
    const pt = l.paymentType||"closing";
    if (pt==="closing") {
      if (l.endDate) {
        // A property sale can roll a lender's payoff instead of cutting a check — check the
        // actual disposition: "rollFull"/"payInterest"/"paidOut"/"custom" still realize the
        // interest (constructive receipt, even if reinvested); "rollPrincipal"/"waiveInterest"
        // mean the lender never actually got that interest, so it isn't taxable income to them.
        if (isWaived(l)) {
          waivedInterest += calcIntEarned(l, l.endDate);
          waivedCount += 1;
        } else {
          bumpYear(l.endDate.slice(0,4), "interest", calcIntEarned(l, l.endDate));
        }
      } else {
        pendingInterest += calcIntEarned(l);
        pendingCount += 1;
      }
    } else if (l.startDate) {
      const lastDate = l.endDate || TODAY;
      const startY = parseInt(l.startDate.slice(0,4));
      const endY = parseInt(lastDate.slice(0,4));
      for (let y=startY; y<=endY; y++) {
        const upTo = y===endY ? lastDate : `${y}-12-31`;
        const cum = calcIntEarned(l, upTo);
        const cumBefore = y===startY ? 0 : calcIntEarned(l, `${y-1}-12-31`);
        const portion = cum - cumBefore;
        if (portion) bumpYear(String(y), "interest", portion);
      }
    }
  });
  const sortedYears = Object.keys(yearStats).sort((a,b) => b.localeCompare(a));
  const lifetimePaidOut = Object.values(yearStats).reduce((s,y) => s + y.interest, 0);

  const account = (data.lenderAccounts||[]).find(a => a.name === name || a.lenderName === name);

  const SectionHead = ({title, count}) => (
    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-3 flex items-center gap-2">
      {title}{count != null && <span className="text-slate-300 dark:text-zinc-600">({count})</span>}
    </div>
  );

  return (
    <div className="px-5 pt-4 pb-8 w-full max-w-5xl mx-auto">
      <div className="mb-5">
        <button onClick={onBack} className="flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-3">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
          Back
        </button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-violet-500 dark:text-violet-400 mb-1">Lender</div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">{name || "Unknown"}</h1>
            <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">
              {active.length} active loan{active.length!==1?"s":""} · {hist.length} closed
            </p>
          </div>
          <button onClick={()=>{setEditName(name);setEditing(e=>!e);}} className="shrink-0 mt-1 px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-700 shadow-sm transition-all">
            {editing?"✕ Cancel":"✏️ Edit"}
          </button>
        </div>
      </div>

      {editing&&(
        <div className="mb-6 bg-white dark:bg-[#1C1C1E] rounded-2xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.07)] border border-slate-100 dark:border-zinc-800">
          <div className="text-[10px] font-bold uppercase tracking-widest text-violet-500 dark:text-violet-400 mb-4">Edit Lender</div>
          <div className="flex flex-col gap-3">
            <Inp label="Lender Name" value={editName} onChange={e=>setEditName(e.target.value)}/>
            <Sel label="Loan Type" value={editType} onChange={v=>setEditType(v)} options={[["private","Private Money"],["hard","Hard Money"]]}/>
            <div className="flex gap-2 pt-1">
              <Btn color="blue" onClick={()=>{
                if(!editName.trim()) return;
                const newName=editName.trim();
                update(d=>({
                  ...d,
                  properties: d.properties.map(p=>({
                    ...p,
                    loans: p.loans.map(l=>l.lenderName===name?{...l,lenderName:newName,loanType:editType}:l),
                  })),
                  unassigned: (d.unassigned||[]).map(l=>l.lenderName===name?{...l,lenderName:newName,loanType:editType}:l),
                }));
                setEditing(false);
                if(newName!==name) navigate({type:'lender',name:newName});
              }}>Save</Btn>
              <Btn color="ghost" onClick={()=>setEditing(false)}>Cancel</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          ["Active Principal", h$(totPrin), "text-slate-900 dark:text-zinc-100"],
          ["Interest (Active)", h$(totInt), "text-emerald-600 dark:text-emerald-400"],
          ["Lifetime Paid Out", h$(lifetimePaidOut), "text-emerald-700 dark:text-emerald-300"],
        ].map(([label, val, color]) => (
          <div key={label} className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">{label}</div>
            <div className={`text-lg font-bold tabular-nums ${color}`}>{val}</div>
          </div>
        ))}
      </div>

      {/* Account info */}
      {account && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 p-5">
          <SectionHead title="Account Info"/>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            {account.email && <div><div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold mb-0.5">Email</div><div className="font-medium text-slate-800 dark:text-zinc-200">{account.email}</div></div>}
            {account.phone && <div><div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold mb-0.5">Phone</div><div className="font-medium text-slate-800 dark:text-zinc-200">{account.phone}</div></div>}
            {account.entity && <div><div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold mb-0.5">Entity</div><div className="font-medium text-slate-800 dark:text-zinc-200">{account.entity}</div></div>}
            {account.notes && <div className="sm:col-span-3"><div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold mb-0.5">Notes</div><div className="text-slate-600 dark:text-zinc-300">{account.notes}</div></div>}
          </div>
        </div>
      )}

      {/* History — for taxes */}
      {sortedYears.length > 0 && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800">
            <SectionHead title="📊 History (for Taxes)"/>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest border-b border-slate-100 dark:border-zinc-800">
                <th className="px-5 pb-2 pt-3 text-left font-semibold">Year</th>
                <th className="px-3 pb-2 pt-3 text-right font-semibold">Loans Paid Out</th>
                <th className="px-5 pb-2 pt-3 text-right font-semibold">Interest Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800">
              {sortedYears.map(y => {
                const yr = yearStats[y];
                const loansThisYear = histByYear[y]||[];
                const isOpen = !!expandedYears[y];
                return (
                  <Fragment key={y}>
                    <tr onClick={()=>loansThisYear.length>0&&setExpandedYears(e=>({...e,[y]:!e[y]}))}
                      className={`transition-colors ${loansThisYear.length>0?"cursor-pointer hover:bg-slate-50 dark:hover:bg-zinc-900/40":""}`}>
                      <td className="px-5 py-3 font-semibold text-slate-800 dark:text-zinc-100">
                        <span className="inline-flex items-center gap-1.5">
                          {loansThisYear.length>0&&<span className={`text-slate-300 dark:text-zinc-600 text-[9px] transition-transform ${isOpen?"rotate-90":""}`}>▶</span>}
                          {y}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-slate-500 dark:text-zinc-400 tabular-nums">{yr.loanCount||0}</td>
                      <td className="px-5 py-3 text-right tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">{h$(yr.interest)}</td>
                    </tr>
                    {isOpen&&loansThisYear.map(l=>(
                      <tr key={l.id} className="bg-slate-50/60 dark:bg-zinc-900/30">
                        <td className="pl-9 pr-5 py-2.5" colSpan={3}>
                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <button onClick={()=>navigate({type:'loan',loanId:l.id,propId:l.prop?.id||null,startEditing:false})}
                              className="font-medium text-blue-600 dark:text-blue-400 hover:underline text-left shrink-0">
                              {l.prop?l.prop.address:"Unassigned"}
                            </button>
                            <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-zinc-400 tabular-nums">
                              <span>{h$(l.principal)} principal</span>
                              <span className={isWaived(l)?"text-slate-400 dark:text-zinc-500":"text-emerald-600 dark:text-emerald-400"}>
                                {isWaived(l)?"$0 (waived/rolled)":`${h$(calcIntEarned(l,l.endDate))} interest`}
                              </span>
                              <span>{l.startDate||"—"} → {l.endDate}</span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
          {pendingCount > 0 && (
            <div className="px-5 py-3 border-t border-slate-100 dark:border-zinc-800 text-[11px] text-slate-400 dark:text-zinc-500">
              Plus {h$(pendingInterest)} accrued but not yet paid across {pendingCount} active loan{pendingCount!==1?"s":""} paid at closing — not counted above until the loan actually closes.
            </div>
          )}
          {waivedCount > 0 && (
            <div className="px-5 py-3 border-t border-slate-100 dark:border-zinc-800 text-[11px] text-slate-400 dark:text-zinc-500">
              {h$(waivedInterest)} in interest was rolled or waived without being paid to this lender across {waivedCount} closed loan{waivedCount!==1?"s":""} — excluded above since they never received it.
            </div>
          )}
        </div>
      )}

      {/* Active loans */}
      {active.length > 0 && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800">
            <SectionHead title="Active Loans" count={active.length}/>
          </div>
          <div className="divide-y divide-slate-50 dark:divide-zinc-800">
            {active.map(l => {
              const bal = calcBalance(l);
              const earned = calcIntEarned(l);
              return (
                <div key={l.id} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {l.prop
                        ? <button onClick={() => navigate({type:'property', id:l.prop.id})} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline text-sm text-left">{l.prop.address}</button>
                        : <span className="font-semibold text-slate-500 dark:text-zinc-400 text-sm">Unassigned</span>
                      }
                      <TypeLabel type={l.loanType}/>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {l.loanType!=="hard"&&<button onClick={()=>setMoveLoan(l)} className="text-[11px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 whitespace-nowrap transition-colors">Move →</button>}
                      <button onClick={() => navigate({type:'loan', loanId:l.id, propId:l.prop?.id||null, startEditing:false})} className="text-[11px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 whitespace-nowrap transition-colors">
                        View →
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
                    {[
                      ["Principal", h$(l.principal)],
                      ["Balance", h$(bal)],
                      ["Interest", h$(earned)],
                      ["Rate", hr(l)],
                      ["Since", l.startDate||"—"],
                      ["Days", String(daysBetween(l.startDate, TODAY))],
                    ].map(([lbl, val]) => (
                      <div key={lbl}>
                        <div className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase font-semibold mb-0.5">{lbl}</div>
                        <div className="font-semibold text-slate-800 dark:text-zinc-200 tabular-nums">{val}</div>
                      </div>
                    ))}
                  </div>
                  {l.specialTerms && <div className="mt-2 text-xs text-slate-400 dark:text-zinc-500 italic">{l.specialTerms}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {allLoans.length === 0 && (
        <div className="text-center py-12 text-slate-400 dark:text-zinc-500 text-sm">No loans found for this lender.</div>
      )}

      {moveLoan&&(
        <PlaceSplitModal loan={moveLoan} currentPropId={moveLoan.prop?.id||null} properties={data.properties}
          onConfirm={result=>handleMoveConfirm(moveLoan,result)} onClose={()=>setMoveLoan(null)}/>
      )}
    </div>
  );
}

function LoanDetailPage({ loanId, propId, data, update, onBack, navigate, startEditing }) {
  const prv = usePrivacy();
  const h$ = v => prv ? maskMoney($$(v)) : $$(v);
  const hr = l => { if(!prv) return fmtRate(l); const s=fmtRate(l); return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s); };
  const [editing, setEditing] = useState(false);
  const [ef, setEf] = useState(null);
  const [closeModal, setCloseModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [drawDate, setDrawDate] = useState(TODAY);
  const [drawAmt, setDrawAmt] = useState("");

  let loan = null, prop = null;
  if (propId) { prop = data.properties.find(p => p.id === propId); loan = prop?.loans.find(l => l.id === loanId); }
  if (!loan) { const u = (data.unassigned||[]).find(l => l.id === loanId); if(u){loan=u;prop=null;} }
  if (!loan) { data.properties.forEach(p => { const l=p.loans.find(l=>l.id===loanId); if(l){loan=l;prop=p;} }); }

  if (!loan) return (
    <div className="flex flex-col items-center justify-center py-20 gap-3 px-5">
      <div className="text-slate-400 dark:text-zinc-500 text-sm">Loan not found</div>
      <button onClick={onBack} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">← Back</button>
    </div>
  );

  const bal = calcBalance(loan);
  const earned = calcIntEarned(loan);
  const draws = loan.drawFacility?.draws || [];
  const drawn = draws.reduce((s,d) => s + (d.amount||0), 0);
  const available = Math.max(0, (loan.drawFacility?.committed||0) - drawn);

  const openEdit = () => {
    setEf({
      principal: String(loan.principal||""),
      startDate: loan.startDate||"",
      endDate: loan.endDate||"",
      dueDate: loan.dueDate||"",
      interestType: loan.interestType||"percentage",
      interestRate: String(loan.interestRate||""),
      paymentType: loan.paymentType||"closing",
      monthlyPayment: String(loan.monthlyPayment||""),
      specialTerms: loan.specialTerms||"",
      drawFacility: loan.drawFacility||null,
    });
    setEditing(true);
  };

  useEffect(() => { if (startEditing && loan) openEdit(); }, []);

  const addDraw = () => {
    const amount = parseFloat(drawAmt);
    if (!amount || !drawDate) return;
    setEf(f=>({...f,drawFacility:{...f.drawFacility,draws:[...(f.drawFacility?.draws||[]),{id:uid(),date:drawDate,amount}]}}));
    setDrawAmt("");
  };

  const saveEdit = () => {
    if(!ef) return;
    const patch = {
      principal: ef.principal!==""?parseFloat(ef.principal)||loan.principal:loan.principal,
      startDate: ef.startDate||loan.startDate,
      endDate: ef.endDate||null,
      dueDate: ef.dueDate||null,
      interestType: ef.interestType,
      interestRate: ef.interestRate!==""?parseFloat(ef.interestRate)||loan.interestRate:loan.interestRate,
      paymentType: ef.paymentType,
      monthlyPayment: ef.monthlyPayment!==""?parseFloat(ef.monthlyPayment)||0:loan.monthlyPayment,
      specialTerms: ef.specialTerms,
      drawFacility: ef.drawFacility?{committed:parseFloat(ef.drawFacility.committed)||0,draws:ef.drawFacility.draws||[]}:null,
    };
    const applyPatch = l => l.id===loanId?{...l,...patch}:l;
    update(d=>({
      ...d,
      properties: d.properties.map(p=>({...p,loans:p.loans.map(applyPatch)})),
      unassigned: (d.unassigned||[]).map(applyPatch),
    }));
    setEditing(false);
  };

  const closeLoan = date => {
    const applyClose = l => l.id===loanId?{...l,endDate:date}:l;
    update(d=>({
      ...d,
      properties: d.properties.map(p=>({...p,loans:p.loans.map(applyClose)})),
      unassigned: (d.unassigned||[]).map(applyClose),
    }));
    setCloseModal(false);
  };

  const deleteLoan = () => {
    update(d=>({
      ...d,
      properties: d.properties.map(p=>({...p,loans:p.loans.filter(l=>l.id!==loanId)})),
      unassigned: (d.unassigned||[]).filter(l=>l.id!==loanId),
    }));
    onBack();
  };

  return (
    <div className="px-5 pt-4 pb-8 w-full max-w-5xl mx-auto">
      <div className="mb-5">
        <button onClick={onBack} className="flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-3">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
          Back
        </button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-blue-500 dark:text-blue-400 mb-2">Loan</div>
            <button onClick={() => navigate({type:'lender', name:loan.lenderName})}
              className="text-2xl font-bold text-slate-900 dark:text-zinc-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left leading-tight">
              {loan.lenderName || "Unknown Lender"}
            </button>
            {prop ? (
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className="text-[13px] text-slate-400 dark:text-zinc-500">at</span>
                <button onClick={() => navigate({type:'property', id:prop.id})} className="text-[15px] font-semibold text-slate-600 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors text-left">
                  {prop.address}
                </button>
              </div>
            ) : (
              <div className="text-sm text-slate-400 dark:text-zinc-500 mt-1.5 italic">Unassigned</div>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${loan.endDate ? "bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400" : "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"}`}>
                {loan.endDate ? `Closed ${loan.endDate}` : "Active"}
              </span>
              <TypeLabel type={loan.loanType}/>
            </div>
          </div>
          {update && (
            <div className="shrink-0 mt-1">
              <button onClick={editing?()=>{setEditing(false);setDeleteConfirm(false);}:openEdit} className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-700 shadow-sm transition-all">
                {editing?"✕ Cancel":"✏️ Edit"}
              </button>
            </div>
          )}
        </div>
      </div>

      {closeModal&&<CloseLoanModal loan={loan} onConfirm={closeLoan} onClose={()=>setCloseModal(false)}/>}

      {editing&&ef&&(
        <div className="mb-6 bg-white dark:bg-[#1C1C1E] rounded-2xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.07)] border border-slate-100 dark:border-zinc-800">
          <div className="text-[10px] font-bold uppercase tracking-widest text-blue-500 dark:text-blue-400 mb-4">Edit Loan Terms</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Inp label="Principal ($)" value={ef.principal} onChange={v=>setEf(f=>({...f,principal:v}))} type="number"/>
            <DateInp label="Start Date" value={ef.startDate} onChange={v=>setEf(f=>({...f,startDate:v}))}/>
            <DateInp label="End Date (leave blank if active)" value={ef.endDate} onChange={v=>setEf(f=>({...f,endDate:v}))}/>
            <DateInp label="Due Date (optional)" value={ef.dueDate} onChange={v=>setEf(f=>({...f,dueDate:v}))} helpText="Only if this loan has a fixed maturity — leave blank if it's just paid off whenever the property sells."/>
            <Sel label="Interest Type" value={ef.interestType} onChange={v=>setEf(f=>({...f,interestType:v}))} options={[["percentage","% Per Year"],["fixed","Fixed $ Amount"]]}/>
            <Inp label={ef.interestType==="fixed"?"Fixed Interest ($)":"Interest Rate (%)"} value={ef.interestRate} onChange={v=>setEf(f=>({...f,interestRate:v}))} type="number"/>
            <Sel label="Payment Type" value={ef.paymentType} onChange={v=>setEf(f=>({...f,paymentType:v}))} options={[["closing","Due at Closing"],["monthly_rate","Monthly (rate-based)"],["monthly_fixed","Monthly (fixed $)"]]}/>
            {ef.paymentType==="monthly_fixed"&&<Inp label="Monthly Payment ($)" value={ef.monthlyPayment} onChange={v=>setEf(f=>({...f,monthlyPayment:v}))} type="number"/>}
            <div className="sm:col-span-2"><Inp label="Special Terms" value={ef.specialTerms} onChange={v=>setEf(f=>({...f,specialTerms:v}))}/></div>
          </div>
          {loan.loanType==="hard"&&(
            <div className="mt-3 p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800">
              <label className="flex items-center gap-3 cursor-pointer mb-1">
                <input type="checkbox" checked={!!ef.drawFacility}
                  onChange={e=>setEf(f=>({...f,drawFacility:e.target.checked?{committed:"",draws:[]}:null}))}
                  className="w-4 h-4 rounded border-slate-300 dark:border-zinc-600 accent-blue-600 cursor-pointer"/>
                <div>
                  <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Rehab Draw Facility</div>
                  <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">Lender committed rehab funding, drawn in stages</div>
                </div>
              </label>
              {ef.drawFacility&&(
                <div className="mt-3 space-y-3">
                  <Inp label="Total Committed ($)" type="number" value={String(ef.drawFacility.committed||"")}
                    onChange={v=>setEf(f=>({...f,drawFacility:{...f.drawFacility,committed:v}}))} placeholder="100000"/>
                  {(ef.drawFacility.draws||[]).length>0&&(
                    <div>
                      <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Draws Taken</div>
                      {ef.drawFacility.draws.map(d=>(
                        <div key={d.id} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-200 dark:border-zinc-700 last:border-0">
                          <span className="text-slate-600 dark:text-zinc-300 tabular-nums">{d.date} · {$$(d.amount)}</span>
                          <button type="button" onClick={()=>setEf(f=>({...f,drawFacility:{...f.drawFacility,draws:f.drawFacility.draws.filter(x=>x.id!==d.id)}}))}
                            className="text-red-400 hover:text-red-600 text-xs p-1 transition-colors">✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="pt-1 border-t border-slate-200 dark:border-zinc-700">
                    <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Add Draw</div>
                    <DateInp label="Draw Date" value={drawDate} onChange={setDrawDate}/>
                    <Inp label="Amount ($)" type="number" value={drawAmt} onChange={setDrawAmt} placeholder="25000"/>
                    <Btn onClick={addDraw} sm color="navy" full>+ Record Draw</Btn>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="flex gap-2 mt-4">
            <Btn color="blue" onClick={saveEdit}>Save Changes</Btn>
            <Btn color="ghost" onClick={()=>{setEditing(false);setDeleteConfirm(false);}}>Cancel</Btn>
          </div>
          {update&&(
            <div className="mt-4 pt-4 border-t border-slate-100 dark:border-zinc-800 flex flex-wrap gap-2">
              {!loan.endDate&&<Btn color="ghost" onClick={()=>setCloseModal(true)}>Close Loan</Btn>}
              {!deleteConfirm
                ?<Btn color="ghost" onClick={()=>setDeleteConfirm(true)}>🗑 Delete</Btn>
                :<><Btn color="red" onClick={deleteLoan}>Confirm Delete</Btn><Btn color="ghost" onClick={()=>setDeleteConfirm(false)}>No</Btn></>
              }
            </div>
          )}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          ["Principal", h$(loan.principal), "text-slate-900 dark:text-zinc-100"],
          ["Balance", h$(bal), "text-blue-600 dark:text-blue-400"],
          ["Interest Earned", h$(earned), "text-emerald-600 dark:text-emerald-400"],
          ["Days Active", String(daysBetween(loan.startDate, loan.endDate||TODAY)), ""],
        ].map(([label, val, color]) => (
          <div key={label} className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">{label}</div>
            <div className={`text-lg font-bold tabular-nums ${color || "text-slate-900 dark:text-zinc-100"}`}>{val}</div>
          </div>
        ))}
      </div>

      {/* Detail table */}
      <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
        <div className="divide-y divide-slate-50 dark:divide-zinc-800">
          {[
            ["Type", loan.loanType === "hard" ? "Hard Money" : "Private Money"],
            ["Rate / Terms", hr(loan)],
            ["Start Date", loan.startDate||"—"],
            ["End Date", loan.endDate||"Active"],
            ...(loan.specialTerms ? [["Special Terms", loan.specialTerms]] : []),
            ...(loan.drawFacility ? [
              ["Draw Committed", h$(loan.drawFacility.committed||0)],
              ["Total Drawn", h$(drawn)],
              ["Draw Available", h$(available)],
            ] : []),
          ].map(([label, val], i) => (
            <div key={label} className={`flex items-center justify-between px-5 py-3 ${i%2===0?"":"bg-slate-50/40 dark:bg-zinc-900/20"}`}>
              <span className="text-xs text-slate-500 dark:text-zinc-400 shrink-0 mr-4">{label}</span>
              <span className="text-sm font-semibold text-slate-800 dark:text-zinc-200 text-right">{val}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Navigation buttons */}
      <div className="flex gap-3 mb-6">
        {loan.lenderName && (
          <button onClick={() => navigate({type:'lender', name:loan.lenderName})}
            className="flex-1 py-3 rounded-2xl bg-white dark:bg-[#1C1C1E] shadow-[0_2px_12px_rgba(0,0,0,0.06)] text-sm font-semibold text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors">
            View Lender →
          </button>
        )}
        {prop && (
          <button onClick={() => navigate({type:'property', id:prop.id})}
            className="flex-1 py-3 rounded-2xl bg-white dark:bg-[#1C1C1E] shadow-[0_2px_12px_rgba(0,0,0,0.06)] text-sm font-semibold text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors">
            View Property →
          </button>
        )}
      </div>

      {/* Draw history */}
      {draws.length > 0 && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500">Draw History ({draws.length})</div>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest border-b border-slate-100 dark:border-zinc-800">
                <th className="px-5 pb-2 pt-3 text-left font-semibold">Date</th>
                <th className="px-5 pb-2 pt-3 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800">
              {[...draws].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map(d => (
                <tr key={d.id}>
                  <td className="px-5 py-3 text-slate-600 dark:text-zinc-300">{d.date}</td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold text-slate-800 dark:text-zinc-200">{h$(d.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardPage({ data, update, onNavigateTab }) {
  const prv = usePrivacy();
  const h$ = v => prv ? maskMoney($$(v)) : $$(v);
  const openPanel = usePanel();
  const [modal, setModal] = useState(null);
  const [fundsOpen, setFundsOpen] = usePersistedState("nx-dashFundsOpen", true);
  const [menuOpen, setMenuOpen] = useState(null);

  const activePropsData = data.properties.filter(p => !p.dateSold);
  const unassignedFunds = (data.unassigned || []).filter(l => !l.endDate);
  const allActiveLoans = activePropsData.flatMap(p => p.loans.filter(l => !l.endDate));
  const allActivePlusUnassigned = [...allActiveLoans, ...unassignedFunds];

  // Loans with a fixed maturity date (not just "due whenever the property sells")
  const loansDueSoon = [
    ...activePropsData.flatMap(p => p.loans.filter(l => !l.endDate && l.dueDate).map(l => ({ loan: l, propAddress: p.address, propId: p.id }))),
    ...unassignedFunds.filter(l => l.dueDate).map(l => ({ loan: l, propAddress: null, propId: null })),
  ].map(x => ({ ...x, days: Math.floor((new Date(x.loan.dueDate) - new Date(TODAY)) / 864e5) }))
   .sort((a, b) => a.days - b.days);

  const unassignedTotal = unassignedFunds.reduce((s, l) => s + (l.principal || 0), 0);
  const activeLendersCount = [...new Set(allActivePlusUnassigned.map(l => l.lenderName).filter(Boolean))].length;
  const totalLoansCount = allActivePlusUnassigned.length;

  // Draws: eligible if 14+ days since the LATER of (last draw date) or (property purchase date)
  const drawsAvailable = activePropsData.flatMap(prop =>
    prop.loans.filter(l => !l.endDate && l.drawFacility && drawRemaining(l) > 0).map(l => ({l, prop}))
  ).filter(({l, prop}) => {
    const draws = l.drawFacility.draws || [];
    const lastDraw = draws.reduce((m, d) => !m || d.date > m ? d.date : m, null);
    const lastEvent = [lastDraw, prop.purchaseDate].filter(Boolean).sort().pop() ?? null;
    return !lastEvent || daysBetween(lastEvent, TODAY) >= 14;
  }).reduce((s, {l}) => s + drawRemaining(l), 0);

  const hardMonthly = allActiveLoans.filter(l => l.loanType === "hard").reduce((s, l) => s + monthlyLoanPayment(l), 0);
  const hardMonthlyLoans = allActiveLoans.filter(l => l.loanType === "hard" && monthlyLoanPayment(l) > 0);

  // Next 1st-of-the-month hard money payment date (recurring, always recomputed from today)
  const [nfY, nfM, nfD] = TODAY.split("-").map(Number);
  const nextFirstDate = nfD <= 1 ? new Date(nfY, nfM - 1, 1) : new Date(nfY, nfM, 1);
  const daysToNextFirst = Math.floor((nextFirstDate - new Date(TODAY)) / 864e5);

  // Unified upcoming-due schedule: fixed-maturity loans + recurring hard money interest
  const dueSchedule = [
    ...(hardMonthly > 0 ? [{
      id: "hard-monthly", label: "Hard Money Interest",
      sub: `${hardMonthlyLoans.length} loan${hardMonthlyLoans.length !== 1 ? "s" : ""} · due 1st of month`,
      amount: hardMonthly, days: daysToNextFirst,
      month: nextFirstDate.toLocaleDateString("en-US", { month: "short" }), day: nextFirstDate.getDate(),
      onClick: () => onNavigateTab("AllLoans:hard"),
    }] : []),
    ...loansDueSoon.map(({ loan, propAddress, propId, days }) => {
      const [dy, dm, dd] = loan.dueDate.split("-").map(Number);
      const dt = new Date(dy, dm - 1, dd);
      return {
        id: loan.id, label: loan.lenderName, sub: propAddress || "Unassigned",
        amount: loan.principal, days,
        month: dt.toLocaleDateString("en-US", { month: "short" }), day: dt.getDate(),
        onClick: () => openPanel({ type: "loan", loanId: loan.id, propId }),
      };
    }),
  ].sort((a, b) => a.days - b.days);
  const totalFundingGap = activePropsData.reduce((s, prop) => {
    const active = prop.loans.filter(l => !l.endDate);
    const funded = active.reduce((acc, l) => acc + (l.principal || 0) + (l.drawFacility?.committed || 0), 0);
    return s + Math.max(0, propNeeded(prop, active) - funded);
  }, 0);
  const totalPayoff = allActivePlusUnassigned.reduce((s, l) => s + calcBalance(l), 0);

  // All active properties ranked by monthly burn — same logic as RehabPriority
  const rollingLoans = data.rollingLoans || [];
  const dashMonthlyBurn = loan => {
    if (loan.endDate) return 0;
    if (loan.interestType === "fixed") return 0;
    if (loan.loanType === "private" && rollingLoans.includes(loan.id)) return 0;
    const pt = loan.paymentType || "closing";
    if (pt === "monthly_fixed") return Math.round(loan.monthlyPayment || 0);
    return Math.round((loan.principal || 0) * (loan.interestRate || 0) / 100 / 12);
  };
  const topBurning = [...activePropsData].map(prop => {
    const active = prop.loans.filter(l => !l.endDate);
    const monthly = active.reduce((s, l) => s + dashMonthlyBurn(l), 0);
    const daysOwned = daysBetween(prop.purchaseDate, TODAY);
    const totalInterest = prop.loans.reduce((s, l) => s + calcIntEarned(l), 0);
    return { prop, monthly, daysOwned, totalInterest };
  }).sort((a, b) => b.monthly - a.monthly);

  const placeOnProperty = (fund, propId) => {
    const loan = {
      id: uid(), lenderName: fund.lenderName, loanType: fund.loanType,
      principal: fund.principal || fund.amount || 0, startDate: fund.startDate || TODAY,
      interestRate: fund.interestRate || 0, interestType: fund.interestType || "percentage",
      paymentType: fund.paymentType || "closing", monthlyPayment: fund.monthlyPayment || 0,
      drawFacility: fund.drawFacility || null, specialTerms: fund.specialTerms || "", endDate: null,
      dueDate: fund.dueDate || null,
    };
    update(d => ({
      ...d,
      unassigned: d.unassigned.filter(u => u.id !== fund.id),
      properties: d.properties.map(p => p.id !== propId ? p : { ...p, loans: [...p.loans, loan] }),
    }));
    setModal(null);
  };

  const handleSplitLoan = (fund, splits) => {
    const newUnassigned = splits.filter(s => s.propId === "unassigned")
      .map(s => splitPiece(fund, s.amount));
    update(d => ({
      ...d,
      unassigned: [...d.unassigned.filter(u => u.id !== fund.id), ...newUnassigned],
      properties: d.properties.map(p => {
        const piece = splits.find(s => s.propId === p.id);
        if (!piece) return p;
        return { ...p, loans: [...p.loans, splitPiece(fund, piece.amount)] };
      }),
    }));
    setModal(null);
  };

  const delUnassigned = id => {
    if (!confirm("Remove this unassigned fund?")) return;
    update(d => ({ ...d, unassigned: d.unassigned.filter(u => u.id !== id) }));
  };

  const sortedFunds = [...unassignedFunds].sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));

  const NAV_COLORS = {
    blue:   "text-blue-600 dark:text-blue-400",
    indigo: "text-indigo-600 dark:text-indigo-400",
    amber:  "text-amber-600 dark:text-amber-400",
    slate:  "text-slate-700 dark:text-zinc-200",
    orange: "text-orange-600 dark:text-orange-400",
  };

  return (
    <div className="px-5 pt-5 pb-8 w-full max-w-5xl mx-auto">
      {menuOpen && <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(null)}/>}

      {/* Header */}
      <div className="mb-6">
        <div className="text-[11px] font-bold uppercase tracking-widest text-blue-500 dark:text-blue-400 mb-1">Nexus Homes</div>
        <h1 className="text-2xl font-black text-slate-900 dark:text-zinc-100 tracking-tight">Funding Center</h1>
      </div>

      {/* ── HERO: Unassigned Money ── */}
      {unassignedFunds.length > 0 ? (
        <div className="mb-4 rounded-2xl overflow-hidden bg-gradient-to-br from-violet-600 to-purple-700 shadow-[0_4px_24px_rgba(124,58,237,0.30)] dark:shadow-[0_4px_24px_rgba(124,58,237,0.20)]">
          {/* Collapsible header */}
          <button onClick={() => setFundsOpen(o => !o)}
            className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-white/5 transition-colors">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm shrink-0">⚠️</span>
              <div className="text-left min-w-0">
                <div className="text-[9px] font-bold uppercase tracking-widest text-violet-200/70 leading-none">Money Ready to Place</div>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-lg font-black text-white tabular-nums tracking-tight leading-none">{h$(unassignedTotal)}</span>
                  <span className="text-[11px] text-violet-200/70 leading-none">{unassignedFunds.length} fund{unassignedFunds.length !== 1 ? "s" : ""} idle</span>
                </div>
              </div>
            </div>
            <span className="text-white/40 text-xs font-bold ml-3 shrink-0">{fundsOpen ? "▲" : "▼"}</span>
          </button>
          {fundsOpen && (
            <div className="border-t border-white/15 divide-y divide-white/10">
              {sortedFunds.map(u => {
                const principal = u.principal || u.amount || 0;
                const days = daysBetween(u.startDate, TODAY);
                return (
                  <div key={u.id} className="px-4 py-2 flex items-center justify-between gap-2 hover:bg-white/5 transition-colors">
                    <div className="flex-1 min-w-0 flex items-center gap-2.5 flex-wrap">
                      <button onClick={() => openPanel({ type: 'loan', loanId: u.id, propId: null })}
                        className="font-semibold text-white text-sm hover:text-violet-200 transition-colors text-left">{u.lenderName}</button>
                      <span className="font-bold text-white/90 text-sm tabular-nums">{h$(principal)}</span>
                      {u.interestRate != null && <span className="text-xs text-violet-200/60">{fmtRate(u)}</span>}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        days > 60 ? "bg-red-500/30 text-red-200" :
                        days > 30 ? "bg-amber-400/25 text-amber-200" :
                        "bg-white/10 text-white/60"
                      }`}>{days}d idle</span>
                    </div>
                    <div className="flex gap-1.5 shrink-0 items-center">
                      {u.loanType!=="hard"&&<button onClick={() => setModal({ type: "place", fund: u })}
                        className="text-[11px] font-bold text-violet-700 bg-white hover:bg-violet-50 rounded-lg px-2.5 py-1 transition-colors shadow-sm whitespace-nowrap">Place →</button>}
                      {/* ⋯ menu */}
                      <div className="relative z-20">
                        <button onClick={() => setMenuOpen(o => o === u.id ? null : u.id)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white/70 hover:text-white text-sm font-bold transition-colors">⋯</button>
                        {menuOpen === u.id && (
                          <div className="absolute right-0 top-8 w-36 bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-slate-100 dark:border-zinc-700 overflow-hidden z-20 py-1">
                            <button onClick={() => { setMenuOpen(null); setModal({ type: "editUnassigned", fund: u }); }}
                              className="w-full text-left px-3 py-2 text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors">
                              ✏️ Edit
                            </button>
                            <button onClick={() => { setMenuOpen(null); delUnassigned(u.id); }}
                              className="w-full text-left px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                              🗑 Remove
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="mb-4 rounded-2xl border border-dashed border-violet-300 dark:border-violet-800 px-4 py-2.5 flex items-center justify-center gap-1.5 bg-violet-50/50 dark:bg-violet-900/10">
          <span className="text-sm font-semibold text-violet-700 dark:text-violet-400">✅ All Money Placed</span>
          <span className="text-xs text-slate-400 dark:text-zinc-500">— no idle funds</span>
        </div>
      )}

      {/* ── Upcoming Due Dates (glanceable — fixed maturities + recurring hard money) ── */}
      {dueSchedule.length > 0 && (
        <div className="mb-6 bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800 flex items-center justify-between">
            <div className="text-[10px] font-bold uppercase tracking-widest text-orange-500 dark:text-orange-400">⏰ Upcoming Due Dates</div>
            <div className="text-xs text-slate-400 dark:text-zinc-500">{dueSchedule.length} scheduled</div>
          </div>
          <div className="divide-y divide-slate-50 dark:divide-zinc-800">
            {dueSchedule.map(item => (
              <button key={item.id} onClick={item.onClick}
                className="w-full px-5 py-3.5 flex items-center gap-3.5 hover:bg-slate-50/60 dark:hover:bg-zinc-800/40 transition-colors text-left">
                <div className={`w-12 h-12 rounded-xl flex flex-col items-center justify-center shrink-0 ${
                  item.days < 0 ? "bg-red-600 text-white"
                  : item.days <= 14 ? "bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400"
                  : item.days <= 30 ? "bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400"
                  : "bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400"
                }`}>
                  <span className="text-[9px] font-bold uppercase leading-none">{item.month}</span>
                  <span className="text-lg font-black leading-none mt-0.5">{item.day}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-slate-800 dark:text-zinc-100 truncate">{item.label}</div>
                  <div className="text-xs text-slate-400 dark:text-zinc-500 truncate">{item.sub}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-black text-base tabular-nums text-slate-800 dark:text-zinc-100">{h$(item.amount)}</div>
                  <div className={`text-[11px] font-bold ${
                    item.days < 0 ? "text-red-600 dark:text-red-400"
                    : item.days <= 14 ? "text-red-600 dark:text-red-400"
                    : item.days <= 30 ? "text-amber-600 dark:text-amber-400"
                    : "text-slate-400 dark:text-zinc-500"
                  }`}>{item.days < 0 ? `${Math.abs(item.days)}d overdue` : item.days === 0 ? "Due today" : `in ${item.days}d`}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Stat Grid (6 tiles) ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        {[
          { label: "Active Properties", value: activePropsData.length, sub: "tap to view",        color: "blue",   icon: "🏠", tab: "Properties"  },
          { label: "Active Lenders",    value: activeLendersCount,    sub: "tap to view",         color: "indigo", icon: "👥", tab: "LenderDash"  },
          { label: "Draws Available",   value: h$(drawsAvailable),   sub: "14d+ since last event",color: "amber",  icon: "🏗️", tab: "Draws"       },
          { label: "Total Active Loans",value: totalLoansCount,      sub: "across all",           color: "slate",  icon: "📋", tab: "AllLoans"    },
          { label: "Funding Gap",       value: h$(totalFundingGap),  sub: "short of 100%",        color: "orange", icon: "📉", tab: "PropDash"    },
          { label: "Total Payoff",      value: h$(totalPayoff),      sub: "all active balances",  color: "slate",  icon: "💰", tab: "LenderDash"  },
        ].map(({ label, value, sub, color, icon, tab }) => (
          <button key={label} onClick={() => onNavigateTab(tab)}
            className="bg-white dark:bg-[#1C1C1E] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)] hover:shadow-[0_4px_20px_rgba(0,0,0,0.10)] hover:-translate-y-0.5 active:scale-[0.98] transition-all text-left group">
            <div className="flex items-start justify-between mb-2">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 leading-tight pr-1">{label}</div>
              <span className="text-base shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">{icon}</span>
            </div>
            <div className={`text-xl font-black tabular-nums tracking-tight ${NAV_COLORS[color]}`}>{value}</div>
            <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5 flex items-center gap-1">
              {sub}
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-2.5 h-2.5 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all">
                <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd"/>
              </svg>
            </div>
          </button>
        ))}
      </div>

      {/* ── Hard Money Monthly Card ── */}
      {hardMonthly > 0 && (
        <button onClick={() => onNavigateTab("AllLoans:hard")}
          className="w-full mb-4 bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] p-4 flex items-center justify-between hover:shadow-[0_4px_20px_rgba(0,0,0,0.10)] hover:-translate-y-0.5 active:scale-[0.98] transition-all text-left group">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-red-500 dark:text-red-400 mb-1">💸 Hard Money — Due 1st of Month</div>
            <div className="text-xs text-slate-400 dark:text-zinc-500">{hardMonthlyLoans.length} loan{hardMonthlyLoans.length!==1?"s":""} · tap to view →</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-2xl font-black text-red-600 dark:text-red-400 tabular-nums">{h$(hardMonthly)}</div>
            <div className="text-[10px] text-slate-400 dark:text-zinc-500">per month</div>
          </div>
        </button>
      )}

      {/* ── All Burning Properties ── */}
      {topBurning.length > 0 && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden mb-4">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800 flex items-start justify-between gap-3">
            <button onClick={() => onNavigateTab("RehabPriority")} className="text-left group">
              <div className="text-[10px] font-bold uppercase tracking-widest text-orange-500 dark:text-orange-400 flex items-center gap-1">
                🔥 Monthly Holding
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity"><path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd"/></svg>
              </div>
              <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">All active properties by monthly cost · tap for Rehab Priority</div>
            </button>
            <div className="shrink-0 text-right">
              <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold tracking-widest mb-0.5">Total/mo</div>
              <div className="text-lg font-black text-orange-600 dark:text-orange-400 tabular-nums">{h$(topBurning.reduce((s,{monthly})=>s+monthly,0))}</div>
            </div>
          </div>
          <div className="divide-y divide-slate-50 dark:divide-zinc-800">
            {topBurning.map(({ prop, monthly, daysOwned, totalInterest }, idx) => (
              <div key={prop.id} className="px-5 py-4 flex items-center gap-4 hover:bg-slate-50/60 dark:hover:bg-zinc-800/40 transition-colors">
                <div className="w-6 h-6 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center text-[11px] font-black text-orange-600 dark:text-orange-400 shrink-0">
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <button onClick={() => openPanel({ type: 'property', id: prop.id })}
                    className="font-semibold text-sm text-slate-800 dark:text-zinc-200 hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left truncate block w-full">
                    {prop.address}
                  </button>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <span className="text-[11px] font-bold text-orange-600 dark:text-orange-400 tabular-nums">{h$(monthly)}/mo</span>
                    {daysOwned > 0 && <span className="text-[11px] text-slate-400 dark:text-zinc-500 tabular-nums">{daysOwned}d owned</span>}
                    {totalInterest > 0 && <span className="text-[11px] text-amber-600 dark:text-amber-400 tabular-nums">{h$(totalInterest)} interest so far</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {modal?.type === "editUnassigned" && (
        <Modal title="Edit Fund" onClose={() => setModal(null)}>
          <LenderMoneyForm properties={data.properties} lenders={data.lenders||[]} unassigned={data.unassigned} init={modal.fund}
            onSave={f => {
              update(d => ({
                ...d,
                unassigned: d.unassigned.map(u => u.id !== modal.fund.id ? u : { ...u, ...loanFields(f), id: u.id }),
              }));
              setModal(null);
            }}
            onMerge={(f, mergeId) => {
              update(d => {
                const mergeAmt = d.unassigned.find(u => u.id === mergeId)?.principal || 0;
                const merged = { ...modal.fund, ...loanFields(f), id: modal.fund.id, principal: (parseFloat(f.principal) || 0) + mergeAmt };
                return { ...d, unassigned: d.unassigned.filter(u => u.id !== mergeId).map(u => u.id === modal.fund.id ? merged : u) };
              });
              setModal(null);
            }}
            onClose={() => setModal(null)}/>
        </Modal>
      )}
      {modal?.type === "place" && (
        <PlaceSplitModal
          loan={modal.fund}
          currentPropId={null}
          properties={data.properties}
          onConfirm={result => {
            if (result.type === "split") handleSplitLoan(modal.fund, result.splits);
            else placeOnProperty(modal.fund, result.propId);
          }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function EntityDetailView({ entity, data, update, onBack, navigate }) {
  if (entity.type === 'property') return <PropertyDetailPage propId={entity.id} data={data} update={update} onBack={onBack} navigate={navigate}/>;
  if (entity.type === 'lender') return <LenderDetailPage name={entity.name} data={data} update={update} onBack={onBack} navigate={navigate}/>;
  if (entity.type === 'loan') return <LoanDetailPage loanId={entity.loanId} propId={entity.propId} data={data} update={update} onBack={onBack} navigate={navigate} startEditing={!!entity.startEditing}/>;
  return null;
}

const TABS=[{id:"Properties",label:"🏠",full:"Properties"},{id:"LenderDash",label:"👥",full:"Lenders"},{id:"PropDash",label:"📊",full:"Dash"},{id:"RehabPriority",label:"🔥",full:"Rehab"},{id:"Closed",label:"🏁",full:"Closed"},{id:"History",label:"📋",full:"History"},{id:"Draws",label:"🏗️",full:"Draws"},{id:"LenderAccts",label:"🔑",full:"Accounts"}];

export default function Tracker({ onSignOut, onHome, userEmail, dark, onToggleDark }) {
  const [data,setData]=useState(null);
  const [tab,setTab]=usePersistedState("nx-activeTab","Properties");
  const [loading,setLoading]=useState(true);
  const [privacyMode,setPrivacyMode]=useState(false);
  const [fabOpen,setFabOpen]=useState(false);
  const [fabPending,setFabPending]=useState(null);
  const [loanFilterPending,setLoanFilterPending]=useState(null);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [mobileNavOpen,setMobileNavOpen]=useState(false);
  const [globalSearch,setGlobalSearch]=useState('');
  const [navStack,setNavStack]=useState([]);
  const [panelStack,setPanelStack]=useState([]);
  const [rehabHover,setRehabHover]=useState(false);
  const fabRef=useRef(null);
  const settingsRef=useRef(null);
  const globalSearchRef=useRef(null);
  const updatedAtRef=useRef(null);
  const saveQueueRef=useRef(Promise.resolve());

  useEffect(()=>{
    const handler=e=>{
      if(fabRef.current&&!fabRef.current.contains(e.target))setFabOpen(false);
      if(settingsRef.current&&!settingsRef.current.contains(e.target))setSettingsOpen(false);
      if(globalSearchRef.current&&!globalSearchRef.current.contains(e.target))setGlobalSearch('');
    };
    document.addEventListener('mousedown',handler);
    return ()=>document.removeEventListener('mousedown',handler);
  },[]);

  // Save with optimistic concurrency: if another tab/device saved since we last read,
  // the write is rejected instead of silently overwriting their change. On conflict we
  // refetch the latest server data and re-apply this same edit on top of it, so a stale
  // background tab can never blindly wipe out work done elsewhere.
  const persistWithRetry = async (next, fn, attempt=0) => {
    try {
      const newUpdatedAt = await save(next, updatedAtRef.current);
      updatedAtRef.current = newUpdatedAt;
    } catch (e) {
      if (e?.isConflict && attempt < 4) {
        const fresh = await load();
        const merged = typeof fn==="function" ? fn(fresh.data) : next;
        updatedAtRef.current = fresh.updatedAt;
        setData(merged);
        return persistWithRetry(merged, fn, attempt+1);
      }
      console.error('Failed to save to Supabase:', e);
      alert('Your last change could not be saved — another device may have updated this data at the same time. Refreshing to the latest data; please try your change again.');
      try {
        const fresh = await load();
        updatedAtRef.current = fresh.updatedAt;
        setData(fresh.data);
      } catch {}
    }
  };

  useEffect(()=>{
    // Pure function of whatever base data is passed in, so a conflict retry can safely
    // recompute this against fresh server data instead of resaving a stale snapshot.
    const applyMigrations = d => {
      const migrateLoans = loans => loans.map(l=>
        (!l.paymentType && l.loanType==="hard") ? {...l,paymentType:"monthly_rate"} : l
      );
      const isHardOverride = name => {
        const n = (name||"").toLowerCase();
        return n.includes("phoenix") || n.includes("kiavi");
      };
      const fixLoanTypes = loans => loans.map(l=>
        (l.lenderName && isHardOverride(l.lenderName) && l.loanType!=="hard")
          ? {...l, loanType:"hard"} : l
      );
      const needsPropMig = d.properties.some(p=>(!p.purchasePrice&&!p.rehabBudget)&&p.fundingNeeded>0);
      const needsLoanMig = d.properties.some(p=>p.loans.some(l=>!l.paymentType&&l.loanType==="hard"))
        || d.unassigned.some(l=>!l.paymentType&&l.loanType==="hard");
      const needsLenderMig = !d.lenders || d.lenders.length===0;
      const needsPhoenixFix = [...d.properties.flatMap(p=>p.loans),...d.unassigned]
        .some(l=>l.lenderName&&isHardOverride(l.lenderName)&&l.loanType!=="hard");
      if (!(needsPropMig||needsLoanMig||needsLenderMig||needsPhoenixFix)) return d;
      const allLoans = [...d.properties.flatMap(p=>p.loans),...d.unassigned];
      const lenderMap = {};
      for (const l of allLoans) {
        if (!l.lenderName) continue;
        const name = l.lenderName.trim();
        const type = isHardOverride(name) ? "hard" : (l.loanType||"private");
        if (!lenderMap[name]) lenderMap[name] = {id:uid(), name, loanType:type};
        else if (type==="hard") lenderMap[name].loanType = "hard";
      }
      const builtLenders = needsLenderMig
        ? Object.values(lenderMap)
        : d.lenders.map(l=>isHardOverride(l.name)?{...l,loanType:"hard"}:l);
      return {...d,
        lenders: builtLenders,
        properties:d.properties.map(p=>({
          ...p,
          ...(needsPropMig&&!p.purchasePrice&&!p.rehabBudget&&p.fundingNeeded>0
            ? {purchasePrice:p.fundingNeeded,rehabBudget:0,monthlyHolding:p.monthlyHolding??500}
            : {}),
          loans:fixLoanTypes(migrateLoans(p.loans)),
        })),
        unassigned:fixLoanTypes(migrateLoans(d.unassigned)),
      };
    };

    load().then(({data:d, updatedAt})=>{
      updatedAtRef.current = updatedAt;
      const migrated = applyMigrations(d);
      if (migrated !== d) {
        saveQueueRef.current = saveQueueRef.current.then(()=>persistWithRetry(migrated, applyMigrations));
        setData(migrated);
      } else {
        setData(d);
      }
      setLoading(false);
    })
    const channel=subscribeToChanges((newData,newUpdatedAt)=>{
      updatedAtRef.current = newUpdatedAt;
      setData(newData);
    })
    // A backgrounded tab/phone can silently drop the realtime connection without
    // reconnecting cleanly — resync from the server whenever the tab becomes visible
    // again so stale data never sits around waiting to be saved over something newer.
    const resync = () => {
      if (document.visibilityState !== 'visible') return;
      load().then(({data:d, updatedAt})=>{
        updatedAtRef.current = updatedAt;
        setData(d);
      }).catch(()=>{});
    };
    document.addEventListener('visibilitychange', resync);
    window.addEventListener('focus', resync);
    return()=>{
      channel.unsubscribe();
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('focus', resync);
    }
  },[])

  const update = fn => {
    setData(prev=>{
      const next=typeof fn==="function"?fn(prev):fn
      saveQueueRef.current = saveQueueRef.current.then(()=>persistWithRetry(next, fn));
      return next
    })
  }
  const navigate = entity => setPanelStack(s=>[...s,entity]);
  const navStackNavigate = entity => setNavStack(s=>[...s,entity]);

  if(loading) return (
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-black flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 rounded-full border-2 border-slate-200 dark:border-zinc-700 border-t-blue-500 animate-spin"/>
        <div className="text-slate-400 dark:text-zinc-500 text-sm font-medium">Loading…</div>
      </div>
    </div>
  );

  // ── Derived values for sidebar counts and global search ──
  const activeProps=data.properties.filter(p=>!p.dateSold).length;
  const activeLenders=[...new Set([...data.properties.flatMap(p=>p.loans.filter(l=>!l.endDate).map(l=>l.lenderName)),...data.unassigned.filter(l=>!l.endDate).map(l=>l.lenderName)].filter(Boolean))].length;
  const activeLoans=data.properties.flatMap(p=>p.loans.filter(l=>!l.endDate)).length+(data.unassigned||[]).filter(l=>!l.endDate).length;
  const closedCount=data.properties.filter(p=>p.dateSold).length;

  const globalResults=(()=>{
    if(globalSearch.length<2)return[];
    const q=globalSearch.toLowerCase();
    const results=[];
    // Active properties
    data.properties.filter(p=>!p.dateSold).forEach(p=>{
      if(p.address?.toLowerCase().includes(q))
        results.push({kind:'property',label:p.address||"",sub:`${p.loans.filter(l=>!l.endDate).length} active loans`,entity:{type:'property',id:p.id}});
    });
    // Closed properties
    data.properties.filter(p=>p.dateSold).forEach(p=>{
      if(p.address?.toLowerCase().includes(q))
        results.push({kind:'property',label:p.address||"",sub:`Sold ${p.dateSold}`,entity:{type:'property',id:p.id}});
    });
    // Lenders — group by name, attach their individual loans as sub-items
    const allActiveLoans=[
      ...data.properties.flatMap(p=>p.loans.filter(l=>!l.endDate).map(l=>({...l,propAddress:p.address,propId:p.id}))),
      ...(data.unassigned||[]).filter(l=>!l.endDate).map(l=>({...l,propAddress:null,propId:null})),
    ];
    const seenLenders=new Set();
    allActiveLoans.forEach(l=>{
      if(l.lenderName?.toLowerCase().includes(q)&&!seenLenders.has(l.lenderName)){
        seenLenders.add(l.lenderName);
        const loans=allActiveLoans.filter(x=>x.lenderName===l.lenderName);
        const totPrin=loans.reduce((s,x)=>s+(x.principal||0),0);
        results.push({
          kind:'lender',
          label:l.lenderName,
          sub:`${loans.length} loan${loans.length!==1?'s':''} · ${$$(totPrin)} active`,
          entity:{type:'lender',name:l.lenderName},
          loans:loans.map(x=>({
            label:`${$$(x.principal)} · ${x.propAddress||'Unassigned'}`,
            entity:{type:'loan',loanId:x.id,propId:x.propId||null},
          })),
        });
      }
    });
    return results.slice(0,6);
  })();

  // ── Sidebar monochrome SVG icons ──
  const IcoHome=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h4v-4h2v4h4a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z"/></svg>;
  const IcoUsers=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>;
  const IcoHardHat=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path d="M10 2C5.6 2 2 5.6 2 10h16C18 5.6 14.4 2 10 2zM1 11h18v2H1zM4 15h12v1c0 .55-.45 1-1 1H5c-.55 0-1-.45-1-1v-1z"/></svg>;
  const IcoDocument=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd"/></svg>;
  const IcoCog=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd"/></svg>;
  const IcoClipboard=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[14px] h-[14px] shrink-0"><path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9zM4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z"/></svg>;
  const IcoGrid=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[14px] h-[14px] shrink-0"><path fillRule="evenodd" d="M5 4a3 3 0 00-3 3v6a3 3 0 003 3h10a3 3 0 003-3V7a3 3 0 00-3-3H5zm-1 9v-1h5v2H5a1 1 0 01-1-1zm7 1h4a1 1 0 001-1v-1h-5v2zm0-4h5V8h-5v2zM9 8H4v2h5V8z" clipRule="evenodd"/></svg>;
  const IcoBar=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[14px] h-[14px] shrink-0"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/></svg>;
  const IcoList=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd"/></svg>;

  // ── Sidebar nav button (icon-only, tooltip on hover) ──
  const SideBtn=({icon,label,active,onClick,tooltip})=>(
    <div className="relative group">
      <button onClick={onClick}
        className={`flex items-center justify-center w-full p-2.5 rounded-xl transition-all ${active?"bg-blue-600 shadow-sm":"hover:bg-black/5 dark:hover:bg-white/10"}`}>
        <span className={`shrink-0 ${active?"text-white":"text-slate-400 dark:text-zinc-500"}`}>{icon}</span>
      </button>
      <div className="absolute left-full top-1/2 -translate-y-1/2 ml-3 px-2.5 py-1.5 bg-zinc-900 dark:bg-zinc-700 text-white text-xs font-semibold rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-100 z-50 shadow-lg">
        {tooltip||label}
        <div className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-zinc-900 dark:border-r-zinc-700"/>
      </div>
    </div>
  );

  return (
    <PrivacyContext.Provider value={privacyMode}>
    <PanelContext.Provider value={navigate}>
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-black flex transition-colors duration-300">

      {/* ── Left Sidebar (desktop only) ── */}
      <div className="hidden sm:flex fixed left-0 top-0 bottom-0 w-14 bg-[#F2F2F7] dark:bg-black border-r border-black/[0.05] dark:border-white/[0.04] flex-col z-40">
        {/* Logo / Dashboard */}
        <button onClick={()=>{setNavStack([]);setPanelStack([]);setTab("Dashboard");}} title="Command Center"
          className={`mx-auto mt-3.5 mb-2.5 w-9 h-9 rounded-[11px] flex items-center justify-center active:scale-95 transition-all shrink-0 ${tab==="Dashboard"&&navStack.length===0?"bg-gradient-to-br from-blue-600 to-blue-700 shadow-lg shadow-blue-500/30 ring-2 ring-blue-400/40":"bg-gradient-to-br from-blue-500 to-blue-700 shadow-md shadow-blue-500/30"}`}>
          <span className="text-white font-black text-lg leading-none tracking-tight">$</span>
        </button>
        <div className="h-px bg-black/[0.06] dark:bg-white/[0.06] mx-2 mb-1.5"/>

        {/* Nav items */}
        <nav className="flex flex-col gap-0.5 px-1.5 flex-1">
          <SideBtn icon={<IcoHome/>} label="Properties" tooltip={`Properties (${activeProps})`} active={tab==="Properties"&&navStack.length===0} onClick={()=>{setNavStack([]);setPanelStack([]);setTab("Properties");}}/>
          <SideBtn icon={<IcoUsers/>} label="Lenders" tooltip={`Lenders (${activeLenders})`} active={tab==="LenderDash"&&navStack.length===0} onClick={()=>{setNavStack([]);setPanelStack([]);setTab("LenderDash");}}/>
          <SideBtn icon={<IcoList/>} label="Loans" tooltip={`Loans (${activeLoans})`} active={tab==="AllLoans"&&navStack.length===0} onClick={()=>{setNavStack([]);setPanelStack([]);setTab("AllLoans");}}/>

          {/* Renovation group — clicking parent does nothing, hover reveals submenu */}
          <div className="relative" onMouseEnter={()=>setRehabHover(true)} onMouseLeave={()=>setRehabHover(false)}>
            <div className={`flex items-center justify-center w-full p-2.5 rounded-xl transition-all cursor-pointer ${["RehabPriority","Draws","PropDash"].includes(tab)&&navStack.length===0?"bg-blue-600":"hover:bg-black/5 dark:hover:bg-white/10"}`}>
              <span className={`shrink-0 ${["RehabPriority","Draws","PropDash"].includes(tab)&&navStack.length===0?"text-white":"text-slate-400 dark:text-zinc-500"}`}><IcoHardHat/></span>
            </div>
            {rehabHover&&(
              <div className="absolute left-full top-0 ml-2 bg-white dark:bg-zinc-800 rounded-xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden w-44 z-50 py-1">
                <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500">Renovation</div>
                {[{id:"RehabPriority",ico:<IcoClipboard/>,l:"Rehab Priority"},{id:"Draws",ico:<IcoGrid/>,l:"Draw Tracker"},{id:"PropDash",ico:<IcoBar/>,l:"Dashboard"}].map(({id,ico,l})=>(
                  <button key={id} onClick={()=>{setNavStack([]);setPanelStack([]);setTab(id);setRehabHover(false);}}
                    className={`w-full text-left flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium transition-colors ${tab===id&&navStack.length===0?"bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700"}`}>
                    <span className="text-slate-400 dark:text-zinc-500 shrink-0">{ico}</span>{l}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Records = Closed + History */}
          <SideBtn icon={<IcoDocument/>} label="Records" tooltip="Records" active={["Closed","History"].includes(tab)&&navStack.length===0} onClick={()=>{setNavStack([]);setPanelStack([]);setTab(["Closed","History"].includes(tab)?tab:"Closed");}}/>
        </nav>

        {/* Bottom — Settings */}
        <div className="px-1.5 pb-3 relative" ref={settingsRef}>
          <div className="relative group">
            <button onClick={()=>setSettingsOpen(o=>!o)}
              className={`flex items-center justify-center w-full p-2.5 rounded-xl transition-all ${settingsOpen?"bg-blue-600":"hover:bg-black/5 dark:hover:bg-white/10"}`}>
              <span className={`shrink-0 ${settingsOpen?"text-white":"text-slate-400 dark:text-zinc-500"}`}><IcoCog/></span>
            </button>
            {!settingsOpen&&<div className="absolute left-full top-1/2 -translate-y-1/2 ml-3 px-2.5 py-1.5 bg-zinc-900 dark:bg-zinc-700 text-white text-xs font-semibold rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-100 z-50 shadow-lg">
              Settings
              <div className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-zinc-900 dark:border-r-zinc-700"/>
            </div>}
          </div>
          {settingsOpen&&(
            <div className="absolute bottom-0 left-full ml-2 w-48 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-50">
              <div className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500">Settings</div>
              <button onClick={()=>setPrivacyMode(p=>!p)}
                className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors text-left">
                <span>Demo Mode</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${privacyMode?"bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400":"bg-slate-100 dark:bg-zinc-700 text-slate-400 dark:text-zinc-500"}`}>{privacyMode?"ON":"OFF"}</span>
              </button>
              <button onClick={onToggleDark}
                className="w-full flex items-center px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors text-left">
                {dark?"Light Mode":"Dark Mode"}
              </button>
              <div className="h-px bg-slate-100 dark:bg-zinc-700 mx-3 my-1"/>
              <button onClick={()=>{setSettingsOpen(false);setTab("LenderAccts");}}
                className="w-full flex items-center px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors text-left">
                Lender Accounts
              </button>
              <div className="h-px bg-slate-100 dark:bg-zinc-700 mx-3 my-1"/>
              <button onClick={onSignOut}
                className="w-full flex items-center px-4 py-2.5 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-left">
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Mobile Nav Drawer ── */}
      {mobileNavOpen && (
        <>
          <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] sm:hidden" onClick={()=>setMobileNavOpen(false)}/>
          <div className="fixed left-0 top-0 bottom-0 z-50 w-72 max-w-[85vw] bg-white dark:bg-[#1C1C1E] shadow-2xl flex flex-col sm:hidden overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-4 border-b border-slate-100 dark:border-zinc-800 shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-[10px] bg-gradient-to-br from-blue-500 to-blue-700 shadow-md shadow-blue-500/30 flex items-center justify-center shrink-0">
                  <span className="text-white font-black text-sm leading-none">$</span>
                </div>
                <span className="font-bold text-slate-900 dark:text-zinc-100 text-sm">Nexus Homes</span>
              </div>
              <button onClick={()=>setMobileNavOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-slate-500 dark:text-zinc-400 text-xl leading-none shrink-0">&times;</button>
            </div>
            <nav className="flex-1 py-2 px-2">
              {[
                {id:"Dashboard",icon:<IcoHome/>,label:"Dashboard",match:t=>t==="Dashboard"},
                {id:"Properties",icon:<IcoHome/>,label:"Properties",match:t=>t==="Properties"},
                {id:"LenderDash",icon:<IcoUsers/>,label:"Lenders",match:t=>t==="LenderDash"},
                {id:"AllLoans",icon:<IcoList/>,label:"Loans",match:t=>t==="AllLoans"},
                {id:"RehabPriority",icon:<IcoClipboard/>,label:"Rehab Priority",match:t=>t==="RehabPriority"},
                {id:"Draws",icon:<IcoGrid/>,label:"Draw Tracker",match:t=>t==="Draws"},
                {id:"PropDash",icon:<IcoBar/>,label:"Prop Dashboard",match:t=>t==="PropDash"},
                {id:"Closed",icon:<IcoDocument/>,label:"Records",match:t=>["Closed","History"].includes(t)},
              ].map(({id,icon,label,match})=>(
                <button key={id}
                  onClick={()=>{setNavStack([]);setPanelStack([]);setTab(id);setMobileNavOpen(false);}}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${match(tab)&&navStack.length===0?"bg-blue-600 text-white":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800"}`}>
                  <span className={`shrink-0 ${match(tab)&&navStack.length===0?"text-white":"text-slate-400 dark:text-zinc-500"}`}>{icon}</span>
                  {label}
                </button>
              ))}
            </nav>
            <div className="border-t border-slate-100 dark:border-zinc-800 py-2 px-2 shrink-0">
              <button onClick={()=>setPrivacyMode(p=>!p)}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors">
                <span>Demo Mode</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${privacyMode?"bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400":"bg-slate-100 dark:bg-zinc-700 text-slate-400 dark:text-zinc-500"}`}>{privacyMode?"ON":"OFF"}</span>
              </button>
              <button onClick={onToggleDark}
                className="w-full flex items-center px-3 py-2.5 rounded-xl text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors text-left">
                {dark?"Light Mode":"Dark Mode"}
              </button>
              <button onClick={()=>{setMobileNavOpen(false);setNavStack([]);setPanelStack([]);setTab("LenderAccts");}}
                className="w-full flex items-center px-3 py-2.5 rounded-xl text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors text-left">
                Lender Accounts
              </button>
              <button onClick={onSignOut}
                className="w-full flex items-center px-3 py-2.5 rounded-xl text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-left">
                Sign Out
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Main content ── */}
      <div className="ml-0 sm:ml-14 flex-1 flex flex-col min-h-screen min-w-0">
        {/* Top bar */}
        <div className="sticky top-0 z-30 bg-[#F2F2F7]/90 dark:bg-black/80 backdrop-blur-xl border-b border-black/[0.04] dark:border-white/[0.04]">
          <div className="px-5 py-1.5 flex items-center w-full gap-2">
            {/* Mobile hamburger (mobile only) */}
            <button onClick={()=>setMobileNavOpen(true)}
              className="sm:hidden w-8 h-8 flex items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-zinc-300 shrink-0">
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd"/></svg>
            </button>
            {/* Left spacer — desktop only, keeps search centered */}
            <div className="hidden sm:block flex-1"/>
            {/* Global search */}
            <div ref={globalSearchRef} className="relative flex-1 min-w-0 sm:flex-none sm:w-72">
              <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 dark:text-zinc-500 pointer-events-none" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd"/></svg>
                <input type="text" value={globalSearch} onChange={e=>setGlobalSearch(e.target.value)}
                  placeholder="Search properties, lenders…"
                  className="w-full pl-8 pr-3 py-1.5 rounded-full text-sm bg-black/[0.06] dark:bg-white/[0.08] text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 border-0"/>
              </div>
              {globalSearch.length>1&&(
                <div className="absolute top-full left-0 right-0 mt-1.5 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-50">
                  {globalResults.length===0
                    ?<div className="px-4 py-3 text-sm text-slate-400 dark:text-zinc-500">No results</div>
                    :globalResults.map((r,i)=>(
                      <div key={i} className="border-b border-slate-50 dark:border-zinc-700/40 last:border-0">
                        {/* Property or lender header row */}
                        <button onClick={()=>{navigate(r.entity);setGlobalSearch('');}}
                          className="w-full text-left flex items-start gap-2.5 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md shrink-0 mt-0.5 ${
                            r.kind==='lender'
                              ?'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                              :'bg-slate-100 dark:bg-zinc-700 text-slate-500 dark:text-zinc-400'
                          }`}>{r.kind==='lender'?'Lender':'Property'}</span>
                          <div className="min-w-0">
                            <div className="text-sm text-slate-800 dark:text-zinc-200 font-semibold truncate">{r.label}</div>
                            {r.sub&&<div className="text-xs text-slate-400 dark:text-zinc-500">{r.sub}</div>}
                          </div>
                        </button>
                        {/* Loan sub-rows for lender results */}
                        {r.loans&&r.loans.map((loan,j)=>(
                          <button key={j} onClick={()=>{navigate(loan.entity);setGlobalSearch('');}}
                            className="w-full text-left flex items-center gap-2 pl-10 pr-4 py-2 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors">
                            <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-slate-300 dark:text-zinc-600 shrink-0"><path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd"/></svg>
                            <span className="text-xs text-slate-600 dark:text-zinc-300 truncate">{loan.label}</span>
                          </button>
                        ))}
                      </div>
                    ))
                  }
                </div>
              )}
            </div>

            {/* Right side — Actions button, adjacent to search */}
            <div className="flex-1 flex justify-end sm:justify-start pl-0 sm:pl-3">
            <div ref={fabRef} className="relative shrink-0">
              <button onClick={()=>setFabOpen(o=>!o)}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-full text-sm font-semibold transition-all border ${fabOpen?"bg-blue-600 border-blue-600 text-white":"border-blue-500 dark:border-blue-400 text-blue-600 dark:text-blue-400 hover:bg-blue-600 hover:border-blue-600 hover:text-white dark:hover:text-white"}`}>
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 shrink-0"><path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd"/></svg>
                <span className="hidden sm:inline">Actions</span>
              </button>
              {fabOpen&&(
                <div className="absolute right-0 top-10 w-52 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-50 py-1">
                  {[
                    {label:"Add Property",modal:"addProp"},
                    {label:"Add Lender Money",modal:{type:"addMoney"}},
                    "divider",
                    {label:"Close Property & All Loans",modal:{type:"closePropPicker"}},
                    {label:"Close Lender Only",modal:"closeLender"},
                    "divider",
                    {label:"Record Draw",modal:{type:"quickDraw"}},
                  ].map((item,i)=>
                    item==="divider"
                      ?<div key={i} className="h-px bg-slate-100 dark:bg-zinc-700 mx-3 my-1"/>
                      :<button key={typeof item.modal==="string"?item.modal:item.modal.type}
                        onClick={()=>{setFabOpen(false);setTab("Properties");setFabPending(item.modal);}}
                        className="w-full text-left px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors">
                        {item.label}
                      </button>
                  )}
                </div>
              )}
            </div>
            </div>
          </div>
        </div>

        {/* Page content */}
        {navStack.length>0 ? (
          <EntityDetailView entity={navStack[navStack.length-1]} data={data} update={update} onBack={()=>setNavStack(s=>s.slice(0,-1))} navigate={navStackNavigate}/>
        ) : (
          <div className="px-5 pt-4 pb-8 w-full max-w-5xl mx-auto">
            {/* Records sub-nav */}
            {["Closed","History"].includes(tab)&&(
              <div className="flex mb-4 bg-white dark:bg-[#1C1C1E] rounded-xl overflow-hidden shadow-sm border border-slate-100 dark:border-zinc-800 self-start w-fit">
                {[["Closed","Closed Deals"],["History","History"]].map(([id,l])=>(
                  <button key={id} onClick={()=>setTab(id)}
                    className={`px-4 py-2 text-sm font-semibold transition-all ${tab===id?"bg-blue-600 text-white":"text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200"}`}>
                    {l}
                  </button>
                ))}
              </div>
            )}
            {tab==="Dashboard"     &&<DashboardPage data={data} update={update} onNavigateTab={t=>{setNavStack([]);setPanelStack([]);if(t==="AllLoans:hard"){setLoanFilterPending("hard");setTab("AllLoans");}else setTab(t);}}/>}
            {tab==="Properties"    &&<PropertiesPage data={data} update={update} pendingAction={fabPending} onClearPendingAction={()=>setFabPending(null)}/>}
            {tab==="LenderDash"   &&<LenderDashboard data={data}/>}
            {tab==="AllLoans"     &&<AllLoansPage data={data} update={update} pendingTypeFilter={loanFilterPending} onClearPendingTypeFilter={()=>setLoanFilterPending(null)}/>}
            {tab==="PropDash"     &&<PropertyDashboard data={data}/>}
            {tab==="RehabPriority"&&<RehabPriorityPage data={data} update={update}/>}
            {tab==="Closed"       &&<ClosedDealsPage data={data} update={update}/>}
            {tab==="History"      &&<HistoryPage data={data}/>}
            {tab==="Draws"        &&<DrawsPage data={data}/>}
            {tab==="LenderAccts"  &&<ManageLendersPage data={data}/>}
          </div>
        )}
      </div>

      {/* ── Slide-in detail panel ── */}
      {panelStack.length>0&&(
        <>
          {/* Backdrop — click to dismiss */}
          <div className="fixed inset-0 z-40 bg-black/30 dark:bg-black/50 backdrop-blur-[2px]" onClick={()=>setPanelStack([])}/>
          {/* Panel */}
          <div className="fixed top-0 right-0 bottom-0 z-50 flex flex-col bg-[#F2F2F7] dark:bg-[#0A0A0A] shadow-2xl" style={{width:'min(700px,82vw)'}}>
            {/* Panel chrome */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-black/[0.06] dark:border-white/[0.05] bg-white/70 dark:bg-black/70 backdrop-blur-xl shrink-0">
              {panelStack.length>1&&(
                <button onClick={()=>setPanelStack(s=>s.slice(0,-1))}
                  className="flex items-center gap-1 text-xs font-semibold text-slate-500 dark:text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
                  Back
                </button>
              )}
              <div className="flex-1"/>
              <button
                onClick={()=>{const e=panelStack[panelStack.length-1];setPanelStack([]);setNavStack([e]);}}
                className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors">
                View Full Page
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z"/><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/></svg>
              </button>
              <button onClick={()=>setPanelStack([])}
                className="w-6 h-6 flex items-center justify-center rounded-full bg-black/[0.06] dark:bg-white/[0.08] text-slate-500 dark:text-zinc-400 hover:bg-black/10 dark:hover:bg-white/15 transition-all ml-1">
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
              </button>
            </div>
            {/* Panel content — scrollable */}
            <div className="flex-1 overflow-y-auto">
              <EntityDetailView
                entity={panelStack[panelStack.length-1]}
                data={data}
                update={update}
                onBack={()=>setPanelStack(s=>s.slice(0,-1))}
                navigate={entity=>setPanelStack(s=>[...s,entity])}
              />
            </div>
          </div>
        </>
      )}

    </div>
    </PanelContext.Provider>
    </PrivacyContext.Provider>
  );
}
