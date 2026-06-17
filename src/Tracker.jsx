import { useState, useEffect, useRef } from "react";
import { loadData, saveData, subscribeToChanges } from './supabase'

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
const yearDays = l => /phoenix/i.test(l?.lenderName||"") ? 360 : 365;

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
  const [f, sf] = useState(()=>({
    lenderName:"", loanType:"private", principal:"",
    startDate:TODAY, interestType:"percentage", interestRate:"", specialTerms:"", endDate:"",
    destination:"unassigned", promissoryNote:false,
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

// ─── Mark Property Sold Modal ─────────────────────────────────────────────────
function MarkSoldModal({ prop, allProperties, onConfirm, onClose }) {
  const activeLoans=prop.loans.filter(l=>!l.endDate);
  const otherProps=allProperties.filter(p=>!p.dateSold&&p.id!==prop.id);
  const [step,setStep]=useState(1);
  const [soldDate,setSoldDate]=useState(TODAY);

  // Per-lender rows — includes principal/interest/fees breakdown
  const [rows,setRows]=useState(()=>activeLoans.map(l=>{
    const monthly=(l.paymentType||"closing")!=="closing";
    const calcP=Math.round(calcBalance(l,soldDate)*100)/100; // cent precision
    // calcInterest: interest owed AT CLOSING (0 for monthly since it was paid during hold)
    const calcI=monthly?0:Math.round((calcP-(l.principal||0))*100)/100;
    // intEarned: total interest earned on this loan (paid monthly OR accrued to closing)
    const intEarned=calcIntEarned(l,soldDate); // already cent-precise
    return {
      loanId:l.id,lenderName:l.lenderName,loanType:l.loanType,
      principal:l.principal||0,calcPayoff:calcP,calcInterest:calcI,
      isMonthly:monthly,
      interestRate:l.interestRate||0,interestType:l.interestType||"percentage",
      paymentType:l.paymentType||"closing",specialTerms:l.specialTerms||"",
      // Breakdown fields (editable) — interestPayoff pre-filled from dashboard calc
      principalPayoff:String(l.principal||0),
      interestPayoff:String(intEarned), // for monthly: interest paid during hold; for closing: accrued at payoff
      lenderFees:"0",
      paidAtTitle:false, // if true, lender is paid at closing table — not from our wire
      // For custom split
      customRolling:String(l.principal||0),
      type:"paidOut",destination:otherProps[0]?.id||"unassigned",newStartDate:nextDay(soldDate),
    };
  }));
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
      return {...r,calcPayoff:calcP,calcInterest:calcI,interestPayoff:String(intEarned),newStartDate:startDate};
    }));
  },[soldDate]);

  // How much each lender is paid FROM the wire (0 if paid at title)
  // Rolling lenders' principals flow through the wire (Nexus receives then reinvests them)
  const wireContrib=r=>{
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
  // Total paid at title (before wire lands)
  const titleTotal=rows.reduce((s,r)=>r.paidAtTitle?s+((parseFloat(r.principalPayoff)||0)+(parseFloat(r.interestPayoff)||0)+(parseFloat(r.lenderFees)||0)):s,0);

  const lenderTotal=rows.reduce((s,r)=>s+wireContrib(r),0);

  // Step 2 cost fields
  const [cashToCloseIn,setCashToCloseIn]=useState(String(prop.purchasePrice||""));
  const [rehabIn,setRehabIn]=useState(String(prop.rehabBudget||""));
  const [miscIn,setMiscIn]=useState(String(Math.round((prop.monthlyHolding??500)*effectiveMonths(prop))));
  const [wireIn,setWireIn]=useState("");
  const [linked,setLinked]=useState("wire");

  const cashToClose=parseFloat(cashToCloseIn)||0;
  const rehab=parseFloat(rehabIn)||0;
  // Money Costs = interest + lender fees for all applicable types
  // rollPrincipal: Nexus keeps interest (income), but fees are still a cost
  // waiveInterest: interest forgiven, but fees still apply
  const moneyCosts=Math.round(rows.reduce((s,r)=>{
    const fees=parseFloat(r.lenderFees)||0;
    const interest=parseFloat(r.interestPayoff)||0;
    if(r.isMonthly) return s+interest+fees;
    if(r.type==="paidOut"||r.type==="payInterest"||r.type==="rollFull") return s+interest+fees;
    return s+fees; // rollPrincipal/waiveInterest/custom: fees still cost, interest not
  },0)*100)/100;
  const baseCosts=cashToClose+rehab+moneyCosts;
  const wire=linked==="wire"?parseFloat(wireIn)||0:baseCosts+(parseFloat(miscIn)||0);
  const misc=linked==="misc"?parseFloat(miscIn)||0:Math.max(0,wire-baseCosts);
  const totalCosts=baseCosts+misc;
  // wire + titleTotal = totalCosts + dealProfit  (user's double-sided equation)
  // nexusCapital = what Nexus recovers from wire after paying lenders (totalCosts - titleTotal - lenderTotal)
  const nexusCapital=totalCosts-titleTotal-lenderTotal;
  const dealProfit=(wire+titleTotal)-totalCosts;
  const balanced=wire>0&&Math.abs(lenderTotal+nexusCapital+dealProfit-wire)<0.01;

  const handleWireChange=v=>{setWireIn(v);setLinked("wire");};
  const handleMiscChange=v=>{setMiscIn(v);setLinked("misc");};

  const handleConfirm=()=>{
    const dispositions={};
    rows.forEach(r=>{
      dispositions[r.loanId]={
        type:r.type,
        principalPayoff:parseFloat(r.principalPayoff)||0,
        interestPayoff:parseFloat(r.interestPayoff)||0,
        lenderFees:parseFloat(r.lenderFees)||0,
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
    });
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
                {rows.map(r=>{
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
                            // paidOut: only reset principal; leave interestPayoff as-is (pre-filled from dashboard)
                            if(t==="paidOut") patch.principalPayoff=String(r.principal);
                            // payInterest: reset interest to closing interest (only shown for closing-type loans)
                            if(t==="payInterest") patch.interestPayoff=String(r.calcInterest);
                            if(t==="custom") patch.customRolling=String(r.principal);
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
                                {r.isMonthly?"Interest (paid monthly)":"Interest"}
                              </div>
                              <input type="number" value={r.interestPayoff} onChange={e=>upd(r.loanId,{interestPayoff:e.target.value})} onWheel={e=>e.target.blur()}
                                className={r.isMonthly?"w-full border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-amber-400 tabular-nums text-amber-700 dark:text-amber-400":numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Lender Fees</div>
                              <input type="number" value={r.lenderFees} onChange={e=>upd(r.loanId,{lenderFees:e.target.value})} onWheel={e=>e.target.blur()} className={numIn}/>
                            </div>
                          </div>
                          {r.isMonthly&&<p className="text-[10px] text-amber-600 dark:text-amber-400">Interest already received monthly — not deducted from closing wire</p>}
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
                  const rowTotal=(parseFloat(r.principalPayoff)||0)+(parseFloat(r.interestPayoff)||0)+(parseFloat(r.lenderFees)||0);
                  let label;
                  if(r.paidAtTitle) label=`${$$p(rowTotal)} at title 🏛`;
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
                  {linked==="wire"
                    ?<div className={autoCls} title="Auto-calculated from wire">{$$p(misc)}</div>
                    :<input type="number" value={miscIn} onChange={e=>handleMiscChange(e.target.value)} onWheel={e=>e.target.blur()} className={inputCls}/>}
                  <button type="button" onClick={()=>{if(linked==="wire"){setMiscIn(String(Math.round(misc)));setLinked("misc");}else{setWireIn(String(Math.round(wire)));setLinked("wire");}}}
                    className="shrink-0 text-[10px] font-semibold text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors whitespace-nowrap">
                    {linked==="wire"?"edit":"auto"}
                  </button>
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
              {linked==="misc"
                ?<div className={`${autoCls} font-bold text-blue-700 dark:text-blue-400`} title="Auto-calculated from misc">{$$p(wire)}</div>
                :<input type="number" value={wireIn} onChange={e=>handleWireChange(e.target.value)} onWheel={e=>e.target.blur()} placeholder="0"
                    className="flex-1 border-2 border-blue-400 dark:border-blue-600 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-right font-bold text-blue-700 dark:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums"/>}
              <button type="button" onClick={()=>{if(linked==="misc"){setWireIn(String(Math.round(wire)));setLinked("wire");}else{setMiscIn(String(Math.round(misc)));setLinked("misc");}}}
                className="shrink-0 text-[10px] font-semibold text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors whitespace-nowrap">
                {linked==="misc"?"edit":"auto"}
              </button>
            </div>

            {/* Deal Profit — always visible */}
            {wire>0?(
              <div className={`rounded-xl p-3 text-center ${dealProfit>=0?"bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900":"bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900"}`}>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Deal Profit</div>
                <div className={`text-2xl font-bold tabular-nums ${dealProfit>=0?"text-emerald-700 dark:text-emerald-400":"text-red-600 dark:text-red-400"}`}>{$$ps(dealProfit)}</div>
                <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-1">{$$p(wire)} wire {titleTotal>0?`+ ${$$p(titleTotal)} title `:""}− {$$p(totalCosts)} costs</div>
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
                    {$$p(wire)} = Lenders {$$p(lenderTotal)} + Costs {$$p(nexusCapital)} + Profit {$$ps(dealProfit)}
                  </span>
                </div>
              </div>
            )}

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
        <Inp label="Cash to Close ($)" type="number" value={f.purchasePrice} onChange={s("purchasePrice")} placeholder="150000"/>
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
          {[["Cash to Close",purchase],["Rehab",rehab],[`Holding (${months} mo × $${holding}/mo)`,holding*months]].filter(([,v])=>v>0).map(([l,v])=>(
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
  const [inlineDraw,setInlineDraw]=useState(null); // {propId, loanId, date, amt}
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

  const loanFields = f => ({
    lenderName:f.lenderName, loanType:f.loanType, principal:parseFloat(f.principal)||0,
    startDate:f.startDate, interestRate:parseFloat(f.interestRate)||0,
    interestType:f.interestType||"percentage",
    paymentType:f.paymentType||"closing",
    monthlyPayment:parseFloat(f.monthlyPayment)||0,
    drawFacility:f.drawFacility?{committed:parseFloat(f.drawFacility.committed)||0,draws:f.drawFacility.draws||[]}:null,
    promissoryNote:f.promissoryNote||false, specialTerms:f.specialTerms||"", endDate:f.endDate||null,
  });

  const saveMoneyForm = f => {
    const base=loanFields(f);
    if(f.destination==="unassigned"){
      update(d=>({...d,unassigned:[...d.unassigned,{id:uid(),...base}]}));
    } else {
      update(d=>({...d,properties:d.properties.map(p=>p.id!==f.destination?p:{...p,loans:[...p.loans,{id:uid(),...base}]})}));
    }
    setModal(null);
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

  const placeOnProperty = (fund,propId) => {
    const loan={id:uid(),lenderName:fund.lenderName,loanType:fund.loanType,principal:fund.principal||fund.amount||0,startDate:fund.startDate||fund.date||TODAY,interestRate:fund.interestRate||0,interestType:fund.interestType||"percentage",paymentType:fund.paymentType||"closing",monthlyPayment:fund.monthlyPayment||0,drawFacility:fund.drawFacility||null,promissoryNote:fund.promissoryNote||false,specialTerms:fund.specialTerms||fund.notes||"",endDate:fund.endDate||null};
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

  const handleMarkSold = (prop, soldDate, dispositions, closingData) => {
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
        promissoryNote:false,specialTerms:d.specialTerms||loan.specialTerms||"",endDate:null,
      };
      if(d.destination==="unassigned"){newUnassigned.push(entry);}
      else{if(!newLoansForProps[d.destination])newLoansForProps[d.destination]=[];newLoansForProps[d.destination].push(entry);}
    });
    update(d=>({...d,
      properties:d.properties.map(p=>{
        if(p.id===prop.id)return{...p,dateSold:soldDate,closingData:closingData||null,loans:p.loans.map(l=>l.endDate?l:{...l,endDate:soldDate})};
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
  const visible=data.properties.filter(p=>showSold||!p.dateSold).sort((a,b)=>propSellDate(a).localeCompare(propSellDate(b)));
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
          const funded=active.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);
          const needed=propNeeded(prop,active);
          const short=Math.max(0,needed-funded);
          return{prop,active,funded,needed,short,under:!prop.dateSold&&short>0,full:!prop.dateSold&&funded>0&&short===0};
        });
        const sorted=[...rows].sort((a,b)=>{
          if(!propSort.col) return propSellDate(a.prop).localeCompare(propSellDate(b.prop));
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
        {visible.map((prop,visIdx)=>{
          const active=prop.loans.filter(l=>!l.endDate);
          const funded=active.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);
          const needed=propNeeded(prop,active);
          const short=Math.max(0,needed-funded);
          const under=!prop.dateSold&&short>0;
          const full=!prop.dateSold&&funded>0&&short===0;
          const isOpen=!!expanded[prop.id];
          const months=effectiveMonths(prop);
          const monthlyInt=active.reduce((s,l)=>s+monthlyLoanPayment(l),0);
          const holdingMo=prop.monthlyHolding??500;

          return (
            <div key={prop.id} className={`rounded-2xl overflow-hidden transition-all ${prop.dateSold?"border border-slate-200 dark:border-zinc-800 opacity-60":under?"border-l-4 border border-red-300 dark:border-red-700 border-l-red-500":"border border-slate-200 dark:border-zinc-800 shadow-sm hover:shadow-md dark:shadow-none transition-shadow"}`}>
              <div className={`cursor-pointer ${prop.dateSold?"bg-slate-50 dark:bg-zinc-800/30":under?"bg-red-50 dark:bg-red-950/20":"bg-white dark:bg-zinc-900"}`} onClick={()=>toggle(prop.id)}>
                <div className="px-5 pt-4 pb-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-[10px] font-bold text-slate-300 dark:text-zinc-600 tabular-nums">#{visIdx+1}</span>
                      <span className="font-semibold text-slate-900 dark:text-zinc-100 text-[15px]">{prop.address||"Unnamed Property"}</span>
                    </div>
                    {(()=>{const pd=prop.purchaseDate||(prop.loans.map(l=>l.startDate).filter(Boolean).sort()[0]);return pd?<div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Purchased {pd}</div>:null;})()}
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
                        {(prop.purchasePrice||prop.rehabBudget)&&(
                          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-400 dark:text-zinc-500">
                            {prop.purchasePrice>0&&<span>Cash to Close <span className="font-semibold text-slate-600 dark:text-zinc-300 tabular-nums">{$$c(prop.purchasePrice)}</span></span>}
                            {prop.rehabBudget>0&&<span>Rehab <span className="font-semibold text-slate-600 dark:text-zinc-300 tabular-nums">{$$c(prop.rehabBudget)}</span></span>}
                            <span>Holding <span className="font-semibold text-slate-600 dark:text-zinc-300 tabular-nums">{$$c(holdingMo*months)}</span> <span className="opacity-70">({months}mo×${holdingMo}/mo)</span></span>
                            {monthlyInt>0&&<span>Interest <span className="font-semibold text-orange-500 dark:text-orange-400 tabular-nums">{$$c(monthlyInt*months)}</span> <span className="opacity-70">({months}mo×{$$(monthlyInt)}/mo)</span></span>}
                          </div>
                        )}
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
                      const bal=calcBalance(loan);
                      const earned=calcIntEarned(loan);
                      const monthly=monthlyLoanPayment(loan);
                      const drawn=(loan.drawFacility?.draws||[]).reduce((s,d)=>s+(d.amount||0),0);
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
                                <span className="text-slate-500 dark:text-zinc-400">Payoff Bal <strong className="text-blue-700 dark:text-blue-400 tabular-nums">{$$(bal)}</strong></span>
                                {monthly>0&&<span className="text-slate-500 dark:text-zinc-400">Monthly Pmt <strong className="text-orange-600 dark:text-orange-400 tabular-nums">{$$(monthly)}/mo</strong></span>}
                                <span className="text-slate-500 dark:text-zinc-400">Int {monthly>0?"Paid":"Earned"} <strong className="text-emerald-600 dark:text-emerald-400 tabular-nums">{$$(earned)}</strong></span>
                                {loan.specialTerms&&<span className="col-span-2 text-slate-400 dark:text-zinc-500 italic">{loan.specialTerms}</span>}
                              </div>
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
                                    {[["Committed",$$(loan.drawFacility.committed),"text-blue-700 dark:text-blue-300"],["Drawn",$$(drawn),"text-slate-700 dark:text-zinc-200"],["Available",$$(drawRemaining(loan)),"text-emerald-600 dark:text-emerald-400"]].map(([l,v,c])=>(
                                      <div key={l}><div className="text-[9px] text-blue-400 dark:text-blue-500 uppercase mb-1">{l}</div><div className={`font-bold tabular-nums ${c}`}>{v}</div></div>
                                    ))}
                                  </div>
                                  {(loan.drawFacility.draws||[]).map(d=>(
                                    <div key={d.id} className="flex justify-between text-[11px] text-slate-500 dark:text-zinc-400 pt-1 border-t border-blue-100 dark:border-blue-900/40 first:border-0 mt-1">
                                      <span>{d.date}</span><span className="tabular-nums">{$$(d.amount)} drawn</span>
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
        <LenderMoneyForm properties={data.properties} init={{...modal.loan,destination:modal.propId,principal:String(modal.loan.principal),interestRate:String(modal.loan.interestRate||""),interestType:modal.loan.interestType||"percentage",paymentType:modal.loan.paymentType||"closing",monthlyPayment:String(modal.loan.monthlyPayment||""),drawFacility:modal.loan.drawFacility||null,promissoryNote:modal.loan.promissoryNote||false}}
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
      {modal?.type==="markSold"&&<MarkSoldModal prop={modal.prop} allProperties={data.properties} onConfirm={(d,disp,cd)=>handleMarkSold(modal.prop,d,disp,cd)} onClose={()=>setModal(null)}/>}
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
      prop.loans.filter(l=>!l.endDate).map(l=>({...l,propAddress:prop.address,bal:calcBalance(l),intEarned:calcIntEarned(l)}))
    ),
    ...data.unassigned.map(u=>{const p=u.principal||u.amount||0;const l={...u,principal:p};return{...l,propAddress:"Unassigned",bal:calcBalance(l),intEarned:calcIntEarned(l)};}),
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
          {label:"Total Payoff", val:totalBal, num:"text-blue-600 dark:text-blue-400"},
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
            case"Payoff Bal": return d*(a.bal-b.bal);
            case"Int Paid":   return d*(a.intEarned-b.intEarned);
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
          {h:"Rate",      left:false, sort:true},
          {h:"Payoff Bal",left:false, sort:true},
          {h:"Int Paid",  left:false, sort:true},
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
    const funded=loans.reduce((s,l)=>s+(l.principal||0)+(l.drawFacility?.committed||0),0);
    const needed=propNeeded(prop,loans);
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
        <div className="mb-4 rounded-2xl bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 px-5 py-4 flex items-center justify-between">
          <div>
            <div className="text-[10px] font-semibold text-orange-500 dark:text-orange-400 uppercase tracking-widest mb-0.5">Monthly Cash Needed</div>
            <div className="text-[11px] text-orange-400 dark:text-orange-500">{$$(monthlyLenderBurn)}/mo interest · {$$(monthlyHoldingBurn)}/mo holding</div>
          </div>
          <div className="text-2xl font-black text-orange-600 dark:text-orange-400 tabular-nums">{$$(totalMonthlyBurn)}<span className="text-sm font-semibold">/mo</span></div>
        </div>
      )}

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
    if(prop.dateSold&&prop.closingData){
      raw.push({date:prop.dateSold,sx:"c",etype:"saleSummary",property:prop.address,propId:prop.id,closingData:prop.closingData,loanId:`sale-${prop.id}`});
    }
  });
  raw.sort((a,b)=>((a.date||"")+a.sx).localeCompare((b.date||"")+b.sx));
  const lp={},lc={};
  const events=raw.map(ev=>{
    lp[ev.lender]=lp[ev.lender]??0;lc[ev.lender]=lc[ev.lender]??0;
    let nc,pp;
    if(ev.etype==="saleSummary"){nc=ev.closingData?.profit??0;}
    else if(ev.etype==="start"){lc[ev.lender]+=ev.amount;pp=lp[ev.lender];nc=pp>0?ev.amount-pp:ev.amount;lp[ev.lender]=0;}
    else{nc=ev.interest??0;lp[ev.lender]+=ev.amount;}
    return{...ev,nc,pp,cumLent:lc[ev.lender]};
  });
  const allL=[...new Set(events.map(e=>e.lender))].sort();
  const filtered=events.filter(e=>(lf==="all"||e.lender===lf)&&(tf==="all"||e.loanType===tf));
  const cfg={
    start:       {label:"Loan Started",  icon:"↗", cls:"bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400"},
    closed:      {label:"Loan Closed",   icon:"✓", cls:"bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400"},
    sold:        {label:"Property Sold", icon:"🏡",cls:"bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"},
    saleSummary: {label:"Sale Closed",   icon:"🏡",cls:"bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"},
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
          if(ev.etype==="saleSummary"){
            const cd=ev.closingData;
            return(
              <div key={ev.loanId} className="bg-blue-50 dark:bg-blue-950/20 border-l-4 border-blue-400 dark:border-blue-600 px-5 py-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">🏡</span>
                  <div>
                    <div className="font-bold text-blue-900 dark:text-blue-100">Sale Closed — {ev.property}</div>
                    <div className="text-xs text-blue-500 dark:text-blue-400">{ev.date} · For Bookkeepers</div>
                  </div>
                  <div className="ml-auto text-right">
                    <div className="text-[10px] text-blue-400 dark:text-blue-500 uppercase font-semibold">Wire Received</div>
                    <div className="font-bold text-xl text-blue-700 dark:text-blue-300 tabular-nums">{$$(cd.wire)}</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="bg-white dark:bg-zinc-900 rounded-lg p-3 space-y-1.5">
                    <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Costs</div>
                    {cd.cashToClose>0&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Cash to Close</span><span className="tabular-nums">{$$(cd.cashToClose)}</span></div>}
                    {cd.rehab>0&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Rehab</span><span className="tabular-nums">{$$(cd.rehab)}</span></div>}
                    {cd.moneyCosts>0&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Money Costs (Interest)</span><span className="tabular-nums">{$$(cd.moneyCosts)}</span></div>}
                    {cd.misc>0&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Misc / Holding</span><span className="tabular-nums">{$$(cd.misc)}</span></div>}
                    <div className="flex justify-between font-bold text-slate-900 dark:text-zinc-100 border-t border-slate-100 dark:border-zinc-800 pt-1.5 mt-0.5"><span>Total</span><span className="tabular-nums">{$$(cd.wire)}</span></div>
                  </div>
                  <div className="bg-white dark:bg-zinc-900 rounded-lg p-3 space-y-1.5">
                    <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Funded By</div>
                    {(cd.lenderPayoffs||[]).map(lp=>(
                      <div key={lp.loanId} className="flex justify-between text-slate-600 dark:text-zinc-300">
                        <span className="truncate mr-1">{lp.lenderName}{lp.type==="waiveInterest"&&<span className="text-amber-500 dark:text-amber-400 ml-1 text-[10px]">(waived int.)</span>}</span>
                        <span className="tabular-nums shrink-0">{$$(lp.actualPayoff)}</span>
                      </div>
                    ))}
                    {cd.selfFunded>0&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Nexus Capital</span><span className="tabular-nums">{$$(cd.selfFunded)}</span></div>}
                    <div className="flex justify-between font-bold text-emerald-700 dark:text-emerald-400 border-t border-slate-100 dark:border-zinc-800 pt-1.5 mt-0.5"><span>Profit</span><span className="tabular-nums">{$$(cd.profit)}</span></div>
                  </div>
                </div>
              </div>
            );
          }
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
