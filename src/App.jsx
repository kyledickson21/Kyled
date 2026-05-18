import { useState, useEffect } from "react";
import { authStatus, setupUser, login, setToken, clearToken, getData, saveData, exportCSV, exportJSON } from "./api.js";

// ─── Utilities ────────────────────────────────────────────────────────────────
const TODAY = new Date().toISOString().split("T")[0];
const uid = () => Math.random().toString(36).slice(2, 9);

const $$ = n => {
  const abs = Math.round(Math.abs(n ?? 0));
  return "$" + abs.toLocaleString();
};
const $$s = n => {
  if (n === undefined || n === null) return "—";
  const abs = Math.round(Math.abs(n)).toLocaleString();
  return n >= 0 ? `+$${abs}` : `-$${abs}`;
};

const daysBetween = (d1, d2) => {
  if (!d1 || !d2) return 0;
  return Math.max(0, Math.floor((new Date(d2) - new Date(d1)) / 864e5));
};

const calcInterest = (principal, rate, start, end) =>
  (principal || 0) * ((rate || 0) / 100) * (daysBetween(start, end) / 365);

const calcBalance = (loan, asOf = TODAY) => {
  if (!loan?.startDate || !loan?.principal) return loan?.principal ?? 0;
  const end = loan.endDate && loan.endDate <= asOf ? loan.endDate : asOf;
  if (loan.startDate > end) return loan.principal;
  return loan.principal + calcInterest(loan.principal, loan.interestRate, loan.startDate, end);
};

// ─── Design Tokens ────────────────────────────────────────────────────────────
const TYPE_COLORS = {
  private: { bg: "bg-sky-100", text: "text-sky-700", dot: "bg-sky-500" },
  hard:    { bg: "bg-amber-100", text: "text-amber-700", dot: "bg-amber-500" },
};

// ─── UI Primitives ────────────────────────────────────────────────────────────
const Field = ({ label, type = "text", value, onChange, placeholder, helpText }) => (
  <div className="mb-4">
    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">{label}</label>
    <input
      type={type}
      value={value ?? ""}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full border border-slate-200 bg-slate-50 rounded-xl px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all"
    />
    {helpText && <p className="text-[11px] text-slate-400 mt-1">{helpText}</p>}
  </div>
);

const SelectField = ({ label, value, onChange, options }) => (
  <div className="mb-4">
    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">{label}</label>
    <select
      value={value ?? ""}
      onChange={e => onChange(e.target.value)}
      className="w-full border border-slate-200 bg-slate-50 rounded-xl px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all appearance-none"
    >
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </div>
);

const TypeBadge = ({ type, small }) => {
  const c = TYPE_COLORS[type] || TYPE_COLORS.private;
  return (
    <span className={`inline-flex items-center gap-1 ${c.bg} ${c.text} rounded-full font-semibold ${small ? "text-[10px] px-2 py-0.5" : "text-xs px-2.5 py-1"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot} shrink-0`} />
      {type === "hard" ? "Hard Money" : "Private Money"}
    </span>
  );
};

