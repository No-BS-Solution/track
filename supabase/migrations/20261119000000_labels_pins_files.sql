-- Labels, pinned messages, file attachments and @mention notifications in card comments.

-- Labels ----------------------------------------------------------------------

create table public.labels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  color text not null check (color in ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray'))
);
create index on public.labels (workspace_id);
alter table public.labels enable row level security;
create policy "members all" on public.labels for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
revoke update on public.labels from anon, authenticated;
grant update (name, color) on public.labels to authenticated;

-- Label ids that no longer exist are ignored by the app, so deleting a label needs no card rewrite.
alter table public.cards add column label_ids uuid[] not null default '{}' check (cardinality(label_ids) <= 20);
grant update (label_ids) on public.cards to authenticated;

-- Pinned messages -------------------------------------------------------------

alter table public.messages add column pinned_at timestamptz;

-- Any member may pin, so this goes through a function instead of the author-only update policy.
create function public.set_pinned(msg uuid, pinned boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.messages set pinned_at = case when pinned then now() end
  where id = msg and public.is_member(workspace_id);
end $$;
revoke execute on function public.set_pinned(uuid, boolean) from public, anon;
grant execute on function public.set_pinned(uuid, boolean) to authenticated;

-- Pinning is not an edit.
create or replace function public.set_edited_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end $$;

-- File attachments ------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('files', 'files', false, 10485760, array[
  'application/pdf', 'text/plain', 'text/csv', 'text/markdown', 'application/json', 'application/zip',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation'
]);

create policy "members read workspace files" on storage.objects for select to authenticated
  using (bucket_id = 'files' and public.is_member_folder(name));
create policy "members upload workspace files" on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and public.is_member_folder(name));
create policy "uploader or owner deletes files" on storage.objects for delete to authenticated
  using (
    bucket_id = 'files' and public.is_member_folder(name)
    and (owner_id = auth.uid()::text or public.is_owner_folder(name))
  );

alter table public.messages
  add column file_path text,
  add column file_name text check (char_length(file_name) <= 200),
  add column file_size integer;
alter table public.messages drop constraint messages_body_check;
alter table public.messages add constraint messages_body_check check (
  char_length(body) <= 4000
  and (char_length(body) >= 1 or image_path is not null or card_id is not null or file_path is not null)
);
grant insert (file_path, file_name, file_size) on public.messages to authenticated;

-- [{ "path": "...", "name": "...", "size": 123 }]
alter table public.cards add column attachments jsonb not null default '[]'
  check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 20);
grant update (attachments) on public.cards to authenticated;

-- History cleanup also detaches old files from cards.
create or replace function public.delete_history_before(ws uuid, before timestamptz) returns integer
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
  update public.cards c set attachments = coalesce((
    select jsonb_agg(a) from jsonb_array_elements(c.attachments) a
    where not exists (
      select 1 from storage.objects o where o.bucket_id = 'files' and o.name = a ->> 'path' and o.created_at < before
    )
  ), '[]')
  where c.workspace_id = ws and c.attachments <> '[]';
  delete from public.messages where workspace_id = ws and created_at < before;
  get diagnostics n = row_count;
  return n;
end $$;

-- Push --------------------------------------------------------------------------

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
        case
          when new.card_id is not null then 'Shared a card'
          when new.file_path is not null then 'Sent a file: ' || coalesce(new.file_name, 'file')
          else 'Sent an image'
        end),
      'url', '#/w/' || new.workspace_id,
      'tag', new.workspace_id
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
  );
  return null;
end $$;

-- Card comments notify only the people they @mention (unless they muted the workspace).
create function public.notify_comment_push() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  url text;
  secret text;
  author text;
  card_title text;
  subs jsonb;
begin
  select decrypted_secret into url from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if url is null or secret is null then
    return null;
  end if;
  select display_name into author from public.profiles where id = new.user_id;
  select title into card_title from public.cards where id = new.card_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'endpoint', s.endpoint,
    'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth),
    'title', author || ' mentioned you on "' || left(card_title, 60) || '"'
  )), '[]') into subs
  from public.push_subscriptions s
  join public.workspace_members m on m.user_id = s.user_id and m.workspace_id = new.workspace_id
  join public.profiles p on p.id = s.user_id
  where s.user_id <> new.user_id and m.notify <> 'none' and strpos(new.body, '@' || p.display_name) > 0;
  if jsonb_array_length(subs) = 0 then
    return null;
  end if;
  perform net.http_post(
    url := url,
    body := jsonb_build_object(
      'subscriptions', subs,
      'body', left(new.body, 200),
      'url', '#/w/' || new.workspace_id || '/c/' || new.card_id,
      'tag', new.card_id
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
  );
  return null;
end $$;

create trigger card_comments_push after insert on public.card_comments
  for each row execute function public.notify_comment_push();

revoke execute on function public.notify_push(), public.notify_comment_push() from public, anon, authenticated;
