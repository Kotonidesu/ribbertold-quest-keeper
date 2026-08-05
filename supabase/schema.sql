-- Ribbertold Quest Keeper schema.
--
-- Run this once in the Supabase SQL editor. It is written to be re-runnable:
-- every object is created if absent and policies are dropped before they are
-- recreated, so applying it twice is harmless.
--
-- The security model in one sentence: the anon key shipped inside the app can
-- do nothing on its own, and every table below decides what the signed-in user
-- may see based on their row in campaign_members. Losing that key costs
-- nothing; losing these policies costs everything.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Display details for a signed-in user. Kept apart from auth.users because
-- that table is not readable by clients.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null default 'Adventurer',
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'New Campaign',
  -- Six hex characters. Short enough to read out over voice chat.
  invite_code text not null unique default upper(substring(replace(gen_random_uuid()::text, '-', '') from 1 for 6)),
  created_by uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

-- Role lives on the membership, not the person: the same account is DM of one
-- campaign and a player in another.
create table if not exists public.campaign_members (
  campaign_id uuid not null references public.campaigns on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'player' check (role in ('dm', 'player')),
  joined_at timestamptz not null default now(),
  primary key (campaign_id, user_id)
);

-- `position` is a float so an item can be dropped between two others by
-- averaging their positions, with no renumbering of the rest.
--
-- `dm_only` is what splits a campaign into two lists: the shared one everybody
-- works from, and the DM's own, which players cannot see, count, or discover
-- the existence of.
create table if not exists public.quests (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns on delete cascade,
  title text not null default 'New Quest',
  location text not null default '',
  status text not null default 'active' check (status in ('active', 'completed', 'failed')),
  position double precision not null default 0,
  dm_only boolean not null default false,
  created_at timestamptz not null default now()
);

-- Objectives carry no visibility of their own: they are exactly as visible as
-- the quest holding them. One rule instead of two, and no way to end up with a
-- hidden objective stranded inside a shared quest.
create table if not exists public.objectives (
  id uuid primary key default gen_random_uuid(),
  quest_id uuid not null references public.quests on delete cascade,
  body text not null default 'New objective',
  done boolean not null default false,
  position double precision not null default 0,
  created_at timestamptz not null default now()
);

-- Catches a database built from an earlier draft of this file, when objectives
-- had their own flag.
alter table public.objectives drop column if exists dm_only;

create index if not exists quests_campaign_idx on public.quests (campaign_id, position);
create index if not exists objectives_quest_idx on public.objectives (quest_id, position);
create index if not exists members_user_idx on public.campaign_members (user_id);

-- ---------------------------------------------------------------------------
-- Membership helpers
--
-- security definer so they can read campaign_members without tripping that
-- table's own policies, which would recurse forever. search_path is pinned so
-- the definer rights cannot be aimed at a table someone else created.
-- ---------------------------------------------------------------------------

create or replace function public.is_member (cid uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.campaign_members
    where campaign_id = cid and user_id = auth.uid()
  );
$$;

create or replace function public.is_dm (cid uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.campaign_members
    where campaign_id = cid and user_id = auth.uid() and role = 'dm'
  );
$$;

-- Objectives reach their campaign through their quest, so every objective
-- policy is really a question about the parent quest.
create or replace function public.can_see_quest (qid uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.quests q
    where q.id = qid
      and public.is_member(q.campaign_id)
      and (not q.dm_only or public.is_dm(q.campaign_id))
  );
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- A profile for every new account, seeded from whatever Discord supplied.
create or replace function public.handle_new_user ()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      'Adventurer'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Whoever creates a campaign is its DM. Without this the creator could not
-- see the campaign they just made, because every read policy below asks
-- campaign_members and there would be no row yet.
create or replace function public.add_creator_as_dm ()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.campaign_members (campaign_id, user_id, role)
  values (new.id, new.created_by, 'dm')
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_campaign_created on public.campaigns;
create trigger on_campaign_created
  after insert on public.campaigns
  for each row execute function public.add_creator_as_dm();

-- ---------------------------------------------------------------------------
-- Creating a campaign
--
-- An RPC because a plain `insert ... returning` cannot work here, for a reason
-- worth writing down: RETURNING checks the new row against the read policy at
-- insert time, and `campaigns_read` requires membership, but the membership row
-- is added by an AFTER trigger that has not fired yet. Postgres reports that as
-- "new row violates row-level security policy", which reads like the insert was
-- refused when in fact only the read-back was.
--
-- Doing both writes inside one security definer function sidesteps the ordering
-- entirely and hands back the finished row.
-- ---------------------------------------------------------------------------

create or replace function public.create_campaign (campaign_name text default null)
returns public.campaigns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  created public.campaigns;
begin
  if auth.uid() is null then
    raise exception 'Sign in before creating a campaign';
  end if;

  insert into public.campaigns (name, created_by)
  values (coalesce(campaign_name, 'New Campaign'), auth.uid())
  returning * into created;

  -- The trigger below usually gets here first; this is the belt to its braces,
  -- and makes the function correct on its own terms.
  insert into public.campaign_members (campaign_id, user_id, role)
  values (created.id, auth.uid(), 'dm')
  on conflict do nothing;

  return created;
