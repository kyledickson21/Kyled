export const config = { runtime: 'edge' };

function slugify(s) {
  return s.toLowerCase().replace(/[,#]+/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const AUDITOR_BASE   = 'https://property.franklincountyauditor.com';
const AUDITOR_SEARCH = `${AUDITOR_BASE}/_web/search/CommonSearch.aspx?mode=ADDRESS`;

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
  const name    = noDir.replace(TYPE_RE, '').trim();
  return { dir: dir.toUpperCase(), name };
}

async function getFranklinCountyData(address) {
  const fallback = { source: 'Franklin County Auditor', url: AUDITOR_SEARCH, dataSource: 'link_only' };

  const street   = (address.split(',')[0] || '').trim();
  const houseNum = (street.match(/^(\d+)/) || [])[1] || '';
  if (!houseNum) return fallback;

  const streetFull = street.replace(/^\d+\s*/, '').trim();
  const { dir, name: streetName } = parseStreetParts(streetFull);

  try {
    // Step 1: GET the search form — capture session cookie + ASP.NET hidden tokens
    const r1 = await fetch(AUDITOR_SEARCH, {
      headers: NAV_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });
    if (!r1.ok) return fallback;
    const html1 = await r1.text();

    // Collect session cookies
    const rawCookies = typeof r1.headers.getSetCookie === 'function'
      ? r1.headers.getSetCookie()
      : (r1.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/).map(s => s.trim());
    const cookie = rawCookies.map(c => c.split(';')[0]).join('; ');

    // Extract all hidden <input> fields (VIEWSTATE, EVENTVALIDATION, etc.)
    const inputs = [];
    const inputRe = /<input([^>]+?)(?:\/?>)/gi;
    let im;
    while ((im = inputRe.exec(html1)) !== null) {
      const attrs  = im[1];
      const nameM  = attrs.match(/\bname="([^"]+)"/i);
      const valueM = attrs.match(/\bvalue="([^"]*)"/i);
      const typeM  = attrs.match(/\btype="([^"]+)"/i);
      if (nameM) inputs.push({
        name:  nameM[1],
        value: valueM ? valueM[1] : '',
        type:  typeM  ? typeM[1].toLowerCase() : 'text',
      });
    }

    // Build POST body — exact field names confirmed from working Python scraper
    const body = new URLSearchParams();
    inputs.filter(f => f.type === 'hidden').forEach(f => body.set(f.name, f.value));
    body.set('__EVENTTARGET',   '');
    body.set('__EVENTARGUMENT', '');
    body.set('inpNumber',   houseNum);
    body.set('Select1',     dir);       // direction: N, S, E, W, etc.
    body.set('inpStreet',   streetName);
    body.set('inpSuffix1',  '');        // leave blank for broader match (Python scraper always sends "")
    body.set('inpUnit',     '');
    body.set('selSortBy',   'PARID');
    body.set('selSortDir',  'ASC');
    body.set('selPageSize', '15');
    body.set('btSearch',    'Search');

    // Step 2: POST — simulates clicking Search on the auditor's address form
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
      signal: AbortSignal.timeout(5000),
    });
    if (!r2.ok) return fallback;
    const html2 = await r2.text();

    let html3, parcelUrl, pin;

    // Single result: either the POST redirected to the datalet page, or it returned it inline
    if (r2.url.includes('Datalet.aspx') || html2.includes('DataletHeaderTopFC')) {
      html3     = html2;
      parcelUrl = r2.url;
      pin       = (r2.url.match(/[?&]pin=([^&]+)/i) || [])[1]?.replace(/-/g, '') || '';
    } else {
      // Multiple results — pick the first SearchResults row
      const srMatch = html2.match(/selectSearchRow\(\s*['"]([^'"]+)['"]\s*\)/i);
      if (!srMatch) return fallback;

      const relPath    = srMatch[1];
      const dataletUrl = relPath.startsWith('http')
        ? relPath
        : `${AUDITOR_BASE}${relPath.startsWith('/') ? '' : '/'}${relPath}`;
      pin       = (dataletUrl.match(/[?&]pin=([^&]+)/i) || [])[1]?.replace(/-/g, '') || '';
      parcelUrl = dataletUrl;

      // Step 3: GET the property detail (datalet) page
      const r3 = await fetch(dataletUrl, {
        headers: {
          ...NAV_HEADERS,
          'Referer': AUDITOR_SEARCH,
          'Cookie': cookie,
          'Sec-Fetch-Site': 'same-origin',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(5000),
      });
      if (!r3.ok) return { source: 'Franklin County Auditor', url: dataletUrl, dataSource: 'link_only' };
      html3 = await r3.text();
    }

    // Extract parcel ID from page text if not in URL
    if (!pin) {
      const pidM = html3.match(/Parcel\s*(?:ID|No\.?)[:\s]+([0-9]{3}-[0-9]+-[0-9]+-[0-9]+)/i)
                || html3.match(/Parcel\s*(?:ID|No\.?)[:\s]+([0-9]{9,})/i);
      if (pidM) pin = pidM[1].replace(/-/g, '');
    }

    // Use canonical permalink if available
    const plinkM = html3.match(/href="([^"]*redir\/Link\/Parcel\/[^"]+)"/i);
    if (plinkM) parcelUrl = plinkM[1];

    // ── Parse property data from Franklin County datalet HTML ──────────────────

    function grabDollar(labelRe) {
      const re = new RegExp(labelRe.source + '[\\s\\S]{0,400}?\\$([\\d,]+)', 'i');
      const m  = html3.match(re);
      if (!m) return null;
      const n = Number(m[1].replace(/,/g, ''));
      return n > 0 ? n : null;
    }
    function grabNum(labelRe) {
      const re = new RegExp(labelRe.source + '[\\s\\S]{0,300}?>\\s*([\\d,\\.]+)\\s*<', 'i');
      const m  = html3.match(re);
      if (!m) return null;
      const n = Number(m[1].replace(/,/g, ''));
      return !isNaN(n) && n > 0 ? n : null;
    }
    function grabText(labelRe) {
      const re = new RegExp(labelRe.source + '[\\s\\S]{0,300}?>([^<]{2,80})<', 'i');
      const m  = html3.match(re);
      return m ? m[1].trim().replace(/\s+/g, ' ') : null;
    }

    // Appraised Value table: find "Base" row → land / improvement / total (in that column order)
    let landValue = null, buildingValue = null, appraisedValue = null;
    const avIdx = html3.search(/Appraised\s*Value/i);
    if (avIdx !== -1) {
      const avSection = html3.slice(avIdx, avIdx + 4000);
      const baseRowM  = avSection.match(/Base[\s\S]{0,800}?\$([\d,]+)[\s\S]{0,300}?\$([\d,]+)[\s\S]{0,300}?\$([\d,]+)/i);
      if (baseRowM) {
        landValue      = Number(baseRowM[1].replace(/,/g, '')) || null;
        buildingValue  = Number(baseRowM[2].replace(/,/g, '')) || null;
        appraisedValue = Number(baseRowM[3].replace(/,/g, '')) || null;
      }
    }
    if (!appraisedValue) {
      appraisedValue = grabDollar(/total\s*(?:market\s*)?value|appraised\s*value/i) || grabDollar(/total\s*value/i);
      if (!landValue)     landValue     = grabDollar(/land/i);
      if (!buildingValue) buildingValue = grabDollar(/improvement|building/i);
    }

    // Building characteristics table — columns: Yr Built / Tot Fin Area / Bedrooms / Full Baths / Half Baths
    let yearBuilt = null, sqft = null, beds = null, baths = null, halfBaths = null;
    const bldgHdrM = html3.match(/Yr\s*Built[\s\S]{0,150}?Tot\s*Fin\s*Area[\s\S]{0,150}?Bedroo/i);
    if (bldgHdrM) {
      const afterHdr = html3.slice(html3.indexOf(bldgHdrM[0]) + bldgHdrM[0].length);
      const cells = [];
      const cellRe = /<td[^>]*>\s*([^<\s][^<]{0,30}?)\s*<\/td>/gi;
      let cm;
      while ((cm = cellRe.exec(afterHdr)) !== null && cells.length < 8) {
        const v = cm[1].trim();
        if (v && /\d/.test(v)) cells.push(v);
      }
      if (cells[0]) yearBuilt = Number(cells[0]) || null;
      if (cells[1]) sqft      = Number(cells[1].replace(/,/g, '')) || null;
      if (cells[2]) beds      = Number(cells[2]) || null;
      if (cells[3]) baths     = Number(cells[3]) || null;
      if (cells[4]) halfBaths = Number(cells[4]) || null;
    }
    if (!yearBuilt) yearBuilt = grabNum(/yr\s*built|year\s*built/i);
    if (!sqft)      sqft      = grabNum(/tot\s*fin\s*area|living\s*area|sq(?:uare)?\s*f(?:ee)?t/i);
    if (!beds)      beds      = grabNum(/bedrooms?\b/i);
    if (!baths)     baths     = grabNum(/full\s*baths?|bathrooms?\b/i);
    if (!halfBaths) halfBaths = grabNum(/half\s*baths?/i);

    const ownerName = grabText(/(?:primary\s*)?owner(?:\s*name)?/i);
    const salePrice = grabDollar(/(?:last\s*)?sale\s*price|transfer\s*amount/i);
    const saleDate  = grabText(/(?:last\s*)?sale\s*date|transfer\s*date/i);

    return {
      source:        'Franklin County Auditor',
      dataSource:    appraisedValue ? 'live' : 'partial',
      parcelId:      pin || null,
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
      { headers: HEADERS, signal: AbortSignal.timeout(4000) }
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
        fetch(`https://www.redfin.com/stingray/api/home/details/avm?${qs}`,          { headers: refHdr, signal: AbortSignal.timeout(4000) }),
        fetch(`https://www.redfin.com/stingray/api/home/details/aboveTheFold?${qs}`, { headers: refHdr, signal: AbortSignal.timeout(4000) }),
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

export default async function handler(request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');
  const county  = searchParams.get('county') || '';

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (!address) {
    return new Response(JSON.stringify({ error: 'address required' }), { status: 400, headers: corsHeaders });
  }

  const isFranklin   = !county || county.toLowerCase().includes('franklin');
  const street       = (address.split(',')[0] || '').trim();
  const _citySegment = (address.split(',')[1] || '').trim().replace(/\s+[A-Z]{2}\b.*$/, '').trim();
  const cityRaw      = (_citySegment && !/^[A-Z]{2}[\s\d]*$/.test(_citySegment)) ? _citySegment : 'Columbus';

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
  const zillowUrl      = `https://www.zillow.com/homes/${slugify(address)}_rb/`;
  const realtorUrl     = `https://www.realtor.com/realestateandhomes-search/${cityRaw.replace(/\s+/g, '-')}_OH?q=${encodeURIComponent(street)}`;

  const result = {
    auditor: (auditorResult.status === 'fulfilled' && auditorResult.value) ? auditorResult.value : searchFallback,
    zillow:  zillowResult.status  === 'fulfilled' ? zillowResult.value  : { url: zillowUrl,  estimate: null, dataSource: 'link_only' },
    redfin:  redfinResult.status  === 'fulfilled' ? redfinResult.value  : { url: `https://www.redfin.com/search?q=${encodeURIComponent(address)}`, estimate: null, dataSource: 'link_only' },
    realtor: { url: realtorUrl, estimate: null, dataSource: 'link_only' },
  };

  return new Response(JSON.stringify(result), { headers: corsHeaders });
}
