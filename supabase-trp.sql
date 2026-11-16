-- =========================================================
-- Transport Roster — Supabase schema
-- =========================================================

-- Events
create table if not exists public.transport_events (
  id uuid primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null,
  event_date date,
  deadline_at timestamptz,
  total_transport_cost numeric default 0,
  pricing_mode text default 'auto',
  manual_seat_price numeric default 0,
  rounding_mode text default 'none',
  no_show_mode text default 'none',
  no_show_units numeric default 0,
  no_show_percent numeric default 0,
  status text default 'open',
  passengers jsonb default '[]'::jsonb,
  payments jsonb default '[]'::jsonb,
  version bigint not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Shares
create table if not exists public.transport_event_shares (
  slug text primary key,
  event_id uuid not null references public.transport_events(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  can_edit boolean default true,
  last_viewed_at timestamptz,
  viewer_email text,
  created_at timestamptz default now()
);

-- Logs
create table if not exists public.event_logs (
  id uuid primary key,
  event_id uuid not null references public.transport_events(id) on delete cascade,
  action text not null,
  actor_email text,
  actor_id uuid,
  details jsonb default '{}'::jsonb,
  at timestamptz not null default now()
);

create index if not exists idx_shares_event on public.transport_event_shares(event_id);
create index if not exists idx_logs_event on public.event_logs(event_id, at desc);

-- RLS
alter table public.transport_events enable row level security;
alter table public.transport_event_shares enable row level security;
alter table public.event_logs enable row level security;

-- Events policies
drop policy if exists "events owner" on public.transport_events;
create policy "events owner" on public.transport_events
  for all using (auth.uid() = owner) with check (auth.uid() = owner);

drop policy if exists "events shared read" on public.transport_events;
create policy "events shared read" on public.transport_events
  for select using (
    exists (select 1 from public.transport_event_shares s where s.event_id = transport_events.id)
  );

drop policy if exists "events shared write" on public.transport_events;
create policy "events shared write" on public.transport_events
  for update using (
    exists (select 1 from public.transport_event_shares s
            where s.event_id = transport_events.id and s.can_edit)
  );

-- Shares policies
drop policy if exists "shares owner" on public.transport_event_shares;
create policy "shares owner" on public.transport_event_shares
  for all using (auth.uid() = created_by) with check (auth.uid() = created_by);

drop policy if exists "shares read" on public.transport_event_shares;
create policy "shares read" on public.transport_event_shares
  for select using (true);

drop policy if exists "shares editor delete" on public.transport_event_shares;
create policy "shares editor delete" on public.transport_event_shares
  for delete using (
    auth.uid() = created_by
    or exists (
      select 1 from public.transport_events e
        where e.id = transport_event_shares.event_id and e.owner = auth.uid()
    )
  );

-- Logs policies
drop policy if exists "logs read" on public.event_logs;
create policy "logs read" on public.event_logs
  for select using (
    exists (select 1 from public.transport_events e where e.id = event_logs.event_id)
  );

drop policy if exists "logs insert" on public.event_logs;
create policy "logs insert" on public.event_logs
  for insert with check (
    exists (select 1 from public.transport_events e where e.id = event_logs.event_id)
  );

-- SECURITY DEFINER function for viewer "last viewed" tracking.
-- Updates only the tracking columns, bypassing RLS on the shares table.
create or replace function public.touch_share(p_slug text, p_email text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.transport_event_shares
     set last_viewed_at = now(),
         viewer_email   = coalesce(p_email, viewer_email)
   where slug = p_slug;
end $$;

grant execute on function public.touch_share(text, text) to authenticated;