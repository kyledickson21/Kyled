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
--      (review/pipeline_order are each optional — pass null to leave what's already
--      stored there untouched, e.g. from the single-lead webhook, which has nothing
--      new to report about either), and changes NOTHING else — not a property's any
--      other field, not a loan, lender, fund, or draw, not any other top-level key,
--      not even property ORDER (the Manual drag-sort tab depends on array order).
--      This isn't just a promise enforced elsewhere; before writing anything, the
--      function locks the row (SELECT ... FOR UPDATE, so a concurrent client save
--      can't interleave with it) and re-verifies all of that itself — property
--      count unchanged, every property's non-resimpli fields AND position
--      byte-for-byte unchanged, every other top-level key unchanged — and raises an
--      exception (writing nothing at all) if any of it doesn't hold. It also
--      refuses a `changes` array with a duplicate id or an id that isn't an actual
--      property, and refuses if nexus_data's own `properties` field is missing or
--      not an array, or if the UPDATE doesn't affect exactly one row.
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

-- 4. Apply — the only write path. `changes` is a jsonb array of {id, resimpli}; `review` is
--    the full new resimpliReview array, or null to leave what's already stored there
--    untouched (the single-lead webhook passes null — it has nothing new to report about the
--    review list from one lead); `synced_at` is the timestamp to record as
--    resimpliLastSyncedAt; `pipeline_order` is REsimpli's live-fetched stage order (same shape
--    as the hardcoded RESIMPLI_PIPELINES default in src/resimpli-shared.mjs), or null to leave
--    whatever's already stored there untouched.
--
--    Property rebuild: every property passes through unchanged, IN THE SAME ORDER, EXCEPT
--    that a property whose id appears in `changes` gets jsonb_set(..., '{resimpli}', <that
--    change's resimpli value>) applied to it. No property is added, removed, or reordered; no
--    field other than `resimpli` is touched on any property, matched or not. Before writing
--    anything, every one of those claims is re-verified against the actual rebuilt data (see
--    the "hard self-check" block below) — not just trusted because the rebuild query above it
--    was written to do the right thing.
create or replace function resimpli_sync_apply(secret text, changes jsonb, review jsonb, synced_at timestamptz, pipeline_order jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_data jsonb;
  new_data jsonb;
  new_properties jsonb;
  row_count_check int;
  rows_affected int;
  dup_count int;
  missing_count int;
  mismatch_count int;
begin
  if not exists (select 1 from resimpli_sync_config c where c.secret = resimpli_sync_apply.secret) then
    raise exception 'resimpli_sync_apply: invalid secret';
  end if;

  -- Confirm exactly one row for this org exists BEFORE doing anything else — a silent
  -- PL/pgSQL "SELECT INTO" with zero or multiple matching rows would otherwise either leave
  -- current_data null or silently pick just one of several rows.
  select count(*) into row_count_check from nexus_data where org_id = 'nexus-homes';
  if row_count_check <> 1 then
    raise exception 'resimpli_sync_apply: expected exactly 1 nexus_data row for org_id=nexus-homes, found %', row_count_check;
  end if;

  -- Lock the row for the rest of this transaction, so a concurrent client save (the app's own
  -- optimistic-concurrency UPDATE) can't interleave between this read and the UPDATE below —
  -- it will simply wait for this transaction to commit, then see the post-sync updated_at and
  -- correctly surface as a conflict for the app to retry (see CLAUDE.md's concurrency note).
  select data into current_data from nexus_data where org_id = 'nexus-homes' for update;

  if current_data->'properties' is null or jsonb_typeof(current_data->'properties') <> 'array' then
    raise exception 'resimpli_sync_apply: properties is missing or not an array — refusing to write';
  end if;

  -- `changes` must not contain the same id twice, and every id in it must already exist.
  select count(*) into dup_count
  from (
    select c.value->>'id' as cid
    from jsonb_array_elements(resimpli_sync_apply.changes) as c
    group by c.value->>'id'
    having count(*) > 1
  ) dupes;
  if dup_count > 0 then
    raise exception 'resimpli_sync_apply: changes contains a duplicate property id — refusing to write';
  end if;

  select count(*) into missing_count
  from jsonb_array_elements(resimpli_sync_apply.changes) as c
  where not exists (
    select 1 from jsonb_array_elements(current_data->'properties') as p
    where p.value->>'id' = c.value->>'id'
  );
  if missing_count > 0 then
    raise exception 'resimpli_sync_apply: changes contains an id that is not an existing property — refusing to write';
  end if;

  -- Rebuild properties, preserving array order explicitly (WITH ORDINALITY + ORDER BY) — a
  -- plain jsonb_agg over a LEFT JOIN has no inherent order, and the Manual (drag) sort tab
  -- depends on this array's order matching what Kyle last arranged.
  select jsonb_agg(
           case when c.value is not null then jsonb_set(p.value, '{resimpli}', c.value->'resimpli') else p.value end
           order by p.ord
         )
    into new_properties
    from jsonb_array_elements(current_data->'properties') with ordinality as p(value, ord)
    left join jsonb_array_elements(resimpli_sync_apply.changes) as c
      on c.value->>'id' = p.value->>'id';

  -- Hard self-check #1: property count unchanged.
  if jsonb_array_length(new_properties) <> jsonb_array_length(current_data->'properties') then
    raise exception 'resimpli_sync_apply: property count changed (% -> %) — refusing to write',
      jsonb_array_length(current_data->'properties'), jsonb_array_length(new_properties);
  end if;

  -- Hard self-check #2: every position's non-resimpli fields AND id are byte-for-byte
  -- unchanged — i.e. nothing moved and nothing but resimpli differs, at every single index.
  select count(*) into mismatch_count
  from jsonb_array_elements(current_data->'properties') with ordinality as op(value, ord)
  join jsonb_array_elements(new_properties) with ordinality as np(value, ord2)
    on op.ord = np.ord2
  where (op.value - 'resimpli') is distinct from (np.value - 'resimpli')
     or (op.value->>'id') is distinct from (np.value->>'id');
  if mismatch_count > 0 then
    raise exception 'resimpli_sync_apply: a field other than resimpli changed, or property order changed, at % position(s) — refusing to write', mismatch_count;
  end if;

  -- Build the full candidate new `data` value once, so the self-check below and the actual
  -- UPDATE are guaranteed to write exactly what was checked — never two separately-computed
  -- values that could drift from each other.
  new_data := jsonb_set(
    jsonb_set(
      jsonb_set(current_data, '{properties}', new_properties),
      '{resimpliReview}', coalesce(resimpli_sync_apply.review, current_data->'resimpliReview', 'null'::jsonb)
    ),
    '{resimpliLastSyncedAt}', to_jsonb(resimpli_sync_apply.synced_at)
  );
  new_data := jsonb_set(new_data, '{resimpliPipelineOrder}', coalesce(resimpli_sync_apply.pipeline_order, current_data->'resimpliPipelineOrder', 'null'::jsonb));

  -- Hard self-check #3: every OTHER top-level key is unchanged — nothing besides properties/
  -- resimpliReview/resimpliLastSyncedAt/resimpliPipelineOrder may differ at all.
  if (current_data - 'properties' - 'resimpliReview' - 'resimpliLastSyncedAt' - 'resimpliPipelineOrder')
     is distinct from
     (new_data - 'properties' - 'resimpliReview' - 'resimpliLastSyncedAt' - 'resimpliPipelineOrder')
  then
    raise exception 'resimpli_sync_apply: a top-level key other than properties/resimpliReview/resimpliLastSyncedAt/resimpliPipelineOrder changed — refusing to write';
  end if;

  update nexus_data set data = new_data, updated_at = now() where org_id = 'nexus-homes';

  get diagnostics rows_affected = row_count;
  if rows_affected <> 1 then
    raise exception 'resimpli_sync_apply: UPDATE affected % row(s), expected exactly 1 — refusing (this should be impossible given the row-count check above)', rows_affected;
  end if;
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

-- 6. Concurrency with the app, in plain English (no further fix needed beyond the FOR UPDATE
--    lock above — the app's existing save path already handles this correctly):
--    The client (src/supabase.js's saveData) always saves with an `updated_at` check — it
--    only writes when the row's updated_at still matches what it last read, and Tracker.jsx's
--    `update()`/`persistWithRetry` treat a mismatch as a conflict: it reloads the fresh row
--    and RE-RUNS Kyle's own pending edit (a pure function of "whatever data I'm handed") against
--    that fresh data, then saves again. So if this function bumps updated_at while Kyle has
--    the page open:
--      - if his save lands FIRST, this function's FOR UPDATE lock simply waits for his
--        transaction to commit, then reads his edit as part of current_data and folds the
--        REsimpli change on top of it — nothing is lost.
--      - if this function's write lands FIRST (or is already holding the lock when his save's
--        UPDATE arrives), his client-side updated_at check fails against the new value, his
--        save surfaces as a conflict, and the existing retry logic reloads (now including this
--        function's resimpli change) and reapplies his edit on top of it before saving again —
--        again, nothing is lost on either side.
--    Both directions already rely on functionality that exists in the app today — no client
--    code change needed, only the FOR UPDATE lock added to resimpli_sync_apply above, which is
--    what makes the first of those two orderings safe (without it, this function's own
--    read-then-write could still race a concurrent save in the other direction).
