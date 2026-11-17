// Static containment check for the Whiteboard-only overrides HARD RULE: "nothing else in the
// app may read [whiteboardOverrides]". Tracker.jsx is a single 9000+-line file holding every
// screen, so the real enforcement isn't "which file" but "which function" — this confirms
// every literal reference to `whiteboardOverrides` in the whole repo falls inside
// WhiteboardPage(), and that no api/*.mjs or other src/*.mjs file references it outside of
// documentation comments in whiteboard-forecast.mjs (which never reads
// `data.whiteboardOverrides` itself — it only takes already-unwrapped plain objects/arrays as
// parameters).
//
// Finding WhiteboardPage's extent: every top-level component/function in this file is written
// at column 0 (`function Name(` or `const Name = (...) =>`), with the function's own body
// always indented — confirmed throughout the file — so the line right before the NEXT such
// column-0 declaration is WhiteboardPage's own closing brace. Brace-counting was tried first
// and rejected: this file's JSX/template-literal content doesn't actually balance braces
// character-by-character (e.g. a brace inside a string or comment), so it closed early.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOP_LEVEL_DECL = /^(function |const [A-Za-z]|class )/;

test("every whiteboardOverrides reference in Tracker.jsx is inside WhiteboardPage()", () => {
  const text = readFileSync(path.join(repoRoot, "src/Tracker.jsx"), "utf8");
  const lines = text.split("\n");
  const startIdx = lines.findIndex(l => l.startsWith("function WhiteboardPage("));
  assert.ok(startIdx !== -1, "WhiteboardPage function not found — has it been renamed?");
  const nextDeclIdx = lines.findIndex((l, i) => i > startIdx && TOP_LEVEL_DECL.test(l));
  assert.ok(nextDeclIdx !== -1, "couldn't find the next top-level declaration after WhiteboardPage");
  const endIdx = nextDeclIdx - 1; // last line still inside WhiteboardPage

  const offenders = [];
  lines.forEach((line, i) => {
    if (line.includes("whiteboardOverrides") && (i < startIdx || i > endIdx)) {
      offenders.push(`line ${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(offenders, [], "whiteboardOverrides must only be referenced inside WhiteboardPage()");

  const insideCount = lines.slice(startIdx, endIdx + 1).filter(l => l.includes("whiteboardOverrides")).length;
  assert.ok(insideCount > 0, "expected to find whiteboardOverrides references inside WhiteboardPage — did the feature get removed?");
});

// One deliberate, narrow exception: api/tv-data.mjs (the public, no-login TV dashboard's read
// endpoint — see CLAUDE.md "Public TV Dashboard") passes whiteboardOverrides straight through
// from tv_dashboard_read() to the client, same as properties/unassigned/lenders/whiteboard —
// it's a read-only, single-RPC pass-through with no rebuild/transform logic of its own (unlike
// the REsimpli sync this rule was originally written to guard against, which rewrites the
// whole properties array), and the data still only ever gets INTERPRETED by WhiteboardPage
// itself on the client (via src/TvDashboard.jsx), the one place this whole rule designates as
// the owner. Every OTHER api/*.mjs file must still never reference it at all.
const WHITEBOARD_OVERRIDES_EXEMPT_API_FILES = ["tv-data.mjs"];

test("no api/*.mjs file reads or writes whiteboardOverrides (except the documented tv-data.mjs pass-through)", () => {
  const apiDir = path.join(repoRoot, "api");
  const offenders = [];
  for (const file of readdirSync(apiDir)) {
    if (!file.endsWith(".mjs")) continue;
    if (WHITEBOARD_OVERRIDES_EXEMPT_API_FILES.includes(file)) continue;
    const text = readFileSync(path.join(apiDir, file), "utf8");
    if (text.includes("whiteboardOverrides")) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "no server function should ever touch whiteboardOverrides — it's Whiteboard-UI-only, synced via the normal nexus_data blob like everything else");
});

test("api/tv-data.mjs only ever READS whiteboardOverrides — no write/rpc call that could mutate it", () => {
  const text = readFileSync(path.join(repoRoot, "api/tv-data.mjs"), "utf8");
  assert.match(text, /whiteboardOverrides/, "expected tv-data.mjs to actually mention it (in a comment) — if this changed, update the exemption above too");
  assert.doesNotMatch(text, /\.rpc\(\s*["'`]\w*(apply|write|update|sync_apply)/i, "tv-data.mjs must stay read-only — only tv_dashboard_read, never anything that writes");
});

test("whiteboard-forecast.mjs's own functions never read data.whiteboardOverrides — only documentation comments mention the key name", () => {
  const text = readFileSync(path.join(repoRoot, "src/whiteboard-forecast.mjs"), "utf8");
  const codeLines = text.split("\n").filter(l => !l.trim().startsWith("//"));
  const codeReferences = codeLines.filter(l => l.includes("whiteboardOverrides"));
  assert.deepEqual(codeReferences, [], "filterClosed/applyMovedDate/undatedSetAsideTotal/availableCash/datedSetAsideCards must take plain closed/movedDates/setAsides parameters, never reach into data.whiteboardOverrides themselves");
});

test("src/resimpli-shared.mjs and src/loan-schedule-shared.mjs never reference whiteboardOverrides", () => {
  for (const file of ["src/resimpli-shared.mjs", "src/loan-schedule-shared.mjs"]) {
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    assert.equal(text.includes("whiteboardOverrides"), false, `${file} must never reference whiteboardOverrides`);
  }
});
