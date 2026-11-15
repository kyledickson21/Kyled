// ─── REsimpli shared matching logic ────────────────────────────────────────
// Pure, dependency-free ES module — imported by both the browser app
// (src/Tracker.jsx) and the server-side sync (api/*.mjs), so the CSV import,
// the scheduled sync, and the webhook receiver all agree on exactly the same
// stage list and address-matching rules. Nothing here touches money, loans,
// lenders, or draws — it only ever reasons about property.resimpli.

// REsimpli's actual pipelines and each one's stage order, left to right/top to
// bottom exactly as REsimpli shows them — verified against both the REsimpli
// screens and the API's orderIndex. Kept hardcoded here as the default/
// fallback; the live sync reads this live from REsimpli's getPipelineList and
// stores it as data.resimpliPipelineOrder (see api/resimpli-sync.mjs), falling
// back to this same order whenever that hasn't run yet or came back empty.
export const RESIMPLI_PIPELINES = [
  { key: "lead", label: "Lead", stages: ["New Leads", "Discovery", "Interested", "Due Diligence", "Offer Follow Up", "Offers Made", "Under Contract"] },
  { key: "inventory", label: "Inventory", stages: ["New Inventory", "Waiting On Possession", "Ready For Rehab", "Under Rehab", "Rehab Complete", "Listed For Sale", "Under Contract"] },
  { key: "rental", label: "Rental", stages: ["New Rental", "Under Rehab", "Ready to Rent", "DSCR in process", "Rented", "Lease Ending Soon", "Eviction In Progress", "TURN/NEEDS RENTED"] },
  { key: "sold", label: "Sold", stages: ["Sold"] },
];

// Flat, deduplicated list of every stage name across every pipeline — used
// only as the PropertyForm datalist suggestions for a hand-typed stage, which
// has no recordType (so no single pipeline to scope it to).
export const RESIMPLI_STAGES = [...new Set(RESIMPLI_PIPELINES.flatMap(p => p.stages))];

// Bundles a pipeline list (the hardcoded default, or a live-fetched
// data.resimpliPipelineOrder) into the lookup structures stageSortKey/
// resimpliStageLabel/pipelineForRecordType need: each pipeline's own index
// (for sort order), a key->pipeline map, and a count of how many pipelines
// use each stage name (for ambiguous-name labeling).
export function buildPipelineIndex(pipelines) {
  const list = Array.isArray(pipelines) && pipelines.length ? pipelines : RESIMPLI_PIPELINES;
  const withOrder = list.map((p, i) => ({ ...p, order: i }));
  const byKey = Object.fromEntries(withOrder.map(p => [p.key, p]));
  const stageNameCount = new Map();
  withOrder.forEach(p => p.stages.forEach(s => stageNameCount.set(s, (stageNameCount.get(s) || 0) + 1)));
  return { pipelines: withOrder, byKey, stageNameCount };
}
const DEFAULT_PIPELINE_INDEX = buildPipelineIndex(RESIMPLI_PIPELINES);

// Looks up a pipeline by property.resimpli.recordType ("lead"|"inventory"|
// "rental"|"sold"). Pass a `buildPipelineIndex(data.resimpliPipelineOrder)`
// result as `index` to use the live-fetched order instead of the default.
export function pipelineForRecordType(recordType, index = DEFAULT_PIPELINE_INDEX) {
  return index.byKey[recordType] || null;
}

// Human label for a resimpli stage — adds "(Lead)"/"(Inventory)" etc. only
// when the bare stage name is ambiguous across pipelines AND the pipeline is
// actually known (recordType set); otherwise just the stage name as-is. The
// stage name alone is never enough to identify a stage — "Under Contract" is
// used by both Lead and Inventory, and "Under Rehab" by both Inventory and
// Rental — recordType (which pipeline) always has to come first.
export function resimpliStageLabel(resimpli, index = DEFAULT_PIPELINE_INDEX) {
  if (!resimpli?.stage) return null;
  const pipeline = pipelineForRecordType(resimpli.recordType, index);
  if (pipeline && index.stageNameCount.get(resimpli.stage) > 1) return `${resimpli.stage} (${pipeline.label})`;
  return resimpli.stage;
}

