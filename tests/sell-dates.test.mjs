// Tests for api/sell-dates.mjs's pure per-property decision and sheet-date-map parsing — no
// network/Google Sheets/REsimpli calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSellDateRow, buildSheetDateMap } from "../api/sell-dates.mjs";

const prop = { id: "p1", address: "1323 Red Bank", leadId: "lead-rb" };

test("a sheet hit wins even when a fallback date is also available", () => {
  const row = resolveSellDateRow(prop, { sheetHit: { date: "2026-11-18" }, fallbackDate: "2026-11-20", sheetConnected: true });
  assert.deepEqual(row, { id: "p1", address: "1323 Red Bank", date: "2026-11-18", source: "sheet" });
});

test("no sheet hit, but a REsimpli fallback date exists -> resimpli-fallback row", () => {
  const row = resolveSellDateRow(prop, { sheetHit: null, fallbackDate: "2026-11-20", sheetConnected: true });
  assert.deepEqual(row, { id: "p1", address: "1323 Red Bank", date: "2026-11-20", source: "resimpli-fallback" });
});

test("B10 (Nov 16 4:34pm): sheet unreachable but the REsimpli fallback still finds a date — NOT Needs Info", () => {
  // The actual bug: fetchSheetValues throwing (e.g. GOOGLE_SERVICE_ACCOUNT_JSON not set) used
  // to abort the whole request and send every property to Needs Info, skipping the REsimpli
  // fallback entirely. Now the fallback is tried regardless of why there's no sheet hit.
  const row = resolveSellDateRow(prop, { sheetHit: null, fallbackDate: "2026-11-18", sheetConnected: false });
  assert.deepEqual(row, { id: "p1", address: "1323 Red Bank", date: "2026-11-18", source: "resimpli-fallback" });
});

test("sheet disconnected AND no fallback date -> Needs Info naming the env var", () => {
  const row = resolveSellDateRow(prop, { sheetHit: null, fallbackDate: null, sheetConnected: false });
  assert.equal(row.date, null);
  assert.match(row.reason, /Sheet not connected/);
  assert.match(row.reason, /GOOGLE_SERVICE_ACCOUNT_JSON/);
});

test("sheet connected but genuinely has no date, and no fallback either -> Needs Info, different reason", () => {
  const row = resolveSellDateRow(prop, { sheetHit: null, fallbackDate: null, sheetConnected: true });
  assert.equal(row.date, null);
  assert.doesNotMatch(row.reason, /Sheet not connected/, "must not claim the sheet is disconnected when it was actually read fine");
  assert.match(row.reason, /No sheet date and no REsimpli fallback date/);
});

test("buildSheetDateMap matches the Sell_ClosingDate column by header name and normalizes an MM/DD/YYYY date", () => {
  const rows = [
    ["Address", "Sell_ClosingDate"],
    ["1323 Red Bank", "11/18/2026"],
  ];
  const map = buildSheetDateMap(rows);
  assert.equal(map.get("1323 red bank").date, "2026-11-18");
});

test("buildSheetDateMap returns an empty map for an empty sheet (never throws)", () => {
  const map = buildSheetDateMap([]);
  assert.equal(map.size, 0);
});
