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
  resimpli-shared.mjs      ← pure REsimpli pipeline/stage/matching logic, shared with api/*.mjs
  loan-schedule-shared.mjs ← pure loan balance/interest/billing-schedule math, shared with api/*.mjs
  whiteboard-forecast.mjs  ← pure Whiteboard forecast arithmetic/date logic, shared with api/*.mjs
api/
  resimpli-sync.mjs, resimpli-webhook.mjs, _resimpli-client.mjs, _sync-core.mjs ← REsimpli live sync
  mercury-balance.mjs, sell-dates.mjs, upcoming-buys.mjs, _google-sheets-client.mjs ← Whiteboard forecast
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
writes to `nexus_data` in bulk (e.g. the REsimpli live sync) — see `exportBackup` near the
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
  resimpliReview: [],  // REsimpli records that are ambiguously matched to a tracker property
                       // (2+ candidates either way) — shown in a dismissible "⚠️ REsimpli
                       // Review" card on the Properties page. {id, kind:"ambiguous", record,
                       // candidateAddresses, detectedAt}. A REsimpli record with NO matching
                       // tracker property at all is dropped, not stored here — Kyle's call:
                       // the sync only pulls data for properties already in the tracker, and
                       // with ~3,500 REsimpli records against a much smaller tracker, that
                       // bucket would run into the thousands and isn't actionable anyway
                       // (nothing to pick between). Fully recomputed by every scheduled/
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
  `resimpliStageLabel`, `stageSortKey`, `effectiveGroupingResimpli`, `groupedStageSortKey`,
  `normalizeAddressForMatch`, `expandCombinedAddress`, `propertyAddressKeys`,
  `matchResimpliRecords`, `assertOnlyResimpliChanged`. Don't re-implement any of this
  elsewhere — import from here. `effectiveGroupingResimpli`/`groupedStageSortKey` are used
  only by `Tracker.jsx` (see "Rental folds into Inventory" below) — the server sync never
  imports them, so none of this changes sync behavior.
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
  is `inventory`/`rental`/`sold`) are still stored **separately** (a CSV row carries only one
  id type per row; importing one never clobbers the other id already on file for that
  property — see `confirmImport` in `ImportResimpliModal`, and the same preserve-the-other-
  field pattern in `PropertyForm`'s save path and in `_sync-core.mjs`'s `buildResimpliChange`).
  But **matching itself no longer requires them to line up**: `storedIdsFor(property)` (in
  `resimpli-shared.mjs`) collects every id a property has on file — `leadId`, `moduleId`, AND
  any id parsed from the property's stored `resimpli.url` query string (`inventoryId`,
  `leadsId`, `soldId`, `leadId`) — and `matchResimpliRecords` matches a REsimpli record against
  ANY of them, regardless of the record's own `idType`. This matters because a CSV-imported
  inventory row stores its `inventoryId` in `leadId` (not `moduleId`) and in the URL, while
  `classifyOneRecord` (the live sync's classifier) always reports `idType:"lead"` with the
  REsimpli lead `_id` — without this, a property's stored inventory id would never match
  anything the live sync reads back for it. The live sync can still only ever discover/refresh
  `leadId` directly — a property matched only via a `moduleId`/URL id stays matched on address
  (or on that id, once found) until/unless the lead is created/found in REsimpli too.
- **Combined addresses** (e.g. "3126 & 3134 Wessex Ct") and **directionals**:
  `normalizeAddressForMatch` drops directionals (N/S/E/W/NE/NW/SE/SW and the spelled-out forms)
  wherever they appear in the street line, not just leading, and strips unit/apt/suite/ste/
  **lot**/# tokens — so "902 Dayton Ave Nw # 52pt" and "902 Dayton Ave #52" normalize
  identically, and so does "100 Main St SW Lot 7" against "100 Main St # 7" (`lot` was added
  to the same strip-this-and-everything-after list as `apt`/`unit`/`suite`/`ste`, after a real
  property went unmatched because REsimpli used `Lot 7` where the tracker's CSV-imported
  address used `# 7`). This is deliberate even though it can make two genuinely different
  addresses collide (e.g. "123 N Main St" vs "123 S Main St") — when that happens, the normal
  2+-candidates ambiguity check already sends them to review instead of guessing, which is
  exactly the wanted behavior. `expandCombinedAddress` is applied to **both sides** of a
  match — `propertyAddressKeys` for a tracker property, `recordAddressKeys` for a REsimpli
  record — and a match is made whenever ANY of one side's expanded/normalized keys equals ANY
  of the other's. Both-sides expansion matters because REsimpli can have a SINGLE record whose
  own address is combined ("3126 & 3134 Wessex Ct") — normalizing that as one run-together key
  ("3126 3134 wessex ct") never equaled either half of a combined tracker property's two
  separately-expanded keys, so it used to go unmatched; now both sides expand the same way and
  it matches cleanly. REsimpli having **two separate** records, one per half, still moves both
  to `ambiguous` instead of either being picked — see `matchResimpliRecords`'s reverse-
  collision pass below.
