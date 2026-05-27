const AUDITOR_BASE   = 'https://property.franklincountyauditor.com';
const AUDITOR_SEARCH = `${AUDITOR_BASE}/_web/search/commonsearch.aspx?mode=address`;

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { address } = req.query;
  if (!address) return res.json({ error: 'pass ?address=...' });

  const result = {};

  try {
    // Step 1: GET search form
    const r1 = await fetch(AUDITOR_SEARCH, {
      headers: NAV_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    result.step1_status = r1.status;
    result.step1_url    = r1.url;
    result.step1_cookie = (r1.headers.get('set-cookie') || '').split(';')[0];

    if (!r1.ok) return res.json(result);
    const html1 = await r1.text();
    result.step1_html_len = html1.length;

    // Extract all input fields
    const inputs = [];
    const inputRe = /<input[^>]+name="([^"]+)"(?:[^>]+value="([^"]*)")?/gi;
    let im;
    while ((im = inputRe.exec(html1)) !== null) inputs.push({ name: im[1], value: im[2] || '' });
    result.form_inputs = inputs.filter(f => !/VIEW|EVENT|GEN/i.test(f.name));
    result.hidden_count = inputs.filter(f => /VIEW|EVENT|GEN/i.test(f.name)).length;

    // Check which fields we can identify
    const find = (re, skip) => inputs.find(f => re.test(f.name) && (!skip || !skip.test(f.name)));
    result.house_field  = find(/house|num|situs.?n|hse/i,         /view|event|gen|btn|submit/i)?.name || 'NOT FOUND';
    result.street_field = find(/street|situs.?s|str.?name|road/i, /num|dir|type|suf|view|event|btn/i)?.name || 'NOT FOUND';
    result.dir_field    = find(/situs.?dir|str.?dir|direction/i,  /view|event|gen/i)?.name || null;
    result.type_field   = find(/situs.?type|str.?type|suffix/i,   /view|event|gen/i)?.name || null;

    if (result.house_field === 'NOT FOUND' || result.street_field === 'NOT FOUND') {
      return res.json({ ...result, error: 'Could not identify form fields — check form_inputs above' });
    }

    // Step 2: POST the search
    const street   = (address.split(',')[0] || '').trim();
    const houseNum = (street.match(/^(\d+)/) || [])[1] || '';
    const streetName = street.replace(/^\d+\s*/, '').trim().replace(/^(N|S|E|W|NE|NW|SE|SW)\s+/i, '').replace(/\s+(ST|AVE|BLVD|DR|RD|LN|CT|PL|WAY|PKWY|CIR|TRL|TERR?|PLACE|TRAIL)\.?$/i, '').trim();

    const body = new URLSearchParams();
    inputs.filter(f => /VIEW|EVENT|GEN/i.test(f.name)).forEach(f => body.set(f.name, f.value));
    body.set(result.house_field,  houseNum);
    body.set(result.street_field, streetName);
    result.post_house  = houseNum;
    result.post_street = streetName;

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
      signal: AbortSignal.timeout(8000),
    });
    result.step2_status = r2.status;
    result.step2_url    = r2.url;

    const html2 = await r2.text();
    result.step2_html_len = html2.length;

    // Look for results
    const pinMatch = html2.match(/Datalet\.aspx[^"']*pin=([^"'&\s]+)/i)
                  || html2.match(/[?&]pin=(\d{9,})/i);
    result.pin_found = pinMatch ? pinMatch[1] : null;

    // Show a snippet of the results area
    const bodyStart = html2.indexOf('<body');
    result.step2_snippet = html2.substring(bodyStart > -1 ? bodyStart : 0, Math.min(html2.length, 2000));

    if (!pinMatch) return res.json(result);

    // Step 3: GET datalet page
    const pin       = pinMatch[1].replace(/-/g, '');
    const parcelUrl = `${AUDITOR_BASE}/_web/Datalets/Datalet.aspx?mode=&UseSearch=no&jur=025&pin=${pin}`;
    const r3 = await fetch(parcelUrl, {
      headers: { ...NAV_HEADERS, 'Referer': r2.url, 'Cookie': result.step1_cookie, 'Sec-Fetch-Site': 'same-origin' },
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
    });
    result.step3_status = r3.status;
    result.step3_url    = r3.url;
    const html3 = await r3.text();
    result.step3_html_len = html3.length;
    // Return first 3000 chars of datalet body so you can see the field structure
    const b3 = html3.indexOf('<body');
    result.step3_snippet = html3.substring(b3 > -1 ? b3 : 0, Math.min(html3.length, 3000));
  } catch (e) {
    result.error = e.message;
  }

  return res.json(result);
}
