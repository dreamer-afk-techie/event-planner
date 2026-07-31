create extension if not exists pgcrypto;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  event_date date,
  practice_goal_per_person integer not null default 5 check (practice_goal_per_person between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

alter table public.events enable row level security;
alter table public.performances enable row level security;
alter table public.practice_logs enable row level security;

grant select, insert, update on public.events to anon;
grant select, insert, update on public.performances to anon;
grant select, insert on public.practice_logs to anon;

drop policy if exists "Anyone can read events" on public.events;
create policy "Anyone can read events"
on public.events for select
to anon
using (true);

drop policy if exists "Anyone can create events" on public.events;
create policy "Anyone can create events"
on public.events for insert
to anon
with check (true);

drop policy if exists "Anyone can update events" on public.events;
create policy "Anyone can update events"
on public.events for update
to anon
using (true)
with check (true);

drop policy if exists "Anyone can read performances" on public.performances;
create policy "Anyone can read performances"
on public.performances for select
to anon
using (true);

drop policy if exists "Anyone can create performances" on public.performances;
create policy "Anyone can create performances"
on public.performances for insert
to anon
with check (true);

drop policy if exists "Anyone can vote and finalize performances" on public.performances;
create policy "Anyone can vote and finalize performances"
on public.performances for update
to anon
using (true)
with check (true);

drop policy if exists "Anyone can read practice logs" on public.practice_logs;
create policy "Anyone can read practice logs"
on public.practice_logs for select
to anon
using (true);

drop policy if exists "Anyone can add practice logs" on public.practice_logs;
create policy "Anyone can add practice logs"
on public.practice_logs for insert
to anon
with check (true);
