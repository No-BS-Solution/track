-- Storage cleanup, usage reporting, automatic message trim (only when the database is nearly full),
-- Web Push, invite code rotation, card comments and checklists.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- Image cleanup -------------------------------------------------------------

create function public.is_owner_folder(object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id::text = (storage.foldername(object_name))[1] and user_id = auth.uid() and role = 'owner'
  );
$$;
revoke execute on function public.is_owner_folder(text) from public, anon;
grant execute on function public.is_owner_folder(text) to authenticated;

create policy "uploader or owner deletes images" on storage.objects for delete to authenticated
  using (
    bucket_id = 'images' and public.is_member_folder(name)
    and (owner_id = auth.uid()::text or public.is_owner_folder(name))
  );

-- Reports total project usage (no workspace data) so the app can warn before the plan limit.
create function public.storage_usage() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'db_bytes', pg_database_size(current_database()),
    'file_bytes', coalesce((select sum((metadata ->> 'size')::bigint) from storage.objects), 0)
  );
$$;

-- Owner-only: delete messages before a date and detach images uploaded before it from cards.
-- The app then deletes the image files that nothing references any more.
create function public.delete_history_before(ws uuid, before timestamptz) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  if not public.is_owner(ws) then
    raise exception 'only the workspace owner can delete history';
  end if;
  update public.cards c set image_paths = array(
    select p from unnest(c.image_paths) p
    where not exists (
      select 1 from storage.objects o where o.bucket_id = 'images' and o.name = p and o.created_at < before
    )
  )
  where c.workspace_id = ws and c.image_paths <> '{}';
  delete from public.messages where workspace_id = ws and created_at < before;
  get diagnostics n = row_count;
  return n;
end $$;

-- Nightly safety net: chat history is kept unless the database passes 90% of the plan limit,
-- then the oldest messages are removed until usage is back to about 75%.
create function public.trim_messages_if_full() returns void
language plpgsql security definer set search_path = '' as $$
declare
  limit_bytes constant bigint := 500 * 1024 * 1024; -- Supabase free plan database size, raise when upgrading
  live_messages bigint;
  used bigint;
  cutoff timestamptz;
begin
  select coalesce(sum(pg_column_size(m.*)), 0) into live_messages from public.messages m;
  -- Deleted rows keep their disk space until reused, so count live message bytes instead of table size.
  used := pg_database_size(current_database()) - pg_total_relation_size('public.messages') + live_messages;
  if used < limit_bytes * 0.9 then
    return;
  end if;
  select created_at into cutoff from (
    select created_at, sum(pg_column_size(m.*)) over (order by created_at, id) as running from public.messages m
  ) x
  where running >= used - (limit_bytes * 0.75)::bigint
  order by created_at limit 1;
  delete from public.messages where created_at <= cutoff;
end $$;

select cron.schedule('trim-messages-if-full', '17 3 * * *', 'select public.trim_messages_if_full()');

-- Invite codes ---------------------------------------------------------------

create function public.regenerate_invite_code(ws uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  code text;
begin
  if not public.is_owner(ws) then
    raise exception 'only the workspace owner can change the invite code';
  end if;
  update public.workspaces set invite_code = encode(extensions.gen_random_bytes(6), 'hex')
    where id = ws returning invite_code into code;
  return code;
end $$;

-- Card comments and checklists ----------------------------------------------

create table public.card_comments (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index on public.card_comments (card_id, created_at);
alter table public.card_comments enable row level security;
revoke insert, update on public.card_comments from anon, authenticated;
grant insert (card_id, workspace_id, body) on public.card_comments to authenticated;

create policy "members read" on public.card_comments for select to authenticated
  using (public.is_member(workspace_id));
create policy "members comment as self" on public.card_comments for insert to authenticated
  with check (
    user_id = auth.uid() and public.is_member(workspace_id)
    and exists (select 1 from public.cards c where c.id = card_id and c.workspace_id = card_comments.workspace_id)
  );
create policy "author deletes" on public.card_comments for delete to authenticated
  using (user_id = auth.uid());

alter table public.cards add column checklist jsonb not null default '[]'
  check (jsonb_typeof(checklist) = 'array' and jsonb_array_length(checklist) <= 100);
grant update (checklist) on public.cards to authenticated;

-- Web Push -------------------------------------------------------------------

create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
revoke insert, update on public.push_subscriptions from anon, authenticated;
create policy "own subscriptions" on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());
create policy "remove own subscriptions" on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

-- One browser = one endpoint, so a re-login on a shared device moves the subscription to the new user.
create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000 or char_length(p_p256dh) > 200 or char_length(p_auth) > 100 then
    raise exception 'invalid push subscription';
  end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
    values (p_endpoint, auth.uid(), p_p256dh, p_auth)
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

-- Hands new messages to the `push` Edge Function. The function URL and shared secret live in Supabase Vault
-- (see README); without them this does nothing, so forks work without push.
create function public.notify_push() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  url text;
  secret text;
  author text;
  ws_name text;
  subs jsonb;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if url is null or secret is null then
    return null;
  end if;
  select display_name into author from public.profiles where id = new.user_id;
  select name into ws_name from public.workspaces where id = new.workspace_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'endpoint', s.endpoint,
    'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth),
    'title', case when strpos(new.body, '@' || p.display_name) > 0
      then author || ' mentioned you in ' || ws_name
      else author || ' in ' || ws_name end
  )), '[]') into subs
  from public.push_subscriptions s
  join public.workspace_members m on m.user_id = s.user_id and m.workspace_id = new.workspace_id
  join public.profiles p on p.id = s.user_id
  where s.user_id <> new.user_id;
  if jsonb_array_length(subs) = 0 then
    return null;
  end if;
  perform net.http_post(
    url := url,
    body := jsonb_build_object(
      'subscriptions', subs,
      'body', coalesce(nullif(left(new.body, 200), ''), 'Sent an image'),
      'url', '#/w/' || new.workspace_id,
      'tag', new.workspace_id
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
  );
  return null;
end $$;

create trigger messages_push after insert on public.messages
  for each row execute function public.notify_push();

-- Function privileges --------------------------------------------------------

revoke execute on function
  public.storage_usage(), public.delete_history_before(uuid, timestamptz), public.trim_messages_if_full(),
  public.regenerate_invite_code(uuid), public.save_push_subscription(text, text, text), public.notify_push()
  from public, anon;
revoke execute on function public.trim_messages_if_full(), public.notify_push() from authenticated;
grant execute on function
  public.storage_usage(), public.delete_history_before(uuid, timestamptz),
  public.regenerate_invite_code(uuid), public.save_push_subscription(text, text, text)
  to authenticated;
