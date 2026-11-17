// Tests for the Whiteboard Board (ledger) view's pure functions — buildLedgerRows,
// groupLedgerRowsByWeek, ledgerSummary. The real Tracker.jsx code builds `balances` once via
// computeForecastSummary and passes that SAME object straight into buildLedgerRows (never
// recomputing a running total independently), so these tests focus on proving that contract —
// every ledger row's balance is exactly computeForecastSummary's own number for that day, and
// every row's netIn/netOut sums back to exactly the net that produced that balance — plus a
// static check that the Board view components never see nexus_data's `update` function at all
// (display-only, per Kyle's "must not change any data, calculations, or other screens" rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { computeForecastSummary, buildLedgerRows, groupLedgerRowsByWeek, ledgerSummary } from "../src/whiteboard-forecast.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeScenario() {
  const dayCols = Array.from({ length: 21 }, (_, i) => {
    const d = new Date(2026, 10, 16 + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const entriesByDay = {
    [dayCols[1]]: [{ id: "sell-p1", label: "1323 Red Bank", amount: 78089.68, direction: "in" }],
    [dayCols[4]]: [
      { id: "buy-l1", label: "840 Francis", amount: 40950, direction: "out" },
      { id: "pmt-hard1", label: "Lender A", amount: 3921.5, direction: "out" },
    ],
    [dayCols[10]]: [{ id: "setaside-sa1", label: "Payroll", amount: 5000, direction: "out" }],
    [dayCols[15]]: [{ id: "sell-p2", label: "1984 Brimfield", amount: 90000, direction: "in" }],
  };
  const netByDay = {};
  dayCols.forEach(day => {
    const entries = entriesByDay[day] || [];
    netByDay[day] = entries.reduce((s, e) => s + (e.direction === "in" ? e.amount : -e.amount), 0);
  });
  return { dayCols, entriesByDay, netByDay };
}

test("buildLedgerRows: every row's balance is EXACTLY computeForecastSummary's own number for that day (parity by construction)", () => {
  const { dayCols, entriesByDay, netByDay } = makeScenario();
  const { balances } = computeForecastSummary(dayCols, netByDay, 70000);
  const rows = buildLedgerRows(dayCols, entriesByDay, balances);
  assert.equal(rows.length, dayCols.length);
  rows.forEach((row, i) => {
    assert.equal(row.day, dayCols[i]);
    assert.equal(row.balance, balances[dayCols[i]], `row ${row.day} balance must equal the calendar view's own balances[day]`);
  });
});

test("buildLedgerRows: each row's netIn - netOut equals the exact net that drove that day's balance", () => {
  const { dayCols, entriesByDay, netByDay } = makeScenario();
  const { balances } = computeForecastSummary(dayCols, netByDay, 70000);
  const rows = buildLedgerRows(dayCols, entriesByDay, balances);
  rows.forEach((row, i) => {
    const day = dayCols[i];
    const net = Math.round((row.netIn - row.netOut) * 100) / 100;
    assert.equal(net, Math.round((netByDay[day] || 0) * 100) / 100, `day ${day}: ledger net must match netByDay`);
  });
});

test("the Red Bank sell entry (78,089.68) appears as netIn, and the running balance after it reflects that exactly", () => {
  const { dayCols, entriesByDay, netByDay } = makeScenario();
  const { balances } = computeForecastSummary(dayCols, netByDay, 70000);
  const rows = buildLedgerRows(dayCols, entriesByDay, balances);
  const redBankRow = rows[1];
  assert.equal(redBankRow.netIn, 78089.68);
  assert.equal(redBankRow.balance, Math.round((70000 + 78089.68) * 100) / 100);
});

test("groupLedgerRowsByWeek: chunks are exactly 7 days and subtotals sum the chunk's own rows", () => {
  const { dayCols, entriesByDay, netByDay } = makeScenario();
  const { balances } = computeForecastSummary(dayCols, netByDay, 70000);
  const rows = buildLedgerRows(dayCols, entriesByDay, balances);
  const weeks = groupLedgerRowsByWeek(rows);
  assert.equal(weeks.length, 3); // 21 days / 7
  assert.equal(weeks[0].rows.length, 7);
  assert.equal(weeks[0].weekStart, dayCols[0]);
  assert.equal(weeks[1].weekStart, dayCols[7]);
  weeks.forEach(week => {
    const expectedIn = Math.round(week.rows.reduce((s, r) => s + r.netIn, 0) * 100) / 100;
    const expectedOut = Math.round(week.rows.reduce((s, r) => s + r.netOut, 0) * 100) / 100;
    assert.equal(week.totalIn, expectedIn);
    assert.equal(week.totalOut, expectedOut);
  });
});

test("ledgerSummary: lowest balance, totals, and ending balance match the underlying rows", () => {
  const { dayCols, entriesByDay, netByDay } = makeScenario();
  // Force a shortfall: a big buy with nothing to cover it.
  netByDay[dayCols[4]] -= 100000;
  entriesByDay[dayCols[4]] = [...entriesByDay[dayCols[4]], { id: "extra-out", label: "Extra", amount: 100000, direction: "out" }];
  const { balances } = computeForecastSummary(dayCols, netByDay, 70000);
  const rows = buildLedgerRows(dayCols, entriesByDay, balances);
  const summary = ledgerSummary(rows, 70000);

  const minBalance = Math.min(...rows.map(r => r.balance));
  assert.equal(summary.lowest.balance, minBalance);
  assert.ok(summary.lowest.balance < 0, "this scenario should produce a real shortfall");
  assert.equal(summary.ending, rows[rows.length - 1].balance);
  const totalIn = Math.round(rows.reduce((s, r) => s + r.netIn, 0) * 100) / 100;
  const totalOut = Math.round(rows.reduce((s, r) => s + r.netOut, 0) * 100) / 100;
  assert.equal(summary.totalIn, totalIn);
  assert.equal(summary.totalOut, totalOut);
});

test("ledgerSummary with no rows falls back to the starting balance as ending", () => {
  const summary = ledgerSummary([], 5000);
  assert.deepEqual(summary, { lowest: null, totalIn: 0, totalOut: 0, ending: 5000, startingBalance: 5000 });
});

// ─── Display-only guarantee: the Board view never receives or calls `update` ───────────────
test("WhiteboardBoardView and WhiteboardBoardRow never take an `update` prop or call update(...)", () => {
  const text = readFileSync(path.join(repoRoot, "src/Tracker.jsx"), "utf8");
  const lines = text.split("\n");
  for (const name of ["WhiteboardBoardView", "WhiteboardBoardRow"]) {
    const startIdx = lines.findIndex(l => l.includes(`function ${name}(`) || l.startsWith(`const ${name} =`));
    assert.ok(startIdx !== -1, `${name} not found`);
    const nextDeclIdx = lines.findIndex((l, i) => i > startIdx && /^(function |const [A-Za-z]|class )/.test(l));
    const body = lines.slice(startIdx, nextDeclIdx === -1 ? lines.length : nextDeclIdx).join("\n");
    assert.doesNotMatch(body, /\bupdate\s*\(/, `${name} must never call update(...) — it's display-only`);
    assert.doesNotMatch(body, /\bupdate\s*,/, `${name} must never take an update prop`);
  }
});

test("the Calendar/Board view toggle only writes to localStorage (usePersistedState), never to nexus_data", () => {
  const text = readFileSync(path.join(repoRoot, "src/Tracker.jsx"), "utf8");
  assert.match(text, /const \[boardView,setBoardView\] = usePersistedState\("nx-whiteboardView","calendar"\)/, "boardView must be a usePersistedState (localStorage-backed), not part of data/whiteboardOverrides");
});
