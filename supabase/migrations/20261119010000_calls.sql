-- Voice/video calls. Media flows peer to peer (WebRTC); the database only records that a call exists so
-- members can be rung by push notification and late joiners can see it. Signaling runs on private
-- Realtime broadcast channels named call:<workspace_id>:<call_id>.

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  started_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index on public.calls (workspace_id, created_at desc);
alter table public.calls enable row level security;
revoke insert, update on public.calls from anon, authenticated;
grant insert (workspace_id) on public.calls to authenticated;

create policy "members read" on public.calls for select to authenticated
  using (public.is_member(workspace_id));
create policy "members start calls" on public.calls for insert to authenticated
  with check (started_by = auth.uid() and public.is_member(workspace_id));

create function public.end_call(call uuid) returns void
language sql security definer set search_path = '' as $$
  update public.calls set ended_at = now()
  where id = call and ended_at is null and public.is_member(workspace_id);
$$;
revoke execute on function public.end_call(uuid) from public, anon;
grant execute on function public.end_call(uuid) to authenticated;

alter publication supabase_realtime add table public.calls;

-- Ring every other member (unless they muted the workspace) with Answer / Decline buttons.
create function public.notify_call_push() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  url text;
  secret text;
  caller text;
  ws_name text;
  subs jsonb;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if url is null or secret is null then
    return null;
  end if;
  select display_name into caller from public.profiles where id = new.started_by;
  select name into ws_name from public.workspaces where id = new.workspace_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'endpoint', s.endpoint,
    'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth),
    'title', caller || ' is calling'
  )), '[]') into subs
  from public.push_subscriptions s
  join public.workspace_members m on m.user_id = s.user_id and m.workspace_id = new.workspace_id
  where s.user_id <> new.started_by and m.notify <> 'none';
  if jsonb_array_length(subs) = 0 then
    return null;
  end if;
  perform net.http_post(
    url := url,
    body := jsonb_build_object(
      'subscriptions', subs,
      'body', 'Call in ' || ws_name,
      'url', '#/w/' || new.workspace_id || '/call/' || new.id,
      'tag', 'call-' || new.id,
      'call', true
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
  );
  return null;
end $$;
revoke execute on function public.notify_call_push() from public, anon, authenticated;

create trigger calls_push after insert on public.calls
  for each row execute function public.notify_call_push();

-- Let members use broadcast (call signaling) as well as presence on their workspace's private channels.
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists "members read presence" on realtime.messages';
    execute 'drop policy if exists "members send presence" on realtime.messages';
    execute $p$create policy "members read workspace channels" on realtime.messages for select to authenticated
      using (realtime.messages.extension in ('presence', 'broadcast') and public.is_member_topic(realtime.topic()))$p$;
    execute $p$create policy "members send workspace channels" on realtime.messages for insert to authenticated
      with check (realtime.messages.extension in ('presence', 'broadcast') and public.is_member_topic(realtime.topic()))$p$;
  end if;
end $$;