end;
$$;

-- ---------------------------------------------------------------------------
-- Joining
--
-- An RPC rather than an insert policy on campaign_members: joining is the one
-- action a non-member must be allowed to take, and routing it through a
-- function keeps that exception in one auditable place instead of widening the
-- table's own rules.
-- ---------------------------------------------------------------------------

create or replace function public.join_campaign (code text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cid uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in before joining a campaign';
  end if;

  select id into cid from public.campaigns
  where invite_code = upper(trim(code));

  if cid is null then
    raise exception 'No campaign with that invite code';
  end if;

  insert into public.campaign_members (campaign_id, user_id, role)
  values (cid, auth.uid(), 'player')
  on conflict do nothing;

  return cid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Everyone in a campaign edits the shared list: add, rename, tick, reorder and
-- delete quests and objectives alike. Three things stay with the DM, and each
-- is a separate rule below rather than a matter of what the UI offers:
--
--   1. The campaign itself. Only a DM renames or deletes it.
--   2. The DM's own list. Players cannot read it, and cannot write to it.
--   3. Moving work between the two lists. A player cannot create a hidden
--      quest, nor flip a shared one to hidden. That is the with-check clauses
--      below; without them a player could quietly hide a quest from everyone.
--
-- Worth knowing when writing the client, because the two refusals look nothing
-- alike:
--
--   Touching a row you cannot see (a `using` block) matches zero rows and
--   raises nothing. It looks exactly like success.
--
--   Writing data you are not allowed to write (a `with check` block) raises
--   "new row violates row-level security policy".
--
-- So the client must check rows-affected, not just the absence of an error.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_members enable row level security;
alter table public.quests enable row level security;
alter table public.objectives enable row level security;

-- Supabase grants these by default; stating them makes the file self-contained
-- and testable elsewhere. Broad table rights are safe precisely because the
-- policies below decide what any of it actually returns. Note anon gets
-- nothing: signing in is the floor for everything.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_write_own on public.profiles;
create policy profiles_write_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists campaigns_read on public.campaigns;
create policy campaigns_read on public.campaigns
  for select to authenticated using (public.is_member(id));

drop policy if exists campaigns_create on public.campaigns;
create policy campaigns_create on public.campaigns
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists campaigns_update on public.campaigns;
create policy campaigns_update on public.campaigns
  for update to authenticated using (public.is_dm(id)) with check (public.is_dm(id));

drop policy if exists campaigns_delete on public.campaigns;
create policy campaigns_delete on public.campaigns
  for delete to authenticated using (public.is_dm(id));

drop policy if exists members_read on public.campaign_members;
create policy members_read on public.campaign_members
  for select to authenticated using (public.is_member(campaign_id));

drop policy if exists members_manage on public.campaign_members;
create policy members_manage on public.campaign_members
  for update to authenticated using (public.is_dm(campaign_id)) with check (public.is_dm(campaign_id));

-- A DM may remove anyone; anyone may remove themselves.
drop policy if exists members_remove on public.campaign_members;
create policy members_remove on public.campaign_members
  for delete to authenticated using (public.is_dm(campaign_id) or user_id = auth.uid());

-- The same expression governs reading and writing a quest, so there is no gap
-- where something is invisible but still writable. `using` judges the row as
-- it stands, `with check` the row as it would become: together they stop a
-- player both from touching a hidden quest and from hiding a shared one.
-- Removes the single all-verbs policy an earlier draft used, which would
-- otherwise survive alongside the four below and keep granting DM-only writes.
drop policy if exists quests_write on public.quests;
drop function if exists public.quest_campaign (uuid);

drop policy if exists quests_read on public.quests;
create policy quests_read on public.quests
  for select to authenticated using (
    public.is_member(campaign_id) and (not dm_only or public.is_dm(campaign_id))
  );

drop policy if exists quests_insert on public.quests;
create policy quests_insert on public.quests
  for insert to authenticated with check (
    public.is_member(campaign_id) and (not dm_only or public.is_dm(campaign_id))
  );

drop policy if exists quests_update on public.quests;
create policy quests_update on public.quests
  for update to authenticated
  using (public.is_member(campaign_id) and (not dm_only or public.is_dm(campaign_id)))
  with check (public.is_member(campaign_id) and (not dm_only or public.is_dm(campaign_id)));

drop policy if exists quests_delete on public.quests;
create policy quests_delete on public.quests
  for delete to authenticated using (
    public.is_member(campaign_id) and (not dm_only or public.is_dm(campaign_id))
  );

-- Whoever can see the quest can work on its objectives.
drop policy if exists objectives_read on public.objectives;
create policy objectives_read on public.objectives
  for select to authenticated using (public.can_see_quest(quest_id));

drop policy if exists objectives_write on public.objectives;
create policy objectives_write on public.objectives
  for all to authenticated
  using (public.can_see_quest(quest_id))
  with check (public.can_see_quest(quest_id));

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

-- Adding a table that is already published is an error, not a no-op, so this
-- checks first. That is what keeps the whole file safe to run twice.
do $$
declare
  t text;
begin
  foreach t in array array['campaigns', 'campaign_members', 'quests', 'objectives'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
