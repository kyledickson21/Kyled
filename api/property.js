function parseStreet(address) {
  const street = (address.split(',')[0] || '').trim();
  const houseNum = (street.match(/^(\d+)/) || [])[1] || '';
  const streetName = street.replace(/^\d+\s*/, '').trim().toUpperCase();
  return { houseNum, streetName };
}

function slugify(s) {
  return s.toLowerCase().replace(/[,#]+/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const FC_ARCGIS_CANDIDATES = [
  'https://gis.franklincountyauditor.com/arcgis/rest/services/TAXMAP/FeatureServer/0',
  'https://maps.fcauditor.org/arcgis/rest/services/TAXMAP/FeatureServer/0',
  'https://gis.franklincountyauditor.com/server/rest/services/TAXMAP/FeatureServer/0',
];

async function queryArcGIS(base, where) {
  const url = `${base}/query?${new URLSearchParams({ where, outFields: '*', returnGeometry: 'false', resultRecordCount: '3', f: 'json' })}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const json = await r.json();
  if (!Array.isArray(json.features) || json.features.length === 0) return null;
  return json.features[0].attributes;
}

async function getFranklinCountyData(address) {
  const base = { source: 'Franklin County Auditor', county: 'Franklin', url: 'https://www.franklincountyauditor.com/real-estate/search', dataSource: 'link_only' };
  const { houseNum, streetName } = parseStreet(address);
  if (!houseNum || !streetName) return base;

  const wherePatterns = [
    `HOUSE_NO='${houseNum}' AND STREET_NAME LIKE '${streetName.split(' ')[0]}%'`,
    `ADDR_NUM='${houseNum}' AND ADDR_STREET LIKE '${streetName.split(' ')[0]}%'`,
    `SITEADDRESS LIKE '${houseNum} ${streetName.split(' ')[0]}%'`,
    `ADDRESS LIKE '${houseNum} ${streetName.split(' ')[0]}%'`,
  ];

  for (const arcBase of FC_ARCGIS_CANDIDATES) {
    for (const where of wherePatterns) {
      try {
        const attrs = await queryArcGIS(arcBase, where);
        if (!attrs) continue;
        const get = (...keys) => { for (const k of keys) { const hit = Object.keys(attrs).find(a => a.toLowerCase() === k.toLowerCase()); if (hit != null && attrs[hit] != null) return attrs[hit]; } return null; };
        const appraisedValue = get('APPR_VALUE', 'APPRTOTVALUE', 'APPRAISED_VALUE', 'TOTALVALUE', 'MARKET_VALUE');
        if (!appraisedValue) continue;
        const parcelId = get('PARCEL_ID', 'PARCELID', 'PARCEL', 'PIN', 'APN');
        return {
          ...base,
          parcelId,
          ownerName: get('OWNER_NAME', 'OWNERNAME', 'OWNER1', 'GRANTEE'),
          appraisedValue: typeof appraisedValue === 'number' ? appraisedValue : parseFloat(appraisedValue) || null,
          salePrice: (() => { const v = get('SALE_PRICE', 'SALEPRICE', 'LAST_SALE_PRICE'); return v ? (typeof v === 'number' ? v : parseFloat(v) || null) : null; })(),
          saleDate: get('SALE_DATE', 'SALEDATE', 'LAST_SALE_DATE'),
          yearBuilt: get('YEAR_BUILT', 'YEARBUILT', 'YR_BUILT'),
          sqft: get('SQFT', 'BLDG_SQFT', 'LIVINGSQFT', 'FINISHED_SQFT'),
          url: parcelId ? `https://www.franklincountyauditor.com/real-estate/parcelid/${encodeURIComponent(parcelId)}` : base.url,
          dataSource: 'live',
        };
      } catch { /* try next */ }
    }
  }
  return base;
}

async function getRedfinData(address) {
  const fallback = { url: 'https://www.redfin.com/city/9949/OH/Columbus', estimate: null, dataSource: 'link_only' };
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.redfin.com/',
  };
  try {
    const r1 = await fetch(`https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(address)}&v=2&iss=false`, { headers: HEADERS, signal: AbortSignal.timeout(6000) });
    const json1 = JSON.parse((await r1.text()).replace(/^\{\}&&/, ''));
    const match = json1?.payload?.exactMatch || json1?.payload?.sections?.[0]?.rows?.[0];
    if (!match?.url) return fallback;
    const propertyUrl = `https://www.redfin.com${match.url}`;
    const propertyId = match.id?.split('/').at(-1) || match.propertyId || match.id;
    let estimate = null;
    if (propertyId) {
      try {
        const r2 = await fetch(`https://www.redfin.com/stingray/api/home/details/avm?propertyId=${propertyId}&listingId=${match.listingId || ''}&pageType=0&accessLevel=3`, { headers: { ...HEADERS, Referer: propertyUrl }, signal: AbortSignal.timeout(5000) });
        const json2 = JSON.parse((await r2.text()).replace(/^\{\}&&/, ''));
        estimate = json2?.payload?.predictedValue ?? null;
      } catch { /* optional */ }
    }
    return { url: propertyUrl, estimate, dataSource: estimate != null ? 'live' : 'link_only' };
  } catch { return fallback; }
}

const COUNTY_AUDITOR = {
  'Franklin County':  { name: 'Franklin County Auditor',  url: 'https://www.franklincountyauditor.com/real-estate/search' },
  'Delaware County':  { name: 'Delaware County Auditor',  url: 'https://ags.co.delaware.oh.us/assessor/search' },
  'Licking County':   { name: 'Licking County Auditor',   url: 'https://www.lickingcountyauditor.org/real-estate/' },
  'Fairfield County': { name: 'Fairfield County Auditor', url: 'https://auditor.co.fairfield.oh.us/' },
  'Union County':     { name: 'Union County Auditor',     url: 'https://www.co.union.oh.us/auditor/' },
  'Madison County':   { name: 'Madison County Auditor',   url: 'https://madison.oh.us/auditor/' },
  'Pickaway County':  { name: 'Pickaway County Auditor',  url: 'https://www.co.pickaway.oh.us/Auditor/RealEstate' },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  const { address, county } = req.query;
  if (!address) return res.status(400).json({ error: 'address required' });

  const isFranklin = !county || county.toLowerCase().includes('franklin');
  const auditorFallback = (() => {
    const info = COUNTY_AUDITOR[county] || null;
    return { source: info?.name || `${county || 'County'} Auditor`, url: info?.url || 'https://www.franklincountyauditor.com/real-estate/search', dataSource: 'link_only' };
  })();

  const [auditorResult, redfinResult] = await Promise.allSettled([
    isFranklin ? getFranklinCountyData(address) : Promise.resolve(auditorFallback),
    getRedfinData(address),
  ]);

  return res.json({
    auditor: auditorResult.status === 'fulfilled' ? auditorResult.value : auditorFallback,
    redfin: redfinResult.status === 'fulfilled' ? redfinResult.value : { url: 'https://www.redfin.com/city/9949/OH/Columbus', estimate: null, dataSource: 'link_only' },
    zillow: { url: `https://www.zillow.com/homes/${slugify(address)}_rb/`, estimate: null, dataSource: 'link_only' },
    realtor: { url: `https://www.realtor.com/realestateandhomes-detail/${slugify(address.split(',')[0])}_${slugify((address.split(',')[1] || 'Columbus').trim())}_OH`, estimate: null, dataSource: 'link_only' },
  });
}
