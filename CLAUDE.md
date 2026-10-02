# Nexus Homes — Private Money Tracker

## What This Is
A private iOS-style dashboard for Kyle Dickson / Nexus Homes to track private money loans across real estate fix-and-flip and rental properties. Lenders are real people whose money is being tracked — data safety is paramount.

## Tech Stack
- **React 18** + **Vite 5** + **Tailwind CSS 3.3.5** (`darkMode: 'class'`)
- **Supabase** — single `nexus_data` row keyed by `org_id = 'nexus-homes'` holding one JSON blob
- **Vercel** — auto-deploys on every push to `claude/build-deploy-app-BIdEz`
- No react-router — view switching is React state only
- `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` for drag-and-drop on the Home screen

## Repo Structure
```
src/
  Tracker.jsx    ← entire money tracker (9400+ lines, single file)
  Home.jsx       ← iOS-style home screen with app icons and folders
  App.jsx        ← auth + dark mode + Tracker/Home/LenderPortal view switch
  LenderPortal.jsx ← read-only portal for lenders with a login (their own loans only)
  supabase.js    ← loadData() / saveData() / subscribeToChanges() + lender-account edge functions
  main.jsx       ← entry point
  index.css      ← Tailwind base
```

## Branch & Deploy
- **Always develop on**: `claude/build-deploy-app-BIdEz`
- **Always push to**: `origin claude/build-deploy-app-BIdEz`
- Vercel auto-deploys on every push to that branch
- Run `npm run build` before committing to verify no build errors

## ⚠️ CRITICAL DATA SAFETY RULE
The Supabase `nexus_data` blob contains real people's real money. **Never destructively overwrite existing fields.** All property/loan updates must use the spread pattern:
```js
// CORRECT — additive, preserves all existing fields
update(d => ({...d, properties: d.properties.map(p =>
  p.id === target.id ? {...p, newField: value} : p
)}))

// WRONG — could lose data
update(d => ({...d, properties: [{newField: value}]}))
```

## Data Shape (Supabase blob)
```js
{
  properties: [
    {
      id: "uid",
      address: "123 Main St",
      purchaseDate: "2024-01-15",   // optional
      purchasePrice: 150000,         // optional
      rehabBudget: 30000,            // optional
      projectMonths: null,           // optional — overrides the estimated hold length
      monthlyHolding: 500,           // optional
      closingBuy: {                  // itemized Cost-to-Buy, straight off the purchase HUD
        cashFromBorrower: 0, depositEarnest: 0, loanToTitle: 0,
        rehabHoldback: 0, loanPointsFees: 0, prepaidInterest: 0,
        // each HUD_KEYS field can also carry a matching `<key>Items` array of itemized
        // entries ({id, note, value}) when a line was split into multiple entries
      },
      dateSold: "2024-06-01",        // set when closed; cleared by "Reopen Property"
      isRental: false,               // set when closed (bool); cleared on reopen
      overageChecks: [               // post-closing insurance/tax/overcharge refunds
        {id, date, source: "insurance"|"taxes"|"overcharge"|"other", amount, notes}
      ],
      closingData: {                 // set when closed; cleared on reopen
        wire: 0, cashToClose: 0, rehab: 0, misc: 0,
        moneyCosts: 0, totalCosts: 0, overageRefund: 0,
        profit: 0, titleTotal: 0, selfFunded: 0,
        lenderPayoffs: [{loanId, lenderName, type, principalPayoff, interestPayoff,
          titleInterestPayoff, lenderFees, wireAmount, totalPayoff, paidAtTitle, isMonthly}]
      },
      loans: [
        {
          id: "uid",
          lenderName: "John Smith",
          loanType: "private" | "hard",
          principal: 100000,
          startDate: "2024-01-15",
          endDate: null,             // null = active
          dueDate: null,             // optional fixed maturity date
          interestRate: 10,          // percent/year OR fixed dollar amount
          interestType: "percentage" | "fixed",
          paymentType: "closing" | "monthly_rate" | "monthly_fixed" | "monthly_rate_split",
          monthlyPayment: 0,         // for monthly_fixed
          splitMonthlyRate: null,    // for monthly_rate_split — portion of interestRate paid
                                     // monthly (e.g. lender's equity-line rate); the rest
                                     // (interestRate - splitMonthlyRate) accrues to closing
          specialTerms: "",
          drawFacility: null | {committed: 0, draws: [{id, date, amount}]},
          lockedToProperty: false,   // private-only subtype — "Fixed to Property": can still be
                                     // moved, but PlaceSplitModal gates the move behind confirming
                                     // the promissory note/mortgage was updated (see needsNoteConfirm)
          promissoryNoteUrl: null,   // link to the signed note/mortgage (Drive, etc.) — required
                                     // in spirit, not enforced at save time: a Fixed-to-Property
                                     // loan missing this shows a red "Needs Note" flag (LockBadge)
                                     // everywhere it's listed, plus the Dashboard's "Promissory
                                     // Notes Needed" card, until a link is added. See
                                     // needsPromissoryNote() near fmtRate.
        }
      ]
    }
  ],
  unassigned: [/* same shape as loans but not on a property */],
  lenders: [                // per-lender billing settings, keyed by name (not the loan records)
    {id, name, loanType, paymentSettings: {
      graceMonth, prorateStubAtClosing, firstFullMonthAtClosing,
      dayCountBasis, monthlyMethod: "perDiem"|"flat", drawFee
    }}
  ],
  rollingLoans: [],         // loan ids flagged in Rehab Priority as "will roll", synced across devices
  propertyOrder: [],        // Active Properties manual drag-sort order (property ids)
  whiteboard: {             // cash-flow calendar (Whiteboard tab)
    startingBalance: 0,
    cards: [{id, kind: "property"|"manual"|"misc"|"bill", propId, address, amount,
      direction: "in"|"out", day: "YYYY-MM-DD"|null, order}]
  },
  homeOrder: [],     // Home screen icon order
  folders: [],       // Home screen folders ({id, name, linkIds})
  quickLinks: [],    // Home screen quick links ({id, label, url, icon, useLogo})
  dashboardLayout: { // Dashboard card drag-order + hidden cards, synced across devices
    order: [],       // card ids, see DASHBOARD_CARD_DEFS in Tracker.jsx
    hidden: []       // card ids currently hidden
  }
}
```

