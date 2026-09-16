import { useState, useEffect, useRef, createContext, useContext } from "react";
import { loadData, saveData, subscribeToChanges, listLenderAccounts, createLenderAccount, deleteLenderAccount } from './supabase'

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

const TypeBadge = ({type,sm}) => {
  const c = type==="hard"
    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
    : "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400";
  const dot = type==="hard" ? "bg-amber-400" : "bg-sky-400";
  return <span className={`inline-flex items-center gap-1 ${c} rounded-full font-semibold ${sm?"text-[10px] px-2 py-0.5":"text-xs px-2.5 py-1"}`}>
    <span className={`w-1.5 h-1.5 rounded-full ${dot} shrink-0`}/>{type==="hard"?"Hard Money":"Private Money"}
  </span>;
};

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
function LenderMoneyForm({ properties, init, onSave, onClose }) {
  const activeProps = properties.filter(p=>!p.dateSold);
  const [f, sf] = useState(()=>({
    lenderName:"", loanType:"private", principal:"",
    startDate:TODAY, interestType:"percentage", interestRate:"", specialTerms:"", endDate:"",
    destination:"unassigned",
    paymentType:"closing", monthlyPayment:"", drawFacility:null,
    ...(init??{}),
    paymentType: init?.paymentType || (init?.loanType==="hard" ? "monthly_rate" : "closing"),
    monthlyPayment: String(init?.monthlyPayment||""),
  }));
  const [drawDate,setDrawDate]=useState(TODAY);
  const [drawAmt,setDrawAmt]=useState("");
  const s = k => v => sf(p=>({...p,[k]:v}));
  const destOptions = [
    ["unassigned","💼  Unassigned — not yet placed on a property"],
    ...activeProps.map(p=>[p.id, `🏠  ${p.address}`]),
  ];
  const isFixed = (f.interestType || "percentage") === "fixed";
  const addDraw = () => {
    const amount = parseFloat(drawAmt);
    if (!amount||!drawDate) return;
    sf(p=>({...p,drawFacility:{...p.drawFacility,draws:[...(p.drawFacility?.draws||[]),{id:uid(),date:drawDate,amount}]}}));
    setDrawAmt("");
  };
  const handleSave = () => {
    if (!f.lenderName?.trim()) { alert("Please enter a lender name."); return; }
    if (!f.startDate) { alert("Please enter a start date."); return; }
    if (!(parseFloat(f.principal) > 0)) { alert("Please enter an amount greater than zero."); return; }
    onSave(f);
  };

  return (
    <div>
      <LenderAutocomplete value={f.lenderName} onChange={s("lenderName")} properties={properties}/>
      <Sel label="Money Type" value={f.loanType} onChange={s("loanType")} options={[["private","Private Money"],["hard","Hard Money"]]}/>
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Where Does This Money Go?</label>
        <select value={f.destination} onChange={e=>s("destination")(e.target.value)}
          className="w-full border-2 border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-950 rounded-xl px-4 py-3 text-sm font-semibold text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all appearance-none">
          {destOptions.map(([v,l])=><option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div className="border-t border-slate-100 dark:border-zinc-800 pt-3 mt-1">
        <Inp label="Amount ($) *" type="number" value={f.principal} onChange={s("principal")} placeholder="100000"/>
        <DateInp label="Start Date *" value={f.startDate} onChange={s("startDate")}/>
        <DateInp label="End / Payoff Date" value={f.endDate} onChange={s("endDate")} helpText="Leave blank while the loan is active"/>
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
      {f.loanType==="hard"&&(
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
const propSizeConflict = (loanAmount, prop) => {
  const active = prop.loans.filter(l=>!l.endDate);
  const needed = propNeeded(prop, active);
  if (needed <= 0) return false;
  const funded = active.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);
  const shortage = Math.max(0, needed - funded);
  return loanAmount > shortage + needed * 0.10; // allow 10% contingency
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
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$(loanAmt)} · {fmtRate(fund)} · <TypeBadge type={fund.loanType} sm/></div>
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
        {blockedDate.length>0&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">Not Available — Timing Issue</div>
            <div className="space-y-1.5">
              {blockedDate.map(p=>(
                <button key={p.id} onClick={()=>handleClick(p)}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-50 cursor-not-allowed">
                  <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500">🕐 {p.address}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {blockedSize.length>0&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">Not Available — No Funding Gap</div>
            <div className="space-y-1.5">
              {blockedSize.map(p=>(
                <button key={p.id} onClick={()=>handleClick(p)}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-50 cursor-not-allowed">
                  <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500">📐 {p.address}</span>
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
  const showUnassigned = item.type==="loan";

  const available=[], blockedDate=[], blockedSize=[];
  for (const p of candidateProps) {
    const c=propConflict(loanStartDate,amount,p);
    if (!c) available.push(p);
    else if (c==='date') blockedDate.push(p);
    else blockedSize.push(p);
  }

  if (!candidateProps.length&&!showUnassigned) return (
    <Modal title="Move Money" onClose={onClose}>
      <p className="text-sm text-slate-500 dark:text-zinc-400 mb-4">No other properties to move to.</p>
      <Btn onClick={onClose} color="ghost" full>Close</Btn>
    </Modal>
  );

  const handleClick = id => {
    if (id==='unassigned') { onMove('unassigned'); return; }
    const p=properties.find(x=>x.id===id);
    const c=propConflict(loanStartDate,amount,p);
    if (c==='date') { setBlockMsg("Cannot move here — this property was acquired after this loan started. The loan would have been uncollateralized during that period. Please pick a property that started before this loan."); return; }
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
        {blockedDate.length>0&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">Not Available — Timing Issue</div>
            <div className="space-y-1.5">
              {blockedDate.map(p=>(
                <button key={p.id} onClick={()=>handleClick(p.id)}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-50 cursor-not-allowed">
                  <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500">🕐 {p.address}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {blockedSize.length>0&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">Not Available — No Funding Gap</div>
            <div className="space-y-1.5">
              {blockedSize.map(p=>(
                <button key={p.id} onClick={()=>handleClick(p.id)}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-50 cursor-not-allowed">
                  <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500">📐 {p.address}</span>
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
                            <TypeBadge type={r.loanType} sm/>
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
                            <TypeBadge type={r.loanType} sm/>
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

// ─── Collapsible Unassigned Funds ─────────────────────────────────────────────
function CollapsibleUnassigned({ funds, total, onPlace, onMove, onEdit, onDelete, onSplit }) {
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
                  <button onClick={()=>openPanel({type:'lender',name:u.lenderName})} className="font-semibold text-slate-900 dark:text-zinc-100 text-sm hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left">{u.lenderName}</button>
                  <TypeBadge type={u.loanType} sm/>
                  <span className="font-bold text-violet-700 dark:text-violet-300 text-sm tabular-nums">{h$(principal)}</span>
                  {(u.interestRate!=null)&&<span className="text-xs text-slate-400 dark:text-zinc-500">{hr(u)}</span>}
                  {earned>0.01&&<span className="text-xs text-emerald-600 dark:text-emerald-400 tabular-nums">+{h$(earned)}</span>}
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${days>60?"bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800":days>30?"bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800":"bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border-slate-200 dark:border-zinc-700"}`}>
                    {days}d
                  </span>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={()=>onPlace(u)} className="text-[11px] font-bold text-white bg-violet-600 hover:bg-violet-700 rounded-lg px-2.5 py-1 transition-colors">Place →</button>
                  {onSplit&&<button onClick={()=>onSplit(u)} className="text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-2.5 py-1 transition-colors">⚡ Split</button>}
                  <button onClick={()=>onMove(u)}  className="p-1.5 text-slate-300 dark:text-zinc-600 hover:text-violet-500 dark:hover:text-violet-400 text-sm transition-colors">⇄</button>
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
  const [sortOpen,setSortOpen]=useState(false);
  const sortRef=useRef(null);
  useEffect(()=>{
    const h=e=>{if(sortRef.current&&!sortRef.current.contains(e.target))setSortOpen(false);};
    document.addEventListener('mousedown',h);
    return()=>document.removeEventListener('mousedown',h);
  },[]);
  const toggle = id => setExpanded(e=>({...e,[id]:!e[id]}));
  const togglePropSort = col => setPropSort(s=>({col,dir:s.col===col&&s.dir==="asc"?"desc":"asc"}));
  const unassignedTotal = data.unassigned.reduce((s,u)=>s+(u.principal||u.amount||0),0);

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

  const loanFields = f => ({
    lenderName:f.lenderName, loanType:f.loanType, principal:parseFloat(f.principal)||0,
    startDate:f.startDate, interestRate:parseFloat(f.interestRate)||0,
    interestType:f.interestType||"percentage",
    paymentType:f.paymentType||"closing",
    monthlyPayment:parseFloat(f.monthlyPayment)||0,
    drawFacility:f.drawFacility?{committed:parseFloat(f.drawFacility.committed)||0,draws:f.drawFacility.draws||[]}:null,
    specialTerms:f.specialTerms||"", endDate:f.endDate||null,
  });

  const saveMoneyForm = (f, force=false) => {
    const base=loanFields(f);
    if(f.destination==="unassigned"){
      update(d=>({...d,unassigned:[...d.unassigned,{id:uid(),...base}]}));
      setModal(null);
    } else {
      const destProp=data.properties.find(p=>p.id===f.destination);
      const conflict=destProp?loanPropConflict(base.startDate,destProp):0;
      if(conflict>0&&!force){
        if(!window.confirm(`⚠️ This loan started ${conflict} days before the property was acquired — the money would be uncollateralized for that period.\n\nPlace it anyway?`))return;
      }
      update(d=>({...d,properties:d.properties.map(p=>p.id!==f.destination?p:{...p,loans:[...p.loans,{id:uid(),...base}]})}));
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
    update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,loans:p.loans.map(x=>x.id===l.id?l:x)})}));
    setModal(null);
  };

  const handleCloseLoan = (propId, loan, closeDate) => {
    update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,loans:p.loans.map(l=>l.id!==loan.id?l:{...l,endDate:closeDate})})}));
    setModal(null);
  };

  const placeOnProperty = (fund,propId) => {
    const loan={id:uid(),lenderName:fund.lenderName,loanType:fund.loanType,principal:fund.principal||fund.amount||0,startDate:fund.startDate||fund.date||TODAY,interestRate:fund.interestRate||0,interestType:fund.interestType||"percentage",paymentType:fund.paymentType||"closing",monthlyPayment:fund.monthlyPayment||0,drawFacility:fund.drawFacility||null,specialTerms:fund.specialTerms||fund.notes||"",endDate:fund.endDate||null};
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

  const handleSplitLoan = (fund, splits) => {
    const newUnassigned = splits
      .filter(s=>s.propId==="unassigned")
      .map(s=>({...fund, id:uid(), principal:s.amount, drawFacility:null}));
    update(d=>({
      ...d,
      unassigned: [...d.unassigned.filter(u=>u.id!==fund.id), ...newUnassigned],
      properties: d.properties.map(p=>{
        const piece=splits.find(s=>s.propId===p.id);
        if(!piece) return p;
        const newLoan={...fund, id:uid(), principal:piece.amount, drawFacility:null};
        return{...p,loans:[...p.loans,newLoan]};
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
      if(propSortMode==="shortage"){
        const shortOf=p=>{const al=p.loans.filter(l=>!l.endDate);const f=al.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);return Math.max(0,propNeeded(p,al)-f);};
        return d*(shortOf(b)-shortOf(a));
      }
      if(propSortMode==="rehabPriority")return d*(rehabBurn(b)-rehabBurn(a));
      if(propSortMode==="dateAcquired")return d*propPurchaseDate(a).localeCompare(propPurchaseDate(b));
      if(propSortMode==="address")return d*(a.address||"").localeCompare(b.address||"");
      if(propSortMode==="dateSold")return d*(a.dateSold||"0000").localeCompare(b.dateSold||"0000");
      return d*propSellDate(a).localeCompare(propSellDate(b));
    });
  const activeCount=data.properties.filter(p=>!p.dateSold).length;
  const totalCount=data.properties.length;

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Active Properties</h2>
          <p className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">
            <span className="font-semibold text-slate-600 dark:text-zinc-300">{activeCount} active</span>
            {totalCount>activeCount&&<span> · {totalCount-activeCount} sold</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-400 cursor-pointer select-none">
            <input type="checkbox" checked={showSold} onChange={e=>setShowSold(e.target.checked)} className="rounded"/> Show Sold
          </label>
          <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-lg p-0.5 gap-0.5">
            {[["condensed","≡"],["expanded","⊞"]].map(([v,icon])=>(
              <button key={v} onClick={()=>setViewMode(v)} title={v==="condensed"?"Condensed view":"Expanded view"}
                className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all ${viewMode===v?"bg-white dark:bg-zinc-700 text-slate-900 dark:text-zinc-100 shadow-sm":"text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300"}`}>
                {icon}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Search + Sort */}
      <div className="mb-4 space-y-2">
        <input type="text" value={propSearch} onChange={e=>setPropSearch(e.target.value)}
          placeholder="Search by address or lender…"
          className="w-full rounded-xl px-4 py-2.5 text-sm bg-white dark:bg-[#1C1C1E] text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-[0_1px_6px_rgba(0,0,0,0.06)] dark:shadow-none border-0"/>
        <div className="flex items-center gap-2">
          <div ref={sortRef} className="relative">
            <button onClick={()=>setSortOpen(o=>!o)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-all border border-slate-200 dark:border-zinc-700">
              <span>Sort: {[["shortage","Shortage"],["rehabPriority","🔥 Priority"],["estClose","Est. Close"],["dateAcquired","Acquired"],["dateSold","Date Sold"],["address","A–Z"]].find(([v])=>v===propSortMode)?.[1]??propSortMode}</span>
              <span className="text-slate-400 dark:text-zinc-500">{sortOpen?"▲":"▼"}</span>
            </button>
            {sortOpen&&(
              <div className="absolute left-0 top-9 w-44 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-30">
                {[["shortage","Shortage"],["rehabPriority","🔥 Priority"],["estClose","Est. Close"],["dateAcquired","Acquired"],["dateSold","Date Sold"],["address","A–Z"]].map(([v,l])=>(
                  <button key={v} onClick={()=>{setPropSortMode(v);setSortOpen(false);}}
                    className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${propSortMode===v?"bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-semibold":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700"}`}>
                    {l}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={()=>setPropSortDir(d=>d==="asc"?"desc":"asc")}
            className="px-3 py-1.5 rounded-xl text-[11px] font-bold bg-white dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-all shrink-0 border border-slate-200 dark:border-zinc-700">
            {propSortDir==="asc"?"↑ Asc":"↓ Desc"}
          </button>
        </div>
      </div>

      {data.unassigned.length>0&&(
        <CollapsibleUnassigned funds={data.unassigned} total={unassignedTotal}
          onPlace={u=>setModal({type:"place",fund:u})} onMove={u=>setModal({type:"moveUnassigned",fund:u})}
          onEdit={u=>setModal({type:"editUnassigned",fund:u})} onDelete={delUnassigned}
          onSplit={u=>setModal({type:"splitLoan",fund:u})}/>
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
        const sorted=[...rows].sort((a,b)=>{
          if(!propSort.col){
            if(propSortMode==="rehabPriority")return 0; // already ordered by burn in visible[]
            return propSellDate(a.prop).localeCompare(propSellDate(b.prop));
          }
          const d=propSort.dir==="asc"?1:-1;
          switch(propSort.col){
            case"Address": return d*(a.prop.address||"").localeCompare(b.prop.address||"");
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
                    const rankCls=propSortMode==="rehabPriority"&&!propSort.col?(i===0?"text-red-500 dark:text-red-400":i===1?"text-orange-500 dark:text-orange-400":i===2?"text-amber-500 dark:text-amber-400":"text-slate-300 dark:text-zinc-600"):"text-slate-300 dark:text-zinc-600";
                    return(
                    <tr key={prop.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors">
                      <td className={`py-2.5 px-4 tabular-nums font-semibold ${rankCls}`}>{i+1}</td>
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

      {viewMode==="expanded"&&<div className="space-y-3">
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

          return (
            <div key={prop.id} className={`rounded-2xl overflow-hidden transition-all ${prop.dateSold?"opacity-50":"shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none"} bg-white dark:bg-[#1C1C1E]`}>

              {/* Header — clean PropDash style, click anywhere to expand */}
              <div className={`px-5 py-3.5 cursor-pointer ${under?"bg-red-50/60 dark:bg-red-950/15":""}`} onClick={()=>toggle(prop.id)}>
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-center gap-2 min-w-0 mr-3">
                    {propSortMode==="rehabPriority"&&<span className={`text-[11px] font-bold w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${visIdx===0?"text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20":visIdx===1?"text-orange-500 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20":visIdx===2?"text-amber-500 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20":"text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800"}`}>#{visIdx+1}</span>}
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
                  {/* Loans header with edit/delete */}
                  <div className="px-4 py-2.5 flex justify-between items-center bg-[#F9F9FB] dark:bg-black/20">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Loans · {prop.loans.length}</span>
                      <button onClick={e=>{e.stopPropagation();setModal({type:"editProp",prop});}} className="w-6 h-6 flex items-center justify-center rounded-md text-slate-300 dark:text-zinc-600 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all text-xs" title="Edit Property">✏️</button>
                      <button onClick={e=>{e.stopPropagation();delProp(prop.id);}} className="w-6 h-6 flex items-center justify-center rounded-md text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all text-xs" title="Delete Property">🗑</button>
                    </div>
                    <div className="flex gap-1.5">
                      {!prop.dateSold&&<Btn onClick={e=>{e.stopPropagation();setModal({type:"markSold",prop});}} color="navy" sm>🏁 Close</Btn>}
                      <Btn onClick={()=>setModal({type:"addMoney",propId:prop.id})} color="green" sm>+ Add Money</Btn>
                    </div>
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
                                <button onClick={()=>openPanel?.({type:'lender',name:loan.lenderName})} className="font-semibold text-slate-900 dark:text-zinc-100 text-[13px] hover:text-blue-600 dark:hover:text-blue-400 text-left transition-colors">{hn(loan.lenderName)}</button>
                                <TypeBadge type={loan.loanType} sm/>
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
                              <button onClick={()=>openPanel?.({type:'loan',loanId:loan.id,propId:prop.id})} className="px-2 py-1 text-[10px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 bg-slate-50 dark:bg-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 border border-slate-200 dark:border-zinc-700 hover:border-blue-200 dark:hover:border-blue-800 rounded-lg transition-all" title="View Loan">View →</button>
                              <button onClick={()=>setModal({type:"moveLoan",propId:prop.id,loan})} className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 dark:text-zinc-600 hover:text-violet-500 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-all text-base" title="Move">⇄</button>
                              <button onClick={()=>setModal({type:"editLoan",propId:prop.id,loan})} className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 dark:text-zinc-600 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all text-sm" title="Edit">✏️</button>
                              {!loan.endDate&&<button onClick={()=>setModal({type:"closeLoan",propId:prop.id,loan})} className="px-2 py-1 text-[10px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-orange-600 dark:hover:text-orange-400 bg-slate-50 dark:bg-zinc-800 hover:bg-orange-50 dark:hover:bg-orange-900/20 border border-slate-200 dark:border-zinc-700 hover:border-orange-200 dark:hover:border-orange-800 rounded-lg transition-all" title="Close Loan">Close Loan</button>}
                              <button onClick={()=>delLoan(prop.id,loan.id)} className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all text-sm" title="Delete">🗑</button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>}

      {(modal==="addMoney"||modal?.type==="addMoney")&&<Modal title="Add Lender Money" onClose={()=>setModal(null)}><LenderMoneyForm properties={data.properties} init={modal?.propId?{destination:modal.propId}:undefined} onSave={saveMoneyForm} onClose={()=>setModal(null)}/></Modal>}
      {modal==="addProp"&&<Modal title="Add Property" onClose={()=>setModal(null)}><PropertyForm onSave={f=>saveProp(f,null)} onClose={()=>setModal(null)}/></Modal>}
      {modal?.type==="editProp"&&<Modal title="Edit Property" onClose={()=>setModal(null)}><PropertyForm init={modal.prop} onSave={f=>saveProp(f,modal.prop)} onClose={()=>setModal(null)}/></Modal>}
      {modal?.type==="editLoan"&&<Modal title="Edit Loan" onClose={()=>setModal(null)}>
        <LenderMoneyForm properties={data.properties} init={{...modal.loan,destination:modal.propId,principal:String(modal.loan.principal),interestRate:String(modal.loan.interestRate||""),interestType:modal.loan.interestType||"percentage",paymentType:modal.loan.paymentType||"closing",monthlyPayment:String(modal.loan.monthlyPayment||""),drawFacility:modal.loan.drawFacility||null}}
          onSave={f=>saveEditedLoan(modal.propId,f,modal.loan)} onClose={()=>setModal(null)}/>
      </Modal>}
      {modal?.type==="editUnassigned"&&<Modal title="Edit Unassigned Fund" onClose={()=>setModal(null)}>
        <LenderMoneyForm properties={data.properties}
          init={{...modal.fund,destination:"unassigned",principal:String(modal.fund.principal||modal.fund.amount||""),interestRate:String(modal.fund.interestRate||""),interestType:modal.fund.interestType||"percentage"}}
          onSave={f=>{
            const updated={...modal.fund,lenderName:f.lenderName,loanType:f.loanType,principal:parseFloat(f.principal)||0,startDate:f.startDate,interestRate:parseFloat(f.interestRate)||0,interestType:f.interestType||"percentage",specialTerms:f.specialTerms||"",endDate:f.endDate||null};
            if(f.destination!=="unassigned"){update(d=>({...d,unassigned:d.unassigned.filter(u=>u.id!==modal.fund.id),properties:d.properties.map(p=>p.id!==f.destination?p:{...p,loans:[...p.loans,{id:uid(),...updated}]})}));}
            else{update(d=>({...d,unassigned:d.unassigned.map(u=>u.id===modal.fund.id?updated:u)}));}
            setModal(null);
          }} onClose={()=>setModal(null)}/>
      </Modal>}
      {modal?.type==="place"&&<PlaceOnPropertyModal fund={modal.fund} properties={data.properties} onPlace={propId=>placeOnProperty(modal.fund,propId)} onClose={()=>setModal(null)}/>}
      {modal?.type==="closeLoan"&&<CloseLoanModal loan={modal.loan} onConfirm={date=>handleCloseLoan(modal.propId,modal.loan,date)} onClose={()=>setModal(null)}/>}
      {modal?.type==="splitLoan"&&<SplitLoanModal fund={modal.fund} properties={data.properties} onConfirm={splits=>handleSplitLoan(modal.fund,splits)} onClose={()=>setModal(null)}/>}
      {modal?.type==="moveLoan"&&<MoveModal item={{type:"loan",propId:modal.propId,loan:modal.loan}} properties={data.properties} onMove={dest=>handleMove({type:"loan",propId:modal.propId,loan:modal.loan},dest)} onClose={()=>setModal(null)}/>}
      {modal?.type==="moveUnassigned"&&<MoveModal item={{type:"unassigned",fund:modal.fund}} properties={data.properties} onMove={dest=>{placeOnProperty(modal.fund,dest);setModal(null);}} onClose={()=>setModal(null)}/>}
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
  const [sortBy, setSortBy] = usePersistedState("nx-lenderSortBy2", "name");

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

  if (search) {
    const q = search.toLowerCase();
    lenders = lenders.filter(ld => ld.name?.toLowerCase().includes(q) || ld.props.some(p => p.toLowerCase().includes(q)));
  }

  lenders.sort((a,b) => {
    if (sortBy === "principal") return b.totalPrin - a.totalPrin;
    if (sortBy === "balance") return b.totalBal - a.totalBal;
    if (sortBy === "loans") return b.activeLoans.length - a.activeLoans.length;
    return (a.name||"").localeCompare(b.name||"");
  });

  const totalPrin = Object.values(byLender).reduce((s,ld) => s + ld.totalPrin, 0);
  const totalBal = Object.values(byLender).reduce((s,ld) => s + ld.totalBal, 0);
  const totalInt = Object.values(byLender).reduce((s,ld) => s + ld.totalInt, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">Lenders</h2>
          <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">{lenders.length} lender{lenders.length!==1?"s":""}</p>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3 mb-5">
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
      </div>

      {/* Search + sort */}
      <div className="flex items-center gap-2 mb-4">
        <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search lenders or properties…"
          className="flex-1 px-3 py-2 rounded-xl text-sm bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
        <select value={sortBy} onChange={e=>setSortBy(e.target.value)}
          className="px-3 py-2 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none">
          <option value="name">A–Z</option>
          <option value="principal">By Principal</option>
          <option value="balance">By Balance</option>
          <option value="loans">By # Loans</option>
        </select>
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
                  {ld.types.map(t => <TypeBadge key={t} type={t} sm/>)}
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
function AllLoansPage({ data }) {
  const prv = usePrivacy();
  const navigate = usePanel();
  const h$ = v => prv ? maskMoney($$(v)) : $$(v);
  const hr = l => { if(!prv) return fmtRate(l); const s=fmtRate(l); return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s); };
  const [filter, setFilter] = usePersistedState("nx-loansFilter", "active");
  const [search, setSearch] = useState("");

  const allLoans = [
    ...data.properties.flatMap(p => p.loans.map(l => ({...l, prop:p, propAddress:p.address, propId:p.id}))),
    ...(data.unassigned||[]).map(l => ({...l, prop:null, propAddress:null, propId:null})),
  ].sort((a,b) => (b.startDate||"").localeCompare(a.startDate||""));

  const filtered = allLoans.filter(l => {
    const matchFilter = filter === "all" || (filter === "active" ? !l.endDate : !!l.endDate);
    const q = search.toLowerCase();
    const matchSearch = !search || l.lenderName?.toLowerCase().includes(q) || l.propAddress?.toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });

  const totalPrin = filtered.filter(l=>!l.endDate).reduce((s,l) => s + (l.principal||0), 0);
  const totalBal = filtered.filter(l=>!l.endDate).reduce((s,l) => s + calcBalance(l), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">All Loans</h2>
          <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">
            {allLoans.filter(l=>!l.endDate).length} active · {allLoans.filter(l=>!!l.endDate).length} closed
          </p>
        </div>
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
            {f.charAt(0).toUpperCase()+f.slice(1)}
          </button>
        ))}
        <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search lender or property…"
          className="ml-auto w-52 px-3 py-1.5 rounded-xl text-xs bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
      </div>

      {/* Loans table */}
      <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-slate-400 dark:text-zinc-500 text-sm">No loans match this filter</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest border-b border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-900/20">
                <th className="px-4 pb-2.5 pt-3 text-left font-semibold">Lender</th>
                <th className="px-3 pb-2.5 pt-3 text-left font-semibold">Property</th>
                <th className="px-3 pb-2.5 pt-3 text-right font-semibold">Principal</th>
                <th className="px-3 pb-2.5 pt-3 text-right font-semibold">Balance</th>
                <th className="px-3 pb-2.5 pt-3 text-right font-semibold">Rate</th>
                <th className="px-3 pb-2.5 pt-3 text-right font-semibold">Started</th>
                <th className="px-4 pb-2.5 pt-3 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800">
              {filtered.map(l => {
                const bal = calcBalance(l);
                return (
                  <tr key={l.id} className="hover:bg-slate-50 dark:hover:bg-zinc-900/30 transition-colors cursor-pointer" onClick={() => navigate({type:'loan', loanId:l.id, propId:l.propId})}>
                    <td className="px-4 py-3">
                      <button onClick={e=>{e.stopPropagation();navigate({type:'lender',name:l.lenderName});}} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline text-left">
                        {l.lenderName||"Unknown"}
                      </button>
                      <TypeBadge type={l.loanType} sm/>
                    </td>
                    <td className="px-3 py-3">
                      {l.prop
                        ? <button onClick={e=>{e.stopPropagation();navigate({type:'property',id:l.propId});}} className="text-slate-600 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400 hover:underline text-left max-w-[160px] truncate block">{l.propAddress}</button>
                        : <span className="text-slate-400 dark:text-zinc-500 italic">Unassigned</span>
                      }
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-semibold text-slate-800 dark:text-zinc-200">{h$(l.principal)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-blue-600 dark:text-blue-400">{h$(bal)}</td>
                    <td className="px-3 py-3 text-right text-slate-500 dark:text-zinc-400">{hr(l)}</td>
                    <td className="px-3 py-3 text-right text-slate-500 dark:text-zinc-400">{l.startDate||"—"}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${l.endDate?"bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400":"bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"}`}>
                        {l.endDate ? "Closed" : "Active"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
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
      <div className="mb-5">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">Property Dashboard</h2>
        <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">Capital deployment overview</p>
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
              <table className="w-full text-xs bg-white dark:bg-[#1C1C1E]">
                <tbody className="divide-y divide-black/[0.04] dark:divide-white/[0.04]">
                  {loans.map(l=>(
                    <tr key={l.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                      <td className="px-5 py-2.5 font-semibold text-slate-800 dark:text-zinc-100">{hn(l.lenderName)}</td>
                      <td className="px-3 py-2.5"><TypeBadge type={l.loanType} sm/></td>
                      <td className="px-3 py-2.5 text-right text-slate-600 dark:text-zinc-300 tabular-nums">{h$(l.principal)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400 dark:text-zinc-500 whitespace-nowrap">{hr(l)}</td>
                      <td className="px-5 py-2.5 text-right font-bold text-blue-700 dark:text-blue-400 tabular-nums">{h$(calcBalance(l))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
  const [closedSortOpen,setClosedSortOpen]=useState(false);
  const closedSortRef=useRef(null);
  useEffect(()=>{
    const h=e=>{if(closedSortRef.current&&!closedSortRef.current.contains(e.target))setClosedSortOpen(false);};
    document.addEventListener('mousedown',h);
    return()=>document.removeEventListener('mousedown',h);
  },[]);
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
              :<table className="w-full text-xs">
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
                      <td className="py-2 text-right"><TypeBadge type={l.loanType} sm/></td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
          <h2 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">Closed Deals</h2>
          <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">
            {flips.length} flip{flips.length!==1?"s":""} · {rentals.length} rental{rentals.length!==1?"s":""}
          </p>
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

      {/* Search + Sort */}
      {current.length>0&&(
        <div className="mb-4 space-y-2">
          <input type="text" value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search by address or lender…"
            className="w-full rounded-xl px-4 py-2.5 text-sm bg-white dark:bg-[#1C1C1E] text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-[0_1px_6px_rgba(0,0,0,0.06)] dark:shadow-none border-0"/>
          <div className="flex items-center gap-2">
            <div ref={closedSortRef} className="relative">
              <button onClick={()=>setClosedSortOpen(o=>!o)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-all border border-slate-200 dark:border-zinc-700">
                <span>Sort: {[["dateSold","Date Sold"],["dateAcquired","Acquired"],["profit","Profit"],["address","A–Z"]].find(([v])=>v===sortMode)?.[1]??sortMode}</span>
                <span className="text-slate-400 dark:text-zinc-500">{closedSortOpen?"▲":"▼"}</span>
              </button>
              {closedSortOpen&&(
                <div className="absolute left-0 top-9 w-40 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-30">
                  {[["dateSold","Date Sold"],["dateAcquired","Acquired"],["profit","Profit"],["address","A–Z"]].map(([v,l])=>(
                    <button key={v} onClick={()=>{setSortMode(v);setClosedSortOpen(false);}}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${sortMode===v?"bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-semibold":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700"}`}>
                      {l}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={()=>setCurrentDir(d=>d==="asc"?"desc":"asc")}
              className="px-3 py-1.5 rounded-xl text-[11px] font-bold bg-white dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-all shrink-0 border border-slate-200 dark:border-zinc-700">
              {currentDir==="asc"?"↑ Asc":"↓ Desc"}
            </button>
          </div>
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
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">History</h2>
          <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">{view==="trail"?"Auto-generated transaction log":"Closed loan records"}</p>
        </div>
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
      <div className="space-y-2 mb-4">
        {view==="trail"&&<input type="text" value={propSearch} onChange={e=>setPropSearch(e.target.value)}
          placeholder="Search by address, lender, date, event type…"
          className="w-full rounded-xl px-4 py-2.5 text-sm bg-white dark:bg-[#1C1C1E] text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-[0_1px_6px_rgba(0,0,0,0.06)] dark:shadow-none border-0"/>}
        <div className="flex gap-2">
          <select value={lf} onChange={e=>setLf(e.target.value)} className="flex-1 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-[#1C1C1E] text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-[0_1px_6px_rgba(0,0,0,0.06)] dark:shadow-none border-0">
            <option value="all">All Lenders</option>
            {(view==="trail"?allL:allLedgerLenders).map((l,i)=><option key={l} value={l}>{prv?`Lender ${i+1}`:l}</option>)}
          </select>
          <select value={tf} onChange={e=>setTf(e.target.value)} className="rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-[#1C1C1E] text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-[0_1px_6px_rgba(0,0,0,0.06)] dark:shadow-none border-0">
            <option value="all">All Types</option><option value="private">Private</option><option value="hard">Hard</option>
          </select>
        </div>
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
                          <TypeBadge type={l.loanType} sm/>
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
                      <TypeBadge type={ev.loanType} sm/>
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
    .sort((a,b)=>dir==="desc"?b.totalBurn-a.totalBurn:a.totalBurn-b.totalBurn);

  const grandTotal=rows.reduce((s,r)=>s+r.totalBurn,0);
  const daysNum=parseFloat(avgDaysBehind)||0;
  const extraFromDelay=daysNum!==0?Math.round(grandTotal*(daysNum/30.44)):0;
  const extraPerYear=Math.round(extraFromDelay*12);

  return(
    <div>
      <div className="flex justify-between items-center mb-3">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">Rehab Priority</h2>
          <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">Ranked by interest that exits at sale — finish these first</p>
        </div>
        <div className="flex items-center gap-2">
          {grandTotal>0&&<span className="text-xs font-semibold text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 px-2.5 py-1 rounded-full">{h$(grandTotal)}/mo total</span>}
          <button onClick={()=>setDir(d=>d==="desc"?"asc":"desc")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white dark:bg-[#1C1C1E] shadow-[0_1px_6px_rgba(0,0,0,0.06)] dark:shadow-none text-sm font-semibold text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors border-0">
            {dir==="desc"?"Highest First ↓":"Lowest First ↑"}
          </button>
        </div>
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
                            <TypeBadge type={loan.loanType} sm/>
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

  // Collect all active properties that have at least one draw-facility loan
  const rows = (data.properties||[])
    .filter(p => !p.dateSold)
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

      return { prop: p, drawLoans, totalCommitted, totalDrawn, totalAvailable, lastDrawDate, daysSinceDraw, allDraws };
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Most overdue (most days since last draw or never drawn) first
      const da = a.daysSinceDraw ?? 99999;
      const db = b.daysSinceDraw ?? 99999;
      return db - da;
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

      {rows.map(({ prop, drawLoans, totalCommitted, totalDrawn, totalAvailable, lastDrawDate, daysSinceDraw }) => {
        const pct_drawn = totalCommitted > 0 ? Math.min(100, Math.round(totalDrawn/totalCommitted*100)) : 0;
        const urgency = daysSinceDraw === null ? "new" : daysSinceDraw >= 21 ? "high" : daysSinceDraw >= 10 ? "med" : "low";
        const urgencyColor = urgency==="new" ? "text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30"
          : urgency==="high" ? "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30"
          : urgency==="med" ? "text-amber-600 dark:text-amber-500 bg-amber-50 dark:bg-amber-900/30"
          : "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30";

        return (
          <div key={prop.id} className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] overflow-hidden">
            {/* Property header */}
            <div className="px-4 pt-4 pb-3 border-b border-slate-100 dark:border-zinc-800">
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold text-[14px] text-slate-900 dark:text-zinc-100 leading-snug flex-1">{prop.address}</div>
                <div className={`shrink-0 text-[11px] font-bold px-2 py-0.5 rounded-full ${urgencyColor}`}>
                  {daysSinceDraw === null ? "Never drawn" : `${daysSinceDraw}d ago`}
                </div>
              </div>
              {lastDrawDate && (
                <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">Last draw {lastDrawDate}</div>
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
        </div>
      </div>

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
                      <button onClick={() => navigate({type:'lender', name:l.lenderName})} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline text-sm text-left">
                        {l.lenderName || "Unknown Lender"}
                      </button>
                      <TypeBadge type={l.loanType} sm/>
                    </div>
                    <button onClick={() => navigate({type:'loan', loanId:l.id, propId:prop.id})} className="text-[11px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 shrink-0 whitespace-nowrap transition-colors">
                      View Loan →
                    </button>
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
                    <button onClick={() => navigate({type:'lender', name:l.lenderName})} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline text-left">{l.lenderName||"Unknown"}</button>
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
      )}

      {/* Closing data lender payoffs */}
      {cd?.lenderPayoffs?.length > 0 && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800">
            <SectionHead title="Payoffs at Close"/>
          </div>
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
                    <button onClick={() => navigate({type:'lender', name:lp.lenderName})} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline text-left">{lp.lenderName||"Unknown"}</button>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums font-semibold text-slate-700 dark:text-zinc-200">{h$(lp.principalPayoff||0)}</td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold text-slate-700 dark:text-zinc-200">{h$(lp.wireAmount||0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {prop.loans.length === 0 && (
        <div className="text-center py-12 text-slate-400 dark:text-zinc-500 text-sm">No loans recorded for this property.</div>
      )}
    </div>
  );
}

function LenderDetailPage({ name, data, onBack, navigate }) {
  const prv = usePrivacy();
  const h$ = v => prv ? maskMoney($$(v)) : $$(v);
  const hr = l => { if(!prv) return fmtRate(l); const s=fmtRate(l); return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s); };

  const allLoans = [
    ...data.properties.flatMap(p => p.loans.map(l => ({...l, prop:p}))),
    ...(data.unassigned||[]).map(l => ({...l, prop:null})),
  ].filter(l => l.lenderName === name);
  const active = allLoans.filter(l => !l.endDate);
  const hist = allLoans.filter(l => l.endDate).sort((a,b) => (b.endDate||"").localeCompare(a.endDate||""));
  const totPrin = active.reduce((s,l) => s + (l.principal||0), 0);
  const totBal = active.reduce((s,l) => s + calcBalance(l), 0);
  const totInt = active.reduce((s,l) => s + calcIntEarned(l), 0);
  const totHistPrin = hist.reduce((s,l) => s + (l.principal||0), 0);
  const totHistInt = hist.reduce((s,l) => s + calcIntEarned(l), 0);

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
        <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Lender</div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">{name || "Unknown"}</h1>
        <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">
          {active.length} active loan{active.length!==1?"s":""} · {hist.length} closed
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          ["Active Principal", h$(totPrin), "text-slate-900 dark:text-zinc-100"],
          ["Balance", h$(totBal), "text-blue-600 dark:text-blue-400"],
          ["Interest (Active)", h$(totInt), "text-emerald-600 dark:text-emerald-400"],
          ["All-Time Paid", h$(totHistPrin), "text-violet-600 dark:text-violet-400"],
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
                      <TypeBadge type={l.loanType} sm/>
                    </div>
                    <button onClick={() => navigate({type:'loan', loanId:l.id, propId:l.prop?.id||null})} className="text-[11px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 shrink-0 whitespace-nowrap transition-colors">
                      View Loan →
                    </button>
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

      {/* Loan history */}
      {hist.length > 0 && (
        <div className="bg-white dark:bg-[#1C1C1E] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <SectionHead title="Loan History" count={hist.length}/>
              <div className="text-xs text-slate-400 dark:text-zinc-500 mb-3">
                {h$(totHistPrin)} principal · {h$(totHistInt)} interest
              </div>
            </div>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest border-b border-slate-100 dark:border-zinc-800">
                <th className="px-5 pb-2 pt-3 text-left font-semibold">Property</th>
                <th className="px-3 pb-2 pt-3 text-right font-semibold">Principal</th>
                <th className="px-3 pb-2 pt-3 text-right font-semibold">Interest</th>
                <th className="px-3 pb-2 pt-3 text-right font-semibold">Started</th>
                <th className="px-5 pb-2 pt-3 text-right font-semibold">Closed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800">
              {hist.map(l => (
                <tr key={l.id} className="hover:bg-slate-50 dark:hover:bg-zinc-900/40 transition-colors">
                  <td className="px-5 py-3">
                    {l.prop
                      ? <button onClick={() => navigate({type:'property', id:l.prop.id})} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline text-left">{l.prop.address}</button>
                      : <span className="text-slate-500 dark:text-zinc-400">Unassigned</span>
                    }
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums font-semibold text-slate-700 dark:text-zinc-200">{h$(l.principal)}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{h$(calcIntEarned(l))}</td>
                  <td className="px-3 py-3 text-right text-slate-500 dark:text-zinc-400">{l.startDate||"—"}</td>
                  <td className="px-5 py-3 text-right text-slate-500 dark:text-zinc-400">{l.endDate||"—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {allLoans.length === 0 && (
        <div className="text-center py-12 text-slate-400 dark:text-zinc-500 text-sm">No loans found for this lender.</div>
      )}
    </div>
  );
}

function LoanDetailPage({ loanId, propId, data, onBack, navigate }) {
  const prv = usePrivacy();
  const h$ = v => prv ? maskMoney($$(v)) : $$(v);
  const hr = l => { if(!prv) return fmtRate(l); const s=fmtRate(l); return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s); };

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

  return (
    <div className="px-5 pt-4 pb-8 w-full max-w-5xl mx-auto">
      <div className="mb-5">
        <button onClick={onBack} className="flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-3">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
          Back
        </button>
        <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Loan</div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">{loan.lenderName || "Unknown Lender"}</h1>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {prop && (
            <button onClick={() => navigate({type:'property', id:prop.id})} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">{prop.address}</button>
          )}
          {!prop && <span className="text-sm text-slate-400 dark:text-zinc-500">Unassigned</span>}
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${loan.endDate ? "bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400" : "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"}`}>
            {loan.endDate ? `Closed ${loan.endDate}` : "Active"}
          </span>
          <TypeBadge type={loan.loanType} sm/>
        </div>
      </div>

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
      )}
    </div>
  );
}

function EntityDetailView({ entity, data, update, onBack, navigate }) {
  if (entity.type === 'property') return <PropertyDetailPage propId={entity.id} data={data} update={update} onBack={onBack} navigate={navigate}/>;
  if (entity.type === 'lender') return <LenderDetailPage name={entity.name} data={data} onBack={onBack} navigate={navigate}/>;
  if (entity.type === 'loan') return <LoanDetailPage loanId={entity.loanId} propId={entity.propId} data={data} onBack={onBack} navigate={navigate}/>;
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
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [globalSearch,setGlobalSearch]=useState('');
  const [detailPage,setDetailPage]=useState(null);
  const [rehabHover,setRehabHover]=useState(false);
  const fabRef=useRef(null);
  const settingsRef=useRef(null);
  const globalSearchRef=useRef(null);

  useEffect(()=>{
    const handler=e=>{
      if(fabRef.current&&!fabRef.current.contains(e.target))setFabOpen(false);
      if(settingsRef.current&&!settingsRef.current.contains(e.target))setSettingsOpen(false);
      if(globalSearchRef.current&&!globalSearchRef.current.contains(e.target))setGlobalSearch('');
    };
    document.addEventListener('mousedown',handler);
    return ()=>document.removeEventListener('mousedown',handler);
  },[]);

  useEffect(()=>{
    load().then(d=>{
      const migrateLoans = loans => loans.map(l=>
        (!l.paymentType && l.loanType==="hard") ? {...l,paymentType:"monthly_rate"} : l
      );
      const needsPropMig = d.properties.some(p=>(!p.purchasePrice&&!p.rehabBudget)&&p.fundingNeeded>0);
      const needsLoanMig = d.properties.some(p=>p.loans.some(l=>!l.paymentType&&l.loanType==="hard"))
        || d.unassigned.some(l=>!l.paymentType&&l.loanType==="hard");
      if (needsPropMig||needsLoanMig) {
        const migrated={...d,
          properties:d.properties.map(p=>({
            ...p,
            ...(needsPropMig&&!p.purchasePrice&&!p.rehabBudget&&p.fundingNeeded>0
              ? {purchasePrice:p.fundingNeeded,rehabBudget:0,monthlyHolding:p.monthlyHolding??500}
              : {}),
            loans:migrateLoans(p.loans),
          })),
          unassigned:migrateLoans(d.unassigned),
        };
        save(migrated);
        setData(migrated);
      } else {
        setData(d);
      }
      setLoading(false);
    })
    const channel=subscribeToChanges(newData=>setData(newData))
    return()=>channel.unsubscribe()
  },[])

  const update = fn => {
    setData(prev=>{
      const next=typeof fn==="function"?fn(prev):fn
      save(next)
      return next
    })
  }
  const navigate = entity => setDetailPage(entity);

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
  const closedCount=data.properties.filter(p=>p.dateSold).length;

  const globalResults=(()=>{
    if(globalSearch.length<2)return[];
    const q=globalSearch.toLowerCase();
    const results=[];
    const seenLenders=new Set();
    data.properties.filter(p=>!p.dateSold).forEach(p=>{
      if(p.address?.toLowerCase().includes(q))
        results.push({tab:"Properties",section:"Properties",label:p.address||"",sub:`${p.loans.filter(l=>!l.endDate).length} loans`});
      p.loans.forEach(l=>{
        if(l.lenderName?.toLowerCase().includes(q)&&!seenLenders.has(l.lenderName)){seenLenders.add(l.lenderName);results.push({tab:"LenderDash",section:"Lenders",label:l.lenderName,sub:p.address});}
      });
    });
    data.properties.filter(p=>p.dateSold).forEach(p=>{
      if(p.address?.toLowerCase().includes(q))results.push({tab:"Closed",section:"Closed",label:p.address||"",sub:`Sold ${p.dateSold}`});
    });
    data.unassigned.forEach(l=>{
      if(l.lenderName?.toLowerCase().includes(q)&&!seenLenders.has(l.lenderName)){seenLenders.add(l.lenderName);results.push({tab:"LenderDash",section:"Lenders",label:l.lenderName});}
    });
    return results.slice(0,8);
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

  // ── Sidebar nav button ──
  const SideBtn=({icon,label,active,onClick,children})=>(
    <button onClick={onClick}
      className={`flex items-center gap-3 w-full px-3 py-2 rounded-xl transition-all text-left ${active?"bg-blue-600 shadow-sm":"hover:bg-black/5 dark:hover:bg-white/10"}`}>
      <span className={`shrink-0 ${active?"text-white":"text-slate-400 dark:text-zinc-500"}`}>{icon}</span>
      <span className={`text-[13px] font-medium truncate ${active?"text-white":"text-slate-600 dark:text-zinc-300"}`}>{label}</span>
      {children}
    </button>
  );

  return (
    <PrivacyContext.Provider value={privacyMode}>
    <PanelContext.Provider value={navigate}>
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-black flex transition-colors duration-300">

      {/* ── Left Sidebar ── */}
      <div className="fixed left-0 top-0 bottom-0 w-44 bg-[#F2F2F7] dark:bg-black border-r border-black/[0.05] dark:border-white/[0.04] flex flex-col z-40">
        {/* Logo / Home */}
        <button onClick={onHome} title="Home"
          className="ml-4 mt-3.5 mb-2.5 w-9 h-9 rounded-[11px] bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-md shadow-blue-500/30 active:scale-95 transition-transform shrink-0">
          <span className="text-white font-black text-sm">N</span>
        </button>
        <div className="h-px bg-black/[0.06] dark:bg-white/[0.06] mx-3 mb-1.5"/>

        {/* Nav items */}
        <nav className="flex flex-col gap-0.5 px-2 flex-1">
          <SideBtn icon={<IcoHome/>} label="Properties" active={tab==="Properties"&&!detailPage} onClick={()=>{setDetailPage(null);setTab("Properties");}}/>
          <SideBtn icon={<IcoUsers/>} label="Lenders" active={tab==="LenderDash"&&!detailPage} onClick={()=>{setDetailPage(null);setTab("LenderDash");}}/>
          <SideBtn icon={<IcoList/>} label="Loans" active={tab==="AllLoans"&&!detailPage} onClick={()=>{setDetailPage(null);setTab("AllLoans");}}/>

          {/* Renovation group — clicking parent does nothing, hover reveals submenu */}
          <div className="relative" onMouseEnter={()=>setRehabHover(true)} onMouseLeave={()=>setRehabHover(false)}>
            <SideBtn icon={<IcoHardHat/>} label="Renovation" active={["RehabPriority","Draws","PropDash"].includes(tab)&&!detailPage} onClick={()=>{}}/>
            {rehabHover&&(
              <div className="absolute left-full top-0 ml-2 bg-white dark:bg-zinc-800 rounded-xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden w-44 z-50 py-1">
                {[{id:"RehabPriority",ico:<IcoClipboard/>,l:"Rehab Priority"},{id:"Draws",ico:<IcoGrid/>,l:"Draw Tracker"},{id:"PropDash",ico:<IcoBar/>,l:"Dashboard"}].map(({id,ico,l})=>(
                  <button key={id} onClick={()=>{setDetailPage(null);setTab(id);setRehabHover(false);}}
                    className={`w-full text-left flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium transition-colors ${tab===id&&!detailPage?"bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700"}`}>
                    <span className="text-slate-400 dark:text-zinc-500 shrink-0">{ico}</span>{l}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Records = Closed + History */}
          <SideBtn icon={<IcoDocument/>} label="Records" active={["Closed","History"].includes(tab)&&!detailPage} onClick={()=>{setDetailPage(null);setTab(["Closed","History"].includes(tab)?tab:"Closed");}}/>
        </nav>

        {/* Bottom — Settings */}
        <div className="px-2 pb-3 relative" ref={settingsRef}>
          <button onClick={()=>setSettingsOpen(o=>!o)}
            className={`flex items-center gap-3 w-full px-3 py-2 rounded-xl transition-all text-left ${settingsOpen?"bg-blue-600":"hover:bg-black/5 dark:hover:bg-white/10"}`}>
            <span className={`shrink-0 ${settingsOpen?"text-white":"text-slate-400 dark:text-zinc-500"}`}><IcoCog/></span>
            <span className={`text-[13px] font-medium ${settingsOpen?"text-white":"text-slate-600 dark:text-zinc-300"}`}>Settings</span>
          </button>
          {settingsOpen&&(
            <div className="absolute bottom-full left-2 mb-2 w-44 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-50">
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

      {/* ── Main content ── */}
      <div className="ml-44 flex-1 flex flex-col min-h-screen">
        {/* Top bar */}
        <div className="sticky top-0 z-30 bg-white/90 dark:bg-[#1C1C1E]/90 backdrop-blur-2xl border-b border-black/[0.08] dark:border-white/[0.07]">
          <div className="px-5 py-2.5 flex items-center gap-2.5 w-full">
            {/* Global search */}
            <div ref={globalSearchRef} className="relative flex-1">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-500 text-sm pointer-events-none">🔍</span>
                <input type="text" value={globalSearch} onChange={e=>setGlobalSearch(e.target.value)}
                  placeholder="Search properties, lenders…"
                  className="w-full pl-8 pr-3 py-2 rounded-xl text-sm bg-slate-100 dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 border-0"/>
              </div>
              {globalSearch.length>1&&(
                <div className="absolute top-full left-0 right-0 mt-1.5 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-50">
                  {globalResults.length===0
                    ?<div className="px-4 py-3 text-sm text-slate-400 dark:text-zinc-500">No results</div>
                    :globalResults.map((r,i)=>(
                      <button key={i} onClick={()=>{setTab(r.tab);setGlobalSearch('');}}
                        className="w-full text-left flex items-start gap-2.5 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors border-b border-slate-50 dark:border-zinc-700/40 last:border-0">
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-zinc-700 text-slate-500 dark:text-zinc-400 shrink-0 mt-0.5">{r.section}</span>
                        <div className="min-w-0">
                          <div className="text-sm text-slate-800 dark:text-zinc-200 font-medium truncate">{r.label}</div>
                          {r.sub&&<div className="text-xs text-slate-400 dark:text-zinc-500">{r.sub}</div>}
                        </div>
                      </button>
                    ))
                  }
                </div>
              )}
            </div>

            {/* Actions button */}
            <div ref={fabRef} className="relative shrink-0">
              <button onClick={()=>setFabOpen(o=>!o)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold transition-all shadow-sm shadow-blue-500/20 ${fabOpen?"bg-blue-700 text-white":"bg-blue-600 hover:bg-blue-700 text-white"}`}>
                <span className={`text-base font-light leading-none transition-transform duration-150 inline-block ${fabOpen?"rotate-45":""}`}>+</span>
                <span>Actions</span>
              </button>
              {fabOpen&&(
                <div className="absolute right-0 top-10 w-48 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-50 py-1">
                  {[
                    {label:"Add Property",modal:"addProp"},
                    {label:"Add Lender Money",modal:{type:"addMoney"}},
                    {label:"Close Property",modal:{type:"closePropPicker"}},
                    {label:"Close Lender Loans",modal:"closeLender"},
                    {label:"Record Draw",modal:{type:"quickDraw"}},
                  ].map(item=>(
                    <button key={typeof item.modal==="string"?item.modal:item.modal.type}
                      onClick={()=>{setFabOpen(false);setTab("Properties");setFabPending(item.modal);}}
                      className="w-full text-left px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors">
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Page content */}
        {detailPage ? (
          <EntityDetailView entity={detailPage} data={data} update={update} onBack={()=>setDetailPage(null)} navigate={navigate}/>
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
            {tab==="Properties"    &&<PropertiesPage data={data} update={update} pendingAction={fabPending} onClearPendingAction={()=>setFabPending(null)}/>}
            {tab==="LenderDash"   &&<LenderDashboard data={data}/>}
            {tab==="AllLoans"     &&<AllLoansPage data={data}/>}
            {tab==="PropDash"     &&<PropertyDashboard data={data}/>}
            {tab==="RehabPriority"&&<RehabPriorityPage data={data} update={update}/>}
            {tab==="Closed"       &&<ClosedDealsPage data={data} update={update}/>}
            {tab==="History"      &&<HistoryPage data={data}/>}
            {tab==="Draws"        &&<DrawsPage data={data}/>}
            {tab==="LenderAccts"  &&<ManageLendersPage data={data}/>}
          </div>
        )}
      </div>
    </div>
    </PanelContext.Provider>
    </PrivacyContext.Provider>
  );
}
