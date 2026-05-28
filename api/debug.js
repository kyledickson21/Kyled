export const config = { runtime: 'edge' };

const AUDITOR_BASE   = 'https://property.franklincountyauditor.com';
const AUDITOR_SEARCH = `${AUDITOR_BASE}/_web/search/CommonSearch.aspx?mode=ADDRESS`;

const NAV_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

export default async function handler(request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (!address) {
    return new Response(JSON.stringify({ error: 'pass ?address=...' }), { headers: corsHeaders });
  }

  const result = { address };

  try {
    // Step 1: GET search form — capture session cookie + ASP.NET hidden tokens
    const r1 = await fetch(AUDITOR_SEARCH, {
      headers: NAV_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    result.step1_status = r1.status;
    result.step1_url    = r1.url;

    const rawCookies = typeof r1.headers.getSetCookie === 'function'
      ? r1.headers.getSetCookie()
      : (r1.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/).map(s => s.trim());
    result.step1_cookie = rawCookies.map(c => c.split(';')[0]).join('; ');

    if (!r1.ok) return new Response(JSON.stringify(result), { headers: corsHeaders });
    const html1 = await r1.text();
    result.step1_html_len = html1.length;

    // Extract all hidden input fields (VIEWSTATE, EVENTVALIDATION, etc.)
    const inputs = [];
    const inputRe = /<input([^>]+?)(?:\/?> )/gi;
    let im;
    const inputRe2 = /<input([^>]+?)(?:\/?>)/gi;
    while ((im = inputRe2.exec(html1)) !== null) {
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
    result.hidden_count   = inputs.filter(f => f.type === 'hidden').length;
    result.hidden_fields  = inputs.filter(f => f.type === 'hidden').map(f => f.name);
    result.known_fields   = ['inpNumber','Select1','inpStreet','inpSuffix1','inpUnit','selSortBy','selSortDir','selPageSize','btSearch'];

    // Parse street parts
    const street      = (address.split(',')[0] || '').trim();
    const houseNum    = (street.match(/^(\d+)/) || [])[1] || '';
    const streetFull  = street.replace(/^\d+\s*/, '').trim();
    const { dir, name: streetName } = parseStreetParts(streetFull);
    result.parsed = { houseNum, dir, streetName };

    // Build POST body with exact confirmed field names
    const body = new URLSearchParams();
    inputs.filter(f => f.type === 'hidden').forEach(f => body.set(f.name, f.value));
    body.set('__EVENTTARGET',   '');
    body.set('__EVENTARGUMENT', '');
    body.set('inpNumber',   houseNum);
    body.set('Select1',     dir);
    body.set('inpStreet',   streetName);
    body.set('inpSuffix1',  '');
    body.set('inpUnit',     '');
    body.set('selSortBy',   'PARID');
    body.set('selSortDir',  'ASC');
    body.set('selPageSize', '15');
    body.set('btSearch',    'Search');
    result.post_body_keys = [...body.keys()];

    // Step 2: POST the search form
    const r2 = await fetch(AUDITOR_SEARCH, {
      method: 'POST',
      headers: {
        ...NAV_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': AUDITOR_SEARCH,
        'Cookie': result.step1_cookie,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: body.toString(),
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    result.step2_status = r2.status;
    result.step2_url    = r2.url;

    const html2 = await r2.text();
    result.step2_html_len = html2.length;

    // Detect result type
    result.single_result    = r2.url.includes('Datalet.aspx') || html2.includes('DataletHeaderTopFC');
    result.selectSearchRow  = (html2.match(/selectSearchRow\(\s*['"]([^'"]+)['"]\s*\)/i) || [])[1] || null;
    result.no_results       = html2.includes('No data found') || html2.includes('no records found') || html2.includes('0 records');

    const bodyStart = html2.indexOf('<body');
    result.step2_snippet = html2.substring(bodyStart > -1 ? bodyStart : 0, Math.min(html2.length, 3000));

    // Step 3: GET datalet if we have a path
    let dataletPath = null;
    if (result.single_result && !r2.url.includes('Datalet.aspx')) {
      const dMatch = html2.match(/href="([^"]*Datalet\.aspx[^"]*)"/i);
      dataletPath = dMatch ? dMatch[1] : null;
    } else if (r2.url.includes('Datalet.aspx')) {
      dataletPath = r2.url;
    } else if (result.selectSearchRow) {
      dataletPath = result.selectSearchRow.startsWith('http')
        ? result.selectSearchRow
        : `${AUDITOR_BASE}${result.selectSearchRow.startsWith('/') ? '' : '/'}${result.selectSearchRow}`;
    }

    if (dataletPath) {
      const dataletUrl = dataletPath.startsWith('http') ? dataletPath : `${AUDITOR_BASE}${dataletPath}`;
      result.step3_url_fetching = dataletUrl;

      const r3 = await fetch(dataletUrl, {
        headers: { ...NAV_HEADERS, 'Referer': r2.url, 'Cookie': result.step1_cookie, 'Sec-Fetch-Site': 'same-origin' },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      result.step3_status   = r3.status;
      result.step3_final_url = r3.url;
      const html3 = await r3.text();
      result.step3_html_len = html3.length;

      const b3 = html3.indexOf('<body');
      result.step3_snippet = html3.substring(b3 > -1 ? b3 : 0, Math.min(html3.length, 5000));

      // Quick parse check
      result.has_DataletHeaderTopFC = html3.includes('DataletHeaderTopFC');
      result.has_AppraisedValue     = /Appraised\s*Value/i.test(html3);
      result.has_YrBuilt            = /Yr\s*Built/i.test(html3);
      result.has_OwnerName          = /owner/i.test(html3);
      result.pin_in_url             = (r3.url.match(/[?&]pin=([^&]+)/i) || [])[1] || null;
    }
  } catch (e) {
    result.error = e.message;
    result.stack = e.stack?.split('\n').slice(0, 5).join('\n');
  }

  return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders });
}