## Key Module-Level Helpers (Tracker.jsx, top of file)
```js
const $$p = n => penny-precise ($150,000.00)                 // used everywhere by default
const $$ps = n => signed penny-precise (+$150,000.00)
const $$c = n => compact ($150K, $1.5M)                       // glance-only dashboard KPI tiles ONLY

const calcBalance(loan, asOf=TODAY)        // current balance including interest
const calcIntEarned(loan, asOf=TODAY)      // interest earned so far
const calcMonthlyPaidPortion(loan, asOf)   // monthly_rate_split: portion paid monthly so far
const fmtRate(loan)                        // human-readable rate/terms string, respects paymentType
const uid()                                // random 7-char ID
const propNeeded(prop, loans)              // total funding needed
const propConflict(startDate, amount, prop) // null | "date" | "size" — loan-placement validity
const effectiveMonths(prop)                // estimated hold months
const monthlyLoanPayment(loan)             // monthly interest cost
const effectiveProfit(prop)                // closing profit + any overage checks
const useDirty / confirmDiscard / useDirtyGuard  // warn-before-discard for modals with unsaved edits
```

## Tracker.jsx Component Map
| Component | Around line | Purpose |
|---|---|---|
| `LenderMoneyForm` | ~569 | Add/edit a loan or unassigned fund |
| `PlaceSplitModal` | ~1397 | Place/split an unassigned fund or move a loan across properties |
| `CloseLoanModal` | ~1641 | Close an individual loan early |
| `MarkSoldModal` | ~1701 | 2-step close-out flow for a property |
| `PropertyForm` | ~2391 | Add/edit a property, incl. itemized Cost-to-Buy |
| `PropertiesPage` | ~2920 | "Properties" tab |
| `LenderDashboard` | ~3674 | "Lenders" tab |
| `AllLoansPage` | ~3826 | "Loans" tab |
| `PropertyDashboard` | ~4047 | "Prop Dashboard" tab |
| `EditClosingModal` | ~4222 | Edit existing closing data after the fact |
| `ClosedDealsPage` | ~4904 | "Records" tab, Closed sub-view (flip/rental tabs) |
| `HistoryPage` | ~5140 | "Records" tab, History sub-view (money trail) |
| `RehabPriorityPage` | ~5739 | "Rehab Priority" tab |
| `OverageCheckModal` | ~6160 | Add/edit a post-closing overage refund |
| `ManageLendersPage` | ~6206 | "Portal Access" — lender portal login management |
| `DrawsPage` | ~6317 | "Draw Tracker" tab |
| `WhiteboardPage` | ~6957 | "Whiteboard" tab — cash-flow calendar |
| `PropertyDetailPage` | ~7143 | Property detail panel/page |
| `LenderDetailPage` | ~7546 | Lender detail panel/page |
| `LoanDetailPage` | ~7969 | Loan detail panel/page |
| `DashboardPage` | ~8396 | "Dashboard" tab (home/overview) |
| `Tracker` (default export) | ~8864 | Main shell with nav tabs |

## Tracker Tabs
Tab ids switched on in `Tracker`'s render (`setTab(id)`), matching the sidebar/mobile nav:
```
Dashboard | Properties | LenderDash ("Lenders") | AllLoans ("Loans") | RehabPriority
Draws ("Draw Tracker") | PropDash ("Prop Dashboard") | Closed + History (grouped as "Records")
Whiteboard
```
"Portal Access" (lender login management) is reached from the settings menu, not the main nav.

