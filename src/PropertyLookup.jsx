import { useState, useRef, useEffect } from 'react';

// ─── address helpers ─────────────────────────────────────────────────────────

const STATE_ABBR = {
  Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',
  Colorado:'CO',Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',
  Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',
  Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',
  Michigan:'MI',Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',
  Nebraska:'NE',Nevada:'NV','New Hampshire':'NH','New Jersey':'NJ',
  'New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',
  Ohio:'OH',Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI',
  'South Carolina':'SC','South Dakota':'SD',Tennessee:'TN',Texas:'TX',
  Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',
  Wisconsin:'WI',Wyoming:'WY',
};

function fmtAddr(item) {
  const a = item.address || {};
  const street = [a.house_number, a.road || a.pedestrian || a.path]
    .filter(Boolean).join(' ');
  const city = a.city || a.town || a.village || a.hamlet || a.suburb || '';
  const state = STATE_ABBR[a.state] || a.state || '';
  const zip = (a.postcode || '').split('-')[0];
  const stateZip = [state, zip].filter(Boolean).join(' ');
  return [street, city, stateZip].filter(Boolean).join(', ');
}

function fmtMoney(n) {
  if (n == null) return null;
  const v = Math.round(Number(n));
  if (!v) return null;
  return '$' + v.toLocaleString();
}

// ─── sub-components ──────────────────────────────────────────────────────────

