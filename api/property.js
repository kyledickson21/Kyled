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
  const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
  const json = await r.json();
  if (json.error) return null;
  if (!Array.isArray(json.features) || json.features.length === 0) return null;
  return json.features[0].attributes;
}

async function getFranklinCountyData(address) {
  const base = {
    source: 'Franklin County Auditor',
    url: 'https://www.franklincountyauditor.com/real-estate/search',
    dataSource: 'link_only',
  };
  const { houseNum, streetName } = parseStreet(address);
  if (!houseNum || !streetName) return base;

  const firstWord = streetName.split(' ')[0];
  const houseInt = parseInt(houseNum, 10);

  // Try many patterns — numeric and string, combined and split field names
  const wherePatterns = [
    `HOUSE_NO = ${houseInt} AND STREET_NAME LIKE '${firstWord}%'`,
    `HOUSE_NO = '${houseNum}' AND STREET_NAME LIKE '${firstWord}%'`,
    `SITEADDR LIKE '${houseNum} ${firstWord}%'`,
    `SITEADDRESS LIKE '${houseNum} ${firstWord}%'`,
    `ADDRESS LIKE '${houseNum} ${firstWord}%'`,
    `ADDR LIKE '${houseNum} ${firstWord}%'`,
    `ADDR_NUM = ${houseInt} AND ADDR_STREET LIKE '${firstWord}%'`,
    `ADDR_NUM = '${houseNum}' AND ADDR_STREET LIKE '${firstWord}%'`,
    `FULLADDR LIKE '${houseNum} ${firstWord}%'`,
    `PROP_ADDR LIKE '${houseNum} ${firstWord}%'`,
  ];

  for (const arcBase of FC_ARCGIS_CANDIDATES) {
    for (const where of wherePatterns) {
      try {
        const attrs = await queryArcGIS(arcBase, where);
        if (!attrs) continue;

        // Flexible field getter — case-insensitive, skips nulls and empty strings
        const get = (...keys) => {
          for (const k of keys) {
            const hit = Object.keys(attrs).find(a => a.toLowerCase() === k.toLowerCase());
            const v = hit != null ? attrs[hit] : undefined;
            if (v != null && v !== '' && v !== 0) return v;
          }
          return null;
        };

        // Must find at least a parcel ID to be useful
        const parcelId = get('PARCELID', 'PARCEL_ID', 'PARCEL', 'PIN', 'APN', 'PARID', 'PARCELNUMBER', 'TAXPARCELID');
        if (!parcelId) continue;

        const toNum = v => v == null ? null : (typeof v === 'number' ? v : parseFloat(String(v).replace(/[,$]/g, '')) || null);

        const appraisedValue = get(
          'APPRTOTVALUE', 'APPR_VALUE', 'TOTALVALUE', 'TOTVALUE', 'MARKETVALUE',
          'APPRVALUE', 'TOTALAPPRVALUE', 'APPRAISED_VALUE', 'APPR_TOT_VALUE',
          'FAIR_MARKET_VALUE', 'FAIRMARKVALUE', 'ASSESSED_VALUE', 'TOTALASSESSED',
          'ASSMT_VALUE', 'ASSMTVALUE', 'TOTALASMT'
        );

        return {
          ...base,
          dataSource: appraisedValue ? 'live' : 'partial',
          parcelId: String(parcelId),
          ownerName: get('OWNER_NAME', 'OWNERNAME', 'OWNER1', 'GRANTEE', 'OWNER'),
          appraisedValue: toNum(appraisedValue),
          landValue: toNum(get('APPRLANDVALUE', 'LAND_VALUE', 'LANDVALUE', 'APPR_LAND', 'LAND')),
          buildingValue: toNum(get('APPRBLDGVALUE', 'BLDG_VALUE', 'BUILDINGVALUE', 'APPR_BLDG', 'IMPR_VALUE', 'BLDG')),
          salePrice: toNum(get('SALEPRICE', 'SALE_PRICE', 'LAST_SALE_PRICE', 'LASTSALEPRICE')),
          saleDate: get('SALEDATE', 'SALE_DATE', 'LAST_SALE_DATE', 'LASTSALEDATE'),
          yearBuilt: get('YEARBUILT', 'YEAR_BUILT', 'YR_BUILT', 'YRBUILT'),
          sqft: toNum(get('LIVINGSQFT', 'SQFT', 'BLDG_SQFT', 'GRSTLIVINGSQFT', 'FINISHED_SQFT', 'LIVING_AREA', 'GBA', 'LIVINGAREA')),
          beds: toNum(get('BEDRMS', 'BEDROOMS', 'BDRMS', 'NBR_BDRM', 'BEDS', 'NBR_BEDRMS', 'NO_BDRMS')),
          baths: toNum(get('BATHS', 'BATHROOMS', 'FULL_BATHS', 'NBR_FULL_BATH', 'NBR_BATH', 'FULL_BATH', 'NUMBATHS')),
          halfBaths: toNum(get('HALFBATH', 'HALF_BATH', 'HALF_BATHS', 'HALFBATHS', 'NBR_HALF_BATH')),
          url: `https://www.franklincountyauditor.com/real-estate/parcelid/${encodeURIComponent(String(parcelId))}`,
        };
      } catch { /* try next */ }
    }
  }
  return base;
}

