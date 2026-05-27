import { useState, useEffect, useRef } from "react";
import { loadData, saveData, subscribeToChanges } from './supabase'

const load = loadData
const save = saveData

const TODAY = new Date().toISOString().split("T")[0];
const uid   = () => Math.random().toString(36).slice(2, 9);
const $$    = n  => "$" + Math.round(Math.abs(n ?? 0)).toLocaleString();
const $$s   = n  => { if (n==null) return "—"; const a=Math.round(Math.abs(n)).toLocaleString(); return n>=0?`+$${a}`:`-$${a}`; };
const $$c   = n  => { const a=Math.round(Math.abs(n??0)); if(a>=1e6){const m=a/1e6;return "$"+(m>=10?m.toFixed(1):m.toFixed(2)).replace(/\.?0+$/,"")+"M";} if(a>=1e3)return "$"+Math.round(a/1e3)+"K"; return "$"+a; };
const pct   = (a,b) => b>0 ? Math.min(100, Math.round(a/b*100)) : 0;

const daysBetween = (d1, d2) => {
  if (!d1||!d2) return 0;
  return Math.max(0, Math.floor((new Date(d2)-new Date(d1))/864e5));
};

const calcBalance = (l, asOf=TODAY) => {
  if (!l?.startDate||!l?.principal) return l?.principal??0;
  if (l.interestType === "fixed") return l.principal + (l.interestRate || 0);
  const end = l.endDate && l.endDate<=asOf ? l.endDate : asOf;
  if (l.startDate>end) return l.principal;
  return l.principal + l.principal*(l.interestRate||0)/100*(daysBetween(l.startDate,end)/365);
};

const fmtRate = (l) => {
  if (!l) return "";
  if (l.interestType === "fixed") return "$" + Math.round(l.interestRate||0).toLocaleString() + " fixed";
  return (l.interestRate||0) + "%/yr";
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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="flex justify-between items-center px-6 py-4 border-b border-slate-100 dark:border-zinc-800 sticky top-0 bg-white dark:bg-zinc-900 rounded-t-2xl z-10">
          <h2 className="font-bold text-slate-900 dark:text-zinc-100 text-base">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all text-xl leading-none">&times;</button>
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
    red:   "bg-red-500 hover:bg-red-600 text-white",
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
              className="w-full text-left px-4 py-3 text-sm text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors border-b border-slate-50 dark:border-zinc-800 last:border-0 flex items-center gap-2">
              <span className="text-slate-300 dark:text-zinc-600 text-xs">👤</span>{name}
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
  const [f, sf] = useState(init ?? {
    lenderName:"", loanType:"private", principal:"",
    startDate:TODAY, interestType:"percentage", interestRate:"", specialTerms:"", endDate:"",
    destination:"unassigned", promissoryNote:false,
  });
  const s = k => v => sf(p=>({...p,[k]:v}));
  const destOptions = [
    ["unassigned","💼  Unassigned — not yet placed on a property"],
    ...activeProps.map(p=>[p.id, `🏠  ${p.address}`]),
  ];
  const isFixed = (f.interestType || "percentage") === "fixed";
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
        <Inp label="Special Terms (optional)" value={f.specialTerms} onChange={s("specialTerms")} placeholder="Monthly interest, balloon, etc."/>
      </div>
      <div className="mt-1 mb-4 p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800">
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={f.promissoryNote||false} onChange={e=>s("promissoryNote")(e.target.checked)}
            className="w-4 h-4 rounded border-slate-300 dark:border-zinc-600 accent-emerald-600 cursor-pointer"/>
          <div>
            <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Promissory note on file</div>
            <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">Check once you have a signed note for this loan</div>
          </div>
        </label>
        {!f.promissoryNote && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold mt-2.5 flex items-center gap-1.5">
            ⚠ No note recorded — get one before funds transfer
          </p>
        )}
      </div>
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
function PlaceOnPropertyModal({ fund, properties, onPlace, onClose }) {
  const activeProps = properties.filter(p=>!p.dateSold);
  const [dest, setDest] = useState(activeProps[0]?.id ?? "");
  if (!activeProps.length) return (
    <Modal title="Place on Property" onClose={onClose}>
      <p className="text-sm text-slate-500 dark:text-zinc-400 mb-4">No active properties. Add one first.</p>
      <Btn onClick={onClose} color="ghost" full>Close</Btn>
    </Modal>
  );
  return (
    <Modal title={`Place ${fund.lenderName}'s Money`} onClose={onClose}>
      <div className="mb-4 p-4 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-100 dark:border-zinc-700">
        <div className="font-bold text-slate-900 dark:text-zinc-100">{fund.lenderName}</div>
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$(fund.principal)} · {fmtRate(fund)} · <TypeBadge type={fund.loanType} sm/></div>
      </div>
      <Sel label="Place on which property?" value={dest} onChange={setDest} options={activeProps.map(p=>[p.id,p.address])}/>
      <div className="flex gap-2 pt-1">
        <Btn onClick={()=>onPlace(dest)} color="green" full>Place on Property →</Btn>
        <Btn onClick={onClose} color="ghost">Cancel</Btn>
      </div>
    </Modal>
  );
}

// ─── Move Modal ───────────────────────────────────────────────────────────────
function MoveModal({ item, properties, onMove, onClose }) {
  const activeProps = properties.filter(p=>!p.dateSold);
  const lenderName = item.type==="loan" ? item.loan.lenderName : item.fund.lenderName;
  const amount = item.type==="loan" ? item.loan.principal : item.fund.principal;
  const currentLoc = item.type==="loan" ? (properties.find(p=>p.id===item.propId)?.address||"a property") : "Unassigned";
  const destOptions = [
    ...activeProps.filter(p=>item.type!=="loan"||p.id!==item.propId).map(p=>[p.id,`🏠  ${p.address}`]),
    ...(item.type==="loan"?[["unassigned","💼  Unassigned"]]:[]),
  ];
  const [dest,setDest]=useState(destOptions[0]?.[0]??"");
  if(!destOptions.length) return (
    <Modal title="Move Money" onClose={onClose}>
      <p className="text-sm text-slate-500 dark:text-zinc-400 mb-4">No other properties to move to.</p>
      <Btn onClick={onClose} color="ghost" full>Close</Btn>
    </Modal>
  );
  return (
    <Modal title="Move Lender Money" onClose={onClose}>
      <div className="mb-4 p-4 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-100 dark:border-zinc-700">
        <div className="font-bold text-slate-900 dark:text-zinc-100">{lenderName}</div>
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$(amount)} · on <span className="font-medium">{currentLoc}</span></div>
      </div>
      <Sel label="Move to" value={dest} onChange={setDest} options={destOptions}/>
      <div className="flex gap-2 pt-1">
        <Btn onClick={()=>onMove(dest)} color="blue" full>Move →</Btn>
        <Btn onClick={onClose} color="ghost">Cancel</Btn>
      </div>
    </Modal>
  );
}

