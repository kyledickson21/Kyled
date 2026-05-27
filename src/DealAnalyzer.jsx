import { useState } from 'react'

// ─── Utils ────────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9)
const n = v => parseFloat(v) || 0
const fmt$ = num => {
  if (num == null || isNaN(num)) return '$—'
  const abs = Math.abs(num)
  const s = '$' + abs.toLocaleString('en-US', { maximumFractionDigits: 0 })
  return num < 0 ? `(${s})` : s
}

function calcPMT(principal, annualRate, termYears) {
  if (!principal || principal <= 0) return 0
  if (!annualRate || annualRate === 0) return principal / (termYears * 12)
  const r = annualRate / 100 / 12
  const t = termYears * 12
  return principal * (r * Math.pow(1 + r, t)) / (Math.pow(1 + r, t) - 1)
}

function amortYear(principal, annualRate, termYears, year) {
  if (!principal || principal <= 0) return { interest: 0, principalPaid: 0 }
  const r = annualRate / 100 / 12
  const payment = calcPMT(principal, annualRate, termYears)
  let balance = principal, totalInterest = 0, totalPrincipal = 0
  const start = (year - 1) * 12 + 1
  const end = Math.min(year * 12, termYears * 12)
  for (let m = 1; m <= end; m++) {
    const ip = balance * r
    const pp = Math.min(payment - ip, balance)
    if (m >= start) { totalInterest += ip; totalPrincipal += pp }
    balance -= pp
    if (balance < 0.01) break
  }
  return { interest: totalInterest, principalPaid: totalPrincipal }
}