function SearchBox({ onSelect }) {
  const [q, setQ] = useState('');
  const [sugg, setSugg] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const debRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    const h = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const search = async val => {
    if (val.length < 3) { setSugg([]); setOpen(false); return; }
    setLoading(true);
    try {
      const r = await fetch(`/api/autocomplete?q=${encodeURIComponent(val)}`);
      const data = await r.json();
      setSugg(data);
      setOpen(data.length > 0);
      setActiveIdx(-1);
    } catch { setSugg([]); }
    setLoading(false);
  };

  const handleChange = e => {
    const val = e.target.value;
    setQ(val);
    clearTimeout(debRef.current);
    debRef.current = setTimeout(() => search(val), 300);
  };

  const handleKey = e => {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, sugg.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); pick(sugg[activeIdx]); }
    if (e.key === 'Escape') setOpen(false);
  };

  const pick = item => {
    const addr = fmtAddr(item);
    setQ(addr);
    setSugg([]);
    setOpen(false);
    onSelect(item, addr);
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-500 pointer-events-none">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
        </div>
        <input
          value={q}
          onChange={handleChange}
          onKeyDown={handleKey}
          onFocus={() => sugg.length > 0 && setOpen(true)}
          placeholder="Search any Columbus-area address…"
          autoComplete="off"
          spellCheck={false}
          className="w-full pl-10 pr-10 py-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-900 dark:text-zinc-100 placeholder-slate-400 dark:placeholder-zinc-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all shadow-sm"
        />
        {loading && (
          <div className="absolute right-3.5 top-1/2 -translate-y-1/2">
            <div className="w-4 h-4 border-2 border-slate-300 dark:border-zinc-600 border-t-blue-500 rounded-full animate-spin"/>
          </div>
        )}
        {q && !loading && (
          <button
            onClick={() => { setQ(''); setSugg([]); setOpen(false); }}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-500 hover:text-slate-600 dark:hover:text-zinc-300">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        )}
      </div>

      {open && sugg.length > 0 && (
        <div className="absolute z-50 mt-1.5 w-full bg-white dark:bg-zinc-800 rounded-xl border border-slate-200 dark:border-zinc-700 shadow-xl overflow-hidden">
          {sugg.map((item, i) => {
            const addr = fmtAddr(item);
            const county = item.address?.county || '';
            return (
              <button
                key={item.place_id}
                onMouseDown={e => { e.preventDefault(); pick(item); }}
                className={`w-full text-left px-4 py-2.5 text-sm flex items-start gap-2.5 transition-colors ${
                  i === activeIdx
                    ? 'bg-blue-50 dark:bg-blue-950/50'
                    : 'hover:bg-slate-50 dark:hover:bg-zinc-700/50'
                }`}>
                <svg className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400 dark:text-zinc-500" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.273 1.765 11.842 11.842 0 00.757.433 5.741 5.741 0 00.28.14l.018.008.006.003zM10 11.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" clipRule="evenodd"/>
                </svg>
                <div className="min-w-0">
                  <div className="text-slate-900 dark:text-zinc-100 font-medium truncate">{addr}</div>
                  {county && <div className="text-xs text-slate-400 dark:text-zinc-500 truncate">{county}</div>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ValueBadge({ value, label }) {
  if (!value) return (
    <div className="text-sm text-slate-400 dark:text-zinc-500 italic">Visit site to see estimate</div>
  );
  return (
    <div>
      <div className="text-2xl font-black text-slate-900 dark:text-zinc-50 tabular-nums tracking-tight">{value}</div>
      {label && <div className="text-xs text-slate-400 dark:text-zinc-500 mt-0.5">{label}</div>}
    </div>
  );
}

function ExternalLink({ href, children, className = '' }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline ${className}`}>
      {children}
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14 21 3"/>
      </svg>
    </a>
  );
}

function AuditorCard({ data }) {
  const val = fmtMoney(data?.appraisedValue);

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-slate-200 dark:border-zinc-800 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-7 h-7 rounded-lg bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center text-sm">🏛️</div>
        <div>
          <div className="font-bold text-slate-900 dark:text-zinc-100 text-sm leading-none">{data?.source || 'County Auditor'}</div>
          <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">Public Record</div>
        </div>
        {data?.dataSource === 'live' && (
          <span className="ml-auto text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded-full">Live</span>
        )}
      </div>

      {data?.dataSource === 'live' ? (
        <>
          <div className="mb-4">
            <div className="text-[11px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider mb-1">Auditor Value</div>
            <ValueBadge value={val} label="Appraised / Market Value" />
          </div>

          <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-sm mb-4">
            {data.ownerName && (
              <div className="col-span-2">
                <div className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">Owner</div>
                <div className="text-slate-700 dark:text-zinc-200 font-medium">{data.ownerName}</div>
              </div>
            )}
            {data.yearBuilt && (
              <div>
                <div className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">Year Built</div>
                <div className="text-slate-700 dark:text-zinc-200 font-medium">{data.yearBuilt}</div>
              </div>
            )}
            {data.sqft && (
              <div>
                <div className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">Sq Ft</div>
                <div className="text-slate-700 dark:text-zinc-200 font-medium tabular-nums">{Number(data.sqft).toLocaleString()}</div>
              </div>
            )}
            {data.salePrice && (
              <div>
                <div className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">Last Sale</div>
                <div className="text-slate-700 dark:text-zinc-200 font-medium tabular-nums">{fmtMoney(data.salePrice)}</div>
              </div>
            )}
            {data.saleDate && (
              <div>
                <div className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">Sale Date</div>
                <div className="text-slate-700 dark:text-zinc-200 font-medium">{data.saleDate}</div>
              </div>
            )}
            {data.parcelId && (
              <div className="col-span-2">
                <div className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider">Parcel ID</div>
                <div className="text-slate-600 dark:text-zinc-300 font-mono text-xs">{data.parcelId}</div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="mb-4 py-3 px-3.5 bg-amber-50 dark:bg-amber-900/20 rounded-xl text-sm text-amber-700 dark:text-amber-300">
          Live data unavailable — view full details on the auditor's site.
        </div>
      )}

      <ExternalLink href={data?.url || '#'}>View on Auditor Site</ExternalLink>
    </div>
  );
}

function EstimateCard({ platform, icon, color, data, estimateLabel }) {
  const val = fmtMoney(data?.estimate);

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-slate-200 dark:border-zinc-800 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <div className={`w-7 h-7 rounded-lg ${color} flex items-center justify-center text-sm`}>{icon}</div>
        <div>
          <div className="font-bold text-slate-900 dark:text-zinc-100 text-sm leading-none">{platform}</div>
          <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">{estimateLabel}</div>
        </div>
        {data?.dataSource === 'live' && (
          <span className="ml-auto text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded-full">Live</span>
        )}
      </div>

      <div className="mb-4">
        <ValueBadge value={val} label={estimateLabel} />
      </div>

      <ExternalLink href={data?.url || '#'}>View on {platform}</ExternalLink>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <div className="w-8 h-8 border-3 border-slate-200 dark:border-zinc-700 border-t-blue-500 rounded-full animate-spin" style={{borderWidth:'3px'}}/>
      <div className="text-sm text-slate-400 dark:text-zinc-500">Looking up property data…</div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PropertyLookup() {
  const [fetching, setFetching] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [lastAddress, setLastAddress] = useState('');

  const handleSelect = async (item, formattedAddress) => {
    setResult(null);
    setError(null);
    setLastAddress(formattedAddress);
    setFetching(true);

    try {
      const params = new URLSearchParams({
        address: formattedAddress,
        lat: item.lat || '',
        lon: item.lon || '',
        county: item.address?.county || '',
      });
      const r = await fetch(`/api/property?${params}`);
      if (!r.ok) throw new Error('Server error');
      const data = await r.json();
      setResult(data);
    } catch {
      setError('Could not fetch property data. Please try again.');
    }
    setFetching(false);
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-lg font-black text-slate-900 dark:text-zinc-100 tracking-tight">Property Lookup</h2>
        <p className="text-sm text-slate-400 dark:text-zinc-500 mt-0.5">
          Search any Columbus-area address to see county auditor value, Zillow, Redfin, and Realtor.com estimates.
        </p>
      </div>

      {/* Search */}
      <SearchBox onSelect={handleSelect} />

      {/* Loading */}
      {fetching && <Spinner />}

      {/* Error */}
      {error && !fetching && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Results */}
      {result && !fetching && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-slate-400 dark:text-zinc-500 uppercase tracking-wider px-0.5">
            Results for {lastAddress}
          </div>

          <AuditorCard data={result.auditor} />

          <EstimateCard
            platform="Zillow"
            icon="🏠"
            color="bg-blue-100 dark:bg-blue-900/40"
            data={result.zillow}
            estimateLabel="Zestimate"
          />

          <EstimateCard
            platform="Redfin"
            icon="🔴"
            color="bg-red-100 dark:bg-red-900/40"
            data={result.redfin}
            estimateLabel="Redfin Estimate"
          />

          <EstimateCard
            platform="Realtor.com"
            icon="🏡"
            color="bg-green-100 dark:bg-green-900/40"
            data={result.realtor}
            estimateLabel="Realtor.com Estimate"
          />

          <p className="text-[11px] text-slate-300 dark:text-zinc-600 text-center pt-1">
            Zillow and Realtor.com estimates are shown on those sites — click the links above to view them.
            Redfin estimate is fetched live when available.
          </p>
        </div>
      )}

      {/* Empty state */}
      {!result && !fetching && !error && (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
          <div className="text-4xl">🔍</div>
          <div className="text-sm font-medium text-slate-500 dark:text-zinc-400">Start typing an address above</div>
          <div className="text-xs text-slate-400 dark:text-zinc-600">Covers Franklin, Delaware, Licking, Fairfield and surrounding counties</div>
        </div>
      )}
    </div>
  );
}
