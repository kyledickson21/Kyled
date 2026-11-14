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
  App.jsx        ← auth + dark mode + Tracker/Home/LenderPortal/bookkeeper view switch
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

**Export Backup**: "Export Backup (JSON)" in the Settings menu (desktop sidebar and mobile
drawer, gated `!readOnly`) downloads `nexus-backup-<date>-<timestamp>.json`. It pulls fresh
straight from Supabase (`fetchBackupRows()` in `supabase.js` — `select org_id, data,
updated_at`) rather than the app's own in-memory `data` state, which can briefly be a
migrated/derived version of the DB row (see `applyMigrations`, run once per session on load
and saved back) rather than the row itself — the file bundles `exportedAt`/`orgId`/`rowCount`
alongside the raw row(s). This is the backup to restore from before running anything that
writes to `nexus_data` in bulk (e.g. the first REsimpli sync) — see `exportBackup` near the
top of the main `Tracker` component. The real `org_id` value is `'nexus-homes'` (see `ORG_ID`
in `supabase.js`), and there's exactly one row.

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
      resimpli: null | {             // optional — REsimpli pipeline tracking, reference only.
        leadId: "12345",             // REsimpli's own LEAD id — the Open API can only read/list
                                      // Leads (not Inventory/Rental/Sold), so this is the only id
                                      // the live sync itself can discover. Matched/stored
                                      // separately from moduleId (below) since they're different
                                      // id spaces in REsimpli — never compare one against the other.
        moduleId: null,              // REsimpli's Inventory/Rental/Sold "module" id — only ever
                                      // arrives via the CSV import (resimpli_id column when
                                      // record_type isn't "lead"); the live sync can't read these
                                      // modules at all. Kept so a later address-match sync can
                                      // still discover and backfill the real leadId without losing
                                      // this reference.
        stage: "Under Contract",     // free text — not constrained to RESIMPLI_STAGES, which
                                      // is only the datalist's suggestion list
        recordType: "lead",          // "lead" | "inventory" | "rental" | "sold" — only ever set
                                      // by import/sync, never by the property form
        url: "https://app.resimpli.com/...",
        source: "manual",            // "manual" | "import" | "sync"
        updatedAt: "2026-11-14T00:00:00.000Z",
      },
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
          drawFacility: null | {committed: 0, draws: [{id, date, amount, fee}]},
                                     // each draw's `fee` is optional (omitted, not 0, when
                                     // there isn't one) — a one-time cost the lender takes off
                                     // a specific draw, e.g. an inspection/draw fee. `amount`
                                     // is always the GROSS draw against the committed facility
                                     // (unchanged meaning — drawn/available math is untouched
                                     // by fee) — the net that actually hit the bank account is
                                     // always computed on display as `amount - fee`, never
                                     // stored. See "Draw Fees" below.
          lockedToProperty: false,   // private-only subtype — "Fixed to Property": can still be
                                     // moved, but PlaceSplitModal gates the move behind confirming
                                     // the promissory note/mortgage was updated (see needsNoteConfirm)
          promissoryNoteUrl: null,   // link to the signed note/mortgage (Drive, etc.) — required
                                     // in spirit, not enforced at save time: a Fixed-to-Property
                                     // loan missing this shows a red "Needs Note" flag (LockBadge)
                                     // everywhere it's listed, plus a Tasks-widget row, until a
                                     // link is added. See needsPromissoryNote() near fmtRate.
          stubPaymentConfirmed: false, // monthly_rate_split only — one-time ack that the loan's
                                     // very first monthly payment was paid by hand, since autopay
                                     // can't already be live the moment a loan originates — the
                                     // amount is a genuine prorated stub when the start date isn't
                                     // the 1st (see firstStubAmount), or just the regular flat
                                     // amount a cycle early otherwise (see firstPaymentAmount).
                                     // Tasks-widget rows for this combine every split loan a
                                     // lender holds (across properties) into one task with one $
                                     // total — Kyle sets up one autopay per lender, not one per
                                     // property — so checking it off sets this
                                     // on every loan in that group at once.
          autopayConfirmedAmount: null, // monthly_rate_split only — $/mo Kyle has confirmed is set
                                     // up as autopay at the lender's bank, tracked per loan but
                                     // compared/combined per lender (see getOpenTasks). null = never
                                     // set up. If the lender's combined total no longer matches
                                     // what's actually owed each month (principal paid down, rate
                                     // changed, a property added/closed) the Tasks widget reopens
                                     // this as an "update autopay amount" task rather than leaving
                                     // it silently stale. Deliberately NOT shown for every
                                     // isAutopayEligible loan — only the split-payment structure
                                     // is manual/easy-to-forget enough to need this nagging (a
                                     // plain hard-money fixed-$ loan like Kiavi has nothing for
                                     // Kyle to personally set up and is excluded).
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
  },
  resimpliLastSyncedAt: null, // ISO timestamp of the live sync's last successful run (scheduled,
                              // manual "Sync Now", or webhook) — shown on the Properties page.
                              // Not touched by the CSV import.
  resimpliReview: [],  // REsimpli records the live sync couldn't confidently match to a tracker
                       // property — shown in a dismissible "⚠️ REsimpli Review" card on the
                       // Properties page. {id, kind:"ambiguous"|"noPropertyMatch", record,
                       // candidateAddresses, detectedAt}. Fully recomputed by every scheduled/
                       // manual sync run (so a resolved ambiguity naturally drops off); a
                       // single-lead webhook hit that can't resolve is just dropped, not added
                       // here — only a full sync run maintains this list. See "REsimpli Live
                       // Sync" below.
  resimpliPipelineOrder: null, // REsimpli's live-fetched pipeline/stage order (same shape as
                                // the hardcoded RESIMPLI_PIPELINES default in
                                // resimpli-shared.mjs: [{key,label,stages,order}]) — set by the
                                // scheduled/manual sync's fetchPipelineOrder(), null until the
                                // first sync run. The UI (sort/filter/badge/Pipeline view) uses
                                // this instead of the hardcoded default whenever it's set. Not
                                // touched by the CSV import or the single-lead webhook.
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
| `EditDrawModal` | ~6842 | Edit/delete an already-recorded draw, from Properties or Loans |
| `ResimpliBadge` | ~3420 | Stage badge shown per property on the Properties page |
| `ImportResimpliModal` | ~3465 | "Import REsimpli Stages" CSV bulk-match/import flow |
| `SyncNowModal` | ~3595 | "Sync Now" dry-run-then-apply flow for the REsimpli live sync |
| `ResimpliReviewCard` | ~3659 | "⚠️ REsimpli Review" dismissible card — unmatched/ambiguous sync results |
| `ManageLendersPage` | ~6206 | "Portal Access" — lender portal login management |
| `HardMoneyComparePage` | ~6990 | "Rate Comparison" — what-if calculator for hard money loans |
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
"Portal Access" (lender login management) and "Rate Comparison" (hard money what-if calculator)
are both reached from the settings menu, not the main nav. Both are hidden under `!readOnly`,
so bookkeepers don't see either.

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