// ─── Loan Disposition Row ─────────────────────────────────────────────────────
function LoanDispositionRow({ loan, soldDate, allProperties, currentPropId, disposition, onChange }) {
  const payoff   = calcBalance(loan, soldDate);
  const interest = payoff - (loan.principal || 0);
  const isFixed  = loan.interestType === "fixed";
  const otherProps = allProperties.filter(p => !p.dateSold && p.id !== currentPropId);
  const destOptions = [
    ["unassigned","💼  Unassigned — hold for next deal"],
    ...otherProps.map(p => [p.id, `🏠  ${p.address}`]),
  ];
  const typeOptions = [
    ["paidOut",      `💰  Paid Out — ${$$(payoff)} leaves Nexus`],
    ["rollFull",     `🔄  Roll Full ${$$(payoff)} — keep everything in`],
    ...(interest > 0.01 ? [["rollPrincipal",`🔄  Roll Principal ${$$(loan.principal)} — pocket ${$$(interest)} interest`]] : []),
    ["custom",       "✏️  Custom Amount"],
  ];
  const rolling = disposition.type !== "paidOut";

  return (
    <div className="border border-slate-200 dark:border-zinc-700 rounded-xl p-4 mb-3 bg-white dark:bg-zinc-900">
      <div className="flex items-center gap-2 mb-3">
        <span className="font-bold text-slate-900 dark:text-zinc-100">{loan.lenderName}</span>
        <TypeBadge type={loan.loanType} sm/>
      </div>
      <div className="grid grid-cols-3 gap-1 text-center bg-slate-50 dark:bg-zinc-800 rounded-lg p-3 mb-3">
        <div>
          <div className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest font-semibold mb-1">Principal</div>
          <div className="font-bold text-slate-800 dark:text-zinc-100 tabular-nums">{$$(loan.principal)}</div>
        </div>
        <div>
          <div className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest font-semibold mb-1">Interest</div>
          <div className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">+{$$(interest)}</div>
        </div>
        <div>
          <div className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest font-semibold mb-1">Payoff</div>
          <div className="font-bold text-blue-700 dark:text-blue-400 tabular-nums">{$$(payoff)}</div>
        </div>
      </div>
      <Sel label="What happens to this money?" value={disposition.type}
        onChange={v => onChange({ ...disposition, type: v, destination: destOptions[0]?.[0] ?? "unassigned" })}
        options={typeOptions}/>
      {disposition.type === "custom" && (
        <Inp label="Amount Rolling Over ($)" type="number" value={disposition.customAmount}
          onChange={v => onChange({ ...disposition, customAmount: v })} placeholder={String(Math.round(loan.principal))}/>
      )}
      {rolling && (
        <>
          {destOptions.length > 0
            ? <Sel label="Where does it go?" value={disposition.destination} onChange={v => onChange({ ...disposition, destination: v })} options={destOptions}/>
            : <p className="text-xs text-amber-600 dark:text-amber-400 mb-3 font-medium">No other active properties — will save as Unassigned.</p>
          }
          <DateInp label="New Loan Start Date" value={disposition.newStartDate}
            onChange={v => onChange({ ...disposition, newStartDate: v })} helpText="Defaults to sale date"/>
          <Inp label={isFixed ? "New Fixed Interest Amount ($) — blank to keep same" : "New Interest Rate (%) — blank to keep same"}
            type="number" value={disposition.newRate} onChange={v => onChange({ ...disposition, newRate: v })}
            placeholder={String(loan.interestRate || 0)}/>
        </>
      )}
    </div>
  );
}