async function getZillowData(address) {
  const slugAddr = slugify(address);
  const defaultUrl = `https://www.zillow.com/homes/${slugAddr}_rb/`;
  const fallback = { url: defaultUrl, estimate: null, beds: null, baths: null, sqft: null, dataSource: 'link_only' };

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };

  try {
    const r = await fetch(defaultUrl, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    if (!r.ok) return { ...fallback, url: r.url || defaultUrl };
    const html = await r.text();

    // Extract Next.js embedded data
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return { ...fallback, url: r.url || defaultUrl };

    const data = JSON.parse(m[1]);
    const pageProps = data?.props?.pageProps;

    // Zillow embeds property data in gdpClientCache
    const cache = pageProps?.componentProps?.gdpClientCache || pageProps?.gdpClientCache;
    let property = null;

    if (cache) {
      const key = Object.keys(cache)[0];
      property = cache[key]?.property || null;
    }

    // Fallback: look in initialReduxState
    if (!property) {
      const redux = pageProps?.componentProps?.initialReduxState;
      const gdp = redux?.gdp?.response?.propertyResponse;
      if (gdp) property = gdp;
    }

    if (!property) return { ...fallback, url: r.url || defaultUrl };

    const estimate = property.zestimate
      || property.zestimateSingleFamily
      || property.price
      || null;

    return {
      url: r.url || defaultUrl,
      estimate: estimate ? Number(estimate) : null,
      beds: property.bedrooms ?? property.beds ?? null,
      baths: property.bathrooms ?? property.baths ?? null,
      sqft: property.livingArea ?? property.livingAreaValue ?? property.sqftFinished ?? null,
      dataSource: estimate ? 'live' : 'link_only',
    };
  } catch {
    return fallback;
  }
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

  const [auditorResult, zillowResult, redfinResult] = await Promise.allSettled([
    isFranklin ? getFranklinCountyData(address) : Promise.resolve(auditorFallback),
    getZillowData(address),
    getRedfinData(address),
  ]);

  const slugStreet = slugify((address.split(',')[0] || '').trim());
  const slugCity   = slugify((address.split(',')[1] || 'Columbus').trim());

  return res.json({
    auditor: auditorResult.status === 'fulfilled' ? auditorResult.value : auditorFallback,
    zillow:  zillowResult.status  === 'fulfilled' ? zillowResult.value  : { url: `https://www.zillow.com/homes/${slugify(address)}_rb/`, estimate: null, dataSource: 'link_only' },
    redfin:  redfinResult.status  === 'fulfilled' ? redfinResult.value  : { url: 'https://www.redfin.com/city/9949/OH/Columbus', estimate: null, beds: null, baths: null, sqft: null, dataSource: 'link_only' },
    realtor: { url: `https://www.realtor.com/realestateandhomes-detail/${slugStreet}_${slugCity}_OH`, estimate: null, dataSource: 'link_only' },
  });
}