// Sortable string key for "Sort by Stage": pipeline first (Lead, Inventory,
// Rental, Sold, in that order, or whatever order `index` carries), then stage
// within that pipeline's own order, then any stage REsimpli doesn't list
// (alphabetically, within its pipeline), then a stage whose pipeline isn't
// known at all (e.g. hand-typed with no recordType — alphabetically), then no
// stage at all (always last). Takes a property ({resimpli:{recordType,stage}}).
export function stageSortKey(prop, index = DEFAULT_PIPELINE_INDEX) {
  const resimpli = prop?.resimpli;
  const stage = resimpli?.stage;
  if (!stage) return "9";
  const pipeline = pipelineForRecordType(resimpli?.recordType, index);
  if (!pipeline) return `8${stage.toLowerCase()}`;
  const sIdx = pipeline.stages.indexOf(stage);
  return `${pipeline.order}${sIdx !== -1 ? `0${String(sIdx).padStart(2, "0")}` : `1${stage.toLowerCase()}`}`;
}

// Rental folds into the Inventory pipeline for SORT/FILTER/GROUP purposes only — there's no
// separate Rental column/position in the Properties page's sort order, stage filter, or
// Pipeline view. This never changes what's stored, and never changes a stage's displayed
// label (resimpliStageLabel/pipelineForRecordType above are untouched and still reason about
// the real "rental" recordType for badge text) — only where a rental-recordType property
// sorts or groups. Matched case-insensitively with extra whitespace collapsed, per Kyle.
const RENTAL_TO_INVENTORY_STAGE = {
  "new rental": "New Inventory",
  "under rehab": "Under Rehab",
  "ready to rent": "Rehab Complete",
  "dscr in process": "Rehab Complete",
};
const normalizeStageKey = s => (s || "").trim().replace(/\s+/g, " ").toLowerCase();

// Returns the {recordType, stage} to sort/filter/group by — identical to the input for every
// recordType except "rental", which maps to its Inventory-pipeline equivalent per
// RENTAL_TO_INVENTORY_STAGE above. Any rental stage not explicitly listed there (Rented, Lease
// Ending Soon, Eviction In Progress, TURN/NEEDS RENTED, or anything else REsimpli might use)
// falls back to "Rehab Complete" — Kyle's catch-all for "any other rental stage on a property
// that's still open in the tracker."
export function effectiveGroupingResimpli(resimpli) {
  if (resimpli?.recordType !== "rental") return resimpli;
  const mapped = RENTAL_TO_INVENTORY_STAGE[normalizeStageKey(resimpli.stage)] || "Rehab Complete";
  return { ...resimpli, recordType: "inventory", stage: mapped };
}

// stageSortKey, but folding rental into Inventory first (see effectiveGroupingResimpli) — use
// this for the Properties page's sort-by-stage and stage filter; use the plain stageSortKey
// (or resimpliStageLabel) anywhere actual pipeline identity still matters, like the badge.
export function groupedStageSortKey(prop, index = DEFAULT_PIPELINE_INDEX) {
  return stageSortKey({ resimpli: effectiveGroupingResimpli(prop?.resimpli) }, index);
}

const ADDRESS_SUFFIX_MAP = {
  street: "st", avenue: "ave", road: "rd", drive: "dr", court: "ct",
  circle: "cir", lane: "ln", boulevard: "blvd", place: "pl", way: "way",
};
const DIRECTIONALS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"]);

