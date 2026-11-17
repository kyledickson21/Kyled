// ─── Public TV Dashboard — shared secret check ──────────────────────────────
//
// One tiny helper, imported by mercury-balance.mjs/sell-dates.mjs/upcoming-buys.mjs, so the
// three can't drift on how the TV secret is checked. It's an ALTERNATIVE to each function's
// normal "send Kyle's logged-in Supabase token" check (see each file's own isAuthorizedCaller),
// never a replacement — a request still needs either a valid Supabase session for
// kyle@nexushomesoh.com OR this secret, not neither. See supabase/tv_dashboard.sql and
// api/tv-data.mjs for the rest of the public-TV-page design.
export function isTvKeyAuthorized(req) {
  const expected = process.env.TV_DASHBOARD_SECRET;
  if (!expected) return false;
  const key = req.query?.key || req.body?.key;
  return !!key && key === expected;
}
