// ─── helpers ──────────────────────────────────────────────────────────────────

function parseStreet(address) {
  const street = (address.split(',')[0] || '').trim();
  const houseNum = (street.match(/^(\d+)/) || [])[1] || '';
  const streetName = street.replace(/^\d+\s*/, '').trim().toUpperCase();
  return { houseNum, streetName };
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[,#]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Franklin County Auditor (ArcGIS REST) ────────────────────────────────────

const FC_ARCGIS_CANDIDATES = [
  'https://gis.franklincountyauditor.com/arcgis/rest/services/TAXMAP/FeatureServer/0',
  'https://maps.fcauditor.org/arcgis/rest/services/TAXMAP/FeatureServer/0',
  'https://gis.franklincountyauditor.com/server/rest/services/TAXMAP/FeatureServer/0',
];

async function queryArcGIS(base, where) {
  const url = `${base}/query?${new URLSearchParams({
    where,
    outFields: '*',
    returnGeometry: 'false',
    resultRecordCount: '3',
    f: 'json',
  })}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const json = await r.json();
  if (!Array.isArray(json.features) || json.features.length === 0) return null;
  return json.features[0].attributes;
}

async function getFranklinCountyAuditorData(address) {
  const base = {
    source: 'Franklin County Auditor',
    county: 'Franklin',
    url: `https://www.franklincountyauditor.com/real-estate/search`,
    dataSource: 'link_only',
  };

  const { houseNum, streetName } = parseStreet(address);
  if (!houseNum || !streetName) return base;

  // Try each possible ArcGIS endpoint with several field-name patterns
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

        // Normalise field names — different services use different casing
        const get = (...keys) => {
          for (const k of keys) {
            const hit = Object.keys(attrs).find(a => a.toLowerCase() === k.toLowerCase());
            if (hit != null && attrs[hit] != null) return attrs[hit];
          }
          return null;
        };

        const parcelId =
          get('PARCEL_ID', 'PARCELID', 'PARCEL', 'PIN') ||
          get('APN');
        const appraisedValue =
          get('APPR_VALUE', 'APPRTOTVALUE', 'APPRAISED_VALUE', 'TOTALVALUE', 'MARKET_VALUE');
        const ownerName =
          get('OWNER_NAME', 'OWNERNAME', 'OWNER1', 'GRANTEE');
        const yearBuilt =
          get('YEAR_BUILT', 'YEARBUILT', 'YR_BUILT');
        const sqft =
          get('SQFT', 'BLDG_SQFT', 'LIVINGSQFT', 'FINISHED_SQFT');
        const salePrice =
          get('SALE_PRICE', 'SALEPRICE', 'LAST_SALE_PRICE');
        const saleDate =
          get('SALE_DATE', 'SALEDATE', 'LAST_SALE_DATE');

        // If we got at least an appraised value we have useful data
        if (!appraisedValue) continue;

        const parcelLink = parcelId
          ? `https://www.franklincountyauditor.com/real-estate/parcelid/${encodeURIComponent(parcelId)}`
          : base.url;

        return {
          ...base,
          parcelId,
          ownerName,
          appraisedValue: typeof appraisedValue === 'number' ? appraisedValue : parseFloat(appraisedValue) || null,
          salePrice: salePrice ? (typeof salePrice === 'number' ? salePrice : parseFloat(salePrice) || null) : null,
          saleDate,
          yearBuilt,
          sqft,
          url: parcelLink,
          dataSource: 'live',
        };
      } catch {
        // try next
      }
    }
  }

  return base;
}

// ─── Redfin ──────────────────────────────────────────────────────────────────

