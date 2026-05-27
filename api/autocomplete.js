export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=8&countrycodes=us`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'NexusHomesPropertyLookup/1.0 (kyle@nexushomesoh.com)',
        'Accept-Language': 'en-US,en',
      },
      signal: AbortSignal.timeout(6000),
    });
    const data = await r.json();
    res.json(data.filter(d => d.address?.house_number));
  } catch {
    res.json([]);
  }
}
