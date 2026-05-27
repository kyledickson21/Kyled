export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { address } = req.query;
  if (!address) return res.json({ error: 'pass ?address=...' });

  const street = (address.split(',')[0] || '').trim();
  const houseNum = (street.match(/^(\d+)/) || [])[1] || '';
  const streetName = street.replace(/^\d+\s*/, '').trim().toUpperCase();
  const firstWord = streetName.split(' ')[0];

  const results = {};

  // Test each ArcGIS base
  const bases = [
    'https://gis.franklincountyauditor.com/arcgis/rest/services/TAXMAP/FeatureServer/0',
    'https://maps.fcauditor.org/arcgis/rest/services/TAXMAP/FeatureServer/0',
    'https://gis.franklincountyauditor.com/server/rest/services/TAXMAP/FeatureServer/0',
  ];

  for (const base of bases) {
    const key = base.split('/')[2];
    try {
      // First get the layer fields
      const metaR = await fetch(`${base}?f=json`, { signal: AbortSignal.timeout(6000) });
      const meta = await metaR.json();
      results[key + '_fields'] = meta.fields?.map(f => `${f.name}(${f.type})`).join(', ') || 'no fields';

      // Try a broad query
      const where = `HOUSE_NO = ${parseInt(houseNum)} AND STREET_NAME LIKE '${firstWord}%'`;
      const qR = await fetch(`${base}/query?${new URLSearchParams({ where, outFields: '*', returnGeometry: 'false', resultRecordCount: '2', f: 'json' })}`, { signal: AbortSignal.timeout(6000) });
      const q = await qR.json();
      results[key + '_query'] = q.error ? `ERROR: ${q.error.message}` : `${q.features?.length || 0} features`;
      if (q.features?.length) results[key + '_attrs'] = q.features[0].attributes;
    } catch (e) {
      results[key] = `FAILED: ${e.message}`;
    }
  }

  // Test Redfin
  try {
    const HEADERS = { 'User-Agent': 'Mozilla/5.0 Chrome/124', Accept: 'application/json', Referer: 'https://www.redfin.com/' };
    const r = await fetch(`https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(address)}&v=2&iss=false`, { headers: HEADERS, signal: AbortSignal.timeout(7000) });
    const text = await r.text();
    const j = JSON.parse(text.replace(/^\{\}&&/, ''));
    const match = j?.payload?.exactMatch || j?.payload?.sections?.[0]?.rows?.[0];
    results.redfin_match = match ? { url: match.url, id: match.id, propertyId: match.propertyId } : 'no match';
  } catch (e) {
    results.redfin = `FAILED: ${e.message}`;
  }

  return res.json(results);
}
