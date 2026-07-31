create extension if not exists pgcrypto;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_code_hash text not null,
  name text not null check (char_length(name) between 1 and 80),
  event_date date,
  practice_goal_per_person integer not null default 5 check (practice_goal_per_person between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.events
add column if not exists owner_id uuid references auth.users(id) on delete cascade;

alter table public.events
add column if not exists event_code_hash text;

create table if not exists public.performances (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  dance_style text not null check (char_length(dance_style) between 1 and 80),
  dancer_group text check (dancer_group in ('Ladies', 'Men', 'Kids', 'Girls', 'Boys', 'Couples', 'Parents & Kids')),
  instagram_url text not null check (instagram_url ~ '^https://(www\.)?instagram\.com/.+'),
  added_by text not null check (char_length(added_by) between 1 and 60),
  notes text not null default '' check (char_length(notes) <= 500),
  votes text[] not null default '{}',
  finalized boolean not null default false,
  finalized_by text,
  finalized_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.performances
add column if not exists dancer_group text check (dancer_group in ('Ladies', 'Men', 'Kids', 'Girls', 'Boys', 'Couples', 'Parents & Kids'));

create table if not exists public.practice_logs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  performance_id uuid references public.performances(id) on delete set null,
  person text not null check (char_length(person) between 1 and 60),
  minutes integer not null default 20 check (minutes between 1 and 600),
  practiced_at_home boolean not null default true,
  notes text not null default '' check (char_length(notes) <= 180),
  created_at timestamptz not null default now()
);

create table if not exists public.event_members (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

drop table if exists public.event_invites;

create index if not exists performances_event_id_created_at_idx on public.performances(event_id, created_at desc);
create index if not exists practice_logs_event_id_created_at_idx on public.practice_logs(event_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists events_set_updated_at on public.events;
create trigger events_set_updated_at
before update on public.events
for each row execute function public.set_updated_at();

create or replace function public.is_event_member(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.events
    where id = target_event_id and owner_id = auth.uid()
  ) or exists (
    select 1 from public.event_members
    where event_id = target_event_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_event_owner(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.events
    where id = target_event_id and owner_id = auth.uid()
  );
$$;

create or replace function public.add_event_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.event_members (event_id, user_id, role)
  values (new.id, new.owner_id, 'editor')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists events_add_owner_membership on public.events;
create trigger events_add_owner_membership
after insert on public.events
for each row execute function public.add_event_owner_membership();

drop function if exists public.claim_event_invitations();

create or replace function public.create_event_with_code(
  p_name text,
  p_event_date date,
  p_practice_goal integer,
  p_event_code text
)
returns table (
  id uuid,
  owner_id uuid,
  name text,
  event_date date,
  practice_goal_per_person integer,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_event public.events%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if char_length(trim(p_event_code)) < 12 then
    raise exception 'Event code must be at least 12 characters';
  end if;
  insert into public.events (owner_id, name, event_date, practice_goal_per_person, event_code_hash)
  values (
    auth.uid(),
    coalesce(nullif(trim(p_name), ''), 'New Event'),
    p_event_date,
    greatest(1, least(100, coalesce(p_practice_goal, 5))),
    extensions.crypt(trim(p_event_code), extensions.gen_salt('bf'))
  )
  returning * into new_event;
  return query select new_event.id, new_event.owner_id, new_event.name, new_event.event_date,
    new_event.practice_goal_per_person, new_event.created_at, new_event.updated_at;
end;
$$;

create or replace function public.join_event_with_code(p_event_code text)
returns table (event_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_event_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  select id into matched_event_id
  from public.events
  where event_code_hash is not null
    and event_code_hash = extensions.crypt(trim(p_event_code), event_code_hash)
  limit 1;
  if matched_event_id is null then
    raise exception 'Invalid event code';
  end if;
  insert into public.event_members (event_id, user_id, role)
  values (matched_event_id, auth.uid(), 'editor')
  on conflict do nothing;
  return query select matched_event_id;
end;
$$;

alter table public.events enable row level security;
alter table public.performances enable row level security;
alter table public.practice_logs enable row level security;
alter table public.event_members enable row level security;

revoke all on public.events, public.performances, public.practice_logs, public.event_members from anon;
grant select, update on public.events to authenticated;
grant select, insert, update, delete on public.performances to authenticated;
grant select, insert on public.practice_logs to authenticated;
grant select, insert on public.event_members to authenticated;
revoke all on function public.is_event_member(uuid), public.is_event_owner(uuid), public.create_event_with_code(text, date, integer, text), public.join_event_with_code(text) from public;
grant execute on function public.is_event_member(uuid), public.is_event_owner(uuid), public.create_event_with_code(text, date, integer, text), public.join_event_with_code(text) to authenticated;

drop policy if exists "Anyone can read events" on public.events;
drop policy if exists "Anyone can create events" on public.events;
drop policy if exists "Anyone can update events" on public.events;
drop policy if exists "Members can read their events" on public.events;
drop policy if exists "Signed-in users can create owned events" on public.events;
drop policy if exists "Owners can update their events" on public.events;
create policy "Members can read their events" on public.events for select to authenticated using (public.is_event_member(id));
create policy "Signed-in users can create owned events" on public.events for insert to authenticated with check (owner_id = auth.uid());
create policy "Owners can update their events" on public.events for update to authenticated using (public.is_event_owner(id)) with check (owner_id = auth.uid());

drop policy if exists "Anyone can read performances" on public.performances;
drop policy if exists "Anyone can create performances" on public.performances;
drop policy if exists "Anyone can vote and finalize performances" on public.performances;
drop policy if exists "Members can read performances" on public.performances;
drop policy if exists "Members can add performances" on public.performances;
drop policy if exists "Members can update performances" on public.performances;
drop policy if exists "Members can delete performances" on public.performances;
create policy "Members can read performances" on public.performances for select to authenticated using (public.is_event_member(event_id));
create policy "Members can add performances" on public.performances for insert to authenticated with check (public.is_event_member(event_id));
create policy "Members can update performances" on public.performances for update to authenticated using (public.is_event_member(event_id)) with check (public.is_event_member(event_id));
create policy "Members can delete performances" on public.performances for delete to authenticated using (public.is_event_member(event_id));

drop policy if exists "Anyone can read practice logs" on public.practice_logs;
drop policy if exists "Anyone can add practice logs" on public.practice_logs;
drop policy if exists "Members can read practice logs" on public.practice_logs;
drop policy if exists "Members can add practice logs" on public.practice_logs;
create policy "Members can read practice logs" on public.practice_logs for select to authenticated using (public.is_event_member(event_id));
create policy "Members can add practice logs" on public.practice_logs for insert to authenticated with check (public.is_event_member(event_id));

drop policy if exists "Members can see their membership" on public.event_members;
drop policy if exists "Owners can add members" on public.event_members;
create policy "Members can see their membership" on public.event_members for select to authenticated using (public.is_event_member(event_id));
create policy "Owners can add members" on public.event_members for insert to authenticated with check (public.is_event_owner(event_id));

notify pgrst, 'reload schema';
