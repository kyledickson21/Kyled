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
  Tracker.jsx   ← entire money tracker (2600+ lines, single file)
  Home.jsx      ← iOS-style home screen with app icons and folders
  supabase.js   ← loadData() / saveData() / subscribeToChanges()
  main.jsx      ← entry point
  index.css     ← Tailwind base
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
      monthlyHolding: 500,           // optional
      dateSold: "2024-06-01",        // set when closed
      isRental: false,               // set when closed (bool)
      closingData: {                 // set when closed
        wire: 0, cashToClose: 0, rehab: 0, misc: 0,
        moneyCosts: 0, totalCosts: 0, overageRefund: 0,
        profit: 0, titleTotal: 0,
        lenderPayoffs: [{loanId, lenderName, principalPayoff, wireAmount, type}]
      },
      loans: [
        {
          id: "uid",
          lenderName: "John Smith",
          loanType: "private" | "hard",
          principal: 100000,
          startDate: "2024-01-15",
          endDate: null,             // null = active
          interestRate: 10,          // percent/year OR fixed dollar amount
          interestType: "percentage" | "fixed",
          paymentType: "closing" | "monthly_rate" | "monthly_fixed",
          monthlyPayment: 0,         // for monthly_fixed
          specialTerms: "",
          drawFacility: null | {committed: 0, drawn: 0, undrawn: 0}
        }
      ]
    }
  ],
  unassigned: [/* same shape as loans but not on a property */],
  homeOrder: [],     // Home screen icon order
  folders: [],       // Home screen folders
  quickLinks: []     // Home screen quick links
}
```

## Key Module-Level Helpers (Tracker.jsx, top of file)
```js
const $$ = n => "$" + round(abs(n)).toLocaleString()         // $150,000
const $$s = n => n>=0 ? `+$${...}` : `-$${...}`             // signed compact
const $$c = n => compact ($150K, $1.5M)                      // very compact
const $$p = n => penny-precise ($150,000.00)
const $$ps = n => signed penny-precise

const calcBalance(loan, asOf=TODAY)   // current balance including interest
const calcIntEarned(loan, asOf=TODAY) // interest earned so far
const uid()                           // random 7-char ID
const propNeeded(prop, loans)         // total funding needed
const effectiveMonths(prop)           // estimated hold months
const monthlyLoanPayment(loan)        // monthly interest cost
```

## Tracker.jsx Component Map
| Component | Around line | Purpose |
|---|---|---|
| `LenderMoneyForm` | ~290 | Add/edit a loan or unassigned fund |
| `MarkSoldModal` | ~487 | 2-step close-out flow for a property |
| `EditClosingModal` | ~2015 | Edit existing closing data after the fact |
| `CloseLoanModal` | ~470 | Close an individual loan early |
| `PropertiesPage` | ~1190 | "Active Properties" tab |
| `LenderDashboard` | ~1677 | "Lenders" tab |
| `PropertyDashboard` | ~1850 | "Prop Dash" tab |
| `ClosedDealsPage` | ~2088 | "Closed Deals" tab (flip/rental tabs) |
| `HistoryPage` | ~2303 | "History" tab (money trail) |
| `Tracker` (default export) | ~2545 | Main shell with nav tabs |

## Tracker Tabs
```js
const TABS = [
  {id:"Properties",  label:"🏠", full:"Active Properties"},
  {id:"LenderDash",  label:"👥", full:"Lenders"},
  {id:"PropDash",    label:"📊", full:"Prop Dash"},
  {id:"Closed",      label:"🏁", full:"Closed Deals"},
  {id:"History",     label:"📋", full:"History"},
]
```

## State & Update Pattern
```js
// In the main Tracker component:
const [data, setData] = useState(null);

const update = fn => {
  setData(prev => {
    const next = fn(prev);
    save(next);   // saves to Supabase
    return next;
  });
};
// `update` is passed as a prop to every page component
```

## UI Design Language
- iOS/Apple aesthetic: frosted glass headers, squircle icons, SF Pro font stack
- Cards: `rounded-2xl`, `shadow-[0_2px_12px_rgba(0,0,0,0.07)]`
- Dark mode: `dark:bg-[#1C1C1E]`, `dark:bg-black`
- Background: `bg-[#F2F2F7]` light / `bg-black` dark
- Accent: blue-600 primary, emerald for positive/green, red for negative/danger, violet for rolled/purple
- No external UI libraries — all custom Tailwind components

## Inline Component Library (inside Tracker.jsx)
```jsx
<Modal title="..." onClose={fn}>...</Modal>
<Btn color="blue|green|purple|red|ghost|navy" onClick={fn} full?>label</Btn>
<DateInp label="..." value={str} onChange={fn} helpText?="..."/>
<Chip color="green|red|blue|gray|purple">label</Chip>
<TypeBadge type="private|hard" sm?/>
<Inp label="..." value={str} onChange={fn} .../>
<Sel label="..." value={str} onChange={fn} options={[{value,label}]}/>
```

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

## Known Pre-existing Warnings (ignore, don't fix)
- esbuild duplicate key warnings at lines ~275-279 (`paymentType`, `monthlyPayment`)
- These don't affect functionality or the build succeeding