- **Reverse-collision tie-break**: when 2+ distinct REsimpli records each independently
  resolve to the SAME property as their one address/id match (REsimpli has a stale Lead
  record AND a current Inventory record for what's really one property, say), `pickWinner`
  (in `resimpli-shared.mjs`) tries to settle it instead of sending straight to review — first
  by id (a record whose id is among the property's own `storedIdsFor`, regardless of the
  record's `idType`), then, if that doesn't settle it, by preferring a single `"inventory"`
  record over anything else (a plain Lead doesn't win over Inventory — Kyle's call). Only
  when NEITHER settles it (e.g. two leads, or two inventory records, with no id match) do all
  of that property's candidate records move to `resimpliReview` as `ambiguous`.
- **Rental folds into Inventory for sort/filter/grouping** — there's no separate Rental
  position or column anywhere properties are sorted, filtered, or grouped by stage.
  `effectiveGroupingResimpli(resimpli)` (in `resimpli-shared.mjs`) maps a `"rental"`-recordType
  property onto its Inventory-pipeline equivalent, matched case-insensitively with extra
  whitespace collapsed: `New Rental`→`New Inventory`, `Under Rehab`→`Under Rehab`, `Ready to
  Rent`/`DSCR in process`→`Rehab Complete`, and any OTHER rental stage (`Rented`, `Lease Ending
  Soon`, `Eviction In Progress`, `TURN/NEEDS RENTED`, or anything not explicitly listed) also
  falls back to `Rehab Complete`. This is purely a sort/filter/grouping position — it never
  touches stored data, and it never changes what a stage is LABELED: `resimpliStageLabel`/
  `pipelineForRecordType`/`stageSortKey` themselves are untouched and still reason about the
  real `"rental"` recordType, so `ResimpliBadge` and the filter dropdown's option text keep
  showing a property's actual REsimpli stage (e.g. still "Rented (Rental)" when that name is
  ambiguous) — only where it sorts/groups changes. `groupedStageSortKey(prop, index)` wraps
  `stageSortKey` with this mapping; use it (not the plain `stageSortKey`) for anything
  sort/filter/group-related on the Properties page.
- **Sort**: `groupedStageSortKey(prop)` returns a sortable string — pipeline first (Lead,
  Inventory (now absorbing Rental), Sold, in that order, via `pipelineForRecordType`), then
  stage within that pipeline's own order, then any stage REsimpli doesn't list (alphabetically,
  within its pipeline), then a stage with no known pipeline (alphabetically), then no stage at
  all (always last) — wired into `propSortMode==="stage"` in both places `PropertiesPage`
  computes sort order (`visible`'s own sort AND the separate `rankMap` sort), so the two stay in
  sync. The condensed table's clickable "Stage" column header reuses the same key.
- **Filter**: a plain `<select>` next to the sort controls — "All Stages", then only the
  (recordType, stage) pairs actually present on an active property, in `groupedStageSortKey`
  order (so a rental property's filter option now sorts near its mapped Inventory stage, not in
  a separate Rental block), labeled via `resimpliStageLabel` using the property's REAL
  recordType/stage (so "Under Contract (Lead)" and "Under Contract (Inventory)" still show as
  two distinct, correctly-filtering options, and a rental stage still reads as e.g. "Rented
  (Rental)") — then "No stage". The filter's value is a composite `"<recordType>::<stage>"`
  string (`"_"` standing in for no recordType) built from the property's real recordType/stage,
  never the grouped one — never the bare stage name either, for the same ambiguity reason.
  Persisted via `usePersistedState("nx-propStageFilter")`.
- **Pipeline view**: a fourth Properties-page view mode (toggle icon "Ⅲ", next to condensed/
  grid/expanded), mirroring REsimpli's own Inventory Grid (kanban). Built from `pipelineColumns`
  (computed alongside `stagesPresent`/`visible`, so the existing search/stage filter apply
  here too): one column per Inventory stage (always shown, even empty, in REsimpli's order,
  via `pipelineForRecordType("inventory").stages`), then "Other Inventory" (a rental or
  inventory property whose mapped/actual stage doesn't match any of those seven — shouldn't
  normally happen for rental, since `effectiveGroupingResimpli` always resolves to one of them
  or falls back to "Rehab Complete"), "Lead: Under Contract", "Sold", and "No stage" — all four
  hidden when empty. **There is no separate Rental column** — a `"rental"`-recordType property
  is routed into whichever Inventory column `effectiveGroupingResimpli` maps it to, exactly
  like a real Inventory property. Each card shows the address, the REsimpli link when on file,
  and the same funded/needed/shortage-or-surplus figures the other views already compute
  inline; clicking a card opens the same property detail panel as every other view. No
  drag-and-drop between columns and no write of any kind — REsimpli's stage is read-only
  reference data here, exactly like the badge elsewhere on this page. Once the live sync
  (below) starts storing the live pipeline order, this view (and sort/filter above) will use
  that instead, falling back to the hardcoded `RESIMPLI_PIPELINES` default.
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
- **Review list**: only **ambiguous** matches go to `data.resimpliReview` (see Data Shape
  above) — a REsimpli record with no matching tracker property at all is dropped by
  `computeFullDiff()` in `_sync-core.mjs`, never stored (Kyle's call: the sync only pulls data
  for properties already in the tracker; `noPropertyMatch` is REsimpli's own pipeline noise
  from this app's point of view, and at REsimpli's real record count that bucket would run
  into the thousands with nothing for Kyle to actually do about any of it). Shown in a
  dismissible "⚠️ REsimpli Review" card at the top of the Properties page
  (`ResimpliReviewCard`, visible to everyone — pure reference data — but the Dismiss button
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
    before being left for Kyle to review. `jsonb_set` is itself STRICT, so building a change's
    `resimpli` value via a bare `c.value->'resimpli'` would return SQL NULL — and silently
    poison that property's rebuild, tripping the mismatch self-check and blocking the ENTIRE
    sync — for a change whose `resimpli` key is missing or JSON null (e.g. a lead whose stage
    just cleared). Wrapped in `coalesce(c.value->'resimpli', 'null'::jsonb)` so that case just
    clears that one property's `resimpli` instead of blocking every future run. `applySync()`
    in `_sync-core.mjs` logs this RPC's exception text via `console.error` on any failure (pure
    structural text — property counts, which check failed, an invalid secret — never an
    address or a secret value) so a blocked run shows up clearly in the Vercel function logs,
    whichever caller (cron, the GitHub Actions trigger, "Sync Now", or the webhook) hit it.
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
  preview deploy. `/api/resimpli-sync` is also triggered every 15 minutes by
  **`.github/workflows/resimpli-sync.yml`** (GitHub Actions, on Kyle's own account — no Vercel
  plan upgrade needed), which just does a guarded `curl -X POST` with the same
  `Authorization: Bearer $CRON_SECRET` header the Vercel Cron path checks — it carries no
  REsimpli/Supabase logic itself; every actual write still only happens if the endpoint's own
  auth check and `resimpli_sync_apply()`'s hard self-check (see above) both pass, exactly as
  they would for the daily Vercel Cron run. No-ops entirely if the `CRON_SECRET` **repository
  secret** isn't set on GitHub (Settings → Secrets and variables → Actions — same value as the
  `CRON_SECRET` env var on Vercel), fails the whole job loudly on a non-2xx response, and logs
  only `matched`/`changed`/`review` counts (no addresses, no secrets).
- **Vercel Cron only runs on Production deployments, not Preview** — the daily sync can only
  actually fire once this merges to `claude/build-deploy-app-BIdEz` (Production).
- **Live status**: as of 2026-11-15, Kyle approved go-live. `supabase/resimpli_sync.sql` has
  been applied to the production Supabase project, `resimpli_sync_config` holds the real
  `RESIMPLI_SYNC_SECRET`, and this section/`api/`/the SQL have been merged into
  `claude/build-deploy-app-BIdEz`. The `CRON_SECRET` **GitHub repository secret** is not set
  yet, so `.github/workflows/resimpli-sync.yml`'s 15-minute trigger no-ops until it is — the
  daily Vercel Cron and the manual "Sync Now" button both work regardless.

## Whiteboard Cash-Flow Forecast
Built on branch `whiteboard-cashflow-forecast` (off `claude/build-deploy-app-BIdEz`), Kyle
approved 11/16 — **not merged to the live branch yet**, pending his review of the preview.
Auto-generated, read-only sell/buy cards layered onto the existing manual Whiteboard (see
"Whiteboard" tab in the component map) — nothing here writes loans/balances/rates/terms/
payouts/lenders/properties; the only new persisted field is `whiteboard.payingBack`
(`{[propId]: {[loanId]: true}}`, a per-property "pay this private loan back at closing instead
of rolling it" checkbox, set from `WhiteboardSellCard`).
- **Pure logic lives in `src/loan-schedule-shared.mjs`** (the real hard-money billing schedule
  — `hardPaymentSchedule`, `calcBalance`, `calcMonthlyPaidPortion`, `calcIntEarned`, plus their
  small dependencies, extracted verbatim from Tracker.jsx the same way `resimpli-shared.mjs`
  was) and **`src/whiteboard-forecast.mjs`** (sell-amount arithmetic, REsimpli text/date
  parsing, running-balance/shortfall math) — both dependency-free `.mjs` modules, unit-tested
  with plain Node, imported by Tracker.jsx and by the server-side `api/*.mjs` functions below.
  `addHardPayments` (inside `computeHistoryEvents`) is now a thin wrapper around
  `hardPaymentSchedule` — same History-tab output as before, `loanId` still keyed off the
  schedule's `rawDate` (unshifted 1st-of-month), not the weekend-shifted `date`, so no
  existing event's identity changed.
- **Loan card fix**: `calcIntEarned(l, asOf, data)` takes an optional third `data` arg — when
  passed, a `monthly_rate`/`monthly_fixed` loan's figure sums the real `hardPaymentSchedule`
  (draws included) instead of the old principal-only continuous accrual. Every pre-existing
  call site still omits `data` and is unchanged; only the Properties page's expanded loan row
  (the one Kyle flagged) passes it. Other `calcIntEarned` call sites (LenderDetailPage totals,
  AllLoansPage, LoanDetailPage, Dashboard) were deliberately left on the old estimate — out of
  the requested scope.
- **Starting cash — Mercury**: `api/mercury-balance.mjs` reads `MERCURY_API_TOKEN` and returns
  the "Master" checking account's (••3564) balance. Falls back to the existing manual
  `whiteboard.startingBalance` input (with an on-screen note) if the token's missing or the
  call fails — never crashes. Mercury's exact response shape here is built from their public
  docs, not verified against a live call from this session.
- **Money in — selling**: tracker properties under contract to sell. `isInventoryResimpli(p)`
  (Tracker.jsx, Whiteboard section) treats a property as Inventory when either
  `resimpli.recordType==="inventory"` OR `resimpli.url` contains `"/inventory/"` — live data
  showed a property can be a real sell-side Inventory record with `recordType` still `null`
  (an old sync run, or the gap `backfillUnderContract` below didn't always close), so the URL
  check catches those too. Combined with `resimpli.stage==="Under Contract"` (the literal
  sell-side pipeline stage, not the rental-folded sort/group mapping). `api/sell-dates.mjs`
  takes `{id,address,leadId}` for each from the browser (the Whiteboard already has live
  property data; this endpoint's only job is a credential-gated lookup) and matches them
  against the Dashboard Bot Office Dashboard Google Sheet (id
  `1sLr3xx99bjWgE8njqfg84arzgHUmHoJaetmSji6TDD8`, tab "Properties", column `Sell_ClosingDate`)
  via a service-account JWT (`GOOGLE_SERVICE_ACCOUNT_JSON`, `api/_google-sheets-client.mjs` —
  Node's built-in `crypto` signs the JWT, no googleapis dependency added), reusing
  `normalizeAddressForMatch` from `resimpli-shared.mjs`. Falls back to REsimpli's
  `analyticsInfo.assignmentContractDate` when the sheet has no date for a property; "needs
  info" only when neither has one. **If the Sheet itself can't be read at all** (missing/
  invalid `GOOGLE_SERVICE_ACCOUNT_JSON`, confirmed live: `"GOOGLE_SERVICE_ACCOUNT_JSON is not
  set"`, or any other Sheets API error) — a bug fixed Nov 16 4:34pm: this used to abort the
  whole request and send every selling property straight to Needs Info, skipping the REsimpli
  fallback entirely. `readSheetDateMap()` now catches that failure on its own, and the
  per-property loop still tries the REsimpli fallback for every property regardless of why the
  sheet had no date for it (`resolveSellDateRow(prop, {sheetHit, fallbackDate,
  sheetConnected})` — the pure decision, unit-tested directly); a property lands in Needs Info
  only when the fallback also has nothing. The response carries `sheetConnected`/`sheetError`,
  and the Whiteboard shows an amber board-level note naming `GOOGLE_SERVICE_ACCOUNT_JSON` when
  `sheetConnected` is false. The sheet's "Dashboard Status" tab has a cell literally labeled
  "Last Checked" with an adjacent value like `"2026-11-16 14:11:12"` (no "T", no timezone — a
  plain America/New_York wall-clock string, confirmed against live data) — parsed via
  `etLocalStringToUtcIso` (`whiteboard-forecast.mjs`, the DST-correct reverse of
  `etEpochToDateStr`) and shown on the Whiteboard page as "last checked \<time\> (Xh ago)",
  flagged amber when over 26h old (skipped entirely while the sheet is disconnected — nothing
  to check). The sell card's day is `saleDate` + 1 business day (the
  existing inflow-clearing rule, applied once up front since this card is placed automatically
  rather than dragged); amount = `sellCashAmount()` (`whiteboard-forecast.mjs`) = purchase
  price − every active hard loan's principal (draws excluded — cash close) − every **checked**
  private loan's principal (unchecked, including the 0%-rate internal Nexus lines, assumed to
  roll) + hard-money interest already paid through the sale date — summed directly from
  `hardPaymentSchedule(loan, data, saleDate)`'s own payments (NOT `calcIntEarned`, which for a
  `paymentType:"closing"` hard loan returns interest still accruing toward closing, not yet
  paid — adding that back would double-count interest the sell formula must never include, per
  its own "never interest paid at closing" rule). `WhiteboardSellCard`'s expandable breakdown
  lists each piece plus a "paying back?" checkbox per private loan.
- **REsimpli sync — Inventory "Under Contract" classification**: `getPipelineList`'s own gap
  (no "Under Contract" status for Lead/Inventory — see "REsimpli Live Sync" above) is bridged
  by `backfillUnderContract`, which calls `/lead/details` on a sample record — that call used
  the same wrapper-unwrap bug fixed below, so it silently found nothing for Inventory on at
  least one real sync run, leaving `recordType:null` on under-contract sell properties.
  `applyKnownUnderContractIds` (`api/_resimpli-client.mjs`, used by both the full sync's
  `buildStatusMap` and the webhook's single-lead path) now also seeds two confirmed, hardcoded
  `mainStatusId`s — `6aa4dcfad18014f8fc6397f5` (Lead pipeline's Under Contract) and
  `6aa4dcfad18014f8fc6397d4` (Inventory pipeline's own, distinct Under Contract) — but only to
  fill a gap neither the raw pipeline lists nor the live backfill already resolved, so it never
  overrides a real discovered mapping.
- **`/lead/details`' real response shape — now verified against live data** (Kyle, Nov 16):
  `{statusCode, data:{leadData}}`, not the `{leadData}` shape every caller originally guessed —
  `unwrapLeadDetails`/`fetchLeadDetails` (`api/_resimpli-client.mjs`) fixed to unwrap
  `data.leadData` first (old guessed paths kept only as a harmless fallback). This was silently
  breaking the webhook's single-lead classification too (an address-less record always failed
  `classifyOneRecord`'s guard), not just the sync's backfill above. The unwrapped `leadData`'s
  custom-question answers live at `leadData.questions.preferenceAnswers[]` as
  `{questionId, value}` (`findCustomAnswer`, `api/upcoming-buys.mjs`), and its investment type
  is the top-level `leadData.investmentTitle` field (`investmentTypeOf`) — NOT a field named
  `investmentType`, which doesn't exist and was silently always `null`, letting every lead
  (wholesale included) through.
- **Money out — buying**: `api/upcoming-buys.mjs` reads REsimpli leads via the existing
  `fetchAllRecords`/`fetchLeadDetails` helpers, filtered to `mainStatusId
  "6aa4dcfad18014f8fc6397f5"` (Under Contract) and `investmentTitle` matching Fix and Flip or
  Rental — a lead with no investment type set, or any other value (wholesale included), is
  silently out of scope, never "needs info". The pure per-lead decision is
  `classifyBuyLead(lead, details, today)`, returning `{row}` / `{needsInfo}` / `{skip:true}`.
  Amount parses the "Cash Needed for Closing" custom question (`parseCashAmount` — robust
  free-text $ parsing). Date is normally the soonest of `analyticsInfo.closingDate` (ms epoch;
  converted via the real America/New_York timezone, not a hardcoded UTC offset, so DST doesn't
  shift the day — `etEpochToDateStr`) and the "Closing Date on Contract" custom question
  (`normalizeDateText` — handles `YYYY-MM-DD`, `MM/DD/YYYY`, and `"Mon D, YYYY"`/
  `"Month D, YYYY"`, e.g. `"Nov 21, 2026"`) — **except** when the contract-date answer has
  already slipped into the past while `analyticsInfo.closingDate` is still today or later
  (`contractIsStale` in `classifyBuyLead`): that's treated as the deal having been extended, so
  the analytics date is used instead of excluding the lead (3434 Reaver: contract date 10/28
  already past, REsimpli's own analytics date 11/20 still upcoming → scheduled on 11/20, not
  sent to Needs Info). Either way, whenever the two source dates differ, the resulting row (or
  needsInfo entry) carries BOTH (`dateFromAnalytics`/`dateFromContract`), and
  `WhiteboardBuyCard` shows both with "— using \<date\>" so Kyle sees the full picture rather
  than either date being silently dropped. A missing/unparseable cash figure, a missing date,
  or a date still past after the extension check goes to "needs info", never the forecast.
- **Forecast view**: a 45d/90d window toggle; `computeForecastSummary` (`whiteboard-
  forecast.mjs`) returns the running balance per day plus first shortfall, largest shortfall,
  and the date it's positive again, shown as stat tiles. A day's balance goes negative in red.
  The headline Total In/Out tiles only count a card whose actual settlement day
  (`wbEffectiveDate`) falls inside the visible window — `withinWindow` (`whiteboard-
  forecast.mjs`) is the one shared, tested filter both the totals and (indirectly, via
  `netFor`) the running balance use, so they can't drift from each other. A "Needs Info" panel
  lists every excluded sell/buy deal and why. Auto cards (`WhiteboardSellCard`/
  `WhiteboardBuyCard`, alongside the existing `WhiteboardPaymentCard`) are visually distinct
  from manual cards and can't be edited or dragged.
- **Hard-money monthly payment amounts now include funded draw interest** — both the
  Dashboard's "💸 Hard Money — Due 1st of Month" card and the Whiteboard's 1st-of-month auto
  loan-payment cards used `monthlyLoanPayment(loan)` (a flat `principal × rate ÷ 12` estimate
  that ignores any rehab draw facility entirely). `scheduledLoanPaymentFor(loan, data, first)`
  (Whiteboard section, used by both) instead takes `hardPaymentSchedule(loan, data, first)`'s
  own entry for that exact 1st-of-month date — the same draw-inclusive, lender-setting-aware
  math the History tab already uses — falling back to the old flat `monthlyLoanPayment()`
  estimate only when the schedule has no entry yet for that month (e.g. still inside a grace
  period), so a loan that would otherwise show a card here never just silently loses it. A
  loan marked paid-at-closing (`paymentType:"closing"`) is unaffected either way — it was never
  in `monthlyLoanPayment()`'s scope and still isn't.
- **Tests**: a real test suite, checked into the repo at `tests/*.test.mjs`, run via
  `npm test` (`node --test tests/*.test.mjs`, Node's built-in test runner — no new dependency).
  54 tests across `loan-schedule-shared.test.mjs`, `whiteboard-forecast.test.mjs`,
  `upcoming-buys.test.mjs`, `resimpli-client.test.mjs`, `resimpli-shared.test.mjs` (the
  REsimpli matcher tests, now checked in rather than scratch-only), and `sell-dates.test.mjs`
  — covering, among other things, the exact Red Bank $78,089.68 sanity check, a checked
  private lender's principal being subtracted, free-text cash and "Nov 21, 2026"-style date
  parsing, the ET-midnight conversion across a DST boundary both directions (epoch→date and
  the Sheet's wall-clock string→UTC), soonest-date selection, a past-or-missing date routing to
  Needs Info (including the "both dates differ" case and the stale-contract-date-is-an-
  extension case, 3434 Reaver), the sell-dates sheet-unreachable-but-REsimpli-fallback-still-
  works case, the `/lead/details` wrapper unwrap and `preferenceAnswers` lookup,
  `investmentTitle` filtering (including the "no type at all" and wholesale cases), the
  draw-inclusive monthly payment exceeding the old flat estimate, and the window-filtered
  totals. All 54 pass as of this writing.
- **Setup still needed before this is usable**: `MERCURY_API_TOKEN` (a read-only Mercury API
  token for the Master account) and `GOOGLE_SERVICE_ACCOUNT_JSON` (the full service-account
  JSON key, shared as a Viewer on the Office Dashboard Sheet) — both server-side-only env vars
  on Vercel, see `.env.example`. Until both are set, the Whiteboard still works exactly as
  before (manual starting balance, no auto sell/buy cards, no "needs info" panel).
- **Live status**: merged into `claude/build-deploy-app-BIdEz` and live in production as of
  2026-11-16 (Kyle: "Go"). `MERCURY_API_TOKEN`/`GOOGLE_SERVICE_ACCOUNT_JSON` are set in Vercel
  for both Production and Preview.

### Whiteboard-only overrides (`data.whiteboardOverrides`)
Mark Closed, drag/tap-to-move dates, and "Set Aside" starting-cash adjustments — three
Whiteboard-only features (Kyle approved 11/16, shipped straight to production, no preview
branch). **HARD RULE**: all three live in their own top-level `data.whiteboardOverrides` key,
read and written ONLY by `WhiteboardPage` (and the pure helpers in `whiteboard-forecast.mjs`
it calls) — nothing else in the app (no other tab, no `api/*.mjs` function) ever references
it, enforced by a static-containment test (`tests/whiteboard-overrides-isolation.test.mjs`)
that fails the suite if the string `whiteboardOverrides` ever shows up outside
`WhiteboardPage()` in `Tracker.jsx` or anywhere in `api/` — **with one documented exception**:
`api/tv-data.mjs` (the public, no-login TV dashboard's read endpoint — see "Public TV
Dashboard" below) passes it straight through to the client untouched, read-only, same as
properties/unassigned/lenders/whiteboard, so `WhiteboardPage` — reached there via
`src/TvDashboard.jsx`, still the one and only place that actually interprets it — renders the
real Mark-Closed/moved-date/amount-override/No-Date-priority state instead of a stale picture.
The isolation test allowlists exactly that one file by name and separately asserts it contains
no write/RPC call that could mutate it; every OTHER `api/*.mjs` file still may never reference
it at all. It syncs like every other field —
no special plumbing — because the whole `data` blob already round-trips through Supabase as
one JSON column; it's additive (`{...d, whiteboardOverrides: {...d.whiteboardOverrides, ...}}`
at every level), so Undo/Redo and `applyMigrations`' generic `{...d, ...}` spread both already
handle it with zero special-casing.
```js
data.whiteboardOverrides = {
  closed: {                    // Mark Closed — keyed by the same auto-card id scheme
    "sell-<propId>": {kind:"sell", key:propId, address, amount, closedAt: isoString},
    "buy-<leadId>":  {kind:"buy",  key:leadId,  address, amount, closedAt: isoString},
  },
  movedDates: {                // drag/tap-to-pick date override, same id scheme
    "<cardId>": {date: "YYYY-MM-DD", originalDate: "YYYY-MM-DD"},  // originalDate pinned once
  },
  setAsides: [                 // Starting Cash "Set aside" list
    {id, label, amount, date: "YYYY-MM-DD"|null},
  ],
}
```
- **Mark Closed**: the "Closed" button on `WhiteboardSellCard`/`WhiteboardBuyCard` (never on a
  manual card or the auto loan-payment card). A closed item is pulled out of the forecast
  entirely — `filterClosed()` (`whiteboard-forecast.mjs`) drops it before `sellCardsFor`/
  `buyCardsFor`/the totals/the running balance ever see it — and listed instead in the
  "✅ Closed, waiting to confirm" panel (`WhiteboardClosedPanel`) with an Undo button per item.
  **Auto-clear**: a `useEffect` in `WhiteboardPage` removes a closed override by itself once
  the real data confirms it — a sell property gets `dateSold` or drops out of `sellingProps`
  (leaves Under Contract/Inventory), or a buy lead drops out of BOTH `buysResult.rows` and
  `buysResult.needsInfo` (truly leaves Under Contract — landing in `needsInfo` instead, e.g.
  for a missing cash figure, does NOT count as leaving) or its property now exists in the
  tracker (matched via `storedIdsFor`, same id-matching `resimpli-shared.mjs`'s REsimpli
  matcher uses). A no-op (no `update()` call) when nothing's stale, so it never fights an
  in-flight edit or loops.
- **Drag/tap to move a date**: `WhiteboardSellCard`/`WhiteboardBuyCard` each call
  `useDraggable({id:card.id})` themselves (same per-card pattern as the existing
  `WhiteboardBillCard`, since the dnd-kit hook can't be called from a parent's `.map()` loop),
  so they drop onto a day column through the SAME `DndContext`/`handleDragEnd` the manual
  cards use — `handleDragEnd` checks the dragged id's `sell-`/`buy-` prefix to route it to
  `setMovedDate()` instead of the manual-card `setCardDay()` path. The 📅 button on each card
  is the tap-to-pick-date fallback (a plain `<input type="date">`, toggled inline) — added
  because touch-dragging a card across a horizontally-scrolling day grid is unreliable on
  iPhone even with `touch-none` set; either path calls the same `setMovedDate()`.
  `applyMovedDate()` (`whiteboard-forecast.mjs`) overrides the card's `day` for forecast
  placement while keeping `sourceDate` as whatever the real source (REsimpli/the Sheet) says
  *right now* — so if that real date later changes, the card still uses the manual date but
  shows the new source date alongside it ("📌 Moved to \<date\> (source says \<date\>)"), per
  Kyle's spec. `originalDate` is pinned the FIRST time a card is moved and never overwritten by
  a later move, so "Reset" always restores the true original, not whatever it was most
  recently moved from.
- **Starting Cash → Set Aside**: money already sitting in the Mercury Master balance that's
  spoken for but hasn't left yet. An entry with no date is subtracted straight from the
  headline "available" figure (`availableCash()`); one with a date instead becomes its own
  dated outflow card (`datedSetAsideCards()` → `WhiteboardSetAsideCard`) that only affects the
  running balance on that day, leaving "available" alone. The summary line reads "Mercury $X
  (or Manual $X), set aside $Y, available $Z". `WhiteboardSetAsideModal` adds/edits one entry;
  each is deletable. The Mercury balance itself (`mercury.balance`) is only ever read, never
  adjusted by any of this.
- **Tests**: `tests/whiteboard-overrides.test.mjs` covers `filterClosed`/`applyMovedDate`
  (including the "source date changed since the override was set" case) /
  `undatedSetAsideTotal`/`availableCash`/`datedSetAsideCards`, plus explicit isolation checks
  that `hardPaymentSchedule`/`resolveLenderSettings`/`calcBalance`/`calcIntEarned`/
  `matchResimpliRecords`/`groupedStageSortKey` all return byte-identical results whether or not
  `data.whiteboardOverrides` is present. `tests/whiteboard-overrides-isolation.test.mjs` is the
  static-containment check described above.

### Board view — a running-balance ledger (Calendar ↔ Board toggle)
A second Whiteboard layout (Kyle, 11/17, shipped straight to production): a classic cash-flow
ledger table — DATE | ADDRESS | AMOUNT | NEW BALANCE (originally two separate IN (+)/OUT (−)
columns; Kyle asked 11/19 to combine them into one — see below), a "Current" starting-balance
row, a sticky header, a summary strip (lowest balance + its date, total in, total out, ending
balance), week subtotal rows, and a red highlight + "Need $X" on any day the balance goes
negative. Loosely inspired by Kyle's own physical office whiteboard, but built to cash-flow-
ledger best practices rather than copying it literally (no hand-drawn-style circles/"!!!").
**Computes nothing of its own and never calls `update()` directly** — `WhiteboardBoardView`/
`WhiteboardBoardRow`/`WhiteboardBoardEntry` (Tracker.jsx, declared just above `WhiteboardPage`)
never receive an `update` prop at all, enforced by `tests/whiteboard-ledger.test.mjs`. It IS
interactive (11/17, see "Board view interactivity" below) — but strictly through named
callback props (`onPickDate`/`onSetAmount`/`onMarkClosed`/etc.) owned and written by
`WhiteboardPage` itself, never a direct write from inside these three components.
- **Toggle**: `["calendar","board"]` buttons next to the existing 30/45/90-day range toggle (a
  30-day option was added alongside the existing 45/90, per this same request) —
  `boardView` is `usePersistedState("nx-whiteboardView","calendar")`, i.e. `localStorage` only,
  never written to `data`/Supabase (same per-device "remember my last choice" pattern as
  `nx-propSortMode` etc. elsewhere in the file) — confirmed by its own test.
- **Exact same data and rules as Calendar — guaranteed by construction, not by re-deriving
  the math a second time.** `WhiteboardPage` builds one `entriesByDay[day]` array (manual cards
  settling that day via `wbEffectiveDate`, `autoCardsFor`, `sellCardsFor`/`buyCardsFor` — which
  already have Mark Closed/moved-date overrides applied — and `setAsideCardsFor`) straight from
  the SAME per-day arrays `netFor`/the Calendar day columns already use, then calls
  `buildLedgerRows(dayCols, entriesByDay, balances)` — passing in `computeForecastSummary`'s own
  `balances` object UNCHANGED, never recomputing a running total independently. A ledger row's
  `balance` is therefore always the literal same number the Calendar view's own day column shows
  for that date; there is no second implementation of the running-balance math to drift from the
  first. `groupLedgerRowsByWeek`/`ledgerSummary` (both pure, in `whiteboard-forecast.mjs`) only
  aggregate what's already been computed — totals, the lowest-balance day, the ending balance.
- **Row display**: a day with no entries is skipped (matches the physical-whiteboard precedent
  of only writing down days something actually happens); a day with multiple entries lists each
  on its own line inside one row rather than string-joining addresses. Week-subtotal rows
  (`Fragment`-grouped, 7-day chunks starting from today) show that week's own IN/OUT totals.
  Every address shown is `shortAddress()`'d (`whiteboard-forecast.mjs` — just the street line,
  e.g. `"1323 Red Bank Dr, Columbus, OH 43215"` → `"1323 Red Bank Dr"`) so the narrow Address
  column never truncates mid-word; the full original string is still on a `title` tooltip via
  `fullLabel` on each `entriesByDay` entry. A day with more than 3 loan-payment lines (`kind:
  "loanPayment"` entries — Dec 1 can run 40+) collapses into one "▸ Loan payments (N)
  −$X" toggle row, collapsed by default, expanding to show each lender/property/amount
  (`groupLoanPaymentEntries`, `whiteboard-forecast.mjs` — a pure display split of the same
  entries `buildLedgerRows` already summed; it never touches the row's own netIn/netOut/
  balance, which still sum every entry regardless of how they're grouped for display).
- **Needs Info** still shows in Board view — it's the one existing, shared panel rendered once
  above the view-specific content (not duplicated per-view), so it never drifts from Calendar's
  copy either.
- **Tests**: `tests/whiteboard-ledger.test.mjs` — `buildLedgerRows` row balances matching
  `computeForecastSummary`'s own `balances` object field-for-field, each row's net matching the
  exact `netByDay` figure that produced it (including the Red Bank $78,089.68 case), week-chunk
  boundaries/subtotals, `ledgerSummary`'s lowest/totals/ending (including a forced-shortfall
  case and the zero-rows fallback), `shortAddress`/`groupLoanPaymentEntries` (including a
  46-entry grouped case proving the grouped subtotal is a strict subset of the row's own
  unaffected `netOut`), and the "never calls `update()` directly" guarantee (no `update` prop
  anywhere in the three Board components; the view toggle is `localStorage`-only).

### Board view interactivity (11/17)
Kyle: "allow me to drag the houses to different dates, manually change and add amounts,
manually add dates and amounts to stuff where it can't find that... also take it off the
timeline, and add stuff that's due with no date." All of it reuses the SAME
`data.whiteboardOverrides` mechanism (two new sub-keys below) and the same `markClosed`/
`setMovedDate` writers Calendar's cards already used — nothing new was added to the data
model's write surface, only new UI that calls what already existed, plus two small new override
types.
- **`amountOverrides`** (`{[cardId]: amount}`) and **`manualFill`**
  (`{[cardId]: {kind, key, address, amount, date}}`) — new `data.whiteboardOverrides` sub-keys.
  `applyAmountOverride(card, amountOverrides)` and `manualFillCards(manualFill, existingIds,
  kind, nextBusinessDayFn)` (both pure, `whiteboard-forecast.mjs`) compose with the existing
  `applyMovedDate` exactly like `manualDate`/`originalDate` do — a card can carry a manual date
  AND a manual amount at once, independently.
- **Editing a sell/buy entry** (Board's `WhiteboardBoardEntry`, and the same ✏️/📅 added to
  Calendar's `WhiteboardSellCard`/`WhiteboardBuyCard`): ✏️ inline amount edit
  (`setAmountOverride`/`resetAmountOverride`), 📅 tap-to-pick date (`setMovedDate`, same
  override Calendar's drag already used), plus Board-view-only drag-to-reschedule (its own
  `DndContext`, scoped to the ledger table — a separate render branch from Calendar's, so no id
  collisions). "Mark Closed" (✕) takes it off the timeline entirely, same as Calendar.
- **"Take off the timeline" extended to loan-payment and Set Aside lines** — `markClosed`/
  `undoClosed` were already fully generic (any `kind` string), so no new writer was needed, only
  new ✕ buttons in `WhiteboardBoardRow` calling them with `kind:"loanPayment"`/`"setAside"`, plus
  a bulk `excludeMany(entries)` ("Remove all") for a day's whole grouped loan-payment list in one
  `update()` call. Unlike sell/buy, these never auto-clear — there's no "real data confirms it"
  signal for a loan payment or Set Aside entry, so Kyle undoes those by hand from the "Closed,
  waiting to confirm" panel.
- **"Add stuff due with no date"** — the existing Unscheduled/Due Now manual-card system already
  supported a dateless card (`WhiteboardCardModal`'s "+ Add Card" always defaults a new card's
  `day` to `null`); Board view just didn't SHOW those lists. It now does, in a compact amber
  strip with a quick date-assign input (reuses `setCardDay`).
- **Needs Info "Fill in"** — a `manualFill` entry lets Kyle pencil in an amount+date for a
  property/lead the real data (REsimpli/the Sheet) has no date or amount for; it joins the
  forecast as a real synthesized card (same id scheme, `sell-<propId>`/`buy-<leadId>`) and
  auto-clears itself the moment a real card exists for that id (checked via `storedIdsFor`-style
  id matching against the UNMERGED real sell/buy arrays, so it can't be stale-cleared by itself).
- **📺 TV Mode** — a button on Board view that calls the browser Fullscreen API on just the
  ledger's own container (takes over the whole screen with ONLY that element, hiding the
  sidebar/nav/everything else automatically — no change to the Tracker shell needed) and
  switches to a denser layout (smaller padding/fonts, edit icons hidden) so a typical dataset
  fits without scrolling. Not a promise of zero scroll for an arbitrarily large dataset — the
  table body can still scroll on its own — just chrome-free and as dense as stays legible.
  **Summary tiles are now the same 4 in both Board view and TV Mode (11/17 → 11/19)** — Under
  $10k | Goes Negative | Total In | Total Out, only `compact` (TV Mode) changing the sizing
  (padding/font), not which tiles show. "Under $10k" (the date the balance first drops below
  that floor, or "✓ stays above") and "Goes Negative" (the date it first goes below $0, or
  "✓ never") each show a sub-label with the $ short/remaining that day, both from the same
  generalized `firstBelowThreshold(ledgerRows, threshold)` helper (called with `10000` and
  `0`), computed in `WhiteboardPage` and passed down as `firstBelow10k`/`firstNegative`. (This
  went through three shapes: first "Lowest Balance"/"Ending Balance" in Board view only, then
  TV Mode got its own distinct "Need to Find $X by \<date\>" + "Under $10k" pair, then that
  split into the current "Under $10k"/"Goes Negative" pair — Kyle, 11/19: "make the regular
  mode have the same headers as what TV mode has now," unifying both views on that last shape.
  `hasShortfall`/`ledgerSum.lowest`/`ledgerSum.ending` are no longer read by this component at
  all — `ledgerSummary()` itself is untouched and still computes/tests them, just unused here.)
- **Tests**: `tests/whiteboard-overrides.test.mjs` — `applyAmountOverride`/`manualFillCards`
  (composability with `applyMovedDate`, never duplicating an id that already has a real card,
  the next-business-day clearing rule). `tests/whiteboard-ledger.test.mjs`'s "never calls
  `update()`" check now also covers `WhiteboardBoardEntry`.

### A past-due sale/buy no longer silently vanishes from the forecast (11/17)
Kyle: "a house that closed yesterday but hasn't hit the account yet, I still want it to
reflect." The bug: a sell card's `day` is `nextBusinessDay(saleDate)` — if the REsimpli/Sheet
close date itself had already passed (the sale closed a few days ago but the cash still hasn't
hit Mercury), that computed day fell before TODAY, which is outside `dayCols` (always
TODAY..TODAY+windowDays) — so the card, and its whole amount, just disappeared from
`entriesByDay` with no trace: not in Needs Info, not anywhere. The buy side already routes a
past closing date to Needs Info server-side (`classifyBuyLead`'s `isPastDate` check), so this
was sell-only in practice, but both got the same fix for consistency.
- **`clampToToday(dateStr, today)`** (pure, `whiteboard-forecast.mjs`): a date before `today`
  is pulled up to `today` instead of left as-is. Applied to the sell card's computed `day`
  (`sellCardsInfo`) and defensively to the buy card's `day` (`buyCardsInfo` — never expected to
  actually fire there, since the server already excludes it, but kept consistent). The card
  carries `pastDue: day!==rawDay` so the UI can say so: `WhiteboardSellCard`/`WhiteboardBuyCard`
  show "⏰ closed/was due \<real date\> — showing today since it hasn't hit the account yet"
  (skipped if the card was ALSO manually moved — `manualDate` already shows its own note), and
  Board view's `WhiteboardBoardEntry` shows a small "⏰ overdue" badge. `card.breakdown.saleDate`
  (sell) / `card.date` (buy) still hold the true original close date throughout, so nothing
  about the real date is lost — only WHERE it's forecast-placed changes.
- **Tests**: `clampToToday` (no-op when on/after today, pulls a past date to today, no-op on a
  missing argument).

### Conservative "round to nearest $5k" display toggle (11/17)
Kyle: a toggle to round the Whiteboard's headline numbers for a built-in safety margin — a
current/running account balance and money coming IN round DOWN (assume you have/get less than
the real number), money going OUT rounds UP (assume it costs more) — and remember whichever way
it's set.
- **`roundDown5k(v)`/`roundUp5k(v)`** (pure, `whiteboard-forecast.mjs`): plain floor/ceil to the
  nearest 5000. `roundDown5k` alone correctly handles a SIGNED balance regardless of sign — a
  positive balance floors toward zero (smaller, i.e. more conservative), a negative balance
  floors further negative (a BIGGER deficit, i.e. still more conservative) — so the same
  function covers "balance" and "net" everywhere, including Calendar's per-day combined
  net-in-minus-net-out figure; only a pure positive expense/shortfall MAGNITUDE needs the
  separate `roundUp5k`.
- **`roundMode`** — `usePersistedState("nx-whiteboardRound", false)` in `WhiteboardPage`, the
  same remembered-per-device `localStorage` pattern as `boardView`/`nx-propSortMode` elsewhere
  (never written to `data`/`whiteboardOverrides` — it's a display preference, not real data) —
  so the choice survives switching Calendar ↔ Board and reloading the page. Toggled via a
  "↕ Round $5k" button next to the existing Calendar/Board and 30/45/90-day toggles, which
  applies to both views (it lives in the shared header above either one).
- **Scope: aggregate/headline totals only, never an individual card's own real amount** —
  applied to: Starting Cash/Mercury balance, the Set Aside summary line (balance/set-aside-
  total/available), First/Largest Shortfall, Total In/Total Out, Calendar's per-day
  balance/net tiles (`WhiteboardColumn`), and Board's Lowest/Ending Balance, Total In/Out,
  the "Current" starting-balance row, week subtotals, and each row's own netIn/netOut/balance/
  "Need $X" (plus the grouped loan-payments subtotal). A single house's sale price, a single
  loan payment, a single Set Aside line item, etc. always display exact — rounding is applied
  at the specific JSX call site for each headline figure (`rIn`/`rOut`/`rBal` helpers built from
  `roundMode` in `WhiteboardPage`/`WhiteboardBoardView`/`WhiteboardBoardRow`), never upstream in
  the actual `balances`/`ledgerSum`/`row` data, so every "short"/red-styling sign check still
  reads the TRUE unrounded number (flooring a value can't flip its sign, so this never
  disagrees with what's displayed).
- **Tests**: `roundDown5k`/`roundUp5k` (positive and negative balances, zero, an amount already
  on a $5k line).

### A manually moved sell date still clears next business day (11/17)
Kyle: "the dates that money comes in, it reflects that the money doesn't hit until the next
business day." Already true for every AUTO-placed inflow (`fcNextBusinessDay` on a sell card's
real close date; `wbEffectiveDate` on any manual "in"-direction card) — the one gap was a
manually dragged/picked sell date (`setMovedDate`, used by Calendar's drag + 📅 picker and
Board's drag + ✏️/📅), which stored the picked day exactly as given, with no clearing shift
re-applied. **`effectiveMovedDate(cardId, newDate, nextBusinessDayFn)`** (pure, `whiteboard-
forecast.mjs`) fixes this: a `sell-`-prefixed id gets `newDate` pushed to the next business
day before it's stored as the override (same as the original auto-placement); a `buy-`-
prefixed id (an outflow, no clearing delay asked for) is left exactly as picked. `setMovedDate`
in `WhiteboardPage` is the one caller — every drag/pick path (Calendar card, Board entry, Board
row drop) already funnels through it, so this one change covers all of them.
- **Tests**: `effectiveMovedDate` (sell shifts via the passed-in next-business-day function,
  buy passes through untouched — asserting the fn is never even called for a buy id).

### Unified "No Date" priority list (11/17)
Kyle: "can we put stuff with no date, or properties where we're unsure, on one no-date list
and sort it by priority?" Previously these lived in three separate, unconnected places: Due
Now bills and Unscheduled manual cards (Calendar only, no ranking beyond bills' own existing
▲▼), and the "Needs Info" panel (REsimpli/Sheet properties missing a date or amount, no
ranking at all). They're now ONE shared panel — replacing the old Needs-Info-only box, shown
once above both Calendar/Board exactly as that box was — with a single hand-ranked priority
order spanning all three sources.
- **`noDateOrder`** — new `data.whiteboardOverrides` sub-key, a plain array of ids in Kyle's
  chosen priority order (earliest = highest priority). `sortByPriorityOrder(items, order)`
  (pure, `whiteboard-forecast.mjs`) sorts any `{id, ...}` array by it — an id not yet in
  `order` keeps its natural relative position, appended after every explicitly-ranked one
  (relies on `Array#sort` being a stable sort, true in every engine this app targets).
- **`noDateAll`** (`WhiteboardPage`) normalizes all three sources into one shape (`{id, kind,
  label, amount, direction}` for a bill/unscheduled card; `{id, kind, label, reason, raw}` for
  a Needs Info sell/buy row — `reason` is what distinguishes the two for display/action
  purposes, not a separate flag), sorted via `sortByPriorityOrder(noDateAll, noDateOrder)`.
  `moveNoDatePriority(id, dir)` swaps a row with its neighbor in the CURRENTLY DISPLAYED sorted
  order and writes the resulting full id list back as `noDateOrder` — every move "fixes" the
  whole list's order going forward, so the first move on an unranked list already produces a
  complete, fully-explicit ranking.
- **Per-row actions, same as before, just unified**: a bill/unscheduled row gets a date-assign
  `<input type="date">` (→ `setCardDay`); a Needs Info row gets the existing "Fill in" amount+
  date form (→ `saveManualFill`, unchanged from the prior phase). ▲▼ priority buttons (gated
  `!readOnly`) are on every row regardless of kind.
- **Drag-to-reorder + number badges (11/17 follow-up)** — Kyle: "I want to be able to drag it
  to different priorities... and have them numbered. Number 1 means most important." Each row
  is wrapped in the existing generic `SortableItem` helper (near `usePersistedState`, top of
  file — already used for Home-screen/property drag-reorder, now reused here rather than a
  new one-off `useSortable` component) with its own small `DndContext`/`SortableContext`
  (`@dnd-kit/sortable`, already a dependency) scoped just to this list — a `⠿` handle drags,
  `handleNoDateDragEnd` computes the new order via `arrayMove` and writes it through the same
  `setNoDateOrder(newIds)` the ▲▼ buttons now also call (both paths converge on one writer).
  The number badge shown on every row is nothing but its own index in `noDateSorted` — it's
  automatically correct after either a drag or a ▲▼ click, with no separate "priority number"
  field to keep in sync.
- **Tests**: `sortByPriorityOrder` (no-op with no order, ranked-first ordering, unranked items
  keep relative order appended after).

### "Move to No-Date" — pulling an already-dated sell/buy card off the timeline (11/17)
Kyle: "how can I move properties to the no date list if they're already on a date?" There was
no way — Mark Closed removes a deal from the forecast entirely (for when it's actually done),
but there was nothing for "I'm just not sure about this one yet, pull it off the calendar for
now without closing it." **`noDateForced`** (new `data.whiteboardOverrides` sub-key, `{[cardId]:
true}`) is that missing middle ground.
- **`sendToNoDate(cardId)`/`restoreFromNoDate(cardId)`** (`WhiteboardPage`) — the override is
  purely an id flag, filtered via the same generic `filterClosed()` already used for Mark
  Closed (it just drops any id present in the map, so it works unchanged for this too).
  `activeSellCards`/`activeBuyCards` now run through it as a second filter pass, AFTER the
  existing moved-date/amount overrides are applied (`sellWithOverrides`/`buyWithOverrides`,
  computed once and reused both for the active lists and for the No-Date row below) — so a
  forced-no-date card still carries its real, fully-computed date/amount for display even
  though it's excluded from the forecast.
- **UI**: a new 📋 button (Calendar's `WhiteboardSellCard`/`WhiteboardBuyCard`, next to the
  existing 📅/Closed buttons; Board's `WhiteboardBoardEntry`, next to ✏️/✕) calls
  `onSendToNoDate`. The card then appears in the unified No-Date panel (see above) as
  `kind:"onHoldSell"/"onHoldBuy"`, showing its real projected amount and "— would be \<date\>",
  with a "↩ Restore" button (instead of Fill In, since the real data for it already exists —
  nothing to pencil in) that calls `restoreFromNoDate`.
- **Never auto-clears** — same reasoning as the loanPayment/setAside Mark Closed case: there's
  no "real data confirms it" signal for "Kyle is unsure about this one," so he restores it
  himself whenever he's ready to commit to a date again.

### Month view — a real wall-calendar grid (11/17)
Kyle: "a calendar view, with the boxes you'd see on a calendar," where he can drag houses
between days, see the no-date stuff and drag it onto a day to schedule it, and drag a dated
item back off onto the no-date area to unschedule it. A third view alongside Row (renamed
from "Calendar" — the existing horizontal day-scroller, to stop it being confused with this
new one) and Board: `["calendar","board","month"]` are still the underlying `boardView`
values (no migration needed for existing `localStorage` choices), labeled "Row"/"Board"/
"Month" on the toggle.
- **Same data, a different layout — no second forecast implementation.** `monthWeeks`
  (`WhiteboardPage`, a `useMemo` over `dayCols`) pads `dayCols` with `null` boxes so every
  week row is a real, aligned Sun–Sat week like a wall calendar — a pure display grouping of
  the exact same array Row/Board already use, adding no new days and computing nothing new.
  Each real box calls the exact same `cardsFor`/`sellCardsFor`/`buyCardsFor`/`autoCardsFor`/
  `setAsideCardsFor` functions Row's day columns already call.
- **Drag reuses the Row view's own `DndContext`/`handleDragEnd`/`dragSensors`/`activeId`
  wholesale** — its own separate `DndContext` instance (mutually exclusive render branch, same
  as Row's), but calling the literal same `handleDragEnd` function, not a second drag
  implementation. The one actual LOGIC change was to `handleDragEnd` itself: dropping a sell/
  buy card onto Unscheduled/Due Now used to be a silent no-op ("auto cards always have a day,
  nowhere to unschedule them to") — it now calls `sendToNoDate(id)` (the same thing the 📋
  button does), so "drag a house back out to no-date" works in BOTH Row and Month view, not
  just the new one.
- **No-Date sidebar**: `WhiteboardDueNowBox` and the `id="unscheduled"` `WhiteboardColumn` are
  reused completely as-is (not reimplemented) in a sidebar next to the grid — dropping a card
  from a day box onto either already unschedules it (manual/bill cards via the existing
  `setCardDay(id,null)` path; sell/buy via the `sendToNoDate` fix above), and dragging FROM
  there onto a day box already schedules it (existing `setCardDay(id,day)` path) — all
  pre-existing behavior, just newly reachable from this grid too. The separate, unified
  "📋 No Date" PRIORITY panel (REsimpli/Sheet Needs-Info rows + the same bills/unscheduled
  cards, hand-ranked — see above) is a DIFFERENT thing and still shows above every view
  including Month; it is NOT wired into this grid's `DndContext` — dragging a Needs-Info/
  on-hold row onto a calendar box is out of scope (those already have their own Fill
  in/Restore actions).
- **Scope: everything draggable in Row view is draggable here too** (manual/property/misc
  cards, bills, sell/buy auto cards — Kyle confirmed "everything," not just sell/buy "houses")
  — loan-payment and Set Aside entries stay non-draggable in both views, since their dates
  come from real loan terms/Kyle's own typed-in date, not something to freely drag around.
- **`WhiteboardMonthChip`** — a compact draggable pill (`useDraggable`, own id = the same
  `sell-`/`buy-`/card-id scheme everything else uses) deliberately much smaller than the full
  `WhiteboardSellCard`/`WhiteboardBuyCard`/`WhiteboardCard` Row view shows (a month box is a
  fraction of a day-column's width) — click navigates to the property (sell cards, property
  manual cards) or opens the edit modal (other manual cards, reusing the existing `setEditCard`
  state), but editing actions like ✏️ amount/📅 pick-date/Mark Closed live only in Board/Row —
  this is a fast way to MOVE dates by drag, not a second editor. Loan payments/Set Aside show
  as a small non-draggable count/icon line instead of chips.
- **`WhiteboardMonthDay`** — one grid box: `useDroppable({id: day})` (a `null` day/padding box
  still calls the hook unconditionally, with a stable `padKey`-derived id, `disabled:true` —
  never a real drop target, but never a fresh random id every render either), day-of-month
  number, a month/year label shown on the 1st of any month or the very first box in the window
  (so a window starting mid-month is still labeled), the chips, and a small end-of-day balance
  figure (red if negative) for context.
- **Tests**: none new — like the public TV dashboard, this is layout + reuse of already-tested
  drag/override logic (`setMovedDate`/`setCardDay`/`sendToNoDate`), not new calculation logic.
  The one real behavior change (`handleDragEnd`'s Unscheduled/Due Now drop for sell/buy) is
  covered by the same manual-testing expectation as the rest of the drag system (dnd-kit
  interactions aren't unit-tested anywhere in this suite).

### Board view table: one combined Amount column, color moved to the balance only (11/19)
Kyle: combine the separate "In (+)"/"Out (−)" columns into one, and stop coloring that
combined number — color ONLY the "New Balance" column, green if positive, red if negative.
Pure display change in `WhiteboardBoardRow`/`WhiteboardBoardView` — `row.netIn`/`row.netOut`
are still computed and tracked exactly as before (nothing about the underlying ledger math
changed, so `tests/whiteboard-ledger.test.mjs`'s `buildLedgerRows`/`ledgerSummary` assertions
are untouched), only how they're RENDERED changed.
- Table is now DATE | ADDRESS | AMOUNT | NEW BALANCE. The merged Amount cell stacks `+$X`
  (if `netIn>0`) and `−$Y` (if `netOut>0`) as plain neutral-colored lines (`text-slate-600`/
  `dark:text-zinc-300`) in one `<td>` — no more emerald/red on the in/out figures themselves.
  Same change for the table header (one "Amount" `<th>`, neutral).
- **New Balance is now green when positive, red when negative** (previously red-when-negative
  but plain slate otherwise) — on the per-row balance cell, AND the "Current" starting-balance
  row's own balance cell, which gets the identical sign check (`rBal(startingBalance)<0`) so
  it's visually consistent with every row below it. The red "Need $X" sub-line under a
  shortfall row is unchanged. This was originally scoped to the ledger TABLE only, leaving the
  summary tiles above it untouched — those tiles were separately unified with TV Mode's right
  after (see below), so the distinction no longer matters in practice.
- **The summary tiles were unified with TV Mode the same day** — Kyle: "make the regular mode
  have the same headers as what TV mode has now." See "Board view interactivity"'s TV Mode
  bullet above (now says both views share Under $10k/Goes Negative/Total In/Total Out).

### Board view table: every day shows, weekend shading instead of week subtotals (11/19)
Kyle: "have this view show like each day so that we can drag it easily... collapse them so
they're smaller... don't really need the week total view, maybe just make the weekend days a
little darker shade."
- **Every day in the window gets a row now** — `WhiteboardBoardView` no longer filters
  `week.rows` down to only populated days before rendering (`ledgerWeeks.flatMap(week=>
  week.rows)` instead of `visibleRows = week.rows.filter(r=>r.entries.length>0)`). The real
  reason this mattered: a day with nothing on it used to have NO row at all, so there was
  nowhere to DROP a dragged card to land it there — showing every day means every day is
  always a valid `useDroppable` target.
- **An empty day renders collapsed** — `WhiteboardBoardRow` branches early (after calling
  `useDroppable` unconditionally, so hook order never depends on which branch runs) into a
  thin, muted row (`text-[9px]`, tighter padding, no address/amount detail, just the date and
  that day's running balance) when `row.entries.length===0`, instead of the full detailed row
  a populated day gets.
- **Week-subtotal header rows are gone** — replaced with weekend shading: `wbIsWeekend(row.day)`
  (an existing top-level helper, already used by the inflow-clearing logic) applies a subtle
  darker background (`bg-slate-50 dark:bg-zinc-900/40`) to a Saturday/Sunday row, in BOTH the
  collapsed and full branches, so weekends are still visually obvious at a glance without a
  separate subtotal row breaking up the flow — the real totals still live in the summary strip
  above the table. A shortfall day's red background still takes priority over weekend shading.
  `groupLedgerRowsByWeek`/week-level totals themselves are untouched (still computed, still
  tested) — this is purely that `WhiteboardBoardView` stopped displaying them, not a removal of
  the underlying pure function.

### Board entries: click-to-edit, streamlined twice over (11/19)
Kyle: "don't wanna see the calendar and notes and whatever button — just wanna edit it by
clicking the thing already on the board directly... more streamlined." `WhiteboardBoardEntry`
no longer shows an always-visible row of 📅/✏️/📋/✕ icon buttons.
- **First pass**: a single click anywhere on the entry (dnd-kit's own activation distance
  already distinguishes a click from a drag, so this never fights drag-to-reschedule) opened
  one combined amount+date editor. Clicking stopped navigating to the property (Row view/the
  Properties page still do) — kept in the final design below too.
- **Kyle's immediate follow-up, same day — the actual shipped design**: "click on the amount
  to edit it, click on the date to edit it, not just the address... thinner rows... get rid of
  the extra text saying it was moved/edited, maybe just some symbol" — then, before that was
  even built, one more refinement: "just a little undo arrow right next to the actual thing
  that was edited... it makes us confirm first." One compact single-line entry:
  `[⏰ if overdue] address  [↺ if moved] date  [↺ if amount-edited] amount  📋  ✕`.
  - The **date** and **amount** are each their own small clickable value — clicking either
    swaps just that one value for its own inline input (`<input type="date">` / `<input
    type="number">`), independent of the other. No combined editor, no Save button — a date
    picks are applied the moment a value is chosen; an amount commits on blur/Enter (Escape
    cancels), matching the rest of the app's inline-edit conventions.
  - A value that's been manually overridden shows a tiny **↺ undo arrow right next to it**
    (violet for a moved date, indigo for an edited amount) instead of a sentence — clicking it
    calls `window.confirm("Reset the date/amount back to <original>?")` and only resets
    (`onResetDate`/`onResetAmount`) if confirmed. The old "manual"/"edited (was $X)"/"📌 moved
    (source says X)" text blocks are gone entirely; ⏰ (overdue — money hasn't hit the account
    yet) is the only other symbol left, and only when the date hasn't ALSO been manually moved.
  - 📋 (Move to No-Date) and ✕ (Mark Closed/remove) stay as small persistent icons at the end
    of the line — these are distinct, meaningful actions (not a value to click-to-edit), so
    they keep their own tiny always-visible buttons rather than being folded into anything.
  - Row padding shrank too (`px-3 py-2` → `px-3 py-1` in normal, non-TV-mode Board view) —
    combined with entries now being one compact line instead of multi-line note blocks, rows
    are meaningfully thinner overall, as asked.
- `navigate`/`compact` are no longer threaded through `WhiteboardBoardEntry` at all (dropped
  from its own signature and call site along with the rest of this redesign) — neither is read
  anywhere in the final version; `navigate` is also gone from `WhiteboardBoardRow`/
  `WhiteboardBoardView`'s signatures and call sites, same as the first pass already noted.

### Public TV Dashboard (`?tv=<secret>`, 11/17)
Kyle uses AbleSign (a digital-signage box/kiosk browser) to display the Whiteboard Board view
on a TV, and asked for a URL that needs no login at all — AbleSign just loads a URL, it can't
do an interactive Supabase sign-in. **Security tradeoff Kyle explicitly confirmed before this
was built**: the URL contains a long random secret instead of a real login — anyone who gets
that exact URL can view the cash balance and upcoming deals with no login, so the secret is a
password living in a link, not true authentication. He also chose to show the FULL Board view
(addresses, lender names on loan-payment lines — everything, same as his own screen) rather
than a numbers-only redacted version.
- **The one new thing this trusts with no login**: `TV_DASHBOARD_SECRET` (server-side env var)
  and a matching row in a new `tv_dashboard_config` table (`supabase/tv_dashboard.sql` — NOT
  applied yet, same "written to the repo, Kyle runs it by hand" pattern as
  `resimpli_sync.sql`). Rotating it (new random value in both places) immediately kills the
  old URL with zero other changes — treat the secret like a password, never commit the real
  value, and rotate it if the TV/kiosk link ever leaks.
- **`tv_dashboard_read(secret)`** (Postgres, `SECURITY DEFINER`, bypasses RLS, same pattern as
  `resimpli_sync_read`) returns ONLY `{properties, unassigned, lenders, whiteboard,
  whiteboardOverrides}` — the exact slice `WhiteboardPage` actually reads (confirmed by
  grepping every `data.X` access inside its own span, plus `upcomingLoanPayments`'s use of
  `data.unassigned`/`data.lenders` for the loan-payment schedule) — never closingData,
  overageChecks, resimpliReview, dashboardLayout, Home-screen config, or any lender/bookkeeper
  account data.
- **`api/tv-data.mjs`** — `GET /api/tv-data?key=<secret>`, checks the key itself (so a wrong
  key never even reaches the database) and again inside the Postgres function (so the anon key
  alone, without the secret, still can't read anything). The ONE documented exception to the
  `whiteboardOverrides` containment hard rule above — a read-only pass-through, not a second
  place that interprets or mutates it (enforced by its own isolation-test carve-out).
- **`api/_tv-auth.mjs`** (`isTvKeyAuthorized(req)`) — a tiny shared check, imported by
  `api/mercury-balance.mjs`/`api/sell-dates.mjs`/`api/upcoming-buys.mjs`'s own
  `isAuthorizedCaller`, accepted as an ALTERNATIVE to (never a replacement for) each one's
  normal "send Kyle's logged-in Supabase token" check — a request still needs either a valid
  session for `kyle@nexushomesoh.com` or this secret, never neither.
- **`src/supabase.js`**: `loadTvDashboardData(tvKey)` (the no-session counterpart to
  `loadData()`) plus an optional `tvKey` argument on `fetchMercuryBalance`/`fetchSellDates`/
  `fetchUpcomingBuys` — when present (only `src/TvDashboard.jsx` ever passes one), it's sent
  instead of a session bearer token; the normal, logged-in Tracker path never passes it, so
  its behavior is completely unchanged.
- **Reuses `WhiteboardPage` wholesale — no second implementation of the forecast to drift
  from the real one.** `WhiteboardPage`, `ReadOnlyContext`, `PrivacyContext`, and
  `PanelContext` are named-exported from `Tracker.jsx` (a separate `export { ... }` statement
  at the very end of the file, not `export` on the declarations themselves, so
  `WhiteboardPage`'s own line stays exactly `function WhiteboardPage(` — the isolation test
  above locates it by that literal prefix). `src/TvDashboard.jsx` loads
  `{properties, unassigned, lenders, whiteboard, whiteboardOverrides}` via
  `loadTvDashboardData`, re-fetches every 5 minutes (a kiosk page stays open for days — this is
  what keeps Mercury/sell-dates/upcoming-buys fresh too, since `WhiteboardPage` only fetches
  those on its own mount; remounting it via a changing `key` on each refresh re-triggers that),
  and renders `<ReadOnlyContext.Provider value={true}><PrivacyContext.Provider
  value={false}><PanelContext.Provider value={null}><WhiteboardPage ... publicMode
  tvKey={tvKey}/></PanelContext.Provider></PrivacyContext.Provider></ReadOnlyContext.Provider>`
  — always read-only (there's no user identity for a write to attribute to), never masked.
- **`publicMode` prop on `WhiteboardPage`** (only ever true from `TvDashboard`): hides the
  whole toolbar (Calendar/Board toggle, day-range toggle, Round $5k, + Add Card — nobody's
  there to click them) and forces `effectiveBoardView` to `"board"` — a plain local override
  of the real, persisted `boardView` value for just the render branches, NOT a different
  default passed to `usePersistedState` itself, so the normal Tracker's own `localStorage`
  choice (and the test asserting its exact default) is completely untouched. `forceTv` on
  `WhiteboardBoardView` similarly seeds `tvMode`'s initial state to `true` directly, WITHOUT
  calling the Fullscreen API (no real user gesture exists to request it from, and the
  kiosk/AbleSign box is already fullscreen at the OS level, so there's nothing to request).
- **`App.jsx`**: checks `?tv=<secret>` in the URL and renders `TvDashboard` instead of the
  normal session/login flow — checked AFTER every hook in `App` runs (never a conditional
  early return before them, to keep hook order unconditional), but before any of the
  session-loading or login UI.
- **Routing a kiosk to it**: point AbleSign (or any browser-based kiosk) at
  `https://<your-domain>/?tv=<the secret>`. No app-side "generate a link" UI — the URL is
  assembled by hand once, using whatever value was put in `TV_DASHBOARD_SECRET`/
  `tv_dashboard_config`.
- **Tests**: the isolation-test carve-out above (`tv-data.mjs` is read-only, no write/RPC
  call). No new pure-logic tests were needed — this feature is wiring (new auth paths, a new
  read endpoint, re-exporting and re-parameterizing existing components), not new calculation
  logic; the actual forecast math is the same already-tested `WhiteboardPage`/
  `whiteboard-forecast.mjs` code path the logged-in Tracker already exercises.

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
