// Tests for src/resimpli-shared.mjs's matcher — "lot" as a unit designator, combined
// addresses expanded on both sides, id-first matching across every stored id, and the
// inventory-preferred reverse-collision tie-break. Synthetic addresses only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAddressForMatch, storedIdsFor, matchResimpliRecords } from "../src/resimpli-shared.mjs";

test('"Lot 7" normalizes the same as "# 7"', () => {
  assert.equal(normalizeAddressForMatch("100 Main St SW Lot 7"), normalizeAddressForMatch("100 Main St Sw # 7"));
  assert.equal(normalizeAddressForMatch("100 Main St SW Lot 7"), "100 main st");
  assert.equal(normalizeAddressForMatch("100 Main St Lot"), "100 main st");
});

test('a street actually named "Lott" is not affected (word boundary)', () => {
  assert.equal(normalizeAddressForMatch("100 Lott Ave"), "100 lott ave");
});

test("a combined record address (\"and\"/\"&\") matches a combined property address cleanly", () => {
  const properties = [{ id: "p1", address: "200 & 202 Oak Ln" }];
  const andRecords = [{ id: null, idType: null, address: "200 and 202 Oak Ln", stage: "Rehab Complete", recordType: "inventory", url: null }];
  let result = matchResimpliRecords(properties, andRecords);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].property.id, "p1");
  assert.equal(result.ambiguous.length, 0);

  const ampRecords = [{ id: null, idType: null, address: "200 & 202 Oak Ln", stage: "Rehab Complete", recordType: "inventory", url: null }];
  result = matchResimpliRecords(properties, ampRecords);
  assert.equal(result.matched.length, 1);
});

test("inventory wins over a lead on reverse collision", () => {
  const properties = [{ id: "p1", address: "300 Pine Rd" }];
  const records = [
    { id: "L1", idType: "lead", address: "300 Pine Rd", stage: "Warm Leads", recordType: "lead", url: null },
    { id: "I1", idType: "lead", address: "300 Pine Road", stage: "Rehab Complete", recordType: "inventory", url: null },
  ];
  const result = matchResimpliRecords(properties, records);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].record.id, "I1");
  assert.equal(result.ambiguous.length, 0);
});

test("id-first matching wins even when the address doesn't match at all", () => {
  const properties = [{ id: "p1", address: "400 Elm St", resimpli: { leadId: "999" } }];
  const records = [{ id: "999", idType: "lead", address: "TOTALLY DIFFERENT ADDRESS, NV", stage: "Rehab Complete", recordType: "inventory", url: null }];
  const result = matchResimpliRecords(properties, records);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].property.id, "p1");
});

test("id parsed from a stored URL query param also matches", () => {
  const properties = [{ id: "p1", address: "401 Elm St", resimpli: { url: "https://app.resimpli.com/inventory?inventoryId=555" } }];
  const records = [{ id: "555", idType: "lead", address: "ANOTHER UNRELATED ADDRESS, NV", stage: "Listed For Sale", recordType: "inventory", url: null }];
  const result = matchResimpliRecords(properties, records);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].property.id, "p1");
});

test("storedIdsFor collects leadId + moduleId + every URL id param", () => {
  const ids = storedIdsFor({ resimpli: { leadId: "A", moduleId: "B", url: "https://x/y?inventoryId=C&leadsId=D&soldId=E&leadId=F&unrelated=Z" } });
  assert.deepEqual([...ids].sort(), ["A", "B", "C", "D", "E", "F"]);
});

test("two unresolvable leads for one property still go to review (no id match, neither uniquely inventory)", () => {
  const properties = [{ id: "p1", address: "500 Birch Ct" }];
  const records = [
    { id: "L1", idType: "lead", address: "500 Birch Ct", stage: "Discovery", recordType: "lead", url: null },
    { id: "L2", idType: "lead", address: "500 Birch Court", stage: "Offers Made", recordType: "lead", url: null },
  ];
  const result = matchResimpliRecords(properties, records);
  assert.equal(result.matched.length, 0);
  assert.equal(result.ambiguous.length, 2);
  assert.deepEqual(result.ambiguous.map(a => a.candidates[0]?.id), ["p1", "p1"]);
});

test("two inventory records for the same property, neither id-matched, still go to review", () => {
  const properties = [{ id: "p1", address: "501 Birch Ct" }];
  const records = [
    { id: "I1", idType: "lead", address: "501 Birch Ct", stage: "Under Rehab", recordType: "inventory", url: null },
    { id: "I2", idType: "lead", address: "501 Birch Court", stage: "Rehab Complete", recordType: "inventory", url: null },
  ];
  const result = matchResimpliRecords(properties, records);
  assert.equal(result.matched.length, 0);
  assert.equal(result.ambiguous.length, 2);
});