async function getRedfinData(address) {
  const fallback = {
    url: `https://www.redfin.com/city/9949/OH/Columbus`,
    estimate: null,
    dataSource: 'link_only',
  };

  const HEADERS = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.redfin.com/',
  };

  try {
    // 1. Autocomplete
    const autoUrl = `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(address)}&v=2&iss=false`;
    const r1 = await fetch(autoUrl, {
      headers: HEADERS,
      signal: AbortSignal.timeout(6000),
    });
    const text1 = await r1.text();
    const json1 = JSON.parse(text1.replace(/^\{\}&&/, ''));

    const match =
      json1?.payload?.exactMatch ||
      json1?.payload?.sections?.[0]?.rows?.[0];

    if (!match?.url) return fallback;

    const propertyUrl = `https://www.redfin.com${match.url}`;
    const propertyId =
      match.id?.split('/').at(-1) ||
      match.propertyId ||
      match.id;

    // 2. AVM estimate
    let estimate = null;
    if (propertyId) {
      try {
        const avmUrl =
          `https://www.redfin.com/stingray/api/home/details/avm` +
          `?propertyId=${propertyId}&listingId=${match.listingId || ''}&pageType=0&accessLevel=3`;
        const r2 = await fetch(avmUrl, {
          headers: { ...HEADERS, Referer: propertyUrl },
          signal: AbortSignal.timeout(5000),
        });
        const text2 = await r2.text();
        const json2 = JSON.parse(text2.replace(/^\{\}&&/, ''));
        estimate = json2?.payload?.predictedValue ?? null;
      } catch {
        // AVM optional
      }
    }

    return { url: propertyUrl, estimate, dataSource: estimate != null ? 'live' : 'link_only' };
  } catch {
    return fallback;
  }
}

// ─── Zillow ───────────────────────────────────────────────────────────────────

function buildZillowUrl(address) {
  // Zillow canonical format: /homes/{street-city-state-zip}_rb/
  const clean = slugify(address);
  return `https://www.zillow.com/homes/${clean}_rb/`;
}

// ─── Realtor.com ──────────────────────────────────────────────────────────────

function buildRealtorUrl(address) {
  const parts = address.split(',').map(s => s.trim());
  const street = slugify(parts[0] || '');
  const city = slugify(parts[1] || 'Columbus');
  const stateZip = (parts[2] || 'OH').trim();
  const state = stateZip.replace(/\d+/g, '').trim() || 'OH';
  return `https://www.realtor.com/realestateandhomes-detail/${street}_${city}_${state}`;
}

// ─── Other county auditor links ───────────────────────────────────────────────

function getAuditorInfo(county) {
  const map = {
    'Franklin County':  { name: 'Franklin County Auditor',  url: 'https://www.franklincountyauditor.com/real-estate/search' },
    'Delaware County':  { name: 'Delaware County Auditor',  url: 'https://ags.co.delaware.oh.us/assessor/search' },
    'Licking County':   { name: 'Licking County Auditor',   url: 'https://www.lickingcountyauditor.org/real-estate/' },
    'Fairfield County': { name: 'Fairfield County Auditor', url: 'https://auditor.co.fairfield.oh.us/' },
    'Union County':     { name: 'Union County Auditor',     url: 'https://www.co.union.oh.us/auditor/' },
    'Madison County':   { name: 'Madison County Auditor',   url: 'https://madison.oh.us/auditor/' },
    'Pickaway County':  { name: 'Pickaway County Auditor',  url: 'https://www.co.pickaway.oh.us/Auditor/RealEstate' },
    'Morrow County':    { name: 'Morrow County Auditor',    url: 'https://morrowcounty.org/auditor/' },
    'Knox County':      { name: 'Knox County Auditor',      url: 'https://www.co.knox.oh.us/auditor/' },
  };
  return map[county] || null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  const { address, county } = req.query;
  if (!address) return res.status(400).json({ error: 'address required' });

  const isFranklin =
    !county || county.toLowerCase().includes('franklin');

  const [auditorResult, redfinResult] = await Promise.allSettled([
    isFranklin
      ? getFranklinCountyAuditorData(address)
      : Promise.resolve(
          (() => {
            const info = getAuditorInfo(county);
            return {
              source: info?.name || `${county} Auditor`,
              county: (county || '').replace(' County', ''),
              url: info?.url || 'https://www.franklincountyauditor.com/real-estate/search',
              dataSource: 'link_only',
            };
          })()
        ),
    getRedfinData(address),
  ]);

  return res.json({
    auditor:
      auditorResult.status === 'fulfilled'
        ? auditorResult.value
        : { source: 'County Auditor', url: '#', dataSource: 'link_only' },
    redfin:
      redfinResult.status === 'fulfilled'
        ? redfinResult.value
        : { url: 'https://www.redfin.com/city/9949/OH/Columbus', estimate: null, dataSource: 'link_only' },
    zillow: { url: buildZillowUrl(address), estimate: null, dataSource: 'link_only' },
    realtor: { url: buildRealtorUrl(address), estimate: null, dataSource: 'link_only' },
  });
}
