function slugify(s) {
  return s.toLowerCase().replace(/[,#]+/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Franklin County: ArcGIS Online hosted FeatureServer (public, CORS-enabled)
// Dataset: https://auditor-fca.opendata.arcgis.com/datasets/parcel-boundaries/about
const FC_ARCGIS_URL = 'https://services2.arcgis.com/ziXVzbDCaQbhK2TI/arcgis/rest/services/Parcel_Features/FeatureServer/0';

async function getFranklinCountyData(address) {
  const street = (address.split(',')[0] || '').trim();
  const houseNum = (street.match(/^(\d+)/) || [])[1] || '';
  const streetRaw = street.replace(/^\d+\s*/, '').trim().toUpperCase();
  const firstWord = streetRaw.split(' ')[0];
  if (!houseNum || !firstWord) return null;

  const searchUrl = 'https://www.franklincountyauditor.com/real-estate/search';

  // Try the ArcGIS Online hosted parcel layer first
  const where = `SITEADDRESS LIKE '${houseNum} ${firstWord}%'`;
  try {
    const qs = new URLSearchParams({
      where,
      outFields: 'PARCELID,OWNERNME1,SITEADDRESS,TOTVALUEBA,RESFLRAREA,LNDVALUEBA,BLDVALUEBA',
      returnGeometry: 'false',
      resultRecordCount: '3',
      f: 'json',
    });
    const r = await fetch(`${FC_ARCGIS_URL}/query?${qs}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error || !j.features?.length) return { source: 'Franklin County Auditor', url: searchUrl, dataSource: 'link_only' };

    const a = j.features[0].attributes;
    const parcelId = a.PARCELID ? String(a.PARCELID) : null;
    const pinNoDash = parcelId ? parcelId.replace(/-/g, '') : null;
    const propUrl = pinNoDash
      ? `https://property.franklincountyauditor.com/_web/Datalets/Datalet.aspx?mode=&UseSearch=no&jur=025&pin=${pinNoDash}`
      : searchUrl;

    const totalValue = a.TOTVALUEBA ? Number(a.TOTVALUEBA) : null;
    return {
      source: 'Franklin County Auditor',
      dataSource: totalValue ? 'live' : 'partial',
      parcelId,
      ownerName: a.OWNERNME1 || null,
      appraisedValue: totalValue,
      landValue: a.LNDVALUEBA ? Number(a.LNDVALUEBA) : null,
      buildingValue: a.BLDVALUEBA ? Number(a.BLDVALUEBA) : null,
      sqft: a.RESFLRAREA ? Number(a.RESFLRAREA) : null,
      beds: null,
      baths: null,
      halfBaths: null,
      url: propUrl,
    };
  } catch {
    return { source: 'Franklin County Auditor', url: searchUrl, dataSource: 'link_only' };
  }
}

async function getZillowData(address) {
  const slugAddr = slugify(address);
  const defaultUrl = `https://www.zillow.com/homes/${slugAddr}_rb/`;
  const fallback = { url: defaultUrl, estimate: null, beds: null, baths: null, sqft: null, dataSource: 'link_only' };

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };

  try {
    const r = await fetch(defaultUrl, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { ...fallback, url: r.url || defaultUrl };
    const html = await r.text();

    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return { ...fallback, url: r.url || defaultUrl };

    const data = JSON.parse(m[1]);
    const pageProps = data?.props?.pageProps;
    const cache = pageProps?.componentProps?.gdpClientCache || pageProps?.gdpClientCache;
    let property = null;
    if (cache) {
      const key = Object.keys(cache)[0];
      property = cache[key]?.property || null;
    }
    if (!property) return { ...fallback, url: r.url || defaultUrl };

    const estimate = property.zestimate || property.zestimateSingleFamily || null;
    return {
      url: r.url || defaultUrl,
      estimate: estimate ? Number(estimate) : null,
      beds: property.bedrooms ?? property.beds ?? null,
      baths: property.bathrooms ?? property.baths ?? null,
      sqft: property.livingArea ?? property.livingAreaValue ?? null,
      dataSource: estimate ? 'live' : 'link_only',
    };
  } catch {
    return fallback;
  }
}

async function getRedfinData(address) {
  const searchUrl = `https://www.redfin.com/search?q=${encodeURIComponent(address)}`;
  const fallback = { url: searchUrl, estimate: null, beds: null, baths: null, sqft: null, dataSource: 'link_only' };

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.redfin.com/',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-rf-api-type': 'jellybeans',
  };

  try {
    const r1 = await fetch(
      `https://www.redfin.com/stingray/do/location-autocomplete?location=${encodeURIComponent(address)}&v=2&iss=false`,
      { headers: HEADERS, signal: AbortSignal.timeout(7000) }
    );
    const text = await r1.text();
    if (!text.trim().startsWith('{') && !text.trim().startsWith('{}&&')) return fallback;

    const json1 = JSON.parse(text.replace(/^\{\}&&/, ''));
    const match = json1?.payload?.exactMatch || json1?.payload?.sections?.[0]?.rows?.[0];
    if (!match?.url) return fallback;

    const propertyUrl = `https://www.redfin.com${match.url}`;
    const propertyId  = match.id?.split('/').at(-1) || match.propertyId || match.id;
    const listingId   = match.listingId || '';
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
          const t = await avmRes.value.text();
          if (t.trim().startsWith('{') || t.includes('{}&&')) {
            const j = JSON.parse(t.replace(/^\{\}&&/, ''));
            estimate = j?.payload?.predictedValue ?? null;
          }
        } catch {}
      }
      if (detailRes.status === 'fulfilled') {
        try {
          const t = await detailRes.value.text();
          if (t.trim().startsWith('{') || t.includes('{}&&')) {
            const j = JSON.parse(t.replace(/^\{\}&&/, ''));
            const p = j?.payload;
            const info = p?.mainHouseInfo || p?.propertyOverview || {};
            beds  = info.beds  ?? p?.beds  ?? null;
            baths = info.baths ?? p?.baths ?? null;
            const sqftRaw = info.sqFt ?? p?.sqFt ?? null;
            sqft  = sqftRaw?.value ?? (typeof sqftRaw === 'number' ? sqftRaw : null);
          }
        } catch {}
      }
    }

    return { url: propertyUrl, estimate, beds, baths, sqft, dataSource: estimate != null ? 'live' : 'link_only' };
  } catch {
    return fallback;
  }
}

