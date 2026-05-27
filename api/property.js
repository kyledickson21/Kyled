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
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  const json = await r.json();
  if (!Array.isArray(json.features) || json.features.length === 0) return null;
  return json.features[0].attributes;
}

async function getFranklinCountyData(address) {
  const base = { source: 'Franklin County Auditor', url: 'https://www.franklincountyauditor.com/real-estate/search', dataSource: 'link_only' };
  const { houseNum, streetName } = parseStreet(address);
  if (!houseNum || !streetName) return base;

  const firstWord = streetName.split(' ')[0];
  const wherePatterns = [
    `HOUSE_NO='${houseNum}' AND STREET_NAME LIKE '${firstWord}%'`,
    `ADDR_NUM='${houseNum}' AND ADDR_STREET LIKE '${firstWord}%'`,
    `SITEADDRESS LIKE '${houseNum} ${firstWord}%'`,
    `ADDRESS LIKE '${houseNum} ${firstWord}%'`,
  ];

  for (const arcBase of FC_ARCGIS_CANDIDATES) {
    for (const where of wherePatterns) {
      try {
        const attrs = await queryArcGIS(arcBase, where);
        if (!attrs) continue;
        const get = (...keys) => {
          for (const k of keys) {
            const hit = Object.keys(attrs).find(a => a.toLowerCase() === k.toLowerCase());
            if (hit != null && attrs[hit] != null && attrs[hit] !== '') return attrs[hit];
          }
          return null;
        };
        const appraisedValue = get('APPR_VALUE', 'APPRTOTVALUE', 'APPRAISED_VALUE', 'TOTALVALUE', 'MARKET_VALUE');
        if (!appraisedValue) continue;
        const toNum = v => v == null ? null : (typeof v === 'number' ? v : parseFloat(v) || null);
        const parcelId = get('PARCEL_ID', 'PARCELID', 'PARCEL', 'PIN', 'APN');
        return {
          ...base,
          parcelId,
          ownerName: get('OWNER_NAME', 'OWNERNAME', 'OWNER1', 'GRANTEE'),
          appraisedValue: toNum(appraisedValue),
          landValue: toNum(get('LAND_VALUE', 'LANDVALUE', 'APPR_LAND')),
          buildingValue: toNum(get('BLDG_VALUE', 'BUILDINGVALUE', 'APPR_BLDG', 'IMPR_VALUE')),
          salePrice: toNum(get('SALE_PRICE', 'SALEPRICE', 'LAST_SALE_PRICE')),
          saleDate: get('SALE_DATE', 'SALEDATE', 'LAST_SALE_DATE'),
          yearBuilt: get('YEAR_BUILT', 'YEARBUILT', 'YR_BUILT'),
          sqft: toNum(get('SQFT', 'BLDG_SQFT', 'LIVINGSQFT', 'FINISHED_SQFT', 'LIVING_AREA', 'TOTAL_SQFT', 'GBA')),
          beds: toNum(get('BEDROOMS', 'BDRMS', 'NBR_BDRM', 'BEDS', 'NBR_BEDRMS', 'NO_BDRMS', 'BEDRMS')),
          baths: toNum(get('FULL_BATHS', 'BATHROOMS', 'BATHS', 'NBR_FULL_BATH', 'NBR_BATH', 'FULL_BATH', 'BATH')),
          halfBaths: toNum(get('HALF_BATHS', 'HALF_BATH', 'HALFBATH', 'NBR_HALF_BATH', 'HALFBATHS')),
          url: parcelId
            ? `https://www.franklincountyauditor.com/real-estate/parcelid/${encodeURIComponent(parcelId)}`
            : base.url,
          dataSource: 'live',
        };
      } catch { /* try next */ }
    }
  }
  return base;
}

async function getRedfinData(address) {
  const fallback = { url: 'https://www.redfin.com/city/9949/OH/Columbus', estimate: null, beds: null, baths: null, sqft: null, dataSource: 'link_only' };
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.redfin.com/',
  };
  try {
    const r1 = await fetch(
      `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(address)}&v=2&iss=false`,
      { headers: HEADERS, signal: AbortSignal.timeout(7000) }
    );
    const json1 = JSON.parse((await r1.text()).replace(/^\{\}&&/, ''));
    const match = json1?.payload?.exactMatch || json1?.payload?.sections?.[0]?.rows?.[0];
    if (!match?.url) return fallback;
    const propertyUrl = `https://www.redfin.com${match.url}`;
    const propertyId = match.id?.split('/').at(-1) || match.propertyId || match.id;
    const listingId = match.listingId || '';

    let estimate = null, beds = null, baths = null, sqft = null;

    if (propertyId) {
      const qs = `propertyId=${propertyId}&listingId=${listingId}&pageType=0&accessLevel=3`;
      const refHdr = { ...HEADERS, Referer: propertyUrl };
      const [avmRes, detailRes] = await Promise.allSettled([
        fetch(`https://www.redfin.com/stingray/api/home/details/avm?${qs}`, { headers: refHdr, signal: AbortSignal.timeout(6000) }),
        fetch(`https://www.redfin.com/stingray/api/home/details/aboveTheFold?${qs}`, { headers: refHdr, signal: AbortSignal.timeout(6000) }),
      ]);

      if (avmRes.status === 'fulfilled') {
        try {
          const j = JSON.parse((await avmRes.value.text()).replace(/^\{\}&&/, ''));
          estimate = j?.payload?.predictedValue ?? null;
        } catch {}
      }

      if (detailRes.status === 'fulfilled') {
        try {
          const j = JSON.parse((await detailRes.value.text()).replace(/^\{\}&&/, ''));
          const p = j?.payload;
          const info = p?.mainHouseInfo || p?.propertyOverview || p?.propertyDetailsHeader || {};
          beds  = info.beds  ?? p?.beds  ?? null;
          baths = info.baths ?? p?.baths ?? null;
          const sqftRaw = info.sqFt ?? info.sqft ?? p?.sqFt ?? p?.sqft ?? null;
          sqft = sqftRaw?.value ?? (typeof sqftRaw === 'number' ? sqftRaw : null);
        } catch {}
      }
    }

    return { url: propertyUrl, estimate, beds, baths, sqft, dataSource: estimate != null ? 'live' : 'link_only' };
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
    return {
      source: info?.name || `${county || 'County'} Auditor`,
      url: info?.url || 'https://www.franklincountyauditor.com/real-estate/search',
      dataSource: 'link_only',
    };
  })();

  const [auditorResult, redfinResult] = await Promise.allSettled([
    isFranklin ? getFranklinCountyData(address) : Promise.resolve(auditorFallback),
    getRedfinData(address),
  ]);

  const slugAddr   = slugify(address);
  const slugStreet = slugify((address.split(',')[0] || '').trim());
  const slugCity   = slugify((address.split(',')[1] || 'Columbus').trim());

  return res.json({
    auditor: auditorResult.status === 'fulfilled' ? auditorResult.value : auditorFallback,
    redfin:  redfinResult.status  === 'fulfilled' ? redfinResult.value  : { url: 'https://www.redfin.com/city/9949/OH/Columbus', estimate: null, beds: null, baths: null, sqft: null, dataSource: 'link_only' },
    zillow:  { url: `https://www.zillow.com/homes/${slugAddr}_rb/`, estimate: null, dataSource: 'link_only' },
    realtor: { url: `https://www.realtor.com/realestateandhomes-detail/${slugStreet}_${slugCity}_OH`, estimate: null, dataSource: 'link_only' },
  });
}
