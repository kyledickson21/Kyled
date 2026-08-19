const fs = require('fs');

const CFG = {
  sparkBase: process.env.SPARK_API_BASE || 'https://sparkapi.com/v1',
  sparkToken: process.env.SPARK_ACCESS_TOKEN || '',
  zapierWebhookUrl: process.env.ZAPIER_WEBHOOK_URL || '',
  lookbackMinutes: parseInt(process.env.LOOKBACK_MINUTES || '60', 10),
  extraFilter: process.env.EXTRA_FILTER || '',
  pageLimit: parseInt(process.env.PAGE_LIMIT || '25', 10),
  stateFile: process.env.STATE_FILE || './state.json',
  pollIntervalMinutes: parseInt(process.env.POLL_INTERVAL_MINUTES || '0', 10),
};

function log(...a) { console.log(new Date().toISOString(), ...a); }
function readState() { try { return JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); } catch { return {}; } }
function writeState(s) { fs.writeFileSync(CFG.stateFile, JSON.stringify(s, null, 2)); }
function sparkDatetime(iso) { return `datetime'${iso.replace(/\.\d+Z$/, 'Z')}'`; }

async function fetchNewListings(sinceIso) {
  let filter = `ModificationTimestamp Gt ${sparkDatetime(sinceIso)}`;
  if (CFG.extraFilter) filter += ` And (${CFG.extraFilter})`;
  const results = []; let page = 1; let totalPages = 1;
  do {
    const params = new URLSearchParams({
      _filter: filter, _orderby: 'ModificationTimestamp', _limit: String(CFG.pageLimit),
      _page: String(page), _pagination: '1', _expand: 'CustomFields',
    });
    const res = await fetch(`${CFG.sparkBase}/listings?${params.toString()}`, {
      headers: { Authorization: `OAuth ${CFG.sparkToken}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Spark API ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const json = await res.json();
    if (!json.D || json.D.Success !== true) throw new Error(`Spark API unsuccessful: ${JSON.stringify(json).slice(0, 400)}`);
    results.push(...(json.D.Results || []));
    totalPages = json.D.Pagination ? json.D.Pagination.TotalPages : 1;
    page += 1;
  } while (page <= totalPages);
  return results;
}

async function sendToZapier(listing) {
  const std = listing.StandardFields || {};
  const payload = { listingId: listing.Id, resourceUri: listing.ResourceUri, ...std, customFields: listing.CustomFields || {} };
  const res = await fetch(CFG.zapierWebhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Zapier webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function runOnce() {
  if (!CFG.sparkToken || !CFG.zapierWebhookUrl) {
    log('WARNING: SPARK_ACCESS_TOKEN and/or ZAPIER_WEBHOOK_URL not set yet. Service is built and ready — add them to connect.');
    return;
  }
  const state = readState();
  const since = state.lastTimestamp || new Date(Date.now() - CFG.lookbackMinutes * 60 * 1000).toISOString();
  log(`Checking Spark for listings modified since ${since} ...`);
  const listings = await fetchNewListings(since);
  log(`Found ${listings.length} new/updated listing(s).`);
  let sent = 0; let newest = since; const alreadySent = new Set(state.sentIds || []);
  for (const listing of listings) {
    const mod = listing.StandardFields && listing.StandardFields.ModificationTimestamp;
    if (alreadySent.has(listing.Id)) continue;
    try {
      await sendToZapier(listing); sent += 1; alreadySent.add(listing.Id);
      if (mod && mod > newest) newest = mod;
    } catch (err) { log(`  ! Failed to send ${listing.Id}: ${err.message}`); break; }
  }
  log(`Sent ${sent} listing(s) to Zapier.`);
  writeState({ lastTimestamp: newest, sentIds: Array.from(alreadySent).slice(-500) });
}

async function main() {
  if (CFG.pollIntervalMinutes > 0) {
    log(`Starting in loop mode — every ${CFG.pollIntervalMinutes} min.`);
    const tick = async () => { try { await runOnce(); } catch (e) { log('ERROR:', e.message); } };
    await tick(); setInterval(tick, CFG.pollIntervalMinutes * 60 * 1000);
  } else {
    try { await runOnce(); } catch (e) { log('ERROR:', e.message); process.exit(1); }
  }
}
main();