const COUNTY_AUDITOR = {
  'Delaware County':  { name: 'Delaware County Auditor',  url: 'https://ags.co.delaware.oh.us/assessor/search' },
  'Licking County':   { name: 'Licking County Auditor',   url: 'https://www.lickingcountyauditor.org/real-estate/' },
  'Fairfield County': { name: 'Fairfield County Auditor', url: 'https://auditor.co.fairfield.oh.us/' },
  'Union County':     { name: 'Union County Auditor',     url: 'https://www.co.union.oh.us/auditor/' },
  'Madison County':   { name: 'Madison County Auditor',   url: 'https://madison.oh.us/auditor/' },
  'Pickaway County':  { name: 'Pickaway County Auditor',  url: 'https://www.co.pickaway.oh.us/Auditor/RealEstate' },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const { address, county } = req.query;
  if (!address) return res.status(400).json({ error: 'address required' });

  const isFranklin = !county || county.toLowerCase().includes('franklin');
  const street  = (address.split(',')[0] || '').trim();
  const cityRaw = (address.split(',')[1] || 'Columbus').trim().split(' ')[0];

  const [auditorResult, zillowResult, redfinResult] = await Promise.allSettled([
    isFranklin
      ? getFranklinCountyData(address)
      : Promise.resolve((() => {
          const info = COUNTY_AUDITOR[county];
          return info
            ? { source: info.name, url: info.url, dataSource: 'link_only' }
            : { source: `${county} Auditor`, url: 'https://www.franklincountyauditor.com/real-estate/search', dataSource: 'link_only' };
        })()),
    getZillowData(address),
    getRedfinData(address),
  ]);

  const zillowUrl  = `https://www.zillow.com/homes/${slugify(address)}_rb/`;
  const realtorUrl = `https://www.realtor.com/realestateandhomes-search/${encodeURIComponent(cityRaw)}_OH?q=${encodeURIComponent(street)}`;

  return res.json({
    auditor: auditorResult.status === 'fulfilled' ? auditorResult.value : { source: 'Franklin County Auditor', url: 'https://www.franklincountyauditor.com/real-estate/search', dataSource: 'link_only' },
    zillow:  zillowResult.status  === 'fulfilled' ? zillowResult.value  : { url: zillowUrl, estimate: null, dataSource: 'link_only' },
    redfin:  redfinResult.status  === 'fulfilled' ? redfinResult.value  : { url: `https://www.redfin.com/search?q=${encodeURIComponent(address)}`, estimate: null, dataSource: 'link_only' },
    realtor: { url: realtorUrl, estimate: null, dataSource: 'link_only' },
  });
}