// ─── Mark Property Sold Modal ─────────────────────────────────────────────────
function MarkSoldModal({ prop, allProperties, onConfirm, onClose }) {
  const [step,setStep]=useState(1);
  const [soldDate,setSoldDate]=useState(TODAY);
  const activeLoans = prop.loans.filter(l => !l.endDate);
  const makeDispositions = date => {
    const d = {};
    activeLoans.forEach(l => { d[l.id]={type:"rollPrincipal",destination:"unassigned",customAmount:"",newStartDate:date,newRate:String(l.interestRate??"")}; });
    return d;
  };
  const [dispositions,setDispositions]=useState(()=>makeDispositions(TODAY));
  const handleDateChange = date => {
    setSoldDate(date);
    setDispositions(prev=>{ const next={...prev}; Object.keys(next).forEach(id=>{next[id]={...next[id],newStartDate:date};}); return next; });
  };
  const totalPayoff = activeLoans.reduce((s,l)=>s+calcBalance(l,soldDate),0);

  return (
    <Modal title={`Sell: ${prop.address}`} onClose={onClose}>
      {step===1 && (
        <div>
          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 mb-4 text-sm text-amber-800 dark:text-amber-300">
            <strong>Every loan ends when a property sells.</strong> On the next screen you'll decide what happens to each lender's money.
          </div>
          <DateInp label="Date Sold" value={soldDate} onChange={handleDateChange}/>
          {activeLoans.length > 0 && (
            <div className="bg-slate-50 dark:bg-zinc-800 rounded-xl p-4 mb-4 text-sm text-slate-600 dark:text-zinc-300">
              <strong>{activeLoans.length} active loan{activeLoans.length!==1?"s":""}</strong> · Total payoff: <strong className="text-blue-700 dark:text-blue-400 tabular-nums">{$$(totalPayoff)}</strong>
            </div>
          )}
          {activeLoans.length===0 && <p className="text-sm text-slate-500 dark:text-zinc-400 mb-4">No active loans — property will just be archived.</p>}
          <div className="flex gap-2">
            <Btn onClick={()=>activeLoans.length>0?setStep(2):onConfirm(soldDate,{})} color="navy" full>
              {activeLoans.length>0?`Settle ${activeLoans.length} Loan${activeLoans.length!==1?"s":""} →`:"Confirm Sale"}
            </Btn>
            <Btn onClick={onClose} color="ghost">Cancel</Btn>
          </div>
        </div>
      )}
      {step===2 && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <button onClick={()=>setStep(1)} className="text-slate-400 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-200 text-sm font-medium transition-colors">← Back</button>
            <span className="text-sm text-slate-500 dark:text-zinc-400">Sold {soldDate} · Settle each lender</span>
          </div>
          <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
            {activeLoans.map(loan=>(
              <LoanDispositionRow key={loan.id} loan={loan} soldDate={soldDate} allProperties={allProperties}
                currentPropId={prop.id} disposition={dispositions[loan.id]}
                onChange={d=>setDispositions(prev=>({...prev,[loan.id]:d}))}/>
            ))}
          </div>
          <div className="flex gap-2 mt-4 pt-4 border-t border-slate-100 dark:border-zinc-800">
            <Btn onClick={()=>onConfirm(soldDate,dispositions)} color="navy" full>✓ Confirm Sale &amp; Settle All</Btn>
            <Btn onClick={onClose} color="ghost">Cancel</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Property Form ────────────────────────────────────────────────────────────
function PropertyForm({ init, onSave, onClose }) {
  const [f,sf]=useState(init??{address:"",fundingNeeded:""});
  const s=k=>v=>sf(p=>({...p,[k]:v}));
  return (
    <div>
      <Inp label="Property Address" value={f.address} onChange={s("address")} placeholder="123 Oak Ave, Nashville, TN"/>
      <Inp label="Estimated Funding Needed ($)" type="number" value={f.fundingNeeded} onChange={s("fundingNeeded")} placeholder="175000"/>
      <div className="flex gap-2 pt-2">
        <Btn onClick={()=>onSave(f)} full>Save Property</Btn>
        <Btn onClick={onClose} color="ghost">Cancel</Btn>
      </div>
    </div>
  );
}

// ─── Collapsible Unassigned Funds ─────────────────────────────────────────────
function CollapsibleUnassigned({ funds, total, onPlace, onMove, onEdit, onDelete }) {
  const [open,setOpen]=useState(false);
  const sorted=[...funds].sort((a,b)=>(a.startDate||"").localeCompare(b.startDate||""));

  return (
    <div className="mb-3 rounded-2xl border-2 border-violet-200 dark:border-violet-800 overflow-hidden">
      <button onClick={()=>setOpen(o=>!o)}
        className="w-full bg-violet-50 dark:bg-violet-950 hover:bg-violet-100 dark:hover:bg-violet-900/80 px-5 py-3.5 flex items-center justify-between transition-colors">
        <div className="flex items-center gap-3">
          <span className="text-sm">💼</span>
          <span className="text-sm font-bold text-violet-900 dark:text-violet-200">Ready to Place</span>
          <span className="text-xl font-bold text-violet-700 dark:text-violet-300 tabular-nums">{$$(total)}</span>
          <span className="text-xs text-violet-400 dark:text-violet-500">{funds.length} lender{funds.length!==1?"s":""}</span>
        </div>
        <span className="text-violet-400 dark:text-violet-500 text-xs font-semibold">{open?"▲ Hide":"▼ Show"}</span>
      </button>
      {open && (
        <div className="bg-white dark:bg-zinc-900 divide-y divide-slate-100 dark:divide-zinc-800">
          {sorted.map(u=>{
            const principal=u.principal||u.amount||0;
            const bal=calcBalance({...u,principal});
            const earned=bal-principal;
            const days=daysBetween(u.startDate,TODAY);
            return (
              <div key={u.id} className="px-5 py-3 flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-900 dark:text-zinc-100 text-sm">{u.lenderName}</span>
                  <TypeBadge type={u.loanType} sm/>
                  <span className="font-bold text-violet-700 dark:text-violet-300 text-sm tabular-nums">{$$(principal)}</span>
                  {(u.interestRate!=null)&&<span className="text-xs text-slate-400 dark:text-zinc-500">{fmtRate(u)}</span>}
                  {earned>0.01&&<span className="text-xs text-emerald-600 dark:text-emerald-400 tabular-nums">+{$$(earned)}</span>}
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${days>60?"bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800":days>30?"bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800":"bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border-slate-200 dark:border-zinc-700"}`}>
                    {days}d
                  </span>
                  {u.promissoryNote ? <Chip color="green">📄 Note ✓</Chip> : <Chip color="amber">⚠ No Note</Chip>}
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={()=>onPlace(u)} className="text-[11px] font-bold text-white bg-violet-600 hover:bg-violet-700 rounded-lg px-2.5 py-1 transition-colors">Place →</button>
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
function PropertiesPage({ data, update }) {
  const [modal,setModal]=useState(null);
  const [expanded,setExpanded]=useState({});
  const [showSold,setShowSold]=useState(false);
  const [viewMode,setViewMode]=useState("expanded");
  const [propSort,setPropSort]=useState({col:null,dir:"asc"});
  const toggle = id => setExpanded(e=>({...e,[id]:!e[id]}));
  const togglePropSort = col => setPropSort(s=>({col,dir:s.col===col&&s.dir==="asc"?"desc":"asc"}));
  const unassignedTotal = data.unassigned.reduce((s,u)=>s+(u.principal||u.amount||0),0);

  const saveMoneyForm = f => {
    const amount=parseFloat(f.principal)||0;
    const base={lenderName:f.lenderName,loanType:f.loanType,principal:amount,startDate:f.startDate,interestRate:parseFloat(f.interestRate)||0,interestType:f.interestType||"percentage",promissoryNote:f.promissoryNote||false,specialTerms:f.specialTerms||"",endDate:f.endDate||null};
    if(f.destination==="unassigned"){
      update(d=>({...d,unassigned:[...d.unassigned,{id:uid(),...base}]}));
    } else {
      update(d=>({...d,properties:d.properties.map(p=>p.id!==f.destination?p:{...p,loans:[...p.loans,{id:uid(),...base}]})}));
    }
    setModal(null);
  };

  const saveProp = (f,existing) => {
    const p={...(existing??{id:uid(),loans:[]}),address:f.address,fundingNeeded:parseFloat(f.fundingNeeded)||0,dateSold:existing?.dateSold??null};
    update(d=>({...d,properties:existing?d.properties.map(x=>x.id===p.id?p:x):[...d.properties,p]}));
    setModal(null);
  };

  const saveEditedLoan = (propId,f,existing) => {
    const l={...existing,lenderName:f.lenderName,loanType:f.loanType,principal:parseFloat(f.principal)||0,startDate:f.startDate,interestRate:parseFloat(f.interestRate)||0,interestType:f.interestType||"percentage",promissoryNote:f.promissoryNote||false,specialTerms:f.specialTerms||"",endDate:f.endDate||null};
    update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,loans:p.loans.map(x=>x.id===l.id?l:x)})}));
    setModal(null);
  };

  const placeOnProperty = (fund,propId) => {
    const loan={id:uid(),lenderName:fund.lenderName,loanType:fund.loanType,principal:fund.principal||fund.amount||0,startDate:fund.startDate||fund.date||TODAY,interestRate:fund.interestRate||0,interestType:fund.interestType||"percentage",promissoryNote:fund.promissoryNote||false,specialTerms:fund.specialTerms||fund.notes||"",endDate:fund.endDate||null};
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

  const handleMarkSold = (prop,soldDate,dispositions) => {
    const activeLoans=prop.loans.filter(l=>!l.endDate);
    const newUnassigned=[]; const newLoansForProps={};
    activeLoans.forEach(loan=>{
      const d=dispositions[loan.id]; if(!d||d.type==="paidOut")return;
      const payoff=calcBalance(loan,soldDate);
      let np; if(d.type==="rollFull")np=payoff; else if(d.type==="rollPrincipal")np=loan.principal; else if(d.type==="custom")np=parseFloat(d.customAmount)||loan.principal; else return;
      const entry={id:uid(),lenderName:loan.lenderName,loanType:loan.loanType,principal:np,startDate:d.newStartDate||soldDate,interestRate:d.newRate!==""?parseFloat(d.newRate):(loan.interestRate||0),interestType:loan.interestType||"percentage",promissoryNote:false,specialTerms:loan.specialTerms||"",endDate:null};
      if(d.destination==="unassigned"){newUnassigned.push(entry);}else{if(!newLoansForProps[d.destination])newLoansForProps[d.destination]=[];newLoansForProps[d.destination].push(entry);}
    });
    update(d=>({...d,properties:d.properties.map(p=>{if(p.id===prop.id)return{...p,dateSold:soldDate,loans:p.loans.map(l=>l.endDate?l:{...l,endDate:soldDate})};if(newLoansForProps[p.id])return{...p,loans:[...p.loans,...newLoansForProps[p.id]]};return p;}),unassigned:[...d.unassigned,...newUnassigned]}));
    setModal(null);
  };

  const visible=data.properties.filter(p=>showSold||!p.dateSold);
  const activeCount=data.properties.filter(p=>!p.dateSold).length;
  const totalCount=data.properties.length;

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Properties</h2>
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
          <Btn onClick={()=>setModal("addProp")} color="ghost" sm>+ Property</Btn>
        </div>
      </div>

      {data.unassigned.length>0&&(
        <CollapsibleUnassigned funds={data.unassigned} total={unassignedTotal}
          onPlace={u=>setModal({type:"place",fund:u})} onMove={u=>setModal({type:"moveUnassigned",fund:u})}
          onEdit={u=>setModal({type:"editUnassigned",fund:u})} onDelete={delUnassigned}/>
      )}

      <button onClick={()=>setModal("addMoney")}
        className="w-full mb-5 py-4 rounded-2xl border-2 border-dashed border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:border-blue-300 dark:hover:border-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-all flex items-center justify-center gap-3 group">
        <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center text-lg font-bold group-hover:scale-105 transition-transform shadow-sm">+</div>
        <div className="text-left">
          <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200 group-hover:text-blue-700 dark:group-hover:text-blue-400 transition-colors">Add Lender Money</div>
          <div className="text-xs text-slate-400 dark:text-zinc-500">Place on a property or hold as unassigned</div>
        </div>
      </button>

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
          const funded=active.reduce((s,l)=>s+(l.principal||0),0);
          const needed=prop.fundingNeeded||0;
          const short=Math.max(0,needed-funded);
          return{prop,active,funded,needed,short,under:!prop.dateSold&&short>0,full:!prop.dateSold&&funded>0&&short===0};
        });
        const sorted=[...rows].sort((a,b)=>{
          if(!propSort.col)return 0;
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
          <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-zinc-800 text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-wider text-[10px]">
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
                              : <span className="opacity-25 ml-0.5">↕</span>
                            }
                          </span>
                        </th>
                      );
                    })}
                    <th className="py-2.5 px-2"></th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-zinc-900 divide-y divide-slate-50 dark:divide-zinc-800">
                  {sorted.map(({prop,active,funded,needed,short,under,full},i)=>(
                    <tr key={prop.id} className={`hover:bg-slate-50 dark:hover:bg-zinc-800/60 transition-colors ${under?"bg-red-50/40 dark:bg-red-950/10":""}`}>
                      <td className="py-2.5 px-4 text-slate-300 dark:text-zinc-600 tabular-nums font-semibold">{i+1}</td>
                      <td className="py-2.5 px-4 font-semibold text-slate-800 dark:text-zinc-100 max-w-[160px] truncate">{prop.address||"Unnamed"}</td>
                      <td className="py-2.5 px-4 text-right text-slate-500 dark:text-zinc-400">{active.length}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-slate-700 dark:text-zinc-200 font-medium">{funded>0?$$(funded):"—"}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-slate-400 dark:text-zinc-500">{needed>0?$$(needed):"—"}</td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap">
                        {prop.dateSold&&<span className="text-slate-400 dark:text-zinc-500 font-semibold">Sold</span>}
                        {full&&<span className="text-emerald-600 dark:text-emerald-400 font-semibold">✓ Full</span>}
                        {under&&<span className="text-red-500 dark:text-red-400 font-bold tabular-nums">−{$$(short)}</span>}
                        {!prop.dateSold&&!full&&!under&&funded===0&&<span className="text-slate-300 dark:text-zinc-600">—</span>}
                      </td>
                      <td className="py-2.5 px-2 text-right">
                        <div className="flex gap-0.5 justify-end">
                          {!prop.dateSold&&<button onClick={()=>setModal({type:"markSold",prop})} className="p-1 text-slate-300 dark:text-zinc-600 hover:text-emerald-500 dark:hover:text-emerald-400 transition-colors text-[11px] font-bold" title="Mark Sold">$</button>}
                          <button onClick={()=>setModal({type:"editProp",prop})} className="p-1 text-slate-300 dark:text-zinc-600 hover:text-blue-500 dark:hover:text-blue-400 transition-colors">✏️</button>
                          <button onClick={()=>delProp(prop.id)} className="p-1 text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 transition-colors">🗑</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {viewMode==="expanded"&&<div className="space-y-3">
        {visible.map(prop=>{
          const active=prop.loans.filter(l=>!l.endDate);
          const funded=active.reduce((s,l)=>s+(l.principal||0),0);
          const needed=prop.fundingNeeded||0;
          const short=Math.max(0,needed-funded);
          const under=!prop.dateSold&&short>0;
          const full=!prop.dateSold&&funded>0&&short===0;
          const isOpen=!!expanded[prop.id];
          const allIdx=data.properties.findIndex(p=>p.id===prop.id);

          return (
            <div key={prop.id} className={`rounded-2xl overflow-hidden transition-all ${prop.dateSold?"border border-slate-200 dark:border-zinc-800 opacity-60":under?"border-l-4 border border-red-300 dark:border-red-700 border-l-red-500":"border border-slate-200 dark:border-zinc-800 shadow-sm hover:shadow-md dark:shadow-none transition-shadow"}`}>
              <div className={`cursor-pointer ${prop.dateSold?"bg-slate-50 dark:bg-zinc-800/30":under?"bg-red-50 dark:bg-red-950/20":"bg-white dark:bg-zinc-900"}`} onClick={()=>toggle(prop.id)}>
                <div className="px-5 pt-4 pb-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-[10px] font-bold text-slate-300 dark:text-zinc-600 tabular-nums">#{allIdx+1}</span>
                      <span className="font-semibold text-slate-900 dark:text-zinc-100 text-[15px]">{prop.address||"Unnamed Property"}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {prop.dateSold && <Chip color="gray">Sold {prop.dateSold}</Chip>}
                      {full   && <Chip color="green">✓ Fully Funded</Chip>}
                      {under  && <Chip color="red">⚠ Short {$$(short)}</Chip>}
                      {!prop.dateSold&&funded>0&&<span className="text-xs text-slate-400 dark:text-zinc-500 tabular-nums">{$$(funded)} placed</span>}
                    </div>
                    {needed>0&&!prop.dateSold&&(
                      <div className="mt-3">
                        <div className="h-1.5 bg-slate-100 dark:bg-zinc-700 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${full?"bg-emerald-500":pct(funded,needed)>=60?"bg-blue-500":"bg-red-400"}`} style={{width:`${pct(funded,needed)}%`}}/>
                        </div>
                        <div className="flex justify-between text-[10px] mt-1">
                          <span className={`font-semibold tabular-nums ${full?"text-emerald-600 dark:text-emerald-400":"text-slate-500 dark:text-zinc-400"}`}>{$$(funded)} / {$$(needed)}</span>
                          <span className={`font-semibold ${under?"text-red-500 dark:text-red-400":"text-slate-400 dark:text-zinc-500"}`}>{pct(funded,needed)}%</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0 items-center">
                    {!prop.dateSold&&(
                      <button onClick={e=>{e.stopPropagation();setModal({type:"markSold",prop});}}
                        className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 border border-emerald-200 dark:border-emerald-800 rounded-lg px-2.5 py-1 transition-colors whitespace-nowrap">
                        Mark Sold
                      </button>
                    )}
                    <button onClick={e=>{e.stopPropagation();setModal({type:"editProp",prop});}} className="p-1.5 text-slate-300 dark:text-zinc-600 hover:text-blue-500 dark:hover:text-blue-400 transition-colors">✏️</button>
                    <button onClick={e=>{e.stopPropagation();delProp(prop.id);}} className="p-1.5 text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 transition-colors">🗑</button>
                    <span className="p-1.5 text-slate-300 dark:text-zinc-600 text-xs">{isOpen?"▲":"▼"}</span>
                  </div>
                </div>
                {!isOpen&&active.length>0&&(
                  <div className="px-5 pb-3 flex flex-wrap gap-1.5">
                    {active.map(l=>(
                      <span key={l.id} className="text-[11px] bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 rounded-full px-2.5 py-1 font-medium tabular-nums">
                        {l.lenderName} · {$$(l.principal)}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {isOpen&&(
                <div className="border-t border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-800/30 px-5 py-4">
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-xs font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Loans · {prop.loans.length}</span>
                    <Btn onClick={()=>setModal("addMoney")} color="green" sm>+ Add Money</Btn>
                  </div>
                  {prop.loans.length===0&&<div className="text-center py-6 text-slate-400 dark:text-zinc-500 text-sm">No loans yet</div>}
                  <div className="space-y-2">
                    {prop.loans.map(loan=>{
                      const bal=calcBalance(loan); const earned=bal-(loan.principal||0);
                      return (
                        <div key={loan.id} className={`rounded-xl p-4 border text-sm ${loan.endDate?"bg-white/40 dark:bg-zinc-900/40 border-slate-100 dark:border-zinc-800":"bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-700"}`}>
                          <div className="flex justify-between items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-2">
                                <span className="font-bold text-slate-900 dark:text-zinc-100">{loan.lenderName}</span>
                                <TypeBadge type={loan.loanType} sm/>
                                {loan.endDate&&<Chip color="gray">Closed {loan.endDate}</Chip>}
                                {loan.promissoryNote ? <Chip color="green">📄 Note ✓</Chip> : <Chip color="red">⚠ No Note</Chip>}
                              </div>
                              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                                <span className="text-slate-500 dark:text-zinc-400">Principal <strong className="text-slate-800 dark:text-zinc-100 tabular-nums">{$$(loan.principal)}</strong></span>
                                <span className="text-slate-500 dark:text-zinc-400">Rate <strong className="text-slate-800 dark:text-zinc-100">{fmtRate(loan)}</strong></span>
                                <span className="text-slate-500 dark:text-zinc-400">Start <strong className="text-slate-800 dark:text-zinc-100">{loan.startDate}</strong></span>
                                <span className="text-slate-500 dark:text-zinc-400">Balance <strong className="text-blue-700 dark:text-blue-400 tabular-nums">{$$(bal)}</strong></span>
                                <span className="text-slate-500 dark:text-zinc-400">Interest <strong className="text-emerald-600 dark:text-emerald-400 tabular-nums">{$$(earned)}</strong></span>
                                {loan.specialTerms&&<span className="col-span-2 text-slate-400 dark:text-zinc-500 italic">{loan.specialTerms}</span>}
                              </div>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <button onClick={()=>setModal({type:"moveLoan",propId:prop.id,loan})} className="p-1.5 text-slate-300 dark:text-zinc-600 hover:text-violet-500 dark:hover:text-violet-400 transition-colors" title="Move">⇄</button>
                              <button onClick={()=>setModal({type:"editLoan",propId:prop.id,loan})} className="p-1.5 text-slate-300 dark:text-zinc-600 hover:text-blue-500 dark:hover:text-blue-400 transition-colors">✏️</button>
                              <button onClick={()=>delLoan(prop.id,loan.id)} className="p-1.5 text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 transition-colors">🗑</button>
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

      {modal==="addMoney"&&<Modal title="Add Lender Money" onClose={()=>setModal(null)}><LenderMoneyForm properties={data.properties} onSave={saveMoneyForm} onClose={()=>setModal(null)}/></Modal>}
      {modal==="addProp"&&<Modal title="Add Property" onClose={()=>setModal(null)}><PropertyForm onSave={f=>saveProp(f,null)} onClose={()=>setModal(null)}/></Modal>}
      {modal?.type==="editProp"&&<Modal title="Edit Property" onClose={()=>setModal(null)}><PropertyForm init={modal.prop} onSave={f=>saveProp(f,modal.prop)} onClose={()=>setModal(null)}/></Modal>}
      {modal?.type==="editLoan"&&<Modal title="Edit Loan" onClose={()=>setModal(null)}>
        <LenderMoneyForm properties={data.properties} init={{...modal.loan,destination:modal.propId,principal:String(modal.loan.principal),interestRate:String(modal.loan.interestRate||""),interestType:modal.loan.interestType||"percentage",promissoryNote:modal.loan.promissoryNote||false}}
          onSave={f=>saveEditedLoan(modal.propId,f,modal.loan)} onClose={()=>setModal(null)}/>
      </Modal>}
      {modal?.type==="editUnassigned"&&<Modal title="Edit Unassigned Fund" onClose={()=>setModal(null)}>
        <LenderMoneyForm properties={data.properties}
          init={{...modal.fund,destination:"unassigned",principal:String(modal.fund.principal||modal.fund.amount||""),interestRate:String(modal.fund.interestRate||""),interestType:modal.fund.interestType||"percentage",promissoryNote:modal.fund.promissoryNote||false}}
          onSave={f=>{
            const updated={...modal.fund,lenderName:f.lenderName,loanType:f.loanType,principal:parseFloat(f.principal)||0,startDate:f.startDate,interestRate:parseFloat(f.interestRate)||0,interestType:f.interestType||"percentage",promissoryNote:f.promissoryNote||false,specialTerms:f.specialTerms||"",endDate:f.endDate||null};
            if(f.destination!=="unassigned"){update(d=>({...d,unassigned:d.unassigned.filter(u=>u.id!==modal.fund.id),properties:d.properties.map(p=>p.id!==f.destination?p:{...p,loans:[...p.loans,{id:uid(),...updated}]})}));}
            else{update(d=>({...d,unassigned:d.unassigned.map(u=>u.id===modal.fund.id?updated:u)}));}
            setModal(null);
          }} onClose={()=>setModal(null)}/>
      </Modal>}
      {modal?.type==="place"&&<PlaceOnPropertyModal fund={modal.fund} properties={data.properties} onPlace={propId=>placeOnProperty(modal.fund,propId)} onClose={()=>setModal(null)}/>}
      {modal?.type==="markSold"&&<MarkSoldModal prop={modal.prop} allProperties={data.properties} onConfirm={(d,disp)=>handleMarkSold(modal.prop,d,disp)} onClose={()=>setModal(null)}/>}
      {modal?.type==="moveLoan"&&<MoveModal item={{type:"loan",propId:modal.propId,loan:modal.loan}} properties={data.properties} onMove={dest=>handleMove({type:"loan",propId:modal.propId,loan:modal.loan},dest)} onClose={()=>setModal(null)}/>}
      {modal?.type==="moveUnassigned"&&<MoveModal item={{type:"unassigned",fund:modal.fund}} properties={data.properties} onMove={dest=>{placeOnProperty(modal.fund,dest);setModal(null);}} onClose={()=>setModal(null)}/>}
    </div>
  );
}

// ─── Lender Dashboard ─────────────────────────────────────────────────────────
function LenderDashboard({ data }) {
  const [view,setView]=useState("loans");
  const [sort,setSort]=useState({col:null,dir:"asc"});
  const [lenderSort,setLenderSort]=useState("name");
  const toggleSort = col => setSort(s=>({col,dir:s.col===col&&s.dir==="asc"?"desc":"asc"}));
  const allActive=[
    ...data.properties.flatMap(prop=>
      prop.loans.filter(l=>!l.endDate).map(l=>({...l,propAddress:prop.address,bal:calcBalance(l),intEarned:calcBalance(l)-(l.principal||0)}))
    ),
    ...data.unassigned.map(u=>{const p=u.principal||u.amount||0;const b=calcBalance({...u,principal:p});return{...u,principal:p,propAddress:"Unassigned",bal:b,intEarned:b-p};}),
  ].sort((a,b)=>a.lenderName.localeCompare(b.lenderName));

  const byLender={};
  allActive.forEach(l=>{
    if(!byLender[l.lenderName])byLender[l.lenderName]={name:l.lenderName,loans:[],totalPrin:0,totalBal:0,totalInt:0,props:[],types:new Set()};
    const ld=byLender[l.lenderName];
    ld.loans.push(l);ld.totalPrin+=l.principal||0;ld.totalBal+=l.bal;ld.totalInt+=l.intEarned;
    if(!ld.props.includes(l.propAddress))ld.props.push(l.propAddress);
    ld.types.add(l.loanType);
  });
  const lenders=Object.values(byLender).map(ld=>({...ld,types:[...ld.types],avgRate:ld.loans.reduce((s,l)=>s+(l.interestRate||0),0)/ld.loans.length})).sort((a,b)=>a.name.localeCompare(b.name));
  const privPrin=allActive.filter(l=>l.loanType==="private").reduce((s,l)=>s+l.principal,0);
  const hardPrin=allActive.filter(l=>l.loanType==="hard").reduce((s,l)=>s+l.principal,0);
  const totalBal=allActive.reduce((s,l)=>s+l.bal,0);

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">Lender Dashboard</h2>
        <p className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">
          <span className="font-semibold text-slate-600 dark:text-zinc-300">{lenders.length} lender{lenders.length!==1?"s":""}</span>
          <span> · {allActive.length} loan{allActive.length!==1?"s":""}</span>
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          {label:"Private",     val:privPrin, num:"text-sky-600 dark:text-sky-400"},
          {label:"Hard Money",  val:hardPrin, num:"text-amber-600 dark:text-amber-400"},
          {label:"Total Bal",   val:totalBal, num:"text-blue-600 dark:text-blue-400"},
        ].map(({label,val,num})=>(
          <div key={label} className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl p-4 text-center">
            <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
            <div className={`text-xl font-bold tabular-nums ${num}`}>{$$c(val)}</div>
          </div>
        ))}
      </div>

      <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-xl p-1 mb-4 gap-1">
        {[["loans","All Active Loans"],["lenders","By Lender"]].map(([v,l])=>(
          <button key={v} onClick={()=>setView(v)}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${view===v?"bg-white dark:bg-zinc-700 text-slate-900 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-300"}`}>{l}</button>
        ))}
      </div>

      {view==="loans"&&(()=>{
        const sortedLoans=[...allActive].sort((a,b)=>{
          if(!sort.col)return 0;
          const d=sort.dir==="asc"?1:-1;
          switch(sort.col){
            case"Lender":   return d*a.lenderName.localeCompare(b.lenderName);
            case"Property": return d*a.propAddress.localeCompare(b.propAddress);
            case"Type":     return d*a.loanType.localeCompare(b.loanType);
            case"Principal":return d*(a.principal-b.principal);
            case"Rate":     return d*((a.interestRate||0)-(b.interestRate||0));
            case"Balance":  return d*(a.bal-b.bal);
            case"Interest": return d*(a.intEarned-b.intEarned);
            case"Started":  return d*(a.startDate||"").localeCompare(b.startDate||"");
            case"Note":     return d*((a.promissoryNote?1:0)-(b.promissoryNote?1:0));
            default:        return 0;
          }
        });
        const COLS=[
          {h:"Lender",   left:true,  sort:true},
          {h:"Type",     left:true,  sort:true},
          {h:"Property", left:true,  sort:true},
          {h:"Principal",left:false, sort:true},
          {h:"Rate",     left:false, sort:true},
          {h:"Balance",  left:false, sort:true},
          {h:"Interest", left:false, sort:true},
          {h:"Started",  left:false, sort:true},
          {h:"Note",     left:false, sort:true},
        ];
        return (
          <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 overflow-hidden">
            {allActive.length===0&&<div className="text-center py-12 text-slate-400 dark:text-zinc-500 text-sm">No active loans on properties.</div>}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-zinc-800 text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-wider text-[10px]">
                    {COLS.map(({h,left,sort:canSort})=>{
                      const isActive=sort.col===h;
                      return (
                        <th key={h}
                          onClick={canSort?()=>toggleSort(h):undefined}
                          className={`py-3 px-3 ${left?"text-left":"text-right"} ${canSort?"cursor-pointer select-none hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors":""} ${isActive?"text-slate-700 dark:text-zinc-200":""}`}>
                          <span className={`inline-flex items-center gap-0.5 ${left?"":"justify-end w-full"}`}>
                            {h}
                            {canSort&&(isActive
                              ? <span className="text-blue-500 ml-0.5">{sort.dir==="asc"?"↑":"↓"}</span>
                              : <span className="opacity-25 ml-0.5">↕</span>
                            )}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-zinc-900 divide-y divide-slate-50 dark:divide-zinc-800">
                  {sortedLoans.map(l=>(
                    <tr key={l.id} className="hover:bg-slate-50 dark:hover:bg-zinc-800/60 transition-colors">
                      <td className="py-3 px-3 font-bold text-slate-900 dark:text-zinc-100 whitespace-nowrap">{l.lenderName}</td>
                      <td className="py-3 px-3"><TypeBadge type={l.loanType} sm/></td>
                      <td className="py-3 px-3 text-slate-500 dark:text-zinc-400 max-w-[130px] truncate">{l.propAddress}</td>
                      <td className="py-3 px-3 text-right text-slate-700 dark:text-zinc-200 tabular-nums">{$$(l.principal)}</td>
                      <td className="py-3 px-3 text-right text-slate-500 dark:text-zinc-400 whitespace-nowrap">{fmtRate(l)}</td>
                      <td className="py-3 px-3 text-right font-bold text-blue-700 dark:text-blue-400 tabular-nums">{$$(l.bal)}</td>
                      <td className="py-3 px-3 text-right text-emerald-600 dark:text-emerald-400 tabular-nums">{$$(l.intEarned)}</td>
                      <td className="py-3 px-3 text-right text-slate-500 dark:text-zinc-400 whitespace-nowrap tabular-nums">{l.startDate||"—"}</td>
                      <td className="py-3 px-3 text-right">
                        {l.promissoryNote ? <span className="text-emerald-500 font-bold">✓</span> : <span className="text-red-400 font-bold">✗</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {view==="lenders"&&(
        <div>
          {lenders.length>0&&(
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest shrink-0">Sort</span>
              <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-xl p-0.5 gap-0.5">
                {[["name","A–Z"],["high","High → Low"],["low","Low → High"]].map(([v,l])=>(
                  <button key={v} onClick={()=>setLenderSort(v)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap ${lenderSort===v?"bg-white dark:bg-zinc-700 text-slate-900 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-300"}`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-3">
          {lenders.length===0&&<div className="text-center py-12 text-slate-400 dark:text-zinc-500 text-sm">No active lenders.</div>}
          {[...lenders].sort((a,b)=>{
            if(lenderSort==="high")return b.totalBal-a.totalBal;
            if(lenderSort==="low")return a.totalBal-b.totalBal;
            return a.name.localeCompare(b.name);
          }).map(ld=>(
            <div key={ld.name} className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm hover:shadow-md dark:shadow-none transition-shadow">
              <div className="px-5 py-4 flex justify-between items-start">
                <div>
                  <div className="font-bold text-slate-900 dark:text-zinc-100 text-[15px]">{ld.name}</div>
                  <div className="flex gap-1.5 mt-1.5 flex-wrap">{ld.types.map(t=><TypeBadge key={t} type={t} sm/>)}</div>
                  <div className="text-xs text-slate-400 dark:text-zinc-500 mt-1">{ld.loans.length} loan{ld.loans.length!==1?"s":""} · {ld.props.join(" / ")}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-1">Current Payoff</div>
                  <div className="font-bold text-blue-700 dark:text-blue-400 text-2xl tabular-nums">{$$(ld.totalBal)}</div>
                </div>
              </div>
              <div className="grid grid-cols-3 divide-x divide-slate-100 dark:divide-zinc-800 border-t border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/50">
                {[["Principal",$$(ld.totalPrin),"text-slate-800 dark:text-zinc-100"],["Interest",$$(ld.totalInt),"text-emerald-600 dark:text-emerald-400"],["Avg Rate",ld.avgRate.toFixed(1)+"%","text-slate-800 dark:text-zinc-100"]].map(([l,v,c])=>(
                  <div key={l} className="px-4 py-3 text-center">
                    <div className="text-[10px] text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-widest mb-1">{l}</div>
                    <div className={`font-bold tabular-nums ${c}`}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Property Dashboard ───────────────────────────────────────────────────────
function PropertyDashboard({ data }) {
  const [deployPct,setDeployPct]=useState(75);
  const active=data.properties.filter(p=>!p.dateSold);
  const rows=active.map(prop=>{
    const loans=prop.loans.filter(l=>!l.endDate);
    const funded=loans.reduce((s,l)=>s+(l.principal||0),0);
    const needed=prop.fundingNeeded||0;
    const short=Math.max(0,needed-funded);
    return{prop,loans,funded,needed,short,under:short>0};
  }).sort((a,b)=>b.under-a.under);

  const totalDeployed=rows.reduce((s,r)=>s+r.funded,0);
  const unassignedTotal=data.unassigned.reduce((s,u)=>s+(u.principal||u.amount||0),0);
  const totalPortfolio=rows.reduce((s,r)=>s+r.needed,0);
  const needNow=Math.round(totalPortfolio*deployPct/100);
  const haveNow=totalDeployed+unassignedTotal;
  const goFindThis=Math.max(0,needNow-haveNow);
  const idleCapital=Math.max(0,haveNow-needNow);

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">Property Dashboard</h2>
        <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">Capital deployment overview</p>
      </div>

      {/* Top 3 stat cards */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="bg-slate-900 dark:bg-zinc-800 rounded-2xl p-4 text-white text-center">
          <div className="text-[9px] font-semibold text-slate-400 uppercase tracking-widest mb-2">Under Mgmt</div>
          <div className="text-xl font-bold tabular-nums">{$$c(haveNow)}</div>
          <div className="text-[10px] text-slate-500 mt-1">deployed + ready</div>
        </div>
        <div className="bg-blue-600 rounded-2xl p-4 text-white text-center">
          <div className="text-[9px] font-semibold text-blue-200 uppercase tracking-widest mb-2">On Deals</div>
          <div className="text-xl font-bold tabular-nums">{$$c(totalDeployed)}</div>
          <div className="text-[10px] text-blue-200 mt-1">{rows.length} propert{rows.length===1?"y":"ies"}</div>
        </div>
        <div className="bg-violet-600 rounded-2xl p-4 text-white text-center">
          <div className="text-[9px] font-semibold text-violet-200 uppercase tracking-widest mb-2">Ready</div>
          <div className="text-xl font-bold tabular-nums">{$$c(unassignedTotal)}</div>
          <div className="text-[10px] text-violet-200 mt-1">{data.unassigned.length} unassigned</div>
        </div>
      </div>

      {/* Capital calculator */}
      <div className="rounded-2xl border border-slate-200 dark:border-zinc-700 overflow-hidden mb-5 shadow-sm">
        <div className="bg-slate-900 dark:bg-zinc-800 px-6 py-5">
          <div className="flex justify-between items-start mb-4">
            <div>
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-1.5">Total Portfolio Size</div>
              <div className="text-3xl font-bold text-white tabular-nums">{$$(totalPortfolio)}</div>
              <div className="text-xs text-slate-400 mt-1">{active.length} active deal{active.length!==1?"s":""}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-1.5">Available Now</div>
              <div className="text-2xl font-bold text-white tabular-nums">{$$(haveNow)}</div>
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
                {goFindThis>0 ? $$(goFindThis) : "All good"}
              </div>
              <div className="text-xs text-white/60 mt-2">
                Need {$$(needNow)} ({deployPct}% of {$$(totalPortfolio)}) · Have {$$(haveNow)}
              </div>
            </div>
            {idleCapital>0&&(
              <div className="text-right bg-white/20 rounded-2xl px-4 py-3">
                <div className="text-[10px] font-semibold text-white/70 uppercase tracking-widest mb-1">Idle Capital</div>
                <div className="text-2xl font-bold text-white tabular-nums">{$$(idleCapital)}</div>
                <div className="text-[10px] text-white/50 mt-0.5">not needed yet</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {active.length===0&&<div className="text-center text-slate-400 dark:text-zinc-500 py-12 text-sm">No active properties.</div>}
      <div className="space-y-3">
        {rows.map(({prop,loans,funded,needed,short,under})=>(
          <div key={prop.id} className={`rounded-2xl border overflow-hidden ${under?"border-red-200 dark:border-red-800":"border-slate-200 dark:border-zinc-800"}`}>
            <div className={`px-5 py-3.5 border-b ${under?"bg-red-50 dark:bg-red-950/20 border-red-100 dark:border-red-800":"bg-slate-50 dark:bg-zinc-800 border-slate-100 dark:border-zinc-700"}`}>
              <div className="flex justify-between items-center mb-2">
                <span className="font-semibold text-slate-900 dark:text-zinc-100">{prop.address}</span>
                {under&&<span className="text-red-600 dark:text-red-400 font-bold tabular-nums">-{$$(short)}</span>}
              </div>
              <div className="h-1.5 bg-slate-200 dark:bg-zinc-700 rounded-full overflow-hidden mb-1.5">
                <div className={`h-full rounded-full ${under?"bg-red-400":pct(funded,needed)===100?"bg-emerald-500":"bg-blue-500"}`} style={{width:`${pct(funded,needed)}%`}}/>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className={`font-semibold tabular-nums ${under?"text-red-600 dark:text-red-400":"text-emerald-600 dark:text-emerald-400"}`}>{$$(funded)} funded</span>
                <span className="text-slate-400 dark:text-zinc-500 tabular-nums">{$$(needed)} needed</span>
              </div>
            </div>
            {loans.length>0&&(
              <table className="w-full text-xs bg-white dark:bg-zinc-900">
                <tbody className="divide-y divide-slate-50 dark:divide-zinc-800">
                  {loans.map(l=>(
                    <tr key={l.id} className="hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors">
                      <td className="px-5 py-2.5 font-semibold text-slate-800 dark:text-zinc-100">{l.lenderName}</td>
                      <td className="px-3 py-2.5"><TypeBadge type={l.loanType} sm/></td>
                      <td className="px-3 py-2.5 text-right text-slate-600 dark:text-zinc-300 tabular-nums">{$$(l.principal)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400 dark:text-zinc-500 whitespace-nowrap">{fmtRate(l)}</td>
                      <td className="px-5 py-2.5 text-right font-bold text-blue-700 dark:text-blue-400 tabular-nums">{$$(calcBalance(l))}</td>
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

// ─── History ──────────────────────────────────────────────────────────────────
function HistoryPage({ data }) {
  const [lf,setLf]=useState("all");
  const [tf,setTf]=useState("all");
  const raw=[];
  data.properties.forEach(prop=>{
    prop.loans.forEach(loan=>{
      raw.push({date:loan.startDate,sx:"b",lender:loan.lenderName,loanType:loan.loanType,interestType:loan.interestType||"percentage",etype:"start",amount:loan.principal||0,principal:loan.principal||0,property:prop.address,rate:loan.interestRate||0,loanId:loan.id});
      const end=loan.endDate||prop.dateSold;
      if(end){const finBal=calcBalance(loan,end);raw.push({date:end,sx:"a",lender:loan.lenderName,loanType:loan.loanType,interestType:loan.interestType||"percentage",etype:prop.dateSold&&!loan.endDate?"sold":"closed",amount:finBal,principal:loan.principal||0,interest:finBal-(loan.principal||0),property:prop.address,rate:loan.interestRate||0,loanId:loan.id});}
    });
  });
  raw.sort((a,b)=>((a.date||"")+a.sx).localeCompare((b.date||"")+b.sx));
  const lp={},lc={};
  const events=raw.map(ev=>{
    lp[ev.lender]=lp[ev.lender]??0;lc[ev.lender]=lc[ev.lender]??0;
    let nc,pp;
    if(ev.etype==="start"){lc[ev.lender]+=ev.amount;pp=lp[ev.lender];nc=pp>0?ev.amount-pp:ev.amount;lp[ev.lender]=0;}
    else{nc=ev.interest??0;lp[ev.lender]+=ev.amount;}
    return{...ev,nc,pp,cumLent:lc[ev.lender]};
  });
  const allL=[...new Set(events.map(e=>e.lender))].sort();
  const filtered=events.filter(e=>(lf==="all"||e.lender===lf)&&(tf==="all"||e.loanType===tf));
  const cfg={
    start: {label:"Loan Started", icon:"↗", cls:"bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400"},
    closed:{label:"Loan Closed",  icon:"✓", cls:"bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400"},
    sold:  {label:"Property Sold",icon:"🏡",cls:"bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"},
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-zinc-100">History</h2>
          <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">Auto-generated transaction log</p>
        </div>
        <span className="text-xs font-semibold text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 px-2.5 py-1 rounded-full">{filtered.length} events</span>
      </div>
      <div className="flex gap-2 mb-4">
        <select value={lf} onChange={e=>setLf(e.target.value)} className="flex-1 border border-slate-200 dark:border-zinc-700 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="all">All Lenders</option>{allL.map(l=><option key={l} value={l}>{l}</option>)}
        </select>
        <select value={tf} onChange={e=>setTf(e.target.value)} className="border border-slate-200 dark:border-zinc-700 rounded-xl px-3 py-2.5 text-sm bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="all">All Types</option><option value="private">Private</option><option value="hard">Hard</option>
        </select>
      </div>
      {!filtered.length&&<div className="text-center py-16 text-slate-400 dark:text-zinc-500"><div className="text-5xl mb-3">📋</div><p className="font-semibold">No transactions yet</p></div>}
      <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 overflow-hidden divide-y divide-slate-100 dark:divide-zinc-800">
        {filtered.map((ev,i)=>{
          const c=cfg[ev.etype]??cfg.closed;const pos=ev.nc>=0;const roll=ev.etype==="start"&&ev.pp>0;
          const rateLabel=ev.interestType==="fixed"?"$"+Math.round(ev.rate).toLocaleString()+" fixed":ev.rate+"%/yr";
          return(
            <div key={`${ev.loanId}-${ev.etype}-${i}`} className="flex items-start gap-3 px-5 py-4 bg-white dark:bg-zinc-900 hover:bg-slate-50 dark:hover:bg-zinc-800/60 transition-colors">
              <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-sm shrink-0 mt-0.5 ${c.cls}`}>{c.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                      <span className="font-mono text-[10px] text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 rounded-md px-1.5 py-0.5">{ev.date}</span>
                      <span className={`text-[10px] font-semibold uppercase ${c.cls} rounded-full px-2 py-0.5`}>{c.label}</span>
                      <TypeBadge type={ev.loanType} sm/>
                      {roll&&<span className="text-[10px] font-semibold text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30 rounded-full px-2 py-0.5">Rollover</span>}
                    </div>
                    <div className="font-bold text-slate-900 dark:text-zinc-100">{ev.lender}</div>
                    <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">{ev.property} · {rateLabel}</div>
                    {ev.etype!=="start"&&(ev.interest||0)>0.01&&<div className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold mt-0.5 tabular-nums">+{$$(ev.interest)} interest</div>}
                    {roll&&ev.pp>0&&<div className="text-xs text-violet-500 dark:text-violet-400 mt-0.5 tabular-nums">Rolled from {$$(ev.pp)}</div>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-bold text-slate-900 dark:text-zinc-100 tabular-nums">{$$(ev.amount)}</div>
                    <div className={`text-sm font-bold tabular-nums ${pos?"text-emerald-600 dark:text-emerald-400":"text-red-500 dark:text-red-400"}`}>{$$s(ev.nc)}</div>
                    <div className="text-[10px] text-slate-400 dark:text-zinc-500">net change</div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Tracker ─────────────────────────────────────────────────────────────
const TABS=[{id:"Properties",label:"🏠",full:"Properties"},{id:"LenderDash",label:"👥",full:"Lenders"},{id:"PropDash",label:"📊",full:"Prop Dash"},{id:"History",label:"📋",full:"History"}];

export default function Tracker({ onSignOut, userEmail, dark, onToggleDark }) {
  const [data,setData]=useState(null);
  const [tab,setTab]=useState("Properties");
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    load().then(d=>{setData(d);setLoading(false);})
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

  if(loading) return (
    <div className="min-h-screen bg-slate-50 dark:bg-zinc-950 flex items-center justify-center">
      <div className="text-slate-400 dark:text-zinc-500 text-sm">Loading…</div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-zinc-950 transition-colors duration-200">
      {/* Header */}
      <div className="bg-white dark:bg-zinc-900 border-b border-slate-200 dark:border-zinc-800 sticky top-0 z-40" style={{boxShadow:"0 1px 12px rgba(0,0,0,0.06)"}}>
        <div className="px-5 pt-3.5 pb-0">
          <div className="flex items-center gap-3 mb-3">
            {/* Logo mark */}
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-700 to-slate-950 dark:from-zinc-600 dark:to-zinc-800 flex items-center justify-center shrink-0 shadow-md">
              <span className="text-white font-black text-sm tracking-tight">N</span>
            </div>
            <div>
              <div className="font-black text-slate-900 dark:text-zinc-100 leading-none tracking-tight">Nexus Homes</div>
              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5 uppercase tracking-widest font-semibold">Private Money Tracker</div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={onToggleDark}
                className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-200 dark:border-zinc-700 text-slate-500 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all"
                title={dark?"Switch to light":"Switch to dark"}>
                {dark?"☀️":"🌙"}
              </button>
              <span className="text-xs text-slate-400 dark:text-zinc-500 hidden sm:block max-w-[120px] truncate">{userEmail}</span>
              <button onClick={onSignOut} className="text-xs font-medium text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 border border-slate-200 dark:border-zinc-700 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-slate-50 dark:hover:bg-zinc-800">Sign out</button>
            </div>
          </div>
          {/* Tabs */}
          <div className="flex overflow-x-auto -mb-px gap-0">
            {TABS.map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-all shrink-0 ${tab===t.id?"border-slate-900 dark:border-zinc-100 text-slate-900 dark:text-zinc-100":"border-transparent text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300"}`}>
                <span>{t.label}</span><span>{t.full}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Page content */}
      <div className="p-4 max-w-2xl mx-auto pb-16">
        {tab==="Properties" &&<PropertiesPage data={data} update={update}/>}
        {tab==="LenderDash"&&<LenderDashboard data={data}/>}
        {tab==="PropDash"  &&<PropertyDashboard data={data}/>}
        {tab==="History"   &&<HistoryPage data={data}/>}
      </div>
    </div>
  );
}
