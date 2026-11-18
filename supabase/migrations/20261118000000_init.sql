-- Tack schema. RLS is the security boundary: assume anyone has the URL and anon key.

create extension if not exists pgcrypto with schema extensions;

-- Tables ---------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 50)
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  invite_code text not null unique default encode(extensions.gen_random_bytes(6), 'hex')
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  last_read_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on public.workspace_members (user_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index on public.messages (workspace_id, created_at);

create table public.lists (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  position text not null
);
create index on public.lists (workspace_id);

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.lists (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 10000),
  assignee_id uuid references public.profiles (id) on delete set null,
  due_date date,
  position text not null,
  source_message_id uuid references public.messages (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index on public.cards (workspace_id);
create index on public.cards (list_id);

-- Triggers -------------------------------------------------------------------

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(left(split_part(new.email, '@', 1), 50), ''), 'user'));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.set_edited_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.edited_at := now();
  return new;
end $$;

create trigger messages_edited before update on public.messages
  for each row execute function public.set_edited_at();

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger cards_updated before update on public.cards
  for each row execute function public.set_updated_at();

-- Helpers (security definer so policies on workspace_members don't recurse) ---

create function public.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws and user_id = auth.uid()
  );
$$;

create function public.is_owner(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = ws and user_id = auth.uid() and role = 'owner'
  );
$$;

create function public.shares_workspace(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members a
    join public.workspace_members b on a.workspace_id = b.workspace_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- RPCs -----------------------------------------------------------------------

create function public.create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into public.workspaces (name, created_by) values (trim(p_name), auth.uid())
    returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role)
    values (ws, auth.uid(), 'owner');
  return ws;
end $$;

create function public.join_workspace(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select id into ws from public.workspaces where invite_code = lower(trim(p_code));
  if ws is null then
    raise exception 'invalid invite code';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role)
    values (ws, auth.uid(), 'member')
    on conflict do nothing;
  return ws;
end $$;

revoke execute on function
  public.handle_new_user(), public.is_member(uuid), public.is_owner(uuid),
  public.shares_workspace(uuid), public.create_workspace(text), public.join_workspace(text)
  from public, anon;
grant execute on function
  public.is_member(uuid), public.is_owner(uuid), public.shares_workspace(uuid),
  public.create_workspace(text), public.join_workspace(text)
  to authenticated;

-- Row Level Security ---------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.messages enable row level security;
alter table public.lists enable row level security;
alter table public.cards enable row level security;

-- Column privileges: limit what an UPDATE (or INSERT) may touch, regardless of policy.
revoke insert, update on public.profiles, public.workspaces, public.workspace_members from anon, authenticated;
revoke insert, update on public.messages from anon, authenticated;
revoke update on public.lists, public.cards from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;
grant update (name) on public.workspaces to authenticated;
grant update (last_read_at) on public.workspace_members to authenticated;
grant insert (workspace_id, body), update (body) on public.messages to authenticated;
grant update (title, position) on public.lists to authenticated;
grant update (list_id, title, description, assignee_id, due_date, position) on public.cards to authenticated;

-- profiles
create policy "read self and co-members" on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_workspace(id));
create policy "update self" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- workspaces (insert only via create_workspace)
create policy "members read" on public.workspaces for select to authenticated
  using (public.is_member(id));
create policy "owner renames" on public.workspaces for update to authenticated
  using (public.is_owner(id)) with check (public.is_owner(id));
create policy "owner deletes" on public.workspaces for delete to authenticated
  using (public.is_owner(id));

-- workspace_members (insert only via RPCs, roles never change)
create policy "members read" on public.workspace_members for select to authenticated
  using (public.is_member(workspace_id));
create policy "update own last_read_at" on public.workspace_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Members can leave, owner can remove members. The owner row stays (delete the workspace instead).
create policy "leave or remove" on public.workspace_members for delete to authenticated
  using (role = 'member' and (user_id = auth.uid() or public.is_owner(workspace_id)));

-- messages
create policy "members read" on public.messages for select to authenticated
  using (public.is_member(workspace_id));
create policy "members post as self" on public.messages for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(workspace_id));
create policy "author edits" on public.messages for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "author deletes" on public.messages for delete to authenticated
  using (user_id = auth.uid());

-- lists
create policy "members all" on public.lists for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));

-- cards
create policy "members all" on public.cards for all to authenticated
  using (public.is_member(workspace_id))
  with check (
    public.is_member(workspace_id)
    and exists (select 1 from public.lists l where l.id = list_id and l.workspace_id = cards.workspace_id)
    and (source_message_id is null or exists (
      select 1 from public.messages m where m.id = source_message_id and m.workspace_id = cards.workspace_id
    ))
  );

-- Realtime -------------------------------------------------------------------

alter publication supabase_realtime add table public.messages, public.lists, public.cards;