// ─── UI Primitives ────────────────────────────────────────────────────────────
function Field({ label, value, onChange, prefix, suffix, placeholder, helper, readOnly }) {
  return (
    <div className="mb-3">
      {label && <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">{label}</label>}
      <div className="relative flex items-center">
        {prefix && <span className="absolute left-3 text-sm text-slate-400 dark:text-zinc-500 pointer-events-none z-10 select-none">{prefix}</span>}
        <input
          type="number"
          value={value ?? ''}
          onChange={e => onChange && onChange(e.target.value)}
          onWheel={e => e.target.blur()}
          placeholder={placeholder}
          readOnly={readOnly}
          className={`w-full border rounded-xl py-2.5 text-sm transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 ${prefix ? 'pl-7' : 'pl-4'} ${suffix ? 'pr-10' : 'pr-4'} ${readOnly ? 'bg-slate-50 dark:bg-zinc-800/50 border-slate-100 dark:border-zinc-700/50 text-slate-500 dark:text-zinc-400 cursor-default' : 'bg-white dark:bg-zinc-800 border-slate-200 dark:border-zinc-700 text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600'}`}
        />
        {suffix && <span className="absolute right-3 text-sm text-slate-400 dark:text-zinc-500 pointer-events-none">{suffix}</span>}
      </div>
      {helper && <p className="text-[10px] text-slate-400 dark:text-zinc-500 mt-1">{helper}</p>}
    </div>
  )
}

function Card({ title, children, className = '' }) {
  return (
    <div className={`bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl p-5 ${className}`}>
      {title && <div className="text-[11px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-widest mb-4">{title}</div>}
      {children}
    </div>
  )
}

function Row({ label, value, bold, color, border }) {
  const clr = { green: 'text-emerald-600 dark:text-emerald-400', red: 'text-red-600 dark:text-red-400', blue: 'text-blue-600 dark:text-blue-400', amber: 'text-amber-600 dark:text-amber-400' }
  return (
    <div className={`flex justify-between items-center py-1.5 ${border ? 'border-t border-slate-100 dark:border-zinc-800 mt-1 pt-2' : ''}`}>
      <span className={`text-sm ${bold ? 'font-semibold text-slate-800 dark:text-zinc-100' : 'text-slate-500 dark:text-zinc-400'}`}>{label}</span>
      <span className={`text-sm font-bold tabular-nums ${clr[color] || 'text-slate-800 dark:text-zinc-100'}`}>{value}</span>
    </div>
  )
}

// ─── MAO Calculator ───────────────────────────────────────────────────────────
const defaultMAO = {
  arv: '', closingPct: 9, rehab: '', riskMargin: '', wsFee: '',
  loanAmt: '', loanRate: 14, projectMonths: 5, loanPoints: 0, loanFees: 0,
}

const LOAN_ROWS = [100000, 150000, 200000, 250000, 300000, 350000, 400000, 450000, 500000, 600000, 750000, 1000000]

function MAOCalculator({ state, update }) {
  const s = k => v => update(k, v)
  const arvN = n(state.arv)
  const closingAmt = arvN * n(state.closingPct) / 100
  const rehabN = n(state.rehab)
  const riskN = n(state.riskMargin)
  const wsFeeN = n(state.wsFee)
  const loanAmtN = n(state.loanAmt)
  const rateN = n(state.loanRate)
  const monthsN = n(state.projectMonths)
  const pointsAmt = loanAmtN * n(state.loanPoints) / 100
  const moneyCost = loanAmtN * rateN / 100 / 12 * monthsN + pointsAmt + n(state.loanFees)
  const monthlyInterest = loanAmtN * rateN / 100 / 12
  const mao = arvN - closingAmt - rehabN - moneyCost - riskN - wsFeeN
  const low = mao - 15000
  const high = mao + 15000
  const positive = mao > 0

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card title="Deal Inputs">
          <Field label="ARV (After Repair Value)" value={state.arv} onChange={s('arv')} prefix="$" placeholder="300000"/>
          <Field label="Closing / Commission %" value={state.closingPct} onChange={s('closingPct')} suffix="%" placeholder="9"/>
          <div className="flex justify-between items-center bg-slate-50 dark:bg-zinc-800 rounded-xl px-4 py-2.5 mb-3">
            <span className="text-xs text-slate-400 dark:text-zinc-500">Closing Amount</span>
            <span className="font-bold text-slate-700 dark:text-zinc-200 tabular-nums text-sm">{fmt$(closingAmt)}</span>
          </div>
          <Field label="Rehab Estimate" value={state.rehab} onChange={s('rehab')} prefix="$" placeholder="100000"/>
          <Field label="Risk / Profit Margin" value={state.riskMargin} onChange={s('riskMargin')} prefix="$" placeholder="80000"/>
          <Field label="Wholesale Fee (W/S)" value={state.wsFee} onChange={s('wsFee')} prefix="$" placeholder="0"/>
        </Card>

        <Card title="Loan / Money Details">
          <Field label="Loan Amount" value={state.loanAmt} onChange={s('loanAmt')} prefix="$" placeholder="200000" helper="Purchase + Rehab typically"/>
          <Field label="Annual Interest Rate" value={state.loanRate} onChange={s('loanRate')} suffix="%" placeholder="14"/>
          <Field label="Project Duration" value={state.projectMonths} onChange={s('projectMonths')} suffix="mo" placeholder="5"/>
          <Field label="Lender Points" value={state.loanPoints} onChange={s('loanPoints')} suffix="%" placeholder="0"/>
          <Field label="Lender Fees" value={state.loanFees} onChange={s('loanFees')} prefix="$" placeholder="0"/>
          <div className="flex justify-between items-center bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-2.5 mt-1">
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">Total Money Cost</span>
            <span className="font-bold text-amber-700 dark:text-amber-400 tabular-nums text-sm">{fmt$(moneyCost)}</span>
          </div>
          <div className="flex justify-between items-center bg-slate-50 dark:bg-zinc-800 rounded-xl px-4 py-2.5 mt-2">
            <span className="text-xs text-slate-400 dark:text-zinc-500">Monthly Interest</span>
            <span className="font-bold text-slate-700 dark:text-zinc-200 tabular-nums text-sm">{fmt$(monthlyInterest)}/mo</span>
          </div>
        </Card>
      </div>

      {/* Offer Output */}
      <div className={`rounded-2xl p-6 ${positive ? 'bg-gradient-to-br from-slate-900 to-slate-700 dark:from-zinc-800 dark:to-zinc-900' : 'bg-gradient-to-br from-red-900 to-red-700'}`}>
        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">Offer Output</div>
        <div className="grid grid-cols-3 gap-4 text-center mb-5">
          {[['Low', low], ['Your Offer', mao], ['High', high]].map(([label, val], i) => (
            <div key={label}>
              <div className="text-[10px] font-semibold text-white/40 uppercase tracking-widest mb-1">{label}</div>
              <div className={`font-black tabular-nums ${i === 1 ? 'text-3xl text-white' : 'text-xl text-white/80'} ${val <= 0 ? '!text-red-300' : ''}`}>{fmt$(val)}</div>
            </div>
          ))}
        </div>
        <div className="border-t border-white/10 pt-4 grid grid-cols-2 gap-x-8 gap-y-1.5">
          {[['ARV', fmt$(arvN)], ['− Closing', `(${fmt$(closingAmt)})`], ['− Rehab', `(${fmt$(rehabN)})`], ['− Money Cost', `(${fmt$(moneyCost)})`], ['− Risk/Profit', `(${fmt$(riskN)})`], ['− W/S Fee', `(${fmt$(wsFeeN)})`]].map(([l, v]) => (
            <div key={l} className="flex justify-between text-[11px]">
              <span className="text-white/40">{l}</span>
              <span className="font-semibold text-white tabular-nums">{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Quick Money Cost Table */}
      <Card title="Quick Money Cost Reference — Monthly Interest">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 dark:border-zinc-800">
                <th className="pb-2 pr-4 text-left text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">Loan Amount</th>
                {[12, 14, 16].map(r => <th key={r} className="pb-2 px-2 text-right text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">{r}%</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/50">
              {LOAN_ROWS.map(l => (
                <tr key={l} className="hover:bg-slate-50 dark:hover:bg-zinc-800/30 transition-colors">
                  <td className="py-1.5 pr-4 font-medium text-slate-600 dark:text-zinc-300 tabular-nums">{l >= 1000000 ? '$1M' : `$${l / 1000}K`}</td>
                  {[12, 14, 16].map(r => (
                    <td key={r} className="py-1.5 px-2 text-right tabular-nums text-slate-500 dark:text-zinc-400">${Math.round(l * r / 100 / 12).toLocaleString()}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// ─── Rental Analysis ──────────────────────────────────────────────────────────
const defaultRental = {
  units: [
    { beds: 3, baths: 1, currentRent: '', marketRent: 2000 },
    { beds: '', baths: '', currentRent: '', marketRent: '' },
    { beds: '', baths: '', currentRent: '', marketRent: '' },
    { beds: '', baths: '', currentRent: '', marketRent: '' },
  ],
  taxPerYr: 2400, insurancePerMo: 100, gasElecPerMo: 0, waterPerMo: 0, hoaPerMo: 0,
  mgmtPct: 8, vacancyPct: 5, maintPct: 10, reservePct: 3,
  salePrice: 200000, downPct: 0, interestRate: 7, loanTerm: 30, closingCosts: 0,
  rehabCosts: 0, rentGrowthRate: 2, appreciationRate: 3,
}

function RentalAnalysis({ state, update }) {
  const s = k => v => update(k, v)
  const su = (i, k) => v => {
    const units = [...state.units]
    units[i] = { ...units[i], [k]: v }
    update('units', units)
  }

  const grossMarket = state.units.reduce((sum, u) => sum + n(u.marketRent), 0)
  const grossCurrent = state.units.reduce((sum, u) => sum + n(u.currentRent), 0)

  const salePriceN = n(state.salePrice)
  const downAmt = salePriceN * n(state.downPct) / 100
  const principal = salePriceN - downAmt
  const monthlyMortgage = calcPMT(principal, n(state.interestRate), n(state.loanTerm))
  const annualMortgage = monthlyMortgage * 12

  const calcNOI = (rents) => {
    const vacancy = rents * n(state.vacancyPct) / 100
    const mgmt = rents * n(state.mgmtPct) / 100
    const maint = rents * n(state.maintPct) / 100
    const reserves = rents * n(state.reservePct) / 100
    const taxes = n(state.taxPerYr) / 12
    const insurance = n(state.insurancePerMo)
    const utilities = n(state.gasElecPerMo) + n(state.waterPerMo) + n(state.hoaPerMo)
    const totalOpEx = vacancy + mgmt + maint + reserves + taxes + insurance + utilities
    return { noi: rents - totalOpEx, totalOpEx, vacancy, mgmt, maint, reserves, taxes, insurance, utilities }
  }

  const proForma = calcNOI(grossCurrent)
  const stabilized = calcNOI(grossMarket)
  const proFormaNetCF = proForma.noi * 12 - annualMortgage
  const stabilizedNetCF = stabilized.noi * 12 - annualMortgage
  const proFormaDCR = annualMortgage > 0 ? (proForma.noi * 12 / annualMortgage).toFixed(2) : '—'
  const stabilizedDCR = annualMortgage > 0 ? (stabilized.noi * 12 / annualMortgage).toFixed(2) : '—'

  const buildingValue = salePriceN * 0.8
  const annualDepreciation = buildingValue / 27.5
  const growthRate = n(state.rentGrowthRate) / 100
  const appRate = n(state.appreciationRate) / 100

  const NOISummary = ({ title, data, monthlyMortgage, annualNetCF, dcr }) => (
    <Card title={title}>
      <Row label="Gross Rents/mo" value={fmt$(data.noi + data.totalOpEx) + '/mo'}/>
      <Row label="− Vacancy" value={`(${fmt$(data.vacancy)})`}/>
      <Row label="− Management" value={`(${fmt$(data.mgmt)})`}/>
      <Row label="− Maintenance" value={`(${fmt$(data.maint)})`}/>
      <Row label="− Reserves" value={`(${fmt$(data.reserves)})`}/>
      <Row label="− Taxes" value={`(${fmt$(data.taxes)})`}/>
      <Row label="− Insurance" value={`(${fmt$(data.insurance)})`}/>
      <Row label="Monthly NOI" value={fmt$(data.noi)} bold border color={data.noi > 0 ? 'green' : 'red'}/>
      <Row label="− Mortgage" value={`(${fmt$(monthlyMortgage)})`}/>
      <Row label="Monthly Net" value={fmt$(data.noi - monthlyMortgage)} bold color={data.noi - monthlyMortgage > 0 ? 'green' : 'red'}/>
      <div className="mt-3 pt-3 border-t border-slate-100 dark:border-zinc-800 grid grid-cols-2 gap-2">
        <div className="text-center bg-slate-50 dark:bg-zinc-800 rounded-xl py-2.5">
          <div className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold mb-1">Annual Net</div>
          <div className={`font-bold text-sm tabular-nums ${annualNetCF >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{fmt$(annualNetCF)}</div>
        </div>
        <div className="text-center bg-slate-50 dark:bg-zinc-800 rounded-xl py-2.5">
          <div className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold mb-1">DCR</div>
          <div className={`font-bold text-sm ${Number(dcr) >= 1 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{dcr}</div>
        </div>
      </div>
    </Card>
  )

  return (
    <div className="space-y-4">
      <Card title="Rental Units">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 dark:border-zinc-800">
                {['#', 'Beds', 'Baths', 'Current Rent/Mo', 'Market Rent/Mo'].map(h => (
                  <th key={h} className="pb-2 pr-3 text-left text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.units.map((u, i) => (
                <tr key={i} className="border-b border-slate-50 dark:border-zinc-800/50 last:border-0">
                  <td className="py-2 pr-3 text-slate-400 dark:text-zinc-500 font-semibold text-xs">{i + 1}</td>
                  <td className="py-1 pr-2"><input type="number" value={u.beds ?? ''} onChange={e => su(i, 'beds')(e.target.value)} onWheel={e => e.target.blur()} placeholder="3" className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-2 py-1.5 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"/></td>
                  <td className="py-1 pr-2"><input type="number" value={u.baths ?? ''} onChange={e => su(i, 'baths')(e.target.value)} onWheel={e => e.target.blur()} placeholder="1" className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-2 py-1.5 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"/></td>
                  <td className="py-1 pr-2">
                    <div className="relative"><span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">$</span>
                      <input type="number" value={u.currentRent ?? ''} onChange={e => su(i, 'currentRent')(e.target.value)} onWheel={e => e.target.blur()} placeholder="0" className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg pl-4 pr-2 py-1.5 text-xs text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"/>
                    </div>
                  </td>
                  <td className="py-1">
                    <div className="relative"><span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">$</span>
                      <input type="number" value={u.marketRent ?? ''} onChange={e => su(i, 'marketRent')(e.target.value)} onWheel={e => e.target.blur()} placeholder="2000" className="w-full border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 rounded-lg pl-4 pr-2 py-1.5 text-xs font-semibold text-blue-900 dark:text-blue-200 focus:outline-none focus:ring-1 focus:ring-blue-500"/>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 dark:border-zinc-700">
                <td colSpan={3} className="pt-2 text-xs font-bold text-slate-600 dark:text-zinc-300">Total</td>
                <td className="pt-2 pr-2 text-xs font-bold text-slate-700 dark:text-zinc-200 tabular-nums">{fmt$(grossCurrent)}/mo</td>
                <td className="pt-2 text-xs font-bold text-blue-700 dark:text-blue-400 tabular-nums">{fmt$(grossMarket)}/mo</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card title="Operating Expenses">
          <Field label="Property Tax / Year" value={state.taxPerYr} onChange={s('taxPerYr')} prefix="$" placeholder="2400"/>
          <Field label="Insurance / Month" value={state.insurancePerMo} onChange={s('insurancePerMo')} prefix="$" placeholder="100"/>
          <Field label="Gas & Electric / Month" value={state.gasElecPerMo} onChange={s('gasElecPerMo')} prefix="$" placeholder="0"/>
          <Field label="Water & Sewer / Month" value={state.waterPerMo} onChange={s('waterPerMo')} prefix="$" placeholder="0"/>
          <Field label="HOA / Month" value={state.hoaPerMo} onChange={s('hoaPerMo')} prefix="$" placeholder="0"/>
          <Field label="Management %" value={state.mgmtPct} onChange={s('mgmtPct')} suffix="%" placeholder="8"/>
          <Field label="Vacancy %" value={state.vacancyPct} onChange={s('vacancyPct')} suffix="%" placeholder="5"/>
          <Field label="Maintenance %" value={state.maintPct} onChange={s('maintPct')} suffix="%" placeholder="10"/>
          <Field label="Cash Reserves %" value={state.reservePct} onChange={s('reservePct')} suffix="%" placeholder="3"/>
        </Card>

        <div className="space-y-4">
          <Card title="Mortgage / Financing">
            <Field label="Sale / Purchase Price" value={state.salePrice} onChange={s('salePrice')} prefix="$" placeholder="200000"/>
            <Field label="Down Payment %" value={state.downPct} onChange={s('downPct')} suffix="%" placeholder="0"/>
            <div className="flex justify-between items-center bg-slate-50 dark:bg-zinc-800 rounded-xl px-4 py-2 mb-3">
              <span className="text-xs text-slate-400 dark:text-zinc-500">Principal</span>
              <span className="font-bold text-sm text-slate-700 dark:text-zinc-200 tabular-nums">{fmt$(principal)}</span>
            </div>
            <Field label="Interest Rate" value={state.interestRate} onChange={s('interestRate')} suffix="%" placeholder="7"/>
            <Field label="Loan Term" value={state.loanTerm} onChange={s('loanTerm')} suffix="yrs" placeholder="30"/>
            <Field label="Purchase Closing Costs" value={state.closingCosts} onChange={s('closingCosts')} prefix="$" placeholder="0"/>
            <Field label="Rehab / Remodel Costs" value={state.rehabCosts} onChange={s('rehabCosts')} prefix="$" placeholder="0"/>
            <div className="flex justify-between items-center bg-slate-900 dark:bg-zinc-700 rounded-xl px-4 py-2.5">
              <span className="text-xs font-semibold text-slate-300">Monthly Mortgage</span>
              <span className="font-bold text-white tabular-nums">{fmt$(monthlyMortgage)}/mo</span>
            </div>
          </Card>
          <Card title="Growth Assumptions">
            <Field label="Annual Rent Growth %" value={state.rentGrowthRate} onChange={s('rentGrowthRate')} suffix="%" placeholder="2"/>
            <Field label="Annual Appreciation %" value={state.appreciationRate} onChange={s('appreciationRate')} suffix="%" placeholder="3"/>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <NOISummary title="Pro Forma (Current Rents)" data={proForma} monthlyMortgage={monthlyMortgage} annualNetCF={proFormaNetCF} dcr={proFormaDCR}/>
        <NOISummary title="Stabilized (Market Rents)" data={stabilized} monthlyMortgage={monthlyMortgage} annualNetCF={stabilizedNetCF} dcr={stabilizedDCR}/>
      </div>

      {/* 5-Year Projections */}
      <Card title="5-Year Projections (Stabilized)">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 dark:border-zinc-800">
                {['Year', 'Market Rent', 'Annual NOI', 'Debt Paydown', 'Appreciation', 'Tax Deductions'].map(h => (
                  <th key={h} className="pb-2 pr-3 text-right first:text-left text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/50">
              {[1, 2, 3, 4, 5].map(yr => {
                const rent = grossMarket * Math.pow(1 + growthRate, yr - 1)
                const yNOI = calcNOI(rent).noi * 12
                const { interest, principalPaid } = amortYear(principal, n(state.interestRate), n(state.loanTerm), yr)
                const appGain = salePriceN * (Math.pow(1 + appRate, yr) - Math.pow(1 + appRate, yr - 1))
                const totalDeductions = annualDepreciation + interest
                return (
                  <tr key={yr} className="hover:bg-slate-50 dark:hover:bg-zinc-800/30 transition-colors">
                    <td className="py-2 pr-3 font-bold text-slate-600 dark:text-zinc-300">Yr {yr}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-slate-600 dark:text-zinc-300">{fmt$(rent)}/mo</td>
                    <td className={`py-2 pr-3 text-right tabular-nums font-semibold ${yNOI >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{fmt$(yNOI)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-blue-600 dark:text-blue-400">{fmt$(principalPaid)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-violet-600 dark:text-violet-400">{fmt$(appGain)}</td>
                    <td className="py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">{fmt$(totalDeductions)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-slate-400 dark:text-zinc-500 mt-3">Depreciation: {fmt$(annualDepreciation)}/yr (80% of purchase / 27.5 yrs straight-line)</p>
      </Card>
    </div>
  )
}

// ─── Fix & Flip Calculator ────────────────────────────────────────────────────
const defaultFlip = {
  arv: '', purchasePrice: '', repairCosts: '', projectMonths: 4,
  loanAmt: '', loanRate: 14, loanPoints: 0, loanFees: 0,
  commissionPct: 0, sellingClosingCosts: 0, closingCreditBuyer: 0,
  purchaseClosingCosts: 0, appraisalFee: 0, inspectionFee: 0, otherPurchaseFee: 0,
  propTaxHolding: 0, insuranceHolding: 0, electricHolding: 0,
  gasHolding: 0, waterHolding: 0, hoaHolding: 0, otherHolding: 0,
}

function FixFlipCalculator({ state, update }) {
  const s = k => v => update(k, v)
  const arvN = n(state.arv)
  const purchaseN = n(state.purchasePrice)
  const repairN = n(state.repairCosts)
  const monthsN = n(state.projectMonths)
  const loanAmtN = n(state.loanAmt) || (purchaseN + repairN)
  const loanRateN = n(state.loanRate)
  const lenderInterest = loanAmtN * loanRateN / 100 / 12 * monthsN
  const lenderPoints = loanAmtN * n(state.loanPoints) / 100
  const commissionAmt = arvN * n(state.commissionPct) / 100
  const purchaseCosts = n(state.purchaseClosingCosts) + n(state.appraisalFee) + n(state.inspectionFee) + n(state.otherPurchaseFee)
  const sellingCosts = commissionAmt + n(state.sellingClosingCosts) + n(state.closingCreditBuyer)
  const holdingCosts = n(state.propTaxHolding) + n(state.insuranceHolding) + n(state.electricHolding) + n(state.gasHolding) + n(state.waterHolding) + n(state.hoaHolding) + n(state.otherHolding)
  const financingCosts = lenderInterest + lenderPoints + n(state.loanFees)
  const totalCosts = purchaseN + repairN + purchaseCosts + sellingCosts + holdingCosts + financingCosts
  const estProfit = arvN - totalCosts
  const roi = (purchaseN + repairN) > 0 ? (estProfit / (purchaseN + repairN) * 100).toFixed(1) : '—'

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card title="Deal Info">
          <Field label="Resale Price (ARV)" value={state.arv} onChange={s('arv')} prefix="$" placeholder="220000"/>
          <Field label="Purchase Price" value={state.purchasePrice} onChange={s('purchasePrice')} prefix="$" placeholder="83500"/>
          <Field label="Repair Costs" value={state.repairCosts} onChange={s('repairCosts')} prefix="$" placeholder="45000"/>
          <Field label="Project Duration" value={state.projectMonths} onChange={s('projectMonths')} suffix="mo" placeholder="4"/>
        </Card>
        <Card title="Financing">
          <Field label="Loan Amount" value={state.loanAmt} onChange={s('loanAmt')} prefix="$" placeholder="Auto" helper="Defaults to Purchase + Repair if blank"/>
          <Field label="Interest Rate" value={state.loanRate} onChange={s('loanRate')} suffix="%" placeholder="14"/>
          <Field label="Lender Points" value={state.loanPoints} onChange={s('loanPoints')} suffix="%" placeholder="0"/>
          <Field label="Lender Fees" value={state.loanFees} onChange={s('loanFees')} prefix="$" placeholder="0"/>
          <div className="flex justify-between items-center bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-2.5">
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">Total Interest Cost</span>
            <span className="font-bold text-amber-700 dark:text-amber-400 tabular-nums">{fmt$(lenderInterest)}</span>
          </div>
        </Card>
        <Card title="Selling Costs">
          <Field label="Commission %" value={state.commissionPct} onChange={s('commissionPct')} suffix="%" placeholder="6"/>
          <div className="flex justify-between items-center bg-slate-50 dark:bg-zinc-800 rounded-xl px-4 py-2 mb-3">
            <span className="text-xs text-slate-400">Commission Amount</span>
            <span className="font-bold text-sm text-slate-700 dark:text-zinc-200 tabular-nums">{fmt$(commissionAmt)}</span>
          </div>
          <Field label="Closing Costs" value={state.sellingClosingCosts} onChange={s('sellingClosingCosts')} prefix="$" placeholder="0"/>
          <Field label="Closing Credit to Buyer" value={state.closingCreditBuyer} onChange={s('closingCreditBuyer')} prefix="$" placeholder="0"/>
        </Card>
        <Card title="Holding Costs (Total for Project)">
          <Field label="Property Taxes" value={state.propTaxHolding} onChange={s('propTaxHolding')} prefix="$" placeholder="0"/>
          <Field label="Insurance" value={state.insuranceHolding} onChange={s('insuranceHolding')} prefix="$" placeholder="0"/>
          <Field label="Electricity" value={state.electricHolding} onChange={s('electricHolding')} prefix="$" placeholder="0"/>
          <Field label="Gas" value={state.gasHolding} onChange={s('gasHolding')} prefix="$" placeholder="0"/>
          <Field label="Water / Sewer" value={state.waterHolding} onChange={s('waterHolding')} prefix="$" placeholder="0"/>
          <Field label="HOA" value={state.hoaHolding} onChange={s('hoaHolding')} prefix="$" placeholder="0"/>
          <Field label="Other" value={state.otherHolding} onChange={s('otherHolding')} prefix="$" placeholder="0"/>
        </Card>
      </div>

      <Card title="Purchase Costs">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Closing Costs" value={state.purchaseClosingCosts} onChange={s('purchaseClosingCosts')} prefix="$" placeholder="0"/>
          <Field label="Appraisal Fee" value={state.appraisalFee} onChange={s('appraisalFee')} prefix="$" placeholder="0"/>
          <Field label="Home Inspection" value={state.inspectionFee} onChange={s('inspectionFee')} prefix="$" placeholder="0"/>
          <Field label="Other Fees" value={state.otherPurchaseFee} onChange={s('otherPurchaseFee')} prefix="$" placeholder="0"/>
        </div>
      </Card>

      {/* Profit Summary */}
      <div className={`rounded-2xl p-6 ${estProfit > 0 ? 'bg-gradient-to-br from-emerald-900 to-emerald-700' : 'bg-gradient-to-br from-red-900 to-red-700'}`}>
        <div className="text-[10px] font-bold text-white/50 uppercase tracking-widest mb-4">Profit Summary</div>
        <div className="grid grid-cols-3 gap-4 text-center mb-5">
          {[['Total Costs', fmt$(totalCosts)], ['Est. Profit', fmt$(estProfit)], ['ROI', `${roi}%`]].map(([label, val], i) => (
            <div key={label}>
              <div className="text-[10px] font-semibold text-white/40 uppercase tracking-widest mb-1">{label}</div>
              <div className={`font-black tabular-nums text-white ${i === 1 ? 'text-3xl' : 'text-xl'}`}>{val}</div>
            </div>
          ))}
        </div>
        <div className="border-t border-white/10 pt-4 grid grid-cols-2 gap-x-8 gap-y-1.5">
          {[['ARV', fmt$(arvN)], ['− Purchase', `(${fmt$(purchaseN)})`], ['− Repairs', `(${fmt$(repairN)})`], ['− Financing', `(${fmt$(financingCosts)})`], ['− Selling Costs', `(${fmt$(sellingCosts)})`], ['− Holding Costs', `(${fmt$(holdingCosts)})`], ['− Purchase Costs', `(${fmt$(purchaseCosts)})`]].map(([l, v]) => (
            <div key={l} className="flex justify-between text-[11px]">
              <span className="text-white/40">{l}</span>
              <span className="font-semibold text-white tabular-nums">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Renovation Budget ────────────────────────────────────────────────────────
const makeDefaultRenoItems = () => ({
  exterior: [
    { label: 'Roof', qty: 1, cost: 15000, enabled: false },
    { label: 'Siding', qty: 1, cost: 20000, enabled: false },
    { label: 'Windows (Exterior)', qty: 1, cost: 21250, enabled: false },
    { label: 'Doors', qty: 1, cost: 2500, enabled: false },
  ],
  utilities: [
    { label: 'Gas Line / Meter', qty: 1, cost: 5000, enabled: false },
    { label: 'Electrical Service', qty: 1, cost: 6000, enabled: false },
    { label: 'Water / Plumbing Main', qty: 1, cost: 4000, enabled: false },
  ],
  kitchen: [
    { label: 'Countertops', qty: 1, cost: 8000, enabled: false },
    { label: 'Cabinets', qty: 1, cost: 16000, enabled: false },
    { label: 'Kitchen Other', qty: 1, cost: 12000, enabled: false },
  ],
  bathroom: [
    { label: 'Shower / Tub', qty: 1, cost: 8000, enabled: false },
    { label: 'Vanity', qty: 1, cost: 800, enabled: false },
    { label: 'Toilet', qty: 1, cost: 600, enabled: false },
    { label: 'Bath Other', qty: 1, cost: 600, enabled: false },
  ],
  interior: [
    { label: 'Lights / Fixtures', qty: 1, cost: 4000, enabled: false },
    { label: 'Flooring', qty: 1, cost: 12000, enabled: false },
    { label: 'Interior Windows', qty: 1, cost: 3000, enabled: false },
    { label: 'Drywall', qty: 1, cost: 20000, enabled: false },
    { label: 'Paint (Interior)', qty: 1, cost: 6000, enabled: false },
    { label: 'Electrical (Full)', qty: 1, cost: 24000, enabled: false },
    { label: 'Plumbing (Full)', qty: 1, cost: 16000, enabled: false },
    { label: 'Water Heater', qty: 1, cost: 2000, enabled: false },
    { label: 'HVAC', qty: 1, cost: 20000, enabled: false },
  ],
  soft: [
    { label: 'Holding Costs', qty: 1, cost: 9000, enabled: false },
    { label: 'Soft Costs', qty: 1, cost: 5000, enabled: false },
    { label: 'Permits', qty: 1, cost: 2500, enabled: false },
  ],
})

const RENO_CATS = [
  { key: 'exterior', label: 'Exterior' },
  { key: 'utilities', label: 'Utilities / MEPs' },
  { key: 'kitchen', label: 'Kitchen' },
  { key: 'bathroom', label: 'Bathroom' },
  { key: 'interior', label: 'Interior / Other' },
  { key: 'soft', label: 'Soft & Holding Costs' },
]

function RenovationBudget({ state, update }) {
  const items = state.items || makeDefaultRenoItems()
  const setItems = v => update('items', v)

  const updateItem = (cat, idx, key, val) => {
    setItems({ ...items, [cat]: items[cat].map((item, i) => i === idx ? { ...item, [key]: val } : item) })
  }
  const toggleItem = (cat, idx) => updateItem(cat, idx, 'enabled', !items[cat][idx].enabled)

  const catTotals = {}
  let grandTotal = 0
  RENO_CATS.forEach(({ key }) => {
    const t = (items[key] || []).filter(i => i.enabled).reduce((s, i) => s + n(i.qty) * n(i.cost), 0)
    catTotals[key] = t
    grandTotal += t
  })

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-slate-900 to-slate-700 dark:from-zinc-800 dark:to-zinc-900 rounded-2xl p-5 flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Total Renovation Budget</div>
          <div className="text-4xl font-black text-white tabular-nums">{fmt$(grandTotal)}</div>
          <div className="text-xs text-slate-400 mt-1">Check items below to include them</div>
        </div>
        <div className="text-right shrink-0">
          {RENO_CATS.filter(c => catTotals[c.key] > 0).map(c => (
            <div key={c.key} className="flex justify-between gap-4 text-xs text-white/60 mb-0.5">
              <span>{c.label}</span>
              <span className="font-semibold tabular-nums">{fmt$(catTotals[c.key])}</span>
            </div>
          ))}
        </div>
      </div>

      {RENO_CATS.map(({ key, label }) => {
        const catItems = items[key] || []
        const allOn = catItems.every(i => i.enabled)
        return (
          <Card key={key} title={`${label}  —  ${fmt$(catTotals[key])}`}>
            <div className="flex items-center justify-between mb-3">
              <button onClick={() => setItems({ ...items, [key]: catItems.map(i => ({ ...i, enabled: !allOn })) })}
                className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                {allOn ? 'Uncheck all' : 'Check all'}
              </button>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 dark:border-zinc-800">
                  <th className="pb-2 w-6"></th>
                  <th className="pb-2 text-left text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Item</th>
                  <th className="pb-2 px-2 text-right text-[10px] font-semibold text-slate-400 uppercase tracking-wider w-16">Qty</th>
                  <th className="pb-2 px-2 text-right text-[10px] font-semibold text-slate-400 uppercase tracking-wider w-28">Unit Cost</th>
                  <th className="pb-2 text-right text-[10px] font-semibold text-slate-400 uppercase tracking-wider w-24">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/50">
                {catItems.map((item, idx) => {
                  const total = item.enabled ? n(item.qty) * n(item.cost) : 0
                  return (
                    <tr key={idx} className={`transition-colors ${item.enabled ? '' : 'opacity-40'}`}>
                      <td className="py-2 pr-2">
                        <input type="checkbox" checked={item.enabled} onChange={() => toggleItem(key, idx)} className="rounded accent-blue-600 cursor-pointer w-3.5 h-3.5"/>
                      </td>
                      <td className="py-2 pr-2 font-medium text-slate-700 dark:text-zinc-200">{item.label}</td>
                      <td className="py-1 px-2">
                        <input type="number" value={item.qty} onChange={e => updateItem(key, idx, 'qty', e.target.value)} onWheel={e => e.target.blur()} min="0"
                          className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg px-2 py-1 text-xs text-right text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"/>
                      </td>
                      <td className="py-1 px-2">
                        <div className="relative">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">$</span>
                          <input type="number" value={item.cost} onChange={e => updateItem(key, idx, 'cost', e.target.value)} onWheel={e => e.target.blur()}
                            className="w-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 rounded-lg pl-4 pr-2 py-1 text-xs text-right text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"/>
                        </div>
                      </td>
                      <td className={`py-2 text-right font-bold tabular-nums ${item.enabled ? 'text-slate-800 dark:text-zinc-100' : 'text-slate-300 dark:text-zinc-600'}`}>
                        {fmt$(total)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 dark:border-zinc-700">
                  <td colSpan={4} className="pt-2 font-bold text-slate-600 dark:text-zinc-300">{label} Subtotal</td>
                  <td className="pt-2 text-right font-bold tabular-nums text-slate-900 dark:text-zinc-100 text-sm">{fmt$(catTotals[key])}</td>
                </tr>
              </tfoot>
            </table>
          </Card>
        )
      })}
    </div>
  )
}

// ─── Reference Tables ─────────────────────────────────────────────────────────
function ReferenceTables() {
  const REHAB_BY_SQFT = [
    { label: 'Light Cosmetic', desc: 'Paint, floors, some bath/kitchen items', costs: [20000, 30000, 40000] },
    { label: 'Moderate Rehab', desc: 'Light Cosmetic + full bath/kitchen + Big Ticket Items / MEPS', costs: [50000, 65000, 80000] },
    { label: 'Full Rehab', desc: 'Full guts / full exterior / Windows, roof, HVAC', costs: [90000, 120000, 150000] },
  ]
  const REHAB_BY_YEAR = [
    { range: '$0 – $15k', costs: [30000, 25000, 25000] },
    { range: '$15k – $40k', costs: [40000, 30000, 30000] },
    { range: '$40k – $70k', costs: [50000, 40000, 35000] },
    { range: '$70k – $110k', costs: [65000, 55000, 40000] },
    { range: '$110k – $150k', costs: [80000, 70000, 60000] },
    { range: '$150k+', costs: [100000, 80000, 70000] },
  ]

  return (
    <div className="space-y-4">
      <Card title="Quick Money Cost — Monthly Interest by Loan Amount">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 dark:border-zinc-800">
                <th className="pb-2 pr-4 text-left text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">Loan Amount</th>
                {[12, 14, 16].map(r => <th key={r} className="pb-2 px-3 text-right text-[10px] font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">{r}% / yr</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/50">
              {LOAN_ROWS.map(l => (
                <tr key={l} className="hover:bg-slate-50 dark:hover:bg-zinc-800/30">
                  <td className="py-2 pr-4 font-semibold text-slate-700 dark:text-zinc-200 tabular-nums">{l >= 1000000 ? '$1,000,000' : `$${l / 1000}K`}</td>
                  {[12, 14, 16].map(r => (
                    <td key={r} className="py-2 px-3 text-right tabular-nums text-slate-600 dark:text-zinc-300">${Math.round(l * r / 100 / 12).toLocaleString()}/mo</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Rehab Estimation by Square Footage">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 dark:border-zinc-800">
                <th className="pb-2 pr-4 text-left text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Rehab Level</th>
                {['0–1,200 sq ft', '1,200–2,000 sq ft', '2,000+ sq ft'].map(h => (
                  <th key={h} className="pb-2 px-3 text-right text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/50">
              {REHAB_BY_SQFT.map(row => (
                <tr key={row.label} className="hover:bg-slate-50 dark:hover:bg-zinc-800/30">
                  <td className="py-3 pr-4">
                    <div className="font-semibold text-slate-700 dark:text-zinc-200">{row.label}</div>
                    <div className="text-[10px] text-slate-400 dark:text-zinc-500 mt-0.5 max-w-[160px]">{row.desc}</div>
                  </td>
                  {row.costs.map((c, i) => (
                    <td key={i} className="py-3 px-3 text-right font-bold tabular-nums text-slate-700 dark:text-zinc-200">{fmt$(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Final Rehab Add-On by Year Built (add to contractor estimate)">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 dark:border-zinc-800">
                <th className="pb-2 pr-4 text-left text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Contractor Bid Range</th>
                {['1800–1940', '1940–1970', '1970+'].map(h => (
                  <th key={h} className="pb-2 px-3 text-right text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-zinc-800/50">
              {REHAB_BY_YEAR.map(row => (
                <tr key={row.range} className="hover:bg-slate-50 dark:hover:bg-zinc-800/30">
                  <td className="py-2 pr-4 font-medium text-slate-700 dark:text-zinc-200">{row.range}</td>
                  {row.costs.map((c, i) => (
                    <td key={i} className="py-2 px-3 text-right tabular-nums text-slate-600 dark:text-zinc-300">{fmt$(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-slate-400 dark:text-zinc-500 mt-3">Add to contractor's estimate based on year built to account for hidden costs in older properties.</p>
      </Card>
    </div>
  )
}

// ─── Deal History ─────────────────────────────────────────────────────────────
function DealHistory({ deals, onLoad, onDelete }) {
  if (deals.length === 0) {
    return (
      <div className="text-center py-20 text-slate-400 dark:text-zinc-500">
        <div className="text-5xl mb-4">📋</div>
        <div className="font-semibold text-base">No saved analyses yet</div>
        <div className="text-sm mt-1">Hit "Save Analysis" above to save the current deal</div>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {[...deals].reverse().map(deal => (
        <div key={deal.id} className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl p-5 hover:shadow-md dark:shadow-none transition-shadow">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-bold text-slate-900 dark:text-zinc-100 mb-0.5">{deal.address}</div>
              <div className="text-xs text-slate-400 dark:text-zinc-500 mb-3">
                {new Date(deal.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
              <div className="flex flex-wrap gap-2">
                {deal.mao?.arv && <span className="text-[11px] bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 rounded-full px-2.5 py-1 font-semibold">ARV {fmt$(n(deal.mao.arv))}</span>}
                {deal.mao?.rehab && <span className="text-[11px] bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 rounded-full px-2.5 py-1 font-semibold">Rehab {fmt$(n(deal.mao.rehab))}</span>}
                {deal.flip?.arv && <span className="text-[11px] bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 rounded-full px-2.5 py-1 font-semibold">Flip ARV {fmt$(n(deal.flip.arv))}</span>}
                {deal.rental?.salePrice && <span className="text-[11px] bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 rounded-full px-2.5 py-1 font-semibold">Purchase {fmt$(n(deal.rental.salePrice))}</span>}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => onLoad(deal)} className="px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition-colors">Load</button>
              <button onClick={() => onDelete(deal.id)} className="px-3 py-1.5 text-xs font-semibold bg-slate-100 hover:bg-red-100 dark:bg-zinc-800 dark:hover:bg-red-900/20 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded-xl transition-colors">Delete</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Save Modal ───────────────────────────────────────────────────────────────
function SaveModal({ onSave, onClose }) {
  const [address, setAddress] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-5">
          <h2 className="font-bold text-slate-900 dark:text-zinc-100 text-lg mb-1">Save Analysis</h2>
          <p className="text-sm text-slate-400 dark:text-zinc-500 mb-4">Enter the property address to label this saved analysis</p>
          <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-widest mb-1.5">Property Address</label>
          <input
            type="text"
            value={address}
            onChange={e => setAddress(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && address.trim() && onSave(address.trim())}
            autoFocus
            placeholder="123 Main St, Columbus, OH"
            className="w-full border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-800 dark:text-zinc-100 placeholder-slate-300 dark:placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4 transition-all"
          />
          <div className="flex gap-2">
            <button onClick={() => address.trim() && onSave(address.trim())} disabled={!address.trim()}
              className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-semibold py-2.5 rounded-xl text-sm transition-all">
              Save Analysis
            </button>
            <button onClick={onClose} className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-300 transition-all">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main DealAnalyzer ────────────────────────────────────────────────────────
const DA_TABS = [
  { id: 'mao',     label: 'MAO Calc',    icon: '🧮' },
  { id: 'rental',  label: 'Rental Hold', icon: '🏘' },
  { id: 'flip',    label: 'Fix & Flip',  icon: '🔨' },
  { id: 'reno',    label: 'Reno Budget', icon: '🏗' },
  { id: 'ref',     label: 'Reference',   icon: '📊' },
  { id: 'history', label: 'History',     icon: '🗂' },
]

export default function DealAnalyzer() {
  const [tab, setTab] = useState('mao')
  const [showSave, setShowSave] = useState(false)
  const [savedDeals, setSavedDeals] = useState(() => {
    try { return JSON.parse(localStorage.getItem('nexus-deal-analyses') || '[]') } catch { return [] }
  })
  const [maoState, setMaoState]     = useState(defaultMAO)
  const [rentalState, setRentalState] = useState(defaultRental)
  const [flipState, setFlipState]   = useState(defaultFlip)
  const [renoState, setRenoState]   = useState({ items: makeDefaultRenoItems() })

  const updateMAO    = (k, v) => setMaoState(p => ({ ...p, [k]: v }))
  const updateRental = (k, v) => setRentalState(p => ({ ...p, [k]: v }))
  const updateFlip   = (k, v) => setFlipState(p => ({ ...p, [k]: v }))
  const updateReno   = (k, v) => setRenoState(p => ({ ...p, [k]: v }))

  const handleSave = address => {
    const deal = { id: uid(), address, savedAt: new Date().toISOString(), mao: maoState, rental: rentalState, flip: flipState, reno: renoState }
    const updated = [...savedDeals, deal]
    setSavedDeals(updated)
    localStorage.setItem('nexus-deal-analyses', JSON.stringify(updated))
    setShowSave(false)
    setTab('history')
  }

  const handleLoad = deal => {
    if (deal.mao)    setMaoState(deal.mao)
    if (deal.rental) setRentalState(deal.rental)
    if (deal.flip)   setFlipState(deal.flip)
    if (deal.reno)   setRenoState(deal.reno)
    setTab('mao')
  }

  const handleDelete = id => {
    if (!confirm('Delete this saved analysis?')) return
    const updated = savedDeals.filter(d => d.id !== id)
    setSavedDeals(updated)
    localStorage.setItem('nexus-deal-analyses', JSON.stringify(updated))
  }

  const handleReset = () => {
    if (!confirm('Reset all fields to defaults?')) return
    setMaoState(defaultMAO)
    setRentalState(defaultRental)
    setFlipState(defaultFlip)
    setRenoState({ items: makeDefaultRenoItems() })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-zinc-100">Deal Analyzer</h2>
          <p className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">MAO calculator · Rental hold · Fix & Flip · Reno budget</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleReset} className="px-3 py-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-500 dark:text-zinc-400 rounded-xl transition-all">Reset</button>
          <button onClick={() => setShowSave(true)} className="px-4 py-1.5 text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition-all flex items-center gap-1.5">
            💾 Save Analysis
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex overflow-x-auto gap-1 mb-5 pb-0.5 -mx-1 px-1">
        {DA_TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all shrink-0 ${tab === t.id ? 'bg-slate-900 dark:bg-zinc-100 text-white dark:text-zinc-900' : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'}`}>
            <span>{t.icon}</span><span>{t.label}</span>
            {t.id === 'history' && savedDeals.length > 0 && (
              <span className="bg-blue-600 text-white rounded-full text-[9px] w-4 h-4 flex items-center justify-center font-bold ml-0.5">{savedDeals.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'mao'     && <MAOCalculator state={maoState} update={updateMAO}/>}
      {tab === 'rental'  && <RentalAnalysis state={rentalState} update={updateRental}/>}
      {tab === 'flip'    && <FixFlipCalculator state={flipState} update={updateFlip}/>}
      {tab === 'reno'    && <RenovationBudget state={renoState} update={updateReno}/>}
      {tab === 'ref'     && <ReferenceTables/>}
      {tab === 'history' && <DealHistory deals={savedDeals} onLoad={handleLoad} onDelete={handleDelete}/>}

      {showSave && <SaveModal onSave={handleSave} onClose={() => setShowSave(false)}/>}
    </div>
  )
}
