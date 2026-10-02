import { useState, useEffect, useLayoutEffect, useMemo, useRef, createContext, useContext, Fragment } from "react";
import { createPortal } from "react-dom";
import { loadData, saveData, subscribeToChanges, listLenderAccounts, createLenderAccount, deleteLenderAccount } from './supabase'
import { DndContext, DragOverlay, PointerSensor, closestCenter, useSensor, useSensors, useDraggable, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, arrayMove, rectSortingStrategy, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const load = loadData
const save = saveData

// toISOString() converts to UTC first, so in the evening in a US timezone it can already be
// "tomorrow" in UTC while it's still today locally — use local date parts instead.
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
})();
const uid   = () => Math.random().toString(36).slice(2, 9);
// Penny-precise everywhere — so a number on screen always matches the bank statement or
// closing doc exactly, nothing hidden by rounding. $$c is the one exception: a compact
// K/M shorthand kept for glance-only dashboard summary tiles, where exact cents would
// just be noise.
const $$p   = n  => "$" + Math.abs(n??0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
const $$ps  = n  => { if(n==null) return "—"; const a=Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,','); return n>=0?`+$${a}`:`-$${a}`; };
const $$c   = n  => { const a=Math.round(Math.abs(n??0)); if(a>=1e6){const m=a/1e6;return "$"+(m>=10?m.toFixed(1):m.toFixed(2)).replace(/\.?0+$/,"")+"M";} if(a>=1e3)return "$"+Math.round(a/1e3)+"K"; return "$"+a; };
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

// Per-lender hard-money billing settings, editable on the lender's own page and applied
// to every loan from that lender. Defaults reproduce the app's existing behavior exactly
// (a loan's own loanType decides the defaults), so nothing changes for a lender until it's
// explicitly customized — see the History tab's addHardPayments for how these are used.
const defaultLenderPaymentSettings = loanType => ({
  graceMonth: loanType==="hard",   // skip the first month before billing starts (only used
                                    // when prorateStubAtClosing is off)
  prorateStubAtClosing: false,      // prorated interest from closing through the end of that
                                     // month is charged at closing instead of rolled into a
                                     // later payment
  firstFullMonthAtClosing: false,   // on top of the stub, ALSO prepay the next full calendar
                                     // month at closing (only meaningful with the stub above)
  dayCountBasis: loanType==="hard" ? 360 : 365,
  monthlyMethod: "perDiem",         // "perDiem" (actual days that month) or "flat" (rate/12 every time)
  drawFee: 0,                       // flat $ fee added for each draw captured in a payment
});
const resolveLenderSettings = (data, lenderName, loanType) => {
  const rec = (data?.lenders||[]).find(l=>l.name===lenderName);
  return {...defaultLenderPaymentSettings(loanType), ...(rec?.paymentSettings||{})};
};

const calcBalance = (l, asOf=TODAY) => {
  if (!l?.startDate||!l?.principal) return l?.principal??0;
  const pt = l.paymentType||"closing";
  if (pt==="monthly_rate"||pt==="monthly_fixed") return l.principal; // payoff = principal only
  if (l.interestType === "fixed") return l.principal + (l.interestRate || 0);
  const end = l.endDate && l.endDate<=asOf ? l.endDate : asOf;
  if (l.startDate>end) return l.principal;
  // A split loan (e.g. a lender funding out of their own equity line) only accrues the
  // portion NOT already being paid out monthly — the other portion (matching, say, their
  // equity line's own rate) is paid in cash each month and never added to the balance.
  const rate = pt==="monthly_rate_split" ? Math.max(0,(l.interestRate||0)-(l.splitMonthlyRate||0)) : (l.interestRate||0);
  return l.principal + l.principal*rate/100*(daysBetween(l.startDate,end)/yearDays(l));
};

// How much of a split-rate loan's interest has already been paid out monthly (the portion
// matching the lender's own cost of funds) as of a given date — 0 for every other type.
const calcMonthlyPaidPortion = (l, asOf=TODAY) => {
  // A split only means anything against a % rate — a Fixed $ loan has no "portion of the
  // rate" to divide, so treat it as unsplit (this combination shouldn't be creatable from
  // either edit screen anymore, but this keeps old/imported data from double-counting).
  if (!l?.startDate||!l?.principal||l.paymentType!=="monthly_rate_split"||l.interestType==="fixed") return 0;
  const end = l.endDate&&l.endDate<=asOf ? l.endDate : asOf;
  if (l.startDate>end) return 0;
  return Math.round(l.principal*(l.splitMonthlyRate||0)/100*(daysBetween(l.startDate,end)/yearDays(l))*100)/100;
};

const calcIntEarned = (l, asOf=TODAY) => {
  if (!l?.startDate||!l?.principal) return 0;
  const pt = l.paymentType||"closing";
  const end = l.endDate&&l.endDate<=asOf ? l.endDate : asOf;
  const days = daysBetween(l.startDate, end);
  if (pt==="monthly_rate") return Math.round((l.principal||0)*(l.interestRate||0)/100/yearDays(l)*days*100)/100;
  if (pt==="monthly_fixed") return Math.round((l.monthlyPayment||0)*days/30.44*100)/100;
  // Total earned either way — the monthly-paid portion (real cash already received) plus
  // whatever's still accruing onto the balance, due at closing.
  if (pt==="monthly_rate_split") return Math.round((calcMonthlyPaidPortion(l,asOf)+(calcBalance(l,asOf)-(l.principal||0)))*100)/100;
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
  // Only the monthly-paid portion is an actual recurring cash draw — the rest accrues to
  // the balance and isn't owed until closing, so it doesn't belong in a monthly cash need.
  if (pt==="monthly_rate_split") return Math.round((loan.principal||0)*(loan.splitMonthlyRate||0)/100/12);
  return 0;
};

const drawRemaining = loan => {
  if (!loan?.drawFacility) return 0;
  const drawn=(loan.drawFacility.draws||[]).reduce((s,d)=>s+(d.amount||0),0);
  return Math.max(0,(loan.drawFacility.committed||0)-drawn);
};

// What lender money actually gets allocated toward: cost to close, rehab, and the interest
// carry expected over the hold period. Holding costs (taxes, insurance, utilities) are a
// real expense but aren't sized against loan proceeds — they're covered out of pocket/cash
// flow — so those alone are left out.
const propNeeded = (prop, activeLoans) => {
  if (!prop?.purchasePrice&&!prop?.rehabBudget) return prop?.fundingNeeded||0;
  const months = effectiveMonths(prop);
  const monthlyInt = (activeLoans||[]).reduce((s,l)=>s+monthlyLoanPayment(l),0);
  return (prop.purchasePrice||0)+(prop.rehabBudget||0)+monthlyInt*months;
};

const fmtRate = (l) => {
  if (!l) return "";
  const pt = l.paymentType||"closing";
  if (l.interestType === "fixed") return "$" + Math.round(l.interestRate||0).toLocaleString() + " fixed";
  if (pt==="monthly_rate") return (l.interestRate||0) + "%/yr · monthly";
  if (pt==="monthly_fixed") return "$" + Math.round(l.monthlyPayment||0).toLocaleString() + "/mo";
  if (pt==="monthly_rate_split") {
    const closingRate = Math.max(0,(l.interestRate||0)-(l.splitMonthlyRate||0));
    return `${l.interestRate||0}%/yr · ${l.splitMonthlyRate||0}% mo + ${closingRate}% close`;
  }
  return (l.interestRate||0) + "%/yr";
};

// A "Fixed to Property" private loan is secured by a promissory note/mortgage against a
// specific property. It still nags for that paperwork until a link is on file — but only
// while the loan is active; a closed/rolled loan's paperwork is moot.
const needsPromissoryNote = loan => loan.loanType==="private" && loan.lockedToProperty && !loan.promissoryNoteUrl && !loan.endDate;

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

// Every popup form used to close instantly on a backdrop click or the header's ✕ — no
// warning, no matter how much had already been typed in. useDirty reports whether a form's
// state has actually changed since it first opened; confirmDiscard is the one place that
// decides whether to interrupt a close with a confirm; useDirtyGuard combines both for a
// form that renders its own <Modal> (most of them — everything reads through onClose so a
// stray outside tap or the ✕ gets the same guard as the form's own Cancel button).
const useDirty = getSnapshot => {
  const initial = useRef(JSON.stringify(getSnapshot()));
  return JSON.stringify(getSnapshot()) !== initial.current;
};
const confirmDiscard = (dirty, doClose) => {
  if (dirty && !window.confirm("Discard what you've entered?")) return;
  doClose();
};
const useDirtyGuard = (getSnapshot, onClose) => {
  const dirty = useDirty(getSnapshot);
  return () => confirmDiscard(dirty, onClose);
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
          className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 pr-10 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-teal-500 transition-all"/>
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 dark:text-zinc-600 pointer-events-none text-sm">
          {loading ? <span className="animate-spin inline-block">⟳</span> : "📍"}
        </div>
        {open && sugg.length>0 && (
          <div className="absolute z-50 mt-1 w-full bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-xl shadow-xl overflow-hidden">
            {sugg.map((s,i)=>(
              <button key={i} onMouseDown={e=>{e.preventDefault();pick(s.label);}}
                className={`w-full text-left px-4 py-3 text-sm border-b border-slate-50 dark:border-zinc-800 last:border-0 transition-colors ${i===activeIdx?"bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800"}`}>
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
// A "$" input that adds thousands commas live as you type (the decimal part is left
// exactly as typed — no padding), and snaps to a full comma + 2-decimal format
// (150,000.00) once you click away. Passes plain numeric strings to onChange — same
// contract as a plain number input, so callers don't need to change how they store,
// parse, or validate the value.
const moneyLiveFormat = raw => {
  if (raw==="") return "";
  const [intPart,...rest] = raw.split(".");
  const intFmt = intPart===""? "" : Number(intPart).toLocaleString("en-US");
  if (rest.length>0) return `${intFmt}.${rest.join("")}`;
  return raw.endsWith(".") ? intFmt+"." : intFmt;
};
const MoneyField = ({value,onChange,className,placeholder,autoFocus,onBlur}) => {
  const [focused,setFocused] = useState(false);
  const ref = useRef(null);
  const nextCursor = useRef(null);
  const n = parseFloat(value);
  const display = focused
    ? moneyLiveFormat(value ?? "")
    : (value===""||value==null||isNaN(n)
        ? ""
        : n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}));
  // A bare "100000" placeholder reads like a real typed value with no formatting — show it
  // as an actual dollar amount ($100,000) so it's clearly an example, not live data.
  const pn = parseFloat(placeholder);
  const displayPlaceholder = placeholder!=null && placeholder!=="" && !isNaN(pn)
    ? "$"+pn.toLocaleString()
    : placeholder;

  useLayoutEffect(()=>{
    if (nextCursor.current!=null && ref.current) {
      ref.current.setSelectionRange(nextCursor.current,nextCursor.current);
      nextCursor.current = null;
    }
  },[display]);

  return (
    <input ref={ref} type="text" inputMode="decimal" autoFocus={autoFocus}
      value={display}
      placeholder={displayPlaceholder}
      onFocus={()=>setFocused(true)}
      onBlur={()=>{setFocused(false);onBlur&&onBlur();}}
      onChange={e=>{
        const el=e.target;
        const cursorPos=el.selectionStart??el.value.length;
        // Count only digits/decimal-point characters before the cursor — commas are pure
        // formatting, so they don't count toward "how far into the number" the cursor is.
        const digitsBefore=(el.value.slice(0,cursorPos).match(/[0-9.]/g)||[]).length;

        let raw=el.value.replace(/[^0-9.]/g,"");
        const parts=raw.split(".");
        if(parts.length>2) raw=parts[0]+"."+parts.slice(1).join("");

        const formatted=moneyLiveFormat(raw);
        let count=0,pos=formatted.length;
        for(let i=0;i<formatted.length;i++){
          if(/[0-9.]/.test(formatted[i])) count++;
          if(count===digitsBefore){ pos=i+1; break; }
        }
        nextCursor.current=pos;
        onChange(raw);
      }}
      className={className}/>
  );
};

// A "%" input — plain numeric entry with a fixed "%" suffix shown inside the field, so it
// reads as a rate rather than a bare number. No live reformatting needed (rates are short),
// just digit/decimal sanitizing like the other numeric fields.
const PercentField = ({value,onChange,className,placeholder,autoFocus,onBlur}) => (
  <div className="relative">
    <input type="text" inputMode="decimal" autoFocus={autoFocus}
      value={value??""}
      placeholder={placeholder}
      onBlur={onBlur}
      onChange={e=>{
        let raw=e.target.value.replace(/[^0-9.]/g,"");
        const parts=raw.split(".");
        if(parts.length>2) raw=parts[0]+"."+parts.slice(1).join("");
        onChange(raw);
      }}
      className={className}/>
    <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-slate-400 dark:text-zinc-500">%</span>
  </div>
);

const Inp = ({label,type="text",value,onChange,placeholder,helpText,money,percent,autoFocus,onBlur}) => (
  <div className="mb-3">
    <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">{label}</label>
    {money ? (
      <MoneyField value={value} onChange={onChange} placeholder={placeholder} autoFocus={autoFocus} onBlur={onBlur}
        className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-teal-500 transition-all"/>
    ) : percent ? (
      <PercentField value={value} onChange={onChange} placeholder={placeholder} autoFocus={autoFocus} onBlur={onBlur}
        className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl pl-4 pr-9 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-teal-500 transition-all"/>
    ) : (
      <input type={type} value={value??""} onChange={e=>onChange(e.target.value)}
        onWheel={e=>e.target.blur()}
        placeholder={placeholder} autoFocus={autoFocus} onBlur={onBlur}
        className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-teal-500 transition-all"/>
    )}
    {helpText&&<p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-1.5">{helpText}</p>}
  </div>
);

const Sel = ({label,value,onChange,options,onBlur,autoFocus}) => (
  <div className="mb-3">
    <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">{label}</label>
    <select value={value??""} onChange={e=>onChange(e.target.value)} onBlur={onBlur} autoFocus={autoFocus}
      className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500 transition-all appearance-none">
      {options.map(([v,l])=><option key={v} value={v}>{l}</option>)}
    </select>
  </div>
);

const DateInp = ({label,value,onChange,helpText,autoFocus,onBlur}) => (
  <div className="mb-3">
    <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">{label}</label>
    <div className="relative">
      <input type="date" value={value??""} onChange={e=>onChange(e.target.value)} autoFocus={autoFocus} onBlur={onBlur}
        className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500 transition-all pr-10"/>
      {value && <button type="button" onClick={()=>onChange("")}
        className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-slate-100 dark:bg-zinc-700 hover:bg-red-100 dark:hover:bg-red-900/50 hover:text-red-500 text-slate-400 dark:text-zinc-400 flex items-center justify-center text-[10px] font-bold transition-colors">✕</button>}
    </div>
    {helpText&&<p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-1.5">{helpText}</p>}
  </div>
);

// A field that has to be explicitly confirmed (✓) before it locks — grayed out and
// unclickable until ✏️ reopens it. Guards against a stray tap or a scroll-triggered click
// silently overwriting a number that's often copied straight off a HUD or term sheet: once
// confirmed, nothing short of deliberately tapping Edit can change it again. Wraps a
// <fieldset> so it works around any input type (Inp, Sel, DateInp, MoneyField, a checkbox)
// without those components needing their own disabled-state plumbing.
const Lockable = ({ locked, onToggle, children }) => (
  <div className="mb-3">
    <fieldset disabled={locked} className={locked?"opacity-50":""}>{children}</fieldset>
    <div className="flex justify-end -mt-2">
      <button type="button" onClick={onToggle}
        className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${locked?"bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 hover:bg-slate-200 dark:hover:bg-zinc-700":"bg-emerald-500 hover:bg-emerald-600 text-white"}`}>
        {locked?"✏️ Edit":"✓ Confirm"}
      </button>
    </div>
  </div>
);
// Same protection as Lockable, but for a field sitting inline in a single-line row or a
// tight table cell — a small icon-only toggle right next to the field instead of a full
// labeled pill underneath, since there's no room for one there.
const LockableInline = ({ locked, onToggle, children, className="" }) => (
  <div className={`flex items-center gap-1 ${className}`}>
    <fieldset disabled={locked} className={`flex-1 min-w-0 ${locked?"opacity-50":""}`}>{children}</fieldset>
    <button type="button" onClick={onToggle}
      className={`shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-[10px] font-bold transition-colors ${locked?"bg-slate-200 dark:bg-zinc-700 text-slate-500 dark:text-zinc-400 hover:bg-slate-300 dark:hover:bg-zinc-600":"bg-emerald-500 hover:bg-emerald-600 text-white"}`}
      title={locked?"Edit":"Confirm"}>
      {locked?"✏️":"✓"}
    </button>
  </div>
);

// Drag wrapper for manual property sorting — reuses the whole element as the drag
// surface (tap still works normally via the PointerSensor's activation distance).
// `children` can be a node (whole item is the drag handle) or a render-prop
// `(handleProps) => node` so the caller can put the handle on just part of
// the item (e.g. a header bar) instead of the whole thing.
const SortableItem = ({id,disabled,as:Tag="div",className,children,...rest}) => {
  const {attributes,listeners,setNodeRef,transform,transition,isDragging}=useSortable({id,disabled});
  const isRenderProp = typeof children==="function";
  const handleProps = disabled ? {} : {...attributes,...listeners};
  return (
    <Tag ref={setNodeRef} className={className}
      style={{transform:CSS.Transform.toString(transform),transition,opacity:isDragging?0.5:1,zIndex:isDragging?10:undefined,cursor:(!isRenderProp&&!disabled)?"grab":undefined}}
      {...(isRenderProp?{}:handleProps)} {...rest}>
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

// Shown next to TypeBadge/TypeLabel for Fixed-to-Property private loans — a violet 🔒 chip
// once the promissory note/mortgage link is on file, or a red "needs note" flag (with a
// HoverTip explaining why) until it is.
const LockBadge = ({loan}) => {
  if(!loan||loan.loanType!=="private"||!loan.lockedToProperty) return null;
  if(needsPromissoryNote(loan)) return (
    <HoverTip tip="Fixed to this property, but no promissory note / mortgage link is on file yet">
      <span className="inline-flex items-center gap-1 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 rounded-full font-semibold text-[10px] px-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0"/>Needs Note
      </span>
    </HoverTip>
  );
  return (
    <span title="Fixed to Property — promissory note on file" className="inline-flex items-center gap-1 bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400 rounded-full font-semibold text-[10px] px-2 py-0.5">
      🔒 Fixed
    </span>
  );
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

// Hover-only tooltip, portal-rendered to <body> (like DropdownPortal above) so it escapes
// any `overflow-x-auto` ancestor — e.g. a scrollable table — instead of being clipped.
// `tip` can be a plain string or richer JSX (multi-line breakdowns, lists); pass `wide` for
// those so the box isn't forced to one line. Pass `interactive` when `tip` itself contains
// clickable content (e.g. links to another page) — this keeps pointer events enabled inside
// the tooltip and bridges hover with a short close-delay so the mouse can travel from the
// trigger into the tooltip without it disappearing first.
const HoverTip = ({children,tip,wide,interactive}) => {
  const ref = useRef(null);
  const [rect, setRect] = useState(null);
  const hideTimer = useRef(null);
  const show = () => { clearTimeout(hideTimer.current); setRect(ref.current.getBoundingClientRect()); };
  const hide = () => {
    if (!interactive) { setRect(null); return; }
    hideTimer.current = setTimeout(()=>setRect(null), 150);
  };
  return (
    <span ref={ref} className="inline-block max-w-full" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {rect && createPortal(
        <div className={`fixed z-[100] ${interactive?"":"pointer-events-none"}`}
          style={{left:rect.left+rect.width/2,top:rect.top-6,transform:"translate(-50%,-100%)"}}
          onMouseEnter={interactive?show:undefined} onMouseLeave={interactive?hide:undefined}>
          <div className={`px-2.5 py-1.5 bg-zinc-900 dark:bg-zinc-700 text-white text-[11px] rounded-lg shadow-lg ${wide?"whitespace-normal min-w-[160px] text-left":"whitespace-nowrap"}`}>
            {tip}
          </div>
        </div>,
        document.body
      )}
    </span>
  );
};

function Modal({title,onClose,children}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-md" onClick={onClose}>
      <div className="bg-white/95 dark:bg-[#1C1F2B]/95 backdrop-blur-2xl rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.25)] w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="flex justify-between items-center px-6 py-4 border-b border-black/[0.06] dark:border-white/[0.06] sticky top-0 bg-white/95 dark:bg-[#1C1F2B]/95 backdrop-blur-2xl rounded-t-2xl z-10">
          <h2 className="font-semibold text-slate-900 dark:text-zinc-100 text-base tracking-[-0.2px]">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-slate-500 dark:text-zinc-400 hover:bg-black/10 dark:hover:bg-white/15 transition-all text-xl leading-none">&times;</button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// A dropdown panel anchored to a button, rendered via portal straight onto document.body so
// it isn't clipped by an ancestor's overflow — a plain `absolute` panel inside a scrollable
// Modal gets cut off the moment the anchor button scrolls near the modal's own bottom edge,
// since the modal's overflow-y-auto clips anything that visually extends past it regardless
// of the panel's own position. Flips to open upward when there isn't room below.
function DropdownPortal({ anchorRef, open, onClose, children }) {
  const [rect, setRect] = useState(null);
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) { setRect(null); return; }
    const measure = () => setRect(anchorRef.current.getBoundingClientRect());
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [open]);
  if (!open || !rect) return null;
  const gap = 4;
  const spaceBelow = window.innerHeight - rect.bottom - gap;
  const spaceAbove = rect.top - gap;
  const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;
  const style = {
    position: "fixed",
    left: rect.left,
    width: rect.width,
    maxHeight: Math.max(120, (openUp ? spaceAbove : spaceBelow) - 8),
    ...(openUp ? {bottom: window.innerHeight - rect.top + gap} : {top: rect.bottom + gap}),
  };
  return createPortal(
    <>
      <div className="fixed inset-0 z-[100]" onClick={onClose}/>
      <div style={style} className="z-[101] overflow-y-auto bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-slate-200 dark:border-zinc-700">
        {children}
      </div>
    </>,
    document.body
  );
}

const Btn = ({onClick,children,color="blue",full,sm,disabled}) => {
  const cls={
    blue:  "bg-teal-600 hover:bg-teal-700 active:bg-teal-800 text-white shadow-sm shadow-teal-200 dark:shadow-none",
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
        placeholder="John Doe"
        className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-teal-500 transition-all"/>
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
function LenderMoneyForm({ properties, lenders = [], unassigned = [], init, onSave, onMerge, onClose, lockDestinationTo, onDirtyChange }) {
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
    paymentType:"closing", monthlyPayment:"", drawFacility:null, splitMonthlyRate:"",
    lockedToProperty:false, promissoryNoteUrl:"",
    ...(init??{}),
    paymentType: init?.paymentType || (init?.loanType==="hard" ? "monthly_rate" : "closing"),
    monthlyPayment: String(init?.monthlyPayment||""),
    splitMonthlyRate: String(init?.splitMonthlyRate??""),
    drawFacility: init?.drawFacility||null,
  }));
  const [drawDate,setDrawDate]=useState(TODAY);
  const [drawAmt,setDrawAmt]=useState("");
  // This form doesn't own its <Modal> everywhere it's used — most callers wrap it — so it
  // can't guard its own backdrop/✕ click. Report dirtiness up when a caller wants it; a
  // no-op (e.g. embedded inline inside PropertyForm, where there's no Modal to guard) if not.
  const isDirty=useDirty(()=>({lenderSel,newName,newType,f}));
  useEffect(()=>{onDirtyChange?.(isDirty);},[isDirty]);
  // Split payment type: the monthly-paid portion can be entered either as a rate (%) or as
  // a flat dollar amount — whichever's easier, since a lender usually quotes one or the
  // other. Either way, splitMonthlyRate (%) is the one canonical value that actually gets
  // saved; a dollar entry is just converted to its rate equivalent as it's typed.
  const [splitEntryMode,setSplitEntryMode]=useState("rate");
  const [splitMonthlyAmt,setSplitMonthlyAmt]=useState("");
  // Keep the rate in sync with the typed dollar amount whenever EITHER changes — not just
  // at the moment the dollar box is typed into — so going back and editing the principal
  // afterward doesn't leave a stale rate behind.
  useEffect(()=>{
    if(splitEntryMode!=="dollar") return;
    const principal=parseFloat(f.principal)||0;
    const amt=parseFloat(splitMonthlyAmt)||0;
    sf(p=>({...p,splitMonthlyRate:principal>0?String(Math.round(amt*12/principal*100*10000)/10000):"0"}));
  },[splitEntryMode,splitMonthlyAmt,f.principal]);
  const [blockMsg,setBlockMsg]=useState("");
  const [destPickerOpen,setDestPickerOpen]=useState(false);
  const [destSearch,setDestSearch]=useState("");
  const destBtnRef=useRef(null);
  const matchesDestSearch=p=>!destSearch||p.address?.toLowerCase().includes(destSearch.toLowerCase());
  const closeDestPicker=()=>{setDestPickerOpen(false);setDestSearch("");};
  // Shown expanded (not collapsed to a summary row) for a brand-new loan, so a first-time
  // user actually sees there's a choice to make instead of it hiding behind a silent
  // default — collapses back to a compact summary once a loan already has one set.
  const [editingPaymentType,setEditingPaymentType]=useState(()=>!init?.paymentType);
  const [editingEndDate,setEditingEndDate]=useState(false);
  const [editingDueDate,setEditingDueDate]=useState(false);
  const paymentTypeLabel = {closing:"Pay at Closing", monthly_rate:"Monthly Interest-Only", monthly_fixed:"Monthly Fixed Amount", monthly_rate_split:"Partial Monthly + Rest at Closing"};
  const s = k => v => sf(p=>({...p,[k]:v}));
  // Fields that already had a real value when this form opened start locked (protecting an
  // already-correct number that's often copied off a term sheet); a brand-new, empty entry
  // starts open since there's nothing yet to protect.
  const [locked,setLocked]=useState(()=>({
    lender:!!initName,
    startDate:!!init?.startDate,
    principal:!!init?.principal,
    interestType:init?.interestRate!=null,
    interestRate:init?.interestRate!=null,
    monthlyPayment:!!init?.monthlyPayment,
    splitMonthlyRate:init?.splitMonthlyRate!=null,
    drawCommitted:!!init?.drawFacility?.committed,
  }));
  const toggleLock=k=>setLocked(l=>({...l,[k]:!l[k]}));

  // Default "How Is Interest Paid?" by loan type — hard money to monthly interest-only,
  // private money to paid-at-closing — and keep it in sync as the user picks a lender or
  // switches the new-lender type, unless they've manually overridden it themselves. Only
  // applies to a fresh entry (init already carrying a paymentType means we're editing one
  // that was set deliberately, so it's left alone).
  const [paymentTypeTouched,setPaymentTypeTouched]=useState(!!init?.paymentType);
  useEffect(()=>{
    if (paymentTypeTouched) return;
    sf(p=>({...p,paymentType:currentLoanType==="hard"?"monthly_rate":"closing"}));
  },[currentLoanType]);

  const isFixed = (f.interestType || "percentage") === "fixed";
  const addDraw = () => {
    const amount = parseFloat(drawAmt);
    if (!amount||!drawDate) return;
    sf(p=>({...p,drawFacility:{...p.drawFacility,draws:[...(p.drawFacility?.draws||[]),{id:uid(),date:drawDate,amount}]}}));
    setDrawAmt("");
  };
  // Every lockable field has to actually be confirmed (✓), not just filled in, before this
  // can save — conditional ones (monthly payment, draw commitment) only count when they're
  // actually shown.
  const requiredLockKeys = ["lender","startDate","principal","interestType","interestRate",
    ...(f.paymentType==="monthly_fixed"?["monthlyPayment"]:[]),
    ...(f.paymentType==="monthly_rate_split"?["splitMonthlyRate"]:[]),
    ...(f.drawFacility?["drawCommitted"]:[])];
  const allConfirmed = requiredLockKeys.every(k=>locked[k]);
  const handleSave = () => {
    const lenderName = activeLender ? activeLender.name : (lenderSel === "_new_" ? newName.trim() : "");
    if (!lenderName) { alert("Please select or enter a lender."); return; }
    if (!(parseFloat(f.principal) > 0)) { alert("Please enter an amount greater than zero."); return; }
    if (!f.startDate) { alert("Please enter a start date."); return; }
    if (!allConfirmed) { alert("Tap ✓ Confirm on every field before this can be saved."); return; }
    const destProp = f.destination && f.destination!=="unassigned"
      ? activeProps.find(x=>x.id===f.destination) : null;
    if (destProp) {
      const c = propConflict(f.startDate, parseFloat(f.principal)||0, destProp);
      if (c) {
        setBlockMsg(c==='date'
          ? "Cannot place here — this property was acquired after this loan started, so for that stretch of time the loan wouldn't have had this property backing it up."
          : "Cannot place here — not enough funding gap on this property (including 10% contingency). Consider splitting this loan or choosing a property with a larger funding need.");
        if (!lockDestinationTo) sf(p=>({...p,destination:"unassigned"}));
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
    if (!window.confirm(`Merge this ${$$p(parseFloat(f.principal)||0)} fund with the ${$$p(candidate.principal)} fund started ${candidate.startDate}? This can't be undone.`)) return;
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
    if (c==='date') { setBlockMsg("Cannot place here — this property was acquired after this loan started, so for that stretch of time the loan wouldn't have had this property backing it up."); return; }
    if (c==='size') { setBlockMsg("Cannot place here — not enough funding gap on this property (including 10% contingency). Consider splitting this loan or choosing a property with a larger funding need."); return; }
    setBlockMsg("");
    s("destination")(pid);
  };

  return (
    <div>
      {/* Lender */}
      <Lockable locked={locked.lender} onToggle={()=>toggleLock("lender")}>
        <div className="mb-3">
          <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">
            Lender <span className="text-red-400">*</span>
          </label>
          <select value={lenderSel} onChange={e=>setLenderSel(e.target.value)}
            className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500 transition-all appearance-none">
            <option value="">— Select a lender —</option>
            <option value="_new_">➕ Add New Lender</option>
            {[...lenders].sort((a,b)=>a.name.localeCompare(b.name)).map(l=>(
              <option key={l.id} value={l.id}>{l.name} ({l.loanType==="hard"?"Hard Money":"Private Money"})</option>
            ))}
          </select>
        </div>
        {lenderSel==="_new_"&&(
          <div className="mb-3 p-3.5 rounded-xl bg-teal-50/50 dark:bg-teal-950/20 border border-teal-100 dark:border-teal-900/40 space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-widest text-teal-500 dark:text-teal-400 mb-2">New Lender Info</div>
            <Inp label="Lender Name *" value={newName} onChange={setNewName} placeholder="John Doe"/>
            <Sel label="Lender Type *" value={newType} onChange={setNewType} options={[
              ["private","Private Money — individual lender"],
              ["hard","Hard Money — institutional / company lender"],
            ]}/>
          </div>
        )}
      </Lockable>
      {activeLender&&(
        <div className="mb-3 flex items-center gap-2 px-1">
          <TypeBadge type={activeLender.loanType}/>
          <span className="text-xs text-slate-400 dark:text-zinc-500">
            {activeLender.loanType==="hard"?"Hard Money Lender":"Private Money Lender"}
          </span>
        </div>
      )}

      {/* Loan details */}
      <div className="border-t border-slate-100 dark:border-zinc-800 pt-3 mt-1">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Lockable locked={locked.startDate} onToggle={()=>toggleLock("startDate")}>
            <DateInp label="Start Date *" value={f.startDate} onChange={v=>{setAndRevalidate("startDate")(v);setBlockMsg("");}}/>
          </Lockable>
          <Lockable locked={locked.principal} onToggle={()=>toggleLock("principal")}>
            <Inp label="Amount ($) *" money value={f.principal} onChange={v=>{setAndRevalidate("principal")(v);setBlockMsg("");}} placeholder="100000"/>
          </Lockable>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Lockable locked={locked.interestType} onToggle={()=>toggleLock("interestType")}>
            <Sel label="Interest Type *" value={f.interestType||"percentage"} onChange={s("interestType")} options={
              // Split only makes sense as a % rate (it's dividing a rate into a monthly
              // portion and a closing portion) — Fixed $ isn't offered while it's selected.
              f.paymentType==="monthly_rate_split" ? [["percentage","% Rate"]] : [
                ["percentage","% Rate"],
                ["fixed","Fixed Amount"],
              ]}/>
          </Lockable>
          <Lockable locked={locked.interestRate} onToggle={()=>toggleLock("interestRate")}>
            {isFixed
              ? <Inp label="Fixed Interest ($) *" money value={f.interestRate} onChange={s("interestRate")} placeholder="5000"/>
              : <Inp label="Annual Rate (%) *" percent value={f.interestRate} onChange={s("interestRate")} placeholder="10"/>
            }
          </Lockable>
        </div>
        {isFixed&&<p className="text-[11px] text-slate-400 dark:text-zinc-500 -mt-2 mb-3">Total interest they receive — e.g. lend $100k, get back $105k → enter 5000.</p>}

        {/* Due date — optional, almost always left blank, so it gets the same muted
            "default" treatment as How Interest Is Paid below instead of a full field. */}
        {editingDueDate ? (
          <DateInp label="Due Date (optional)" value={f.dueDate} onChange={s("dueDate")} autoFocus onBlur={()=>setEditingDueDate(false)} helpText="Only if this loan has a fixed maturity — leave blank if it's just paid off whenever the property sells."/>
        ) : (
          <button type="button" onClick={()=>setEditingDueDate(true)}
            className="w-full flex items-center justify-between px-3 py-1.5 mb-2 rounded-lg text-xs text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/60 transition-colors">
            <span>Due Date{!f.dueDate?" (default)":""}</span>
            <span className="font-medium">{f.dueDate||"None"}</span>
          </button>
        )}

        {/* How interest is paid — auto-set by lender type (hard → monthly, private →
            closing), so it reads as a default rather than an active choice until you
            actually tap in and change it. */}
        {editingPaymentType ? (
          <Sel label="How Is Interest Paid? *" value={f.paymentType||"closing"} autoFocus
            onChange={v=>{
              setPaymentTypeTouched(true);
              // Split only makes sense as a % rate — drop back to percentage if Fixed $
              // was selected, rather than leaving an impossible combination in place.
              if(v==="monthly_rate_split"&&f.interestType==="fixed") sf(p=>({...p,paymentType:v,interestType:"percentage"}));
              else s("paymentType")(v);
            }}
            onBlur={()=>setEditingPaymentType(false)} options={[
            ["closing",       "Pay at Closing — all interest owed when deal closes"],
            ["monthly_rate",  "Monthly Interest-Only — pay rate monthly, principal at closing"],
            ["monthly_fixed", "Monthly Fixed Amount — set dollar amount each month"],
            ["monthly_rate_split", "Partial Monthly + Rest at Closing"],
          ]}/>
        ) : (
          <button type="button" onClick={()=>setEditingPaymentType(true)}
            className="w-full flex items-center justify-between px-3 py-1.5 mb-2 rounded-lg text-xs text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/60 transition-colors">
            <span>How Interest Is Paid{!paymentTypeTouched?" (default)":""}</span>
            <span className="font-medium">{paymentTypeLabel[f.paymentType||"closing"]}</span>
          </button>
        )}
        {f.paymentType==="monthly_fixed"&&(
          <Lockable locked={locked.monthlyPayment} onToggle={()=>toggleLock("monthlyPayment")}>
            <Inp label="Monthly Payment Amount ($) *" money value={f.monthlyPayment} onChange={s("monthlyPayment")} placeholder="500" helpText="Fixed dollar amount lender receives each month"/>
          </Lockable>
        )}
        {f.paymentType==="monthly_rate_split"&&(()=>{
          const total=parseFloat(f.interestRate)||0;
          const principal=parseFloat(f.principal)||0;
          const monthlyRate=parseFloat(f.splitMonthlyRate)||0;
          const monthlyDollar=principal>0?Math.round(principal*monthlyRate/100/12*100)/100:0;
          const closingRate=Math.max(0,total-monthlyRate);
          const closingDollar=principal>0?Math.round(principal*closingRate/100/12*100)/100:0;
          const switchTo=mode=>{
            if(mode==="dollar"&&splitEntryMode!=="dollar") setSplitMonthlyAmt(principal>0?String(monthlyDollar):"");
            setSplitEntryMode(mode);
          };
          return (
            <Lockable locked={locked.splitMonthlyRate} onToggle={()=>toggleLock("splitMonthlyRate")}>
              <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Monthly-Paid Portion *</label>
              <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-lg p-0.5 mb-2 w-fit">
                <button type="button" onClick={()=>switchTo("rate")}
                  className={`px-3 py-1 rounded-md text-[11px] font-semibold transition-all ${splitEntryMode==="rate"?"bg-white dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400"}`}>By Rate (%)</button>
                <button type="button" onClick={()=>switchTo("dollar")}
                  className={`px-3 py-1 rounded-md text-[11px] font-semibold transition-all ${splitEntryMode==="dollar"?"bg-white dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400"}`}>By Dollar Amount ($)</button>
              </div>
              {splitEntryMode==="rate" ? (
                <>
                  <Inp percent value={f.splitMonthlyRate} onChange={s("splitMonthlyRate")} placeholder="7"/>
                  <p className="text-[11px] text-slate-400 dark:text-zinc-500 -mt-2 mb-3">
                    {principal>0?`= ${$$p(monthlyDollar)}/mo`:"Enter the principal above to see the dollar equivalent"}
                  </p>
                </>
              ) : (
                <>
                  <Inp money value={splitMonthlyAmt} onChange={setSplitMonthlyAmt} placeholder="583"/>
                  <p className="text-[11px] text-slate-400 dark:text-zinc-500 -mt-2 mb-3">
                    {principal>0?`= ${monthlyRate.toFixed(3).replace(/\.?0+$/,"")}% of the ${total||"—"}% total`:"Enter the principal above first"}
                  </p>
                </>
              )}
              {monthlyRate>total&&total>0?(
                <p className="text-[11px] text-red-500 dark:text-red-400 -mt-1">
                  That's more than the {total}% total — double-check the total rate above, or this loan will show nothing accruing to closing.
                </p>
              ):(
                <p className="text-[11px] text-slate-400 dark:text-zinc-500 -mt-1">
                  Rest of the {total||"—"}% total — {closingRate.toFixed(3).replace(/\.?0+$/,"")}%{principal>0?` (≈ ${$$p(closingDollar)}/mo if it were paid monthly)`:""} — accrues instead and is paid at closing
                </p>
              )}
            </Lockable>
          );
        })()}
      </div>
      {currentLoanType==="hard"&&(
        <div className="mt-2 mb-1 p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800">
          <label className="flex items-center gap-3 cursor-pointer mb-1">
            <input type="checkbox" checked={!!f.drawFacility}
              onChange={e=>sf(p=>({...p,drawFacility:e.target.checked?{committed:"",draws:[]}:null}))}
              className="w-4 h-4 rounded border-slate-300 dark:border-zinc-600 accent-teal-600 cursor-pointer"/>
            <div>
              <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Rehab Draw Facility</div>
              <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">Lender committed rehab funding, drawn in stages</div>
            </div>
          </label>
          {f.drawFacility&&(
            <div className="mt-3 space-y-3">
              <Lockable locked={locked.drawCommitted} onToggle={()=>toggleLock("drawCommitted")}>
                <Inp label="Total Committed ($)" money value={String(f.drawFacility.committed||"")}
                  onChange={v=>sf(p=>({...p,drawFacility:{...p.drawFacility,committed:v}}))} placeholder="100000"/>
              </Lockable>
              {(f.drawFacility.draws||[]).length>0&&(
                <div>
                  <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Draws Taken</div>
                  {f.drawFacility.draws.map(d=>(
                    <div key={d.id} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-200 dark:border-zinc-700 last:border-0">
                      <span className="text-slate-600 dark:text-zinc-300 tabular-nums">{d.date} · {$$p(d.amount)}</span>
                      <button type="button" onClick={()=>sf(p=>({...p,drawFacility:{...p.drawFacility,draws:p.drawFacility.draws.filter(x=>x.id!==d.id)}}))}
                        className="text-red-400 hover:text-red-600 text-xs p-1 transition-colors">✕</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="pt-1 border-t border-slate-200 dark:border-zinc-700">
                <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Add Draw</div>
                <DateInp label="Draw Date" value={drawDate} onChange={setDrawDate}/>
                <Inp label="Amount ($)" money value={drawAmt} onChange={setDrawAmt} placeholder="25000"/>
                <Btn onClick={addDraw} sm color="navy" full>+ Record Draw</Btn>
              </div>
            </div>
          )}
        </div>
      )}
      {currentLoanType==="private"&&(
        <div className="mt-2 mb-1 p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800">
          <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200 mb-1">Private Loan Type</div>
          <div className="flex bg-white dark:bg-zinc-900 rounded-lg p-0.5 mb-2 border border-slate-200 dark:border-zinc-700 w-fit">
            <button type="button" onClick={()=>sf(p=>({...p,lockedToProperty:false}))}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${!f.lockedToProperty?"bg-slate-100 dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400"}`}>Regular</button>
            <button type="button" onClick={()=>sf(p=>({...p,lockedToProperty:true}))}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${f.lockedToProperty?"bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 shadow-sm":"text-slate-500 dark:text-zinc-400"}`}>Fixed to Property</button>
          </div>
          <div className="text-[11px] text-slate-400 dark:text-zinc-500">
            {f.lockedToProperty
              ? "Secured by a promissory note / mortgage against the specific property — can still be moved, but moving requires confirming the paperwork was updated first."
              : "Can be freely placed, split, or moved between properties, same as today."}
          </div>
          {f.lockedToProperty&&(
            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-zinc-700">
              <Inp label="Promissory Note / Mortgage Link" value={f.promissoryNoteUrl||""} onChange={s("promissoryNoteUrl")}
                placeholder="https://drive.google.com/…"
                helpText="Link to wherever the signed note/mortgage is kept. Can add this later — until it's here, this loan shows a needs-attention flag."/>
            </div>
          )}
        </div>
      )}

      {mergeCandidates.length>0&&(
        <div className="mb-3 p-3.5 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
          <div className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-1">🔗 Possible Duplicate{mergeCandidates.length>1?"s":""} Found</div>
          <div className="text-[11px] text-amber-700/80 dark:text-amber-400/80 mb-2">Same lender, start date, and rate — sitting unassigned. Merge into one loan?</div>
          <div className="space-y-1.5">
            {mergeCandidates.map(c=>(
              <div key={c.id} className="flex items-center justify-between gap-2 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2">
                <span className="text-xs text-slate-700 dark:text-zinc-200 tabular-nums">{$$p(c.principal)} · started {c.startDate}</span>
                <button type="button" onClick={()=>handleMerge(c)}
                  className="text-[11px] font-bold text-amber-700 dark:text-amber-300 hover:underline shrink-0">Merge →</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Where does this money go? — collapsed picker, same style as the split-loan picker.
          Locked (no picker at all) when this form is opened from inside a specific
          property's own flow — adding a loan there obviously means that property, so there's
          nothing to choose and no "Unassigned"/other-property option to confuse it with. */}
      {lockDestinationTo ? (
        <div className="mt-3 mb-1">
          <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-2">This Loan Goes On</label>
          {blockMsg&&<div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 mb-2">{blockMsg}</div>}
          <div className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-sm text-slate-700 dark:text-zinc-200 truncate">
            🏠 {lockDestinationTo.label}
          </div>
        </div>
      ) : (
      <div className="mt-3 mb-1 relative">
        <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-2">
          Where Does This Money Go?
        </label>
        {blockMsg&&<div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 mb-2">{blockMsg}</div>}
        <button ref={destBtnRef} type="button" onClick={()=>setDestPickerOpen(o=>!o)}
          className="relative w-full text-left px-4 py-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm flex items-center justify-between gap-2 text-slate-800 dark:text-zinc-100 hover:border-teal-400 dark:hover:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500 transition-all">
          <span className="truncate">
            {f.destination==="unassigned"
              ? "💼 Unassigned — not yet placed on a property"
              : (()=>{const p=activeProps.find(x=>x.id===f.destination);return p?`🏠 ${p.address}`:"— Select property —";})()}
          </span>
          <span className="shrink-0 text-slate-400 dark:text-zinc-500">▾</span>
        </button>
        <DropdownPortal anchorRef={destBtnRef} open={destPickerOpen} onClose={()=>{setDestPickerOpen(false);setDestSearch("");}}>
            {activeProps.length>0&&(
              <div className="sticky top-0 bg-white dark:bg-zinc-800 border-b border-slate-100 dark:border-zinc-700 p-1.5">
                <input type="text" value={destSearch} onChange={e=>setDestSearch(e.target.value)} placeholder="Search properties…" autoFocus
                  className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-teal-500"/>
              </div>
            )}
            {!destSearch&&(
              <button type="button" onClick={()=>{setBlockMsg("");s("destination")("unassigned");closeDestPicker();}}
                className="w-full text-left px-3 py-2.5 text-xs font-medium text-slate-800 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 border-b border-slate-100 dark:border-zinc-700 transition-colors">
                💼 Unassigned — not yet placed on a property
              </button>
            )}
            {canShowConflicts ? (
              <>
                {available.filter(matchesDestSearch).map(p=>(
                  <button key={p.id} type="button" onClick={()=>{handleDestClick(p.id);closeDestPicker();}}
                    className="w-full text-left px-3 py-2.5 text-xs font-medium text-slate-800 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors flex items-center justify-between gap-2">
                    <span className="truncate">🏠 {p.address}</span>
                    <span className="text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$p(propGap(p))} avail</span>
                  </button>
                ))}
                {blockedSize.filter(matchesDestSearch).map(p=>(
                  <button key={p.id} type="button" disabled
                    className="w-full text-left px-3 py-2.5 text-xs font-medium opacity-40 cursor-not-allowed pointer-events-none text-slate-500 dark:text-zinc-500 flex items-center justify-between gap-2">
                    <span className="truncate">📐 {p.address} — no funding gap</span>
                    <span className="shrink-0 tabular-nums">{$$p(propGap(p))} avail</span>
                  </button>
                ))}
                {blockedDate.filter(matchesDestSearch).map(p=>(
                  <button key={p.id} type="button" disabled
                    className="w-full text-left px-3 py-2.5 text-xs font-medium opacity-40 cursor-not-allowed pointer-events-none text-slate-500 dark:text-zinc-500 flex items-center justify-between gap-2">
                    <span className="truncate">🕐 {p.address} — timing conflict</span>
                    <span className="shrink-0 tabular-nums">{$$p(propGap(p))} avail</span>
                  </button>
                ))}
                {[...available,...blockedSize,...blockedDate].filter(matchesDestSearch).length===0&&(
                  <div className="px-3 py-2.5 text-xs text-slate-400 dark:text-zinc-500 italic">{destSearch?"No matches":"No active properties. Add one first."}</div>
                )}
              </>
            ) : activeProps.filter(matchesDestSearch).length>0 ? (
              [...activeProps].filter(matchesDestSearch).sort((a,b)=>propGap(b)-propGap(a)).map(p=>(
                <button key={p.id} type="button" onClick={()=>{handleDestClick(p.id);closeDestPicker();}}
                  className="w-full text-left px-3 py-2.5 text-xs font-medium text-slate-800 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors flex items-center justify-between gap-2">
                  <span className="truncate">🏠 {p.address}</span>
                  <span className="text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$p(propGap(p))} avail</span>
                </button>
              ))
            ) : (
              <div className="px-3 py-2.5 text-xs text-slate-400 dark:text-zinc-500 italic">{destSearch?"No matches":"No active properties. Add one first."}</div>
            )}
        </DropdownPortal>
        {!canShowConflicts&&activeProps.length>0&&(
          <div className="text-[11px] text-slate-400 dark:text-zinc-500 italic px-1 mt-1.5">Enter amount and start date above to see property availability.</div>
        )}
      </div>
      )}

      {/* End date + notes — kept at the very bottom since a loan is normally left active */}
      <div className="border-t border-slate-100 dark:border-zinc-800 pt-3 mt-3">
        {editingEndDate ? (
          <DateInp label="End / Payoff Date" value={f.endDate} onChange={s("endDate")} autoFocus onBlur={()=>setEditingEndDate(false)} helpText="Leave blank while the loan is active"/>
        ) : (
          <button type="button" onClick={()=>setEditingEndDate(true)}
            className="w-full flex items-center justify-between px-3 py-1.5 mb-2 rounded-lg text-xs text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/60 transition-colors">
            <span>End / Payoff Date</span>
            <span className="font-medium">{f.endDate||"Active (no end date)"}</span>
          </button>
        )}
        <Inp label="Notes (optional)" value={f.specialTerms} onChange={s("specialTerms")} placeholder="Balloon, prepayment penalty, etc."/>
      </div>

      {!allConfirmed&&<p className="text-[11px] text-red-500 dark:text-red-400 -mt-2 mb-2">Tap ✓ Confirm on every field above before this can be saved.</p>}
      <div className="flex gap-2 pt-1">
        <Btn onClick={handleSave} color={f.destination==="unassigned"?"purple":"green"} disabled={!allConfirmed} full>
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
    if (c==='date') { setBlockMsg("Cannot place here — this property was acquired after this loan started, so for that stretch of time the loan wouldn't have had this property backing it up. Please pick a property that started before this loan."); return; }
    if (c==='size') { setBlockMsg("Cannot place here — not enough funding gap on this property (including 10% contingency). Consider splitting this loan or choosing a property with a larger funding need."); return; }
    onPlace(p.id);
  };

  return (
    <Modal title={`Place ${fund.lenderName}'s Money`} onClose={onClose}>
      <div className="mb-4 p-4 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-100 dark:border-zinc-700">
        <div className="font-bold text-slate-900 dark:text-zinc-100">{fund.lenderName}</div>
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$p(loanAmt)} · {fmtRate(fund)} · <TypeLabel type={fund.loanType}/></div>
      </div>
      {blockMsg&&<div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 mb-3">{blockMsg}</div>}
      <div className="space-y-4">
        {available.length>0&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">Available</div>
            <div className="space-y-1.5">
              {available.map(p=>(
                <button key={p.id} onClick={()=>{setBlockMsg('');handleClick(p);}}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-teal-50 dark:hover:bg-teal-900/20 border border-slate-200 dark:border-zinc-700 hover:border-teal-300 dark:hover:border-teal-700 transition-all">
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
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$p(amount)} · on <span className="font-medium">{currentLoc}</span></div>
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
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$p(amount)} · on <span className="font-medium">{currentLoc}</span></div>
      </div>
      {blockMsg&&<div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 mb-3">{blockMsg}</div>}
      <div className="space-y-4">
        {showUnassigned&&(
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">Remove from Property</div>
            <button onClick={()=>handleClick('unassigned')}
              className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-teal-50 dark:hover:bg-teal-900/20 border border-slate-200 dark:border-zinc-700 hover:border-teal-300 dark:hover:border-teal-700 transition-all">
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
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-teal-50 dark:hover:bg-teal-900/20 border border-slate-200 dark:border-zinc-700 hover:border-teal-300 dark:hover:border-teal-700 transition-all">
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
  // Same ordering as the Draws tab's default "Highest Chance" sort: longest since the last
  // draw or purchase (whichever is more recent) floats to the top, so the facility that's
  // most likely due for a draw is pre-selected without having to switch pages to check.
  const drawLoans = (data.properties||[]).filter(p=>!p.dateSold).flatMap(prop=>
    (prop.loans||[]).filter(l=>!l.endDate&&l.drawFacility).map(l=>{
      const drawDates=(l.drawFacility.draws||[]).map(d=>d.date).filter(Boolean).sort();
      const lastDrawDate=drawDates.length?drawDates[drawDates.length-1]:null;
      const lastEventDate=[lastDrawDate,prop.purchaseDate].filter(Boolean).sort().pop()??null;
      const daysSinceEvent=lastEventDate?daysBetween(lastEventDate,TODAY):null;
      const eligible=!lastEventDate||daysSinceEvent>=14;
      return {
        ...l, propId:prop.id, propAddress:prop.address, remaining:drawRemaining(l),
        lastDrawDate, lastEventDate, daysSinceEvent, eligible,
      };
    })
  ).sort((a,b)=>{
    const ea=a.daysSinceEvent??99999, eb=b.daysSinceEvent??99999;
    if(a.eligible!==b.eligible) return a.eligible?-1:1;
    return eb-ea;
  });
  const [selId,setSelId]=useState(drawLoans[0]?.id??'');
  const [date,setDate]=useState(TODAY);
  const [amount,setAmount]=useState('');
  const [locked,setLocked]=useState({});
  const toggleLock=k=>setLocked(l=>({...l,[k]:!l[k]}));

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
            className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500">
            {drawLoans.map(l=>(
              <option key={l.id} value={l.id}>
                {l.propAddress} — {l.lenderName} ({$$p(l.remaining)} avail
                {l.daysSinceEvent!=null?`, ${l.daysSinceEvent}d since ${l.lastDrawDate&&l.lastDrawDate===l.lastEventDate?"last draw":"purchase"}`:""})
              </option>
            ))}
          </select>
        </div>

        {sel&&(
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-slate-50 dark:bg-zinc-800 p-3 text-center">
              <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold mb-1">Committed</div>
              <div className="text-sm font-bold text-slate-800 dark:text-zinc-100 tabular-nums">{$$p(totalCommitted)}</div>
            </div>
            <div className="rounded-xl bg-slate-50 dark:bg-zinc-800 p-3 text-center">
              <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold mb-1">Drawn</div>
              <div className="text-sm font-bold text-amber-600 dark:text-amber-400 tabular-nums">{$$p(totalDrawn)}</div>
            </div>
            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-900/20 p-3 text-center">
              <div className="text-[10px] text-emerald-600 dark:text-emerald-400 uppercase font-semibold mb-1">Available</div>
              <div className="text-sm font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">{$$p(maxDraw)}</div>
            </div>
            <div className="rounded-xl bg-slate-50 dark:bg-zinc-800 p-3 text-center">
              <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold mb-1">Days Since</div>
              <div className="text-sm font-bold text-slate-800 dark:text-zinc-100 tabular-nums">
                {sel.daysSinceEvent!=null?`${sel.daysSinceEvent}d`:"—"}
              </div>
            </div>
          </div>
        )}

        <Lockable locked={locked.date} onToggle={()=>toggleLock("date")}>
          <DateInp label="Draw Date" value={date} onChange={setDate}/>
        </Lockable>
        <Lockable locked={locked.amount} onToggle={()=>toggleLock("amount")}>
          <Inp label="Draw Amount" money value={amount} onChange={setAmount} placeholder="0"/>
        </Lockable>

        {amt>maxDraw&&maxDraw>0&&(
          <p className="text-xs text-red-500 dark:text-red-400">Amount exceeds available balance of {$$p(maxDraw)}</p>
        )}

        <div className="flex gap-2 pt-1">
          <Btn onClick={()=>valid&&onSave({propId:sel.propId,loanId:sel.id,date,amount:amt})} color={valid?"green":"ghost"} full>Record Draw →</Btn>
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
  const [placeSearch, setPlaceSearch] = useState("");
  const [rowSearch, setRowSearch] = useState("");
  const matchesSearch = (p,q) => !q||p.address?.toLowerCase().includes(q.toLowerCase());
  const pickerBtnRefs = useRef({});

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
  const [amtLocked,setAmtLocked] = useState({});
  const toggleAmtLock=i=>setAmtLocked(l=>({...l,[i]:!l[i]}));
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

  // Fixed-to-Property private money is secured by a promissory note/mortgage against the
  // specific property it's on — still moveable, but only after confirming that paperwork
  // gets updated to reflect the new property, so it doesn't just quietly drift out of sync.
  const needsNoteConfirm = currentPropId!==null && loan.loanType==="private" && loan.lockedToProperty;
  const [noteConfirmed, setNoteConfirmed] = useState(false);
  const [noteChecked, setNoteChecked] = useState(false);
  if (needsNoteConfirm && !noteConfirmed) return (
    <Modal title={`Move — ${loan.lenderName}`} onClose={onClose}>
      <div className="mb-4 p-4 rounded-xl border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-900/20">
        <div className="font-bold text-violet-800 dark:text-violet-300 mb-1">⚠️ Fixed to Property</div>
        <div className="text-sm text-violet-700 dark:text-violet-400">
          {loan.lenderName}'s {$$p(loanAmt)} is secured by a promissory note / mortgage against its current
          property. Moving it to a different property means that paperwork needs to be updated to match —
          otherwise the note is pointing at the wrong collateral.
        </div>
      </div>
      <label className="flex items-start gap-2.5 mb-4 cursor-pointer">
        <input type="checkbox" checked={noteChecked} onChange={e=>setNoteChecked(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-slate-300 dark:border-zinc-600 accent-violet-600 cursor-pointer shrink-0"/>
        <span className="text-sm text-slate-700 dark:text-zinc-300">I've updated (or will immediately update) the promissory note / mortgage to reflect this move.</span>
      </label>
      <div className="flex gap-2">
        <Btn onClick={onClose} color="ghost" full>Cancel</Btn>
        <Btn onClick={()=>setNoteConfirmed(true)} color="purple" full disabled={!noteChecked}>Continue</Btn>
      </div>
    </Modal>
  );

  if(!hasViableDest&&!showUnassigned) return (
    <Modal title={`${currentPropId?"Move":"Place"} — ${loan.lenderName}`} onClose={onClose}>
      <div className="mb-4 p-4 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-100 dark:border-zinc-700">
        <div className="font-bold text-slate-900 dark:text-zinc-100">{loan.lenderName}</div>
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$p(loanAmt)} · {fmtRate(loan)}</div>
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
        <div className="text-sm text-slate-500 dark:text-zinc-400 mt-0.5">{$$p(loanAmt)} · {fmtRate(loan)} · <TypeLabel type={loan.loanType}/></div>
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
          {(available.length+blockedSize.length+blockedDate.length)>1&&(
            <input type="text" value={placeSearch} onChange={e=>setPlaceSearch(e.target.value)} placeholder="Search properties…"
              className="w-full px-3 py-2 rounded-xl text-sm bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-teal-500"/>
          )}
          {showUnassigned&&(
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1.5">Remove from Property</div>
              <button type="button" onClick={()=>handlePlace("unassigned")}
                className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-violet-50 dark:hover:bg-violet-900/20 border border-slate-200 dark:border-zinc-700 hover:border-violet-300 dark:hover:border-violet-700 transition-all">
                <span className="font-medium text-[13px] text-slate-800 dark:text-zinc-200">💼 Move to Unassigned</span>
              </button>
            </div>
          )}
          {available.filter(p=>matchesSearch(p,placeSearch)).length>0&&(
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1.5">Available Properties</div>
              <div className="space-y-1.5">
                {available.filter(p=>matchesSearch(p,placeSearch)).map(p=>(
                  <button key={p.id} type="button" onClick={()=>{setBlockMsg("");handlePlace(p.id);}}
                    className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-teal-50 dark:hover:bg-teal-900/20 border border-slate-200 dark:border-zinc-700 hover:border-teal-300 dark:hover:border-teal-700 transition-all flex items-center justify-between gap-2">
                    <span className="font-medium text-[13px] text-slate-800 dark:text-zinc-200 truncate">🏠 {p.address}</span>
                    <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$p(propGap(p))} avail</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {blockedSize.filter(p=>matchesSearch(p,placeSearch)).length>0&&(
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-amber-500 dark:text-amber-400 mb-1.5">No Funding Gap — Consider Splitting</div>
              <div className="space-y-1.5">
                {blockedSize.filter(p=>matchesSearch(p,placeSearch)).map(p=>(
                  <button key={p.id} type="button" disabled
                    className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-40 cursor-not-allowed flex items-center justify-between gap-2">
                    <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500 truncate">📐 {p.address}</span>
                    <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$p(propGap(p))} avail</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {blockedDate.filter(p=>matchesSearch(p,placeSearch)).length>0&&(
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1.5">Timing Conflict — Cannot Place</div>
              <div className="space-y-1.5">
                {blockedDate.filter(p=>matchesSearch(p,placeSearch)).map(p=>(
                  <button key={p.id} type="button" disabled
                    className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 opacity-40 cursor-not-allowed flex items-center justify-between gap-2">
                    <span className="font-medium text-[13px] text-slate-500 dark:text-zinc-500 truncate">🕐 {p.address}</span>
                    <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$p(propGap(p))} avail</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {placeSearch&&[...available,...blockedSize,...blockedDate].filter(p=>matchesSearch(p,placeSearch)).length===0&&(
            <div className="text-xs text-slate-400 dark:text-zinc-500 text-center py-3">No matches</div>
          )}
          <div className="pt-1"><Btn onClick={onClose} color="ghost" full>Cancel</Btn></div>
        </div>
      )}
      {mode==="split"&&(
        <div className="space-y-4">
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-sm">
            <div className="flex justify-between"><span className="text-slate-500 dark:text-zinc-400">Total to split</span><span className="tabular-nums font-semibold text-slate-900 dark:text-zinc-100">{$$p(loanAmt)}</span></div>
          </div>
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
                      <LockableInline locked={amtLocked[i]} onToggle={()=>toggleAmtLock(i)}>
                        <MoneyField placeholder="$ Amount" value={row.amount}
                          onChange={val=>{
                            const newAmt=parseFloat(val)||0;
                            let newPropId=row.propId;
                            if(row.propId&&row.propId!=="unassigned"){
                              const p=activeProps.find(x=>x.id===row.propId);
                              if(p&&propConflict(loan.startDate,newAmt,p)!==null) newPropId="";
                            }
                            setSplits(s=>s.map((r,j)=>j===i?{...r,amount:val,propId:newPropId}:r));
                          }}
                          className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-2 py-1.5 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-teal-500 tabular-nums"/>
                      </LockableInline>
                    </div>
                    <div className="flex-1 relative">
                      <button ref={el=>pickerBtnRefs.current[i]=el} type="button" disabled={!hasAmt} onClick={()=>setOpenPicker(openPicker===i?null:i)}
                        className={`relative w-full text-left px-2 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs flex items-center justify-between gap-1 ${!hasAmt?"opacity-40 cursor-not-allowed text-slate-400 dark:text-zinc-500":"text-slate-800 dark:text-zinc-100 hover:border-teal-400 dark:hover:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"}`}>
                        <span className="truncate">{pickerLabel}</span>
                        <span className="shrink-0 text-slate-400 dark:text-zinc-500">▾</span>
                      </button>
                      <DropdownPortal anchorRef={{current:pickerBtnRefs.current[i]}} open={openPicker===i} onClose={()=>{setOpenPicker(null);setRowSearch("");}}>
                          {candidateProps.length>1&&(
                            <div className="sticky top-0 bg-white dark:bg-zinc-800 border-b border-slate-100 dark:border-zinc-700 p-1.5">
                              <input type="text" value={rowSearch} onChange={e=>setRowSearch(e.target.value)} placeholder="Search properties…" autoFocus
                                className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-teal-500"/>
                            </div>
                          )}
                          {!rowSearch&&(
                            <button type="button" onClick={()=>{setRow(i,"propId","unassigned");setOpenPicker(null);setRowSearch("");}}
                              className="w-full text-left px-3 py-2.5 text-xs font-medium text-slate-800 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 border-b border-slate-100 dark:border-zinc-700 transition-colors">
                              💼 Leave unassigned
                            </button>
                          )}
                          {propOptions.filter(({prop})=>matchesSearch(prop,rowSearch)).map(({prop,c})=>{
                            const disabled=c!==null;
                            const emoji=c==="date"?"🕐":c==="size"?"📐":"🏠";
                            const suffix=c==="date"?" — timing conflict":"";
                            return(
                              <button key={prop.id} type="button" disabled={disabled}
                                onClick={()=>{setRow(i,"propId",prop.id);setOpenPicker(null);setRowSearch("");}}
                                className={`w-full text-left px-3 py-2.5 text-xs font-medium transition-colors flex items-center justify-between gap-2 ${disabled?"opacity-40 cursor-not-allowed pointer-events-none text-slate-500 dark:text-zinc-500":"text-slate-800 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700"}`}>
                                <span className="truncate">{emoji} {prop.address}{suffix}</span>
                                <span className="text-slate-400 dark:text-zinc-500 shrink-0 tabular-nums">{$$p(propGap(prop))} avail</span>
                              </button>
                            );
                          })}
                          {rowSearch&&propOptions.filter(({prop})=>matchesSearch(prop,rowSearch)).length===0&&(
                            <div className="px-3 py-2.5 text-xs text-slate-400 dark:text-zinc-500 italic">No matches</div>
                          )}
                      </DropdownPortal>
                    </div>
                    {splits.length>1&&<button type="button" onClick={()=>removeRow(i)} className="text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 text-base transition-colors shrink-0">✕</button>}
                  </div>
                </div>
              );
            })}
            <button type="button" onClick={addRow} className="text-xs text-teal-600 dark:text-teal-400 hover:underline font-semibold">+ Add destination</button>
          </div>
          <div className={`flex justify-between text-sm font-semibold border-t border-slate-200 dark:border-zinc-700 pt-3 ${Math.abs(remaining)<0.01?"text-emerald-600 dark:text-emerald-400":remaining<0?"text-red-500 dark:text-red-400":"text-amber-600 dark:text-amber-400"}`}>
            <span>Unallocated</span>
            <span className="tabular-nums">{$$p(remaining)} {Math.abs(remaining)<0.01?"✓":remaining<0?"(over!)":""}</span>
          </div>
          {!splitValid&&<p className="text-xs text-slate-400 dark:text-zinc-500 mt-1">{splits.some(r=>rowConflict(r))?"A destination has a conflict — reduce that amount or pick another property.":`All rows need a destination and amount, and must sum to ${$$p(loanAmt)}.`}</p>}
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
  const [dateLocked, setDateLocked] = useState(false);
  const payoff = Math.round(calcBalance(loan, closeDate) * 100) / 100;
  // For a split loan, calcIntEarned is the TOTAL (monthly-paid + still-accruing) — showing
  // that as "Accrued Interest" here would overstate what's actually reflected in the payoff
  // below, which (correctly) only carries the still-accruing closing portion.
  const intEarned = loan.paymentType==="monthly_rate_split"
    ? Math.round((payoff-(loan.principal||0))*100)/100
    : Math.round(calcIntEarned(loan, closeDate) * 100) / 100;
  const monthlyPaidPortion = calcMonthlyPaidPortion(loan, closeDate);
  const inputCls = "flex-1 border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500";
  return (
    <Modal title={`Close Loan — ${loan.lenderName}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="w-32 text-sm text-slate-600 dark:text-zinc-300 shrink-0">Close Date</span>
          <LockableInline locked={dateLocked} onToggle={()=>setDateLocked(l=>!l)} className="flex-1">
            <input type="date" value={closeDate} onChange={e=>setCloseDate(e.target.value)} className={inputCls}/>
          </LockableInline>
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
          {monthlyPaidPortion > 0.01 && (
            <p className="text-[11px] text-slate-400 dark:text-zinc-500">
              Plus {$$p(monthlyPaidPortion)} already paid monthly — not part of this payoff
            </p>
          )}
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
  const [locked,setLocked]=useState({});
  const toggleLock=k=>setLocked(l=>({...l,[k]:!l[k]}));

  // Per-lender rows — includes principal/interest/fees breakdown
  const [rows,setRows]=useState(()=>[
    ...activeLoans.map(l=>{
      const pt=l.paymentType||"closing";
      // isMonthly: fully paid monthly, nothing more owed from the wire at closing. A split
      // loan is NOT this — its closing portion is still owed, same as a "closing" loan.
      const isMonthly=pt==="monthly_rate"||pt==="monthly_fixed";
      const calcP=Math.round(calcBalance(l,soldDate)*100)/100; // cent precision
      // calcInterest: interest owed AT CLOSING (0 for monthly; for split, just the
      // still-accruing closing portion — the monthly-paid portion never touches this)
      const calcI=isMonthly?0:Math.round((calcP-(l.principal||0))*100)/100;
      // intEarned: total interest earned on this loan (monthly-paid + accrued, whichever apply)
      const intEarned=calcIntEarned(l,soldDate); // already cent-precise
      // monthlyPortionPaid: for a split loan, interest already received in cash each month —
      // a real cost of this deal, but never pulled from THIS wire since it's already been paid.
      const monthlyPortionPaid=calcMonthlyPaidPortion(l,soldDate);
      return {
        loanId:l.id,lenderName:l.lenderName,loanType:l.loanType,
        principal:l.principal||0,calcPayoff:calcP,calcInterest:calcI,monthlyPortionPaid,
        isMonthly,isPreClosed:false,
        interestRate:l.interestRate||0,interestType:l.interestType||"percentage",
        splitMonthlyRate:l.splitMonthlyRate||0,
        paymentType:pt,specialTerms:l.specialTerms||"",
        principalPayoff:String(l.principal||0),
        interestPayoff:String(isMonthly?intEarned:calcI),
        // Hard money is settled through title as standard practice; private money is
        // settled from the wire by default. Still a per-lender toggle either way.
        lenderFees:"0",overageRefund:"0",titleMoneyCosts:"0",paidAtTitle:l.loanType==="hard",
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
      const pt=l.paymentType||"closing";
      const isMonthly=pt==="monthly_rate"||pt==="monthly_fixed";
      const calcP=Math.round(calcBalance(l,soldDate)*100)/100;
      const calcI=isMonthly?0:Math.round((calcP-(l.principal||0))*100)/100;
      const intEarned=calcIntEarned(l,soldDate);
      const monthlyPortionPaid=calcMonthlyPaidPortion(l,soldDate);
      // waiveInterest: interest not paid, so original start date carries forward (don't reset)
      const newSD=r.type==="waiveInterest"?r.origStartDate:startDate;
      return {...r,calcPayoff:calcP,calcInterest:calcI,interestPayoff:String(isMonthly?intEarned:calcI),monthlyPortionPaid,newStartDate:newSD};
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
  const guardedClose=useDirtyGuard(()=>({step,soldDate,isRental,rows,cashToCloseIn,rehabIn,miscIn,wireIn}),onClose);

  const cashToClose=parseFloat(cashToCloseIn)||0;
  const rehab=parseFloat(rehabIn)||0;
  // Money Costs = interest + lender fees for all applicable types
  // rollPrincipal: Nexus keeps interest (income), but fees are still a cost
  // waiveInterest: interest forgiven, but fees still apply
  const moneyCosts=Math.round(rows.reduce((s,r)=>{
    const fees=parseFloat(r.lenderFees)||0;
    const interest=parseFloat(r.interestPayoff)||0;
    // A split loan's monthly-paid portion is real cash already spent on this deal, over and
    // above whatever happens to the closing-portion below (rolled, waived, or paid).
    const monthlyPaid=r.monthlyPortionPaid||0;
    if(r.type==="rollPrincipal"||r.type==="waiveInterest") return s+fees+monthlyPaid;
    if(r.isMonthly||r.type==="paidOut"||r.type==="payInterest"||r.type==="rollFull"||r.type==="alreadyPaid") return s+interest+fees+monthlyPaid;
    return s+fees+monthlyPaid; // custom: fees + monthly-paid portion still cost, closing accrual not
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
        splitMonthlyRate:r.splitMonthlyRate||0,
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
        isMonthly:r.isMonthly||false,
        principalPayoff:parseFloat(r.principalPayoff)||0,
        interestPayoff:parseFloat(r.interestPayoff)||0,
        // For a monthly-paid loan (mostly hard money), interestPayoff above is the TOTAL
        // interest over the whole hold period, most of which was already paid month to
        // month — titleMoneyCosts is just the prorated last-partial-month portion Title
        // actually pays at closing. Save it separately so History can show what Title paid,
        // not the whole period's interest.
        titleInterestPayoff:r.isMonthly&&r.paidAtTitle?(parseFloat(r.titleMoneyCosts)||0):0,
        lenderFees:parseFloat(r.lenderFees)||0,
        wireAmount:wireContrib(r),
        totalPayoff:(parseFloat(r.principalPayoff)||0)+(parseFloat(r.interestPayoff)||0)+(parseFloat(r.lenderFees)||0),
      })),
    }, isRental);
  };

  const inputCls="flex-1 border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-right text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500 tabular-nums";
  const autoCls="flex-1 border border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/50 rounded-lg px-3 py-2 text-sm text-right text-slate-400 dark:text-zinc-500 tabular-nums select-none";
  const labelCls="w-40 text-sm text-slate-600 dark:text-zinc-300 shrink-0 leading-tight";
  const numIn="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-teal-500 tabular-nums text-slate-800 dark:text-zinc-100";
  const autoNum="w-full border border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/50 rounded-lg px-3 py-2 text-sm text-right text-slate-400 dark:text-zinc-500 tabular-nums select-none";

  return (
    <Modal title={`Close: ${prop.address}`} onClose={guardedClose}>
      <div>

        {/* Step tabs */}
        <div className="flex gap-2 mb-5">
          {[["1 · Settle Lenders",1],["2 · Wire & Costs",2]].map(([label,s])=>(
            <button key={s} type="button" onClick={()=>s<step?setStep(s):undefined}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${s===step?"bg-teal-600 text-white":s<step?"bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 cursor-pointer":"bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-500 cursor-not-allowed"}`}>
              {label}
            </button>
          ))}
        </div>

        {/* ── Step 1: Settle Lenders ── */}
        {step===1&&(
          <div className="space-y-4">
            <Lockable locked={locked.soldDate} onToggle={()=>toggleLock("soldDate")}>
              <DateInp label="Date Sold" value={soldDate} onChange={setSoldDate}/>
            </Lockable>

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

                      {r.monthlyPortionPaid>0.01&&(
                        <div className="mb-3 -mt-1 text-[11px] text-slate-500 dark:text-zinc-400">
                          Plus {$$p(r.monthlyPortionPaid)} already paid monthly ({r.splitMonthlyRate}% portion) — separate from the payoff above, already a cost of this deal regardless of disposition
                        </div>
                      )}

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
                          className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500">
                          <option value="paidOut">💰 Paid Out — {$$p(r.calcPayoff)} leaves Nexus</option>
                          <option value="rollFull">🔄 Roll Full {$$p(r.calcPayoff)} to next deal</option>
                          {r.calcInterest>0.01&&<>
                            <option value="rollPrincipal">🔄 Roll {$$p(r.principal)}, Nexus keeps {$$p(r.calcInterest)}</option>
                            <option value="payInterest">💸 Pay {$$p(r.calcInterest)} interest, roll {$$p(r.principal)}</option>
                          </>}
                          <option value="waiveInterest">⚡ Waive interest, roll {$$p(r.principal)}</option>
                          <option value="custom">✏️ Custom split</option>
                        </select>
                        <p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-1.5">
                          {({
                            paidOut:"The lender is fully paid off and done — principal and interest leave Nexus for good.",
                            rollFull:"Nothing is paid out now — this lender's whole balance (principal + interest) carries over and gets reinvested in the next deal.",
                            rollPrincipal:"The lender's principal rolls into the next deal; Nexus keeps the interest earned on this one as profit.",
                            payInterest:"Nexus pays out the interest earned so far; the principal rolls into the next deal.",
                            waiveInterest:"The interest earned on this deal is forgiven — the lender gets nothing extra, and only the principal rolls into the next deal.",
                            custom:"Split it yourself — decide how much pays out now from the wire and how much rolls into the next deal.",
                          })[r.type]}
                        </p>
                      </div>

                      {/* paidOut: full principal / interest / fees breakdown */}
                      {r.type==="paidOut"&&(
                        <div className="space-y-2 mb-3 p-3 bg-slate-50 dark:bg-zinc-800/40 rounded-lg">
                          <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Payoff Breakdown</div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Principal</div>
                              <MoneyField value={r.principalPayoff} onChange={v=>upd(r.loanId,{principalPayoff:v})} className={numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">
                                {r.isMonthly?"Total Interest (full period)":"Interest"}
                              </div>
                              <MoneyField value={r.interestPayoff} onChange={v=>upd(r.loanId,{interestPayoff:v})}
                                className={r.isMonthly?"w-full border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-amber-400 tabular-nums text-amber-700 dark:text-amber-400":numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Lender Fees</div>
                              <MoneyField value={r.lenderFees} onChange={v=>upd(r.loanId,{lenderFees:v})} className={numIn}/>
                            </div>
                          </div>
                          {r.isMonthly&&!r.paidAtTitle&&<p className="text-[10px] text-amber-600 dark:text-amber-400">Total interest over hold period — not deducted from closing wire</p>}
                          {r.isMonthly&&r.paidAtTitle&&(
                            <div className="mt-2 pt-2 border-t border-amber-200 dark:border-amber-800/40 space-y-2">
                              <div className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-widest">Of that interest, split:</div>
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <div className="text-[10px] text-amber-600 dark:text-amber-400 mb-1">Prorated interest from title</div>
                                  <MoneyField value={r.titleMoneyCosts} onChange={v=>upd(r.loanId,{titleMoneyCosts:v})} className={numIn}/>
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
                              <MoneyField value={r.interestPayoff} onChange={v=>upd(r.loanId,{interestPayoff:v})} className={numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Lender Fees</div>
                              <MoneyField value={r.lenderFees} onChange={v=>upd(r.loanId,{lenderFees:v})} className={numIn}/>
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
                              <MoneyField value={r.customRolling} onChange={v=>upd(r.loanId,{customRolling:v})} className={numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">From Wire</div>
                              <div className={autoNum}>{$$p(autoWireForCustom)}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Lender Fees</div>
                              <MoneyField value={r.lenderFees} onChange={v=>upd(r.loanId,{lenderFees:v})} className={numIn}/>
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
                            <MoneyField value={r.lenderFees} onChange={v=>upd(r.loanId,{lenderFees:v})} placeholder="0" className={numIn}/>
                          </div>
                        </div>
                      )}

                      {/* Overage refund (post-close) */}
                      <div className="mt-3 pt-3 border-t border-slate-100 dark:border-zinc-800">
                        <div className="flex items-center gap-3">
                          <div className="text-[10px] text-slate-400 dark:text-zinc-500 leading-tight">Overage Refund<br/><span className="text-[9px]">(post-close, from this lender)</span></div>
                          <MoneyField value={r.overageRefund} onChange={v=>upd(r.loanId,{overageRefund:v})} placeholder="0" className={numIn}/>
                        </div>
                        <p className="text-[9px] text-slate-400 dark:text-zinc-500 mt-1">Only if THIS lender is refunding an overage as part of closing. A later insurance/tax/overcharge check unrelated to a specific lender belongs in "Overage Check" on the property page instead — don't enter the same refund in both places.</p>
                      </div>

                      {/* Roll destination */}
                      {isRolling&&(
                        <div className="pt-3 border-t border-slate-100 dark:border-zinc-800 grid grid-cols-2 gap-2">
                          <div>
                            <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase mb-1">Roll To</div>
                            <select value={r.destination} onChange={e=>upd(r.loanId,{destination:e.target.value})}
                              className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-2 py-1.5 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-teal-500">
                              <option value="unassigned">💼 Unassigned</option>
                              {otherProps.map(p=><option key={p.id} value={p.id}>🏠 {p.address}</option>)}
                            </select>
                          </div>
                          <div>
                            <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase mb-1">New Start Date</div>
                            <input type="date" value={r.newStartDate} onChange={e=>upd(r.loanId,{newStartDate:e.target.value})}
                              className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-2 py-1.5 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-teal-500"/>
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
                          <MoneyField value={r.interestPayoff}
                            onChange={v=>upd(r.loanId,{interestPayoff:v})}
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
                  <div className="text-[10px] text-slate-400 dark:text-zinc-500">The wire amount that covers everything above with $0 profit — enter more for a profit, less for a loss.</div>
                </div>
              );
            })()}

            <div className="flex gap-2 pt-1">
              <Btn onClick={()=>setStep(2)} color="navy" full>Next: Wire &amp; Costs →</Btn>
              <Btn onClick={guardedClose} color="ghost">Cancel</Btn>
            </div>
          </div>
        )}

        {/* ── Step 2: Wire & Costs ── */}
        {step===2&&(
          <div className="space-y-5 pb-2">

            {/* Lender reference from step 1 */}
            <div className="rounded-xl bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-800 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-semibold text-teal-500 dark:text-teal-400 uppercase tracking-widest">Lender Settlements (Step 1)</div>
                <div className="text-right">
                  {titleTotal>0&&<div className="text-[10px] text-amber-600 dark:text-amber-400 tabular-nums">🏛 Title: {$$p(titleTotal)}</div>}
                  <div className="font-bold text-lg tabular-nums text-teal-700 dark:text-teal-300">Wire: {$$p(lenderTotal)}</div>
                </div>
              </div>
              <div className="text-[11px] text-teal-600 dark:text-teal-400 space-y-0.5">
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
                  <LockableInline locked={locked.cashToClose} onToggle={()=>toggleLock("cashToClose")} className="flex-1">
                    <MoneyField value={cashToCloseIn} onChange={setCashToCloseIn} className={inputCls}/>
                  </LockableInline>
                </div>
                <div className="flex items-center gap-3">
                  <span className={labelCls}>Rehab</span>
                  <LockableInline locked={locked.rehab} onToggle={()=>toggleLock("rehab")} className="flex-1">
                    <MoneyField value={rehabIn} onChange={setRehabIn} className={inputCls}/>
                  </LockableInline>
                </div>
                <div className="flex items-center gap-3">
                  <span className={labelCls}>Money Costs <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-normal">(from step 1)</span></span>
                  <div className={autoCls} title="Auto-derived from lender interest in step 1">{$$p(moneyCosts)}</div>
                  <button type="button" onClick={()=>setStep(1)} className="shrink-0 text-[10px] font-semibold text-teal-500 dark:text-teal-400 hover:text-teal-700 dark:hover:text-teal-300 transition-colors whitespace-nowrap">edit ↑</button>
                </div>
                <div className="flex items-center gap-3">
                  <span className={labelCls}>Misc <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-normal">(utilities, insurance)</span></span>
                  <LockableInline locked={locked.misc} onToggle={()=>toggleLock("misc")} className="flex-1">
                    <MoneyField value={miscIn} onChange={handleMiscChange} className={inputCls}/>
                  </LockableInline>
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
              <LockableInline locked={locked.wire} onToggle={()=>toggleLock("wire")} className="flex-1">
                <MoneyField value={wireIn} onChange={handleWireChange} placeholder="0"
                    className="w-full border-2 border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-right font-bold text-teal-700 dark:text-teal-400 focus:outline-none focus:ring-2 focus:ring-teal-500 tabular-nums"/>
              </LockableInline>
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
                <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-1">Break-even wire (the amount that covers costs with $0 profit): {$$p(baseCosts-titleTotal)}</div>
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
            {!balanced&&(
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {wire<=0?"Enter the wire amount above before closing — Confirm is disabled until then.":"Nexus Self-Funding went negative — lenders + title took more than the total costs cover. Double-check the wire, title, and lender payoff amounts above before closing."}
              </p>
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
              {balanced
                ? <Btn onClick={handleConfirm} color="navy" full>✓ Confirm &amp; Close Property</Btn>
                : <Btn onClick={()=>{if(window.confirm("The numbers here don't balance — close anyway? Double-check this is really what you want before continuing."))handleConfirm();}} color="ghost" full>⚠ Confirm Anyway — Unbalanced</Btn>
              }
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
function PropertyForm({ init, lenders, onSave, onClose, onDirtyChange }) {
  // A stable id for this property before it's ever saved, so the real Add Lender Money
  // screen (LenderMoneyForm, unmodified) can show it as a normal pickable destination —
  // same picker as everywhere else, just fed a live draft of this property alongside the
  // real ones instead of a special-cased "this property" shortcut.
  const [draftPropId] = useState(()=>init?.id || uid());
  // Cost to buy, itemized straight off the HUD instead of one hand-totaled number. Each line
  // can hold MULTIPLE entries (e.g. a rehab holdback per lender, or several fee lines) that
  // get summed automatically — added with "+ Add another" — instead of the user pre-adding
  // them in their head before typing a single number.
  const hudDefault = key => {
    if (key==="cashFromBorrower") {
      return init?.closingBuy?.cashFromBorrower!=null
        ? String(init.closingBuy.cashFromBorrower)
        : (!init?.closingBuy&&init?.purchasePrice?String(init.purchasePrice):"");
    }
    const flat = init?.closingBuy?.[key];
    if (flat!=null) return String(flat);
    // A property that predates this breakdown would otherwise be locked out of saving ANY
    // edit until five new fields get backfilled — instead, default the rest to N/A, so
    // existing data is already valid and only genuinely new entries have to be typed out.
    return (init&&!init.closingBuy) ? "N/A" : "";
  };
  const seedHudEntries = key => {
    const items = init?.closingBuy?.[key+"Items"];
    if (items&&items.length) return items.map(it=>({id:it.id||uid(),note:it.note||"",value:String(it.value??"")}));
    return [{id:uid(),note:"",value:hudDefault(key)}];
  };
  const [f,sf]=useState(()=>({
    address:init?.address||"",
    rehabBudget:String(init?.rehabBudget||""),
    projectMonths:init?.projectMonths!=null?String(init.projectMonths):"",
    monthlyHolding:String(init?.monthlyHolding??500),
    purchaseDate:init?.purchaseDate||"",
    cashFromBorrower:seedHudEntries("cashFromBorrower"),
    depositEarnest:seedHudEntries("depositEarnest"),
    loanToTitle:seedHudEntries("loanToTitle"),
    rehabHoldback:seedHudEntries("rehabHoldback"),
    loanPointsFees:seedHudEntries("loanPointsFees"),
    prepaidInterest:seedHudEntries("prepaidInterest"),
  }));
  const s=k=>v=>sf(p=>({...p,[k]:v}));
  const addHudEntry=key=>sf(p=>({...p,[key]:[...p[key],{id:uid(),note:"",value:""}]}));
  const removeHudEntry=(key,id)=>sf(p=>({...p,[key]:p[key].filter(e=>e.id!==id)}));
  const updateHudEntry=(key,field,id,val)=>sf(p=>({...p,[key]:p[key].map(e=>e.id===id?{...e,[field]:val}:e)}));
  // Fields that already had a real value when the form opened start locked — that's exactly
  // the case worth protecting (an already-correct number sitting there) — a brand-new,
  // empty field starts open since there's nothing yet to accidentally overwrite.
  const [locked,setLocked]=useState(()=>({
    address:!!init?.address,
    purchaseDate:!!init?.purchaseDate,
    cashFromBorrower:hudDefault("cashFromBorrower")!=="",
    depositEarnest:hudDefault("depositEarnest")!=="",
    loanToTitle:hudDefault("loanToTitle")!=="",
    rehabHoldback:hudDefault("rehabHoldback")!=="",
    loanPointsFees:hudDefault("loanPointsFees")!=="",
    prepaidInterest:hudDefault("prepaidInterest")!=="",
    rehabBudget:!!init?.rehabBudget,
  }));
  const toggleLock=k=>setLocked(l=>({...l,[k]:!l[k]}));
  const rehab=parseFloat(f.rehabBudget)||0;
  const autoMonths=rehab?Math.ceil((rehab/1000+60)/30):2;
  const months=f.projectMonths!==""?Math.max(0.5,parseFloat(f.projectMonths)||2):autoMonths;
  const holding=parseFloat(f.monthlyHolding)||500;
  const closingBuy=closingBuyFromForm(f);
  const purchase=purchasePriceFromClosingBuy(closingBuy);
  const totalBase=purchase+rehab+holding*months;
  const hudComplete=HUD_KEYS.every(k=>hudFieldValid(f[k]));
  // Every lockable field has to actually be confirmed (✓), not just filled in, before this
  // can save — the whole point is that nothing gets saved without a deliberate confirm.
  const allConfirmed=["address","purchaseDate",...HUD_KEYS,"rehabBudget"].every(k=>locked[k]);
  const canSaveProperty=hudComplete&&allConfirmed;
  const [editingMonths,setEditingMonths]=useState(false);
  const [editingHolding,setEditingHolding]=useState(false);

  // Loans added via the real Add Lender Money popup while this property form is still open —
  // queued locally (not written to the database) until Save Property, since this property
  // may not have an id yet. A live draft of the in-progress property (current address, cost
  // to buy, rehab, and any loans already queued for it) is injected into that popup's own
  // property list so its picker can offer "this property" as a normal option, funding-gap
  // math and all — no special-casing inside LenderMoneyForm itself.
  const [loanDrafts,setLoanDrafts]=useState([]);
  const [addingLoan,setAddingLoan]=useState(false);
  // This form doesn't render its own <Modal> — whatever wraps it owns the backdrop/✕, so
  // it can't check dirtiness on its own. Report it up instead, so the caller can guard its
  // close the same way every self-contained form guards itself.
  const isDirty=useDirty(()=>({f,loanDrafts}));
  useEffect(()=>{onDirtyChange?.(isDirty);},[isDirty]);
  const draftProp={id:draftPropId,address:f.address||"(this property)",purchasePrice:purchase,rehabBudget:rehab,purchaseDate:f.purchaseDate||null,dateSold:null,
    // Existing (already-saved) loans plus anything queued locally for this property, so the
    // funding-gap math accounts for what's already funded, not just what's mid-edit.
    loans:[...(init?.loans||[]), ...loanDrafts.filter(d=>(d._destination||draftPropId)===draftPropId)]};
  const addLoanDraft=lf=>{
    const loan=loanFields(lf);
    setLoanDrafts(ds=>[...ds,{...loan,id:uid(),_destination:lf.destination,_newLender:lf.newLender}]);
    setAddingLoan(false);
  };
  const removeLoanDraft=id=>setLoanDrafts(ds=>ds.filter(d=>d.id!==id));

  return (
    <div>
      <Lockable locked={locked.address} onToggle={()=>toggleLock("address")}>
        <Inp label="Property Address" value={f.address} onChange={s("address")} placeholder="123 Oak Ave, Nashville, TN"/>
      </Lockable>
      <Lockable locked={locked.purchaseDate} onToggle={()=>toggleLock("purchaseDate")}>
        <DateInp label="Purchase Date" value={f.purchaseDate} onChange={s("purchaseDate")} helpText="Reference only — does not affect calculations"/>
      </Lockable>

      {/* Cost to buy — itemized straight off the HUD/Closing Disclosure instead of one
          hand-totaled number, to cut down on transcription mistakes. Every line is required —
          type N/A (exactly) for anything that doesn't apply to this deal, rather than leaving
          it blank, so a blank field always means "not entered yet," never "doesn't apply."
          Each line can also hold multiple entries (e.g. a rehab holdback per lender, or
          several separate fees) that sum automatically via "+ Add another". */}
      <div className="mb-3 p-3.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/60">
        <div className="text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-2">Cost to Buy — From the HUD</div>
        {[
          ["cashFromBorrower","Cash Due From Borrower ($)","150000 or N/A","The exact wire we send to title"],
          ["depositEarnest","Deposit / Earnest Money Sent Before Closing ($)","5000 or N/A",null],
          ["loanToTitle","Loan Amount Sent Directly to Title ($)","100000 or N/A",null],
          ["rehabHoldback","− Rehab Holdback ($)","0 or N/A","Money the lender held back for rehab draws, if any"],
          ["loanPointsFees","− Loan Points / Fees ($)","0 or N/A",null],
          ["prepaidInterest","− Prepaid Interest at Closing ($)","0 or N/A",null],
        ].map(([key,label,placeholder,help])=>{
          const entries=f[key]||[];
          const multi=entries.length>1;
          const fieldValid=hudFieldValid(entries);
          return (
            <Lockable key={key} locked={locked[key]} onToggle={()=>toggleLock(key)}>
              <div className="mb-3">
                <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">{label}</label>
                {entries.map((entry,idx)=>{
                  const t=(entry.value||"").trim();
                  const invalid=t!==""&&!isValidHudValue(t);
                  return (
                    <div key={entry.id} className="flex gap-1.5 mb-1.5">
                      {multi&&(
                        <input type="text" value={entry.note} onChange={e=>updateHudEntry(key,"note",entry.id,e.target.value)}
                          placeholder={`Item ${idx+1} (optional)`}
                          className="w-28 shrink-0 border border-slate-200 dark:border-zinc-700 rounded-xl px-2.5 py-3 text-xs bg-white dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-teal-500"/>
                      )}
                      <input type="text" value={entry.value} onChange={e=>updateHudEntry(key,"value",entry.id,e.target.value)} placeholder={placeholder}
                        className={`flex-1 border rounded-xl px-4 py-3 text-sm bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 transition-all ${invalid?"border-red-300 dark:border-red-700 focus:ring-red-500":"border-slate-200 dark:border-zinc-700 focus:ring-teal-500"}`}/>
                      {multi&&(
                        <button type="button" onClick={()=>removeHudEntry(key,entry.id)}
                          className="shrink-0 w-8 flex items-center justify-center rounded-xl text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 transition-colors">✕</button>
                      )}
                    </div>
                  );
                })}
                <button type="button" onClick={()=>addHudEntry(key)} className="text-[11px] font-semibold text-teal-600 dark:text-teal-400 hover:underline">+ Add another</button>
                {multi&&(
                  <div className="flex justify-between text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mt-1.5">
                    <span>Subtotal</span><span className="tabular-nums">{$$p(sumHudEntries(entries))}</span>
                  </div>
                )}
                <p className={`text-[11px] mt-1.5 ${!fieldValid?"text-red-500 dark:text-red-400":"text-slate-400 dark:text-zinc-500"}`}>
                  {!fieldValid?"Enter a dollar amount, or type N/A if this doesn't apply":(help||"Required — type N/A if this doesn't apply")}
                </p>
              </div>
            </Lockable>
          );
        })}
        <div className="flex justify-between items-center pt-2 mt-1 border-t border-slate-200 dark:border-zinc-700">
          <span className="text-xs font-bold text-slate-600 dark:text-zinc-300">Cost to Buy</span>
          <span className="text-base font-black text-slate-900 dark:text-zinc-100 tabular-nums">{$$p(purchase)}</span>
        </div>
      </div>

      <Lockable locked={locked.rehabBudget} onToggle={()=>toggleLock("rehabBudget")}>
        <Inp label="Rehab Budget ($)" money value={f.rehabBudget} onChange={s("rehabBudget")} placeholder="50000"/>
      </Lockable>

      {/* Project length + monthly holding — auto-filled from rehab and rarely touched, so
          they sit as a small muted row until tapped, instead of taking up full-size fields. */}
      {editingMonths ? (
        <div className="mb-3">
          <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5 flex items-center gap-2">
            Project Length (months)
            {f.projectMonths!==""&&parseFloat(f.projectMonths)!==autoMonths&&(
              <button type="button" onClick={()=>s("projectMonths")("")}
                className="text-teal-500 hover:text-teal-700 dark:text-teal-400 text-[10px] font-semibold transition-colors normal-case">
                ↺ Reset ({autoMonths} mo)
              </button>
            )}
          </label>
          <input type="number" step="0.5" min="0.5" autoFocus onWheel={e=>e.target.blur()}
            value={f.projectMonths!==""?f.projectMonths:autoMonths}
            onChange={e=>s("projectMonths")(e.target.value)}
            onBlur={()=>setEditingMonths(false)}
            className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500 transition-all"/>
          {rehab>0&&<p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-1.5">Formula: {Math.floor(rehab/1000)} rehab days + 60 listing days = {autoMonths} mo</p>}
        </div>
      ) : (
        <button type="button" onClick={()=>setEditingMonths(true)}
          className="w-full flex items-center justify-between px-3 py-1.5 mb-2 rounded-lg text-xs text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/60 transition-colors">
          <span>Project Length{f.projectMonths===""?" (auto from rehab)":""}</span>
          <span className="tabular-nums font-medium">{months} mo</span>
        </button>
      )}

      {editingHolding ? (
        <Inp label="Monthly Utilities & Insurance ($)" money autoFocus value={f.monthlyHolding} onChange={s("monthlyHolding")}
          onBlur={()=>setEditingHolding(false)} helpText="Pre-filled at $500/mo — covers utilities, insurance, etc."/>
      ) : (
        <button type="button" onClick={()=>setEditingHolding(true)}
          className="w-full flex items-center justify-between px-3 py-1.5 mb-3 rounded-lg text-xs text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/60 transition-colors">
          <span>Monthly Utilities & Insurance</span>
          <span className="tabular-nums font-medium">{$$p(holding)}/mo</span>
        </button>
      )}

      {totalBase>0&&(
        <div className="mb-4 p-4 bg-slate-50 dark:bg-zinc-800 rounded-xl border border-slate-200 dark:border-zinc-700 text-xs space-y-1">
          <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Estimated Capital Need</div>
          {[["Cost to Buy",purchase],["Rehab",rehab],[`Holding (${months} mo × $${holding}/mo)`,holding*months]].filter(([,v])=>v>0).map(([l,v])=>(
            <div key={l} className="flex justify-between text-slate-600 dark:text-zinc-300"><span>{l}</span><span className="tabular-nums">{$$p(v)}</span></div>
          ))}
          <div className="flex justify-between font-bold text-slate-900 dark:text-zinc-100 border-t border-slate-200 dark:border-zinc-700 pt-2 mt-1">
            <span>Base Total</span><span className="tabular-nums">{$$p(totalBase)}</span>
          </div>
          <p className="text-[10px] text-slate-400 dark:text-zinc-500 pt-1">+ monthly interest × {months} mo added once loans are entered</p>
        </div>
      )}

      {/* Loans — the real Add Lender Money screen, opened right here so a loan can start
          when the property is bought instead of a separate trip afterward. */}
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-2">Loans</label>
        {loanDrafts.map(d=>(
          <div key={d.id} className="flex items-center justify-between gap-2 px-3.5 py-2.5 mb-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-800 dark:text-zinc-100 truncate">{d.lenderName||"Unknown"} <span className="font-normal text-slate-400 dark:text-zinc-500">· {$$p(d.principal)}</span></div>
              <div className="text-[11px] text-slate-400 dark:text-zinc-500">{fmtRate(d)}</div>
            </div>
            <button type="button" onClick={()=>removeLoanDraft(d.id)} className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400">✕</button>
          </div>
        ))}
        {/* Inline, not a popup — this is the real LenderMoneyForm, just rendered in place
            instead of stacked as a second modal on top of the Add Property one, which was
            forcing a scroll back up to it every time. */}
        {addingLoan ? (
          <div className="p-3.5 rounded-xl border border-teal-200 dark:border-teal-800 bg-teal-50/30 dark:bg-teal-900/10">
            <div className="text-[11px] font-bold uppercase tracking-widest text-teal-600 dark:text-teal-400 mb-2">Add a Loan</div>
            <LenderMoneyForm properties={[draftProp]} lenders={lenders||[]} init={{destination:draftPropId}}
              lockDestinationTo={{id:draftPropId,label:f.address||"this property"}}
              onSave={addLoanDraft} onClose={()=>setAddingLoan(false)}/>
          </div>
        ) : (
          <button type="button" onClick={()=>setAddingLoan(true)} className="text-xs font-semibold text-teal-600 dark:text-teal-400 hover:underline">+ Add a Loan</button>
        )}
      </div>

      {!hudComplete&&<p className="text-[11px] text-red-500 dark:text-red-400 -mt-1 mb-2">Every Cost to Buy line needs a number or N/A before this can be saved.</p>}
      {hudComplete&&!allConfirmed&&<p className="text-[11px] text-red-500 dark:text-red-400 -mt-1 mb-2">Tap ✓ Confirm on every field above before this can be saved.</p>}
      <div className="flex gap-2 pt-2">
        <Btn onClick={()=>canSaveProperty&&onSave({...f,purchasePrice:String(purchase),closingBuy,loanDrafts,id:draftPropId})} color={canSaveProperty?"blue":"ghost"} disabled={!canSaveProperty} full>Save Property</Btn>
        <Btn onClick={()=>confirmDiscard(isDirty,onClose)} color="ghost">Cancel</Btn>
      </div>
    </div>
  );
}

// ─── Shared page toolbar components ───────────────────────────────────────────
const SEARCH_CLS = "ml-auto w-52 px-3 py-1.5 rounded-xl text-xs bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-teal-500 shrink-0";

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
              className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${value===v?"bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-300 font-semibold":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700"}`}>
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
  const h$=v=>prv?maskMoney($$p(v)):$$p(v);
  const hr=l=>{if(!prv)return fmtRate(l);const s=fmtRate(l);return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s);};
  const [open,setOpen]=useState(false);
  const sorted=[...funds].sort((a,b)=>(a.startDate||"").localeCompare(b.startDate||""));

  return (
    <div className="mb-3 rounded-2xl overflow-hidden bg-white dark:bg-[#1C1F2B] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
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
              <div key={u.id} className="px-5 py-3.5 flex items-center justify-between gap-2 bg-white dark:bg-[#1C1F2B] hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                  <button onClick={()=>openPanel({type:'loan',loanId:u.id,propId:null})} className="font-semibold text-slate-900 dark:text-zinc-100 text-sm hover:text-teal-600 dark:hover:text-teal-400 transition-colors text-left">{u.lenderName}</button>
                  <span className="font-bold text-violet-700 dark:text-violet-300 text-sm tabular-nums">{h$(principal)}</span>
                  {(u.interestRate!=null)&&<span className="text-xs text-slate-400 dark:text-zinc-500">{hr(u)}</span>}
                  {earned>0.01&&<span className="text-xs text-emerald-600 dark:text-emerald-400 tabular-nums">+{h$(earned)}</span>}
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${days>60?"bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800":days>30?"bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800":"bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border-slate-200 dark:border-zinc-700"}`}>
                    {days}d
                  </span>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={()=>onPlace(u)} className="text-[11px] font-bold text-white bg-violet-600 hover:bg-violet-700 rounded-lg px-2.5 py-1 transition-colors">Place →</button>
                  <button onClick={()=>onEdit(u)}  className="p-1.5 text-slate-300 dark:text-zinc-600 hover:text-teal-500 dark:hover:text-teal-400 text-sm transition-colors">✏️</button>
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
  splitMonthlyRate:f.paymentType==="monthly_rate_split"?(parseFloat(f.splitMonthlyRate)||0):null,
  drawFacility:f.drawFacility?{committed:parseFloat(f.drawFacility.committed)||0,draws:f.drawFacility.draws||[]}:null,
  specialTerms:f.specialTerms||"", endDate:f.endDate||null,
  dueDate:f.dueDate||null,
  lockedToProperty:f.loanType==="private"?!!f.lockedToProperty:false,
  promissoryNoteUrl:f.loanType==="private"&&f.lockedToProperty?(f.promissoryNoteUrl||null):null,
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
// Every brand-new hard money lender starts with the stub prorated at closing and a grace
// month, but not the next full month prepaid too — the house default. Private lenders keep
// the generic fallback (no explicit paymentSettings) since they don't share that convention.
const newLenderDefaultSettings = loanType => loanType==="hard"
  ? {...defaultLenderPaymentSettings("hard"), prorateStubAtClosing:true}
  : null;
const upsertLender = (d, newLender) => {
  if (!newLender) return d;
  const settings = newLender.paymentSettings || newLenderDefaultSettings(newLender.loanType);
  const withSettings = settings ? {...newLender, paymentSettings:settings} : newLender;
  return {...d, lenders:[...(d.lenders||[]).filter(x=>x.name!==withSettings.name), withSettings]};
};

// Loans queued up via the real Add Lender Money screen (LenderMoneyForm) while a property
// form is still open, not yet written to the database — each one already carries whatever
// destination its own picker resolved to (this property, a different existing one, or
// Unassigned), so saving the property just has to route each draft to the right bucket and
// register any brand-new lender, exactly like the standalone "Add Lender Money" flow does.
const routeLoanDrafts = (data, loanDrafts, defaultPropId) => {
  let lenders = data.lenders || [];
  let unassigned = data.unassigned || [];
  const propLoanAdds = {};
  (loanDrafts||[]).forEach(({_destination,_newLender,...loan}) => {
    const dest = _destination || defaultPropId;
    if (dest === "unassigned") unassigned = [...unassigned, loan];
    else propLoanAdds[dest] = [...(propLoanAdds[dest]||[]), loan];
    if (_newLender && !lenders.some(l=>l.name===_newLender.name)) {
      const settings = _newLender.paymentSettings || newLenderDefaultSettings(_newLender.loanType);
      lenders = [...lenders, settings ? {..._newLender,paymentSettings:settings} : _newLender];
    }
  });
  return { lenders, unassigned, propLoanAdds };
};
// The HUD-derived cost-to-buy breakdown: what actually funds the purchase, from the wire we
// send plus any money sent straight to title, minus anything held back or taken off the top
// before it ever reaches the cost of the house — entered as its own line items straight off
// the HUD instead of one hand-calculated number, to cut down on transcription mistakes.
// Every line is required: a blank field is incomplete, not "zero" — N/A (typed exactly) is
// the only way to say a line doesn't apply to this deal.
const HUD_KEYS = ["cashFromBorrower","depositEarnest","loanToTitle","rehabHoldback","loanPointsFees","prepaidInterest"];
// A plain parseFloat silently reads "1,500" as 1 (stops at the comma) and "150000abc" as
// 150000 (ignores the trailing garbage) — strip thousands-commas first, then insist the
// WHOLE string is a clean non-negative number, so typos surface as invalid instead of
// silently turning into the wrong dollar amount.
const parseHudNumber = v => {
  const cleaned = (v||"").trim().replace(/,/g,"");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return parseFloat(cleaned);
};
const isHudNA = v => /^n\/?a$/i.test((v||"").trim()); // N/A, n/a, NA, na — any case, with or without the slash
const isValidHudValue = v => isHudNA(v) || parseHudNumber(v)!=null;
// Each HUD line can hold several entries (e.g. one rehab holdback per lender) that sum
// automatically instead of forcing the user to add them up by hand before typing one number.
const sumHudEntries = entries => (entries||[]).reduce((sum,e)=>{
  const n = parseHudNumber(e.value);
  return n==null ? sum : sum+n;
},0);
const hudFieldValid = entries => (entries||[]).length>0 && entries.every(e=>isValidHudValue(e.value));
const closingBuyFromForm = f => {
  const out = {};
  HUD_KEYS.forEach(key=>{
    out[key] = sumHudEntries(f[key]);
    const items = (f[key]||[]).filter(e=>(e.value||"").trim()!=="");
    if (items.length) out[key+"Items"] = items.map(e=>({id:e.id,note:e.note||"",value:e.value}));
  });
  return out;
};
const purchasePriceFromClosingBuy = cb =>
  (cb.cashFromBorrower || 0) + (cb.depositEarnest || 0) + (cb.loanToTitle || 0)
  - (cb.rehabHoldback || 0) - (cb.loanPointsFees || 0) - (cb.prepaidInterest || 0);

// ── Overage checks ──────────────────────────────────────────────────────────
// Checks that show up AFTER a property closes — an insurance refund, a tax proration
// correction, an overcharge title catches later — with no way to know in advance what
// they'll be for or how much. They're recorded against the closed property as they come
// in and count straight toward that property's profit, on top of the profit figure that
// was locked in at closing.
const OVERAGE_SOURCES = [["insurance","Insurance"],["taxes","Taxes"],["overcharge","Closing Overcharge"],["other","Other"]];
const overageSourceLabel = src => (OVERAGE_SOURCES.find(([v])=>v===src)||[])[1] || "Overage";
const overageCheckTotal = prop => (prop.overageChecks||[]).reduce((s,c)=>s+(c.amount||0),0);
const effectiveProfit = prop => (prop.closingData?.profit||0) + overageCheckTotal(prop);
// Human-readable label for a navigate() entity — used for the "Recently Viewed" search list,
// resolved at the moment it's visited since loans/properties can get renamed/closed later.
const labelForEntity = (entity, data) => {
  if (!entity || !data) return null;
  if (entity.type === 'property') {
    const p = data.properties.find(x => x.id === entity.id);
    return p ? { label: p.address || "Unnamed property", sub: p.dateSold ? `Sold ${p.dateSold}` : "Active" } : null;
  }
  if (entity.type === 'lender') {
    return { label: entity.name, sub: "Lender" };
  }
  if (entity.type === 'loan') {
    const allLoans = [
      ...data.properties.flatMap(p => p.loans.map(l => ({ ...l, propAddress: p.address }))),
      ...(data.unassigned || []).map(l => ({ ...l, propAddress: null })),
    ];
    const l = allLoans.find(x => x.id === entity.loanId);
    return l ? { label: l.lenderName || "Loan", sub: `${$$p(l.principal)} · ${l.propAddress || "Unassigned"}` } : null;
  }
  return null;
};

// ── Undo support ──────────────────────────────────────────────────────────────
// Rather than snapshot the whole blob (which would blindly clobber any concurrent
// change from another tab/device when undone), diff prev vs next by id and build a
// small inverse PATCH function — add back what was removed, drop what was added,
// restore modified items to their old values. That patch can then be safely replayed
// on top of whatever the current data actually is when Undo is pressed (or retried
// against fresher data on a save conflict), the same way every other update() does.
const byId = arr => new Map((arr||[]).map(x=>[x.id,x]));
const diffById = (prevArr=[], nextArr=[]) => {
  const p=byId(prevArr), n=byId(nextArr);
  const added=[...n.keys()].filter(id=>!p.has(id));
  const removed=[...p.values()].filter(x=>!n.has(x.id));
  const modified=[...n.entries()]
    .filter(([id,item])=>p.has(id)&&JSON.stringify(p.get(id))!==JSON.stringify(item))
    .map(([id])=>({id,prevItem:p.get(id)}));
  return {added,removed,modified};
};
const invertArray = (prevArr, nextArr) => {
  const {added,removed,modified}=diffById(prevArr,nextArr);
  if(!added.length&&!removed.length&&!modified.length) return null;
  return currentArr => {
    let arr = (currentArr||[]).filter(x=>!added.includes(x.id));
    arr = arr.map(x=>{
      const mod = modified.find(m=>m.id===x.id);
      return mod ? mod.prevItem : x;
    });
    return [...arr, ...removed];
  };
};
const invertProperty = (prevProp, nextProp) => {
  if (JSON.stringify(prevProp)===JSON.stringify(nextProp)) return null;
  const invertLoans = invertArray(prevProp.loans, nextProp.loans);
  const {loans:_p, ...prevRest} = prevProp;
  const {loans:_n, ...nextRest} = nextProp;
  const fieldsChanged = JSON.stringify(prevRest)!==JSON.stringify(nextRest);
  return currentProp => ({
    ...currentProp,
    ...(fieldsChanged ? prevRest : {}),
    loans: invertLoans ? invertLoans(currentProp.loans) : currentProp.loans,
  });
};
const computeInverse = (prev, next) => {
  if (prev===next) return null;
  const propDiff = diffById(prev.properties, next.properties);
  const propInverses = new Map();
  (next.properties||[]).forEach(np=>{
    const pp=(prev.properties||[]).find(p=>p.id===np.id);
    if(pp){ const inv=invertProperty(pp,np); if(inv) propInverses.set(np.id,inv); }
  });
  const invertUnassigned = invertArray(prev.unassigned, next.unassigned);
  const invertLenders = invertArray(prev.lenders, next.lenders);
  const otherKeys = Object.keys(next).filter(k=>!['properties','unassigned','lenders'].includes(k));
  const otherChanges = {};
  otherKeys.forEach(k=>{ if(JSON.stringify(prev[k])!==JSON.stringify(next[k])) otherChanges[k]=prev[k]; });
  const nothingChanged = !propDiff.added.length&&!propDiff.removed.length&&propInverses.size===0
    &&!invertUnassigned&&!invertLenders&&Object.keys(otherChanges).length===0;
  if (nothingChanged) return null;
  return current => {
    let properties=(current.properties||[]).filter(p=>!propDiff.added.includes(p.id));
    properties=properties.map(p=>propInverses.has(p.id)?propInverses.get(p.id)(p):p);
    properties=[...properties,...propDiff.removed];
    return {
      ...current,
      ...otherChanges,
      properties,
      unassigned: invertUnassigned ? invertUnassigned(current.unassigned) : current.unassigned,
      lenders: invertLenders ? invertLenders(current.lenders) : current.lenders,
    };
  };
};

// ─── Properties Page ──────────────────────────────────────────────────────────
function PropertiesPage({ data, update, pendingAction, onClearPendingAction }) {
  const prv=usePrivacy();
  const openPanel=usePanel();
  const h$=v=>prv?maskMoney($$p(v)):$$p(v);
  const hc=v=>prv?maskMoney($$c(v)):$$c(v);
  const hn=n=>n??"";
  const hr=l=>{if(!prv)return fmtRate(l);const s=fmtRate(l);return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s);};
  const [modal,setModal]=useState(null);
  // PropertyForm/LenderMoneyForm don't own their <Modal> — this page does — so they report
  // whether they've actually been typed into (via onDirtyChange, reset naturally to false
  // the moment a fresh instance mounts), and this page decides whether closing needs a confirm.
  const [formDirty,setFormDirty]=useState(false);
  const closeModal=()=>confirmDiscard(formDirty,()=>setModal(null));
  const [expanded,setExpanded]=useState({});
  const [viewMode,setViewMode]=usePersistedState("nx-propViewMode","condensed");
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

  const saveMoneyForm = f => {
    const base=loanFields(f);
    if(f.destination==="unassigned"){
      update(d=>upsertLender({...d,unassigned:[...d.unassigned,{id:uid(),...base}]},f.newLender));
      setModal(null);
    } else {
      const destProp=data.properties.find(p=>p.id===f.destination);
      const conflict=destProp?propConflict(base.startDate,base.principal,destProp):null;
      if(conflict){
        alert(conflict==='date'
          ? "Cannot place here — this property was acquired after this loan started, so for that stretch of time the loan wouldn't have had this property backing it up."
          : "Cannot place here — not enough funding gap on this property (including 10% contingency). Consider splitting this loan or choosing a property with a larger funding need.");
        return;
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
    // f.id is the same id the property form's embedded loan picker already showed this
    // property as (minted before the first save) — reuse it instead of generating a new
    // one, or loans queued for "this property" would end up pointing at the wrong id.
    const p={...(existing??{id:f.id||uid(),loans:[]}),address:f.address,purchasePrice,rehabBudget,projectMonths,monthlyHolding,fundingNeeded:purchasePrice+rehabBudget,dateSold:existing?.dateSold??null,purchaseDate:f.purchaseDate||null,closingBuy:f.closingBuy||null};
    update(d=>{
      const {lenders,unassigned,propLoanAdds}=routeLoanDrafts(d,f.loanDrafts,p.id);
      const finalP={...p,loans:[...p.loans,...(propLoanAdds[p.id]||[])]};
      let properties=existing?d.properties.map(x=>x.id===finalP.id?finalP:x):[...d.properties,finalP];
      properties=properties.map(x=>x.id===finalP.id?x:(propLoanAdds[x.id]?{...x,loans:[...x.loans,...propLoanAdds[x.id]]}:x));
      return {...d,lenders,unassigned,properties};
    });
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

  const saveOverageCheck = (propId,entry) => {
    update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,overageChecks:[...(p.overageChecks||[]),{id:uid(),...entry}]})}));
    setModal(null);
  };

  const placeOnProperty = (fund,propId) => {
    const loan={id:uid(),lenderName:fund.lenderName,loanType:fund.loanType,principal:fund.principal||fund.amount||0,startDate:fund.startDate||fund.date||TODAY,interestRate:fund.interestRate||0,interestType:fund.interestType||"percentage",paymentType:fund.paymentType||"closing",monthlyPayment:fund.monthlyPayment||0,splitMonthlyRate:fund.splitMonthlyRate??null,drawFacility:fund.drawFacility||null,specialTerms:fund.specialTerms||fund.notes||"",endDate:fund.endDate||null,dueDate:fund.dueDate||null};
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

  const delProp = id => { if(!window.confirm("Delete this property and all its loans?"))return; update(d=>({...d,properties:d.properties.filter(p=>p.id!==id)})); };
  const delUnassigned = id => { if(!window.confirm("Remove this unassigned fund?"))return; update(d=>({...d,unassigned:d.unassigned.filter(u=>u.id!==id)})); };

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
        splitMonthlyRate:(d.paymentType||loan.paymentType)==="monthly_rate_split"?(d.splitMonthlyRate??loan.splitMonthlyRate??0):null,
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
    .filter(p=>!p.dateSold)
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
                      <button onClick={() => setModal({ type: "place", fund: u })}
                        className="text-[11px] font-bold text-violet-700 bg-white hover:bg-violet-50 rounded-lg px-2.5 py-1 transition-colors shadow-sm whitespace-nowrap">Place →</button>
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
      ) : null}

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
          const pd=prop.purchaseDate||(prop.loans.map(l=>l.startDate).filter(Boolean).sort()[0]);
          const daysOwned=pd?Math.floor((new Date(TODAY)-new Date(pd))/86400000):null;
          const months=effectiveMonths(prop);
          const monthlyInt=active.reduce((s,l)=>s+monthlyLoanPayment(l),0);
          const interestCarry=monthlyInt*months;
          return{prop,active,funded,needed,short,over,full:_f,under:!prop.dateSold&&short>0&&!_f,pd,daysOwned,months,interestCarry};
        });
        // No column header actively clicked — keep rows' order, which already reflects the
        // sort dropdown (propSortMode/propSortDir) via visible[]. A clicked column overrides it —
        // except in Manual mode, where drag order must stay authoritative, so the column click
        // is ignored there (dragging would otherwise fight the column sort for row position).
        const sorted=(!propSort.col||propSortMode==="manual") ? rows : [...rows].sort((a,b)=>{
          const d=propSort.dir==="asc"?1:-1;
          switch(propSort.col){
            case"Address":    return d*streetSortKey(a.prop.address).localeCompare(streetSortKey(b.prop.address));
            case"Days Owned": return d*((a.daysOwned??-1)-(b.daysOwned??-1));
            case"Loans":      return d*(a.active.length-b.active.length);
            case"Funded":     return d*(a.funded-b.funded);
            case"Needed":     return d*(a.needed-b.needed);
            case"Status":     return d*(a.short-b.short);
            default:          return 0;
          }
        });
        const COLS=[
          {h:"Address",left:true},
          {h:"Days Owned",left:false},
          {h:"Loans",  left:false},
          {h:"Funded", left:false},
          {h:"Needed", left:false},
          {h:"Status", left:false},
        ];
        const manualMode=propSortMode==="manual";
        const rowClass="hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors cursor-pointer";
        const tbody=(
          <tbody className="bg-white dark:bg-[#1C1F2B] divide-y divide-black/[0.04] dark:divide-white/[0.05]">
            {sorted.map(({prop,active,funded,needed,short,over,under,full,pd,daysOwned,months,interestCarry})=>{
              const cells=(<>
                <td className="py-2.5 px-4 tabular-nums text-[11px] text-slate-300 dark:text-zinc-600">{rankMap[prop.id]}</td>
                <td className="py-2.5 px-4 font-semibold text-slate-800 dark:text-zinc-100 max-w-[160px]">
                  <HoverTip tip={prop.address||"Unnamed"}>
                    <span className="truncate block">{prop.address?.split(',')[0]||"Unnamed"}</span>
                  </HoverTip>
                </td>
                <td className="py-2.5 px-4 text-right tabular-nums text-slate-500 dark:text-zinc-400">
                  {daysOwned!=null?(
                    <HoverTip tip={`Bought ${pd}`}><span>{daysOwned}d</span></HoverTip>
                  ):"—"}
                </td>
                <td className="py-2.5 px-4 text-right text-slate-500 dark:text-zinc-400">
                  {active.length>0?(
                    <HoverTip wide interactive tip={
                      <div className="flex flex-col gap-0.5">
                        {active.map(l=>(
                          <button key={l.id} onClick={e=>{e.stopPropagation();openPanel({type:'lender',name:l.lenderName});}}
                            className="flex justify-between gap-3 w-full text-left hover:text-teal-300 transition-colors">
                            <span className="underline decoration-dotted underline-offset-2">{l.lenderName}</span><span className="font-semibold tabular-nums">{$$p(l.principal||0)}</span>
                          </button>
                        ))}
                      </div>
                    }><span>{active.length}</span></HoverTip>
                  ):active.length}
                </td>
                <td className="py-2.5 px-4 text-right tabular-nums text-slate-700 dark:text-zinc-200 font-medium">{funded>0?$$p(funded):"—"}</td>
                <td className="py-2.5 px-4 text-right tabular-nums text-slate-400 dark:text-zinc-500">
                  {needed>0?(
                    <HoverTip wide tip={
                      <div className="flex flex-col gap-0.5">
                        <div className="flex justify-between gap-3"><span>Purchase</span><span className="font-semibold tabular-nums">{$$p(prop.purchasePrice||0)}</span></div>
                        <div className="flex justify-between gap-3"><span>Rehab</span><span className="font-semibold tabular-nums">{$$p(prop.rehabBudget||0)}</span></div>
                        <div className="flex justify-between gap-3"><span>Interest carry ({months}mo)</span><span className="font-semibold tabular-nums">{$$p(interestCarry)}</span></div>
                      </div>
                    }><span>{$$p(needed)}</span></HoverTip>
                  ):"—"}
                </td>
                <td className="py-2.5 px-4 text-right whitespace-nowrap">
                  {prop.dateSold&&<span className="text-slate-400 dark:text-zinc-500 font-semibold">Sold</span>}
                  {full&&short===0&&over>needed*0.05&&<span className="text-amber-600 dark:text-amber-400 font-semibold tabular-nums">+{$$p(over)} over</span>}
                  {full&&short===0&&over<=needed*0.05&&<span className="text-emerald-600 dark:text-emerald-400 font-semibold">✓ Full</span>}
                  {full&&short>0&&<span className="text-emerald-600 dark:text-emerald-400 font-bold tabular-nums">−{$$p(short)}</span>}
                  {under&&<span className="text-red-500 dark:text-red-400 font-bold tabular-nums">−{$$p(short)}</span>}
                  {!prop.dateSold&&!full&&!under&&funded===0&&<span className="text-slate-300 dark:text-zinc-600">—</span>}
                </td>
                <td className="py-2.5 px-2 text-right">
                  <div className="flex gap-0.5 justify-end items-center">
                    <button onClick={e=>{e.stopPropagation();setModal({type:"editProp",prop});}} className="w-6 h-6 flex items-center justify-center rounded-md text-slate-300 dark:text-zinc-600 hover:text-teal-500 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-all text-xs">✏️</button>
                    <button onClick={e=>{e.stopPropagation();delProp(prop.id);}} className="w-6 h-6 flex items-center justify-center rounded-md text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all text-xs">🗑</button>
                  </div>
                </td>
              </>);
              const openProp=()=>openPanel({type:'property',id:prop.id});
              return manualMode ? (
                <SortableItem key={prop.id} id={prop.id} as="tr" className={rowClass} onClick={openProp}>{cells}</SortableItem>
              ) : (
                <tr key={prop.id} className={rowClass} onClick={openProp}>{cells}</tr>
              );
            })}
          </tbody>
        );
        const table=(
          <div className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1F2B] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
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
                              ? <span className="text-teal-500 ml-0.5">{propSort.dir==="asc"?"↑":"↓"}</span>
                              : <span className="opacity-40 ml-0.5">↕</span>
                            }
                          </span>
                        </th>
                      );
                    })}
                    <th className="py-2.5 px-2"></th>
                  </tr>
                </thead>
                {tbody}
              </table>
            </div>
          </div>
        );
        // DndContext's accessibility live-region renders a <div>, which can't be a direct
        // child of <table> — so it wraps the whole card from outside the table, not between
        // <table> and <tbody>, even though only the <tr>s inside are actually sortable.
        return manualMode ? (
          <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sorted.map(r=>r.prop.id)} strategy={verticalListSortingStrategy}>
              {table}
            </SortableContext>
          </DndContext>
        ) : table;
      })()}

      {viewMode==="grid"&&visible.length>0&&(
        <DndContext sensors={dragSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visible.map(p=>p.id)} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
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
                className={`w-full text-left rounded-2xl overflow-hidden transition-all hover:-translate-y-0.5 bg-white dark:bg-[#1C1F2B] ${prop.dateSold?"opacity-50":"shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none hover:shadow-[0_4px_20px_rgba(0,0,0,0.10)]"}`}>
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
                        <div className={`h-full transition-all rounded-full ${full?"bg-emerald-500":under?"bg-red-400":"bg-teal-500"}`} style={{width:`${pct(funded,needed)}%`}}/>
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
          const purchaseAmt=prop.purchasePrice||0;
          const rehabAmt=prop.rehabBudget||0;
          const intAmt=monthlyInt*months;
          const d1=purchaseAmt/needed*100;
          const d2=(purchaseAmt+rehabAmt)/needed*100;
          const hasBreakdown=purchaseAmt>0||rehabAmt>0||intAmt>0;
          const pd=prop.purchaseDate||(prop.loans.map(l=>l.startDate).filter(Boolean).sort()[0]);
          const daysOwned=pd?Math.floor((new Date(TODAY)-new Date(pd))/86400000):null;
          const manualMode=propSortMode==="manual";

          return (
            <SortableItem key={prop.id} id={prop.id} disabled={!manualMode}
              className={`rounded-2xl overflow-hidden transition-all ${prop.dateSold?"opacity-50":"shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none"} bg-white dark:bg-[#1C1F2B]`}>
            {handleProps => (<>

              {/* Header — clean PropDash style, click anywhere to expand (drag handle in manual mode) */}
              <div className={`px-5 py-3.5 cursor-pointer ${under?"bg-red-50/60 dark:bg-red-950/15":""} ${manualMode?"cursor-grab":""}`}
                onClick={()=>toggle(prop.id)} {...handleProps}>
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-center gap-2 min-w-0 mr-3">
                    <span className="text-[11px] text-slate-300 dark:text-zinc-600 tabular-nums font-medium shrink-0">{rankMap[prop.id]}</span>
                    <button onClick={e=>{e.stopPropagation();openPanel?.({type:'property',id:prop.id});}} className="font-semibold text-slate-900 dark:text-zinc-100 truncate hover:text-teal-600 dark:hover:text-teal-400 text-left transition-colors">{isOpen?(prop.address||"Unnamed Property"):(prop.address?.split(',')[0]||"Unnamed Property")}</button>
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
                      <div className={`h-full absolute left-0 top-0 transition-all rounded-full ${full?"bg-emerald-500":under?"bg-red-400":"bg-teal-500"}`} style={{width:`${pct(funded,needed)}%`}}/>
                      {hasBreakdown&&purchaseAmt>0&&(rehabAmt>0||intAmt>0)&&<div className="absolute top-0 h-full w-[2px] bg-white/80 dark:bg-black/40" style={{left:`${d1}%`}}/>}
                      {hasBreakdown&&(purchaseAmt+rehabAmt)>0&&intAmt>0&&<div className="absolute top-0 h-full w-[2px] bg-white/80 dark:bg-black/40" style={{left:`${d2}%`}}/>}
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
                        {intAmt>0&&<span className="text-slate-500 dark:text-zinc-400">Interest <strong className="text-slate-800 dark:text-zinc-200 tabular-nums">{hc(intAmt)}</strong><span className="opacity-60 ml-1">({months}mo)</span></span>}
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
                        <div key={loan.id} className={`px-4 py-3 bg-white dark:bg-[#1C1F2B] transition-all ${loan.endDate?"opacity-55":""}`}>
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap mb-1">
                                <button onClick={()=>openPanel?.({type:'loan',loanId:loan.id,propId:prop.id})} className="font-semibold text-slate-900 dark:text-zinc-100 text-[13px] hover:text-teal-600 dark:hover:text-teal-400 text-left transition-colors">{hn(loan.lenderName)}</button>
                                <LockBadge loan={loan}/>
                                {loan.endDate&&<Chip color="gray">Closed {loan.endDate}</Chip>}
                              </div>
                              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                                <span className="text-slate-500 dark:text-zinc-400"><strong className="text-slate-800 dark:text-zinc-200 tabular-nums">{h$(loan.principal)}</strong> principal</span>
                                <span className="text-slate-400 dark:text-zinc-500">{hr(loan)}</span>
                                <span className="text-slate-400 dark:text-zinc-500">from {loan.startDate}</span>
                                <span className="text-slate-500 dark:text-zinc-400">bal <strong className="text-teal-600 dark:text-teal-400 tabular-nums">{h$(bal)}</strong></span>
                                {monthly>0&&<span className="text-slate-400 dark:text-zinc-500"><strong className="text-orange-500 dark:text-orange-400 tabular-nums">{h$(monthly)}/mo</strong></span>}
                                <span className="text-slate-400 dark:text-zinc-500">{monthly>0?"paid":"earned"} <strong className="text-emerald-600 dark:text-emerald-400 tabular-nums">{h$(earned)}</strong></span>
                              </div>
                              {loan.specialTerms&&<div className="text-[10px] text-slate-400 dark:text-zinc-500 italic mt-1">{loan.specialTerms}</div>}
                              {loan.drawFacility&&(
                                <div className="mt-3 p-3 bg-teal-50 dark:bg-teal-950/30 rounded-lg border border-teal-100 dark:border-teal-900/50">
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="text-[10px] font-semibold text-teal-600 dark:text-teal-400 uppercase tracking-widest">Rehab Draw Facility</div>
                                    {!loan.endDate&&(inlineDraw?.loanId===loan.id
                                      ? <button type="button" onClick={()=>setInlineDraw(null)} className="text-[10px] font-medium px-2 py-0.5 rounded-md border border-slate-300 dark:border-zinc-600 text-slate-500 dark:text-zinc-400 hover:border-red-400 hover:text-red-500 transition-colors">Cancel</button>
                                      : <button type="button" onClick={()=>setInlineDraw({propId:prop.id,loanId:loan.id,date:TODAY,amt:"",dateLocked:false,amtLocked:false})} className="text-[10px] font-semibold px-2.5 py-1 rounded-md bg-teal-600 hover:bg-teal-700 text-white transition-colors">+ Add Draw</button>
                                    )}
                                  </div>
                                  <div className="grid grid-cols-3 gap-2 text-center text-xs mb-2">
                                    {[["Committed",h$(loan.drawFacility.committed),"text-teal-700 dark:text-teal-300"],["Drawn",h$(drawn),"text-slate-700 dark:text-zinc-200"],["Available",h$(drawRemaining(loan)),"text-emerald-600 dark:text-emerald-400"]].map(([l,v,c])=>(
                                      <div key={l}><div className="text-[9px] text-teal-400 dark:text-teal-500 uppercase mb-1">{l}</div><div className={`font-bold tabular-nums ${c}`}>{v}</div></div>
                                    ))}
                                  </div>
                                  {(loan.drawFacility.draws||[]).map(d=>(
                                    <div key={d.id} className="flex justify-between text-[11px] text-slate-500 dark:text-zinc-400 pt-1 border-t border-teal-100 dark:border-teal-900/40 first:border-0 mt-1">
                                      <span>{d.date}</span><span className="tabular-nums">{h$(d.amount)} drawn</span>
                                    </div>
                                  ))}
                                  {inlineDraw?.loanId===loan.id&&(
                                    <div className="mt-2 pt-2 border-t border-teal-200 dark:border-teal-800/60 space-y-2">
                                      <div>
                                        <div className="text-[9px] font-semibold text-teal-400 dark:text-teal-500 uppercase mb-1">Draw Date</div>
                                        <LockableInline locked={inlineDraw.dateLocked} onToggle={()=>setInlineDraw(p=>({...p,dateLocked:!p.dateLocked}))}>
                                          <input type="date" value={inlineDraw.date} onChange={e=>setInlineDraw(p=>({...p,date:e.target.value}))}
                                            className="w-full border border-teal-200 dark:border-teal-800 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-teal-500"/>
                                        </LockableInline>
                                      </div>
                                      <div>
                                        <div className="text-[9px] font-semibold text-teal-400 dark:text-teal-500 uppercase mb-1">Amount ($)</div>
                                        <LockableInline locked={inlineDraw.amtLocked} onToggle={()=>setInlineDraw(p=>({...p,amtLocked:!p.amtLocked}))}>
                                          <MoneyField value={inlineDraw.amt} onChange={v=>setInlineDraw(p=>({...p,amt:v}))}
                                            placeholder="25000"
                                            className="w-full border border-teal-200 dark:border-teal-800 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-xs text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-teal-500"/>
                                        </LockableInline>
                                      </div>
                                      <button type="button" onClick={commitInlineDraw}
                                        className="w-full bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold rounded-lg py-2 transition-colors">
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

      {(modal==="addMoney"||modal?.type==="addMoney")&&<Modal title="Add Lender Money" onClose={closeModal}><LenderMoneyForm properties={data.properties} lenders={data.lenders||[]} init={modal?.propId?{destination:modal.propId}:undefined} onSave={saveMoneyForm} onClose={closeModal} onDirtyChange={setFormDirty}/></Modal>}
      {modal==="addProp"&&<Modal title="Add Property" onClose={closeModal}><PropertyForm lenders={data.lenders||[]} onSave={f=>saveProp(f,null)} onClose={closeModal} onDirtyChange={setFormDirty}/></Modal>}
      {modal?.type==="editProp"&&<Modal title="Edit Property" onClose={closeModal}><PropertyForm init={modal.prop} lenders={data.lenders||[]} onSave={f=>saveProp(f,modal.prop)} onClose={closeModal} onDirtyChange={setFormDirty}/></Modal>}
      {modal?.type==="editLoan"&&<Modal title="Edit Loan" onClose={closeModal}>
        <LenderMoneyForm properties={data.properties} lenders={data.lenders||[]} init={{...modal.loan,destination:modal.propId,principal:String(modal.loan.principal),interestRate:String(modal.loan.interestRate||""),interestType:modal.loan.interestType||"percentage",paymentType:modal.loan.paymentType||"closing",monthlyPayment:String(modal.loan.monthlyPayment||""),drawFacility:modal.loan.drawFacility||null}}
          onSave={f=>saveEditedLoan(modal.propId,f,modal.loan)} onClose={closeModal} onDirtyChange={setFormDirty}/>
      </Modal>}
      {modal?.type==="editUnassigned"&&<Modal title="Edit Unassigned Fund" onClose={closeModal}>
        <LenderMoneyForm properties={data.properties} lenders={data.lenders||[]} unassigned={data.unassigned}
          init={{...modal.fund,destination:"unassigned",principal:String(modal.fund.principal||modal.fund.amount||""),interestRate:String(modal.fund.interestRate||""),interestType:modal.fund.interestType||"percentage"}}
          onDirtyChange={setFormDirty}
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
      {modal?.type==="closePropPicker"&&<ClosePropertyPickerModal properties={data.properties} order={data.propertyOrder||[]} onPick={prop=>setModal({type:"markSold",prop})} onClose={()=>setModal(null)}/>}
      {modal?.type==="quickDraw"&&<QuickDrawModal data={data} onSave={handleQuickDraw} onClose={()=>setModal(null)}/>}
      {modal?.type==="overageCheckPicker"&&<OverageCheckPropertyPickerModal properties={data.properties} onPick={prop=>setModal({type:"overageCheck",prop})} onClose={()=>setModal(null)}/>}
      {modal?.type==="overageCheck"&&<OverageCheckModal prop={modal.prop} onSave={entry=>saveOverageCheck(modal.prop.id,entry)} onClose={()=>setModal(null)}/>}
    </div>
  );
}

// ─── Lender Dashboard ─────────────────────────────────────────────────────────
function LenderDashboard({ data }) {
  const prv = usePrivacy();
  const navigate = usePanel();
  const h$ = v => prv ? maskMoney($$p(v)) : $$p(v);
  const [search, setSearch] = useState("");
  const [lenderFilter, setLenderFilter] = usePersistedState("nx-lenderFilter", "active");
  // Default to biggest-balance-first instead of alphabetical, so the lenders with the most
  // money outstanding surface without picking a sort mode (only affects a fresh/first-ever
  // load — anyone who's already picked a sort keeps it).
  const [sortBy, setSortBy] = usePersistedState("nx-lenderSortBy2", "balance");
  const [sortDir, setSortDir] = usePersistedState("nx-lenderSortDir", "desc");

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
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${lenderFilter===val?"bg-teal-600 text-white shadow-sm":"bg-white dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 hover:text-slate-700 dark:hover:text-zinc-200"}`}>
            {label}{lenderFilter===val?` (${lenderCounts[val]})`:null}
          </button>
        ))}
      </div>

      {/* Summary — hidden for inactive-only view */}
      {lenderFilter!=="inactive"&&<div className="grid grid-cols-3 gap-3 mb-5">
        {[
          ["Total Principal", h$(totalPrin), "text-slate-900 dark:text-zinc-100"],
          ["Total Balance", h$(totalBal), "text-teal-600 dark:text-teal-400"],
          ["Interest Accrued", h$(totalInt), "text-emerald-600 dark:text-emerald-400"],
        ].map(([label, val, color]) => (
          <div key={label} className="bg-white dark:bg-[#1C1F2B] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
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
            className="w-full text-left bg-white dark:bg-[#1C1F2B] rounded-2xl px-5 py-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)] hover:shadow-[0_4px_20px_rgba(0,0,0,0.1)] dark:shadow-none dark:hover:bg-[#262A38] transition-all group">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold text-slate-900 dark:text-zinc-100 text-[15px] group-hover:text-teal-600 dark:group-hover:text-teal-400 transition-colors">{ld.name}</span>
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
                <div className="font-bold text-teal-600 dark:text-teal-400 tabular-nums text-sm">{h$(ld.totalBal)}</div>
              </div>
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-300 dark:text-zinc-600 shrink-0 group-hover:text-teal-400 transition-colors">
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
  const h$ = v => prv ? maskMoney($$p(v)) : $$p(v);
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
          <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Active Principal</div>
            <div className="text-xl font-bold tabular-nums text-slate-900 dark:text-zinc-100">{h$(totalPrin)}</div>
          </div>
          <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Active Balance</div>
            <div className="text-xl font-bold tabular-nums text-teal-600 dark:text-teal-400">{h$(totalBal)}</div>
          </div>
        </div>
      )}

      {/* Filters + search */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {["active","closed","all"].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors ${filter===f?"bg-teal-600 text-white":"bg-white dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700"}`}>
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
      <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-slate-400 dark:text-zinc-500 text-sm">No loans match this filter</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] text-slate-400 dark:text-zinc-500 uppercase tracking-widest border-b border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-900/20">
                <th onClick={()=>toggleSort("num")} className="pl-4 pr-2 pb-2.5 pt-3 text-left font-semibold cursor-pointer select-none hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors">
                  <span className="inline-flex items-center gap-0.5">#
                    {sortBy==="num"?<span className="text-teal-500 ml-0.5">{sortDir==="asc"?"↑":"↓"}</span>:<span className="opacity-30 ml-0.5">↕</span>}
                  </span>
                </th>
                {[["lender","Lender","left","px-3"],["property","Property","left","px-3"],["principal","Principal","right","px-3"],["balance","Balance","right","px-3"],["type","Type","left","px-3"]].map(([col,label,align,px])=>(
                  <th key={col} onClick={()=>toggleSort(col)}
                    className={`${px} pb-2.5 pt-3 text-${align} font-semibold cursor-pointer select-none hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors`}>
                    <span className={`inline-flex items-center gap-0.5 ${align==="right"?"justify-end w-full":""}`}>
                      {label}
                      {sortBy===col
                        ? <span className="text-teal-500 ml-0.5">{sortDir==="asc"?"↑":"↓"}</span>
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
                      ? <span className="text-teal-500 ml-0.5">{sortDir==="asc"?"↑":"↓"}</span>
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
                      <button onClick={e=>{e.stopPropagation();navigate({type:'loan',loanId:l.id,propId:l.propId});}} className="font-semibold text-teal-600 dark:text-teal-400 hover:underline text-left">
                        {l.lenderName||"Unknown"}
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      {l.prop
                        ? <button onClick={e=>{e.stopPropagation();navigate({type:'property',id:l.propId});}} className="text-slate-600 dark:text-zinc-300 hover:text-teal-600 dark:hover:text-teal-400 hover:underline text-left max-w-[160px] truncate block">{l.propAddress}</button>
                        : <span className="text-slate-400 dark:text-zinc-500 italic">Unassigned</span>
                      }
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-semibold text-slate-800 dark:text-zinc-200">{h$(l.principal)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-teal-600 dark:text-teal-400">{h$(bal)}</td>
                    <td className="px-3 py-3"><div className="flex items-center gap-1.5"><TypeLabel type={l.loanType}/><LockBadge loan={l}/></div></td>
                    <td className="px-3 py-3 text-right text-slate-500 dark:text-zinc-400">{hr(l)}</td>
                    <td className="px-3 py-3 text-right text-slate-500 dark:text-zinc-400">{l.startDate||"—"}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${l.endDate?"bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400":"bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"}`}>
                        {l.endDate ? "Closed" : "Active"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      {!l.endDate&&l.loanType!=="hard"&&(
                        <button onClick={e=>{e.stopPropagation();setMoveLoan(l);}} className="text-[11px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-teal-600 dark:hover:text-teal-400 whitespace-nowrap transition-colors">Move →</button>
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
  const h$=v=>prv?maskMoney($$p(v)):$$p(v);
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
        <div className="bg-teal-600 rounded-2xl p-4 text-white text-center">
          <div className="text-[9px] font-semibold text-teal-200 uppercase tracking-widest mb-2">On Deals</div>
          <div className="text-xl font-bold tabular-nums">{hc(totalDeployed)}</div>
          <div className="text-[10px] text-teal-200 mt-1">{rows.length} propert{rows.length===1?"y":"ies"}</div>
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
              className="w-full accent-teal-400 cursor-pointer"/>
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
          <div key={prop.id} className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1F2B] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
            <div className={`px-5 py-3.5 border-b border-black/[0.06] dark:border-white/[0.06] ${under?"bg-red-50/60 dark:bg-red-950/15":""}`}>
              <div className="flex justify-between items-center mb-2">
                <span className="font-semibold text-slate-900 dark:text-zinc-100">{prop.address}</span>
                {under&&<span className="text-red-600 dark:text-red-400 font-bold tabular-nums">-{h$(short)}</span>}
              </div>
              <div className="h-1.5 bg-slate-200 dark:bg-zinc-700 rounded-full overflow-hidden mb-1.5">
                <div className={`h-full rounded-full ${under?"bg-red-400":pct(funded,needed)>=95?"bg-emerald-500":"bg-teal-500"}`} style={{width:`${pct(funded,needed)}%`}}/>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className={`font-semibold tabular-nums ${under?"text-red-600 dark:text-red-400":"text-emerald-600 dark:text-emerald-400"}`}>{h$(funded)} funded</span>
                <span className="text-slate-400 dark:text-zinc-500 tabular-nums">{h$(needed)} needed</span>
              </div>
            </div>
            {loans.length>0&&(
              <div className="overflow-x-auto">
              <table className="w-full text-xs bg-white dark:bg-[#1C1F2B]">
                <tbody className="divide-y divide-black/[0.04] dark:divide-white/[0.04]">
                  {loans.map(l=>(
                    <tr key={l.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                      <td className="px-5 py-2.5 font-semibold text-slate-800 dark:text-zinc-100">{hn(l.lenderName)}</td>
                      <td className="px-3 py-2.5"><TypeLabel type={l.loanType}/></td>
                      <td className="px-3 py-2.5 text-right text-slate-600 dark:text-zinc-300 tabular-nums">{h$(l.principal)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400 dark:text-zinc-500 whitespace-nowrap">{hr(l)}</td>
                      <td className="px-5 py-2.5 text-right font-bold text-teal-700 dark:text-teal-400 tabular-nums">{h$(calcBalance(l))}</td>
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
const payoffTypeLabel = {
  paidOut:"💰 Paid Out", rollFull:"🔄 Rolled Full", rollPrincipal:"🔄 Principal Rolled (Nexus kept interest)",
  payInterest:"💸 Interest Paid, Principal Rolled", waiveInterest:"⚡ Interest Waived, Principal Rolled",
  custom:"✏️ Custom Split", alreadyPaid:"Already Paid (Early Close)",
};

// Mirrors MarkSoldModal field-for-field, panel-for-panel, so a closing can be corrected
// after the fact on the exact same form it was originally entered on — seeded from the
// saved closingData instead of live loan balances. The one piece intentionally removed is
// the disposition type itself (paid out / rolled / waived / custom) and the roll
// destination/new-start-date picker: choosing a disposition at close time creates or moves
// actual loan records (see handleMarkSold), and there's no stored link from a closed loan
// back to whatever it became, so replaying that safely after the fact isn't possible —
// re-picking it here would just relabel the record without moving anything, silently
// desyncing the app from what actually exists. Every dollar figure is still fully editable,
// including the per-lender overage refund the original form has (this was missing before).
function EditClosingModal({ prop, onSave, onClose }) {
  const cd=prop.closingData||{};
  const [step,setStep]=useState(1);
  const [dateSold,setDateSold]=useState(prop.dateSold||"");
  const [isRental,setIsRental]=useState(prop.isRental||false);
  const [locked,setLocked]=useState({});
  const toggleLock=k=>setLocked(l=>({...l,[k]:!l[k]}));

  // Loans settled exactly at this sale vs. ones already closed earlier (paid out early,
  // interest still charged to this deal) — same split MarkSoldModal made at close time,
  // reconstructed here from each loan's own endDate.
  const atSaleLoans=prop.loans.filter(l=>l.endDate&&l.endDate===prop.dateSold);
  const earlyClosedLoans=prop.loans.filter(l=>l.endDate&&l.endDate!==prop.dateSold);

  const [rows,setRows]=useState(()=>[
    ...atSaleLoans.map(l=>{
      const lp=(cd.lenderPayoffs||[]).find(p=>p.loanId===l.id)||{};
      // isMonthly comes from the loan's own paymentType, not lp.isMonthly — older closings
      // never saved that flag on the payoff record, which was silently hiding the title/
      // monthly interest split below for any deal closed before that flag existed.
      const isMonthly=l.paymentType==="monthly_rate"||l.paymentType==="monthly_fixed";
      // Recomputed fresh from the loan itself, same as isMonthly above — a split loan's
      // monthly-paid portion (real cash already received) is a fixed cost of the deal
      // regardless of what happens to the closing portion, edited or not.
      const monthlyPortionPaid=calcMonthlyPaidPortion(l,l.endDate);
      return {
        loanId:l.id,lenderName:l.lenderName,loanType:l.loanType,
        principal:l.principal||0,isMonthly,isPreClosed:false,monthlyPortionPaid,
        type:lp.type||"paidOut",
        principalPayoff:String(lp.principalPayoff??l.principal??0),
        interestPayoff:String(lp.interestPayoff??0),
        titleMoneyCosts:String(lp.titleInterestPayoff||""),
        lenderFees:String(lp.lenderFees??0),
        overageRefund:"0", // not stored per lender historically — only the combined total was saved
        paidAtTitle:lp.paidAtTitle||false,
        wireAmount:String(lp.wireAmount??0),
        customRolling:String(lp.principalPayoff??l.principal??0),
      };
    }),
    ...earlyClosedLoans.map(l=>{
      const lp=(cd.lenderPayoffs||[]).find(p=>p.loanId===l.id)||{};
      return {
        loanId:l.id,lenderName:l.lenderName,loanType:l.loanType,
        principal:l.principal||0,isMonthly:false,isPreClosed:true,type:"alreadyPaid",
        principalPayoff:"0",interestPayoff:String(lp.interestPayoff??0),
        titleMoneyCosts:"",lenderFees:String(lp.lenderFees??0),overageRefund:"0",
        paidAtTitle:false,wireAmount:"0",customRolling:"0",
      };
    }),
  ]);
  const upd=(loanId,patch)=>setRows(rs=>rs.map(r=>r.loanId===loanId?{...r,...patch}:r));

  // Same formula as MarkSoldModal's wireContrib — reconstructed from the recoverable stored
  // fields for every type except "custom", whose original split amount wasn't persisted;
  // that one falls back to the saved/editable wireAmount directly.
  const wireContrib=r=>{
    if(r.type==="alreadyPaid") return 0;
    if(r.paidAtTitle) return 0;
    const fees=parseFloat(r.lenderFees)||0;
    const principal=parseFloat(r.principalPayoff)||0;
    const interest=parseFloat(r.interestPayoff)||0;
    if(r.type==="paidOut"){ const intFromWire=r.isMonthly?0:interest; return principal+intFromWire+fees; }
    if(r.type==="rollFull") return principal+interest+fees;
    if(r.type==="rollPrincipal") return principal+fees;
    if(r.type==="waiveInterest") return principal+fees;
    if(r.type==="payInterest") return interest+fees;
    if(r.type==="custom") return parseFloat(r.wireAmount)||0;
    return 0;
  };
  const titleTotal=rows.reduce((s,r)=>{
    if(!r.paidAtTitle) return s;
    const principal=parseFloat(r.principalPayoff)||0;
    const fees=parseFloat(r.lenderFees)||0;
    const overage=parseFloat(r.overageRefund)||0;
    if(r.isMonthly) return s+principal+(parseFloat(r.titleMoneyCosts)||0)+fees+overage;
    return s+principal+(parseFloat(r.interestPayoff)||0)+fees+overage;
  },0);
  const lenderTotal=rows.reduce((s,r)=>s+wireContrib(r),0);
  const moneyCosts=Math.round(rows.reduce((s,r)=>{
    const fees=parseFloat(r.lenderFees)||0;
    const interest=parseFloat(r.interestPayoff)||0;
    const monthlyPaid=r.monthlyPortionPaid||0;
    if(r.type==="rollPrincipal"||r.type==="waiveInterest") return s+fees+monthlyPaid;
    if(r.isMonthly||r.type==="paidOut"||r.type==="payInterest"||r.type==="rollFull"||r.type==="alreadyPaid") return s+interest+fees+monthlyPaid;
    return s+fees+monthlyPaid;
  },0)*100)/100;

  const [cashToCloseIn,setCashToCloseIn]=useState(String(cd.cashToClose||""));
  const [rehabIn,setRehabIn]=useState(String(cd.rehab||""));
  const [miscIn,setMiscIn]=useState(String(cd.misc||""));
  const [wireIn,setWireIn]=useState(String(cd.wire||""));
  const guardedClose=useDirtyGuard(()=>({step,dateSold,isRental,rows,cashToCloseIn,rehabIn,miscIn,wireIn}),onClose);

  const cashToClose=parseFloat(cashToCloseIn)||0;
  const rehab=parseFloat(rehabIn)||0;
  const baseCosts=cashToClose+rehab+moneyCosts;
  const wire=parseFloat(wireIn)||0;
  const misc=parseFloat(miscIn)||0;
  const totalCosts=baseCosts+misc;
  const overageRefund=Math.round(rows.reduce((s,r)=>s+(parseFloat(r.overageRefund)||0),0)*100)/100;
  const nexusCapital=totalCosts-titleTotal-lenderTotal;
  const dealProfit=(wire+titleTotal)-totalCosts+overageRefund;
  const balanced=wire>0&&nexusCapital>=-0.01;

  const handleWireChange=v=>setWireIn(v);
  const handleMiscChange=v=>setMiscIn(v);

  const handleConfirm=()=>{
    const updatedPayoffs=rows.map(r=>({
      loanId:r.loanId,lenderName:r.lenderName,type:r.type,
      paidAtTitle:r.paidAtTitle||false,
      isMonthly:r.isMonthly||false,
      principalPayoff:parseFloat(r.principalPayoff)||0,
      interestPayoff:parseFloat(r.interestPayoff)||0,
      titleInterestPayoff:r.isMonthly&&r.paidAtTitle?(parseFloat(r.titleMoneyCosts)||0):0,
      lenderFees:parseFloat(r.lenderFees)||0,
      wireAmount:wireContrib(r),
      totalPayoff:(parseFloat(r.principalPayoff)||0)+(parseFloat(r.interestPayoff)||0)+(parseFloat(r.lenderFees)||0),
    }));
    onSave({dateSold,isRental,closingData:{
      ...cd,wire,cashToClose,rehab,moneyCosts,misc,totalCosts,
      overageRefund,profit:dealProfit,selfFunded:nexusCapital,titleTotal,
      lenderPayoffs:updatedPayoffs,
    }});
  };

  const inputCls="flex-1 border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-right text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500 tabular-nums";
  const autoCls="flex-1 border border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/50 rounded-lg px-3 py-2 text-sm text-right text-slate-400 dark:text-zinc-500 tabular-nums select-none";
  const labelCls="w-40 text-sm text-slate-600 dark:text-zinc-300 shrink-0 leading-tight";
  const numIn="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-teal-500 tabular-nums text-slate-800 dark:text-zinc-100";
  const autoNum="w-full border border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/50 rounded-lg px-3 py-2 text-sm text-right text-slate-400 dark:text-zinc-500 tabular-nums select-none";

  return (
    <Modal title={`Edit Closing: ${prop.address}`} onClose={guardedClose}>
      <div>

        {/* Step tabs */}
        <div className="flex gap-2 mb-5">
          {[["1 · Settle Lenders",1],["2 · Wire & Costs",2]].map(([label,s])=>(
            <button key={s} type="button" onClick={()=>setStep(s)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${s===step?"bg-teal-600 text-white":"bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-zinc-500"}`}>
              {label}
            </button>
          ))}
        </div>

        {/* ── Step 1: Settle Lenders ── */}
        {step===1&&(
          <div className="space-y-4">
            <Lockable locked={locked.dateSold} onToggle={()=>toggleLock("dateSold")}>
              <DateInp label="Date Sold" value={dateSold} onChange={setDateSold}/>
            </Lockable>

            <div>
              <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-3">Settle Lenders</div>
              {rows.filter(r=>!r.isPreClosed).length===0&&(
                <p className="text-sm text-slate-400 dark:text-zinc-500 text-center py-4">No lenders settled at this sale.</p>
              )}
              <div className="space-y-3">
                {rows.filter(r=>!r.isPreClosed).map(r=>{
                  const calcInterest=r.isMonthly?0:(parseFloat(r.interestPayoff)||0);
                  const calcPayoff=(parseFloat(r.principalPayoff)||0)+(parseFloat(r.interestPayoff)||0);
                  const autoWireForCustom=Math.max(0,calcPayoff-(parseFloat(r.customRolling)||0));
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
                          {calcInterest>0&&<div>Accrued Int: {$$p(calcInterest)}</div>}
                          <div className="font-semibold text-slate-600 dark:text-zinc-300">Payoff: {$$p(calcPayoff)}</div>
                        </div>
                      </div>

                      {r.monthlyPortionPaid>0.01&&(
                        <div className="mb-3 -mt-1 text-[11px] text-slate-500 dark:text-zinc-400">
                          Plus {$$p(r.monthlyPortionPaid)} already paid monthly — separate from the payoff above, already a cost of this deal regardless of disposition
                        </div>
                      )}

                      {/* Disposition — set at closing, not editable here; see note at top of file */}
                      <div className="mb-3">
                        <label className="block text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-1.5">Disposition</label>
                        <div className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/60 rounded-lg px-3 py-2 text-sm text-slate-500 dark:text-zinc-400">
                          {payoffTypeLabel[r.type]||r.type}
                        </div>
                      </div>

                      {/* paidOut: full principal / interest / fees breakdown */}
                      {r.type==="paidOut"&&(
                        <div className="space-y-2 mb-3 p-3 bg-slate-50 dark:bg-zinc-800/40 rounded-lg">
                          <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Payoff Breakdown</div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Principal</div>
                              <MoneyField value={r.principalPayoff} onChange={v=>upd(r.loanId,{principalPayoff:v})} className={numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">
                                {r.isMonthly?"Total Interest (full period)":"Interest"}
                              </div>
                              <MoneyField value={r.interestPayoff} onChange={v=>upd(r.loanId,{interestPayoff:v})}
                                className={r.isMonthly?"w-full border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-amber-400 tabular-nums text-amber-700 dark:text-amber-400":numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Lender Fees</div>
                              <MoneyField value={r.lenderFees} onChange={v=>upd(r.loanId,{lenderFees:v})} className={numIn}/>
                            </div>
                          </div>
                          {r.isMonthly&&!r.paidAtTitle&&<p className="text-[10px] text-amber-600 dark:text-amber-400">Total interest over hold period — not deducted from closing wire</p>}
                          {r.isMonthly&&r.paidAtTitle&&(
                            <div className="mt-2 pt-2 border-t border-amber-200 dark:border-amber-800/40 space-y-2">
                              <div className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-widest">Of that interest, split:</div>
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <div className="text-[10px] text-amber-600 dark:text-amber-400 mb-1">Prorated interest from title</div>
                                  <MoneyField value={r.titleMoneyCosts} onChange={v=>upd(r.loanId,{titleMoneyCosts:v})} className={numIn}/>
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
                              <MoneyField value={r.interestPayoff} onChange={v=>upd(r.loanId,{interestPayoff:v})} className={numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Lender Fees</div>
                              <MoneyField value={r.lenderFees} onChange={v=>upd(r.loanId,{lenderFees:v})} className={numIn}/>
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
                              <MoneyField value={r.customRolling} onChange={v=>upd(r.loanId,{customRolling:v})} className={numIn}/>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">From Wire</div>
                              <div className={autoNum}>{$$p(autoWireForCustom)}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Lender Fees</div>
                              <MoneyField value={r.lenderFees} onChange={v=>upd(r.loanId,{lenderFees:v})} className={numIn}/>
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
                              {$$p(r.type==="rollFull"?calcPayoff:r.principal)}
                              {r.type==="rollPrincipal"&&<span className="text-[10px] font-normal text-slate-400 dark:text-zinc-500 ml-1">(principal; Nexus keeps int)</span>}
                              {r.type==="waiveInterest"&&<span className="text-[10px] font-normal text-slate-400 dark:text-zinc-500 ml-1">(principal; interest forgiven)</span>}
                            </span>
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-400 dark:text-zinc-500 mb-1">Misc Fees from Wire (if any)</div>
                            <MoneyField value={r.lenderFees} onChange={v=>upd(r.loanId,{lenderFees:v})} placeholder="0" className={numIn}/>
                          </div>
                        </div>
                      )}

                      {/* Overage refund (post-close) */}
                      <div className="mt-3 pt-3 border-t border-slate-100 dark:border-zinc-800">
                        <div className="flex items-center gap-3">
                          <div className="text-[10px] text-slate-400 dark:text-zinc-500 leading-tight">Overage Refund<br/><span className="text-[9px]">(post-close, from this lender)</span></div>
                          <MoneyField value={r.overageRefund} onChange={v=>upd(r.loanId,{overageRefund:v})} placeholder="0" className={numIn}/>
                        </div>
                        <p className="text-[9px] text-slate-400 dark:text-zinc-500 mt-1">Only if THIS lender is refunding an overage as part of closing. A later insurance/tax/overcharge check unrelated to a specific lender belongs in "Overage Check" on the property page instead — don't enter the same refund in both places.</p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Pre-closed loans — interest paid out early, still a cost of this deal */}
              {earlyClosedLoans.length>0&&(
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
                          <MoneyField value={r.interestPayoff}
                            onChange={v=>upd(r.loanId,{interestPayoff:v})}
                            className="flex-1 border border-orange-200 dark:border-orange-800/50 bg-white dark:bg-zinc-800 rounded-lg px-3 py-1.5 text-sm text-right text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-orange-400 tabular-nums"/>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Step 1 summary: lenders + project costs */}
            {(()=>{
              const estC2C=parseFloat(prop.purchasePrice)||cashToClose;
              const estRehab=parseFloat(prop.rehabBudget)||rehab;
              const estMoney=moneyCosts;
              const estMisc=misc||Math.round((prop.monthlyHolding??500)*effectiveMonths(prop));
              const estCosts=estC2C+estRehab+estMoney+estMisc;
              const minWire=estCosts-titleTotal;
              return (
                <div className="rounded-xl bg-slate-50 dark:bg-zinc-800/30 border border-slate-200 dark:border-zinc-700 px-4 py-4 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500 dark:text-zinc-400">Lenders (from wire)</span>
                    <span className="font-semibold tabular-nums text-slate-700 dark:text-zinc-200">{$$p(lenderTotal)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-500 dark:text-zinc-400">Project costs</span>
                    <span className="font-semibold tabular-nums text-slate-700 dark:text-zinc-200">{$$p(estCosts)}</span>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-zinc-700">
                    <span className="text-sm font-bold text-slate-700 dark:text-zinc-200">Break-even wire</span>
                    <span className="font-bold text-base tabular-nums text-slate-900 dark:text-zinc-100">{$$p(minWire)}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 dark:text-zinc-500">The wire amount that covers everything above with $0 profit — enter more for a profit, less for a loss.</div>
                </div>
              );
            })()}

            <div className="flex gap-2 pt-1">
              <Btn onClick={()=>setStep(2)} color="navy" full>Next: Wire &amp; Costs →</Btn>
              <Btn onClick={guardedClose} color="ghost">Cancel</Btn>
            </div>
          </div>
        )}

        {/* ── Step 2: Wire & Costs ── */}
        {step===2&&(
          <div className="space-y-5 pb-2">

            {/* Lender reference from step 1 */}
            <div className="rounded-xl bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-800 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-semibold text-teal-500 dark:text-teal-400 uppercase tracking-widest">Lender Settlements (Step 1)</div>
                <div className="text-right">
                  {titleTotal>0&&<div className="text-[10px] text-amber-600 dark:text-amber-400 tabular-nums">🏛 Title: {$$p(titleTotal)}</div>}
                  <div className="font-bold text-lg tabular-nums text-teal-700 dark:text-teal-300">Wire: {$$p(lenderTotal)}</div>
                </div>
              </div>
              <div className="text-[11px] text-teal-600 dark:text-teal-400 space-y-0.5">
                {rows.filter(r=>!r.isPreClosed).map(r=>{
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
                  <LockableInline locked={locked.cashToClose} onToggle={()=>toggleLock("cashToClose")} className="flex-1">
                    <MoneyField value={cashToCloseIn} onChange={setCashToCloseIn} className={inputCls}/>
                  </LockableInline>
                </div>
                <div className="flex items-center gap-3">
                  <span className={labelCls}>Rehab</span>
                  <LockableInline locked={locked.rehab} onToggle={()=>toggleLock("rehab")} className="flex-1">
                    <MoneyField value={rehabIn} onChange={setRehabIn} className={inputCls}/>
                  </LockableInline>
                </div>
                <div className="flex items-center gap-3">
                  <span className={labelCls}>Money Costs <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-normal">(from step 1)</span></span>
                  <div className={autoCls} title="Auto-derived from lender interest in step 1">{$$p(moneyCosts)}</div>
                  <button type="button" onClick={()=>setStep(1)} className="shrink-0 text-[10px] font-semibold text-teal-500 dark:text-teal-400 hover:text-teal-700 dark:hover:text-teal-300 transition-colors whitespace-nowrap">edit ↑</button>
                </div>
                <div className="flex items-center gap-3">
                  <span className={labelCls}>Misc <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-normal">(utilities, insurance)</span></span>
                  <LockableInline locked={locked.misc} onToggle={()=>toggleLock("misc")} className="flex-1">
                    <MoneyField value={miscIn} onChange={handleMiscChange} className={inputCls}/>
                  </LockableInline>
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
              <LockableInline locked={locked.wire} onToggle={()=>toggleLock("wire")} className="flex-1">
                <MoneyField value={wireIn} onChange={handleWireChange} placeholder="0"
                    className="w-full border-2 border-teal-400 dark:border-teal-600 bg-white dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-right font-bold text-teal-700 dark:text-teal-400 focus:outline-none focus:ring-2 focus:ring-teal-500 tabular-nums"/>
              </LockableInline>
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
                <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-1">Break-even wire (the amount that covers costs with $0 profit): {$$p(baseCosts-titleTotal)}</div>
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
            {!balanced&&(
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {wire<=0?"Enter the wire amount above before saving — Save is disabled until then.":"Nexus Self-Funding went negative — lenders + title took more than the total costs cover. Double-check the wire, title, and lender payoff amounts above before saving."}
              </p>
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
              {balanced
                ? <Btn onClick={handleConfirm} color="navy" full>✓ Save Changes</Btn>
                : <Btn onClick={()=>{if(window.confirm("The numbers here don't balance — save anyway? Double-check this is really what you want before continuing."))handleConfirm();}} color="ghost" full>⚠ Save Anyway — Unbalanced</Btn>
              }
              <Btn onClick={()=>setStep(1)} color="ghost">← Back</Btn>
              <Btn onClick={onClose} color="ghost">Cancel</Btn>
            </div>
          </div>
        )}

      </div>
    </Modal>
  );
}

// ─── Closed Deals ─────────────────────────────────────────────────────────────
// Closed Deals card — hoisted out of ClosedDealsPage's render so its identity is stable
// across renders (was redefined, and thus fully remounted, on every parent re-render).
const PropCard=({prop,isOpen,h$,hs,hn,hr,onOpenPanel,onToggleRental,onToggleExpand,onEdit,onReopen})=>{
  const cd=prop.closingData;
  const profit=cd?effectiveProfit(prop):null;
  return(
    <div className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1F2B] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <button onClick={()=>onOpenPanel({type:'property',propId:prop.id})} className="font-semibold text-slate-900 dark:text-zinc-100 truncate hover:text-teal-600 dark:hover:text-teal-400 transition-colors text-left">{prop.address||"Unnamed"}</button>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-[11px] text-slate-400 dark:text-zinc-500">Sold {prop.dateSold}</span>
              <button
                onClick={e=>{e.stopPropagation();onToggleRental(prop.id);}}
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
            <button onClick={()=>onEdit(prop)}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 dark:text-zinc-600 hover:text-teal-500 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-all text-sm" title="Edit closing">✏️</button>
            <button onClick={()=>onReopen(prop)}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 dark:text-zinc-600 hover:text-amber-500 dark:hover:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-all text-sm" title="Reopen property">↺</button>
            <button onClick={()=>onToggleExpand(prop.id)}
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
                    <td className="py-2 font-semibold text-slate-800 dark:text-zinc-100"><button onClick={()=>onOpenPanel({type:'lender',name:l.lenderName})} className="hover:text-teal-600 dark:hover:text-teal-400 transition-colors text-left">{hn(l.lenderName)}</button></td>
                    <td className="py-2 text-right tabular-nums text-slate-700 dark:text-zinc-200">{h$(l.principal)}</td>
                    <td className="py-2 text-right tabular-nums text-slate-500 dark:text-zinc-400">{hr(l)}</td>
                    <td className="py-2 text-right"><TypeLabel type={l.loanType}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          }
          {(prop.overageChecks||[]).length>0&&(
            <div className="mt-4">
              <div className="text-[10px] font-semibold text-amber-500 dark:text-amber-400 uppercase tracking-widest mb-2">Overage Checks</div>
              <div className="space-y-1.5">
                {prop.overageChecks.map(c=>(
                  <div key={c.id} className="flex items-center justify-between gap-2 text-xs bg-amber-50/60 dark:bg-amber-950/10 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <span className="font-semibold text-slate-700 dark:text-zinc-200">{overageSourceLabel(c.source)}</span>
                      <span className="text-slate-400 dark:text-zinc-500"> · {c.date}</span>
                      {c.notes&&<div className="text-[11px] text-slate-400 dark:text-zinc-500 truncate">{c.notes}</div>}
                    </div>
                    <span className="tabular-nums font-semibold text-emerald-600 dark:text-emerald-400 shrink-0">+{h$(c.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function ClosedDealsPage({ data, update }) {
  const prv=usePrivacy();
  const openPanel=usePanel();
  const h$=v=>prv?maskMoney($$p(v)):$$p(v);
  const hc=v=>prv?maskMoney($$c(v)):$$c(v);
  const hs=v=>prv?maskMoney($$ps(v)):$$ps(v);
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
  const [closeSearch,setCloseSearch]=useState("");

  const toggle=id=>setExpanded(e=>({...e,[id]:!e[id]}));
  const toggleRental=id=>{
    const prop=data.properties.find(p=>p.id===id);
    if(!prop) return;
    const msg=prop.isRental
      ? `Move "${prop.address||"this property"}" back to Flips? It'll disappear from the Rentals list and show up under Flips instead.`
      : `Mark "${prop.address||"this property"}" as a Rental? It'll disappear from the Flips list and show up under Rentals instead.`;
    if(!window.confirm(msg)) return;
    update(d=>({...d,properties:d.properties.map(p=>p.id===id?{...p,isRental:!p.isRental}:p)}));
  };

  // Reopening only clears the property's own sale/closing record — loans that were closed
  // out as part of this sale (endDate set, principal rolled elsewhere, etc.) are left alone,
  // since reconstructing exactly how each one should unwind isn't something that can be done
  // safely/automatically. If those need to move too, that's a manual follow-up on each loan.
  const reopenProperty=prop=>{
    if(!window.confirm(`Reopen "${prop.address||"this property"}"? It'll move back to Active Properties and its closing record will be cleared — you'll re-enter closing details if you close it again. Loans that were paid off or rolled as part of this sale are NOT reopened; adjust those individually if needed.`)) return;
    update(d=>({...d,properties:d.properties.map(p=>p.id===prop.id?{...p,dateSold:null,isRental:false,closingData:null}:p)}));
  };

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
      const entry={id:uid(),lenderName:loan.lenderName,loanType:loan.loanType,principal:np,startDate:d.newStartDate||soldDate,interestRate:d.newRate!==""?parseFloat(d.newRate):(loan.interestRate||0),interestType:d.interestType||loan.interestType||"percentage",paymentType:d.paymentType||loan.paymentType||"closing",splitMonthlyRate:(d.paymentType||loan.paymentType)==="monthly_rate_split"?(d.splitMonthlyRate??loan.splitMonthlyRate??0):null,specialTerms:d.specialTerms||loan.specialTerms||"",endDate:null};
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
        if(sortMode==="profit")return d*(effectiveProfit(a)-effectiveProfit(b));
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
  const avgProfit=Math.round(withData.reduce((s,p)=>s+effectiveProfit(p),0)/n);
  const totalProfit=withData.reduce((s,p)=>s+effectiveProfit(p),0);

  return(
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Closed Deals</h2>
        </div>
        <div className="relative">
          <button onClick={()=>{setShowClosePicker(v=>!v);setCloseSearch("");}}
            className="text-[12px] font-semibold text-white bg-teal-600 hover:bg-teal-700 dark:bg-teal-500 dark:hover:bg-teal-400 rounded-xl px-3.5 py-2 transition-colors whitespace-nowrap shadow-sm">
            + Close a Property
          </button>
          {showClosePicker&&(
            <div className="absolute right-0 top-full mt-2 bg-white dark:bg-[#262A38] rounded-2xl shadow-2xl border border-black/[0.08] dark:border-white/[0.08] z-30 min-w-[220px] overflow-hidden">
              {activeProps.length===0?(
                <div className="px-4 py-3 text-sm text-slate-400 dark:text-zinc-500 text-center">No active properties to close</div>
              ):(
                <>
                  <div className="px-4 pt-3 pb-1.5 text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-widest">Pick a property to close</div>
                  {activeProps.length>1&&(
                    <div className="px-3 pb-2">
                      <input type="text" value={closeSearch} onChange={e=>setCloseSearch(e.target.value)} placeholder="Search properties…" autoFocus
                        className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-teal-500"/>
                    </div>
                  )}
                  <div className="max-h-72 overflow-y-auto">
                    {activeProps.filter(p=>!closeSearch||p.address?.toLowerCase().includes(closeSearch.toLowerCase())).map(p=>(
                      <button key={p.id} onClick={()=>{setCloseModal(p);setShowClosePicker(false);}}
                        className="w-full text-left px-4 py-2.5 text-sm font-medium text-slate-800 dark:text-zinc-100 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors border-t border-black/[0.04] dark:border-white/[0.04] first:border-t-0">
                        {p.address||"Unnamed Property"}
                      </button>
                    ))}
                    {closeSearch&&activeProps.filter(p=>p.address?.toLowerCase().includes(closeSearch.toLowerCase())).length===0&&(
                      <div className="px-4 py-3 text-xs text-slate-400 dark:text-zinc-500 text-center">No matches</div>
                    )}
                  </div>
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
          <div className="bg-teal-600 rounded-2xl p-4 text-center text-white">
            <div className="text-[9px] font-semibold text-teal-200 uppercase tracking-widest mb-2">Avg Cash to Close</div>
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
        {vis.map(prop=><PropCard key={prop.id} prop={prop} isOpen={!!expanded[prop.id]} h$={h$} hs={hs} hn={hn} hr={hr}
          onOpenPanel={openPanel} onToggleRental={toggleRental} onToggleExpand={toggle} onEdit={setEditModal} onReopen={reopenProperty}/>)}
      </div>

      {/* Modals */}
      {editModal&&<EditClosingModal prop={editModal} onSave={updates=>handleEditSave(editModal,updates)} onClose={()=>setEditModal(null)}/>}
      {closeModal&&<MarkSoldModal prop={closeModal} allProperties={data.properties} onConfirm={(d,disp,cd,ir)=>handleMarkSold(closeModal,d,disp,cd,ir)} onClose={()=>setCloseModal(null)}/>}
    </div>
  );
}

// ─── History ──────────────────────────────────────────────────────────────────
// Sortable table header cell for HistoryPage's loan ledger — pure/props-only.
const SortHd=({col,label,sort,onSort})=>{
  const active=sort.col===col;
  return<button onClick={()=>onSort(col)} className={`text-left text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded transition-colors ${active?"text-teal-600 dark:text-teal-400":"text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300"}`}>{label}{active?(sort.dir==="desc"?" ↓":" ↑"):""}</button>;
};

function HistoryPage({ data }) {
  const prv=usePrivacy();
  const openPanel=usePanel();
  const h$=v=>prv?maskMoney($$p(v)):$$p(v);
  const hs=v=>prv?maskMoney($$ps(v)):$$ps(v);
  const hn=n=>n??"";
  const [view,setView]=usePersistedState("nx-histView","trail");
  const [lf,setLf]=usePersistedState("nx-histLender","all");
  const [tf,setTf]=usePersistedState("nx-histType","all");
  const [propSearch,setPropSearch]=useState("");
  const [ledgerSort,setLedgerSort]=usePersistedState("nx-ledgerSort",{col:"endDate",dir:"desc"});
  // Rebuilding the whole event ledger (every loan start/close/rollover/overage check plus
  // every recurring monthly payment, for every property) is real work — memoize it against
  // `data` so typing in the lender/type/search filters below doesn't redo it on every key.
  const events=useMemo(()=>{
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
        // A monthly-paid loan's payoff (calcBalance) is principal-only, since interest is
        // normally settled month to month — but a property can sell mid-month, and any
        // prorated last-partial-month interest Title pays directly gets recorded on the
        // closing as titleInterestPayoff. Fold that in here so it doesn't show as $0.
        const titleInterest=disp?.titleInterestPayoff||0;
        // waiveInterest: interest forgiven, principal unchanged — show principal only as amount
        const dispAmt=disp?.type==="waiveInterest"?loan.principal:finBal+titleInterest;
        raw.push({date:end,sx:"a",lender:loan.lenderName,loanType:loan.loanType,interestType:loan.interestType||"percentage",etype,disposition:disp?.type||null,amount:dispAmt,principal:loan.principal||0,interest:(finBal-(loan.principal||0))+titleInterest,property:prop.address,propId:prop.id,rate:loan.interestRate||0,loanId:loan.id});
      }
    });
    if(prop.dateSold&&prop.closingData){
      raw.push({date:prop.dateSold,sx:"c",etype:"saleSummary",property:prop.address,propId:prop.id,closingData:prop.closingData,overageChecks:prop.overageChecks||[],loanId:`sale-${prop.id}`});
    }
    (prop.overageChecks||[]).forEach(c=>{
      raw.push({date:c.date,sx:"d",etype:"overageCheck",property:prop.address,propId:prop.id,amount:c.amount||0,source:c.source,notes:c.notes||"",loanId:`overage-${c.id}`});
    });
  });
  // Same calendar date N months later, with the day clamped to that month's length
  // (Jan 31 + 1 month -> Feb 28/29, not an overflow into March).
  const monthsLater = (y,m,d,n) => {
    let nm = m + n;
    const ny = y + Math.floor((nm-1)/12);
    nm = ((nm-1)%12)+1;
    const lastDay = new Date(ny, nm, 0).getDate();
    return `${ny}-${String(nm).padStart(2,'0')}-${String(Math.min(d,lastDay)).padStart(2,'0')}`;
  };
  // Interest is requested/prorated as of the 1st, but the bank doesn't move money on a
  // weekend — if the 1st is a Sat/Sun, it actually posts the next Monday. Purely a
  // display-date shift for the bookkeeper; proration always uses the 1st itself.
  const firstBusinessDay = dateStr => {
    const [y,m,d] = dateStr.split('-').map(Number);
    const dow = new Date(y,m-1,d).getDay();
    const add = dow===6 ? 2 : dow===0 ? 1 : 0;
    const dt = new Date(y,m-1,d+add);
    return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  };
  // Recurring monthly interest payments, due the 1st of every month the loan was active
  // — generated for the loan's whole life (past through today) so bookkeepers can map
  // every payment, not just the loan's start/close events. Any loan can be set up with
  // monthly-paid interest, private or hard money, so this isn't restricted by loanType
  // (a loanType==="hard" restriction here previously caused every monthly-paid PRIVATE
  // loan to be silently skipped). Actual billing mechanics (grace period, day-count basis,
  // flat vs. per-diem monthly amount, whether the first month is prepaid at closing, a
  // per-draw fee) come from the lender's own Payment Settings — editable on their page —
  // and default to exactly this function's original behavior when unset.
  const addHardPayments = (loan, propAddress, propId) => {
    if (!loan.startDate) return;
    const pt = loan.paymentType||"closing";
    if (pt!=="monthly_rate"&&pt!=="monthly_fixed"&&pt!=="monthly_rate_split") return;
    const endBound = loan.endDate || TODAY;
    const [sy,sm,sd] = loan.startDate.split('-').map(Number);
    const settings = resolveLenderSettings(data, loan.lenderName, loan.loanType);
    // A split loan (e.g. an equity-line lender) only pays the matched portion of the rate
    // monthly — the rest accrues onto the balance and is settled at closing instead, so
    // these recurring cash payments should bill against that portion, not the full rate.
    const billRate = pt==="monthly_rate_split" ? (loan.splitMonthlyRate||0) : (loan.interestRate||0);
    const dailyRate = billRate/100/settings.dayCountBasis;
    const flatMonthly = pt==="monthly_fixed" ? (loan.monthlyPayment||0) : (loan.principal||0)*billRate/1200;
    // One-time $ fee for each draw whose date falls in [periodStart, periodEnd) — half-open
    // so a draw dated exactly on a schedule boundary is counted in exactly one period.
    const feeFor = (periodStart, periodEndExclusive) =>
      (loan.drawFacility?.draws||[]).filter(d=>d.date&&d.date>=periodStart&&d.date<periodEndExclusive).length*(settings.drawFee||0);
    const pushPayment = (dateStr, amount) => {
      amount = Math.round(amount*100)/100; // to the cent, not the whole dollar — needed to match a bank statement
      if (amount>0) {
        raw.push({date:firstBusinessDay(dateStr), sx:"m", lender:loan.lenderName, loanType:loan.loanType, interestType:loan.interestType||"percentage", etype:"hardPayment", amount, principal:loan.principal||0, property:propAddress, propId, rate:billRate, loanId:`${loan.id}-pay-${dateStr}`});
      }
    };

    if (settings.prorateStubAtClosing) {
      // The prorated stub (closing day through end of that month) is charged at closing,
      // outside the recurring cycle. On top of that, up to one extra calendar month can be
      // skipped before regular billing starts: firstFullMonthAtClosing means that month is
      // ALSO prepaid at closing, while graceMonth means it's simply not charged at all (a
      // true grace period) — the two are independent and can combine. Either way, the
      // regular cycle only covers calendar months that weren't already accounted for, and
      // always bills in arrears — the 1st pays for the month that just ended, same as every
      // other lender — so a skipped month can mean the following 1st has nothing due at all.
      const skip = 1 + (settings.firstFullMonthAtClosing?1:0) + (settings.graceMonth?1:0);
      let cy=sy, cm=sm+skip; while(cm>12){cm-=12;cy+=1;}
      let prevDate = `${cy}-${String(cm).padStart(2,'0')}-01`; // start of the first period not already prepaid
      while (true) {
        const periodStart = `${cy}-${String(cm).padStart(2,'0')}-01`;
        // Arrears means the bill posts a month AFTER the period it covers — so whether an
        // entry belongs in History has to check the bill date against endBound, not the
        // period's own start. Checking periodStart here let an already-passed period whose
        // bill hadn't posted yet (e.g. today is Sept 15, period is September, bill is Oct 1)
        // show up as a future-dated "payment" that hasn't happened.
        let billY=cy, billM=cm+1; if(billM>12){billM=1;billY+=1;} // always arrears
        const dateStr = `${billY}-${String(billM).padStart(2,'0')}-01`;
        if (dateStr>endBound) break;
        const lastDay = new Date(cy,cm,0).getDate();
        let amount = settings.monthlyMethod==="flat" ? flatMonthly : (loan.principal||0)*dailyRate*lastDay;
        // A draw dated before this period (e.g. taken the same day as closing) is clamped
        // to start accruing at prevDate rather than dropped — its own closing-time stub is
        // assumed covered the same way the base loan's was, but every dollar from prevDate
        // forward still has to show up in a payment somewhere.
        (loan.drawFacility?.draws||[]).forEach(d=>{
          if (!d.date||d.date>=periodStart) return;
          const drawStart = d.date>prevDate ? d.date : prevDate;
          amount += settings.monthlyMethod==="flat" ? (d.amount||0)*billRate/1200 : (d.amount||0)*dailyRate*daysBetween(drawStart,periodStart);
        });
        pushPayment(dateStr, amount+feeFor(prevDate,periodStart));
        prevDate = periodStart;
        cm+=1; if(cm>12){cm=1;cy+=1;}
      }
      return;
    }

    // Standard model: optional grace month (no payment due until the loan's one-month
    // anniversary — see settings.graceMonth), then a prorated catch-up first payment, then
    // regular payments computed per-diem (actual days that month) or flat (rate/12 flat
    // every time), per settings.monthlyMethod.
    const firstDue = settings.graceMonth ? monthsLater(sy,sm,sd,1) : loan.startDate;
    let cy=sy, cm=sm+1; if(cm>12){cm=1;cy+=1;}
    const schedule=[];
    while (true) {
      const dateStr = `${cy}-${String(cm).padStart(2,'0')}-01`;
      if (dateStr>endBound) break;
      if (dateStr>=firstDue) schedule.push(dateStr);
      cm+=1; if(cm>12){cm=1;cy+=1;}
    }
    let prevDate = loan.startDate;
    schedule.forEach(dateStr=>{
      const days = daysBetween(prevDate,dateStr);
      let amount;
      if (settings.monthlyMethod==="flat") {
        amount = flatMonthly;
        (loan.drawFacility?.draws||[]).forEach(d=>{
          if (!d.date||d.date>=dateStr||d.date<prevDate) return;
          amount += (d.amount||0)*billRate/1200;
        });
      } else if (pt==="monthly_fixed") {
        amount = (loan.monthlyPayment||0)*days/30.44;
      } else {
        amount = (loan.principal||0)*dailyRate*days;
        // Rehab draw facility: each draw accrues its own interest from its actual draw
        // date (not the loan's origination date), folded into the same 1st-of-month
        // payment as the base principal.
        (loan.drawFacility?.draws||[]).forEach(d=>{
          if (!d.date||d.date>=dateStr) return;
          const drawStart = d.date>prevDate ? d.date : prevDate;
          amount += (d.amount||0)*dailyRate*daysBetween(drawStart,dateStr);
        });
      }
      pushPayment(dateStr, amount+feeFor(prevDate,dateStr));
      prevDate = dateStr;
    });
  };
  data.properties.forEach(prop=>{
    prop.loans.forEach(loan=>addHardPayments(loan, prop.address, prop.id));
  });
  // Also generate for unassigned monthly-paid loans — money that's still sitting
  // unplaced but already accruing/paying interest was being skipped entirely before.
  (data.unassigned||[]).forEach(loan=>addHardPayments(loan, "Unassigned", null));
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
  // Running outstanding-principal balance per lender (all properties) and per
  // lender+property (for hard money, which is tracked per deal, not pooled).
  const outstanding={},outstandingByProp={};
  const mapped=raw.map(ev=>{
    lp[ev.lender]=lp[ev.lender]??0;lc[ev.lender]=lc[ev.lender]??0;
    let nc,pp;
    if(ev.etype==="saleSummary"){nc=ev.closingData?.profit??0;}
    else if(ev.etype==="overageCheck"){nc=ev.amount||0;} // post-close cash in, not tied to any lender
    else if(ev.etype==="hardPayment"){nc=0;} // interest paid, principal outstanding unchanged
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
    if(ev.etype!=="saleSummary"&&ev.etype!=="overageCheck"){
      outstanding[ev.lender]=(outstanding[ev.lender]||0)+nc;
      const propKey=`${ev.lender}||${ev.propId??"unassigned"}`;
      outstandingByProp[propKey]=(outstandingByProp[propKey]||0)+nc;
    }
    return{...ev,nc,pp,cumLent:lc[ev.lender],
      runningTotal:outstanding[ev.lender],
      runningTotalThisProperty:outstandingByProp[`${ev.lender}||${ev.propId??"unassigned"}`]};
  });
  return mapped;
  },[data]);
  const allL=[...new Set(events.map(e=>e.lender))].sort();
  const filtered=events.filter(e=>{
    if(lf!=="all"&&e.lender!==lf)return false;
    if(tf!=="all"&&e.loanType!==tf)return false;
    if(!propSearch)return true;
    const q=propSearch.toLowerCase();
    return[e.property,e.lender,e.date,e.etype,e.loanType,e.disposition,e.interestType,e.source,e.notes].filter(Boolean).join(" ").toLowerCase().includes(q);
  });
  // Combine same-day, same-lender, same-type events (e.g. one loan split across several
  // properties all starting/closing the same day) into a single row, listing every
  // property underneath instead of repeating a near-identical row per piece.
  const groupedTrail = (() => {
    const groups=new Map();
    filtered.forEach(ev=>{
      // Hard money stays scoped per-property even when grouping (its running total is
      // per-house, not pooled), so it only groups with same-day/type events on the SAME
      // property. Private money can still combine across properties (e.g. one loan split
      // several ways the same day).
      const key = (ev.etype==="saleSummary"||ev.etype==="overageCheck") ? `solo-${ev.loanId}`
        : ev.loanType==="hard" ? `${ev.lender}||${ev.date}||${ev.etype}||${ev.propId??"unassigned"}`
        : `${ev.lender}||${ev.date}||${ev.etype}`;
      if(!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(ev);
    });
    return [...groups.entries()].map(([key,group])=>{
      if(group.length===1) return group[0];
      const first=group[0];
      const last=group[group.length-1];
      const sameRate = group.every(e=>e.rate===first.rate&&e.interestType===first.interestType);
      const sameProp = group.every(e=>e.propId===first.propId);
      return {
        ...first,
        _group: group,
        amount: group.reduce((s,e)=>s+(e.amount||0),0),
        nc: group.reduce((s,e)=>s+(e.nc||0),0),
        principal: group.reduce((s,e)=>s+(e.principal||0),0),
        interest: group.reduce((s,e)=>s+(e.interest||0),0),
        pp: group.reduce((s,e)=>s+(e.pp||0),0),
        rate: sameRate ? first.rate : null,
        property: sameProp ? first.property : `${group.length} properties`,
        propId: sameProp ? first.propId : null,
        runningTotal: last.runningTotal,
        runningTotalThisProperty: last.runningTotalThisProperty,
        loanId: `group-${key}`,
      };
    });
  })();
  const inCls="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400";
  const outCls="bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400";
  const cfg={
    start:       {label:"Loan Started",  icon:"↙", cls:inCls},
    closed:      {label:"Paid Back",     icon:"↗", cls:outCls},
    sold:        {label:"Paid Back",     icon:"↗", cls:outCls},
    saleSummary: {label:"Sale Closed",   icon:"↙", cls:inCls},
    rolled:      {label:"Rolled",        icon:"↙", cls:inCls},
    hardPayment: {label:"Interest Payment",icon:"↗",cls:outCls},
    overageCheck:{label:"Overage Check", icon:"💰", cls:inCls},
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
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">History</h2>
        <span className="text-xs font-semibold text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 px-2.5 py-1 rounded-full">{view==="trail"?`${groupedTrail.length} events`:`${ledgerRows.length} loans`}</span>
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
          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-teal-500">
          <option value="all">All Lenders</option>
          {(view==="trail"?allL:allLedgerLenders).map((l,i)=><option key={l} value={l}>{prv?`Lender ${i+1}`:l}</option>)}
        </select>
        <select value={tf} onChange={e=>setTf(e.target.value)}
          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-teal-500">
          <option value="all">All Types</option><option value="private">Private</option><option value="hard">Hard</option>
        </select>
        {view==="trail"&&<input type="text" value={propSearch} onChange={e=>setPropSearch(e.target.value)}
          placeholder="Search address, lender, date…" className={SEARCH_CLS}/>}
      </div>
      {view==="ledger"&&(
        <div>
          {!ledgerRows.length&&<div className="text-center py-16 text-slate-400 dark:text-zinc-500"><div className="text-5xl mb-3">🗂</div><p className="font-semibold">No closed loans yet</p></div>}
          {ledgerRows.length>0&&(
            <div className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1F2B] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
              <div className="grid grid-cols-[1fr_1fr_auto_auto_auto_auto] gap-x-3 px-5 py-2 border-b border-black/[0.06] dark:border-white/[0.06] bg-slate-50 dark:bg-zinc-800/50">
                <SortHd col="lenderName" label="Lender" sort={ledgerSort} onSort={toggleSort}/>
                <SortHd col="property" label="Property" sort={ledgerSort} onSort={toggleSort}/>
                <SortHd col="endDate" label="Dates" sort={ledgerSort} onSort={toggleSort}/>
                <SortHd col="principal" label="Principal" sort={ledgerSort} onSort={toggleSort}/>
                <SortHd col="interest" label="Interest" sort={ledgerSort} onSort={toggleSort}/>
                <SortHd col="days" label="Days" sort={ledgerSort} onSort={toggleSort}/>
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
                          <button onClick={()=>openPanel?.({type:'lender',name:l.lenderName})} className="font-semibold text-slate-900 dark:text-zinc-100 text-sm hover:text-teal-600 dark:hover:text-teal-400 transition-colors text-left">{hn(l.lenderName)}</button>
                          <TypeLabel type={l.loanType}/>
                        </div>
                        <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">{rateLabel}</div>
                      </div>
                      <div className="text-sm text-slate-600 dark:text-zinc-300 truncate"><button onClick={()=>openPanel?.({type:'property',id:l.propId})} className="hover:text-teal-600 dark:hover:text-teal-400 transition-colors text-left truncate max-w-full block">{l.property}</button></div>
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
      {!groupedTrail.length&&<div className="text-center py-16 text-slate-400 dark:text-zinc-500"><div className="text-5xl mb-3">📋</div><p className="font-semibold">No transactions yet</p></div>}
      <div className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1F2B] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none divide-y divide-black/[0.05] dark:divide-white/[0.05]">
        {[...groupedTrail].reverse().map((ev,i)=>{
          const c=cfg[ev.etype]??cfg.closed;const pos=ev.nc>=0;const roll=ev.etype==="start"&&ev.pp>0;
          const rateLabel=ev.rate==null?"mixed rates":ev.interestType==="fixed"?"$"+Math.round(ev.rate).toLocaleString()+" fixed":ev.rate+"%/yr";
          if(ev.etype==="saleSummary"){
            const cd=ev.closingData;
            const lenderPrincipals=(cd.lenderPayoffs||[]).reduce((s,lp)=>s+(lp.principalPayoff||0),0);
            const nexusFunded=Math.max(0,(cd.totalCosts||0)-lenderPrincipals);
            const wireLenders=(cd.lenderPayoffs||[]).filter(lp=>(lp.wireAmount||0)>0.01);
            const profitAtClose=(cd.profit||0)-(cd.overageRefund||0);
            return(
              <div key={ev.loanId} className="bg-teal-50/70 dark:bg-teal-950/15 border-l-4 border-teal-400 dark:border-teal-500 px-5 py-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className={`w-9 h-9 rounded-full flex items-center justify-center text-sm shrink-0 ${inCls}`}>↙</span>
                  <div>
                    <div className="font-bold text-teal-900 dark:text-teal-100">Sale Closed — <button onClick={()=>ev.propId&&openPanel?.({type:'property',id:ev.propId})} className="hover:underline text-left">{ev.property}</button></div>
                    <div className="text-xs text-teal-500 dark:text-teal-400">{ev.date} · For Bookkeepers</div>
                  </div>
                  <div className="ml-auto text-right">
                    <div className="text-[10px] text-teal-400 dark:text-teal-500 uppercase font-semibold">Wire Received</div>
                    <div className="font-bold text-xl text-teal-700 dark:text-teal-300 tabular-nums">{h$(cd.wire)}</div>
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
                    {nexusFunded>0.01&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Nexus Self-Funding</span><span className="tabular-nums">{h$(nexusFunded)}</span></div>}
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
                    {(cd.selfFunded||0)>0.01&&<div className="flex justify-between text-slate-600 dark:text-zinc-300"><span>Nexus Self-Funding</span><span className="tabular-nums">{h$(cd.selfFunded)}</span></div>}
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
                    <div className="flex justify-between font-bold text-teal-700 dark:text-teal-300 border-t border-black/[0.06] dark:border-white/[0.06] pt-1.5 mt-0.5"><span>= Wire</span><span className="tabular-nums">{h$(cd.wire)}</span></div>
                  </div>
                </div>
                {ev.overageChecks.length>0&&(
                  <div className="mt-3 pt-3 border-t border-teal-100 dark:border-teal-900/40">
                    <div className="text-[10px] font-semibold text-amber-500 dark:text-amber-400 uppercase tracking-widest mb-2">Overage Checks — Received After Closing</div>
                    <div className="space-y-1 text-xs">
                      {ev.overageChecks.map(c=>(
                        <div key={c.id} className="flex justify-between text-slate-600 dark:text-zinc-300">
                          <span>{overageSourceLabel(c.source)} <span className="text-slate-400 dark:text-zinc-500">· {c.date}</span></span>
                          <span className="tabular-nums font-medium text-emerald-600 dark:text-emerald-400">+{h$(c.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          }
          if(ev.etype==="overageCheck"){
            return(
              <div key={ev.loanId} className="flex items-start gap-3 px-5 py-4 bg-amber-50/60 dark:bg-amber-950/10 hover:bg-amber-50 dark:hover:bg-amber-950/20 transition-colors">
                <span className="w-9 h-9 rounded-full flex items-center justify-center text-sm shrink-0 mt-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">💰</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap mb-1">
                        <span className="font-mono text-[10px] text-slate-400 dark:text-zinc-500 bg-slate-100 dark:bg-zinc-800 rounded-md px-1.5 py-0.5">{ev.date}</span>
                        <span className="text-[10px] font-semibold uppercase bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-full px-2 py-0.5">Overage Check — {overageSourceLabel(ev.source)}</span>
                      </div>
                      <button onClick={()=>ev.propId&&openPanel?.({type:'property',id:ev.propId})} className="font-bold text-slate-900 dark:text-zinc-100 hover:text-teal-600 dark:hover:text-teal-400 transition-colors text-left">{ev.property}</button>
                      {ev.notes&&<div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">{ev.notes}</div>}
                      <div className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">Counts toward profit · For Bookkeepers</div>
                    </div>
                    <div className="text-right shrink-0 min-w-[90px]">
                      <div className="font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">+{h$(ev.amount)}</div>
                    </div>
                  </div>
                </div>
              </div>
            );
          }
          return(
            <div key={`${ev.loanId}-${ev.etype}-${i}`} className="flex items-start gap-3 px-5 py-4 bg-white dark:bg-[#1C1F2B] hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
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
                    <button onClick={()=>ev.lender&&openPanel?.({type:'lender',name:ev.lender})} className="font-bold text-slate-900 dark:text-zinc-100 hover:text-teal-600 dark:hover:text-teal-400 transition-colors text-left">{hn(ev.lender)}</button>
                    <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5"><button onClick={()=>ev.propId&&openPanel?.({type:'property',id:ev.propId})} className={`${ev.propId?"hover:text-teal-600 dark:hover:text-teal-400 transition-colors":""} text-left`}>{ev.property}</button> · {rateLabel}</div>
                    {roll&&ev.pp>0&&<div className="text-xs text-violet-500 dark:text-violet-400 mt-0.5 tabular-nums">Rolled from {h$(ev.pp)}</div>}
                    {ev._group&&(
                      <div className="mt-2 space-y-1 border-t border-black/[0.05] dark:border-white/[0.05] pt-1.5">
                        {ev._group.map(g=>(
                          <div key={g.loanId} className="flex items-center justify-between gap-2 text-[11px] text-slate-400 dark:text-zinc-500">
                            <button onClick={()=>g.propId&&openPanel?.({type:'property',id:g.propId})} className={`${g.propId?"hover:text-teal-600 dark:hover:text-teal-400 transition-colors":""} text-left truncate`}>{g.property}</button>
                            <span className="tabular-nums shrink-0">{h$(g.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0 min-w-[110px]">
                    {ev.etype==="start"?(
                      <>
                        <div className="font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">+{h$(ev.amount)}</div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5 tabular-nums">Principal {h$(ev.amount)}</div>
                      </>
                    ):ev.etype==="rolled"?(
                      <>
                        <div className="font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">{h$(ev.amount)}</div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5 tabular-nums">
                          Principal {h$(ev.principal)}
                          {ev.disposition==="waiveInterest"?" · Interest waived":(ev.interest||0)>0.01?` · Interest ${h$(ev.interest)}`:""}
                        </div>
                      </>
                    ):ev.etype==="hardPayment"?(
                      <>
                        <div className="font-bold text-red-600 dark:text-red-400 tabular-nums">−{h$(ev.amount)}</div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5 tabular-nums">Interest {h$(ev.amount)}</div>
                      </>
                    ):(
                      <>
                        <div className="font-bold text-red-600 dark:text-red-400 tabular-nums">−{h$(ev.amount)}</div>
                        <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5 tabular-nums">
                          Principal {h$(ev.principal)}
                          {ev.disposition==="waiveInterest"?" · Interest waived":(ev.interest||0)>0.01?` · Interest ${h$(ev.interest)}`:""}
                        </div>
                      </>
                    )}
                    {ev.etype!=="saleSummary"&&(
                      <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-1.5 pt-1.5 border-t border-black/[0.05] dark:border-white/[0.05] tabular-nums">
                        {ev.loanType==="hard"?"This house":"New total"}: {h$(ev.loanType==="hard"?ev.runningTotalThisProperty:ev.runningTotal)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {filtered.length>0&&(()=>{
        const principalNet=filtered.reduce((s,e)=>(e.etype==="saleSummary"||e.etype==="overageCheck")?s:s+(e.nc||0),0);
        return(
          <div className="mt-3 rounded-2xl bg-white dark:bg-[#1C1F2B] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none px-5 py-4 flex items-center justify-between">
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
  const h$=v=>prv?maskMoney($$p(v)):$$p(v);
  const hr=l=>{ if(!prv) return fmtRate(l); const s=fmtRate(l); return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s); };
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
      <label className={`flex items-center gap-3 px-4 py-3 mb-4 rounded-2xl cursor-pointer transition-colors ${projectFull?"bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-800":"bg-white dark:bg-[#1C1F2B] shadow-[0_1px_6px_rgba(0,0,0,0.06)] dark:shadow-none border border-transparent"}`}>
        <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${projectFull?"bg-teal-600 border-teal-600":"border-slate-300 dark:border-zinc-600"}`}
          onClick={()=>setProjectFull(p=>!p)}>
          {projectFull&&<svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
        </div>
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-zinc-100">Project fully funded at {PROJ_RATE}%</div>
          <div className="text-[11px] text-slate-400 dark:text-zinc-500">Fill any funding gap with a hypothetical {PROJ_RATE}% loan to see true worst-case monthly cost</div>
        </div>
      </label>

      {/* Average delay input + cost impact */}
      <div className={`px-4 py-3 mb-4 rounded-2xl bg-white dark:bg-[#1C1F2B] shadow-[0_1px_6px_rgba(0,0,0,0.06)] dark:shadow-none`}>
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
            <div key={prop.id} className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1F2B] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
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
                      {projectFull&&gapPct>0&&<div className="absolute top-0 h-full bg-teal-300 dark:bg-teal-600 rounded-r-full transition-all" style={{left:`${fundedPct}%`,width:`${gapPct}%`}}/>}
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
                            <span className="text-slate-400 dark:text-zinc-500 shrink-0">{h$(loan.principal)} · {hr(loan)}</span>
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
                      <div className="flex items-center justify-between text-[11px] border-t border-dashed border-teal-200 dark:border-teal-800 pt-1 mt-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold text-teal-500 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/30 rounded px-1.5 py-0.5">projected</span>
                          <span className="text-teal-500 dark:text-teal-400">{h$(gap)} gap @ {PROJ_RATE}%/yr</span>
                        </div>
                        <span className="font-semibold tabular-nums text-teal-500 dark:text-teal-400">+{h$(projBurn)}/mo</span>
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
  const [interestMode, setInterestMode] = useState('split'); // 'split' | 'consolidate'
  const [consolidateLoanId, setConsolidateLoanId] = useState('');
  const [dateLocked,setDateLocked]=useState(false);

  const allActiveLoans = [
    ...(data.properties||[]).filter(p=>!p.dateSold).flatMap(p=>
      (p.loans||[]).filter(l=>!l.endDate).map(l=>({...l,propAddress:p.address,propId:p.id}))
    ),
    ...(data.unassigned||[]).filter(l=>!l.endDate).map(l=>({...l,propAddress:null,propId:null}))
  ];
  const lenderNames=[...new Set(allActiveLoans.map(l=>l.lenderName).filter(Boolean))].sort();
  const lenderLoans=allActiveLoans.filter(l=>l.lenderName===lenderName);
  const allSelected=lenderLoans.length>0&&selectedIds.length===lenderLoans.length;

  // Fixed-fee loans among the ones actually being closed — these are the ones a flat
  // interest amount can be consolidated across (a %-rate loan's interest already scales
  // correctly per piece, so there's nothing to consolidate there).
  const selectedFixedLoans = lenderLoans.filter(l=>selectedIds.includes(l.id)&&l.interestType==="fixed");
  const totalFixedInterest = selectedFixedLoans.reduce((s,l)=>s+(l.interestRate||0),0);

  useEffect(()=>{
    if(lenderName) setSelectedIds(lenderLoans.map(l=>l.id));
    setInterestMode('split');
    setConsolidateLoanId('');
  },[lenderName]);

  useEffect(()=>{
    if(consolidateLoanId && !selectedFixedLoans.some(l=>l.id===consolidateLoanId)) setConsolidateLoanId('');
  },[selectedIds]);

  const toggle=id=>setSelectedIds(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);

  const handleClose=()=>{
    if(!date||!selectedIds.length) return;
    if(interestMode==='consolidate'&&selectedFixedLoans.length>1&&!consolidateLoanId) return;
    const consolidate = interestMode==='consolidate'&&selectedFixedLoans.length>1;
    const applyClose = l => {
      if(!selectedIds.includes(l.id)) return l;
      const patch = {endDate:date};
      if(consolidate&&l.interestType==="fixed") patch.interestRate = l.id===consolidateLoanId?totalFixedInterest:0;
      return {...l,...patch};
    };
    update(d=>({
      ...d,
      properties:d.properties.map(p=>({...p,loans:p.loans.map(applyClose)})),
      unassigned:(d.unassigned||[]).map(applyClose),
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
          <Lockable locked={dateLocked} onToggle={()=>setDateLocked(l=>!l)}>
            <DateInp label="Close Date" value={date} onChange={setDate}/>
          </Lockable>
          <div className="mt-3">
            <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">
              <span>Loans to Close</span>
              <button onClick={()=>setSelectedIds(allSelected?[]:lenderLoans.map(l=>l.id))}
                className="text-teal-600 dark:text-teal-400 font-semibold text-[11px] normal-case tracking-normal">
                {allSelected?'Deselect all':'Select all'}
              </button>
            </div>
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {lenderLoans.map(l=>(
                <button key={l.id} onClick={()=>toggle(l.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all flex items-center justify-between gap-3 ${selectedIds.includes(l.id)?'bg-teal-50 dark:bg-teal-900/20 border-teal-300 dark:border-teal-700':'bg-slate-50 dark:bg-zinc-800 border-slate-200 dark:border-zinc-700'}`}>
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-slate-800 dark:text-zinc-200 truncate">{l.propAddress||'Unassigned'}</div>
                    <div className="text-[11px] text-slate-500 dark:text-zinc-400">{$$p(l.principal)} · started {l.startDate}</div>
                  </div>
                  <div className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${selectedIds.includes(l.id)?'bg-teal-500 border-teal-500':'border-slate-300 dark:border-zinc-600'}`}>
                    {selectedIds.includes(l.id)&&<span className="text-white text-[10px] leading-none">✓</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
          {selectedFixedLoans.length>1&&(
            <div className="mt-3 p-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-2">
                Fixed Interest — {$$p(totalFixedInterest)} total across {selectedFixedLoans.length} pieces
              </div>
              <div className="flex gap-2 mb-2">
                <button type="button" onClick={()=>setInterestMode('split')}
                  className={`flex-1 text-xs font-semibold py-2 rounded-lg transition-all ${interestMode==='split'?'bg-teal-600 text-white':'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700'}`}>
                  Keep Split
                </button>
                <button type="button" onClick={()=>setInterestMode('consolidate')}
                  className={`flex-1 text-xs font-semibold py-2 rounded-lg transition-all ${interestMode==='consolidate'?'bg-teal-600 text-white':'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700'}`}>
                  Put on One Property
                </button>
              </div>
              {interestMode==='consolidate'&&(
                <div className="space-y-1.5">
                  {selectedFixedLoans.map(l=>(
                    <button key={l.id} type="button" onClick={()=>setConsolidateLoanId(l.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg border text-xs flex items-center justify-between transition-all ${consolidateLoanId===l.id?'bg-teal-50 dark:bg-teal-900/20 border-teal-300 dark:border-teal-700':'bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-700'}`}>
                      <span className="font-medium text-slate-800 dark:text-zinc-200">{l.propAddress||'Unassigned'}</span>
                      <span className="text-slate-400 dark:text-zinc-500 tabular-nums">currently {$$p(l.interestRate||0)}</span>
                    </button>
                  ))}
                  {!consolidateLoanId&&(
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">Pick which property gets the full {$$p(totalFixedInterest)} — the rest will show $0 interest.</p>
                  )}
                </div>
              )}
            </div>
          )}
          <Btn onClick={handleClose} color="red" full disabled={!selectedIds.length||(interestMode==='consolidate'&&selectedFixedLoans.length>1&&!consolidateLoanId)}>
            Close {allSelected?'All':selectedIds.length} Loan{selectedIds.length!==1?'s':''} →
          </Btn>
        </>
      )}
      <Btn onClick={onClose} color="ghost" full>Cancel</Btn>
    </Modal>
  );
}

// ─── Close Property Picker Modal ─────────────────────────────────────────────
function ClosePropertyPickerModal({ properties, order, onPick, onClose }) {
  const [search,setSearch]=useState("");
  // Same manual order as the Properties tab's drag-sort — usually arranged soonest-to-close
  // first, which is exactly the order you want when picking which one to close out.
  const manualOrder=order||[];
  const active=(properties||[]).filter(p=>!p.dateSold).sort((a,b)=>{
    const ia=manualOrder.indexOf(a.id), ib=manualOrder.indexOf(b.id);
    return (ia===-1?Infinity:ia)-(ib===-1?Infinity:ib)||(a.id||"").localeCompare(b.id||"");
  });
  const filtered=active.filter(p=>!search||p.address?.toLowerCase().includes(search.toLowerCase()));
  return (
    <Modal title="Close a Property" onClose={onClose}>
      {active.length===0
        ? <><p className="text-sm text-slate-400 dark:text-zinc-500 mb-3">No active properties to close.</p><Btn onClick={onClose} color="ghost" full>Close</Btn></>
        : <>
            <p className="text-xs text-slate-400 dark:text-zinc-500 mb-2">Select the property to mark as sold:</p>
            <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search properties…" autoFocus
              className="w-full mb-3 px-3 py-2 rounded-xl text-sm bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-teal-500"/>
            <div className="space-y-1.5 mb-3 max-h-96 overflow-y-auto">
              {filtered.length===0&&<div className="text-xs text-slate-400 dark:text-zinc-500 text-center py-3">No matches</div>}
              {filtered.map(p=>(
                <button key={p.id} onClick={()=>onPick(p)}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-teal-50 dark:hover:bg-teal-900/20 border border-slate-200 dark:border-zinc-700 hover:border-teal-300 dark:hover:border-teal-700 transition-all">
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

// ─── Overage Check ────────────────────────────────────────────────────────────
// A check that shows up after a property has already closed — insurance, taxes, or a
// closing overcharge caught later — recorded against that property so it counts toward
// profit and stays visible to the bookkeepers.
function OverageCheckPropertyPickerModal({ properties, onPick, onClose }) {
  const [search,setSearch]=useState("");
  // Every property, sold or still owned — an overage check (insurance, taxes, a title
  // correction) can show up either way, not just after closing.
  const all=(properties||[]).slice().sort((a,b)=>(a.address||"").localeCompare(b.address||""));
  const filtered=all.filter(p=>!search||p.address?.toLowerCase().includes(search.toLowerCase()));
  return (
    <Modal title="Overage Check — Pick a Property" onClose={onClose}>
      {all.length===0
        ? <><p className="text-sm text-slate-400 dark:text-zinc-500 mb-3">No properties yet.</p><Btn onClick={onClose} color="ghost" full>Close</Btn></>
        : <>
            <p className="text-xs text-slate-400 dark:text-zinc-500 mb-2">Which property is this check for? For insurance/tax/overcharge money found after the fact — if a lender is instead refunding part of an overage as part of a closing, enter that on Mark Sold / Edit Closing instead.</p>
            <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search properties…" autoFocus
              className="w-full mb-3 px-3 py-2 rounded-xl text-sm bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-teal-500"/>
            <div className="space-y-1.5 mb-3 max-h-96 overflow-y-auto">
              {filtered.length===0&&<div className="text-xs text-slate-400 dark:text-zinc-500 text-center py-3">No matches</div>}
              {filtered.map(p=>(
                <button key={p.id} onClick={()=>onPick(p)}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-zinc-800 hover:bg-teal-50 dark:hover:bg-teal-900/20 border border-slate-200 dark:border-zinc-700 hover:border-teal-300 dark:hover:border-teal-700 transition-all flex items-center justify-between gap-2">
                  <span className="font-medium text-[13px] text-slate-800 dark:text-zinc-200 truncate">🏠 {p.address}</span>
                  {p.dateSold
                    ? <span className="text-[11px] text-slate-400 dark:text-zinc-500 shrink-0">Sold {p.dateSold}</span>
                    : <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 shrink-0">Active</span>}
                </button>
              ))}
            </div>
            <Btn onClick={onClose} color="ghost" full>Cancel</Btn>
          </>
      }
    </Modal>
  );
}
function OverageCheckModal({ prop, init, onSave, onDelete, onClose }) {
  const [date,setDate]=useState(init?.date||TODAY);
  const [amount,setAmount]=useState(init?String(init.amount||""):"");
  const [source,setSource]=useState(init?.source||OVERAGE_SOURCES[0][0]);
  const [notes,setNotes]=useState(init?.notes||"");
  const guardedClose=useDirtyGuard(()=>({date,amount,source,notes}),onClose);
  // Editing an existing entry: it's already a real, checked number — start locked so it
  // can't be bumped by accident while fixing a typo elsewhere on the form.
  const [locked,setLocked]=useState(()=>({date:!!init,amount:!!init}));
  const toggleLock=k=>setLocked(l=>({...l,[k]:!l[k]}));
  const amt=parseFloat(amount)||0;
  const needsNote=source==="other";
  // Same mandatory-confirm rule every other form follows — this one was the one place in
  // the app where a field could be left un-confirmed and still saved.
  const allConfirmed=locked.date&&locked.amount;
  const dateOk=!date||(date<=TODAY&&(!prop.purchaseDate||date>=prop.purchaseDate));
  const canSave=amt>0&&!!date&&allConfirmed&&dateOk&&(!needsNote||notes.trim()!=="");
  return (
    <Modal title={`${init?"Edit":"Overage Check —"} ${prop.address}`} onClose={guardedClose}>
      <div className="space-y-1">
        <Lockable locked={locked.date} onToggle={()=>toggleLock("date")}>
          <DateInp label="Date Received" value={date} onChange={setDate}/>
        </Lockable>
        {!dateOk&&(
          <p className="text-[11px] text-red-500 dark:text-red-400 -mt-2 mb-3">
            {date>TODAY?"Date can't be in the future.":`Date can't be before this property's purchase date (${prop.purchaseDate}).`}
          </p>
        )}
        <Lockable locked={locked.amount} onToggle={()=>toggleLock("amount")}>
          <Inp label="Amount ($)" money value={amount} onChange={setAmount} placeholder="500"/>
        </Lockable>
        <Sel label="Where's This From?" value={source} onChange={setSource} options={OVERAGE_SOURCES}/>
        <Inp label={`Notes${needsNote?" *":""}`} value={notes} onChange={setNotes} placeholder="What this was for, exactly — for the bookkeepers"/>
        {needsNote&&notes.trim()===""&&<p className="text-[11px] text-red-500 dark:text-red-400 -mt-2 mb-2">Say what this was for when the source is "Other".</p>}
        <p className="text-[11px] text-slate-400 dark:text-zinc-500 -mt-2 mb-2">Counts toward this property's profit and shows up in History for the bookkeepers. For money unrelated to a specific lender — insurance, taxes, a closing overcharge — found after the fact. If instead a specific lender is refunding part of an overage as part of THIS closing, enter it on that lender's line in Mark Sold / Edit Closing instead — not here.</p>
        {!allConfirmed&&<p className="text-[11px] text-red-500 dark:text-red-400 -mt-1 mb-2">Tap ✓ Confirm on the date and amount before this can be saved.</p>}
        <div className="flex gap-2">
          <Btn onClick={()=>canSave&&onSave({date,amount:amt,source,notes})} color={canSave?"blue":"ghost"} disabled={!canSave} full>{init?"Save Changes":"Save Overage Check"}</Btn>
          {onDelete&&<Btn onClick={()=>{if(window.confirm("Delete this overage check? This can't be undone."))onDelete();}} color="red">Delete</Btn>}
        </div>
      </div>
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
  const [showPassword, setShowPassword] = useState(false)

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
        <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Portal Access</h2>
      </div>
      <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] p-4">
        <div className="font-bold text-[14px] text-slate-800 dark:text-zinc-100 mb-1">Grant Portal Access</div>
        <div className="text-[12px] text-slate-400 dark:text-zinc-500 mb-4">Give a lender their own login to see only their loans.</div>
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Lender Name</label>
            <select value={form.lenderName} onChange={e => setForm(f => ({...f, lenderName: e.target.value}))} required
              className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500">
              <option value="">— select lender —</option>
              {allNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Email</label>
            <input type="email" value={form.email} onChange={e => setForm(f => ({...f, email: e.target.value}))} required placeholder="their@email.com"
              className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"/>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">Password</label>
            <div className="relative">
              <input type={showPassword?"text":"password"} value={form.password} onChange={e => setForm(f => ({...f, password: e.target.value}))} required placeholder="temporary password"
                className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 rounded-xl px-3 py-2.5 pr-16 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"/>
              <button type="button" onClick={()=>setShowPassword(s=>!s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300 px-2 py-1">
                {showPassword?"Hide":"Show"}
              </button>
            </div>
          </div>
          {err && <p className="text-red-500 text-xs font-medium">{err}</p>}
          {ok  && <p className="text-emerald-600 dark:text-emerald-400 text-xs font-medium">{ok}</p>}
          <button type="submit" disabled={saving}
            className="w-full bg-teal-600 hover:bg-teal-700 text-white rounded-xl py-2.5 text-sm font-semibold transition-all disabled:opacity-50">
            {saving ? 'Creating…' : 'Create Login'}
          </button>
        </form>
      </div>

      <div>
        <div className="text-[13px] font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-3">
          Portal Logins {lenders ? `(${lenders.length})` : ''}
        </div>
        {fetching ? (
          <div className="text-slate-400 dark:text-zinc-500 text-sm text-center py-8">Loading…</div>
        ) : !lenders?.length ? (
          <div className="text-slate-300 dark:text-zinc-600 text-sm text-center py-8">No portal logins yet</div>
        ) : (
          <div className="space-y-2">
            {lenders.map(l => (
              <div key={l.id} className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] px-4 py-3 flex items-center justify-between gap-3">
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
  const h$ = v => { const s=$$p(v); return privacy?maskMoney(s):s; };
  const [drawSearch,setDrawSearch]=useState("");
  const [drawSort,setDrawSort]=usePersistedState("nx-drawSort","chance");
  const [drawSortDir,setDrawSortDir]=usePersistedState("nx-drawSortDir","desc");
  const [viewMode,setViewMode]=usePersistedState("nx-drawsViewMode","grid");

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
      const fullyDrawn = totalAvailable <= 0;

      // Last draw date across all loans
      const drawDates = allDraws.map(d=>d.date).filter(Boolean).sort();
      const lastDrawDate = drawDates.length ? drawDates[drawDates.length-1] : null;
      const daysSinceDraw = lastDrawDate ? daysBetween(lastDrawDate, TODAY) : null;

      // "Last event" = later of last draw or purchase date (both count for 14-day window)
      const lastEventDate = [lastDrawDate, p.purchaseDate].filter(Boolean).sort().pop() ?? null;
      const daysSinceEvent = lastEventDate ? daysBetween(lastEventDate, TODAY) : null;
      // Fully drawn (nothing left) is never "eligible" — no amount of waiting makes more
      // money appear, so it always drops to the bottom / stays grayed out regardless of
      // how long it's been since the last draw or purchase.
      const eligible = !fullyDrawn && (!lastEventDate || daysSinceEvent >= 14);

      return { prop: p, drawLoans, totalCommitted, totalDrawn, totalAvailable, fullyDrawn, lastDrawDate, daysSinceDraw, lastEventDate, daysSinceEvent, eligible, allDraws };
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

  // Shared per-row derived display bits (badge label/color, sub-label) used by all three views.
  const rowMeta = r => {
    const pct_drawn = r.totalCommitted > 0 ? Math.min(100, Math.round(r.totalDrawn/r.totalCommitted*100)) : 0;
    const urgency = !r.eligible ? "wait"
      : r.daysSinceEvent === null ? "new"
      : r.daysSinceEvent >= 21 ? "high"
      : r.daysSinceEvent >= 14 ? "med"
      : "low";
    const urgencyColor = urgency==="wait" ? "text-slate-500 dark:text-zinc-400 bg-slate-100 dark:bg-zinc-800"
      : urgency==="new" ? "text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30"
      : urgency==="high" ? "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30"
      : urgency==="med" ? "text-amber-600 dark:text-amber-500 bg-amber-50 dark:bg-amber-900/30"
      : "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30";
    const eventLabel = r.fullyDrawn ? "Fully Drawn"
      : !r.eligible ? `Wait ${14 - (r.daysSinceEvent??0)}d`
      : r.daysSinceEvent === null ? "No prior event"
      : `${r.daysSinceEvent}d ago`;
    const eventSub = r.lastDrawDate && r.prop.purchaseDate
      ? (r.lastDrawDate >= r.prop.purchaseDate ? `Last draw ${r.lastDrawDate}` : `Purchased ${r.prop.purchaseDate}`)
      : r.lastDrawDate ? `Last draw ${r.lastDrawDate}`
      : r.prop.purchaseDate ? `Purchased ${r.prop.purchaseDate}`
      : null;
    return { pct_drawn, urgencyColor, eventLabel, eventSub };
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Draws</h2>
        <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-lg p-0.5 gap-0.5">
          {[["condensed","≡"],["grid","▦"],["expanded","⊞"]].map(([v,icon])=>(
            <button key={v} onClick={()=>setViewMode(v)} title={v==="condensed"?"Condensed view":v==="grid"?"Card view":"Expanded view"}
              className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all ${viewMode===v?"bg-white dark:bg-zinc-700 text-slate-900 dark:text-zinc-100 shadow-sm":"text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300"}`}>
              {icon}
            </button>
          ))}
        </div>
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
      <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] p-3 flex items-center justify-between">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Total Available Draws</div>
          <div className="text-xl font-black text-emerald-600 dark:text-emerald-400 tabular-nums">{h$(totalAvailableAll)}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Properties</div>
          <div className="text-xl font-black text-slate-700 dark:text-zinc-200">{rows.length}</div>
        </div>
      </div>

      {/* ── Condensed: sortable-look table, one row per property ── */}
      {viewMode==="condensed"&&(
        <div className="rounded-2xl overflow-hidden bg-white dark:bg-[#1C1F2B] shadow-[0_2px_12px_rgba(0,0,0,0.07)] dark:shadow-none">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#F9F9FB] dark:bg-black/20 text-slate-400 dark:text-zinc-500 font-semibold uppercase tracking-wider text-[10px] border-b border-black/[0.05] dark:border-white/[0.05]">
                  <th className="py-2.5 px-4 text-left">Address</th>
                  <th className="py-2.5 px-4 text-right">Available</th>
                  <th className="py-2.5 px-4 text-right">Drawn / Committed</th>
                  <th className="py-2.5 px-4 text-right">% Drawn</th>
                  <th className="py-2.5 px-4 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-[#1C1F2B] divide-y divide-black/[0.04] dark:divide-white/[0.05]">
                {rows.map(r=>{
                  const {pct_drawn,urgencyColor,eventLabel}=rowMeta(r);
                  return (
                    <tr key={r.prop.id} className={`hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors ${!r.eligible?"opacity-50":""}`}>
                      <td className="py-2.5 px-4 font-semibold text-slate-800 dark:text-zinc-100 max-w-[220px] truncate">{r.prop.address||"Unnamed"}</td>
                      <td className={`py-2.5 px-4 text-right tabular-nums font-semibold ${r.totalAvailable>0?"text-emerald-600 dark:text-emerald-400":"text-slate-300 dark:text-zinc-600"}`}>{h$(r.totalAvailable)}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-slate-500 dark:text-zinc-400">{h$(r.totalDrawn)} / {h$(r.totalCommitted)}</td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-slate-400 dark:text-zinc-500">{pct_drawn}%</td>
                      <td className="py-2.5 px-4 text-right">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ${urgencyColor}`}>{eventLabel}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Grid: condensed 2-column cards ── */}
      {viewMode==="grid"&&(
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {rows.map(r=>{
          const { prop, drawLoans, totalCommitted, totalDrawn, totalAvailable, eligible } = r;
          const {pct_drawn,urgencyColor,eventLabel,eventSub}=rowMeta(r);
          return (
            <div key={prop.id} className={`bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] overflow-hidden ${!eligible?"opacity-60":""}`}>
              {/* Property header */}
              <div className="px-3.5 pt-2.5 pb-2 border-b border-slate-100 dark:border-zinc-800">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-semibold text-[13px] text-slate-900 dark:text-zinc-100 leading-snug flex-1 truncate">{prop.address}</div>
                  <div className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${urgencyColor}`}>
                    {eventLabel}
                  </div>
                </div>
                {eventSub && (
                  <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5">{eventSub}</div>
                )}
              </div>

              {/* Available amount */}
              <div className="px-3.5 py-2.5">
                <div className="flex items-end justify-between mb-1.5">
                  <div>
                    <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Available</div>
                    <div className={`text-lg font-black tabular-nums ${totalAvailable > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-slate-300 dark:text-zinc-600"}`}>
                      {h$(totalAvailable)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Drawn / Committed</div>
                    <div className="text-[12px] font-semibold text-slate-500 dark:text-zinc-400 tabular-nums">{h$(totalDrawn)} / {h$(totalCommitted)}</div>
                  </div>
                </div>
                {/* Progress bar */}
                <div className="h-1.5 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${pct_drawn>=90?"bg-red-500":pct_drawn>=60?"bg-amber-500":"bg-emerald-500"}`}
                    style={{width:`${pct_drawn}%`}}/>
                </div>
              </div>

              {/* Per-loan breakdown */}
              {drawLoans.length > 1 && (
                <div className="px-3.5 pb-2.5 space-y-1">
                  <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">By Lender</div>
                  {drawLoans.map(l => {
                    const drawn = (l.drawFacility.draws||[]).reduce((s,d)=>s+(d.amount||0),0);
                    const avail = Math.max(0,(l.drawFacility.committed||0)-drawn);
                    return (
                      <div key={l.id} className="flex items-center justify-between text-[11px]">
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
      )}

      {/* ── Expanded: full-detail, one property per row ── */}
      {viewMode==="expanded"&&(
        <div className="space-y-3">
        {rows.map(r=>{
          const { prop, drawLoans, totalCommitted, totalDrawn, totalAvailable, eligible } = r;
          const {pct_drawn,urgencyColor,eventLabel,eventSub}=rowMeta(r);
          return (
            <div key={prop.id} className={`bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.07)] overflow-hidden ${!eligible?"opacity-60":""}`}>
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
      )}
    </div>
  );
}

// ─── Whiteboard ───────────────────────────────────────────────────────────────
// A deliberately manual, standalone planning board — separate from the rest of the
// tracker's auto-computed numbers. You drag cards onto a day to plan upcoming money in
// (usually an expected sale) and money out (usually a purchase closing), so you can see at
// a glance what's coming and whether you'll have the cash for it. Incoming money is assumed
// to take 1 business day to clear, so a day's net counts in-cards by when they actually
// settle, not the day they're dropped on. Bills with no due date (kind:"bill") skip the day
// grid entirely and live in a separate "Due Now" queue, ranked by when they were added with
// a manual up/down override. Nothing here feeds back into properties/loans/history; it's
// just a whiteboard.
const wbAddDays = (dateStr,n) => {
  const [y,m,d] = dateStr.split('-').map(Number);
  const dt = new Date(y,m-1,d+n);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
};
const wbFmtDate = dateStr => {
  const [y,m,d] = dateStr.split('-').map(Number);
  return new Date(y,m-1,d).toLocaleDateString(undefined,{month:'short',day:'numeric'});
};
const wbWeekday = dateStr => {
  const [y,m,d] = dateStr.split('-').map(Number);
  return new Date(y,m-1,d).toLocaleDateString(undefined,{weekday:'short'});
};
const wbIsWeekend = dateStr => {
  const [y,m,d] = dateStr.split('-').map(Number);
  const dow = new Date(y,m-1,d).getDay();
  return dow===0 || dow===6;
};
// Incoming money doesn't actually hit the account the day it's expected — it takes
// 1 business day to clear, so a card dated Thursday isn't real cash until Friday.
const wbNextBusinessDay = dateStr => {
  let d = wbAddDays(dateStr,1);
  while (wbIsWeekend(d)) d = wbAddDays(d,1);
  return d;
};
const wbEffectiveDate = card => card.direction==="in" && card.day ? wbNextBusinessDay(card.day) : card.day;

const WhiteboardCardVisual = ({ card, h$, liens, availText, onEdit, onRemove, navigate, dragHandleProps }) => {
  const isProp = card.kind==="property";
  const isIn = card.direction==="in";
  const hasAmount = (card.amount||0)>0;
  const liensShown = (liens||[]).slice(0,4);
  const liensExtra = (liens||[]).length - liensShown.length;
  const liensTotal = (liens||[]).reduce((s,l)=>s+l.amt,0);
  return (
    <div className={`rounded-xl border p-3 mb-2 bg-white dark:bg-zinc-800 shadow-sm select-none ${isIn?"border-emerald-300 dark:border-emerald-700":"border-red-300 dark:border-red-700"}`}
      {...(dragHandleProps||{})}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {isProp
            ? <button onClick={e=>{e.stopPropagation();navigate&&navigate({type:'property',id:card.propId});}}
                className="font-semibold text-[13px] text-teal-600 dark:text-teal-400 hover:underline truncate text-left block w-full">{card.address}</button>
            : <div className="font-semibold text-[13px] text-slate-800 dark:text-zinc-100 truncate">{card.address}</div>
          }

          {isProp&&liensShown.length>0&&(
            <div className="mt-1.5 mb-1 space-y-0.5">
              {liensShown.map((l,i)=>(
                <div key={i} className="flex justify-between text-[10px] text-slate-400 dark:text-zinc-500 gap-2">
                  <span className="truncate">{l.lenderName||"Unknown"}</span>
                  <span className="tabular-nums shrink-0">{h$(l.amt)}</span>
                </div>
              ))}
              {liensExtra>0&&<div className="text-[10px] text-slate-300 dark:text-zinc-600">+{liensExtra} more</div>}
              <div className="flex justify-between text-[10px] font-semibold text-slate-500 dark:text-zinc-400 border-t border-slate-100 dark:border-zinc-700 pt-0.5">
                <span>Liens</span><span className="tabular-nums">{h$(liensTotal)}</span>
              </div>
            </div>
          )}

          {hasAmount ? (
            <div className={`text-lg font-black tabular-nums mt-0.5 ${isIn?"text-emerald-600 dark:text-emerald-400":"text-red-600 dark:text-red-400"}`}>
              {isIn?"+":"−"}{h$(card.amount)}
            </div>
          ) : onEdit ? (
            <button onClick={e=>{e.stopPropagation();onEdit(card);}}
              className="text-[11px] font-semibold text-teal-500 dark:text-teal-400 hover:underline mt-0.5">
              + {isIn?"Add expected amount":"Add amount needed"}
            </button>
          ) : (
            <div className="text-[11px] text-slate-300 dark:text-zinc-600 mt-0.5 italic">No amount yet</div>
          )}
          {availText&&(
            <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5">Available {availText}</div>
          )}
        </div>
        {(onEdit||onRemove)&&(
          <div className="flex flex-col gap-1 shrink-0">
            {onEdit&&<button onClick={e=>{e.stopPropagation();onEdit(card);}} className="w-5 h-5 flex items-center justify-center rounded text-slate-300 dark:text-zinc-600 hover:text-teal-500 dark:hover:text-teal-400 text-[11px]">✏️</button>}
            {onRemove&&<button onClick={e=>{e.stopPropagation();onRemove(card.id);}} className="w-5 h-5 flex items-center justify-center rounded text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 text-xs">✕</button>}
          </div>
        )}
      </div>
    </div>
  );
};

const WhiteboardCard = ({ card, h$, liens, availText, onEdit, onRemove, navigate }) => {
  const {attributes,listeners,setNodeRef,transform,isDragging} = useDraggable({id:card.id});
  const style = transform ? {transform:`translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex:10} : undefined;
  return (
    <div ref={setNodeRef} style={style} className={`cursor-grab active:cursor-grabbing touch-none ${isDragging?"opacity-30":""}`}>
      <WhiteboardCardVisual card={card} h$={h$} liens={liens} availText={availText} onEdit={onEdit} onRemove={onRemove} navigate={navigate} dragHandleProps={{...attributes,...listeners}}/>
    </div>
  );
};

// balance is the running cash position after everything through this day — the number that
// answers "will I have enough" — shown big and red the moment it goes negative. net (that
// day's own activity) stays as a small secondary line underneath when it's non-zero.
const WhiteboardColumn = ({ id, label, sub, isToday, isUnscheduled, weekStart, net, balance, settledIn, h$, children, empty }) => {
  const {setNodeRef,isOver} = useDroppable({id});
  const short = balance<0;
  return (
    <div ref={setNodeRef}
      className={`shrink-0 w-56 rounded-2xl p-2.5 transition-colors ${isOver?"bg-teal-50 dark:bg-teal-900/20 ring-2 ring-teal-300 dark:ring-teal-700":short?"bg-red-50/70 dark:bg-red-900/10":isToday?"bg-amber-50/70 dark:bg-amber-900/10":"bg-slate-100/70 dark:bg-zinc-900/40"} ${weekStart?"ml-2":""}`}>
      <div className="px-1 pb-2 mb-2 border-b border-slate-200 dark:border-zinc-700">
        <div className={`text-[11px] font-bold uppercase tracking-wide ${isUnscheduled?"text-slate-400 dark:text-zinc-500":isToday?"text-amber-600 dark:text-amber-400":"text-slate-600 dark:text-zinc-300"}`}>{label}</div>
        {sub&&<div className="text-[10px] text-slate-400 dark:text-zinc-500">{sub}</div>}
        {balance!=null&&(
          <div className={`text-sm font-black tabular-nums mt-0.5 ${short?"text-red-600 dark:text-red-400":"text-slate-700 dark:text-zinc-200"}`}>{short?"⚠ −":""}{h$(Math.abs(balance))}</div>
        )}
        {!isUnscheduled&&net!==0&&(
          <div className={`text-[11px] font-semibold tabular-nums mt-0.5 ${net>=0?"text-emerald-600 dark:text-emerald-400":"text-red-500 dark:text-red-400"}`}>{net>=0?"+":"−"}{h$(Math.abs(net))} today</div>
        )}
        {/* Money dragged onto an earlier day still counts here instead, once it clears (1
            business day later) — spell that out, or a balance jump here looks unexplained. */}
        {settledIn&&settledIn.length>0&&(
          <div className="mt-1 space-y-0.5">
            {settledIn.map((c,i)=>(
              <div key={i} className="text-[10px] text-emerald-600 dark:text-emerald-400">+{h$(c.amount)} clearing from {c.address} ({wbFmtDate(c.day)})</div>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-[70px]">
        {children}
        {empty&&<div className="text-[11px] text-slate-300 dark:text-zinc-600 italic text-center py-4">{isUnscheduled?"Drop cards here first":"—"}</div>}
      </div>
    </div>
  );
};

function WhiteboardCardModal({ properties, init, onSave, onClose }) {
  const [mode,setMode] = useState(init?.kind || "property");
  const [propId,setPropId] = useState(init?.propId || "");
  const [address,setAddress] = useState(init?.address || "");
  const [amount,setAmount] = useState(init ? String(init.amount||"") : "");
  const [direction,setDirection] = useState(init?.direction || "out");
  const [propSearch,setPropSearch] = useState("");
  const [amountLocked,setAmountLocked] = useState(()=>!!init?.amount);

  const activeProps = (properties||[]).filter(p=>!p.dateSold);
  const filtered = activeProps.filter(p=>!propSearch||p.address?.toLowerCase().includes(propSearch.toLowerCase()));
  // Only the address/description (and, for a property card, which property) is required —
  // the amount is added whenever it's actually known, which for a property is usually only
  // once it's under contract or closer to closing.
  const canSave = mode==="property" ? !!propId : address.trim().length>0;

  return (
    <Modal title={init?"Edit Card":"Add Card"} onClose={onClose}>
      <div className="space-y-3">
        {!init&&(
          <div className="grid grid-cols-2 bg-slate-100 dark:bg-zinc-800 rounded-xl p-1 gap-1 mb-1">
            <button type="button" onClick={()=>setMode("property")}
              className={`py-1.5 rounded-lg text-xs font-semibold transition-all ${mode==="property"?"bg-white dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-400 dark:text-zinc-500"}`}>🏠 Property</button>
            <button type="button" onClick={()=>{setMode("manual");setPropId("");setAddress("");}}
              className={`py-1.5 rounded-lg text-xs font-semibold transition-all ${mode==="manual"?"bg-white dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-400 dark:text-zinc-500"}`}>🔑 Purchase Closing</button>
            <button type="button" onClick={()=>{setMode("misc");setPropId("");setAddress("");}}
              className={`py-1.5 rounded-lg text-xs font-semibold transition-all ${mode==="misc"?"bg-white dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-400 dark:text-zinc-500"}`}>💵 Other</button>
            <button type="button" onClick={()=>{setMode("bill");setPropId("");setAddress("");}}
              className={`py-1.5 rounded-lg text-xs font-semibold transition-all ${mode==="bill"?"bg-white dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-400 dark:text-zinc-500"}`}>🧾 Bill, No Due Date</button>
          </div>
        )}

        {mode==="misc"&&(
          <div className="mb-1">
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Direction</label>
            <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-xl p-1 gap-1">
              <button type="button" onClick={()=>setDirection("in")}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${direction==="in"?"bg-white dark:bg-zinc-700 text-emerald-600 dark:text-emerald-400 shadow-sm":"text-slate-400 dark:text-zinc-500"}`}>+ Money In</button>
              <button type="button" onClick={()=>setDirection("out")}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${direction==="out"?"bg-white dark:bg-zinc-700 text-red-600 dark:text-red-400 shadow-sm":"text-slate-400 dark:text-zinc-500"}`}>− Money Out</button>
            </div>
          </div>
        )}

        {mode==="property"?(
          <div className="mb-1">
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Property</label>
            {propId?(
              <div className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-zinc-700 px-4 py-3">
                <span className="text-sm font-semibold text-slate-800 dark:text-zinc-100 truncate">{address}</span>
                <button type="button" onClick={()=>{setPropId("");setAddress("");}} className="text-xs font-semibold text-teal-500 hover:underline shrink-0 ml-2">Change</button>
              </div>
            ):(
              <>
                <input type="text" value={propSearch} onChange={e=>setPropSearch(e.target.value)} placeholder="Search properties…"
                  className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-xl px-4 py-2.5 text-sm mb-2 text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-teal-500"/>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {filtered.map(p=>(
                    <button key={p.id} type="button" onClick={()=>{setPropId(p.id);setAddress(p.address);}}
                      className="w-full text-left px-3 py-2 rounded-lg text-sm bg-slate-50 dark:bg-zinc-800 hover:bg-teal-50 dark:hover:bg-teal-900/20 text-slate-800 dark:text-zinc-100 transition-colors truncate">
                      {p.address}
                    </button>
                  ))}
                  {filtered.length===0&&<div className="text-xs text-slate-400 dark:text-zinc-500 text-center py-3">No matches</div>}
                </div>
              </>
            )}
            {propId&&<p className="text-[11px] text-slate-400 dark:text-zinc-500 mt-2">Shows all current liens on this property automatically.</p>}
          </div>
        ):mode==="misc"?(
          <Inp label="Description" value={address} onChange={setAddress} placeholder="e.g. Contractor draw, personal loan, refund"/>
        ):mode==="bill"?(
          <Inp label="What's it for?" value={address} onChange={setAddress} placeholder="e.g. Insurance, materials invoice, utility bill"/>
        ):(
          <Inp label="Address" value={address} onChange={setAddress} placeholder="123 Oak Ave, Nashville, TN"/>
        )}

        <Lockable locked={amountLocked} onToggle={()=>setAmountLocked(l=>!l)}>
          <Inp label={`${mode==="property"?"Expected Amount":"Amount"}${mode==="bill"?"":" — optional"} ($)`} money value={amount} onChange={setAmount} placeholder="150000"
            helpText={mode==="property"?"Add now if you know it, or leave blank and fill it in closer to closing":mode==="bill"?"You can leave this blank and fill it in once you know it":"Add now if you know it, or leave blank and fill it in once you do"}/>
        </Lockable>
        {mode==="bill"&&<p className="text-[11px] text-slate-400 dark:text-zinc-500 -mt-2">No due date needed — it goes straight into the Due Now queue, ranked by when it came in. Use the ▲▼ arrows there to reprioritize.</p>}

        <div className="flex gap-2 pt-1">
          <Btn color={canSave?"blue":"ghost"} disabled={!canSave} onClick={()=>canSave&&onSave({
            id: init?.id || uid(),
            kind: mode,
            propId: mode==="property" ? propId : null,
            address: address.trim(),
            amount: parseFloat(amount)||0,
            direction: mode==="misc" ? direction : mode==="bill" ? "out" : (init?.direction || (mode==="property" ? "in" : "out")),
            day: mode==="bill" ? null : (init?.day ?? null),
          })}>Save</Btn>
          <Btn color="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}

// Read-only cards auto-generated from every active monthly-pay loan (hard money's monthly
// interest, or any other monthly_fixed loan) — one per loan for each 1st-of-the-month date
// in view, since that's always the bill date (arrears). Purely computed each render, never
// stored, so they always reflect the live loan/property data.
const upcomingLoanPayments = (data, dayCols) => {
  const firsts = dayCols.filter(d=>d.slice(8,10)==="01");
  if (!firsts.length) return [];
  const allLoans = [
    ...(data.properties||[]).flatMap(p=>(p.loans||[]).map(l=>({...l, _addr:p.address, _propId:p.id}))),
    ...(data.unassigned||[]).map(l=>({...l, _addr:"Unassigned", _propId:null})),
  ].filter(l=>!l.endDate && monthlyLoanPayment(l)>0);
  const out = [];
  for (const first of firsts) {
    for (const l of allLoans) {
      if (l.startDate && l.startDate>=first) continue; // hasn't been outstanding a full month yet
      out.push({
        id: `pmt-${l.id}-${first}`,
        loanId: l.id,
        propId: l._propId,
        address: l._addr,
        lenderName: l.lenderName,
        amount: monthlyLoanPayment(l),
        day: first,
      });
    }
  }
  return out;
};

const WhiteboardPaymentCard = ({ card, h$, navigate }) => (
  <div className="rounded-xl border border-dashed border-slate-300 dark:border-zinc-600 p-3 mb-2 bg-slate-50 dark:bg-zinc-800/60">
    <div className="flex items-center gap-1.5 mb-0.5">
      <span className="text-[10px]">🏦</span>
      <button onClick={e=>{e.stopPropagation();navigate&&navigate({type:'loan',loanId:card.loanId,propId:card.propId});}}
        className="font-semibold text-[12px] text-slate-600 dark:text-zinc-300 hover:text-teal-600 dark:hover:text-teal-400 hover:underline truncate text-left">
        {card.lenderName||"Unknown"}
      </button>
    </div>
    {card.address&&<div className="text-[10px] text-slate-400 dark:text-zinc-500 truncate">{card.address}</div>}
    <div className="text-base font-black tabular-nums mt-0.5 text-red-500 dark:text-red-400">−{h$(card.amount)}</div>
    <div className="text-[10px] text-slate-300 dark:text-zinc-600 mt-0.5 italic">Loan payment · auto</div>
  </div>
);

// Bills/invoices with no due date — pay-ASAP, ranked by when they came in (default) or a
// manual override via the up/down arrows, kept in their own queue instead of forced onto a
// specific day since there isn't one yet. Also draggable onto a day, same as any other card —
// once it has a day it leaves this queue and shows up there instead (see cardsFor).
const WhiteboardBillCard = ({ card, h$, canMoveUp, canMoveDown, onMove, onEdit, onRemove }) => {
  const {attributes,listeners,setNodeRef,transform,isDragging} = useDraggable({id:card.id});
  const style = transform ? {transform:`translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex:10} : undefined;
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}
      className={`rounded-xl border border-amber-300 dark:border-amber-700 p-3 mb-2 bg-white dark:bg-zinc-800 shadow-sm cursor-grab active:cursor-grabbing touch-none select-none ${isDragging?"opacity-30":""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[13px] text-slate-800 dark:text-zinc-100 truncate">{card.address}</div>
          {(card.amount||0)>0 ? (
            <div className="text-lg font-black tabular-nums mt-0.5 text-red-600 dark:text-red-400">−{h$(card.amount)}</div>
          ) : onEdit ? (
            <button onClick={e=>{e.stopPropagation();onEdit(card);}} className="text-[11px] font-semibold text-teal-500 dark:text-teal-400 hover:underline mt-0.5">+ Add amount</button>
          ) : (
            <div className="text-[11px] text-slate-300 dark:text-zinc-600 mt-0.5 italic">No amount yet</div>
          )}
          <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5">since {wbFmtDate(card.addedAt||TODAY)}</div>
        </div>
        <div className="flex flex-col gap-1 shrink-0 items-center">
          <button disabled={!canMoveUp} onClick={e=>{e.stopPropagation();onMove(card.id,-1);}} className="w-5 h-5 flex items-center justify-center rounded text-slate-300 dark:text-zinc-600 hover:text-teal-500 dark:hover:text-teal-400 disabled:opacity-20 text-[11px]">▲</button>
          <button disabled={!canMoveDown} onClick={e=>{e.stopPropagation();onMove(card.id,1);}} className="w-5 h-5 flex items-center justify-center rounded text-slate-300 dark:text-zinc-600 hover:text-teal-500 dark:hover:text-teal-400 disabled:opacity-20 text-[11px]">▼</button>
          {onEdit&&<button onClick={e=>{e.stopPropagation();onEdit(card);}} className="w-5 h-5 flex items-center justify-center rounded text-slate-300 dark:text-zinc-600 hover:text-teal-500 dark:hover:text-teal-400 text-[11px]">✏️</button>}
          {onRemove&&<button onClick={e=>{e.stopPropagation();onRemove(card.id);}} className="w-5 h-5 flex items-center justify-center rounded text-slate-300 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 text-xs">✕</button>}
        </div>
      </div>
    </div>
  );
};

// Droppable, so a bill can be dragged straight onto a day (leaving this queue — see
// cardsFor) and a dated bill can be dragged back here to clear its day again.
const WhiteboardDueNowBox = ({ bills, billsTotal, h$, moveBill, onEdit, onRemove }) => {
  const {setNodeRef,isOver} = useDroppable({id:"duenow"});
  if (!bills.length) return null;
  return (
    <div ref={setNodeRef} className={`shrink-0 w-56 rounded-2xl p-2 transition-colors ${isOver?"bg-teal-50 dark:bg-teal-900/20 ring-2 ring-teal-300 dark:ring-teal-700":"bg-amber-50/70 dark:bg-amber-900/10"}`}>
      <div className="px-1 pb-1.5 mb-1.5 border-b border-slate-200 dark:border-zinc-700 flex items-baseline justify-between gap-2">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">🧾 Due Now</div>
          <div className="text-[10px] text-slate-400 dark:text-zinc-500">No due date · oldest first</div>
        </div>
        {billsTotal>0&&<div className="text-xs font-bold tabular-nums shrink-0 text-red-600 dark:text-red-400">−{h$(billsTotal)}</div>}
      </div>
      <div className="min-h-[40px]">
        {bills.map((c,i)=><WhiteboardBillCard key={c.id} card={c} h$={h$} canMoveUp={i>0} canMoveDown={i<bills.length-1} onMove={moveBill} onEdit={onEdit} onRemove={onRemove}/>)}
      </div>
    </div>
  );
};

function WhiteboardPage({ data, update }) {
  const prv = usePrivacy();
  const navigate = usePanel();
  const h$ = v => prv?maskMoney($$p(v)):$$p(v);
  const cards = data.whiteboard?.cards || [];
  const [addOpen,setAddOpen] = useState(false);
  const [editCard,setEditCard] = useState(null);
  const [activeId,setActiveId] = useState(null);
  const dragSensors = useSensors(useSensor(PointerSensor,{activationConstraint:{distance:8}}));

  const DAYS = 45;
  const dayCols = Array.from({length:DAYS},(_,i)=>wbAddDays(TODAY,i));
  const autoCards = upcomingLoanPayments(data, dayCols);

  // A bill counts as "in the Due Now queue" only while it has no day — drag it onto a day and
  // it shows up there like any other card instead (still excluded from Unscheduled, since a
  // dayless bill belongs in Due Now, not that column).
  const cardsFor = day => cards.filter(c=>(c.day||null)===day && (day!=null || c.kind!=="bill"));
  const autoCardsFor = day => autoCards.filter(c=>c.day===day);
  const unscheduled = cardsFor(null);
  const bills = cards.filter(c=>c.kind==="bill" && !c.day).sort((a,b)=>(a.order??0)-(b.order??0));
  const billsTotal = bills.reduce((s,c)=>s+(c.amount||0),0);
  // Net for a day counts out-cards placed that day plus in-cards that actually SETTLE
  // that day (1 business day after the day they're dropped on), not cards merely placed
  // there — so a Thursday deposit doesn't look available for a Thursday closing. Auto loan
  // payments always land on their own day (the 1st) with no settlement delay — they go out.
  const netFor = day => cards
    .filter(c=>c.day && wbEffectiveDate(c)===day)
    .reduce((s,c)=>s+(c.direction==="in"?(c.amount||0):-(c.amount||0)),0)
    - autoCardsFor(day).reduce((s,c)=>s+(c.amount||0),0);
  // A card dragged onto day X but settling on day Y (see wbEffectiveDate) still shows on X —
  // this is what lets Y's balance jump make sense without hunting for the card.
  const settledInFor = day => cards.filter(c=>c.day && c.day!==day && c.direction==="in" && (c.amount||0)>0 && wbEffectiveDate(c)===day);
  // Running cash balance through each day, so a shortfall shows up on the exact day it
  // happens instead of needing to be worked out by hand. Only counts money that's actually
  // on a date — Due Now bills and Unscheduled cards have no date, so they sit outside this
  // entirely until they're given one.
  const startingBalance = data.whiteboard?.startingBalance || 0;
  const balances = {};
  {
    let running = startingBalance;
    for (const day of dayCols) {
      running += netFor(day);
      balances[day] = running;
    }
  }
  // Current liens on a linked property, pulled live every render — so if a loan gets paid
  // off or a new one's added, the card reflects it automatically without re-entering anything.
  const liensFor = propId => {
    const prop = (data.properties||[]).find(p=>p.id===propId);
    if (!prop) return [];
    return (prop.loans||[]).filter(l=>!l.endDate).map(l=>({
      lenderName: l.lenderName,
      amt: (l.principal||0)+(l.drawFacility?.committed||0),
    }));
  };

  const saveCard = c => update(d=>{
    const existing = d.whiteboard?.cards||[];
    const already = existing.some(x=>x.id===c.id);
    let card = c;
    if (card.kind==="bill" && card.order==null) {
      const maxOrder = existing.filter(x=>x.kind==="bill").reduce((m,x)=>Math.max(m,x.order??0),0);
      card = {...card, order: maxOrder+1, addedAt: card.addedAt || TODAY};
    }
    const nextCards = already ? existing.map(x=>x.id===card.id?{...x,...card}:x) : [...existing,card];
    return {...d, whiteboard:{...d.whiteboard, cards:nextCards}};
  });
  const removeCard = id => {
    if (!window.confirm("Remove this card from the whiteboard?")) return;
    update(d=>({...d, whiteboard:{...d.whiteboard, cards:(d.whiteboard?.cards||[]).filter(c=>c.id!==id)}}));
  };
  const setCardDay = (id,day) => update(d=>({...d, whiteboard:{...d.whiteboard, cards:(d.whiteboard?.cards||[]).map(c=>c.id===id?{...c,day}:c)}}));
  const setStartingBalance = v => update(d=>({...d, whiteboard:{...d.whiteboard, startingBalance:v}}));
  const moveBill = (id,dir) => update(d=>{
    const all = d.whiteboard?.cards||[];
    const sorted = all.filter(c=>c.kind==="bill" && !c.day).sort((a,b)=>(a.order??0)-(b.order??0));
    const idx = sorted.findIndex(c=>c.id===id);
    const swapIdx = idx+dir;
    if (idx<0||swapIdx<0||swapIdx>=sorted.length) return d;
    const a=sorted[idx], b=sorted[swapIdx];
    const aOrder=a.order??0, bOrder=b.order??0;
    return {...d, whiteboard:{...d.whiteboard, cards: all.map(c=>{
      if(c.id===a.id) return {...c,order:bOrder};
      if(c.id===b.id) return {...c,order:aOrder};
      return c;
    })}};
  });

  const handleDragEnd = ({active,over}) => {
    setActiveId(null);
    if (!over) return;
    setCardDay(active.id, (over.id==="unscheduled"||over.id==="duenow") ? null : over.id);
  };

  const activeCard = cards.find(c=>c.id===activeId);
  // Cards still sitting in Unscheduled haven't been given a day yet, and bills still in Due
  // Now have no day at all — neither feeds into any day's balance, so exclude both here too,
  // or this total wouldn't match what the day columns actually add up to. A bill dragged onto
  // a day counts here exactly like any other dated card. Due Now shows its own total on its
  // own box for bills that haven't been given a day yet.
  const scheduledCards = cards.filter(c=>c.day);
  const totalIn = scheduledCards.reduce((s,c)=>s+(c.direction==="in"?(c.amount||0):0),0);
  const totalOut = scheduledCards.reduce((s,c)=>s+(c.direction==="out"?(c.amount||0):0),0) + autoCards.reduce((s,c)=>s+(c.amount||0),0);
  const [sbInput,setSbInput] = useState(String(startingBalance||""));
  useEffect(()=>{ setSbInput(String(startingBalance||"")); }, [startingBalance]);

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Whiteboard</h2>
          <p className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5 max-w-md">A manual planning board, separate from the rest of the tracker — drag cards onto a day to plan upcoming money in and out. Incoming money takes 1 business day to clear, loan payments are pulled in on the 1st automatically, and bills with no due date live in the Due Now queue on the left.</p>
        </div>
        <Btn onClick={()=>setAddOpen(true)} color="blue">+ Add Card</Btn>
      </div>

      <div className="flex gap-3 mb-4 flex-wrap">
        <div className="flex-1 min-w-[140px] bg-white dark:bg-[#1C1F2B] rounded-2xl p-3 shadow-[0_2px_12px_rgba(0,0,0,0.07)]">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Starting Balance</div>
          <div className="flex items-baseline gap-0.5">
            <span className="text-lg font-black text-slate-700 dark:text-zinc-200">$</span>
            <input type="text" inputMode="decimal" value={sbInput}
              onChange={e=>setSbInput(e.target.value)}
              onBlur={()=>setStartingBalance(parseFloat(sbInput)||0)}
              className="text-lg font-black tabular-nums bg-transparent w-full focus:outline-none text-slate-700 dark:text-zinc-200 min-w-0"/>
          </div>
        </div>
        {(cards.length>0||autoCards.length>0)&&(<>
          <div className="flex-1 min-w-[110px] bg-white dark:bg-[#1C1F2B] rounded-2xl p-3 shadow-[0_2px_12px_rgba(0,0,0,0.07)]">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Total In</div>
            <div className="text-lg font-black text-emerald-600 dark:text-emerald-400 tabular-nums">+{h$(totalIn)}</div>
          </div>
          <div className="flex-1 min-w-[110px] bg-white dark:bg-[#1C1F2B] rounded-2xl p-3 shadow-[0_2px_12px_rgba(0,0,0,0.07)]">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-0.5">Total Out</div>
            <div className="text-lg font-black text-red-600 dark:text-red-400 tabular-nums">−{h$(totalOut)}</div>
          </div>
        </>)}
      </div>

      {cards.length===0&&autoCards.length===0?(
        <div className="text-center py-16 text-slate-400 dark:text-zinc-500">
          <div className="text-4xl mb-3">📌</div>
          <p className="font-semibold">Nothing on the board yet</p>
          <p className="text-xs mt-1 max-w-xs mx-auto">Add a card for a property you're closing on or one you expect to sell, then drag it onto the day it's happening.</p>
        </div>
      ):(
        <DndContext sensors={dragSensors} onDragStart={e=>setActiveId(e.active.id)} onDragEnd={handleDragEnd}>
          <div className="flex gap-3 overflow-x-auto pb-4 -mx-1 px-1">
            <WhiteboardDueNowBox bills={bills} billsTotal={billsTotal} h$={h$} moveBill={moveBill} onEdit={setEditCard} onRemove={removeCard}/>
            <WhiteboardColumn id="unscheduled" label="Unscheduled" isUnscheduled h$={h$} empty={unscheduled.length===0}>
              {unscheduled.map(c=><WhiteboardCard key={c.id} card={c} h$={h$} liens={c.kind==="property"?liensFor(c.propId):null} onEdit={setEditCard} onRemove={removeCard} navigate={navigate}/>)}
            </WhiteboardColumn>
            {dayCols.map((day,i)=>(
              <WhiteboardColumn key={day} id={day} h$={h$}
                label={i===0?"Today":wbFmtDate(day)}
                sub={i===0?wbFmtDate(day):wbWeekday(day)}
                isToday={i===0} weekStart={i>0&&i%7===0} net={netFor(day)} balance={balances[day]} settledIn={settledInFor(day)} empty={cardsFor(day).length===0&&autoCardsFor(day).length===0}>
                {autoCardsFor(day).map(c=><WhiteboardPaymentCard key={c.id} card={c} h$={h$} navigate={navigate}/>)}
                {cardsFor(day).map(c=><WhiteboardCard key={c.id} card={c} h$={h$} liens={c.kind==="property"?liensFor(c.propId):null} availText={c.direction==="in"?wbFmtDate(wbEffectiveDate(c)):null} onEdit={setEditCard} onRemove={removeCard} navigate={navigate}/>)}
              </WhiteboardColumn>
            ))}
          </div>
          <DragOverlay>
            {activeCard&&<div className="w-56"><WhiteboardCardVisual card={activeCard} h$={h$} liens={activeCard.kind==="property"?liensFor(activeCard.propId):null}/></div>}
          </DragOverlay>
        </DndContext>
      )}

      {(addOpen||editCard)&&(
        <WhiteboardCardModal properties={data.properties} init={editCard}
          onSave={c=>{saveCard(c);setAddOpen(false);setEditCard(null);}}
          onClose={()=>{setAddOpen(false);setEditCard(null);}}/>
      )}
    </div>
  );
}

// ─── Entity Detail Pages ──────────────────────────────────────────────────────
// Shared by PropertyDetailPage and LenderDetailPage — pure/props-only.
const SectionHead = ({title, count}) => (
  <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-3 flex items-center gap-2">
    {title}{count != null && <span className="text-slate-300 dark:text-zinc-600">({count})</span>}
  </div>
);

function PropertyDetailPage({ propId, data, update, onBack, navigate }) {
  const prv = usePrivacy();
  const h$ = v => prv ? maskMoney($$p(v)) : $$p(v);
  const hs = v => prv ? maskMoney($$ps(v)) : $$ps(v);
  const hr = l => { if(!prv) return fmtRate(l); const s=fmtRate(l); return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s); };
  const [editing, setEditing] = useState(false);
  const [moveLoan, setMoveLoan] = useState(null);
  const [addingLoan, setAddingLoan] = useState(false);
  const [addingOverage, setAddingOverage] = useState(false);
  const [editingOverage, setEditingOverage] = useState(null);
  const [loanFormDirty, setLoanFormDirty] = useState(false);
  const closeAddingLoan = () => confirmDiscard(loanFormDirty, () => setAddingLoan(false));

  const prop = data.properties.find(p => p.id === propId);
  if (!prop) return (
    <div className="flex flex-col items-center justify-center py-20 gap-3 px-5">
      <div className="text-slate-400 dark:text-zinc-500 text-sm">Property not found</div>
      <button onClick={onBack} className="text-sm text-teal-600 dark:text-teal-400 hover:underline">← Back</button>
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

  // Same save logic as the "Add Lender Money" flow used everywhere else (PropertiesPage's
  // saveMoneyForm) — kept in sync with it rather than a simplified reimplementation, since
  // this is the exact same LenderMoneyForm screen, just opened from a property's own page
  // and pre-targeted at it.
  const saveNewLoan = f => {
    const base = loanFields(f);
    if (f.destination==="unassigned") {
      update(d=>upsertLender({...d,unassigned:[...(d.unassigned||[]),{id:uid(),...base}]},f.newLender));
      setAddingLoan(false);
      return;
    }
    const destProp = data.properties.find(p=>p.id===f.destination);
    const conflict = destProp ? propConflict(base.startDate,base.principal,destProp) : null;
    if (conflict) {
      alert(conflict==='date'
        ? "Cannot place here — this property was acquired after this loan started, so for that stretch of time the loan wouldn't have had this property backing it up."
        : "Cannot place here — not enough funding gap on this property (including 10% contingency). Consider splitting this loan or choosing a property with a larger funding need.");
      return;
    }
    update(d=>upsertLender({...d,properties:d.properties.map(p=>p.id!==f.destination?p:{...p,loans:[...p.loans,{id:uid(),...base}]})},f.newLender));
    setAddingLoan(false);
  };

  const saveOverageCheck = entry => {
    update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,overageChecks:[...(p.overageChecks||[]),{id:uid(),...entry}]})}));
    setAddingOverage(false);
  };
  const saveEditedOverageCheck = (id,entry) => {
    update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,overageChecks:(p.overageChecks||[]).map(c=>c.id!==id?c:{...c,...entry})})}));
    setEditingOverage(null);
  };
  const deleteOverageCheck = id => {
    update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,overageChecks:(p.overageChecks||[]).filter(c=>c.id!==id)})}));
    setEditingOverage(null);
  };

  return (
    <div className="px-5 pt-4 pb-8 w-full max-w-5xl mx-auto">
      {/* Back + header */}
      <div className="mb-5">
        <button onClick={onBack} className="flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-zinc-500 hover:text-teal-600 dark:hover:text-teal-400 transition-colors mb-3">
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
          <div className="flex items-center gap-2 shrink-0">
            {prop.dateSold && (
              <button onClick={()=>{
                if(!window.confirm(`Reopen "${prop.address||"this property"}"? It'll move back to Active Properties and its closing record will be cleared — you'll re-enter closing details if you close it again. Loans that were paid off or rolled as part of this sale are NOT reopened; adjust those individually if needed.`)) return;
                update(d=>({...d,properties:d.properties.map(p=>p.id!==propId?p:{...p,dateSold:null,isRental:false,closingData:null})}));
              }}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 hover:text-amber-600 dark:hover:text-amber-400 hover:border-amber-300 dark:hover:border-amber-700 shadow-sm transition-all">
                ↺ Reopen
              </button>
            )}
            <button onClick={()=>setEditing(e=>!e)}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 hover:text-teal-600 dark:hover:text-teal-400 hover:border-teal-300 dark:hover:border-teal-700 shadow-sm transition-all">
              {editing?"✕ Cancel":"✏️ Edit"}
            </button>
          </div>
        </div>
      </div>
      {editing && prop.dateSold && (
        <EditClosingModal prop={prop} onSave={updates=>{
          update(d=>({...d,
            properties:d.properties.map(p=>p.id!==propId?p:{...p,dateSold:updates.dateSold,isRental:updates.isRental,closingData:updates.closingData})
          }));
          setEditing(false);
        }} onClose={()=>setEditing(false)}/>
      )}
      {editing && !prop.dateSold && (
        <div className="mb-6 bg-white dark:bg-[#1C1F2B] rounded-2xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
          <div className="text-[10px] font-bold uppercase tracking-widest text-teal-500 dark:text-teal-400 mb-4">Edit Property Details</div>
          <PropertyForm init={prop} lenders={data.lenders||[]} onSave={f=>{
            update(d=>{
              const {lenders,unassigned,propLoanAdds}=routeLoanDrafts(d,f.loanDrafts,propId);
              let properties=d.properties.map(p=>p.id!==propId?p:{
                ...p,
                address:f.address||p.address,
                purchaseDate:f.purchaseDate,
                purchasePrice:parseFloat(f.purchasePrice)||0,
                closingBuy:f.closingBuy||null,
                rehabBudget:f.rehabBudget!==""?parseFloat(f.rehabBudget)||0:p.rehabBudget,
                monthlyHolding:f.monthlyHolding!==""?parseFloat(f.monthlyHolding)||500:p.monthlyHolding,
                projectMonths:f.projectMonths!==""?parseFloat(f.projectMonths)||null:p.projectMonths,
                loans:[...p.loans,...(propLoanAdds[propId]||[])],
              });
              properties=properties.map(x=>x.id===propId?x:(propLoanAdds[x.id]?{...x,loans:[...x.loans,...propLoanAdds[x.id]]}:x));
              return {...d,lenders,unassigned,properties};
            });
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
            ["Funded", h$(funded), "text-teal-600 dark:text-teal-400"],
            ["Shortage", h$(shortage), shortage>0?"text-red-500 dark:text-red-400":"text-emerald-600 dark:text-emerald-400"],
          ].map(([label, val, color]) => (
            <div key={label} className="bg-white dark:bg-[#1C1F2B] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
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
            ["Profit", hs(effectiveProfit(prop)), effectiveProfit(prop)>=0?"text-emerald-600 dark:text-emerald-400":"text-red-500 dark:text-red-400"],
          ].map(([label, val, color]) => (
            <div key={label} className="bg-white dark:bg-[#1C1F2B] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">{label}</div>
              <div className={`text-lg font-bold tabular-nums ${color || "text-slate-900 dark:text-zinc-100"}`}>{val}</div>
            </div>
          ))}
        </div>
      ) : null}

      {/* Overage checks — insurance/tax/overcharge refunds that can show up any time, on a
          property still owned or one already closed. */}
      <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
        {(prop.closingData?.overageRefund||0)>0&&(prop.overageChecks||[]).length>0&&(
          <div className="px-5 py-2.5 bg-amber-50 dark:bg-amber-900/10 border-b border-amber-100 dark:border-amber-900/30 text-[11px] text-amber-700 dark:text-amber-400">
            ⚠ This property also has a {h$(prop.closingData.overageRefund)} lender overage refund recorded at closing — double-check none of the checks below are the same money counted twice.
          </div>
        )}
        <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800 flex items-center justify-between gap-3">
          <SectionHead title="Overage Checks" count={(prop.overageChecks||[]).length}/>
          <button onClick={()=>setAddingOverage(true)}
            className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white transition-colors">+ Overage Check</button>
        </div>
        {(prop.overageChecks||[]).length===0 && (
          <div className="px-5 py-6 text-center text-sm text-slate-400 dark:text-zinc-500">No overage checks recorded yet</div>
        )}
        <div className="divide-y divide-slate-50 dark:divide-zinc-800">
          {(prop.overageChecks||[]).map(c=>(
            <div key={c.id} className="px-5 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800 dark:text-zinc-100">{overageSourceLabel(c.source)} <span className="font-normal text-slate-400 dark:text-zinc-500">· {c.date}</span></div>
                {c.notes && <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5 truncate">{c.notes}</div>}
              </div>
              <div className="shrink-0 flex items-center gap-2">
                <span className="font-bold tabular-nums text-emerald-600 dark:text-emerald-400">+{h$(c.amount)}</span>
                <button onClick={()=>setEditingOverage(c)}
                  className="w-6 h-6 flex items-center justify-center rounded text-slate-300 dark:text-zinc-600 hover:text-teal-500 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-all text-xs" title="Edit">✏️</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {addingOverage && (
        <div className="mb-4">
          <OverageCheckModal prop={prop} onSave={saveOverageCheck} onClose={()=>setAddingOverage(false)}/>
        </div>
      )}
      {editingOverage && (
        <div className="mb-4">
          <OverageCheckModal prop={prop} init={editingOverage}
            onSave={entry=>saveEditedOverageCheck(editingOverage.id,entry)}
            onDelete={()=>deleteOverageCheck(editingOverage.id)}
            onClose={()=>setEditingOverage(null)}/>
        </div>
      )}

      {/* Active loans — header (with Add Loan) always shows, even with none yet, so a loan
          can start on this property without leaving the page for a separate screen. */}
      {!prop.dateSold && (
        <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-zinc-800 flex items-center justify-between gap-3">
            <SectionHead title="Active Loans" count={active.length}/>
            <button onClick={()=>setAddingLoan(true)}
              className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white transition-colors">+ Add Loan</button>
          </div>
          {active.length===0 && (
            <div className="px-5 py-6 text-center text-sm text-slate-400 dark:text-zinc-500">No active loans on this property yet</div>
          )}
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
                      <button onClick={() => navigate({type:'loan', loanId:l.id, propId:prop.id})} className="font-semibold text-teal-600 dark:text-teal-400 hover:underline text-sm text-left">
                        {l.lenderName || "Unknown Lender"}
                      </button>
                      <TypeLabel type={l.loanType}/>
                      <LockBadge loan={l}/>
                    </div>
                    {l.loanType!=="hard"&&<button onClick={()=>setMoveLoan(l)} className="text-[11px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-teal-600 dark:hover:text-teal-400 shrink-0 whitespace-nowrap transition-colors">Move →</button>}
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
                    <div className="mt-3 p-3 bg-teal-50 dark:bg-teal-950/30 rounded-xl border border-teal-100 dark:border-teal-900/40">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-bold text-teal-600 dark:text-teal-400 uppercase tracking-widest">Draw Facility</span>
                      </div>
                      <div className="grid grid-cols-3 gap-3 text-xs text-center mb-2">
                        {[["Committed", h$(l.drawFacility.committed||0),"text-teal-700 dark:text-teal-300"],["Drawn",h$(drawn),"text-amber-600 dark:text-amber-400"],["Available",h$(drawRemaining(l)),"text-emerald-600 dark:text-emerald-400"]].map(([lbl,val,c])=>(
                          <div key={lbl}><div className="text-[9px] text-teal-400 dark:text-teal-500 uppercase mb-0.5">{lbl}</div><div className={`font-bold tabular-nums ${c}`}>{val}</div></div>
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
        <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
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
                    <button onClick={() => navigate({type:'loan', loanId:l.id, propId:prop.id})} className="font-semibold text-teal-600 dark:text-teal-400 hover:underline text-left">{l.lenderName||"Unknown"}</button>
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
        <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
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
                      ? <button onClick={() => navigate({type:'loan', loanId:lp.loanId, propId:prop.id})} className="font-semibold text-teal-600 dark:text-teal-400 hover:underline text-left">{lp.lenderName||"Unknown"}</button>
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

      {addingLoan&&(
        <Modal title="Add Lender Money" onClose={closeAddingLoan}>
          <LenderMoneyForm properties={data.properties} lenders={data.lenders||[]} unassigned={data.unassigned}
            init={{destination:propId}} lockDestinationTo={{id:propId,label:prop.address}}
            onSave={saveNewLoan} onClose={closeAddingLoan} onDirtyChange={setLoanFormDirty}/>
        </Modal>
      )}
    </div>
  );
}

function LenderDetailPage({ name, data, update, onBack, navigate }) {
  const prv = usePrivacy();
  const h$ = v => prv ? maskMoney($$p(v)) : $$p(v);
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

  // Payment settings — how this lender's interest is actually billed (grace period, day
  // count, flat vs. per-diem monthly amount, first month prepaid at closing, per-draw fee).
  // Seeded from whatever's saved, falling back to the defaults that match current app
  // behavior for this lender's loan type, so nothing changes until explicitly adjusted.
  const currentLoanType = allLoans[0]?.loanType || "private";
  const [psForm, setPsForm] = useState(() => resolveLenderSettings(data, name, currentLoanType));
  const [psSaved, setPsSaved] = useState(false);
  const [drawFeeLocked, setDrawFeeLocked] = useState(!!resolveLenderSettings(data, name, currentLoanType).drawFee);
  const savePaymentSettings = () => {
    update(d => {
      const existing = (d.lenders||[]).find(l => l.name===name);
      const rec = existing ? {...existing, paymentSettings:psForm} : {id:uid(), name, loanType:currentLoanType, paymentSettings:psForm};
      return {...d, lenders:[...(d.lenders||[]).filter(l=>l.name!==name), rec]};
    });
    setPsSaved(true);
    setTimeout(()=>setPsSaved(false), 1500);
  };
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
    const isSplit = pt==="monthly_rate_split";
    // A split loan (e.g. an equity-line lender) is really TWO income streams: the
    // monthly-paid portion, real cash prorated across every calendar year same as any other
    // monthly-paid loan below, and the closing-portion, only realized (or waived) once the
    // loan actually closes — same cash-basis treatment as a plain "closing" loan.
    if (pt==="closing" || isSplit) {
      const closingBasis = asOf => isSplit ? calcIntEarned(l,asOf)-calcMonthlyPaidPortion(l,asOf) : calcIntEarned(l,asOf);
      if (l.endDate) {
        // A property sale can roll a lender's payoff instead of cutting a check — check the
        // actual disposition: "rollFull"/"payInterest"/"paidOut"/"custom" still realize the
        // interest (constructive receipt, even if reinvested); "rollPrincipal"/"waiveInterest"
        // mean the lender never actually got that interest, so it isn't taxable income to them.
        if (isWaived(l)) {
          waivedInterest += closingBasis(l.endDate);
          waivedCount += 1;
        } else {
          bumpYear(l.endDate.slice(0,4), "interest", closingBasis(l.endDate));
        }
      } else {
        pendingInterest += closingBasis(TODAY);
        pendingCount += 1;
      }
    }
    if (pt!=="closing" && l.startDate) {
      // Prorate whatever's actually paid out monthly across every calendar year the loan
      // was active in — the full amount for a plain monthly loan, or just the matched
      // portion for a split one (the rest is handled as closing-basis above).
      const monthlyBasis = asOf => isSplit ? calcMonthlyPaidPortion(l,asOf) : calcIntEarned(l,asOf);
      const lastDate = l.endDate || TODAY;
      const startY = parseInt(l.startDate.slice(0,4));
      const endY = parseInt(lastDate.slice(0,4));
      for (let y=startY; y<=endY; y++) {
        const upTo = y===endY ? lastDate : `${y}-12-31`;
        const cum = monthlyBasis(upTo);
        const cumBefore = y===startY ? 0 : monthlyBasis(`${y-1}-12-31`);
        const portion = cum - cumBefore;
        if (portion) bumpYear(String(y), "interest", portion);
      }
    }
  });
  const sortedYears = Object.keys(yearStats).sort((a,b) => b.localeCompare(a));
  const lifetimePaidOut = Object.values(yearStats).reduce((s,y) => s + y.interest, 0);

  const account = (data.lenderAccounts||[]).find(a => a.name === name || a.lenderName === name);

  return (
    <div className="px-5 pt-4 pb-8 w-full max-w-5xl mx-auto">
      <div className="mb-5">
        <button onClick={onBack} className="flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-zinc-500 hover:text-teal-600 dark:hover:text-teal-400 transition-colors mb-3">
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
          <button onClick={()=>{setEditName(name);setEditing(e=>!e);}} className="shrink-0 mt-1 px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 hover:text-teal-600 dark:hover:text-teal-400 hover:border-teal-300 dark:hover:border-teal-700 shadow-sm transition-all">
            {editing?"✕ Cancel":"✏️ Edit"}
          </button>
        </div>
      </div>

      {editing&&(
        <div className="mb-6 bg-white dark:bg-[#1C1F2B] rounded-2xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.07)] border border-slate-100 dark:border-zinc-800">
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

      {/* Payment Settings — how this lender's interest is actually billed, applied to every loan from them */}
      {editing && (
      <div className="mb-6 bg-white dark:bg-[#1C1F2B] rounded-2xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.07)] border border-slate-100 dark:border-zinc-800">
        <div className="text-[10px] font-bold uppercase tracking-widest text-violet-500 dark:text-violet-400 mb-1">Payment Settings</div>
        <p className="text-[11px] text-slate-400 dark:text-zinc-500 mb-4">How {name}'s monthly interest payments are actually billed — applies to every loan from them, on every property.</p>
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-zinc-700 px-4 py-3 cursor-pointer">
            <div>
              <div className="font-semibold text-sm text-slate-800 dark:text-zinc-100">Prorates stub at closing</div>
              <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">Interest from closing through the end of that month is charged at closing, not rolled into a later payment. Billing always resumes in arrears — the 1st pays for the month that just ended.</div>
            </div>
            <div onClick={()=>setPsForm(f=>({...f,prorateStubAtClosing:!f.prorateStubAtClosing}))}
              className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer shrink-0 ${psForm.prorateStubAtClosing?"bg-teal-500":"bg-slate-200 dark:bg-zinc-600"}`}>
              <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${psForm.prorateStubAtClosing?"translate-x-5":""}`}/>
            </div>
          </label>

          <label className={`flex items-center justify-between gap-3 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-900/10 px-4 py-3 ml-4 ${!psForm.prorateStubAtClosing?"opacity-40 pointer-events-none":"cursor-pointer"}`}>
            <div>
              <div className="font-semibold text-sm text-slate-800 dark:text-zinc-100">Also prepays the next full month</div>
              <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">On top of the stub, one full calendar month is also charged at closing — e.g. close Jul 28: stub covers the rest of July, August is also paid up front, so Sep 1 has nothing due and Oct 1 is the first real payment, covering September</div>
            </div>
            <div onClick={()=>psForm.prorateStubAtClosing&&setPsForm(f=>({...f,firstFullMonthAtClosing:!f.firstFullMonthAtClosing}))}
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${psForm.firstFullMonthAtClosing?"bg-amber-500":"bg-slate-200 dark:bg-zinc-600"}`}>
              <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${psForm.firstFullMonthAtClosing?"translate-x-5":""}`}/>
            </div>
          </label>

          <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-zinc-700 px-4 py-3 cursor-pointer">
            <div>
              <div className="font-semibold text-sm text-slate-800 dark:text-zinc-100">Gives a grace period month</div>
              <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">
                {psForm.prorateStubAtClosing
                  ? "On top of the stub, one extra calendar month is skipped entirely — not charged at closing, not billed later either"
                  : "No payment due on a 1st before the loan's one-month anniversary; the first payment prorates back to origination"}
              </div>
            </div>
            <div onClick={()=>setPsForm(f=>({...f,graceMonth:!f.graceMonth}))}
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${psForm.graceMonth?"bg-teal-500":"bg-slate-200 dark:bg-zinc-600"}`}>
              <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${psForm.graceMonth?"translate-x-5":""}`}/>
            </div>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <Sel label="Day-Count Basis" value={String(psForm.dayCountBasis)} onChange={v=>setPsForm(f=>({...f,dayCountBasis:parseInt(v)}))}
              options={[["360","360-day year"],["365","365-day year"]]}/>
            <Sel label="Monthly Amount" value={psForm.monthlyMethod} onChange={v=>setPsForm(f=>({...f,monthlyMethod:v}))}
              options={[["perDiem","Per-Diem (actual days)"],["flat","Flat (rate ÷ 12)"]]}/>
          </div>

          <Lockable locked={drawFeeLocked} onToggle={()=>setDrawFeeLocked(l=>!l)}>
            <Inp label="Fee Per Draw ($)" money value={String(psForm.drawFee||"")} onChange={v=>setPsForm(f=>({...f,drawFee:parseFloat(v)||0}))} placeholder="0"/>
          </Lockable>

          <div className="flex gap-2 pt-1">
            <Btn color="blue" onClick={savePaymentSettings}>{psSaved?"✓ Saved":"Save Settings"}</Btn>
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
          <div key={label} className="bg-white dark:bg-[#1C1F2B] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">{label}</div>
            <div className={`text-lg font-bold tabular-nums ${color}`}>{val}</div>
          </div>
        ))}
      </div>

      {/* Account info */}
      {account && (
        <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 p-5">
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
        <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
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
                              className="font-medium text-teal-600 dark:text-teal-400 hover:underline text-left shrink-0">
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
        <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
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
                        ? <button onClick={() => navigate({type:'property', id:l.prop.id})} className="font-semibold text-teal-600 dark:text-teal-400 hover:underline text-sm text-left">{l.prop.address}</button>
                        : <span className="font-semibold text-slate-500 dark:text-zinc-400 text-sm">Unassigned</span>
                      }
                      <TypeLabel type={l.loanType}/>
                      <LockBadge loan={l}/>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {l.loanType!=="hard"&&<button onClick={()=>setMoveLoan(l)} className="text-[11px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-teal-600 dark:hover:text-teal-400 whitespace-nowrap transition-colors">Move →</button>}
                      <button onClick={() => navigate({type:'loan', loanId:l.id, propId:l.prop?.id||null, startEditing:false})} className="text-[11px] font-semibold text-slate-400 dark:text-zinc-500 hover:text-teal-600 dark:hover:text-teal-400 whitespace-nowrap transition-colors">
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
  const h$ = v => prv ? maskMoney($$p(v)) : $$p(v);
  const hr = l => { if(!prv) return fmtRate(l); const s=fmtRate(l); return s.includes('%')?s.replace(/[\d.]+(?=%)/,'∙∙'):maskMoney(s); };
  const [editing, setEditing] = useState(false);
  const [ef, setEf] = useState(null);
  const [efLocked, setEfLocked] = useState({});
  const toggleEfLock = k => setEfLocked(l=>({...l,[k]:!l[k]}));
  const [efBlockMsg, setEfBlockMsg] = useState("");
  const [splitEntryMode,setSplitEntryMode]=useState("rate");
  const [splitMonthlyAmt,setSplitMonthlyAmt]=useState("");
  // Keep the rate in sync with the typed dollar amount whenever EITHER changes — not just
  // at the moment the dollar box is typed into — so going back and editing the principal
  // afterward doesn't leave a stale rate behind.
  useEffect(()=>{
    if(!ef||splitEntryMode!=="dollar") return;
    const principal=parseFloat(ef.principal)||0;
    const amt=parseFloat(splitMonthlyAmt)||0;
    setEf(f=>({...f,splitMonthlyRate:principal>0?String(Math.round(amt*12/principal*100*10000)/10000):"0"}));
  },[splitEntryMode,splitMonthlyAmt,ef?.principal]);
  const [closeModal, setCloseModal] = useState(false);
  const [drawDate, setDrawDate] = useState(TODAY);
  const [drawAmt, setDrawAmt] = useState("");
  const [drawLocked, setDrawLocked] = useState({});
  const toggleDrawLock = k => setDrawLocked(l=>({...l,[k]:!l[k]}));

  let loan = null, prop = null;
  if (propId) { prop = data.properties.find(p => p.id === propId); loan = prop?.loans.find(l => l.id === loanId); }
  if (!loan) { const u = (data.unassigned||[]).find(l => l.id === loanId); if(u){loan=u;prop=null;} }
  if (!loan) { data.properties.forEach(p => { const l=p.loans.find(l=>l.id===loanId); if(l){loan=l;prop=p;} }); }

  if (!loan) return (
    <div className="flex flex-col items-center justify-center py-20 gap-3 px-5">
      <div className="text-slate-400 dark:text-zinc-500 text-sm">Loan not found</div>
      <button onClick={onBack} className="text-sm text-teal-600 dark:text-teal-400 hover:underline">← Back</button>
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
      splitMonthlyRate: String(loan.splitMonthlyRate??""),
      specialTerms: loan.specialTerms||"",
      drawFacility: loan.drawFacility||null,
      lockedToProperty: !!loan.lockedToProperty,
      promissoryNoteUrl: loan.promissoryNoteUrl||"",
    });
    // This is always an existing loan, so every field already holds a real, presumably
    // correct value — start it locked (the same "already-correct data starts protected"
    // rule every other form in the app follows), rather than forcing a re-confirm of
    // everything just to change one unrelated field like Notes.
    setEfLocked({
      principal: !!loan.principal,
      startDate: !!loan.startDate,
      interestType: loan.interestRate!=null,
      interestRate: loan.interestRate!=null,
      monthlyPayment: !!loan.monthlyPayment,
      splitMonthlyRate: loan.splitMonthlyRate!=null,
      drawCommitted: !!loan.drawFacility?.committed,
    });
    setEfBlockMsg("");
    setEditing(true);
  };

  useEffect(() => { if (startEditing && loan) openEdit(); }, []);

  const addDraw = () => {
    const amount = parseFloat(drawAmt);
    if (!amount || !drawDate) return;
    setEf(f=>({...f,drawFacility:{...f.drawFacility,draws:[...(f.drawFacility?.draws||[]),{id:uid(),date:drawDate,amount}]}}));
    setDrawAmt("");
    setDrawLocked({});
  };

  // Every lockable field has to actually be confirmed (✓) before this can save — same
  // mandatory-confirm rule the shared Add Lender Money form already applies when editing
  // this exact loan from a property's own page; this inline editor was skipping it.
  const requiredEfLockKeys = ["principal","startDate","interestType","interestRate",
    ...(ef?.paymentType==="monthly_fixed"?["monthlyPayment"]:[]),
    ...(ef?.paymentType==="monthly_rate_split"?["splitMonthlyRate"]:[]),
    ...(ef?.drawFacility?["drawCommitted"]:[])];
  const efAllConfirmed = ef ? requiredEfLockKeys.every(k=>efLocked[k]) : false;

  const saveEdit = () => {
    if(!ef) return;
    setEfBlockMsg("");
    if(!efAllConfirmed){ alert("Tap ✓ Confirm on every field above before this can be saved."); return; }
    if(ef.principal!==""&&isNaN(parseFloat(ef.principal))){ alert("Principal isn't a valid number."); return; }
    if(ef.interestRate!==""&&isNaN(parseFloat(ef.interestRate))){ alert((ef.interestType==="fixed"?"Fixed interest":"Interest rate")+" isn't a valid number."); return; }
    if(ef.paymentType==="monthly_fixed"&&ef.monthlyPayment!==""&&isNaN(parseFloat(ef.monthlyPayment))){ alert("Monthly payment isn't a valid number."); return; }
    if(ef.paymentType==="monthly_rate_split"&&ef.splitMonthlyRate!==""&&isNaN(parseFloat(ef.splitMonthlyRate))){ alert("Monthly-paid portion isn't a valid number."); return; }
    const newPrincipal = ef.principal!==""?parseFloat(ef.principal)||loan.principal:loan.principal;
    const newStartDate = ef.startDate||loan.startDate;
    // Same timing/funding-gap check the shared Add Lender Money form runs whenever this
    // loan is saved from there — re-run here too so the two editors agree on what's
    // allowed instead of one being stricter than the other.
    if(prop){
      const conflict = propConflict(newStartDate, newPrincipal, prop);
      if(conflict==='date'){ setEfBlockMsg("Cannot save — this start date is before the property was acquired, so for that stretch of time the loan wouldn't have had this property backing it up."); return; }
      if(conflict==='size'){ setEfBlockMsg("Cannot save — not enough funding gap on this property for this amount (including the usual 10% cushion)."); return; }
    }
    const patch = {
      principal: newPrincipal,
      startDate: newStartDate,
      endDate: ef.endDate||null,
      dueDate: ef.dueDate||null,
      interestType: ef.interestType,
      interestRate: ef.interestRate!==""?parseFloat(ef.interestRate)||loan.interestRate:loan.interestRate,
      paymentType: ef.paymentType,
      monthlyPayment: ef.monthlyPayment!==""?parseFloat(ef.monthlyPayment)||0:loan.monthlyPayment,
      splitMonthlyRate: ef.paymentType==="monthly_rate_split"?(ef.splitMonthlyRate!==""?parseFloat(ef.splitMonthlyRate)||0:loan.splitMonthlyRate||0):null,
      specialTerms: ef.specialTerms,
      drawFacility: ef.drawFacility?{committed:parseFloat(ef.drawFacility.committed)||0,draws:ef.drawFacility.draws||[]}:null,
      lockedToProperty: loan.loanType==="private"?!!ef.lockedToProperty:false,
      promissoryNoteUrl: loan.loanType==="private"&&ef.lockedToProperty?(ef.promissoryNoteUrl||null):null,
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
    if(!window.confirm("Delete this loan? This can't be undone.")) return;
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
        <button onClick={onBack} className="flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-zinc-500 hover:text-teal-600 dark:hover:text-teal-400 transition-colors mb-3">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
          Back
        </button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-teal-500 dark:text-teal-400 mb-2">Loan</div>
            <button onClick={() => navigate({type:'lender', name:loan.lenderName})}
              className="text-2xl font-bold text-slate-900 dark:text-zinc-100 hover:text-teal-600 dark:hover:text-teal-400 transition-colors text-left leading-tight">
              {loan.lenderName || "Unknown Lender"}
            </button>
            {prop ? (
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className="text-[13px] text-slate-400 dark:text-zinc-500">at</span>
                <button onClick={() => navigate({type:'property', id:prop.id})} className="text-[15px] font-semibold text-slate-600 dark:text-zinc-300 hover:text-teal-600 dark:hover:text-teal-400 hover:underline transition-colors text-left">
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
              <LockBadge loan={loan}/>
            </div>
          </div>
          {update && (
            <div className="shrink-0 mt-1">
              <button onClick={editing?()=>{setEditing(false);setDeleteConfirm(false);}:openEdit} className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 hover:text-teal-600 dark:hover:text-teal-400 hover:border-teal-300 dark:hover:border-teal-700 shadow-sm transition-all">
                {editing?"✕ Cancel":"✏️ Edit"}
              </button>
            </div>
          )}
        </div>
      </div>

      {!editing&&needsPromissoryNote(loan)&&(
        <div className="mb-5 p-4 rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 flex items-start justify-between gap-3">
          <div>
            <div className="font-bold text-red-700 dark:text-red-400 text-sm mb-0.5">🔴 Needs a Promissory Note</div>
            <div className="text-xs text-red-600/80 dark:text-red-400/80">This loan is Fixed to Property, but no promissory note / mortgage link is on file yet.</div>
          </div>
          {update&&<button onClick={openEdit} className="shrink-0 text-xs font-bold text-red-700 dark:text-red-400 hover:underline whitespace-nowrap">+ Add Link</button>}
        </div>
      )}

      {closeModal&&<CloseLoanModal loan={loan} onConfirm={closeLoan} onClose={()=>setCloseModal(false)}/>}

      {editing&&ef&&(
        <div className="mb-6 bg-white dark:bg-[#1C1F2B] rounded-2xl p-5 shadow-[0_2px_12px_rgba(0,0,0,0.07)] border border-slate-100 dark:border-zinc-800">
          <div className="text-[10px] font-bold uppercase tracking-widest text-teal-500 dark:text-teal-400 mb-4">Edit Loan Terms</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Lockable locked={efLocked.principal} onToggle={()=>toggleEfLock("principal")}>
              <Inp label="Principal ($)" value={ef.principal} onChange={v=>setEf(f=>({...f,principal:v}))} money/>
            </Lockable>
            <Lockable locked={efLocked.startDate} onToggle={()=>toggleEfLock("startDate")}>
              <DateInp label="Start Date" value={ef.startDate} onChange={v=>setEf(f=>({...f,startDate:v}))}/>
            </Lockable>
            <Lockable locked={efLocked.endDate} onToggle={()=>toggleEfLock("endDate")}>
              <DateInp label="End Date (leave blank if active)" value={ef.endDate} onChange={v=>setEf(f=>({...f,endDate:v}))}/>
            </Lockable>
            <Lockable locked={efLocked.dueDate} onToggle={()=>toggleEfLock("dueDate")}>
              <DateInp label="Due Date (optional)" value={ef.dueDate} onChange={v=>setEf(f=>({...f,dueDate:v}))} helpText="Only if this loan has a fixed maturity — leave blank if it's just paid off whenever the property sells."/>
            </Lockable>
            <Lockable locked={efLocked.interestType} onToggle={()=>toggleEfLock("interestType")}>
              <Sel label="Interest Type" value={ef.interestType} onChange={v=>setEf(f=>({...f,interestType:v}))} options={
                ef.paymentType==="monthly_rate_split" ? [["percentage","% Per Year"]] : [["percentage","% Per Year"],["fixed","Fixed $ Amount"]]}/>
            </Lockable>
            <Lockable locked={efLocked.interestRate} onToggle={()=>toggleEfLock("interestRate")}>
              <Inp label={ef.interestType==="fixed"?"Fixed Interest ($)":"Interest Rate (%)"} value={ef.interestRate} onChange={v=>setEf(f=>({...f,interestRate:v}))} money={ef.interestType==="fixed"} percent={ef.interestType!=="fixed"}/>
            </Lockable>
            <Sel label="How Is Interest Paid?" value={ef.paymentType} onChange={v=>setEf(f=>{
              // Split only makes sense as a % rate — drop back to percentage if Fixed $ was
              // selected, rather than leaving an impossible combination in place.
              const interestType=(v==="monthly_rate_split"&&f.interestType==="fixed")?"percentage":f.interestType;
              return {...f,paymentType:v,interestType};
            })} options={[
              ["closing",       "Pay at Closing — all interest owed when deal closes"],
              ["monthly_rate",  "Monthly Interest-Only — pay rate monthly, principal at closing"],
              ["monthly_fixed", "Monthly Fixed Amount — set dollar amount each month"],
              ["monthly_rate_split", "Partial Monthly + Rest at Closing"],
            ]}/>
            {ef.paymentType==="monthly_fixed"&&(
              <Lockable locked={efLocked.monthlyPayment} onToggle={()=>toggleEfLock("monthlyPayment")}>
                <Inp label="Monthly Payment ($)" value={ef.monthlyPayment} onChange={v=>setEf(f=>({...f,monthlyPayment:v}))} money/>
              </Lockable>
            )}
            {ef.paymentType==="monthly_rate_split"&&(()=>{
              const total=parseFloat(ef.interestRate)||0;
              const principal=parseFloat(ef.principal)||0;
              const monthlyRate=parseFloat(ef.splitMonthlyRate)||0;
              const monthlyDollar=principal>0?Math.round(principal*monthlyRate/100/12*100)/100:0;
              const closingRate=Math.max(0,total-monthlyRate);
              const closingDollar=principal>0?Math.round(principal*closingRate/100/12*100)/100:0;
              const switchTo=mode=>{
                if(mode==="dollar"&&splitEntryMode!=="dollar") setSplitMonthlyAmt(principal>0?String(monthlyDollar):"");
                setSplitEntryMode(mode);
              };
              return (
                <Lockable locked={efLocked.splitMonthlyRate} onToggle={()=>toggleEfLock("splitMonthlyRate")}>
                  <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Monthly-Paid Portion</label>
                  <div className="flex bg-slate-100 dark:bg-zinc-800 rounded-lg p-0.5 mb-2 w-fit">
                    <button type="button" onClick={()=>switchTo("rate")}
                      className={`px-3 py-1 rounded-md text-[11px] font-semibold transition-all ${splitEntryMode==="rate"?"bg-white dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400"}`}>By Rate (%)</button>
                    <button type="button" onClick={()=>switchTo("dollar")}
                      className={`px-3 py-1 rounded-md text-[11px] font-semibold transition-all ${splitEntryMode==="dollar"?"bg-white dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400"}`}>By Dollar Amount ($)</button>
                  </div>
                  {splitEntryMode==="rate" ? (
                    <>
                      <Inp value={ef.splitMonthlyRate} onChange={v=>setEf(f=>({...f,splitMonthlyRate:v}))} percent/>
                      <p className="text-[11px] text-slate-400 dark:text-zinc-500 -mt-2 mb-3">
                        {principal>0?`= ${$$p(monthlyDollar)}/mo`:"Enter the principal above to see the dollar equivalent"}
                      </p>
                    </>
                  ) : (
                    <>
                      <Inp money value={splitMonthlyAmt} onChange={setSplitMonthlyAmt}/>
                      <p className="text-[11px] text-slate-400 dark:text-zinc-500 -mt-2 mb-3">
                        {principal>0?`= ${monthlyRate.toFixed(3).replace(/\.?0+$/,"")}% of the ${total||"—"}% total`:"Enter the principal above first"}
                      </p>
                    </>
                  )}
                  {monthlyRate>total&&total>0?(
                    <p className="text-[11px] text-red-500 dark:text-red-400 -mt-1">
                      That's more than the {total}% total — double-check the total rate above, or this loan will show nothing accruing to closing.
                    </p>
                  ):(
                    <p className="text-[11px] text-slate-400 dark:text-zinc-500 -mt-1">
                      Rest of the {total||"—"}% total — {closingRate.toFixed(3).replace(/\.?0+$/,"")}%{principal>0?` (≈ ${$$p(closingDollar)}/mo if it were paid monthly)`:""} — accrues instead and is paid at closing
                    </p>
                  )}
                </Lockable>
              );
            })()}
            <div className="sm:col-span-2"><Inp label="Notes" value={ef.specialTerms} onChange={v=>setEf(f=>({...f,specialTerms:v}))}/></div>
          </div>
          {loan.loanType==="hard"&&(
            <div className="mt-3 p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800">
              <label className="flex items-center gap-3 cursor-pointer mb-1">
                <input type="checkbox" checked={!!ef.drawFacility}
                  onChange={e=>setEf(f=>({...f,drawFacility:e.target.checked?{committed:"",draws:[]}:null}))}
                  className="w-4 h-4 rounded border-slate-300 dark:border-zinc-600 accent-teal-600 cursor-pointer"/>
                <div>
                  <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200">Rehab Draw Facility</div>
                  <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">Lender committed rehab funding, drawn in stages</div>
                </div>
              </label>
              {ef.drawFacility&&(
                <div className="mt-3 space-y-3">
                  <Lockable locked={efLocked.drawCommitted} onToggle={()=>toggleEfLock("drawCommitted")}>
                    <Inp label="Total Committed ($)" money value={String(ef.drawFacility.committed||"")}
                      onChange={v=>setEf(f=>({...f,drawFacility:{...f.drawFacility,committed:v}}))} placeholder="100000"/>
                  </Lockable>
                  {(ef.drawFacility.draws||[]).length>0&&(
                    <div>
                      <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Draws Taken</div>
                      {ef.drawFacility.draws.map(d=>(
                        <div key={d.id} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-200 dark:border-zinc-700 last:border-0">
                          <span className="text-slate-600 dark:text-zinc-300 tabular-nums">{d.date} · {$$p(d.amount)}</span>
                          <button type="button" onClick={()=>setEf(f=>({...f,drawFacility:{...f.drawFacility,draws:f.drawFacility.draws.filter(x=>x.id!==d.id)}}))}
                            className="text-red-400 hover:text-red-600 text-xs p-1 transition-colors">✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="pt-1 border-t border-slate-200 dark:border-zinc-700">
                    <div className="text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-2">Add Draw</div>
                    <Lockable locked={drawLocked.date} onToggle={()=>toggleDrawLock("date")}>
                      <DateInp label="Draw Date" value={drawDate} onChange={setDrawDate}/>
                    </Lockable>
                    <Lockable locked={drawLocked.amt} onToggle={()=>toggleDrawLock("amt")}>
                      <Inp label="Amount ($)" money value={drawAmt} onChange={setDrawAmt} placeholder="25000"/>
                    </Lockable>
                    <Btn onClick={addDraw} sm color="navy" full>+ Record Draw</Btn>
                  </div>
                </div>
              )}
            </div>
          )}
          {loan.loanType==="private"&&(
            <div className="mt-3 p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800">
              <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200 mb-1">Private Loan Type</div>
              <div className="flex bg-white dark:bg-zinc-900 rounded-lg p-0.5 mb-2 border border-slate-200 dark:border-zinc-700 w-fit">
                <button type="button" onClick={()=>setEf(f=>({...f,lockedToProperty:false}))}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${!ef.lockedToProperty?"bg-slate-100 dark:bg-zinc-700 text-slate-800 dark:text-zinc-100 shadow-sm":"text-slate-500 dark:text-zinc-400"}`}>Regular</button>
                <button type="button" onClick={()=>setEf(f=>({...f,lockedToProperty:true}))}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${ef.lockedToProperty?"bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 shadow-sm":"text-slate-500 dark:text-zinc-400"}`}>Fixed to Property</button>
              </div>
              <div className="text-[11px] text-slate-400 dark:text-zinc-500">
                {ef.lockedToProperty
                  ? "Secured by a promissory note / mortgage against the specific property — still moveable, but moving requires confirming the paperwork was updated first."
                  : "Can be freely placed, split, or moved between properties, same as today."}
              </div>
              {ef.lockedToProperty&&(
                <div className="mt-3 pt-3 border-t border-slate-200 dark:border-zinc-700">
                  <Inp label="Promissory Note / Mortgage Link" value={ef.promissoryNoteUrl||""} onChange={v=>setEf(f=>({...f,promissoryNoteUrl:v}))}
                    placeholder="https://drive.google.com/…"
                    helpText="Link to wherever the signed note/mortgage is kept. Until this is here, this loan shows a needs-attention flag."/>
                </div>
              )}
            </div>
          )}
          {efBlockMsg&&<p className="text-[11px] text-red-500 dark:text-red-400 mb-2">{efBlockMsg}</p>}
          {!efAllConfirmed&&<p className="text-[11px] text-red-500 dark:text-red-400 mb-2">Tap ✓ Confirm on every field above before this can be saved.</p>}
          <div className="flex gap-2 mt-4">
            <Btn color={efAllConfirmed?"blue":"ghost"} disabled={!efAllConfirmed} onClick={saveEdit}>Save Changes</Btn>
            <Btn color="ghost" onClick={()=>setEditing(false)}>Cancel</Btn>
          </div>
          {update&&(
            <div className="mt-4 pt-4 border-t border-slate-100 dark:border-zinc-800 flex flex-wrap gap-2">
              {!loan.endDate&&<Btn color="ghost" onClick={()=>setCloseModal(true)}>Close Loan</Btn>}
              <Btn color="red" onClick={deleteLoan}>🗑 Delete</Btn>
            </div>
          )}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          ["Principal", h$(loan.principal), "text-slate-900 dark:text-zinc-100"],
          ["Balance", h$(bal), "text-teal-600 dark:text-teal-400"],
          ["Interest Earned", h$(earned), "text-emerald-600 dark:text-emerald-400"],
          ["Days Active", String(daysBetween(loan.startDate, loan.endDate||TODAY)), ""],
        ].map(([label, val, color]) => (
          <div key={label} className="bg-white dark:bg-[#1C1F2B] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 mb-1">{label}</div>
            <div className={`text-lg font-bold tabular-nums ${color || "text-slate-900 dark:text-zinc-100"}`}>{val}</div>
          </div>
        ))}
      </div>

      {/* Detail table */}
      <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] mb-4 overflow-hidden">
        <div className="divide-y divide-slate-50 dark:divide-zinc-800">
          {[
            ["Type", loan.loanType === "hard" ? "Hard Money" : "Private Money"],
            ["Rate / Terms", hr(loan)],
            ["Start Date", loan.startDate||"—"],
            ["End Date", loan.endDate||"Active"],
            ...(loan.specialTerms ? [["Notes", loan.specialTerms]] : []),
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
            className="flex-1 py-3 rounded-2xl bg-white dark:bg-[#1C1F2B] shadow-[0_2px_12px_rgba(0,0,0,0.06)] text-sm font-semibold text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors">
            View Lender →
          </button>
        )}
        {prop && (
          <button onClick={() => navigate({type:'property', id:prop.id})}
            className="flex-1 py-3 rounded-2xl bg-white dark:bg-[#1C1F2B] shadow-[0_2px_12px_rgba(0,0,0,0.06)] text-sm font-semibold text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors">
            View Property →
          </button>
        )}
      </div>

      {/* Draw history */}
      {draws.length > 0 && (
        <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
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

// Dashboard cards the user can drag-reorder and show/hide — the 5 original sections
// (Money Ready to Place, Upcoming Due Dates, Key Numbers, Hard Money, Monthly Holding)
// stay in a fixed order above these and aren't part of this system. Id + label only
// here; each card's actual content is computed inline in DashboardPage (it needs a lot
// of locally-computed numbers) and looked up by id at render time. Order/hidden state
// is persisted to data.dashboardLayout so it's the same on every device.
// Every section of the Dashboard is one of these cards — all draggable and hideable from
// the same Customize mode, laid out in a responsive grid so small ones sit side by side.
// `wide: true` cards (lists/banners) span the full grid width; the rest are single tiles.
const DASHBOARD_CARD_DEFS = [
  { id:"moneyReady", label:"Money Ready to Place", wide:true },
  { id:"upcomingDue", label:"Upcoming Due Dates", wide:true },
  { id:"activeProperties", label:"Active Properties" },
  { id:"activeLenders", label:"Active Lenders" },
  { id:"totalActiveLoans", label:"Total Active Loans" },
  { id:"drawsAvailableAmt", label:"Draws Available" },
  { id:"fundingGap", label:"Funding Gap" },
  { id:"totalPayoff", label:"Total Payoff" },
  { id:"totalPrivateMoneyNeeded", label:"Total Private Money Needed" },
  { id:"privateMoneyOnHand", label:"Private Money On Hand" },
  { id:"privateMoneyGap", label:"Private Money Gap" },
  { id:"neededIfRehabFullyDrawn", label:"Needed If Rehab Fully Drawn" },
  { id:"closedProperties", label:"Closed Properties" },
  { id:"activeRehabOnHand", label:"Active + Rehab On Hand" },
  { id:"lifetimeProfit", label:"Lifetime Profit" },
  { id:"interestThisMonth", label:"Interest Accruing This Month" },
  { id:"hardMoneyDue", label:"Hard Money Due", wide:true },
  { id:"monthlyHolding", label:"Monthly Holding", wide:true },
  { id:"drawsDetail", label:"Draws Available by Property", wide:true },
  { id:"lenderConcentration", label:"Top Lenders by Balance", wide:true },
  { id:"recentClosings", label:"Recently Closed", wide:true },
  { id:"promissoryNotesNeeded", label:"Promissory Notes Needed", wide:true },
];
const DEFAULT_DASHBOARD_ORDER = DASHBOARD_CARD_DEFS.map(c=>c.id);

function DashboardPage({ data, update, onNavigateTab }) {
  const prv = usePrivacy();
  const h$ = v => prv ? maskMoney($$p(v)) : $$p(v);
  const hc$ = v => prv ? maskMoney($$c(v)) : $$c(v);
  const hs$ = v => prv ? maskMoney($$ps(v)) : $$ps(v);
  const openPanel = usePanel();
  const [modal, setModal] = useState(null);
  // All list-bearing sections default collapsed (just the header/summary row) so the whole
  // dashboard fits without scrolling — tap a header to expand just the one you want.
  const [fundsOpen, setFundsOpen] = usePersistedState("nx-dashFundsOpen", false);
  const [dueDatesOpen, setDueDatesOpen] = usePersistedState("nx-dashDueDatesOpen", false);
  const [burningOpen, setBurningOpen] = usePersistedState("nx-dashBurningOpen", false);
  const [drawsOpen, setDrawsOpen] = usePersistedState("nx-dashDrawsOpen", false);
  const [lendersOpen, setLendersOpen] = usePersistedState("nx-dashLendersOpen", false);
  const [closingsOpen, setClosingsOpen] = usePersistedState("nx-dashClosingsOpen", false);
  const [menuOpen, setMenuOpen] = useState(null);
  const [formDirty, setFormDirty] = useState(false);
  const closeModal = () => confirmDiscard(formDirty, () => setModal(null));

  // ── Customizable card layout — drag to reorder, hide/show, persisted to the blob ──
  const [editMode, setEditMode] = useState(false);
  const savedOrder = data.dashboardLayout?.order || [];
  const cardOrder = [...savedOrder.filter(id=>DEFAULT_DASHBOARD_ORDER.includes(id)), ...DEFAULT_DASHBOARD_ORDER.filter(id=>!savedOrder.includes(id))];
  const cardHidden = data.dashboardLayout?.hidden || [];
  const dashDragSensors = useSensors(useSensor(PointerSensor,{activationConstraint:{distance:8}}));
  const toggleCardHidden = id => {
    const nextHidden = cardHidden.includes(id) ? cardHidden.filter(x=>x!==id) : [...cardHidden, id];
    update(d => ({...d, dashboardLayout: {...(d.dashboardLayout||{}), order: cardOrder, hidden: nextHidden}}));
  };
  const handleDashDragEnd = ({active, over}) => {
    if (!over || active.id === over.id) return;
    const oldIndex = cardOrder.indexOf(active.id);
    const newIndex = cardOrder.indexOf(over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(cardOrder, oldIndex, newIndex);
    update(d => ({...d, dashboardLayout: {...(d.dashboardLayout||{}), order: reordered, hidden: cardHidden}}));
  };

  const activePropsData = data.properties.filter(p => !p.dateSold);
  const unassignedFunds = (data.unassigned || []).filter(l => !l.endDate);
  const allActiveLoans = activePropsData.flatMap(p => p.loans.filter(l => !l.endDate));
  const allActivePlusUnassigned = [...allActiveLoans, ...unassignedFunds];

  // Fixed-to-Property private loans missing their promissory note / mortgage link.
  const loansNeedingNotes = [
    ...activePropsData.flatMap(p => p.loans.filter(needsPromissoryNote).map(l => ({ loan: l, propId: p.id, propAddress: p.address }))),
    ...unassignedFunds.filter(needsPromissoryNote).map(l => ({ loan: l, propId: null, propAddress: null })),
  ];

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
  const drawsAvailableList = activePropsData.flatMap(prop =>
    prop.loans.filter(l => !l.endDate && l.drawFacility && drawRemaining(l) > 0).map(l => {
      const draws = l.drawFacility.draws || [];
      const lastDraw = draws.reduce((m, d) => !m || d.date > m ? d.date : m, null);
      const lastEvent = [lastDraw, prop.purchaseDate].filter(Boolean).sort().pop() ?? null;
      const daysSince = lastEvent ? daysBetween(lastEvent, TODAY) : null;
      return { l, prop, remaining: drawRemaining(l), daysSince, eligible: !lastEvent || daysSince >= 14 };
    })
  ).filter(x => x.eligible).sort((a, b) => b.remaining - a.remaining);
  const drawsAvailable = drawsAvailableList.reduce((s, x) => s + x.remaining, 0);

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
  const totalPurchasePrice = activePropsData.reduce((s, p) => s + (p.purchasePrice || 0), 0);
  const privateMoneyNeeded = totalPurchasePrice * 0.12;
  // Rehab money still needed beyond what's already committed via a draw facility, plus the
  // full-timeline cost of hard money's monthly interest (not just next month's) — on top of
  // the same 12% of purchase price, for a fuller "what private money do we actually need"
  // number than the purchase-price-only tile above. Split into properties with no draw
  // facility committed at all vs. ones with a facility whose committed amount falls short.
  let rehabNoDraws = 0, rehabDrawGap = 0;
  activePropsData.forEach(p => {
    const committed = p.loans.filter(l => !l.endDate).reduce((cs, l) => cs + (l.drawFacility?.committed || 0), 0);
    const gap = Math.max(0, (p.rehabBudget || 0) - committed);
    if (gap <= 0) return;
    if (committed === 0) rehabNoDraws += gap; else rehabDrawGap += gap;
  });
  const uncommittedRehab = rehabNoDraws + rehabDrawGap;
  // A hard-money loan's own draw facility (committed rehab money not yet pulled) also
  // carries interest, but not for the full timeline like the base principal — draws trickle
  // out over the hold period. Assumed drawn in equal monthly chunks, so the outstanding draw
  // balance ramps from ~0 to the full committed amount; summing each month's interest on
  // that ramp works out to committed × rate × (months+1) / 2400.
  const hardDrawCarry = (loan, months) => {
    if (!loan?.drawFacility?.committed || loan.interestType === "fixed") return 0;
    return (loan.drawFacility.committed || 0) * ((loan.interestRate || 0) / 100) * (months + 1) / 24;
  };
  const hardMoneyFullTimeline = activePropsData.reduce((s, p) => {
    const months = effectiveMonths(p);
    const hardLoans = p.loans.filter(l => !l.endDate && l.loanType === "hard");
    const hardMonthlyForProp = hardLoans.reduce((hs, l) => hs + monthlyLoanPayment(l), 0);
    const drawCarryForProp = hardLoans.reduce((ds, l) => ds + hardDrawCarry(l, months), 0);
    return s + hardMonthlyForProp * months + drawCarryForProp;
  }, 0);
  const totalPrivateMoneyNeeded = privateMoneyNeeded + uncommittedRehab + hardMoneyFullTimeline;
  // Private-type money currently deployed (on active properties) or sitting unassigned —
  // what's actually on hand right now, as opposed to the tiles above (what's still needed).
  const privateMoneyOnHand = allActivePlusUnassigned
    .filter(l => l.loanType === "private")
    .reduce((s, l) => s + (l.principal || 0) + (l.drawFacility?.committed || 0), 0);
  const privateMoneyGap = totalPrivateMoneyNeeded - privateMoneyOnHand;
  // Hypothetical: what Total Private Money Needed would be if every property's rehab were
  // fully covered by a committed draw facility — i.e. the rehab component drops out entirely.
  const totalPrivateMoneyNeededIfFullyDrawn = privateMoneyNeeded + hardMoneyFullTimeline;

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

  // Top lenders by current outstanding balance (active loans + still-unassigned funds).
  const lenderBalances = {};
  allActivePlusUnassigned.forEach(l => {
    if (!l.lenderName) return;
    lenderBalances[l.lenderName] = (lenderBalances[l.lenderName] || 0) + calcBalance(l);
  });
  const topLenders = Object.entries(lenderBalances).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Most recently closed properties with a profit figure to show.
  const recentClosings = data.properties.filter(p => p.dateSold && p.closingData)
    .sort((a, b) => (b.dateSold || "").localeCompare(a.dateSold || "")).slice(0, 5);

  // Simple portfolio-wide snapshot — active vs. closed, and lifetime profit across everything sold.
  const closedPropsData = data.properties.filter(p => p.dateSold);
  const lifetimeProfit = closedPropsData.reduce((s, p) => s + effectiveProfit(p), 0);
  const activePurchaseRehab = activePropsData.reduce((s, p) => s + (p.purchasePrice || 0) + (p.rehabBudget || 0), 0);

  // Interest cost accruing THIS month across every active loan/fund, any type — distinct
  // from the Hard Money card above (hard-money only); this is the fuller cash-need picture.
  const interestThisMonth = allActivePlusUnassigned.reduce((s, l) => s + monthlyLoanPayment(l), 0);

  const placeOnProperty = (fund, propId) => {
    const loan = {
      id: uid(), lenderName: fund.lenderName, loanType: fund.loanType,
      principal: fund.principal || fund.amount || 0, startDate: fund.startDate || TODAY,
      interestRate: fund.interestRate || 0, interestType: fund.interestType || "percentage",
      paymentType: fund.paymentType || "closing", monthlyPayment: fund.monthlyPayment || 0,
      splitMonthlyRate: fund.splitMonthlyRate ?? null,
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
    if (!window.confirm("Remove this unassigned fund?")) return;
    update(d => ({ ...d, unassigned: d.unassigned.filter(u => u.id !== id) }));
  };

  const sortedFunds = [...unassignedFunds].sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));

  const NAV_COLORS = {
    blue:   "text-teal-600 dark:text-teal-400",
    indigo: "text-indigo-600 dark:text-indigo-400",
    amber:  "text-amber-600 dark:text-amber-400",
    slate:  "text-slate-700 dark:text-zinc-200",
    orange: "text-orange-600 dark:text-orange-400",
    violet: "text-violet-600 dark:text-violet-400",
    emerald:"text-emerald-600 dark:text-emerald-400",
  };

  // Each card's content — null when there's nothing to show right now (the card is then
  // auto-hidden outside edit mode, same as the old fixed sections used to do).
  // The 5 original sections — fixed position, not draggable/hideable (see note on
  // DASHBOARD_CARD_DEFS above). Each list-bearing one collapses to just its header/summary
  // row by default so the whole dashboard fits without scrolling.
  // One self-contained card per entry in DASHBOARD_CARD_DEFS — every section of the
  // Dashboard, atomized, so each can be independently dragged/hidden in Customize mode.
  // Small KPI tiles render null never; list/banner cards render null when there's nothing
  // to show right now (auto-hidden outside edit mode, same as before).
  const kpiTileDefs = [
    { id: "activeProperties", label: "Active Properties", value: activePropsData.length, sub: "tap to view", color: "blue", icon: "🏠", tab: "Properties" },
    { id: "activeLenders", label: "Active Lenders", value: activeLendersCount, sub: "tap to view", color: "indigo", icon: "👥", tab: "LenderDash" },
    { id: "totalActiveLoans", label: "Total Active Loans", value: totalLoansCount, sub: "across all", color: "slate", icon: "📋", tab: "AllLoans" },
    { id: "drawsAvailableAmt", label: "Draws Available", value: h$(drawsAvailable), sub: "14d+ since last event", color: "amber", icon: "🏗️", tab: "Draws" },
    { id: "fundingGap", label: "Funding Gap", value: h$(totalFundingGap), sub: "short of 100%", color: "orange", icon: "📉", tab: "PropDash" },
    { id: "totalPayoff", label: "Total Payoff", value: h$(totalPayoff), sub: "all active balances", color: "slate", icon: "💰", tab: "LenderDash" },
    { id: "totalPrivateMoneyNeeded", label: "Total Private Money Needed", value: h$(totalPrivateMoneyNeeded), sub: "purchase + rehab + hard $ carry", color: "violet", icon: "💵", tab: "Properties",
      breakdown: [
        { label: "Purchase", value: hc$(privateMoneyNeeded) },
        { label: "No Draws", value: hc$(rehabNoDraws) },
        { label: "Draw Gap", value: hc$(rehabDrawGap) },
        { label: "Hard $", value: hc$(hardMoneyFullTimeline) },
      ] },
    { id: "privateMoneyOnHand", label: "Private Money On Hand", value: h$(privateMoneyOnHand), sub: "principal + committed", color: "emerald", icon: "🤝", tab: "LenderDash" },
    { id: "privateMoneyGap", label: "Private Money Gap", value: hs$(privateMoneyGap), sub: privateMoneyGap > 0 ? "still needed" : "surplus on hand", color: privateMoneyGap > 0 ? "orange" : "emerald", icon: "⚖️", tab: "Properties" },
    { id: "neededIfRehabFullyDrawn", label: "Needed If Rehab Fully Drawn", value: h$(totalPrivateMoneyNeededIfFullyDrawn), sub: "purchase + hard $ carry only", color: "violet", icon: "🏗️", tab: "Properties" },
    { id: "closedProperties", label: "Closed Properties", value: closedPropsData.length, sub: "tap to view", color: "slate", icon: "🏁", tab: "Closed" },
    { id: "activeRehabOnHand", label: "Active + Rehab On Hand", value: h$(activePurchaseRehab), sub: "purchase + rehab, active only", color: "violet", icon: "🧮", tab: "Properties" },
    { id: "lifetimeProfit", label: "Lifetime Profit", value: hs$(lifetimeProfit), sub: "all closed sales", color: lifetimeProfit >= 0 ? "emerald" : "orange", icon: "📈", tab: "Closed" },
    { id: "interestThisMonth", label: "Interest Accruing This Month", value: h$(interestThisMonth), sub: "all monthly-paid loans, any type", color: "slate", icon: "📅", tab: "AllLoans" },
  ];
  const renderKpiTile = ({ label, value, sub, color, icon, tab, breakdown }) => (
    <button onClick={() => onNavigateTab(tab)}
      className="w-full h-full bg-white dark:bg-[#1C1F2B] rounded-2xl p-4 shadow-[0_2px_12px_rgba(0,0,0,0.06)] hover:shadow-[0_4px_20px_rgba(0,0,0,0.10)] hover:-translate-y-0.5 active:scale-[0.98] transition-all text-left group border border-slate-100 dark:border-zinc-800">
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
      {breakdown && (
        <div className="mt-1.5 pt-1.5 border-t border-slate-100 dark:border-zinc-800 flex flex-wrap gap-x-2.5 gap-y-0.5">
          {breakdown.map(b => (
            <span key={b.label} className="text-[9px] text-slate-400 dark:text-zinc-500">{b.label} <strong className="text-slate-600 dark:text-zinc-300 tabular-nums">{b.value}</strong></span>
          ))}
        </div>
      )}
    </button>
  );

  const cardContent = {
    ...Object.fromEntries(kpiTileDefs.map(t => [t.id, renderKpiTile(t)])),

    moneyReady: unassignedFunds.length === 0 ? null : (
      <div className="rounded-2xl overflow-hidden bg-gradient-to-br from-violet-600 to-purple-700 shadow-[0_4px_24px_rgba(124,58,237,0.30)] dark:shadow-[0_4px_24px_rgba(124,58,237,0.20)]">
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
                    <button onClick={() => setModal({ type: "place", fund: u })}
                      className="text-[11px] font-bold text-violet-700 bg-white hover:bg-violet-50 rounded-lg px-2.5 py-1 transition-colors shadow-sm whitespace-nowrap">Place →</button>
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
    ),

    upcomingDue: dueSchedule.length === 0 ? null : (
      <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
        <button onClick={() => setDueDatesOpen(o => !o)}
          className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/60 dark:hover:bg-zinc-800/40 transition-colors">
          <div className="text-[10px] font-bold uppercase tracking-widest text-orange-500 dark:text-orange-400">⏰ Upcoming Due Dates</div>
          <div className="flex items-center gap-2">
            <div className="text-xs text-slate-400 dark:text-zinc-500">{dueSchedule.length} scheduled</div>
            <span className="text-slate-300 dark:text-zinc-600 text-xs">{dueDatesOpen ? "▲" : "▼"}</span>
          </div>
        </button>
        {dueDatesOpen && (
          <div className="divide-y divide-slate-50 dark:divide-zinc-800 border-t border-slate-100 dark:border-zinc-800">
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
        )}
      </div>
    ),

    hardMoneyDue: hardMonthly === 0 ? null : (
      <button onClick={() => onNavigateTab("AllLoans:hard")}
        className="w-full bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] p-4 flex items-center justify-between hover:shadow-[0_4px_20px_rgba(0,0,0,0.10)] hover:-translate-y-0.5 active:scale-[0.98] transition-all text-left group">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-red-500 dark:text-red-400 mb-1">💸 Hard Money — Due 1st of Month</div>
          <div className="text-xs text-slate-400 dark:text-zinc-500">{hardMonthlyLoans.length} loan{hardMonthlyLoans.length!==1?"s":""} · tap to view →</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-black text-red-600 dark:text-red-400 tabular-nums">{h$(hardMonthly)}</div>
          <div className="text-[10px] text-slate-400 dark:text-zinc-500">per month</div>
        </div>
      </button>
    ),

    monthlyHolding: topBurning.length === 0 ? null : (
      <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
        <div className="px-5 py-4 flex items-start justify-between gap-3">
          <button onClick={() => onNavigateTab("RehabPriority")} className="text-left group">
            <div className="text-[10px] font-bold uppercase tracking-widest text-orange-500 dark:text-orange-400 flex items-center gap-1">
              🔥 Monthly Holding
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity"><path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd"/></svg>
            </div>
            <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">All active properties by monthly cost · tap for Rehab Priority</div>
          </button>
          <button onClick={() => setBurningOpen(o => !o)} className="shrink-0 text-right flex items-center gap-2">
            <div>
              <div className="text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-semibold tracking-widest mb-0.5">Total/mo</div>
              <div className="text-lg font-black text-orange-600 dark:text-orange-400 tabular-nums">{h$(topBurning.reduce((s,{monthly})=>s+monthly,0))}</div>
            </div>
            <span className="text-slate-300 dark:text-zinc-600 text-xs">{burningOpen ? "▲" : "▼"}</span>
          </button>
        </div>
        {burningOpen && (
          <div className="divide-y divide-slate-50 dark:divide-zinc-800 border-t border-slate-100 dark:border-zinc-800">
            {topBurning.map(({ prop, monthly, daysOwned, totalInterest }, idx) => (
              <div key={prop.id} className="px-5 py-4 flex items-center gap-4 hover:bg-slate-50/60 dark:hover:bg-zinc-800/40 transition-colors">
                <div className="w-6 h-6 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center text-[11px] font-black text-orange-600 dark:text-orange-400 shrink-0">
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <button onClick={() => openPanel({ type: 'property', id: prop.id })}
                    className="font-semibold text-sm text-slate-800 dark:text-zinc-200 hover:text-teal-600 dark:hover:text-teal-400 transition-colors text-left truncate block w-full">
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
        )}
      </div>
    ),

    drawsDetail: drawsAvailableList.length === 0 ? null : (
      <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between">
          <button onClick={() => onNavigateTab("Draws")} className="text-left group">
            <div className="text-[10px] font-bold uppercase tracking-widest text-amber-500 dark:text-amber-400">🏗️ Draws Available by Property</div>
            <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">14d+ since last draw or purchase · tap for Draw Tracker</div>
          </button>
          <button onClick={() => setDrawsOpen(o => !o)} className="flex items-center gap-2 shrink-0">
            <div className="text-lg font-black text-amber-600 dark:text-amber-400 tabular-nums">{h$(drawsAvailable)}</div>
            <span className="text-slate-300 dark:text-zinc-600 text-xs">{drawsOpen ? "▲" : "▼"}</span>
          </button>
        </div>
        {drawsOpen && (
          <div className="divide-y divide-slate-50 dark:divide-zinc-800 border-t border-slate-100 dark:border-zinc-800">
            {drawsAvailableList.map(({ l, prop, remaining, daysSince }) => (
              <button key={l.id} onClick={() => openPanel({ type: 'property', id: prop.id })}
                className="w-full px-5 py-3 flex items-center justify-between gap-3 hover:bg-slate-50/60 dark:hover:bg-zinc-800/40 transition-colors text-left">
                <div className="min-w-0">
                  <div className="font-semibold text-sm text-slate-800 dark:text-zinc-200 truncate">{prop.address}</div>
                  <div className="text-[11px] text-slate-400 dark:text-zinc-500">{l.lenderName}{daysSince != null ? ` · ${daysSince}d since last event` : ""}</div>
                </div>
                <div className="text-sm font-bold text-amber-600 dark:text-amber-400 tabular-nums shrink-0">{h$(remaining)}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    ),

    lenderConcentration: topLenders.length === 0 ? null : (
      <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
        <button onClick={() => setLendersOpen(o => !o)} className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/60 dark:hover:bg-zinc-800/40 transition-colors">
          <div className="text-left">
            <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-500 dark:text-indigo-400">👥 Top Lenders by Balance</div>
            <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">Current outstanding, active + unassigned · tap for Lenders</div>
          </div>
          <span className="text-slate-300 dark:text-zinc-600 text-xs shrink-0">{lendersOpen ? "▲" : "▼"}</span>
        </button>
        {lendersOpen && (
          <div className="divide-y divide-slate-50 dark:divide-zinc-800 border-t border-slate-100 dark:border-zinc-800">
            {topLenders.map(([name, balance]) => (
              <button key={name} onClick={() => openPanel({ type: 'lender', name })}
                className="w-full px-5 py-3 flex items-center justify-between gap-3 hover:bg-slate-50/60 dark:hover:bg-zinc-800/40 transition-colors text-left">
                <div className="font-semibold text-sm text-slate-800 dark:text-zinc-200 truncate">{name}</div>
                <div className="text-sm font-bold text-indigo-600 dark:text-indigo-400 tabular-nums shrink-0">{h$(balance)}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    ),

    recentClosings: recentClosings.length === 0 ? null : (
      <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden">
        <button onClick={() => setClosingsOpen(o => !o)} className="w-full px-5 py-4 flex items-center justify-between hover:bg-slate-50/60 dark:hover:bg-zinc-800/40 transition-colors">
          <div className="text-left">
            <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">🏁 Recently Closed</div>
            <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">Tap for Closed Deals</div>
          </div>
          <span className="text-slate-300 dark:text-zinc-600 text-xs shrink-0">{closingsOpen ? "▲" : "▼"}</span>
        </button>
        {closingsOpen && (
          <div className="divide-y divide-slate-50 dark:divide-zinc-800 border-t border-slate-100 dark:border-zinc-800">
            {recentClosings.map(p => {
              const profit = effectiveProfit(p);
              return (
                <button key={p.id} onClick={() => openPanel({ type: 'property', id: p.id })}
                  className="w-full px-5 py-3 flex items-center justify-between gap-3 hover:bg-slate-50/60 dark:hover:bg-zinc-800/40 transition-colors text-left">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm text-slate-800 dark:text-zinc-200 truncate">{p.address || "Unnamed property"}</div>
                    <div className="text-[11px] text-slate-400 dark:text-zinc-500">Sold {p.dateSold}</div>
                  </div>
                  <div className={`text-sm font-bold tabular-nums shrink-0 ${profit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>{hs$(profit)}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    ),
    promissoryNotesNeeded: loansNeedingNotes.length === 0 ? null : (
      <div className="bg-white dark:bg-[#1C1F2B] rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.06)] overflow-hidden border border-red-100 dark:border-red-900/40">
        <div className="w-full px-5 py-4 flex items-center justify-between">
          <div className="text-left">
            <div className="text-[10px] font-bold uppercase tracking-widest text-red-500 dark:text-red-400">🔴 Promissory Notes Needed</div>
            <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">Fixed-to-Property loans missing their note/mortgage link</div>
          </div>
          <div className="text-lg font-black text-red-600 dark:text-red-400 tabular-nums shrink-0">{loansNeedingNotes.length}</div>
        </div>
        <div className="divide-y divide-slate-50 dark:divide-zinc-800 border-t border-slate-100 dark:border-zinc-800">
          {loansNeedingNotes.map(({loan: l, propId, propAddress}) => (
            <button key={l.id} onClick={() => openPanel({ type: 'loan', loanId: l.id, propId })}
              className="w-full px-5 py-3 flex items-center justify-between gap-3 hover:bg-slate-50/60 dark:hover:bg-zinc-800/40 transition-colors text-left">
              <div className="min-w-0">
                <div className="font-semibold text-sm text-slate-800 dark:text-zinc-200 truncate">{l.lenderName}</div>
                <div className="text-[11px] text-slate-400 dark:text-zinc-500 truncate">{propAddress||"Unassigned"}</div>
              </div>
              <div className="text-sm font-bold text-slate-700 dark:text-zinc-200 tabular-nums shrink-0">{h$(l.principal||0)}</div>
            </button>
          ))}
        </div>
      </div>
    ),
  };

  return (
    <div className="px-5 pt-5 pb-8 w-full max-w-6xl mx-auto">
      {menuOpen && <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(null)}/>}

      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-widest text-teal-500 dark:text-teal-400 mb-1">Nexus Homes</div>
          <h1 className="text-2xl font-black text-slate-900 dark:text-zinc-100 tracking-tight">Funding Center</h1>
        </div>
        <button onClick={() => setEditMode(e => !e)}
          className={`shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${editMode ? "bg-teal-600 text-white" : "bg-white dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border border-slate-200 dark:border-zinc-700 hover:text-teal-600 dark:hover:text-teal-400"}`}>
          {editMode ? "Done" : "Customize"}
        </button>
      </div>

      <DndContext sensors={dashDragSensors} collisionDetection={closestCenter} onDragEnd={handleDashDragEnd}>
        <SortableContext items={cardOrder} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {cardOrder.map(id => {
              const def = DASHBOARD_CARD_DEFS.find(c => c.id === id);
              if (!def) return null;
              const isHidden = cardHidden.includes(id);
              const content = cardContent[id];
              if (!editMode && (isHidden || !content)) return null;
              const spanClass = def.wide ? "col-span-2 sm:col-span-3 lg:col-span-4" : "col-span-1";
              return (
                <SortableItem key={id} id={id} disabled={!editMode} className={spanClass}>
                  {handleProps => (
                    <div className="h-full">
                      {editMode && (
                        <div className="flex items-center justify-between mb-1.5 px-1">
                          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500 min-w-0">
                            <span {...handleProps} className="cursor-grab active:cursor-grabbing text-slate-300 dark:text-zinc-600 text-sm leading-none shrink-0">⠿</span>
                            <span className="truncate">{def.label}</span>
                          </div>
                          <button onClick={() => toggleCardHidden(id)} className="text-[10px] font-bold text-teal-600 dark:text-teal-400 hover:underline shrink-0 ml-2">
                            {isHidden ? "Show" : "Hide"}
                          </button>
                        </div>
                      )}
                      {!isHidden && content}
                      {(isHidden || !content) && editMode && (
                        <div className="h-full rounded-2xl border-2 border-dashed border-slate-200 dark:border-zinc-700 px-4 py-5 text-center text-xs text-slate-400 dark:text-zinc-500">
                          {isHidden ? "Hidden — tap Show to bring it back" : "Nothing to show right now"}
                        </div>
                      )}
                    </div>
                  )}
                </SortableItem>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>

      {/* ── Modals ── */}
      {modal?.type === "editUnassigned" && (
        <Modal title="Edit Fund" onClose={closeModal}>
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
            onClose={closeModal} onDirtyChange={setFormDirty}/>
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

// ── Sidebar monochrome SVG icons — pure/stateless, hoisted to module scope so they
// aren't redefined (and their identity doesn't change) on every Tracker render ──
const IcoHome=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h4v-4h2v4h4a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z"/></svg>;
const IcoUsers=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>;
const IcoDocument=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd"/></svg>;
const IcoWrench=()=><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[15px] h-[15px] shrink-0"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>;
const IcoCog=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd"/></svg>;
const IcoClipboard=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[14px] h-[14px] shrink-0"><path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9zM4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z"/></svg>;
const IcoGrid=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[14px] h-[14px] shrink-0"><path fillRule="evenodd" d="M5 4a3 3 0 00-3 3v6a3 3 0 003 3h10a3 3 0 003-3V7a3 3 0 00-3-3H5zm-1 9v-1h5v2H5a1 1 0 01-1-1zm7 1h4a1 1 0 001-1v-1h-5v2zm0-4h5V8h-5v2zM9 8H4v2h5V8z" clipRule="evenodd"/></svg>;
const IcoBar=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[14px] h-[14px] shrink-0"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/></svg>;
const IcoList=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd"/></svg>;
const IcoPin=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd"/></svg>;
const IcoPie=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path d="M10 2a8 8 0 108 8h-8V2z"/><path d="M8 2.252A8.014 8.014 0 002.252 8H8V2.252z"/></svg>;
const IcoApps=()=><svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] shrink-0"><path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM13 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2h-2zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM13 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2h-2z"/></svg>;

// Sidebar nav button — pure/props-only, hoisted so its identity is stable across renders.
// `badge`: an alert count shown as a small red dot (count<=0 or omitted hides it entirely).
// Kept to a dot rather than a number for 1-2 digit counts so it doesn't crowd a 9px icon —
// the tooltip still spells out exactly what it means.
const SideBtn=({icon,label,active,onClick,tooltip,badge})=>(
  <div className="relative group">
    <button onClick={onClick}
      className={`relative flex items-center justify-center w-full p-2.5 rounded-xl transition-all ${active?"bg-teal-600 shadow-sm":"hover:bg-black/5 dark:hover:bg-white/10"}`}>
      <span className={`shrink-0 ${active?"text-white":"text-slate-400 dark:text-zinc-500"}`}>{icon}</span>
      {badge>0&&<span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500 ring-2 ring-[#F2F2F7] dark:ring-black"/>}
    </button>
    <div className="absolute left-full top-1/2 -translate-y-1/2 ml-3 px-2.5 py-1.5 bg-zinc-900 dark:bg-zinc-700 text-white text-xs font-semibold rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-100 z-50 shadow-lg">
      {tooltip||label}
      <div className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-zinc-900 dark:border-r-zinc-700"/>
    </div>
  </div>
);

export default function Tracker({ onSignOut, onHome, userEmail, dark, onToggleDark }) {
  const [data,setData]=useState(null);
  const [tab,setTab]=usePersistedState("nx-activeTab","Dashboard");
  const [loading,setLoading]=useState(true);
  const [privacyMode,setPrivacyMode]=useState(false);
  const [fabOpen,setFabOpen]=useState(false);
  const [fabPending,setFabPending]=useState(null);
  const [loanFilterPending,setLoanFilterPending]=useState(null);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [mobileNavOpen,setMobileNavOpen]=useState(false);
  const [mobileRenovOpen,setMobileRenovOpen]=useState(false);
  const [globalSearch,setGlobalSearch]=useState('');
  const [globalSelIdx,setGlobalSelIdx]=useState(-1);
  const [searchFocused,setSearchFocused]=useState(false);
  const [recentlyViewed,setRecentlyViewed]=usePersistedState("nx-recentlyViewed",[]);
  const searchInputRef=useRef(null);
  const [navStack,setNavStack]=useState([]);
  const [panelStack,setPanelStack]=useState([]);
  const [rehabHover,setRehabHover]=useState(false);
  const [rehabOpen,setRehabOpen]=useState(false);
  const rehabMenuRef=useRef(null);
  // Closing on mouseleave fires the instant the cursor crosses the small gap between the
  // wrench button and the flyout (that gap isn't part of either element's hit box), which
  // made it feel impossible to actually reach the flyout. A short close delay — cleared the
  // moment the cursor re-enters anywhere in this group — gives it time to arrive instead.
  const rehabCloseTimerRef=useRef(null);
  const openRehabHover=()=>{clearTimeout(rehabCloseTimerRef.current);setRehabHover(true);};
  const closeRehabHoverDelayed=()=>{rehabCloseTimerRef.current=setTimeout(()=>setRehabHover(false),300);};
  const fabRef=useRef(null);
  const settingsRef=useRef(null);
  const globalSearchRef=useRef(null);
  const updatedAtRef=useRef(null);
  const saveQueueRef=useRef(Promise.resolve());
  // Each entry holds both directions ({undo, redo}: currentData => transformedData) so a
  // step can move back and forth between the two stacks instead of just disappearing once
  // undone. A fresh update() always clears the redo stack — same as Sheets/Docs, once you
  // make a new change the old "forward" history no longer applies.
  const undoStackRef=useRef([]); // oldest→newest, capped
  const redoStackRef=useRef([]); // oldest→newest (most recently undone is last)
  const UNDO_STACK_LIMIT=10;
  const [undoCount,setUndoCount]=useState(0);
  const [redoCount,setRedoCount]=useState(0);

  useEffect(()=>{
    const handler=e=>{
      if(fabRef.current&&!fabRef.current.contains(e.target))setFabOpen(false);
      if(settingsRef.current&&!settingsRef.current.contains(e.target))setSettingsOpen(false);
      if(globalSearchRef.current&&!globalSearchRef.current.contains(e.target)){setGlobalSearch('');setSearchFocused(false);}
      if(rehabMenuRef.current&&!rehabMenuRef.current.contains(e.target))setRehabOpen(false);
    };
    document.addEventListener('mousedown',handler);
    return ()=>document.removeEventListener('mousedown',handler);
  },[]);

  // "/" or Cmd/Ctrl+K jumps straight to search from anywhere, as long as focus isn't
  // already in a text field (so it doesn't hijack typing "/" into a notes box).
  useEffect(()=>{
    const handler=e=>{
      const tag=document.activeElement?.tagName;
      const typing=tag==='INPUT'||tag==='TEXTAREA'||document.activeElement?.isContentEditable;
      const isShortcut=(e.key==='/'&&!typing)||((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k');
      if(!isShortcut) return;
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    document.addEventListener('keydown',handler);
    return ()=>document.removeEventListener('keydown',handler);
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
      const undo = computeInverse(prev, next);
      if(undo){
        const redo = computeInverse(next, prev);
        undoStackRef.current=[...undoStackRef.current,{undo,redo}].slice(-UNDO_STACK_LIMIT);
        setUndoCount(undoStackRef.current.length);
        redoStackRef.current=[];
        setRedoCount(0);
      }
      saveQueueRef.current = saveQueueRef.current.then(()=>persistWithRetry(next, fn));
      return next
    })
  }
  const handleUndo = () => {
    const stack = undoStackRef.current;
    if (!stack.length) return;
    const entry = stack[stack.length-1];
    undoStackRef.current = stack.slice(0,-1);
    setUndoCount(undoStackRef.current.length);
    redoStackRef.current = [...redoStackRef.current, entry];
    setRedoCount(redoStackRef.current.length);
    setData(prev=>{
      const reverted = entry.undo(prev);
      saveQueueRef.current = saveQueueRef.current.then(()=>persistWithRetry(reverted, entry.undo));
      return reverted;
    });
  };
  const handleRedo = () => {
    const stack = redoStackRef.current;
    if (!stack.length) return;
    const entry = stack[stack.length-1];
    redoStackRef.current = stack.slice(0,-1);
    setRedoCount(redoStackRef.current.length);
    undoStackRef.current = [...undoStackRef.current, entry];
    setUndoCount(undoStackRef.current.length);
    setData(prev=>{
      const reapplied = entry.redo(prev);
      saveQueueRef.current = saveQueueRef.current.then(()=>persistWithRetry(reapplied, entry.redo));
      return reapplied;
    });
  };
  const navigate = entity => {
    setPanelStack(s=>[...s,entity]);
    const resolved=labelForEntity(entity,data);
    if(resolved){
      setRecentlyViewed(prev=>{
        const key=JSON.stringify(entity);
        const next=[{entity,...resolved},...prev.filter(r=>JSON.stringify(r.entity)!==key)];
        return next.slice(0,6);
      });
    }
  };
  const navStackNavigate = entity => setNavStack(s=>[...s,entity]);

  // ── Derived values for sidebar counts and global search ──
  // `data` is still null while the initial load is in flight — these run unconditionally
  // (before the `if(loading) return` below) so hook order never changes between renders,
  // and just no-op until data actually lands.
  const {activeProps,activeLenders,activeLoans,closedCount,unassignedFundsCount}=useMemo(()=>{
    const empty={activeProps:0,activeLenders:0,activeLoans:0,closedCount:0,unassignedFundsCount:0};
    if(!data) return empty;
    return {
      activeProps:data.properties.filter(p=>!p.dateSold).length,
      activeLenders:[...new Set([...data.properties.flatMap(p=>p.loans.filter(l=>!l.endDate).map(l=>l.lenderName)),...data.unassigned.filter(l=>!l.endDate).map(l=>l.lenderName)].filter(Boolean))].length,
      activeLoans:data.properties.flatMap(p=>p.loans.filter(l=>!l.endDate)).length+(data.unassigned||[]).filter(l=>!l.endDate).length,
      closedCount:data.properties.filter(p=>p.dateSold).length,
      unassignedFundsCount:(data.unassigned||[]).filter(l=>!l.endDate).length,
    };
  },[data]);

  const globalResults=useMemo(()=>{
    if(!data||globalSearch.length<2)return[];
    const q=globalSearch.toLowerCase();
    const qDigits=globalSearch.replace(/[^0-9]/g,"");
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
    // Every loan, active or closed — the base pool for lender/note/amount matches below,
    // so a lender who's fully paid off (or a closed loan's note) is still findable.
    const allLoans=[
      ...data.properties.flatMap(p=>p.loans.map(l=>({...l,propAddress:p.address,propId:p.id}))),
      ...(data.unassigned||[]).map(l=>({...l,propAddress:null,propId:null})),
    ];
    // Lenders — group by name, attach their individual loans (active + closed) as sub-items
    const seenLenders=new Set();
    allLoans.forEach(l=>{
      if(l.lenderName?.toLowerCase().includes(q)&&!seenLenders.has(l.lenderName)){
        seenLenders.add(l.lenderName);
        const loans=allLoans.filter(x=>x.lenderName===l.lenderName);
        const active=loans.filter(x=>!x.endDate);
        const totPrin=active.reduce((s,x)=>s+(x.principal||0),0);
        results.push({
          kind:'lender',
          label:l.lenderName,
          sub:active.length>0?`${active.length} active loan${active.length!==1?'s':''} · ${$$p(totPrin)}`:`${loans.length} closed loan${loans.length!==1?'s':''}`,
          entity:{type:'lender',name:l.lenderName},
          loans:loans.slice(0,5).map(x=>({
            label:`${$$p(x.principal)} · ${x.propAddress||'Unassigned'}${x.endDate?' (closed)':''}`,
            entity:{type:'loan',loanId:x.id,propId:x.propId||null},
          })),
        });
      }
    });
    // Loan notes ("special terms") — only when the lender-name match above didn't already
    // surface this loan's lender.
    allLoans.forEach(l=>{
      if(l.specialTerms&&l.specialTerms.toLowerCase().includes(q)&&!seenLenders.has(l.lenderName)){
        results.push({kind:'note',label:l.lenderName||'Loan',sub:l.specialTerms,entity:{type:'loan',loanId:l.id,propId:l.propId||null}});
      }
    });
    // Loans by amount — require at least 3 digits so "10" doesn't match half the ledger.
    if(qDigits.length>=3){
      allLoans.forEach(l=>{
        if(String(Math.round(l.principal||0)).includes(qDigits)){
          results.push({kind:'amount',label:$$p(l.principal),sub:`${l.lenderName||'Unknown'} · ${l.propAddress||'Unassigned'}${l.endDate?' (closed)':''}`,entity:{type:'loan',loanId:l.id,propId:l.propId||null}});
        }
      });
    }
    // Overage checks — surfaces the parent property.
    data.properties.forEach(p=>{
      (p.overageChecks||[]).forEach(oc=>{
        const src=overageSourceLabel(oc.source);
        if((oc.notes||'').toLowerCase().includes(q)||src.toLowerCase().includes(q)){
          results.push({kind:'overage',label:p.address||"",sub:`Overage Check · ${src}${oc.notes?' — '+oc.notes:''}`,entity:{type:'property',id:p.id}});
        }
      });
    });
    // Whiteboard cards — no dedicated detail route, so this just jumps to the Whiteboard tab.
    (data.whiteboard?.cards||[]).forEach(c=>{
      if(c.address&&c.address.toLowerCase().includes(q)){
        results.push({kind:'whiteboard',label:c.address,sub:`Whiteboard · ${c.direction==='in'?'money in':'money out'}${c.amount?' · '+$$p(c.amount):''}`,action:()=>setTab('Whiteboard')});
      }
    });
    // Home screen shortcuts (folders + quick links) — jumps to the Home screen.
    (data.folders||[]).forEach(f=>{
      if(f.name&&f.name.toLowerCase().includes(q)) results.push({kind:'home',label:f.name,sub:'Home Screen Folder',action:()=>onHome?.()});
    });
    (data.quickLinks||[]).forEach(l=>{
      if(l.label&&l.label.toLowerCase().includes(q)) results.push({kind:'home',label:l.label,sub:'Home Screen Shortcut',action:()=>onHome?.()});
    });
    return results.slice(0,12);
  },[globalSearch,data]);

  if(loading) return (
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-[#14161F] flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 rounded-full border-2 border-slate-200 dark:border-zinc-700 border-t-teal-500 animate-spin"/>
        <div className="text-slate-400 dark:text-zinc-500 text-sm font-medium">Loading…</div>
      </div>
    </div>
  );

  return (
    <PrivacyContext.Provider value={privacyMode}>
    <PanelContext.Provider value={navigate}>
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-[#14161F] flex transition-colors duration-300">

      {/* ── Left Sidebar (desktop only) ── */}
      <div className="hidden sm:flex fixed left-0 top-0 bottom-0 w-14 bg-[#F2F2F7] dark:bg-[#14161F] border-r border-black/[0.05] dark:border-white/[0.04] flex-col z-40">
        {/* Logo / Dashboard */}
        <button onClick={()=>{setNavStack([]);setPanelStack([]);setTab("Dashboard");}} title="Dashboard"
          className={`mx-auto mt-3.5 mb-2.5 w-9 h-9 rounded-[11px] flex items-center justify-center active:scale-95 transition-all shrink-0 ${tab==="Dashboard"&&navStack.length===0?"bg-gradient-to-br from-teal-600 to-teal-700 shadow-lg shadow-teal-500/30 ring-2 ring-teal-400/40":"bg-gradient-to-br from-teal-500 to-teal-700 shadow-md shadow-teal-500/30"}`}>
          <span className="text-white font-black text-lg leading-none tracking-tight">$</span>
        </button>
        <div className="h-px bg-black/[0.06] dark:bg-white/[0.06] mx-2 mb-1.5"/>

        {/* Nav items */}
        <nav className="flex flex-col gap-0.5 px-1.5 flex-1">
          <SideBtn icon={<IcoHome/>} label="Properties" badge={unassignedFundsCount} tooltip={`Properties (${activeProps})${unassignedFundsCount>0?` · ${unassignedFundsCount} fund${unassignedFundsCount!==1?'s':''} unassigned`:''}`} active={tab==="Properties"&&navStack.length===0} onClick={()=>{setNavStack([]);setPanelStack([]);setTab("Properties");}}/>
          <SideBtn icon={<IcoUsers/>} label="Lenders" tooltip={`Lenders (${activeLenders})`} active={tab==="LenderDash"&&navStack.length===0} onClick={()=>{setNavStack([]);setPanelStack([]);setTab("LenderDash");}}/>
          <SideBtn icon={<IcoList/>} label="Loans" tooltip={`Loans (${activeLoans})`} active={tab==="AllLoans"&&navStack.length===0} onClick={()=>{setNavStack([]);setPanelStack([]);setTab("AllLoans");}}/>

          {/* Renovation group — hover reveals the submenu on desktop; also toggles on
              click so it works on touch/click-only devices (a laptop trackpad running
              Windows, an iPad) where hover never fires. */}
          <div ref={rehabMenuRef} className="relative" onMouseEnter={openRehabHover} onMouseLeave={closeRehabHoverDelayed}>
            <button onClick={()=>setRehabOpen(o=>!o)} title="Renovation"
              className={`relative flex items-center justify-center w-full p-2.5 rounded-xl transition-all cursor-pointer ${["RehabPriority","Draws","PropDash"].includes(tab)&&navStack.length===0?"bg-teal-600":"hover:bg-black/5 dark:hover:bg-white/10"}`}>
              <span className={`shrink-0 ${["RehabPriority","Draws","PropDash"].includes(tab)&&navStack.length===0?"text-white":"text-slate-400 dark:text-zinc-500"}`}><IcoWrench/></span>
            </button>
            {(rehabHover||rehabOpen)&&(
              <div className="absolute left-full top-0 ml-0.5 bg-white dark:bg-zinc-800 rounded-xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden w-44 z-50 py-1">
                <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500">Renovation</div>
                {[{id:"RehabPriority",ico:<IcoClipboard/>,l:"Rehab Priority"},{id:"Draws",ico:<IcoGrid/>,l:"Draw Tracker"},{id:"PropDash",ico:<IcoBar/>,l:"Prop Dashboard"}].map(({id,ico,l})=>(
                  <button key={id} onClick={()=>{setNavStack([]);setPanelStack([]);setTab(id);setRehabHover(false);setRehabOpen(false);}}
                    className={`w-full text-left flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium transition-colors ${tab===id&&navStack.length===0?"bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-300":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700"}`}>
                    <span className="text-slate-400 dark:text-zinc-500 shrink-0">{ico}</span>{l}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Records = Closed + History */}
          <SideBtn icon={<IcoDocument/>} label="Records" tooltip="Records" active={["Closed","History"].includes(tab)&&navStack.length===0} onClick={()=>{setNavStack([]);setPanelStack([]);setTab(["Closed","History"].includes(tab)?tab:"Closed");}}/>
          <SideBtn icon={<IcoPin/>} label="Whiteboard" tooltip="Whiteboard" active={tab==="Whiteboard"&&navStack.length===0} onClick={()=>{setNavStack([]);setPanelStack([]);setTab("Whiteboard");}}/>
        </nav>

        {/* Bottom — Home Screen + Settings */}
        {onHome&&(
          <div className="px-1.5 mb-1">
            <SideBtn icon={<IcoApps/>} label="Home Screen" tooltip="Home Screen" onClick={onHome}/>
          </div>
        )}
        <div className="px-1.5 pb-3 relative" ref={settingsRef}>
          <div className="relative group">
            <button onClick={()=>setSettingsOpen(o=>!o)}
              className={`flex items-center justify-center w-full p-2.5 rounded-xl transition-all ${settingsOpen?"bg-teal-600":"hover:bg-black/5 dark:hover:bg-white/10"}`}>
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
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${privacyMode?"bg-teal-100 dark:bg-teal-900/40 text-teal-600 dark:text-teal-400":"bg-slate-100 dark:bg-zinc-700 text-slate-400 dark:text-zinc-500"}`}>{privacyMode?"ON":"OFF"}</span>
              </button>
              <button onClick={onToggleDark}
                className="w-full flex items-center px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors text-left">
                {dark?"Light Mode":"Dark Mode"}
              </button>
              <div className="h-px bg-slate-100 dark:bg-zinc-700 mx-3 my-1"/>
              <button onClick={()=>{setSettingsOpen(false);setTab("LenderAccts");}}
                className="w-full flex items-center px-4 py-2.5 text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors text-left">
                Portal Access
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
          <div className="fixed left-0 top-0 bottom-0 z-50 w-72 max-w-[85vw] bg-white dark:bg-[#1C1F2B] shadow-2xl flex flex-col sm:hidden overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-4 border-b border-slate-100 dark:border-zinc-800 shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-[10px] bg-gradient-to-br from-teal-500 to-teal-700 shadow-md shadow-teal-500/30 flex items-center justify-center shrink-0">
                  <span className="text-white font-black text-sm leading-none">$</span>
                </div>
                <span className="font-bold text-slate-900 dark:text-zinc-100 text-sm">Nexus Homes</span>
              </div>
              <button onClick={()=>setMobileNavOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-slate-500 dark:text-zinc-400 text-xl leading-none shrink-0">&times;</button>
            </div>
            <nav className="flex-1 py-2 px-2">
              {[
                {id:"Dashboard",icon:<IcoPie/>,label:"Dashboard",match:t=>t==="Dashboard"},
                {id:"Properties",icon:<IcoHome/>,label:"Properties",match:t=>t==="Properties",badge:unassignedFundsCount},
                {id:"LenderDash",icon:<IcoUsers/>,label:"Lenders",match:t=>t==="LenderDash"},
                {id:"AllLoans",icon:<IcoList/>,label:"Loans",match:t=>t==="AllLoans"},
              ].map(({id,icon,label,match,badge})=>(
                <button key={id}
                  onClick={()=>{setNavStack([]);setPanelStack([]);setTab(id);setMobileNavOpen(false);}}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${match(tab)&&navStack.length===0?"bg-teal-600 text-white":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800"}`}>
                  <span className={`relative shrink-0 ${match(tab)&&navStack.length===0?"text-white":"text-slate-400 dark:text-zinc-500"}`}>
                    {icon}
                    {badge>0&&<span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500"/>}
                  </span>
                  {label}
                </button>
              ))}

              {/* Renovation group — expands in place instead of three separate rows */}
              <button onClick={()=>setMobileRenovOpen(o=>!o)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${["RehabPriority","Draws","PropDash"].includes(tab)&&navStack.length===0&&!mobileRenovOpen?"bg-teal-600 text-white":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800"}`}>
                <span className="flex items-center gap-3">
                  <span className={`shrink-0 ${["RehabPriority","Draws","PropDash"].includes(tab)&&navStack.length===0&&!mobileRenovOpen?"text-white":"text-slate-400 dark:text-zinc-500"}`}>
                    <IcoWrench/>
                  </span>
                  Renovation
                </span>
                <span className="text-xs opacity-60">{mobileRenovOpen?"▲":"▼"}</span>
              </button>
              {mobileRenovOpen&&[
                {id:"RehabPriority",icon:<IcoClipboard/>,label:"Rehab Priority",match:t=>t==="RehabPriority"},
                {id:"Draws",icon:<IcoGrid/>,label:"Draw Tracker",match:t=>t==="Draws"},
                {id:"PropDash",icon:<IcoBar/>,label:"Prop Dashboard",match:t=>t==="PropDash"},
              ].map(({id,icon,label,match})=>(
                <button key={id}
                  onClick={()=>{setNavStack([]);setPanelStack([]);setTab(id);setMobileNavOpen(false);}}
                  className={`w-full flex items-center gap-3 pl-9 pr-3 py-2 rounded-xl text-sm font-medium transition-colors ${match(tab)&&navStack.length===0?"bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-300":"text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800"}`}>
                  <span className="shrink-0 text-slate-400 dark:text-zinc-500">{icon}</span>
                  {label}
                </button>
              ))}

              {[
                {id:"Closed",icon:<IcoDocument/>,label:"Records",match:t=>["Closed","History"].includes(t)},
                {id:"Whiteboard",icon:<IcoPin/>,label:"Whiteboard",match:t=>t==="Whiteboard"},
              ].map(({id,icon,label,match,badge})=>(
                <button key={id}
                  onClick={()=>{setNavStack([]);setPanelStack([]);setTab(id);setMobileNavOpen(false);}}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${match(tab)&&navStack.length===0?"bg-teal-600 text-white":"text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800"}`}>
                  <span className={`relative shrink-0 ${match(tab)&&navStack.length===0?"text-white":"text-slate-400 dark:text-zinc-500"}`}>
                    {icon}
                    {badge>0&&<span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500"/>}
                  </span>
                  {label}
                </button>
              ))}
            </nav>
            <div className="border-t border-slate-100 dark:border-zinc-800 py-2 px-2 shrink-0">
              <button onClick={()=>setPrivacyMode(p=>!p)}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors">
                <span>Demo Mode</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${privacyMode?"bg-teal-100 dark:bg-teal-900/40 text-teal-600 dark:text-teal-400":"bg-slate-100 dark:bg-zinc-700 text-slate-400 dark:text-zinc-500"}`}>{privacyMode?"ON":"OFF"}</span>
              </button>
              <button onClick={onToggleDark}
                className="w-full flex items-center px-3 py-2.5 rounded-xl text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors text-left">
                {dark?"Light Mode":"Dark Mode"}
              </button>
              <button onClick={()=>{setMobileNavOpen(false);setNavStack([]);setPanelStack([]);setTab("LenderAccts");}}
                className="w-full flex items-center px-3 py-2.5 rounded-xl text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors text-left">
                Portal Access
              </button>
              {onHome&&(
                <button onClick={()=>{setMobileNavOpen(false);onHome();}}
                  className="w-full flex items-center px-3 py-2.5 rounded-xl text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors text-left">
                  Home Screen
                </button>
              )}
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
                <input type="text" ref={searchInputRef} value={globalSearch}
                  onFocus={()=>setSearchFocused(true)}
                  onChange={e=>{setGlobalSearch(e.target.value);setGlobalSelIdx(-1);}}
                  onKeyDown={e=>{
                    if(!globalResults.length) return;
                    if(e.key==='ArrowDown'){e.preventDefault();setGlobalSelIdx(i=>(i+1)%globalResults.length);}
                    else if(e.key==='ArrowUp'){e.preventDefault();setGlobalSelIdx(i=>(i-1+globalResults.length)%globalResults.length);}
                    else if(e.key==='Enter'&&globalSelIdx>=0){
                      const r=globalResults[globalSelIdx];
                      if(r.action) r.action(); else navigate(r.entity);
                      setGlobalSearch('');setGlobalSelIdx(-1);
                    } else if(e.key==='Escape'){setGlobalSearch('');setGlobalSelIdx(-1);searchInputRef.current?.blur();}
                  }}
                  placeholder="Search properties, lenders, notes, amounts… (/)"
                  className="w-full pl-8 pr-3 py-1.5 rounded-full text-sm bg-black/[0.06] dark:bg-white/[0.08] text-slate-800 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-teal-500/50 border-0"/>
              </div>
              {globalSearch.length===0&&searchFocused&&recentlyViewed.length>0&&(
                <div className="absolute top-full left-0 right-0 mt-1.5 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-50">
                  <div className="px-4 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500">Recently Viewed</div>
                  {recentlyViewed.map((r,i)=>(
                    <button key={i} onClick={()=>{navigate(r.entity);setGlobalSearch('');setSearchFocused(false);}}
                      className="w-full text-left flex items-start gap-2.5 px-4 py-2 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors">
                      <div className="min-w-0">
                        <div className="text-sm text-slate-800 dark:text-zinc-200 font-semibold truncate">{r.label}</div>
                        {r.sub&&<div className="text-xs text-slate-400 dark:text-zinc-500 truncate">{r.sub}</div>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {globalSearch.length>1&&(
                <div className="absolute top-full left-0 right-0 mt-1.5 max-h-[70vh] overflow-y-auto bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-50">
                  {globalResults.length===0
                    ?<div className="px-4 py-3 text-sm text-slate-400 dark:text-zinc-500">No results</div>
                    :globalResults.map((r,i)=>{
                      const badge={
                        lender:['Lender','bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400'],
                        note:['Note','bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400'],
                        amount:['Amount','bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'],
                        overage:['Overage','bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400'],
                        whiteboard:['Whiteboard','bg-slate-100 dark:bg-zinc-700 text-slate-500 dark:text-zinc-400'],
                        home:['Home Screen','bg-slate-100 dark:bg-zinc-700 text-slate-500 dark:text-zinc-400'],
                      }[r.kind]||['Property','bg-slate-100 dark:bg-zinc-700 text-slate-500 dark:text-zinc-400'];
                      return (
                      <div key={i} className="border-b border-slate-50 dark:border-zinc-700/40 last:border-0">
                        {/* Result header row */}
                        <button onClick={()=>{if(r.action) r.action(); else navigate(r.entity);setGlobalSearch('');setGlobalSelIdx(-1);}}
                          onMouseEnter={()=>setGlobalSelIdx(i)}
                          className={`w-full text-left flex items-start gap-2.5 px-4 py-2.5 transition-colors ${globalSelIdx===i?'bg-slate-50 dark:bg-zinc-700':'hover:bg-slate-50 dark:hover:bg-zinc-700'}`}>
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md shrink-0 mt-0.5 ${badge[1]}`}>{badge[0]}</span>
                          <div className="min-w-0">
                            <div className="text-sm text-slate-800 dark:text-zinc-200 font-semibold truncate">{r.label}</div>
                            {r.sub&&<div className="text-xs text-slate-400 dark:text-zinc-500 truncate">{r.sub}</div>}
                          </div>
                        </button>
                        {/* Loan sub-rows for lender results */}
                        {r.loans&&r.loans.map((loan,j)=>(
                          <button key={j} onClick={()=>{navigate(loan.entity);setGlobalSearch('');setGlobalSelIdx(-1);}}
                            className="w-full text-left flex items-center gap-2 pl-10 pr-4 py-2 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors">
                            <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-slate-300 dark:text-zinc-600 shrink-0"><path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd"/></svg>
                            <span className="text-xs text-slate-600 dark:text-zinc-300 truncate">{loan.label}</span>
                          </button>
                        ))}
                      </div>
                      );
                    })
                  }
                </div>
              )}
            </div>

            {/* Right side — Actions button, adjacent to search */}
            <div className="flex-1 flex justify-end sm:justify-start items-center gap-2 pl-0 sm:pl-3">
            <div className="flex items-center gap-0.5 shrink-0">
              <button onClick={handleUndo} disabled={undoCount===0}
                title={undoCount>0?`Undo last change${undoCount>1?` (${undoCount} steps available)`:''}`:'Nothing to undo'}
                className={`relative flex items-center justify-center w-7 h-7 rounded-full transition-all ${undoCount===0?"text-slate-300 dark:text-zinc-700 cursor-not-allowed":"text-slate-500 dark:text-zinc-400 hover:bg-slate-200 dark:hover:bg-zinc-800"}`}>
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0"><path fillRule="evenodd" d="M9.707 3.293a1 1 0 010 1.414L7.414 7H12a5 5 0 110 10H8a1 1 0 110-2h4a3 3 0 100-6H7.414l2.293 2.293a1 1 0 11-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
                {undoCount>1&&<span className="absolute -top-0.5 -right-0.5 text-[9px] font-bold bg-slate-300 dark:bg-zinc-600 text-slate-700 dark:text-zinc-200 rounded-full w-3.5 h-3.5 flex items-center justify-center leading-none">{undoCount}</span>}
              </button>
              <button onClick={handleRedo} disabled={redoCount===0}
                title={redoCount>0?`Redo${redoCount>1?` (${redoCount} steps available)`:''}`:'Nothing to redo'}
                className={`relative flex items-center justify-center w-7 h-7 rounded-full transition-all ${redoCount===0?"text-slate-300 dark:text-zinc-700 cursor-not-allowed":"text-slate-500 dark:text-zinc-400 hover:bg-slate-200 dark:hover:bg-zinc-800"}`}>
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0 scale-x-[-1]"><path fillRule="evenodd" d="M9.707 3.293a1 1 0 010 1.414L7.414 7H12a5 5 0 110 10H8a1 1 0 110-2h4a3 3 0 100-6H7.414l2.293 2.293a1 1 0 11-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
                {redoCount>1&&<span className="absolute -top-0.5 -right-0.5 text-[9px] font-bold bg-slate-300 dark:bg-zinc-600 text-slate-700 dark:text-zinc-200 rounded-full w-3.5 h-3.5 flex items-center justify-center leading-none">{redoCount}</span>}
              </button>
            </div>
            <div ref={fabRef} className="relative shrink-0">
              <button onClick={()=>setFabOpen(o=>!o)}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-full text-sm font-semibold text-teal-700 dark:text-teal-400 transition-all border border-teal-500/40 dark:border-teal-400/40 ${fabOpen?"bg-teal-500/15":"bg-teal-500/5 hover:bg-teal-500/15"}`}>
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 shrink-0"><path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd"/></svg>
                <span className="hidden sm:inline">Actions</span>
              </button>
              {fabOpen&&(
                <div className="absolute right-0 top-10 w-52 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl dark:shadow-zinc-900 border border-slate-100 dark:border-zinc-700 overflow-hidden z-50 py-1">
                  {[
                    {label:"Add Property",modal:"addProp"},
                    {label:"Add Lender Money",modal:{type:"addMoney"}},
                    "divider",
                    {label:"Close Property",modal:{type:"closePropPicker"}},
                    {label:"Close Lender Only",modal:"closeLender"},
                    "divider",
                    {label:"Record Draw",modal:{type:"quickDraw"}},
                    {label:"Overage Check",modal:{type:"overageCheckPicker"}},
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
              <div className="flex mb-4 bg-white dark:bg-[#1C1F2B] rounded-xl overflow-hidden shadow-sm border border-slate-100 dark:border-zinc-800 self-start w-fit">
                {[["Closed","Closed Deals"],["History","History"]].map(([id,l])=>(
                  <button key={id} onClick={()=>setTab(id)}
                    className={`px-4 py-2 text-sm font-semibold transition-all ${tab===id?"bg-teal-600 text-white":"text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200"}`}>
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
            {tab==="Whiteboard"   &&<WhiteboardPage data={data} update={update}/>}
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
          <div className="fixed top-0 right-0 bottom-0 z-50 flex flex-col bg-[#F2F2F7] dark:bg-[#10121A] shadow-2xl" style={{width:'min(700px,82vw)'}}>
            {/* Panel chrome */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-black/[0.06] dark:border-white/[0.05] bg-white/70 dark:bg-black/70 backdrop-blur-xl shrink-0">
              {panelStack.length>1&&(
                <button onClick={()=>setPanelStack(s=>s.slice(0,-1))}
                  className="flex items-center gap-1 text-xs font-semibold text-slate-500 dark:text-zinc-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
                  Back
                </button>
              )}
              <div className="flex-1"/>
              <button
                onClick={()=>{const e=panelStack[panelStack.length-1];setPanelStack([]);setNavStack([e]);}}
                className="flex items-center gap-1.5 text-xs font-semibold text-teal-600 dark:text-teal-400 hover:text-teal-700 dark:hover:text-teal-300 transition-colors">
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