## State & Update Pattern
```js
// In the main Tracker component:
const [data, setData] = useState(null);
const undoStackRef = useRef([]);   // capped stack of { inverse: currentData => revertedData }

const update = fn => {
  setData(prev => {
    const next = fn(prev);
    const inverse = computeInverse(prev, next);   // diff-based, for Undo
    if (inverse) undoStackRef.current = [...undoStackRef.current, {inverse}].slice(-10);
    saveQueueRef.current = saveQueueRef.current.then(() => persistWithRetry(next, fn));
    return next;
  });
};
// `update` is passed as a prop to every page component. Saves are serialized through
// saveQueueRef and use optimistic concurrency (updatedAtRef) — a conflict retries by
// re-running `fn` against the freshly-loaded data instead of overwriting it.
```

## UI Design Language
- iOS/Apple aesthetic: frosted glass headers, squircle icons, SF Pro font stack
- Cards: `rounded-2xl`, `shadow-[0_2px_12px_rgba(0,0,0,0.07)]`
- Dark mode: `dark:bg-[#1C1F2B]` (cards), `dark:bg-[#14161F]` (page/sidebar) — a navy/charcoal
  palette matching Kyle's REsimpli CRM, not pure black
- Background: `bg-[#F2F2F7]` light / `bg-[#14161F]` dark
- Accent: teal-600 primary (matches REsimpli's signature blueish-green), emerald for
  positive/green, red for negative/danger, violet for rolled/purple
- No external UI libraries — all custom Tailwind components

## Inline Component Library (inside Tracker.jsx)
```jsx
<Modal title="..." onClose={fn}>...</Modal>
<Btn color="blue|green|purple|red|ghost|navy" onClick={fn} full? sm? disabled?>label</Btn>
<DateInp label="..." value={str} onChange={fn} helpText?="..."/>
<Chip color="green|red|blue|gray|purple">label</Chip>
<TypeBadge type="private|hard" sm?/>
<LockBadge loan={loan}/>   {/* Fixed-to-Property private loans only: 🔒 Fixed, or a red Needs Note flag */}
<Inp label="..." value={str} onChange={fn} money? percent? .../>
<Sel label="..." value={str} onChange={fn} options={[[value,label], ...]}/>   {/* array of tuples, not {value,label} objects */}
<MoneyField value={str} onChange={fn} placeholder? .../>   {/* bare $ input, no label — used inside custom layouts */}
<Lockable locked={bool} onToggle={fn}>...</Lockable>              {/* full-width confirm-before-save wrapper */}
<LockableInline locked={bool} onToggle={fn}>...</LockableInline>  {/* inline variant, same pattern */}
<DropdownPortal anchorRef={ref} open={bool} onClose={fn}>...</DropdownPortal>  {/* portal-rendered dropdown */}
```
Forms with unsaved-edit protection use the `useDirty`/`confirmDiscard`/`useDirtyGuard` trio
(declared near `usePersistedState`, top of file): a form that owns its own `<Modal>` calls
`useDirtyGuard` directly; a form whose `<Modal>` is rendered by its caller instead exposes an
`onDirtyChange` prop and the caller tracks its own `formDirty` state + guarded close handler.

## History Tab — Money Trail Logic
- **Start events**: `nc = +principal` (money in from lender, green `+$X`)
- **Close/Paid-back events**: `nc = -principal` (money out to lender, red `−$X`); interest shown as supplemental info
- **Rolled events**: `nc = 0`, shows "→ Continues / no cash out"
- **Sum of nc for a lender = their current outstanding principal with Nexus**
- A "Net Outstanding" footer shows the sum for all filtered events

## Closed Deals Tab
- Flip/Rental tab switcher at the top
- Stats (count, avg cash to close, avg rehab, avg profit) reflect whichever tab is active
- "+ Close a Property" button opens a property picker → MarkSoldModal
- ✏️ Edit button on each card opens EditClosingModal to fix mistakes
- "○ Mark Rental" toggle on each card (retroactive)
- ↺ Reopen button clears `dateSold`/`isRental`/`closingData`, moving the property back to
  Active Properties — deliberately does NOT reopen any loans that were closed/rolled as
  part of that sale (see `PropCard`/`PropertyDetailPage`'s reopen handler)

## Known Pre-existing Warnings (ignore, don't fix)
- esbuild duplicate key warnings around lines ~591-597 in `LenderMoneyForm`'s default state
  (`paymentType`, `monthlyPayment`, `splitMonthlyRate`, `drawFacility` each set once as a
  literal default, then again from `init` via spread — intentional, not a bug)
- These don't affect functionality or the build succeeding
