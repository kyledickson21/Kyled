-- ─── REsimpli sync — database support ───────────────────────────────────────
--
-- ⚠️ NOT APPLIED. Nothing in this file has been run against Supabase — review it,
-- test it on a Supabase branch first if possible, and run it by hand in the SQL
-- editor only once you're satisfied with it. Nothing in this repo runs it
-- automatically.
--
-- What this adds, in plain English:
--   1. A tiny new table, resimpli_sync_config, that holds exactly one secret
--      value (meant to match the RESIMPLI_SYNC_SECRET env var on Vercel). RLS is
--      turned on with zero policies, so nothing can read or write it through
--      the normal Supabase client (anon or authenticated) — only the two
--      functions below, which run with elevated ("security definer") privilege,
--      can ever see it.
--   2. resimpli_sync_read(secret) — returns just {id, address, resimpli} for
--      every property. That's it. No loan, lender, fund, draw, or money field
--      is ever returned. Used by the server sync to figure out what would
--      change, before writing anything.
--   3. resimpli_sync_apply(secret, changes, review, synced_at, pipeline_order) — the ONLY way
--      the sync can write to nexus_data. It replaces the `resimpli` key on the
--      properties listed in `changes` (by id), replaces the top-level
--      `resimpliReview`, `resimpliLastSyncedAt`, and `resimpliPipelineOrder` keys
--      (pipeline_order is optional — pass null to leave the stored pipeline order
--      untouched, e.g. from the single-lead webhook, which has nothing new to report
--      there), and changes NOTHING else — not a property's any other field, not a
--      loan, lender, fund, or draw, not any other top-level key. This isn't a
--      promise enforced elsewhere; it's how the function is written — it rebuilds
--      the properties array by copying every property through unchanged except
--      for a jsonb_set on just the `resimpli` key of a matching id.
--   4. Both functions refuse (raise an exception, writing nothing) unless the
--      `secret` argument matches the one stored in resimpli_sync_config. This
--      is the actual gate — see api/resimpli-sync.mjs and
--      api/resimpli-webhook.mjs, which call these using only the Supabase anon
--      key (no service role key, by Kyle's preference) and this secret.
--
-- Credential this needs: nothing beyond the existing anon key on the client
-- side. The only thing to add is the resimpli_sync_config row (step 2 below),
-- run once by hand with the real secret value — never commit that value
-- anywhere, including this file.

-- 1. Config table — no policies, so PostgREST can't touch it directly as anon
--    or authenticated; only the SECURITY DEFINER functions below (running as
--    the function owner) can read it.
create table if not exists resimpli_sync_config (
  id int primary key default 1 check (id = 1), -- singleton row
  secret text not null
);
alter table resimpli_sync_config enable row level security;
-- Deliberately no policies on this table at all.

-- 2. Run this once, BY HAND, after choosing a value that matches the
--    RESIMPLI_SYNC_SECRET env var you set on Vercel. Example (replace the
--    placeholder before running):
--
--   insert into resimpli_sync_config (id, secret) values (1, 'REPLACE_ME')
--     on conflict (id) do update set secret = excluded.secret;

-- 3. Read — matching inputs only (id, address, resimpli). Nothing else is
--    ever exposed through this function, regardless of what's in nexus_data.
create or replace function resimpli_sync_read(secret text)
returns table(id text, address text, resimpli jsonb)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from resimpli_sync_config c where c.secret = resimpli_sync_read.secret) then
    raise exception 'resimpli_sync_read: invalid secret';
  end if;
  return query
    select p->>'id', p->>'address', p->'resimpli'
    from nexus_data, jsonb_array_elements(data->'properties') as p
    where org_id = 'nexus-homes';
end;
$$;

-- 4. Apply — the only write path. `changes` is a jsonb array of
--    {id, resimpli}; `review` is the full new resimpliReview array (the
--    caller computes it, this function just stores it verbatim); `synced_at`
--    is the timestamp to record as resimpliLastSyncedAt; `pipeline_order` is
--    REsimpli's live-fetched stage order (same shape as the hardcoded
--    RESIMPLI_PIPELINES default in src/resimpli-shared.mjs) to store as
--    resimpliPipelineOrder, or null to leave whatever's already stored there
--    untouched (the single-lead webhook always passes null — it has nothing
--    new to report about pipeline order).
--
--    Property rebuild: every property passes through unchanged EXCEPT that a
--    property whose id appears in `changes` gets jsonb_set(..., '{resimpli}',
--    <that change's resimpli value>) applied to it. No property is added,
--    removed, or reordered; no field other than `resimpli` is touched on any
--    property, matched or not.
create or replace function resimpli_sync_apply(secret text, changes jsonb, review jsonb, synced_at timestamptz, pipeline_order jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  new_properties jsonb;
  current_data jsonb;
begin
  if not exists (select 1 from resimpli_sync_config c where c.secret = resimpli_sync_apply.secret) then
    raise exception 'resimpli_sync_apply: invalid secret';
  end if;

  select data into current_data from nexus_data where org_id = 'nexus-homes';

  select coalesce(jsonb_agg(
    case
      when c.value is not null then jsonb_set(p.value, '{resimpli}', c.value->'resimpli')
      else p.value
    end
  ), '[]'::jsonb)
  into new_properties
  from jsonb_array_elements(current_data->'properties') as p
  left join jsonb_array_elements(resimpli_sync_apply.changes) as c
    on c.value->>'id' = p.value->>'id';

  update nexus_data
  set data = jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(current_data, '{properties}', new_properties),
            '{resimpliReview}', coalesce(resimpli_sync_apply.review, '[]'::jsonb)
          ),
          '{resimpliLastSyncedAt}', to_jsonb(resimpli_sync_apply.synced_at)
        ),
        '{resimpliPipelineOrder}', coalesce(resimpli_sync_apply.pipeline_order, current_data->'resimpliPipelineOrder', 'null'::jsonb)
      ),
      updated_at = now()
  where org_id = 'nexus-homes';
end;
$$;

-- 5. Grants — the sync calls these over PostgREST using only the anon key (no
--    logged-in Supabase Auth session for the cron/webhook paths), so both need
--    EXECUTE granted to the `anon` role. The secret check inside each function
--    body is the real gate; granting anon EXECUTE here doesn't widen what
--    either function is able to touch — it's still only ever resimpli/
--    resimpliReview/resimpliLastSyncedAt/resimpliPipelineOrder, by construction above.
--
-- NOTE if this file is ever re-run after an earlier version was already applied:
-- `create or replace function` only replaces a function with the EXACT SAME
-- argument list — adding resimpli_sync_apply's `pipeline_order` parameter here
-- creates a SECOND, overloaded function rather than replacing an already-applied
-- 4-argument version. If resimpli_sync_apply(text,jsonb,jsonb,timestamptz) (no
-- 5th arg) was ever actually applied, drop it first:
--   drop function if exists resimpli_sync_apply(text, jsonb, jsonb, timestamptz);
-- Nothing in this repo has applied anything from this file yet, so this doesn't
-- apply on a first run — only relevant if this file is edited and re-run later.
grant execute on function resimpli_sync_read(text) to anon;
grant execute on function resimpli_sync_apply(text, jsonb, jsonb, timestamptz, jsonb) to anon;
