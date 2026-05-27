function slugify(s) {
  return s.toLowerCase().replace(/[,#]+/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const AUDITOR_BASE   = 'https://property.franklincountyauditor.com';
const AUDITOR_SEARCH = `${AUDITOR_BASE}/_web/search/commonsearch.aspx?mode=address`;

const NAV_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

function parseStreetParts(streetFull) {
  const DIR_RE  = /^(N|S|E|W|NE|NW|SE|SW)\s+/i;
  const TYPE_RE = /\s+(ST|AVE|BLVD|DR|RD|LN|CT|PL|WAY|PKWY|CIR|TRL|TERR?|PLACE|TRAIL)\.?$/i;
  const dir     = (streetFull.match(DIR_RE)  || [])[1] || '';
  const noDir   = streetFull.replace(DIR_RE,  '');
  const type    = (noDir.match(TYPE_RE)      || [])[1] || '';
  const name    = noDir.replace(TYPE_RE, '').trim();
  return { dir: dir.toUpperCase(), name, type: type.toUpperCase() };
}

async function getFranklinCountyData(address) {
  const fallback = { source: 'Franklin County Auditor', url: AUDITOR_SEARCH, dataSource: 'link_only' };

  const street   = (address.split(',')[0] || '').trim();
  const houseNum = (street.match(/^(\d+)/) || [])[1] || '';
  if (!houseNum) return fallback;

  const streetFull = street.replace(/^\d+\s*/, '').trim();
  const { dir, name: streetName, type: streetType } = parseStreetParts(streetFull);

  try {
    // Step 1: GET the search form — capture session cookie + ASP.NET hidden tokens
    const r1 = await fetch(AUDITOR_SEARCH, {
      headers: NAV_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
    });
    if (!r1.ok) return fallback;
    const html1  = await r1.text();
    const cookie = (r1.headers.get('set-cookie') || '').split(';')[0];

    // Extract every <input> name/value pair
    const inputs = [];
    const inputRe = /<input[^>]+name="([^"]+)"(?:[^>]+value="([^"]*)")?/gi;
    let im;
    while ((im = inputRe.exec(html1)) !== null) inputs.push({ name: im[1], value: im[2] || '' });

    // Locate house-number and street-name fields by common naming patterns
    const find = (re, skip) => inputs.find(f => re.test(f.name) && (!skip || !skip.test(f.name)));
    const houseField  = find(/house|num|situs.?n|hse/i,           /view|event|gen|btn|submit/i);
    const streetField = find(/street|situs.?s|str.?name|road/i,   /num|dir|type|suf|view|event|btn/i);
    if (!houseField || !streetField) return fallback;

    // Build form POST body
    const body = new URLSearchParams();
    inputs.filter(f => /VIEW|EVENT|GEN/i.test(f.name)).forEach(f => body.set(f.name, f.value));
    body.set(houseField.name,  houseNum);
    body.set(streetField.name, streetName);

    const dirField  = find(/situs.?dir|str.?dir|direction/i, /view|event|gen/i);
    const typeField = find(/situs.?type|str.?type|suffix/i,  /view|event|gen/i);
    if (dirField  && dir)        body.set(dirField.name,  dir);
    if (typeField && streetType) body.set(typeField.name, streetType);

    const btnField = find(/btn.?search|search.?btn/i);
    if (btnField) body.set(btnField.name, btnField.value || 'Search');

    // Step 2: POST the address — simulates typing and clicking Search
    const r2 = await fetch(AUDITOR_SEARCH, {
      method: 'POST',
      headers: {
        ...NAV_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': AUDITOR_SEARCH,
        'Cookie': cookie,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: body.toString(),
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
    });
    if (!r2.ok) return fallback;
    const html2 = await r2.text();

    // Find the parcel PIN in the results page (Datalet link or pin= param)
    const pinMatch = html2.match(/Datalet\.aspx[^"']*pin=([^"'&\s]+)/i)
                  || html2.match(/[?&]pin=(\d{9,})/i);
    if (!pinMatch) return fallback;

    const pin       = pinMatch[1].replace(/-/g, '');
    const parcelUrl = `${AUDITOR_BASE}/_web/Datalets/Datalet.aspx?mode=&UseSearch=no&jur=025&pin=${pin}`;

    // Step 3: GET the property detail page
    const r3 = await fetch(parcelUrl, {
      headers: {
        ...NAV_HEADERS,
        'Referer': r2.url || AUDITOR_SEARCH,
        'Cookie': cookie,
        'Sec-Fetch-Site': 'same-origin',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    });
    const parcelFallback = { source: 'Franklin County Auditor', url: parcelUrl, dataSource: 'link_only' };
    if (!r3.ok) return parcelFallback;
    const html3 = await r3.text();

    // Parse data from datalet HTML using label→value proximity matching
    function grabDollar(labelRe) {
      const re = new RegExp(labelRe.source + '[\\s\\S]{0,400}?\\$([\\d,]+)', 'i');
      const m  = html3.match(re);
      if (!m) return null;
      const n = Number(m[1].replace(/,/g, ''));
      return n > 0 ? n : null;
    }
    function grabNum(labelRe) {
      const re = new RegExp(labelRe.source + '[\\s\\S]{0,200}?>\\s*([\\d\\.]+)\\s*<', 'i');
      const m  = html3.match(re);
      if (!m) return null;
      const n = Number(m[1]);
      return !isNaN(n) && n > 0 ? n : null;
    }
    function grabText(labelRe) {
      const re = new RegExp(labelRe.source + '[\\s\\S]{0,200}?>([^<]{2,80})<', 'i');
      const m  = html3.match(re);
      return m ? m[1].trim().replace(/\s+/g, ' ') : null;
    }

    const appraisedValue = grabDollar(/total\s*(?:market\s*)?value|market\s*value|appraised\s*value/i)
                        || grabDollar(/total\s*value/i);
    const landValue      = grabDollar(/land\s*value/i);
    const buildingValue  = grabDollar(/building\s*value|improvement/i);
    const sqft           = grabNum(/living\s*area|floor\s*area|sq(?:uare)?\s*f(?:ee)?t/i);
    const beds           = grabNum(/bedrooms?\b/i);
    const baths          = grabNum(/full\s*baths?|bathrooms?\b/i);
    const halfBaths      = grabNum(/half\s*baths?/i);
    const yearBuilt      = grabNum(/year\s*built/i);
    const ownerName      = grabText(/(?:primary\s*)?owner(?:\s*name)?/i);
    const salePrice      = grabDollar(/(?:last\s*)?sale\s*price|transfer\s*amount/i);
    const saleDate       = grabText(/(?:last\s*)?sale\s*date|transfer\s*date/i);

    return {
      source: 'Franklin County Auditor',
      dataSource: appraisedValue ? 'live' : 'partial',
      parcelId: pin,
      ownerName,
      appraisedValue,
      landValue,
      buildingValue,
      sqft,
      beds,
      baths,
      halfBaths,
      yearBuilt,
      salePrice,
      saleDate,
      url: parcelUrl,
    };
  } catch {
    return fallback;
  }
}

async function getZillowData(address) {
  const slugAddr   = slugify(address);
  const defaultUrl = `https://www.zillow.com/homes/${slugAddr}_rb/`;
  const fallback   = { url: defaultUrl, estimate: null, beds: null, baths: null, sqft: null, dataSource: 'link_only' };

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
    const r = await fetch(defaultUrl, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ...fallback, url: r.url || defaultUrl };
    const html = await r.text();

    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return { ...fallback, url: r.url || defaultUrl };

    const data      = JSON.parse(m[1]);
    const pageProps = data?.props?.pageProps;
    const cache     = pageProps?.componentProps?.gdpClientCache || pageProps?.gdpClientCache;
    let property    = null;
    if (cache) {
      const key = Object.keys(cache)[0];
      property  = cache[key]?.property || null;
    }
    if (!property) return { ...fallback, url: r.url || defaultUrl };

    const estimate = property.zestimate || property.zestimateSingleFamily || null;
    return {
      url:        r.url || defaultUrl,
      estimate:   estimate ? Number(estimate) : null,
      beds:       property.bedrooms   ?? property.beds  ?? null,
      baths:      property.bathrooms  ?? property.baths ?? null,
      sqft:       property.livingArea ?? property.livingAreaValue ?? null,
      dataSource: estimate ? 'live' : 'link_only',
    };
  } catch {
    return fallback;
  }
}

async function getRedfinData(address) {
  const searchUrl = `https://www.redfin.com/search?q=${encodeURIComponent(address)}`;
  const fallback  = { url: searchUrl, estimate: null, beds: null, baths: null, sqft: null, dataSource: 'link_only' };

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
      { headers: HEADERS, signal: AbortSignal.timeout(3500) }
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
      const qs     = `propertyId=${propertyId}&listingId=${listingId}&pageType=0&accessLevel=3`;
      const refHdr = { ...HEADERS, Referer: propertyUrl };
      const [avmRes, detailRes] = await Promise.allSettled([
        fetch(`https://www.redfin.com/stingray/api/home/details/avm?${qs}`,          { headers: refHdr, signal: AbortSignal.timeout(3500) }),
        fetch(`https://www.redfin.com/stingray/api/home/details/aboveTheFold?${qs}`, { headers: refHdr, signal: AbortSignal.timeout(3500) }),
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
            const j    = JSON.parse(t.replace(/^\{\}&&/, ''));
            const p    = j?.payload;
            const info = p?.mainHouseInfo || p?.propertyOverview || {};
            beds        = info.beds  ?? p?.beds  ?? null;
            baths       = info.baths ?? p?.baths ?? null;
            const sqftRaw = info.sqFt ?? p?.sqFt ?? null;
            sqft        = sqftRaw?.value ?? (typeof sqftRaw === 'number' ? sqftRaw : null);
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
  const street     = (address.split(',')[0] || '').trim();
  const _citySegment = (address.split(',')[1] || '').trim().replace(/\s+[A-Z]{2}\b.*$/, '').trim();
  const cityRaw    = (_citySegment && !/^[A-Z]{2}[\s\d]*$/.test(_citySegment)) ? _citySegment : 'Columbus';

  const [auditorResult, zillowResult, redfinResult] = await Promise.allSettled([
    isFranklin
      ? getFranklinCountyData(address)
      : Promise.resolve((() => {
          const info = COUNTY_AUDITOR[county];
          return info
            ? { source: info.name, url: info.url, dataSource: 'link_only' }
            : { source: `${county} Auditor`, url: AUDITOR_SEARCH, dataSource: 'link_only' };
        })()),
    getZillowData(address),
    getRedfinData(address),
  ]);

  const searchFallback = { source: 'Franklin County Auditor', url: AUDITOR_SEARCH, dataSource: 'link_only' };
  const zillowUrl   = `https://www.zillow.com/homes/${slugify(address)}_rb/`;
  const realtorUrl  = `https://www.realtor.com/realestateandhomes-search/${cityRaw.replace(/\s+/g, '-')}_OH?q=${encodeURIComponent(street)}`;

  return res.json({
    auditor: (auditorResult.status === 'fulfilled' && auditorResult.value) ? auditorResult.value : searchFallback,
    zillow:  zillowResult.status  === 'fulfilled' ? zillowResult.value  : { url: zillowUrl,  estimate: null, dataSource: 'link_only' },
    redfin:  redfinResult.status  === 'fulfilled' ? redfinResult.value  : { url: `https://www.redfin.com/search?q=${encodeURIComponent(address)}`, estimate: null, dataSource: 'link_only' },
    realtor: { url: realtorUrl, estimate: null, dataSource: 'link_only' },
  });
}
