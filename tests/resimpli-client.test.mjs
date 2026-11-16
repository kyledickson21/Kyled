import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapLeadDetails, applyKnownUnderContractIds } from "../api/_resimpli-client.mjs";

test("B2: unwrapLeadDetails reads the real {statusCode, data:{leadData}} response shape", () => {
  const real = { statusCode: 200, data: { leadData: { address: "123 Main St", investmentTitle: "Fix and Flip" } } };
  assert.deepEqual(unwrapLeadDetails(real), { address: "123 Main St", investmentTitle: "Fix and Flip" });
});

test("unwrapLeadDetails falls back to the old guessed shapes if REsimpli ever changes the wrapper", () => {
  assert.deepEqual(unwrapLeadDetails({ leadData: { address: "x" } }), { address: "x" });
  const bareObj = { address: "y" };
  assert.deepEqual(unwrapLeadDetails(bareObj), bareObj);
});

test("B1: applyKnownUnderContractIds fills the Lead and Inventory Under Contract gap without overriding an existing entry", () => {
  const map = new Map([["already-known", { recordType: "sold", stage: "Sold", orderIndex: 0 }]]);
  const filled = applyKnownUnderContractIds(map);
  assert.deepEqual(filled.get("6aa4dcfad18014f8fc6397f5"), { recordType: "lead", stage: "Under Contract", orderIndex: 0 });
  assert.deepEqual(filled.get("6aa4dcfad18014f8fc6397d4"), { recordType: "inventory", stage: "Under Contract", orderIndex: 0 });
  assert.deepEqual(filled.get("already-known"), { recordType: "sold", stage: "Sold", orderIndex: 0 }, "an existing entry must never be overridden");
});

test("B1: applyKnownUnderContractIds does not override a live-discovered Under Contract mapping", () => {
  const map = new Map([["6aa4dcfad18014f8fc6397d4", { recordType: "inventory", stage: "Under Contract", orderIndex: 7 }]]);
  const filled = applyKnownUnderContractIds(map);
  assert.equal(filled.get("6aa4dcfad18014f8fc6397d4").orderIndex, 7, "the live backfill's own orderIndex must be preserved, not clobbered by the hardcoded fallback");
});
