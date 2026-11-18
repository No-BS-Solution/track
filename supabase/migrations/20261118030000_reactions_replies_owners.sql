-- Reactions, replies, card links in chat, archived cards, per-workspace notification settings,
-- multiple owners, presence authorization and pruning of dead push subscriptions.

-- Reactions -------------------------------------------------------------------

create table public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  emoji text not null check (emoji in ('👍', '❤️', '😂', '🎉', '👀', '✅')),
  primary key (message_id, user_id, emoji)
);
create index on public.message_reactions (workspace_id);
alter table public.message_reactions enable row level security;
revoke insert, update on public.message_reactions from anon, authenticated;
grant insert (message_id, workspace_id, emoji) on public.message_reactions to authenticated;

create policy "members read" on public.message_reactions for select to authenticated
  using (public.is_member(workspace_id));
create policy "members react as self" on public.message_reactions for insert to authenticated
  with check (
    user_id = auth.uid() and public.is_member(workspace_id)
    and exists (select 1 from public.messages m where m.id = message_id and m.workspace_id = message_reactions.workspace_id)
  );
create policy "remove own reaction" on public.message_reactions for delete to authenticated
  using (user_id = auth.uid());

alter publication supabase_realtime add table public.message_reactions;

-- Replies and card links in chat ---------------------------------------------

alter table public.messages
  add column reply_to uuid references public.messages (id) on delete set null,
  add column card_id uuid references public.cards (id) on delete set null;
alter table public.messages drop constraint messages_body_check;
alter table public.messages add constraint messages_body_check
  check (char_length(body) <= 4000 and (char_length(body) >= 1 or image_path is not null or card_id is not null));
grant insert (reply_to, card_id) on public.messages to authenticated;

drop policy "members post as self" on public.messages;
create policy "members post as self" on public.messages for insert to authenticated
  with check (
    user_id = auth.uid() and public.is_member(workspace_id)
    and (reply_to is null or exists (select 1 from public.messages r where r.id = reply_to and r.workspace_id = messages.workspace_id))
    and (card_id is null or exists (select 1 from public.cards c where c.id = card_id and c.workspace_id = messages.workspace_id))
  );
create index on public.messages (card_id) where card_id is not null;

-- Archived cards --------------------------------------------------------------

alter table public.cards add column archived_at timestamptz;
grant update (archived_at) on public.cards to authenticated;

-- Notification settings -------------------------------------------------------

alter table public.workspace_members add column notify text not null default 'all'
  check (notify in ('all', 'mentions', 'none'));
grant update (notify) on public.workspace_members to authenticated;

create or replace function public.notify_push() returns trigger
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
    'endpoint', x.endpoint,
    'keys', jsonb_build_object('p256dh', x.p256dh, 'auth', x.auth),
    'title', case when x.mentioned then author || ' mentioned you in ' || ws_name else author || ' in ' || ws_name end
  )), '[]') into subs
  from (
    select s.*, m.notify, strpos(new.body, '@' || p.display_name) > 0 as mentioned
    from public.push_subscriptions s
    join public.workspace_members m on m.user_id = s.user_id and m.workspace_id = new.workspace_id
    join public.profiles p on p.id = s.user_id
    where s.user_id <> new.user_id
  ) x
  where x.notify = 'all' or (x.notify = 'mentions' and x.mentioned);
  if jsonb_array_length(subs) = 0 then
    return null;
  end if;
  perform net.http_post(
    url := url,
    body := jsonb_build_object(
      'subscriptions', subs,
      'body', coalesce(nullif(left(new.body, 200), ''),
        case when new.card_id is not null then 'Shared a card' else 'Sent an image' end),
      'url', '#/w/' || new.workspace_id,
      'tag', new.workspace_id
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
  );
  return null;
end $$;
revoke execute on function public.notify_push() from public, anon, authenticated;

-- The push function answers with endpoints the push service reported as gone (404/410).
-- pg_net keeps responses for a few hours, so a periodic job deletes those subscriptions.
create function public.prune_push_subscriptions() returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint in (
    select jsonb_array_elements_text(r.content::jsonb -> 'gone')
    from net._http_response r
    where r.status_code = 200 and r.content like '{"sent":%'
  );
$$;
revoke execute on function public.prune_push_subscriptions() from public, anon, authenticated;
select cron.schedule('prune-push-subscriptions', '*/30 * * * *', 'select public.prune_push_subscriptions()');

-- Multiple owners -------------------------------------------------------------

create function public.owner_count(ws uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.workspace_members where workspace_id = ws and role = 'owner';
$$;

-- Owners promote or demote anyone, but a workspace always keeps at least one owner.
create function public.set_member_role(ws uuid, member uuid, new_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_owner(ws) then
    raise exception 'only owners can change roles';
  end if;
  if new_role not in ('owner', 'member') then
    raise exception 'invalid role';
  end if;
  if new_role = 'member' and public.owner_count(ws) <= 1
     and exists (select 1 from public.workspace_members where workspace_id = ws and user_id = member and role = 'owner') then
    raise exception 'a workspace needs at least one owner';
  end if;
  update public.workspace_members set role = new_role where workspace_id = ws and user_id = member;
end $$;

drop policy "leave or remove" on public.workspace_members;
create policy "leave or remove" on public.workspace_members for delete to authenticated
  using (
    (user_id = auth.uid() or public.is_owner(workspace_id))
    and (role = 'member' or public.owner_count(workspace_id) > 1)
  );

revoke execute on function public.owner_count(uuid), public.set_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.owner_count(uuid), public.set_member_role(uuid, uuid, text) to authenticated;

-- Presence ("online" and "typing") on private Realtime channels named presence:<workspace_id> --------

create function public.is_member_topic(topic text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id::text = split_part(topic, ':', 2) and user_id = auth.uid()
  );
$$;
revoke execute on function public.is_member_topic(text) from public, anon;
grant execute on function public.is_member_topic(text) to authenticated;

-- realtime.messages is created by the Realtime service, so it may not exist in a database-only test run.
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $p$create policy "members read presence" on realtime.messages for select to authenticated
      using (realtime.messages.extension = 'presence' and public.is_member_topic(realtime.topic()))$p$;
    execute $p$create policy "members send presence" on realtime.messages for insert to authenticated
      with check (realtime.messages.extension = 'presence' and public.is_member_topic(realtime.topic()))$p$;
  end if;
end $$;
