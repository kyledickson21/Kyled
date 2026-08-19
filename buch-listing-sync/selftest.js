const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const received = [];
function runConnector(env) {
  return new Promise((resolve, reject) => {
    const c = spawn('node', ['listing-sync.js'], { env, stdio: 'inherit' });
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    c.on('error', reject);
  });
}
const spark = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ D: { Success: true, Results: [
    { Id: 'MLS-1001', ResourceUri: '/v1/listings/MLS-1001', StandardFields: { UnparsedAddress: '482 Reinhard Ave', ListPrice: 164900, ModificationTimestamp: '2026-08-19T10:00:00Z', PrivateRemarks: 'as-is, motivated', ShowingInstructions: 'lockbox' }, CustomFields: {} },
    { Id: 'MLS-1002', ResourceUri: '/v1/listings/MLS-1002', StandardFields: { UnparsedAddress: '1177 Oakwood Ave', ListPrice: 139000, ModificationTimestamp: '2026-08-19T10:05:00Z', PrivateRemarks: 'needs full rehab', ShowingInstructions: 'tenant' }, CustomFields: {} },
  ], Pagination: { TotalRows: 2, PageSize: 25, TotalPages: 1, CurrentPage: 1 } } }));
});
const zap = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push(JSON.parse(b)); res.writeHead(200); res.end('ok'); }); });
spark.listen(0, () => { zap.listen(0, async () => {
  try { fs.unlinkSync('./state.test.json'); } catch {}
  await runConnector({ ...process.env, SPARK_API_BASE: `http://127.0.0.1:${spark.address().port}/v1`, SPARK_ACCESS_TOKEN: 'test', ZAPIER_WEBHOOK_URL: `http://127.0.0.1:${zap.address().port}/hook`, STATE_FILE: './state.test.json', LOOKBACK_MINUTES: '120' });
  let ok = received.length === 2;
  const a = received.find((r) => r.listingId === 'MLS-1001');
  if (!a || a.UnparsedAddress !== '482 Reinhard Ave' || a.ListPrice !== 164900 || !a.PrivateRemarks || !a.ShowingInstructions) ok = false;
  const st = JSON.parse(fs.readFileSync('./state.test.json', 'utf8'));
  if (st.lastTimestamp !== '2026-08-19T10:05:00Z') ok = false;
  try { fs.unlinkSync('./state.test.json'); } catch {}
  console.log(ok ? '\nSELF-TEST PASSED' : '\nSELF-TEST FAILED');
  spark.close(); zap.close(); process.exit(ok ? 0 : 1);
}); });
