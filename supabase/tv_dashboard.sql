-- ─── Public TV Dashboard — database support ─────────────────────────────────
--
-- ⚠️ NOT APPLIED. Nothing in this file has been run against Supabase — review it,
-- test it on a Supabase branch first if possible, and run it by hand in the SQL
-- editor only once you're satisfied with it. Nothing in this repo runs it
-- automatically.
--
-- What this adds, in plain English:
--   1. A tiny new table, tv_dashboard_config, that holds exactly one secret value
--      (meant to match the TV_DASHBOARD_SECRET env var on Vercel). RLS is turned on
--      with zero policies, so nothing can read or write it through the normal
--      Supabase client (anon or authenticated) — only the function below, which
--      runs with elevated ("security definer") privilege, can ever see it.
--   2. tv_dashboard_read(secret) — returns ONLY {properties, unassigned, lenders,
--      whiteboard, whiteboardOverrides} from the single nexus_data row. That's it —
--      no closingData/overageChecks/resimpliReview/dashboardLayout/homeOrder/
--      folders/quickLinks, no lender/bookkeeper account data, nothing about the
--      REsimpli sync's own bookkeeping. This is the exact slice the Whiteboard
--      forecast actually reads (properties/unassigned/lenders for the hard-money
--      payment schedule + sell-cash-amount math, whiteboard/whiteboardOverrides for
--      the cards/overrides themselves) — same pattern as resimpli_sync_read, just a
--      different, wider slice for a different purpose (a public no-login TV page,
--      not the REsimpli sync).
--   3. The function refuses (raises an exception, returns nothing) unless the
--      `secret` argument matches the one stored in tv_dashboard_config. This is the
--      actual gate — see api/tv-data.mjs, which calls this using only the Supabase
--      anon key (no service role key) and this secret. The same secret is ALSO
--      checked directly (no RPC involved) by api/mercury-balance.mjs,
--      api/sell-dates.mjs, and api/upcoming-buys.mjs as an alternate to the normal
--      "send Kyle's logged-in Supabase token" check, so the public TV page can call
--      those three too.
--
-- Kyle: this is the one new thing you're trusting with a no-login URL — treat the
-- secret value itself like a password (don't post it anywhere, and if the TV/kiosk
-- link ever leaks, come back here and run step 2 again with a NEW random value,
-- then update TV_DASHBOARD_SECRET on Vercel to match — the old link stops working
-- immediately, nothing else changes).

-- 1. Config table — no policies, so PostgREST can't touch it directly as anon or
--    authenticated; only the SECURITY DEFINER function below (running as the
--    function owner) can read it.
create table if not exists tv_dashboard_config (
  id int primary key default 1 check (id = 1), -- singleton row
  secret text not null
);
alter table tv_dashboard_config enable row level security;
-- Deliberately no policies on this table at all.

-- 2. Run this once, BY HAND, after choosing a long random value that matches the
--    TV_DASHBOARD_SECRET env var you set on Vercel. Example (replace the
--    placeholder before running — don't commit the real value anywhere):
--
--   insert into tv_dashboard_config (id, secret) values (1, 'REPLACE_ME')
--     on conflict (id) do update set secret = excluded.secret;

-- 3. Read — matching fields only. Nothing else in nexus_data is ever exposed
--    through this function, regardless of what's stored there.
create or replace function tv_dashboard_read(secret text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not exists (select 1 from tv_dashboard_config c where c.secret = tv_dashboard_read.secret) then
    raise exception 'tv_dashboard_read: invalid secret';
  end if;
  select jsonb_build_object(
    'properties', coalesce(data->'properties', '[]'::jsonb),
    'unassigned', coalesce(data->'unassigned', '[]'::jsonb),
    'lenders', coalesce(data->'lenders', '[]'::jsonb),
    'whiteboard', coalesce(data->'whiteboard', '{}'::jsonb),
    'whiteboardOverrides', coalesce(data->'whiteboardOverrides', '{}'::jsonb)
  )
  into result
  from nexus_data
  where org_id = 'nexus-homes';
  return result;
end;
$$;