## Bookkeeper (Read-Only) Role
A bookkeeper login sees the real Tracker UI — every tab, full History/Money Trail, all
properties/lenders/loans — with zero write capability. Unlike LenderPortal (a separate,
simplified, single-lender UI), this reuses Tracker.jsx itself so bookkeepers see exactly
what Kyle sees, just locked down.
- **Routing**: `App.jsx` renders `<Tracker readOnly userEmail={...} .../>` (no `onHome`, so
  there's no Home screen option) when `session.user.user_metadata?.role === 'bookkeeper'`.
- **Hard backstop**: `Tracker`'s own `update` function (see State & Update Pattern above)
  returns immediately when `readOnly` is true, before touching `setData` or Supabase — so no
  write can ever land from a bookkeeper session, no matter what UI is still reachable.
- **UI hiding**: `ReadOnlyContext`/`useReadOnly()` (declared next to `PrivacyContext`) is
  provided once at the top of `Tracker` and read via the hook in every page/card component
  that has an edit/add/delete/move/drag affordance, to hide it outright rather than leave a
  dead button. Covers: the global Actions (+) menu, Undo/Redo, "Portal Access" (bookkeeper
  accounts aren't managed from inside a bookkeeper session), Dashboard's Customize +
  drag-reorder + TasksCard (Kyle's own to-do checklist), and every per-page Edit/Delete/Move/
  Reopen/Close/Mark Rental/Add-* button and `DndContext` drag sensor across Properties,
  PropertyDetailPage, LoanDetailPage, LenderDetailPage, ClosedDealsPage, RehabPriorityPage,
  and WhiteboardPage. `{update && ...}` alone is NOT a safe read-only gate — `update` is
  always a truthy function (a no-op under readOnly), so that pattern only hides UI when the
  prop itself wasn't passed; use `{!readOnly && ...}` (or combine the two) instead.
- **Account creation**: "Portal Access" (`ManageLendersPage`) now has a second "Grant
  Bookkeeper Access" form/list below the lender one, calling `createBookkeeperAccount({email,
  password})` / the shared `listLenderAccounts()` / `deleteLenderAccount(userId)` from
  `supabase.js`. All three hit the same `manage-lenders` edge function (deployed outside this
  repo — its source isn't checked in, so changes to it have to be pasted into the Supabase
  dashboard's Edge Functions editor by hand, there's no deploy tooling here) extended to
  accept `{ role: "bookkeeper" }` on POST: it skips the `lenderName`/`lender_profiles` row
  entirely (a bookkeeper isn't scoped to one lender) and GET now also returns a `bookkeepers`
  array (from `auth.admin.listUsers()` filtered to `user_metadata.role === "bookkeeper"`,
  since those accounts have no profile-table row to list). DELETE is unchanged and already
  works for either role. The function's own auth check (only `kyle@nexushomesoh.com` may
  call it at all) means this is safe to share across both account types.
- **RLS note**: `nexus_data`'s SELECT policy is unrestricted for any authenticated user, so a
  bookkeeper reads the full blob via the same plain `loadData()` the admin Tracker uses — no
  dedicated edge function needed for bookkeeper reads, unlike lenders (`lender-data`). The
  UPDATE policy was originally just as unrestricted, which would have let a lender or
  bookkeeper account write directly to the table by calling the Supabase client's `.update()`
  themselves, bypassing the app's own UI lockdown entirely — tightened to exclude both roles
  (`(auth.jwt() -> 'user_metadata' ->> 'role') IS DISTINCT FROM 'bookkeeper' AND ... 'lender'`)
  so the read-only guarantee holds even against someone going around the app, not just
  against the app's own hidden buttons.

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
- **Draw events** (`etype:"draw"`, one per entry in a loan's `drawFacility.draws`): `nc =
  drawGross(d)` — a draw is new money in, just like a loan starting, so it grows what's owed
  by the full gross (not the smaller net that actually hit the account, which is `ev.amount`,
  the headline `+$X` figure shown). 🏗️ "Rehab Draw", green. `groupTrailEvents` sums `fee`/
  `gross` too when same-day draws combine into one row — don't forget those two fields if the
  grouping logic there ever changes shape.
- **Sum of nc for a lender = their current outstanding principal with Nexus**
- A "Net Outstanding" footer shows the sum for all filtered events
- A third `HistoryPage` view, **"📅 As Of Date"** (`view==="asof"`), answers "what was our
  total loan exposure on date X" — a date picker plus every loan (properties + unassigned)
  where `startDate <= asOfDate && (!endDate || endDate >= asOfDate)` (a loan closing exactly
  on the as-of date still counts — money was out that day), each one's payoff recomputed via
  `calcBalance(loan, asOfDate)` rather than today, summed into Total Principal / Interest
  Accrued / Total Payoff stat tiles. The existing lender/type filters apply here too.

## Draw Fees
Every "Add Draw" entry point — the global Actions → "Record Draw" quick action
(`QuickDrawModal`), the inline "+ Add Draw" card on Properties (`inlineDraw` state in
`PropertiesPage`), and the draw-facility editor in both `LenderMoneyForm` (adding/editing a
loan) and `LoanDetailPage` — has an optional "Draw Fee ($)" field alongside the existing Draw
Amount, for lenders that take a fee off a specific draw (e.g. an inspection fee).
- **`amount` is the NET** — what Kyle actually types in is the amount that hits the bank
  account, since that's the number he has in hand (off a bank statement/draw sheet). The fee
  is on top of that, not carved out of it. `drawGross(d) = d.amount + (d.fee||0)` (declared
  right next to `drawRemaining`, top of file) is the true draw against the committed
  facility — every "Drawn"/"Available"/funded total, and the per-draw interest accrual in
  `addHardPayments` (Whiteboard), sums `drawGross(d)`, never `d.amount` alone. Getting this
  backwards (subtracting the fee from amount instead of adding it) was a bug fixed shortly
  after the feature shipped — watch for any new "drawn against facility" math defaulting back
  to a bare `d.amount` sum instead of `drawGross(d)`.
- Every place a draw is listed — the read-only Draw History table on `LoanDetailPage`
  ("To Account" / "Fee" / "Drawn (Facility)" columns), the draws list on `PropertyDetailPage`,
  and the editable "Draws Taken" lists in the two forms — shows the net amount, the fee (when
  present), and the computed gross (`drawGross(d)`, "drawn against the facility"), so
  bookkeepers see it too without needing any write access.
- **Editing a recorded draw**: a ✏️ next to each draw row on both `PropertyDetailPage` (inside
  the loan's Draw Facility card) and `LoanDetailPage`'s Draw History table — not just inside
  the loan's full edit form — opens `EditDrawModal` (date/amount/fee, same Lockable-confirm
  pattern as everywhere else, plus a Delete button with a confirm prompt). `PropertyDetailPage`
  patches `prop.loans` directly (it already knows `propId`); `LoanDetailPage` uses the same
  "patch across properties + unassigned" pattern as `saveEdit`/`closeLoan`/`deleteLoan` there,
  since a loan can live in either place. Both pencils are gated `!readOnly`.
- **At closing**: `sumDrawFees(loan)` (near `drawRemaining`, top of file) totals every fee
  recorded across a loan's draws. `MarkSoldModal` pre-fills that loan's row's "Lender Fees"
  field with this sum (still editable) when a property is first marked sold, so draw fees land
  in **Money Costs**, not Rehab — `rehabIn` is a wholly separate field, never touched by this.
  A small teal hint under the field ("Pre-filled from $X in recorded draw fees") shows the
  original figure even if Kyle edits Lender Fees afterward for an unrelated reason.
  `EditClosingModal` (editing an already-closed deal) keeps using the real saved `lenderFees`
  value rather than re-deriving it, but shows the same hint for reference.

## Hard Money Rate Comparison (`HardMoneyComparePage`)
A what-if calculator reached via Settings → "Rate Comparison" (hidden from bookkeepers). Kyle
types in a hypothetical lender's rate/points/day-count basis; the tool shows what every
`loanType==="hard"` loan — past and current, properties + unassigned — would have cost under
those terms instead of what it actually cost, both "This Year" and "All-Time". Nothing is saved;
inputs persist locally via `usePersistedState` (`nx-hmcRate`/`nx-hmcPoints`/`nx-hmcBasis`).
- **Actual** interest reuses `calcIntEarned()` verbatim, so it always matches the Dashboard/
  LenderDetailPage figure for the same loan.
- **Hypothetical** interest is flat simple interest (`principal × rate × days ÷ basis`) over the
  loan's own real start/end dates — it does not re-simulate monthly billing mechanics, so treat
  it as a ballpark for comparing rates, not a penny-exact alternate history.
- Points are a one-time cost under the hypothetical lender, as either a `%` of principal or a
  flat `$` origination fee (toggled via "Fee Type", mirroring `interestType`'s percentage/fixed
  pattern elsewhere in the app) — counted in "This Year" only if the loan itself originated this
  year (`loan.startDate.slice(0,4) === currentYear`) — a loan that funded in an earlier year
  would have paid its points then, not now. They always count toward "All-Time" regardless of
  origination year.
- "This Year" uses `max(0, earnedThrough(today) - earnedThrough(lastYearEnd))` for both actual
  and hypothetical sides, so a loan that closed before this year contributes $0 to "This Year"
  but still counts fully toward "All-Time".
- Private-money loans are entirely out of scope — the tool only ever looks at `loanType==="hard"`.

## Registering a Lender Before Any Loan (`AddLenderModal`)
`data.lenders[]` was always the authoritative lender roster independent of loans —
`resolveLenderSettings`/`LenderMoneyForm`'s lender picker already read from it directly — but
`LenderDashboard` only ever built its list from actual loan records, so a lender with zero
loans was invisible and there was no UI to create one in the first place. "+ Add Lender" on
the Lenders tab (gated `!readOnly`) opens `AddLenderModal` (name + loan type, blocks a
case-insensitive duplicate name) and calls `upsertLender` to create the record, then navigates
straight to that lender's `LenderDetailPage` so Kyle can fill in Payment Settings (how their
monthly interest is actually billed) right away — the whole point being to capture a lender's
terms the moment he works them out, before an actual loan exists.
- `LenderDashboard` now also seeds its `byLender` map from `data.lenders[]` directly (not just
  loan records), so a zero-loan lender shows up with a "No loans yet — terms on file" line
  instead of silently not appearing at all.
- `LenderDetailPage` already worked for zero loans (`allLoans` is just `[]`, Payment Settings
  reads/writes by name regardless) — fixed `currentLoanType`/`editType` to check the saved
  `data.lenders` record's own `loanType` FIRST, falling back to an actual loan's type and then
  "private" only if neither exists, so a pre-registered hard money lender with no loans yet
  doesn't silently read back as private.
- The "Edit Lender" rename/retype Save handler previously only patched `lenderName`/`loanType`
  on actual loan records — for a zero-loan lender there's nothing for that to touch, so Save
  did nothing at all; fixed to also patch the lender's own `data.lenders` record (by old name),
  which was already a latent bug for lenders WITH loans too (their Payment Settings went
  orphaned under the stale name after a rename).
- Found and fixed a real bug while testing this: the "Lender Name" field's `onChange` was
  written as `e=>setEditName(e.target.value)`, but `Inp`'s `onChange` already unwraps the
  event and calls back with the plain string — so typing a new name threw immediately
  ("Cannot read properties of undefined (reading 'value')"). Now `onChange={setEditName}`.
- "Remove Lender" (next to Save/Cancel in the Edit panel) only shows when `allLoans.length===0`
  — deleting a lender with any loan history (active or closed) is never exposed this casually,
  since their Payment Settings would be the only thing lost but the blast radius of "this
  button ever touches real loan data" isn't worth the risk for a feature this narrow.

## Prop Dashboard — "Funded" Means Actual Cash, Not Committed
`PropertyDashboard`'s capital calculator (Total Portfolio Size / Available Now / Deployment
rate assumption / You Need to Find / Idle Capital) and its per-property funded/needed bars
compute `funded` as `principal + sum(drawGross(d) for d in drawFacility.draws)` — actual money
in, not the draw facility's full `committed` ceiling. A committed-but-largely-undrawn rehab
facility used to count as fully funded the moment it was set up, which made this page read as
"almost full" when the real cash position was much tighter (the Available Now number included
lender promises that hadn't been disbursed yet). `pendingDraws = committed − funded` is kept
as a separate, clearly-labeled "+$X committed, not yet drawn" line (under the "On Deals" stat
tile, and per-property in the list below) so that capital is still visible, just not folded
into what's treated as in-hand.
- **The regular Properties tab (`PropertiesPage`) deliberately still uses the full committed
  amount** for its own funded/needed bars and shortage sort — Kyle confirmed that's correct
  there: it answers "does this deal have financing lined up" (so he doesn't go raise/place
  more private money than a property actually needs), not "do I have cash in hand right now."
  Whiteboard's auto-generated cards and the other ~6 `principal + drawFacility?.committed`
  call sites across the file (LenderDashboard, AllLoansPage, RehabPriorityPage, etc.) were
  intentionally left untouched for the same reason — only `PropertyDashboard`'s capital
  calculator is about present-tense cash position.

## REsimpli Stage Tracking (Properties Page)
Reference-only metadata (`property.resimpli` — see Data Shape above) for where a deal sits in
REsimpli's own pipeline. Never touches any money field, loan, lender, or draw.
- **Shared logic lives in `src/resimpli-shared.mjs`** — a pure, dependency-free ES module
  (explicit `.mjs` extension since `package.json` has no `"type":"module"`), imported by both
  `Tracker.jsx` (via Vite) and the server-side sync (`api/*.mjs`, via plain Node ESM), so the
  CSV import, the scheduled sync, the webhook receiver, and the manual "Sync Now" button all
  agree on exactly the same pipeline/stage order, address-normalization rules, and matching
  algorithm. Exports: `RESIMPLI_PIPELINES`, `RESIMPLI_STAGES`, `pipelineForRecordType`,
  `resimpliStageLabel`, `stageSortKey`, `normalizeAddressForMatch`, `expandCombinedAddress`,
  `propertyAddressKeys`, `matchResimpliRecords`, `assertOnlyResimpliChanged`. Don't
  re-implement any of this elsewhere — import from here.
- **Pipelines**: REsimpli has four pipelines, each with its own stage order —
  `RESIMPLI_PIPELINES` is the hardcoded default, verified against both the REsimpli screens and
  the API's `orderIndex`: Lead (New Leads → … → Under Contract), Inventory (New Inventory → … →
  Under Contract), Rental (New Rental → … → TURN/NEEDS RENTED), Sold (Sold).
  `property.resimpli.recordType` ("lead"|"inventory"|"rental"|"sold") says which pipeline a
  property is in — the stage name alone is never enough, since "Under Contract" is used by both
  Lead and Inventory, and "Under Rehab" by both Inventory and Rental. `pipelineForRecordType
  (recordType)` looks up a pipeline by key; `RESIMPLI_STAGES` is a flat, deduplicated list of
  every stage across every pipeline, used only for the PropertyForm datalist (a hand-typed
  stage has no recordType, so no single pipeline to scope it to). The live sync (held, see
  below) will eventually read this order live from REsimpli's `getPipelineList` and store it
  alongside the synced data, falling back to this hardcoded default when that isn't available.
- **Display**: `ResimpliBadge` shows `resimpliStageLabel(resimpli)` as a small indigo chip, or
  muted "No stage" when there isn't one; clickable through to `resimpli.url` when set.
  `resimpliStageLabel` adds "(Lead)"/"(Inventory)"/etc. only when the bare stage name is
  ambiguous across pipelines (`STAGE_NAME_PIPELINE_COUNT`) AND the pipeline is actually known
  (recordType set) — otherwise just the stage name. Shown on the Properties page in condensed/
  grid/expanded/pipeline — a dedicated "Stage" column in condensed, a line under the card in
  grid, a line under the header in expanded, the column itself in pipeline — and NOT shown
  anywhere else (PropertyDetailPage, Dashboard, etc.), scoped to the Properties page only.
- **Editing**: `PropertyForm` has a "REsimpli (optional)" section — Stage (plain text input
  with an HTML `<datalist>` of `RESIMPLI_STAGES` as suggestions, not a locked dropdown, since
  REsimpli's own stage names can drift), REsimpli ID, and URL. None of the three are
  Lockable/confirm-gated like the money fields are — there's nothing here that affects a
  calculation. `recordType` and `moduleId` are NOT editable from this form at all — only an
  import or the live sync sets them; a hand-edit always carries whatever was already on file
  for those two fields forward unchanged. Saving from the form always sets `source:"manual"`
  and a fresh `updatedAt`, even if the record previously came from an import or sync, since a
  hand-edit is by definition the latest manual word on it. Both `PropertyForm` callers
  (`PropertiesPage`'s `saveProp` and `PropertyDetailPage`'s inline edit handler) just pass
  `resimpli: f.resimpli` straight through — `PropertyForm` itself already computed the correct
  final value from `init?.resimpli`, so neither caller needs its own merge logic.
- **leadId vs. moduleId**: the Open API can read/list Leads but **cannot list the Inventory,
  Rental, or Sold modules** — so `resimpli.leadId` (set by the live sync, or by a CSV row whose
  `record_type` is `lead`) and `resimpli.moduleId` (set only by a CSV row whose `record_type`
  is `inventory`/`rental`/`sold`) are stored and matched **separately**, never compared against
  each other. A CSV row carries only one id type per row; importing one never clobbers the
  other id already on file for that property (see `confirmImport` in `ImportResimpliModal`,
  and the same preserve-the-other-field pattern in `PropertyForm`'s save path and in
  `api/resimpli-sync.mjs`'s diff computation). The live sync can only ever discover/refresh
  `leadId` — a property whose REsimpli record only has a `moduleId` stays matched on address
  until the lead is created/found in REsimpli too.
- **Combined addresses** (e.g. "3126 & 3134 Wessex Ct") and **directionals**:
  `normalizeAddressForMatch` drops directionals (N/S/E/W/NE/NW/SE/SW and the spelled-out forms)
  wherever they appear in the street line, not just leading, and strips unit/apt/suite/#
  tokens — so "902 Dayton Ave Nw # 52pt" and "902 Dayton Ave #52" normalize identically. This
  is deliberate even though it can make two genuinely different addresses collide (e.g. "123 N
  Main St" vs "123 S Main St") — when that happens, the normal 2+-candidates ambiguity check
  already sends them to review instead of guessing, which is exactly the wanted behavior.
  `expandCombinedAddress`/`propertyAddressKeys` split a tracker property like "3126 & 3134
  Wessex Ct" into its two individual addresses for matching: if REsimpli has **one** matching
  record, the property matches cleanly; if REsimpli has **two** (one per half), both move to
  `ambiguous` instead of either being picked — see `matchResimpliRecords`'s second pass in
  `resimpli-shared.mjs`.
- **Sort**: `stageSortKey(prop)` returns a sortable string — pipeline first (Lead, Inventory,
  Rental, Sold, in that order, via `pipelineForRecordType`), then stage within that pipeline's
  own order, then any stage REsimpli doesn't list (alphabetically, within its pipeline), then a
  stage with no known pipeline (alphabetically), then no stage at all (always last) — wired
  into `propSortMode==="stage"` in both places `PropertiesPage` computes sort order
  (`visible`'s own sort AND the separate `rankMap` sort), so the two stay in sync. The condensed
  table's clickable "Stage" column header reuses the same key.
- **Filter**: a plain `<select>` next to the sort controls — "All Stages", then only the
  (recordType, stage) pairs actually present on an active property, in `stageSortKey` order,
  labeled via `resimpliStageLabel` (so "Under Contract (Lead)" and "Under Contract (Inventory)"
  show as two distinct, correctly-filtering options when both are present), then "No stage".
  The filter's value is a composite `"<recordType>::<stage>"` string (`"_"` standing in for no
  recordType) — never the bare stage name, for the same ambiguity reason. Persisted via
  `usePersistedState("nx-propStageFilter")`.
- **Pipeline view**: a fourth Properties-page view mode (toggle icon "Ⅲ", next to condensed/
  grid/expanded), mirroring REsimpli's own Inventory Grid (kanban). Built from `pipelineColumns`
  (computed alongside `stagesPresent`/`visible`, so the existing search/stage filter apply
  here too): one column per Inventory stage (always shown, even empty, in REsimpli's order,
  via `pipelineForRecordType("inventory").stages`), then "Other Inventory" (unrecognized
  inventory stage), "Lead: Under Contract", "Rental", "Sold", and "No stage" — all five hidden
  when empty. Each card shows the address, the REsimpli link when on file, and the same
  funded/needed/shortage-or-surplus figures the other views already compute inline; clicking a
  card opens the same property detail panel as every other view. No drag-and-drop between
  columns and no write of any kind — REsimpli's stage is read-only reference data here, exactly
  like the badge elsewhere on this page. Once the live sync (below) starts storing the live
  pipeline order, this view (and sort/filter above) will use that instead, falling back to the
  hardcoded `RESIMPLI_PIPELINES` default.
- **Import** (`ImportResimpliModal`, reached via the global Actions (+) menu → "Import
  REsimpli Stages (fallback)", gated `!readOnly` same as every other item in that menu — moved
  off the Properties-page toolbar once the live sync below does this automatically, so it's no
  longer a default-visible button, just a deliberate fallback):
  accepts a CSV file (`parseCSV` — a small hand-rolled quoted-field parser, fine since this is
  Kyle's own export, not third-party input) with columns `address,resimpli_id,record_type,
  stage,url`, matched by header name via `csvRowsToResimpliObjects` so a reordered export still
  works. Each row is converted to a generic record (`csvRowToRecord` — `idType` is `"module"`
  when `record_type` is set and isn't `"lead"`, else `"lead"`) and matched via the shared
  `matchResimpliRecords(properties, records)` — never guesses: 2+ property candidates for the
  same record, or 2+ records for the same property (see combined-address note above), go to
  `ambiguous` and are skipped entirely, not written. The preview shows all four buckets —
  Matched, Ambiguous — skipped, CSV rows with no tracker property, and tracker properties with
  no CSV row. Matching runs against **every** property regardless of `dateSold`, not just
  active ones. Nothing writes until "Confirm Import" — `importResimpliStages` builds the full
  next state, runs it through `assertOnlyResimpliChanged` as an explicit last-line guard (see
  "REsimpli Live Sync" below), and only then calls `update()`, touching only `property.resimpli`
  on the matched properties, by id — every other property and every other field passes through
  completely untouched. Every imported record gets `source:"import"` and a fresh `updatedAt`.
  The CSV import does **not** write to `data.resimpliReview` — that list is maintained only by
  the live sync (see below); the import modal's own preview is where Kyle resolves CSV
  ambiguity/no-match before confirming, and nothing from it persists past that one import.

## REsimpli Live Sync
A server-side sync that keeps `property.resimpli` current from REsimpli itself, on top of the
manual CSV import above (which remains as a fallback). Nothing here is deployed yet — see the
HOLD note at the end of this section.

- **Architecture**: implemented as **Vercel serverless functions** (`api/*.mjs`), not Supabase
  Edge Functions — chosen because the app already deploys via Vercel and its env vars are
  already set there, Vercel Cron is natively configurable via `vercel.json`, and (per the
  Bookkeeper section above) this repo has no deploy tooling for Supabase Edge Functions at all
  — those have to be hand-pasted into the Supabase dashboard. One deploy pipeline covers both
  the app and the sync.
  - `api/_resimpli-client.mjs` — the REsimpli Open API v6 HTTP client. **The entire contract is
    now VERIFIED against live REsimpli calls** (base URL `https://api.resimpli.com/api/v6/openapi`,
    every call is POST — reads included, a GET 404s — with a bare `Authorization: <key>`
    header, 500 req/min rate limit): `/getUserInfo` (key check), `/lead/list` (the only way to
    read Inventory/Rental/Sold — there's no per-module list endpoint, so it returns every
    record across every module mixed together), `/lead/details`, `/getPipelineList` (moduleType
    1/6/7 = Lead/Inventory/Rental; no Sold module). Classification keys off `mainStatusId` via a
    status map built from `getPipelineList` (`buildStatusMap`/`fetchRawPipelineLists`), with a
    one-call-per-pipeline backfill (`backfillUnderContract`) for the "Under Contract" gap
    `getPipelineList` always has for Lead/Inventory, and `mainStatusTitle` text as a fallback
    only for "Sold" (no module to query at all — `classifyOneRecord`). A null/blank address is
    always skipped, never guessed; a record's `url` is always left `null` here so the caller
    preserves whatever the CSV import already stored, exactly like `moduleId`. `pipelineOrderFromRaw`
    builds the live `{key,label,stages}` pipeline order from the same `getPipelineList` data
    buildStatusMap used, filling the Under Contract/Sold gaps from the hardcoded
    `RESIMPLI_PIPELINES` default. Still read-only: nothing here ever writes to REsimpli.
  - `api/_sync-core.mjs` — shared between the scheduled/manual sync and the webhook, so the two
    can't drift on how a change/review/apply is built: `readProperties()` (wraps
    `resimpli_sync_read`), `applySync()` (wraps `resimpli_sync_apply` — `review`/`pipelineOrder`
    left undefined means "leave what's already stored untouched", used by the webhook's
    single-lead path; the full sync always passes both explicitly), `buildResimpliChange()` (the
    one moduleId/url-preserving rule both paths use), and `computeFullDiff()` (the full
    properties-vs-REsimpli diff, used as-is by the scheduled/manual sync and by the webhook when
    it can't narrow to one lead).
  - `api/resimpli-sync.mjs` — `POST /api/resimpli-sync { dryRun }`. Three callers: Vercel Cron
    (daily on the Hobby plan — see `vercel.json` — sends `GET` with
    `Authorization: Bearer $CRON_SECRET`), an outside scheduler if Kyle wants more often without
    upgrading to Vercel Pro (same header, GET or POST — the handler only checks the header, not
    the method), and the Properties page's "Sync Now" button (`POST`, sends the Supabase access
    token, checked against the `kyle@nexushomesoh.com` allowlist — same pattern as the existing
    `manage-lenders` edge function — and honors `dryRun` from the body). A cron/scheduler call
    always applies for real — no dry run, nothing to preview to.
  - `api/resimpli-webhook.mjs` — `POST /api/resimpli-webhook?secret=<RESIMPLI_WEBHOOK_SECRET>`
    (or header `X-Resimpli-Webhook-Secret`). An endpoint a REsimpli automation can call on a
    single lead's stage change. REsimpli sends these only from automations set up by hand in
    REsimpli (max 10 per account), with no request signature, so the shared secret is the only
    gate. **No REsimpli automation has been created to call this yet**, and REsimpli's webhook
    payload shape is NOT verified (unlike the rest of the contract above) — so the payload is
    treated as a **hint only**: `extractLeadId` pulls a lead id from several plausible field
    names if one's there, and `syncOneLead` re-fetches the real record via `/lead/details` and
    runs a guarded single-property update from THAT, never trusting payload fields like
    address/stage directly. If no id can be found anywhere in the payload at all, it just runs
    `computeFullDiff()` + `applySync()` (a full sync) instead. The raw payload is logged (no
    secrets in it to redact) so its real shape can be confirmed once an automation actually
    calls this.
- **Matching**: both the scheduled/manual sync and the webhook call the same shared
  `matchResimpliRecords` from `resimpli-shared.mjs` used by the CSV import — same leadId-first,
  then-normalized-address rules, same combined-address/directional handling, same
  never-guess-on-ambiguity behavior.
- **Review list**: unmatched/ambiguous REsimpli records go to `data.resimpliReview` (see Data
  Shape above), shown in a dismissible "⚠️ REsimpli Review" card at the top of the Properties
  page (`ResimpliReviewCard`, visible to everyone — pure reference data — but the Dismiss button
  is gated `!readOnly`). The scheduled/manual sync fully recomputes this list every run, so a
  since-resolved ambiguity naturally drops off; the webhook never adds to it (a single-lead hit
  that can't resolve cleanly is just dropped — it'll show up on the next full sync instead).
- **Safe writes — the database layer**: neither Vercel function ever reads or writes
  `nexus_data` with a bare `.from('nexus_data')` call. Both go through two Postgres functions
  defined in **`supabase/resimpli_sync.sql` (written to the repo, NOT applied to Supabase yet)**:
  - `resimpli_sync_read(secret)` — returns only `{id, address, resimpli}` per property. No loan,
    lender, fund, draw, or money field is ever returned by it.
  - `resimpli_sync_apply(secret, changes, review, synced_at, pipeline_order)` — the **only**
    write path (`review`/`pipeline_order` are each optional/nullable — the webhook's
    single-lead path passes both as null, since one lead has nothing new to report about
    either, and null leaves whatever's already stored untouched rather than clearing it). It
    rebuilds the properties array IN THE SAME ORDER (the Manual drag-sort tab depends on
    this), copying every property through unchanged except that a property whose id appears in
    `changes` gets `jsonb_set` applied to just its `resimpli` key, then separately sets
    `data.resimpliReview`, `data.resimpliLastSyncedAt`, and `data.resimpliPipelineOrder`. Before
    writing anything it: locks the row (`SELECT ... FOR UPDATE`, so a concurrent client save
    can't interleave — see the concurrency note at the bottom of the SQL file), confirms
    exactly one row exists for `org_id='nexus-homes'`, rejects a `changes` array with a
    duplicate id or an id that isn't an actual property, and then re-verifies the rebuild
    itself — property count unchanged, every position's non-resimpli fields AND id unchanged,
    every other top-level key unchanged — raising an exception (writing nothing at all) if any
    of that doesn't hold, rather than trusting the rebuild query to have done the right thing.
    Tested directly against a local Postgres instance (every guard, including the row lock)
    before being left for Kyle to review.
  - Both are `SECURITY DEFINER` (bypass RLS) but refuse (raise an exception, write nothing)
    unless their `secret` argument matches a value stored in a new `resimpli_sync_config` table
    — which has RLS enabled with **zero policies**, so nothing can read or write it through the
    normal Supabase client at all, only these two functions. That stored value is meant to match
    a new env var, `RESIMPLI_SYNC_SECRET` — a database-layer secret, intentionally separate from
    `CRON_SECRET`/`RESIMPLI_WEBHOOK_SECRET` (which only gate the Vercel functions), so that
    possessing the public anon key alone still can't trigger a write. **This was Kyle's own
    ask — a narrow database function instead of adding the Supabase service role key** — see
    the SQL file's own comments for exactly what to run and in what order.
- **Guard, client-side**: `assertOnlyResimpliChanged(oldData, newData)` (in
  `resimpli-shared.mjs`) is the same kind of last-line check on the browser side — used before
  the CSV import's `update()` call — throwing if anything other than `property.resimpli` or the
  top-level `resimpliReview`/`resimpliLastSyncedAt`/`resimpliPipelineOrder` keys
  (`RESIMPLI_MANAGED_KEYS`) would change. It's not expected to ever fire given how the import's
  next-state is built, but aborts instead of silently writing if it somehow would. The server
  sync does NOT call this — `resimpli_sync_read()` deliberately never returns a property's
  non-resimpli fields at all, so there's nothing to diff against; its equivalent guarantee is
  structural instead (see `resimpli_sync_apply()` above).
- **Live pipeline order**: once a sync has actually run, `data.resimpliPipelineOrder` holds
  REsimpli's live-fetched stage order (from `fetchPipelineOrder()` above) in the same
  `{key, label, stages}` shape as the hardcoded `RESIMPLI_PIPELINES` default. `PropertiesPage`
  builds `pipelineIndex = data.resimpliPipelineOrder ? buildPipelineIndex(data.resimpliPipelineOrder)
  : undefined` once, near the top of the component (before `visible`, since several `.sort()`
  calls run as soon as it's defined), and threads it through every `stageSortKey`/
  `resimpliStageLabel`/`pipelineForRecordType` call and into `<ResimpliBadge pipelineIndex=.../>`
  — each one defaults to the hardcoded order via its own default parameter when `pipelineIndex`
  is `undefined`, so nothing breaks before the first sync has ever run.
- **"Last synced" + "Sync Now"**: shown on the Properties page toolbar (gated `!readOnly`).
  "Sync Now" opens `SyncNowModal`, which always runs a **dry run** first (`dryRun:true` —
  computes and shows the diff without writing anything), then a separate **Apply** step the
  user has to click explicitly.
- **Env vars** (server-side only — `api/*.mjs` — never `VITE_`-prefixed, never imported by
  client code): `RESIMPLI_API_KEY`, `CRON_SECRET`, `RESIMPLI_WEBHOOK_SECRET`, and the new
  `RESIMPLI_SYNC_SECRET` proposed above. See `.env.example`.
- **Cron schedule**: `vercel.json` runs the sync once daily at 9:00 UTC (4am ET) —
  the Vercel Hobby plan only allows daily crons; an hourly schedule was tried first and failed
  preview deploy. More often needs either Vercel Pro or an outside scheduler hitting
  `/api/resimpli-sync` with the same `CRON_SECRET` bearer header (GET or POST both work) —
  Kyle's call, not yet decided.
- **Vercel Cron only runs on Production deployments, not Preview** — so even once deployed to a
  preview branch, the scheduled sync literally cannot fire until this is merged to the
  production branch. The manual "Sync Now" button and the webhook both work on Preview, though.
- **HOLD**: as of 2026-11-14, none of this (this section, `api/`, or `supabase/resimpli_sync.sql`)
  has been pushed to `claude/build-deploy-app-BIdEz` or applied to Supabase — see the session's
  reply for the exact commit/branch state, backup location, and rollback steps. Don't deploy or
  apply the SQL without checking that HOLD is still in effect.

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