const StatusChip = ({ children, color }) => {
  const colors = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    red: "bg-red-50 text-red-700 border-red-200",
    gray: "bg-slate-100 text-slate-500 border-slate-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return <span className={`inline-flex items-center text-[11px] font-semibold border rounded-full px-2.5 py-0.5 ${colors[color]}`}>{children}</span>;
};

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        style={{ boxShadow: "0 25px 60px rgba(0,0,0,0.2)" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-between items-center px-6 py-5 border-b border-slate-100 sticky top-0 bg-white rounded-t-2xl z-10">
          <h2 className="font-bold text-slate-800 text-base">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-all text-xl leading-none">&times;</button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

const PrimaryBtn = ({ onClick, children, color = "blue", full, sm }) => {
  const colors = {
    blue: "bg-blue-600 hover:bg-blue-700 text-white shadow-blue-200",
    green: "bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-200",
    purple: "bg-violet-600 hover:bg-violet-700 text-white shadow-violet-200",
    red: "bg-red-500 hover:bg-red-600 text-white",
    ghost: "bg-slate-100 hover:bg-slate-200 text-slate-700",
  };
  return (
    <button onClick={onClick} className={`${colors[color]} ${full ? "w-full" : ""} ${sm ? "px-3 py-1.5 text-xs" : "px-4 py-2.5 text-sm"} rounded-xl font-semibold transition-all shadow-sm`}>
      {children}
    </button>
  );
};

// ─── Auth Screens ─────────────────────────────────────────────────────────────
function AuthScreen({ mode, onSuccess, error, setError }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const isSetup = mode === "setup";

  const submit = async () => {
    setError("");
    if (!username.trim() || !password) { setError("Username and password are required."); return; }
    if (isSetup && password !== confirm) { setError("Passwords do not match."); return; }
    if (isSetup && password.length < 6) { setError("Password must be at least 6 characters."); return; }
    setLoading(true);
    try {
      const res = isSetup ? await setupUser(username.trim(), password) : await login(username.trim(), password);
      if (res.error) { setError(res.error); return; }
      setToken(res.token);
      onSuccess();
    } catch { setError("Connection error. Is the server running?"); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-blue-600 text-white font-bold flex items-center justify-center shadow-md shadow-blue-200">N</div>
          <div>
            <div className="font-bold text-slate-800">Nexus Homes</div>
            <div className="text-[11px] text-slate-400 uppercase tracking-wide font-medium">Private Money Tracker</div>
          </div>
        </div>
        <h2 className="text-lg font-bold text-slate-800 mb-1">{isSetup ? "Create Admin Account" : "Sign In"}</h2>
        <p className="text-sm text-slate-400 mb-6">{isSetup ? "Set up your Nexus account to get started." : "Welcome back to Nexus Homes."}</p>
        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 mb-4">{error}</div>}
        <Field label="Username" value={username} onChange={setUsername} placeholder="nexus-admin" />
        <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="••••••••" />
        {isSetup && <Field label="Confirm Password" type="password" value={confirm} onChange={setConfirm} placeholder="••••••••" />}
        <PrimaryBtn onClick={submit} full>{loading ? "Please wait…" : isSetup ? "Create Account" : "Sign In"}</PrimaryBtn>
      </div>
    </div>
  );
}

// ─── Forms ────────────────────────────────────────────────────────────────────
function PropertyForm({ init, onSave, onClose }) {
  const [f, sf] = useState(init ?? { address: "", fundingNeeded: "", dateSold: "" });
  const s = k => v => sf(p => ({ ...p, [k]: v }));
  return (
    <div>
      <Field label="Property Address" value={f.address} onChange={s("address")} placeholder="123 Oak Ave, Nashville, TN" />
      <Field label="Estimated Funding Needed ($)" type="number" value={f.fundingNeeded} onChange={s("fundingNeeded")} placeholder="175000" />
      <Field label="Date Sold" type="date" value={f.dateSold} onChange={s("dateSold")} helpText="Leave blank if property is still active" />
      <div className="flex gap-2 pt-1">
        <PrimaryBtn onClick={() => onSave(f)} full>Save Property</PrimaryBtn>
        <PrimaryBtn onClick={onClose} color="ghost">Cancel</PrimaryBtn>
      </div>
    </div>
  );
}

function LoanForm({ init, onSave, onClose }) {
  const [f, sf] = useState(init ?? { lenderName: "", loanType: "private", principal: "", startDate: TODAY, interestRate: "", specialTerms: "", endDate: "" });
  const s = k => v => sf(p => ({ ...p, [k]: v }));
  return (
    <div>
      <Field label="Lender Name" value={f.lenderName} onChange={s("lenderName")} placeholder="Mike Dixon" />
      <SelectField label="Loan Type" value={f.loanType} onChange={s("loanType")} options={[["private","Private Money"],["hard","Hard Money"]]} />
      <Field label="Loan Amount ($)" type="number" value={f.principal} onChange={s("principal")} placeholder="100000" />
      <Field label="Start Date" type="date" value={f.startDate} onChange={s("startDate")} />
      <Field label="Annual Interest Rate (%)" type="number" value={f.interestRate} onChange={s("interestRate")} placeholder="10" />
      <Field label="Special Terms" value={f.specialTerms} onChange={s("specialTerms")} placeholder="Monthly interest payments, balloon, etc." />
      <Field label="End / Payoff Date" type="date" value={f.endDate} onChange={s("endDate")} helpText="Leave blank while loan is active" />
      <div className="flex gap-2 pt-1">
        <PrimaryBtn onClick={() => onSave(f)} color="green" full>Save Loan</PrimaryBtn>
        <PrimaryBtn onClick={onClose} color="ghost">Cancel</PrimaryBtn>
      </div>
    </div>
  );
}

function UnassignedForm({ init, onSave, onClose }) {
  const [f, sf] = useState(init ?? { lenderName: "", loanType: "private", amount: "", date: TODAY, notes: "" });
  const s = k => v => sf(p => ({ ...p, [k]: v }));
  return (
    <div>
      <Field label="Lender Name" value={f.lenderName} onChange={s("lenderName")} placeholder="Jane Smith" />
      <SelectField label="Type" value={f.loanType} onChange={s("loanType")} options={[["private","Private Money"],["hard","Hard Money"]]} />
      <Field label="Amount ($)" type="number" value={f.amount} onChange={s("amount")} placeholder="50000" />
      <Field label="Date Received" type="date" value={f.date} onChange={s("date")} />
      <Field label="Notes" value={f.notes} onChange={s("notes")} placeholder="Earmarked for 123 Oak, etc." />
      <div className="flex gap-2 pt-1">
        <PrimaryBtn onClick={() => onSave(f)} color="purple" full>Save Funds</PrimaryBtn>
        <PrimaryBtn onClick={onClose} color="ghost">Cancel</PrimaryBtn>
      </div>
    </div>
  );
}

// ─── Properties Page ─────────────────────────────────────────────────────────
function PropertiesPage({ data, update }) {
  const [addProp, setAddProp] = useState(false);
  const [editProp, setEditProp] = useState(null);
  const [addLoanFor, setAddLoanFor] = useState(null);
  const [editLoan, setEditLoan] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [showSold, setShowSold] = useState(false);

  const toggle = id => setExpanded(e => ({ ...e, [id]: !e[id] }));

  const saveProp = (f, existing) => {
    const p = { ...(existing ?? { id: uid(), loans: [] }), address: f.address, fundingNeeded: parseFloat(f.fundingNeeded) || 0, dateSold: f.dateSold || null };
    update(d => ({ ...d, properties: existing ? d.properties.map(x => x.id === p.id ? p : x) : [...d.properties, p] }));
    setAddProp(false); setEditProp(null);
  };

  const delProp = id => {
    if (!confirm("Delete this property and all its loans? This cannot be undone.")) return;
    update(d => ({ ...d, properties: d.properties.filter(p => p.id !== id) }));
  };

  const saveLoan = (propId, f, existing) => {
    const l = { ...(existing ?? { id: uid() }), lenderName: f.lenderName, loanType: f.loanType, principal: parseFloat(f.principal) || 0, startDate: f.startDate, interestRate: parseFloat(f.interestRate) || 0, specialTerms: f.specialTerms || "", endDate: f.endDate || null };
    update(d => ({ ...d, properties: d.properties.map(p => p.id !== propId ? p : { ...p, loans: existing ? p.loans.map(x => x.id === l.id ? l : x) : [...p.loans, l] }) }));
    setAddLoanFor(null); setEditLoan(null);
  };

  const delLoan = (propId, loanId) => {
    if (!confirm("Delete this loan?")) return;
    update(d => ({ ...d, properties: d.properties.map(p => p.id !== propId ? p : { ...p, loans: p.loans.filter(l => l.id !== loanId) }) }));
  };

  const visible = data.properties.filter(p => showSold || !p.dateSold);

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Properties</h2>
          <p className="text-sm text-slate-400 mt-0.5">All data entry happens here — dashboards auto-populate</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-500 cursor-pointer select-none">
            <input type="checkbox" checked={showSold} onChange={e => setShowSold(e.target.checked)} className="rounded" />
            Show Sold
          </label>
          <PrimaryBtn onClick={() => setAddProp(true)}>+ Add Property</PrimaryBtn>
        </div>
      </div>

      {visible.length === 0 && (
        <div className="text-center py-20 text-slate-400">
          <div className="text-5xl mb-4">🏠</div>
          <p className="font-medium">No active properties yet</p>
          <p className="text-sm mt-1">Add your first property to get started</p>
        </div>
      )}

      <div className="space-y-3">
        {visible.map(prop => {
          const active = prop.loans.filter(l => !l.endDate);
          const funded = active.reduce((s, l) => s + (l.principal || 0), 0);
          const needed = prop.fundingNeeded || 0;
          const short = Math.max(0, needed - funded);
          const under = !prop.dateSold && short > 0;
          const isOpen = !!expanded[prop.id];
          return (
            <div key={prop.id} className={`rounded-2xl border overflow-hidden transition-all ${prop.dateSold ? "border-slate-200 opacity-70" : under ? "border-red-300 shadow-red-100 shadow-md" : "border-slate-200 shadow-sm"}`}>
              <div className={`px-5 py-4 cursor-pointer flex items-center gap-3 ${prop.dateSold ? "bg-slate-50" : under ? "bg-red-50" : "bg-white"}`} onClick={() => toggle(prop.id)}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-800">{prop.address || "Unnamed Property"}</span>
                    {prop.dateSold && <StatusChip color="gray">Sold {prop.dateSold}</StatusChip>}
                    {!prop.dateSold && under && <StatusChip color="red">⚠ Short {$$(short)}</StatusChip>}
                    {!prop.dateSold && !under && funded > 0 && <StatusChip color="green">✓ Fully Funded</StatusChip>}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-xs text-slate-500">
                    <span>Need: <strong className="text-slate-700">{$$(needed)}</strong></span>
                    <span>Funded: <strong className={under ? "text-red-600" : "text-emerald-600"}>{$$(funded)}</strong></span>
                    <span>{active.length} active loan{active.length !== 1 ? "s" : ""}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={e => { e.stopPropagation(); setEditProp(prop); }} className="p-1.5 text-slate-400 hover:text-blue-500 text-base transition-colors">✏️</button>
                  <button onClick={e => { e.stopPropagation(); delProp(prop.id); }} className="p-1.5 text-slate-400 hover:text-red-500 text-base transition-colors">🗑</button>
                  <span className="text-slate-400 ml-1 text-sm">{isOpen ? "▲" : "▼"}</span>
                </div>
              </div>
              {isOpen && (
                <div className="border-t border-slate-100 bg-slate-50 px-5 py-4">
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">Loans ({prop.loans.length})</span>
                    <PrimaryBtn onClick={() => setAddLoanFor(prop.id)} color="green" sm>+ Add Loan</PrimaryBtn>
                  </div>
                  {prop.loans.length === 0 && <div className="text-center py-6 text-slate-400 text-sm">No loans yet — add the first one above</div>}
                  <div className="space-y-2">
                    {prop.loans.map(loan => {
                      const bal = calcBalance(loan);
                      const earned = bal - (loan.principal || 0);
                      return (
                        <div key={loan.id} className={`rounded-xl p-4 border text-sm ${loan.endDate ? "bg-white/60 border-slate-100" : "bg-white border-slate-200 shadow-sm"}`}>
                          <div className="flex justify-between items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-2">
                                <span className="font-bold text-slate-800">{loan.lenderName}</span>
                                <TypeBadge type={loan.loanType} small />
                                {loan.endDate && <StatusChip color="gray">Closed {loan.endDate}</StatusChip>}
                              </div>
                              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
                                <span>Principal: <strong className="text-slate-800">{$$(loan.principal)}</strong></span>
                                <span>Rate: <strong>{loan.interestRate}% / yr</strong></span>
                                <span>Start: <strong>{loan.startDate}</strong></span>
                                <span>Balance: <strong className="text-blue-700">{$$(bal)}</strong></span>
                                <span>Interest: <strong className="text-emerald-600">{$$(earned)}</strong></span>
                                {loan.specialTerms && <span className="col-span-2 text-slate-400 italic">{loan.specialTerms}</span>}
                              </div>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <button onClick={() => setEditLoan({ propId: prop.id, loan })} className="p-1 text-slate-400 hover:text-blue-500 text-sm transition-colors">✏️</button>
                              <button onClick={() => delLoan(prop.id, loan.id)} className="p-1 text-slate-400 hover:text-red-500 text-sm transition-colors">🗑</button>
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
      </div>

      {addProp && <Modal title="Add Property" onClose={() => setAddProp(false)}><PropertyForm onSave={f => saveProp(f, null)} onClose={() => setAddProp(false)} /></Modal>}
      {editProp && <Modal title="Edit Property" onClose={() => setEditProp(null)}><PropertyForm init={editProp} onSave={f => saveProp(f, editProp)} onClose={() => setEditProp(null)} /></Modal>}
      {addLoanFor && <Modal title="Add Loan" onClose={() => setAddLoanFor(null)}><LoanForm onSave={f => saveLoan(addLoanFor, f, null)} onClose={() => setAddLoanFor(null)} /></Modal>}
      {editLoan && <Modal title="Edit Loan" onClose={() => setEditLoan(null)}><LoanForm init={editLoan.loan} onSave={f => saveLoan(editLoan.propId, f, editLoan.loan)} onClose={() => setEditLoan(null)} /></Modal>}
    </div>
  );
}

// ─── Unassigned Funds Page ────────────────────────────────────────────────────
function UnassignedPage({ data, update }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);

  const save = (f, existing) => {
    const item = { ...(existing ?? { id: uid() }), lenderName: f.lenderName, loanType: f.loanType, amount: parseFloat(f.amount) || 0, date: f.date, notes: f.notes || "" };
    update(d => ({ ...d, unassigned: existing ? d.unassigned.map(u => u.id === item.id ? item : u) : [...d.unassigned, item] }));
    setShowAdd(false); setEditing(null);
  };

  const del = id => {
    if (!confirm("Remove these funds?")) return;
    update(d => ({ ...d, unassigned: d.unassigned.filter(u => u.id !== id) }));
  };

  const total = data.unassigned.reduce((s, u) => s + (u.amount || 0), 0);

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Unassigned Funds</h2>
          <p className="text-sm text-violet-600 font-semibold mt-0.5">Total available: {$$(total)}</p>
        </div>
        <PrimaryBtn onClick={() => setShowAdd(true)} color="purple">+ Add Funds</PrimaryBtn>
      </div>
      {data.unassigned.length === 0 && (
        <div className="text-center py-20 text-slate-400">
          <div className="text-5xl mb-4">💰</div>
          <p className="font-medium">No unassigned funds</p>
        </div>
      )}
      <div className="space-y-2">
        {data.unassigned.map(u => (
          <div key={u.id} className="bg-white border border-violet-100 rounded-2xl p-4 flex justify-between items-center shadow-sm">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="font-bold text-slate-800">{u.lenderName}</span>
                <TypeBadge type={u.loanType} small />
              </div>
              <div className="text-sm">
                <strong className="text-violet-700 text-lg">{$$(u.amount)}</strong>
                <span className="text-slate-400 text-xs ml-2">received {u.date}</span>
              </div>
              {u.notes && <div className="text-xs text-slate-400 mt-0.5 italic">{u.notes}</div>}
            </div>
            <div className="flex gap-1">
              <button onClick={() => setEditing(u)} className="p-2 text-slate-400 hover:text-blue-500 transition-colors">✏️</button>
              <button onClick={() => del(u.id)} className="p-2 text-slate-400 hover:text-red-500 transition-colors">🗑</button>
            </div>
          </div>
        ))}
      </div>
      {showAdd && <Modal title="Add Unassigned Funds" onClose={() => setShowAdd(false)}><UnassignedForm onSave={f => save(f, null)} onClose={() => setShowAdd(false)} /></Modal>}
      {editing && <Modal title="Edit Funds" onClose={() => setEditing(null)}><UnassignedForm init={editing} onSave={f => save(f, editing)} onClose={() => setEditing(null)} /></Modal>}
    </div>
  );
}

// ─── Property Dashboard ───────────────────────────────────────────────────────
function PropertyDashboard({ data }) {
  const active = data.properties.filter(p => !p.dateSold);
  const unassignedTotal = data.unassigned.reduce((s, u) => s + (u.amount || 0), 0);
  const rows = active.map(prop => {
    const loans = prop.loans.filter(l => !l.endDate);
    const funded = loans.reduce((s, l) => s + (l.principal || 0), 0);
    const needed = prop.fundingNeeded || 0;
    const short = Math.max(0, needed - funded);
    return { prop, loans, funded, needed, short, under: short > 0 };
  }).sort((a, b) => b.under - a.under);
  const totalDeployed = rows.reduce((s, r) => s + r.funded, 0);
  const totalShort = rows.reduce((s, r) => s + r.short, 0);

  return (
    <div>
      <h2 className="text-2xl font-bold text-slate-800 mb-6">Property Dashboard</h2>
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-blue-600 rounded-2xl p-4 text-white">
          <div className="text-xs font-bold uppercase tracking-wider opacity-70 mb-1">Total Deployed</div>
          <div className="text-xl font-bold">{$$(totalDeployed)}</div>
          <div className="text-xs opacity-60 mt-0.5">{rows.length} properties</div>
        </div>
        <div className="bg-violet-600 rounded-2xl p-4 text-white">
          <div className="text-xs font-bold uppercase tracking-wider opacity-70 mb-1">Unassigned</div>
          <div className="text-xl font-bold">{$$(unassignedTotal)}</div>
          <div className="text-xs opacity-60 mt-0.5">{data.unassigned.length} lender(s)</div>
        </div>
        <div className={`rounded-2xl p-4 text-white ${totalShort > 0 ? "bg-red-500" : "bg-emerald-600"}`}>
          <div className="text-xs font-bold uppercase tracking-wider opacity-70 mb-1">Underfunded</div>
          <div className="text-xl font-bold">{totalShort > 0 ? $$(totalShort) : "✓ Good"}</div>
          <div className="text-xs opacity-60 mt-0.5">{rows.filter(r => r.under).length} properties short</div>
        </div>
      </div>

      {data.unassigned.length > 0 && (
        <div className="mb-5 rounded-2xl border border-violet-200 overflow-hidden">
          <div className="bg-violet-50 px-5 py-3 border-b border-violet-100 flex justify-between items-center">
            <span className="font-bold text-violet-800 text-sm">💰 Unassigned Funds</span>
            <span className="font-bold text-violet-700">{$$(unassignedTotal)}</span>
          </div>
          <div className="bg-white divide-y divide-slate-50">
            {data.unassigned.map(u => (
              <div key={u.id} className="px-5 py-3 flex justify-between items-center text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-slate-700 font-medium">{u.lenderName}</span>
                  <TypeBadge type={u.loanType} small />
                  <span className="text-slate-400 text-xs">{u.date}</span>
                </div>
                <strong className="text-violet-700">{$$(u.amount)}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      {active.length === 0 && <div className="text-center text-slate-400 py-12">No active properties to display.</div>}
      <div className="space-y-4">
        {rows.map(({ prop, loans, funded, needed, short, under }) => (
          <div key={prop.id} className={`rounded-2xl border overflow-hidden ${under ? "border-red-300" : "border-slate-200"}`}>
            <div className={`px-5 py-3 flex justify-between items-center border-b ${under ? "bg-red-50 border-red-100" : "bg-slate-50 border-slate-100"}`}>
              <div>
                <div className="font-bold text-slate-800 text-sm">{prop.address}</div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5 text-xs text-slate-500">
                  <span>Needed: <strong>{$$(needed)}</strong></span>
                  <span className={under ? "text-red-600 font-bold" : "text-emerald-600 font-semibold"}>Funded: {$$(funded)}</span>
                  {under && <span className="text-red-600 font-bold">⚠ Short: {$$(short)}</span>}
                  {!under && funded > 0 && <span className="text-emerald-600">✓ Fully Funded</span>}
                </div>
              </div>
              {under && <div className="bg-red-100 text-red-700 rounded-xl px-3 py-1.5 text-sm font-bold shrink-0">-{$$(short)}</div>}
            </div>
            {loans.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 text-slate-400 font-semibold uppercase tracking-wide text-[10px]">
                      <th className="text-left px-5 py-2.5">Lender</th>
                      <th className="text-left px-3 py-2.5">Type</th>
                      <th className="text-right px-3 py-2.5">Principal</th>
                      <th className="text-right px-3 py-2.5">Rate</th>
                      <th className="text-right px-5 py-2.5">Balance Today</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-slate-50">
                    {loans.map(loan => (
                      <tr key={loan.id}>
                        <td className="px-5 py-3 font-semibold text-slate-800">{loan.lenderName}</td>
                        <td className="px-3 py-3"><TypeBadge type={loan.loanType} small /></td>
                        <td className="px-3 py-3 text-right text-slate-700">{$$(loan.principal)}</td>
                        <td className="px-3 py-3 text-right text-slate-600">{loan.interestRate}%</td>
                        <td className="px-5 py-3 text-right font-bold text-blue-700">{$$(calcBalance(loan))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-5 py-3 text-xs text-slate-400 bg-white">No active loans on this property.</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Lender Dashboard ─────────────────────────────────────────────────────────
function LenderDashboard({ data }) {
  const [view, setView] = useState("loans");
  const allActive = data.properties.flatMap(prop =>
    prop.loans.filter(l => !l.endDate).map(l => ({ ...l, propAddress: prop.address, bal: calcBalance(l), intEarned: calcBalance(l) - (l.principal || 0) }))
  ).sort((a, b) => a.lenderName.localeCompare(b.lenderName));

  const byLender = {};
  allActive.forEach(l => {
    if (!byLender[l.lenderName]) byLender[l.lenderName] = { name: l.lenderName, loans: [], totalPrin: 0, totalBal: 0, totalInt: 0, props: [], types: new Set() };
    const ld = byLender[l.lenderName];
    ld.loans.push(l); ld.totalPrin += l.principal || 0; ld.totalBal += l.bal; ld.totalInt += l.intEarned;
    if (!ld.props.includes(l.propAddress)) ld.props.push(l.propAddress);
    ld.types.add(l.loanType);
  });
  const lenders = Object.values(byLender).map(ld => ({ ...ld, types: [...ld.types], avgRate: ld.loans.reduce((s, l) => s + (l.interestRate || 0), 0) / ld.loans.length })).sort((a, b) => a.name.localeCompare(b.name));
  const privPrin = allActive.filter(l => l.loanType === "private").reduce((s, l) => s + l.principal, 0);
  const hardPrin = allActive.filter(l => l.loanType === "hard").reduce((s, l) => s + l.principal, 0);
  const totalBal = allActive.reduce((s, l) => s + l.bal, 0);

  return (
    <div>
      <h2 className="text-2xl font-bold text-slate-800 mb-6">Lender Dashboard</h2>
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-sky-50 border border-sky-200 rounded-2xl p-4">
          <div className="text-xs font-bold text-sky-500 uppercase tracking-wide mb-1">Private Money</div>
          <div className="font-bold text-sky-800 text-lg">{$$(privPrin)}</div>
          <div className="text-xs text-sky-400">{allActive.filter(l=>l.loanType==="private").length} loans</div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <div className="text-xs font-bold text-amber-500 uppercase tracking-wide mb-1">Hard Money</div>
          <div className="font-bold text-amber-800 text-lg">{$$(hardPrin)}</div>
          <div className="text-xs text-amber-400">{allActive.filter(l=>l.loanType==="hard").length} loans</div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4">
          <div className="text-xs font-bold text-blue-500 uppercase tracking-wide mb-1">Total Balance</div>
          <div className="font-bold text-blue-800 text-lg">{$$(totalBal)}</div>
          <div className="text-xs text-blue-400">{allActive.length} active loans</div>
        </div>
      </div>
      <div className="flex bg-slate-100 rounded-xl p-1 mb-5 gap-1">
        {[["loans","All Individual Loans"],["lenders","Condensed by Lender"]].map(([v, label]) => (
          <button key={v} onClick={() => setView(v)} className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${view === v ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>{label}</button>
        ))}
      </div>
      {view === "loans" && (
        <div>
          <p className="text-xs text-slate-400 mb-3">{allActive.length} active loan{allActive.length !== 1 ? "s" : ""} — one row per loan</p>
          {allActive.length === 0 && <div className="text-center text-slate-400 py-12">No active loans.</div>}
          <div className="rounded-2xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 text-slate-400 font-bold uppercase tracking-wide text-[10px]">
                    {["Lender","Type","Property","Principal","Rate","Start","Balance","Interest","Terms"].map(h => (
                      <th key={h} className={`py-3 px-3 font-semibold whitespace-nowrap ${h==="Lender"||h==="Property"||h==="Terms" ? "text-left" : "text-right"}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-slate-50">
                  {allActive.map(loan => (
                    <tr key={loan.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-3 font-bold text-slate-800 whitespace-nowrap">{loan.lenderName}</td>
                      <td className="py-3 px-3"><TypeBadge type={loan.loanType} small /></td>
                      <td className="py-3 px-3 text-slate-600 max-w-[160px] truncate">{loan.propAddress}</td>
                      <td className="py-3 px-3 text-right text-slate-700 whitespace-nowrap">{$$(loan.principal)}</td>
                      <td className="py-3 px-3 text-right text-slate-600">{loan.interestRate}%</td>
                      <td className="py-3 px-3 text-right text-slate-500 whitespace-nowrap">{loan.startDate}</td>
                      <td className="py-3 px-3 text-right font-bold text-blue-700 whitespace-nowrap">{$$(loan.bal)}</td>
                      <td className="py-3 px-3 text-right text-emerald-600 whitespace-nowrap">{$$(loan.intEarned)}</td>
                      <td className="py-3 px-3 text-slate-400 italic max-w-[120px] truncate">{loan.specialTerms || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {view === "lenders" && (
        <div>
          <p className="text-xs text-slate-400 mb-3">{lenders.length} lender{lenders.length !== 1 ? "s" : ""} — all loans combined</p>
          {lenders.length === 0 && <div className="text-center text-slate-400 py-12">No active lenders.</div>}
          <div className="space-y-3">
            {lenders.map(ld => (
              <div key={ld.name} className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                <div className="px-5 py-4 flex justify-between items-start border-b border-slate-50">
                  <div>
                    <div className="font-bold text-slate-800 text-base">{ld.name}</div>
                    <div className="flex gap-1.5 mt-1.5 flex-wrap">{ld.types.map(t => <TypeBadge key={t} type={t} small />)}</div>
                    <div className="text-xs text-slate-400 mt-1.5">{ld.loans.length} loan{ld.loans.length !== 1 ? "s" : ""} · {ld.props.join(" / ")}</div>
                  </div>
                  <div className="text-right shrink-0 ml-4">
                    <div className="font-bold text-blue-700 text-xl">{$$(ld.totalBal)}</div>
                    <div className="text-xs text-slate-400">current payoff</div>
                  </div>
                </div>
                <div className="grid grid-cols-3 divide-x divide-slate-50 bg-slate-50/50">
                  {[["Total Principal",$$(ld.totalPrin),"text-slate-800"],["Interest Earned",$$(ld.totalInt),"text-emerald-600"],["Avg Rate",ld.avgRate.toFixed(2)+"%","text-slate-800"]].map(([label,val,color]) => (
                    <div key={label} className="px-4 py-3 text-center">
                      <div className="text-[10px] text-slate-400 font-semibold uppercase tracking-wide">{label}</div>
                      <div className={`font-bold text-sm mt-0.5 ${color}`}>{val}</div>
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

// ─── History Page ─────────────────────────────────────────────────────────────
function HistoryPage({ data }) {
  const [lenderFilter, setLenderFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  const rawEvents = [];
  data.properties.forEach(prop => {
    prop.loans.forEach(loan => {
      rawEvents.push({ date: loan.startDate, sortSuffix: "b", lender: loan.lenderName, loanType: loan.loanType, etype: "start", amount: loan.principal || 0, principal: loan.principal || 0, property: prop.address, rate: loan.interestRate || 0, loanId: loan.id });
      const end = loan.endDate || prop.dateSold;
      if (end) {
        const finBal = calcBalance(loan, end);
        const intEarned = finBal - (loan.principal || 0);
        rawEvents.push({ date: end, sortSuffix: "a", lender: loan.lenderName, loanType: loan.loanType, etype: prop.dateSold && !loan.endDate ? "sold" : "closed", amount: finBal, principal: loan.principal || 0, interest: intEarned, property: prop.address, rate: loan.interestRate || 0, loanId: loan.id });
      }
    });
  });
  rawEvents.sort((a, b) => ((a.date || "") + a.sortSuffix).localeCompare((b.date || "") + b.sortSuffix));

  const lenderPending = {};
  const lenderCumLent = {};
  const events = rawEvents.map(ev => {
    lenderPending[ev.lender] = lenderPending[ev.lender] ?? 0;
    lenderCumLent[ev.lender] = lenderCumLent[ev.lender] ?? 0;
    let netChange, prevPayoff;
    if (ev.etype === "start") {
      lenderCumLent[ev.lender] += ev.amount;
      prevPayoff = lenderPending[ev.lender];
      netChange = prevPayoff > 0 ? ev.amount - prevPayoff : ev.amount;
      lenderPending[ev.lender] = 0;
    } else {
      netChange = ev.interest ?? 0;
      lenderPending[ev.lender] += ev.amount;
    }
    return { ...ev, netChange, prevPayoff, cumLent: lenderCumLent[ev.lender] };
  });

  const allLenders = [...new Set(events.map(e => e.lender))].sort();
  const filtered = events.filter(e => (lenderFilter === "all" || e.lender === lenderFilter) && (typeFilter === "all" || e.loanType === typeFilter));

  const etypeConfig = {
    start:  { label: "Loan Started",  icon: "↗", iconBg: "bg-emerald-100 text-emerald-600" },
    closed: { label: "Loan Closed",   icon: "✓", iconBg: "bg-slate-100 text-slate-500" },
    sold:   { label: "Property Sold", icon: "🏡", iconBg: "bg-blue-100 text-blue-600" },
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Transaction History</h2>
          <p className="text-sm text-slate-400 mt-0.5">Auto-generated from all property data</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 font-medium">{filtered.length} events</span>
          <button onClick={exportCSV} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-3 py-1.5 rounded-xl transition-all shadow-sm">Export CSV</button>
          <button onClick={exportJSON} className="bg-slate-700 hover:bg-slate-800 text-white text-xs font-semibold px-3 py-1.5 rounded-xl transition-all shadow-sm">Export JSON</button>
        </div>
      </div>
      <div className="flex gap-2 mb-5">
        <select value={lenderFilter} onChange={e => setLenderFilter(e.target.value)} className="flex-1 min-w-0 border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="all">All Lenders</option>
          {allLenders.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="all">All Types</option>
          <option value="private">Private $</option>
          <option value="hard">Hard $</option>
        </select>
      </div>
      {filtered.length === 0 && (
        <div className="text-center py-20 text-slate-400">
          <div className="text-5xl mb-4">📋</div>
          <p className="font-medium">No transactions yet</p>
          <p className="text-sm mt-1">Add properties with loans to see history here</p>
        </div>
      )}
      <div className="rounded-2xl border border-slate-200 overflow-hidden">
        {filtered.map((ev, i) => {
          const cfg = etypeConfig[ev.etype] ?? etypeConfig.closed;
          const nc = ev.netChange;
          const ncPos = nc >= 0;
          const isRollover = ev.etype === "start" && ev.prevPayoff > 0;
          return (
            <div key={`${ev.loanId}-${ev.etype}-${i}`} className="border-b border-slate-100 last:border-0">
              <div className="flex items-start gap-3 px-4 py-4">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-sm shrink-0 mt-0.5 ${cfg.iconBg}`}>{cfg.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <span className="font-mono text-[10px] text-slate-400 bg-slate-100 rounded px-1.5 py-0.5">{ev.date}</span>
                        <span className={`text-[10px] font-bold uppercase tracking-wide ${cfg.iconBg} rounded-full px-2 py-0.5`}>{cfg.label}</span>
                        <TypeBadge type={ev.loanType} small />
                        {isRollover && <span className="text-[10px] font-semibold text-violet-600 bg-violet-50 rounded-full px-2 py-0.5">Rollover</span>}
                      </div>
                      <div className="font-bold text-slate-800">{ev.lender}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{ev.property} · {ev.rate}%/yr</div>
                      {ev.etype !== "start" && (ev.interest || 0) > 0.01 && <div className="text-xs text-emerald-600 mt-0.5 font-medium">Interest earned: {$$(ev.interest)}</div>}
                      {isRollover && ev.prevPayoff > 0 && <div className="text-xs text-violet-500 mt-0.5">Rolled from: {$$(ev.prevPayoff)}</div>}
                      <div className="text-[10px] text-slate-400 mt-1">Cumulative lent w/ Nexus: {$$(ev.cumLent)}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-bold text-slate-800">{$$(ev.amount)}</div>
                      <div className={`text-sm font-bold mt-0.5 ${ncPos ? "text-emerald-600" : "text-red-500"}`}>{$$s(nc)}</div>
                      <div className="text-[10px] text-slate-400">net change</div>
                    </div>
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

// ─── App Shell ────────────────────────────────────────────────────────────────
const TABS = [
  { id: "Properties", label: "🏠", full: "Properties" },
  { id: "Unassigned", label: "💰", full: "Unassigned" },
  { id: "PropDash",   label: "📊", full: "Prop Dash"  },
  { id: "LenderDash", label: "👥", full: "Lenders"    },
  { id: "History",    label: "📋", full: "History"    },
];

export default function App() {
  const [authMode, setAuthMode] = useState(null); // null | "setup" | "login" | "app"
  const [authError, setAuthError] = useState("");
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("Properties");

  const loadApp = async () => {
    try {
      const d = await getData();
      setData(d);
      setAuthMode("app");
    } catch (err) {
      if (err.message === "unauthorized") { clearToken(); setAuthMode("login"); }
      else setAuthError("Could not load data. Check server connection.");
    }
  };

  useEffect(() => {
    authStatus().then(({ hasUsers }) => {
      if (!hasUsers) { setAuthMode("setup"); return; }
      const token = localStorage.getItem("nexus_token");
      if (token) { loadApp(); } else { setAuthMode("login"); }
    }).catch(() => setAuthError("Cannot reach server."));
  }, []);

  const handleAuthSuccess = () => loadApp();

  const logout = () => { clearToken(); setAuthMode("login"); setData(null); };

  const update = fn => {
    setData(prev => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      saveData(next).catch(err => console.error("Save failed:", err));
      return next;
    });
  };

  if (authMode === null) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-400 text-sm">{authError || "Connecting…"}</div>
      </div>
    );
  }

  if (authMode === "setup" || authMode === "login") {
    return <AuthScreen mode={authMode} onSuccess={handleAuthSuccess} error={authError} setError={setAuthError} />;
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-400 text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200 sticky top-0 z-40" style={{ boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
        <div className="px-5 pt-3 pb-0">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-blue-600 text-white font-bold text-sm flex items-center justify-center shrink-0 shadow-md shadow-blue-200">N</div>
              <div>
                <div className="font-bold text-slate-800 leading-none text-sm">Nexus Homes</div>
                <div className="text-[10px] text-slate-400 mt-0.5 uppercase tracking-wide font-medium">Private Money Tracker</div>
              </div>
            </div>
            <button onClick={logout} className="text-xs text-slate-400 hover:text-slate-600 font-medium transition-colors">Sign Out</button>
          </div>
          <div className="flex overflow-x-auto -mb-px gap-0">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold whitespace-nowrap border-b-2 transition-all shrink-0 ${tab === t.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"}`}>
                <span>{t.label}</span><span>{t.full}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="p-5 max-w-3xl mx-auto pb-12">
        {tab === "Properties"  && <PropertiesPage    data={data} update={update} />}
        {tab === "Unassigned"  && <UnassignedPage    data={data} update={update} />}
        {tab === "PropDash"    && <PropertyDashboard data={data} />}
        {tab === "LenderDash"  && <LenderDashboard   data={data} />}
        {tab === "History"     && <HistoryPage        data={data} />}
      </div>
    </div>
  );
}