// Normalizes an address down to just its street line for fuzzy-matching a
// REsimpli record against a tracker property — city/state/zip and any
// unit/apt/suite/# marker are dropped entirely (ignored for matching),
// directionals are dropped wherever they appear (not just leading), common
// street-suffix spellings are collapsed to one short form, and punctuation/
// extra whitespace is stripped. So "902 Dayton Ave Nw # 52pt" and
// "902 Dayton Ave #52" both normalize to "902 dayton ave".
//
// Dropping directionals is deliberate even though it can make two genuinely
// different addresses collide (e.g. "123 N Main St" vs "123 S Main St" both
// become "123 main st") — that's intentional: when two tracker properties
// collide this way, the normal "2+ candidates" ambiguity check below already
// sends them to review instead of guessing, which is exactly the outcome
// asked for ("if a directional is the only thing that tells two candidates
// apart, treat it as ambiguous").
export function normalizeAddressForMatch(address) {
  if (!address) return "";
  let line = (address.split(",")[0] || "").toLowerCase();
  line = line.replace(/\s*#.*$/, "");                                     // "...ave #2" / "...ave # 52pt" -> "...ave"
  line = line.replace(/\b(apt|apartment|unit|suite|ste|lot)\b.*$/, "");    // "...ave apt 2" / "...hwy 62 sw lot 7" -> "...ave "/"...hwy 62 sw "
  line = line.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  line = line.split(" ")
    .filter(w => !DIRECTIONALS.has(w))
    .map(w => ADDRESS_SUFFIX_MAP[w] || w)
    .join(" ");
  return line;
}

// Matches "123 & 125 Wessex Ct" / "123 and 125 Wessex Ct" style combined
// addresses — two house numbers sharing one street name, used by Kyle for a
// single tracker property that covers two adjoining lots/units. Returns the
// expanded list of individual addresses, or the original address unchanged
// (as a one-item list) when it isn't a combined address.
const COMBINED_ADDRESS_RE = /^(\d[\w-]*)\s*(?:&|and)\s*(\d[\w-]*)\s+(.+)$/i;
export function expandCombinedAddress(address) {
  if (!address) return [];
  const line = (address.split(",")[0] || "").trim();
  const m = line.match(COMBINED_ADDRESS_RE);
  if (!m) return [address];
  const [, num1, num2, rest] = m;
  return [`${num1} ${rest}`, `${num2} ${rest}`];
}

// Every normalized address key a plain address string should be matched against — more than
// one only for a combined address like "3126 & 3134 Wessex Ct". Shared by both sides of a
// match: a tracker property can be a combined address (propertyAddressKeys), and so can a
// REsimpli record (recordAddressKeys) — REsimpli sometimes has one inventory record covering
// the same two-lot address Kyle tracks as one property, and without expanding both sides the
// combined record's single run-together key ("3126 3134 wessex ct") never equals either of the
// property's two expanded keys.
function addressKeysFor(address) {
  return expandCombinedAddress(address).map(normalizeAddressForMatch).filter(Boolean);
}
export function propertyAddressKeys(property) {
  return addressKeysFor(property?.address);
}
export function recordAddressKeys(record) {
  return addressKeysFor(record?.address);
}

// Every REsimpli id a property has on file, from every place one could be stored: the
// explicit leadId/moduleId fields, plus any id parsed off a stored resimpli.url's query
// string (inventoryId, leadsId, soldId, leadId — REsimpli's own module-specific param names).
// A CSV-imported inventory row stores its inventoryId in resimpli.leadId (moduleId is left
// unset) AND in its URL, so this has to check all of these, not just leadId/moduleId, for a
// property's stored inventory id to ever line up with anything. Returns a Set of strings.
const URL_ID_PARAMS = ["inventoryId", "leadsId", "soldId", "leadId"];
function idsFromUrl(url) {
  if (!url) return [];
  try {
    const params = new URL(url).searchParams;
    return URL_ID_PARAMS.map(k => params.get(k)).filter(Boolean);
  } catch { return []; }
}
export function storedIdsFor(property) {
  const ids = new Set();
  if (property?.resimpli?.leadId) ids.add(String(property.resimpli.leadId));
  if (property?.resimpli?.moduleId) ids.add(String(property.resimpli.moduleId));
  idsFromUrl(property?.resimpli?.url).forEach(id => ids.add(String(id)));
  return ids;
}

// When 2+ distinct REsimpli records are each the unique match for the same property (the
// reverse-collision case below), picks the one to actually use instead of giving up to review,
// in two steps — stop at the first one that settles it:
//   1. A record whose id is among the property's own stored ids (see storedIdsFor) — the
//      record IS the one this property is already linked to, whatever REsimpli module it's
//      filed under. Matched regardless of idType (classifyOneRecord always reports "lead",
//      even for what's really an inventory/rental record by CSV-stored id).
//   2. Otherwise, a single "inventory" record among the candidates — REsimpli's current,
//      actionable record for a property that also still has a stale lead record on file
//      (Kyle's call: prefer Inventory over a plain Lead).
// Returns null (still ambiguous, nothing picked) if neither step finds exactly one winner.
function pickWinner(recordsForProp, property) {
  const storedIds = storedIdsFor(property);
  const idMatches = recordsForProp.filter(r => r.id != null && storedIds.has(String(r.id)));
  if (idMatches.length === 1) return idMatches[0];
  const inventoryMatches = recordsForProp.filter(r => r.recordType === "inventory");
  if (inventoryMatches.length === 1) return inventoryMatches[0];
  return null;
}

// Matches a list of external REsimpli records against tracker properties.
// Each record: {id, idType: "lead"|"module", address, stage, recordType, url}. `idType` is
// carried through for reference only and never gates matching — see storedIdsFor/pickWinner
// above, matching by id no longer requires it to line up with how the id was stored.
// `id`/`address` are optional — pass id:null when the record has no REsimpli id at all
// (shouldn't normally happen, but handled safely).
//
// Matching, in order, per record:
//   1. Any of the property's own stored ids (storedIdsFor — leadId, moduleId, or an id parsed
//      from its stored URL) equal to this record's id.
//   2. Falling back to normalized address, with BOTH sides expanded for a combined address
//      ("3126 & 3134 Wessex Ct") — a record matches a property if any of the record's
//      expanded/normalized address keys equals any of the property's (recordAddressKeys /
//      propertyAddressKeys), so REsimpli having one combined-address record for what Kyle
//      tracks as one combined-address property matches cleanly instead of neither key
//      equaling the other.
// A record matching 2+ properties this way is ambiguous and skipped.
//
// After the per-record pass, properties are checked for the reverse collision: a single
// tracker property (most commonly a combined address) that was the UNIQUE match for 2+
// DIFFERENT records. Rather than giving up immediately, pickWinner (above) tries to settle it
// by id first, then by preferring a lone Inventory record over a Lead — only when neither
// settles it do all of that property's matches move from `matched` into `ambiguous` instead.
//
// Returns {matched, ambiguous, noPropertyMatch, noRecordMatch}:
//   matched:         [{property, record}]
//   ambiguous:       [{record, candidates:[property,...]}]  (candidates may be a single
//                     property when the ambiguity is the reverse "2 records, 1 property" case)
//   noPropertyMatch: [record]      — records with zero matching properties
//   noRecordMatch:   [property]    — properties with zero matching (non-ambiguous) records
export function matchResimpliRecords(properties, records) {
  const byAnyId = new Map(); // id string -> [property, ...] (normally length 1)
  properties.forEach(p => {
    storedIdsFor(p).forEach(id => {
      if (!byAnyId.has(id)) byAnyId.set(id, []);
      byAnyId.get(id).push(p);
    });
  });

  const perRecordCandidates = records.map(record => {
    let candidates = [];
    if (record.id != null) {
      const idMatches = byAnyId.get(String(record.id));
      if (idMatches && idMatches.length) candidates = idMatches;
    }
    if (candidates.length === 0) {
      const keys = recordAddressKeys(record);
      if (keys.length) candidates = properties.filter(p => propertyAddressKeys(p).some(pk => keys.includes(pk)));
    }
    return { record, candidates };
  });

  const matched = [], ambiguous = [], noPropertyMatch = [];
  const provisional = new Map(); // propertyId -> [{record}] — only for records that had exactly 1 candidate here
  perRecordCandidates.forEach(({ record, candidates }) => {
    if (candidates.length === 0) { noPropertyMatch.push(record); return; }
    if (candidates.length > 1) { ambiguous.push({ record, candidates }); return; }
    const p = candidates[0];
    if (!provisional.has(p.id)) provisional.set(p.id, []);
    provisional.get(p.id).push(record);
  });

  const matchedPropIds = new Set();
  provisional.forEach((recordsForProp, propId) => {
    const property = properties.find(p => p.id === propId);
    if (recordsForProp.length === 1) {
      matched.push({ property, record: recordsForProp[0] });
      matchedPropIds.add(propId);
      return;
    }
    // Same property, 2+ distinct records (e.g. a combined address where REsimpli has a
    // separate record for each half, or a stale lead alongside a current inventory record) —
    // try to settle it instead of giving up immediately.
    const winner = pickWinner(recordsForProp, property);
    if (winner) {
      matched.push({ property, record: winner });
      matchedPropIds.add(propId);
    } else {
      recordsForProp.forEach(record => ambiguous.push({ record, candidates: [property] }));
    }
  });

  const noRecordMatch = properties.filter(p => !matchedPropIds.has(p.id));
  return { matched, ambiguous, noPropertyMatch, noRecordMatch };
}

// Exempt from assertOnlyResimpliChanged's otherwise-nothing-else-changed check — every
// top-level field the REsimpli sync/import is allowed to touch, besides property.resimpli
// itself.
const RESIMPLI_MANAGED_KEYS = new Set(["resimpliReview", "resimpliLastSyncedAt", "resimpliPipelineOrder"]);

// Client-side defense-in-depth guard, used by the CSV import's apply step (which has the full
// nexus_data blob in hand in the browser, so can diff it directly): throws unless the only
// differences between two nexus_data blobs are (a) property.resimpli on some subset of
// properties, and (b) the RESIMPLI_MANAGED_KEYS top-level fields above. No property/loan/
// lender/draw/fund may be added, removed, or changed in any other field.
//
// The server-side sync/webhook does NOT call this — resimpli_sync_read() (see
// supabase/resimpli_sync.sql) deliberately never returns a property's non-resimpli fields at
// all, so there's nothing here to diff against. Its equivalent guarantee is structural instead:
// resimpli_sync_apply() is written so it can only ever jsonb_set the resimpli key of a property
// plus the RESIMPLI_MANAGED_KEYS top-level fields — enforced by how the SQL is written, not by
// a before/after comparison.
export function assertOnlyResimpliChanged(oldData, newData) {
  const oldProps = oldData?.properties || [];
  const newProps = newData?.properties || [];
  if (oldProps.length !== newProps.length) {
    throw new Error("resimpli guard: property count changed — refusing to write");
  }
  const oldById = new Map(oldProps.map(p => [p.id, p]));
  for (const np of newProps) {
    const op = oldById.get(np.id);
    if (!op) throw new Error(`resimpli guard: new property id ${np.id} not present before — refusing to write`);
    const { resimpli: _npResimpli, ...npRest } = np;
    const { resimpli: _opResimpli, ...opRest } = op;
    if (JSON.stringify(npRest) !== JSON.stringify(opRest)) {
      throw new Error(`resimpli guard: a field other than resimpli changed on property ${np.id} — refusing to write`);
    }
  }
  const oldKeys = Object.keys(oldData || {}).filter(k => !RESIMPLI_MANAGED_KEYS.has(k));
  const newKeys = Object.keys(newData || {}).filter(k => !RESIMPLI_MANAGED_KEYS.has(k));
  for (const k of newKeys) {
    if (k === "properties") continue;
    if (JSON.stringify(newData[k]) !== JSON.stringify(oldData?.[k])) {
      throw new Error(`resimpli guard: top-level key "${k}" changed — refusing to write`);
    }
  }
  if (oldKeys.length !== newKeys.length) {
    throw new Error("resimpli guard: a top-level key was added or removed — refusing to write");
  }
}
