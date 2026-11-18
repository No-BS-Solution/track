-- Image attachments for messages and cards, stored privately per workspace: images/<workspace_id>/<file>

alter table public.messages add column image_path text;
alter table public.messages drop constraint messages_body_check;
alter table public.messages add constraint messages_body_check
  check (char_length(body) <= 4000 and (char_length(body) >= 1 or image_path is not null));
grant insert (image_path) on public.messages to authenticated;

alter table public.cards add column image_paths text[] not null default '{}'
  check (cardinality(image_paths) <= 20);
grant update (image_paths) on public.cards to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('images', 'images', false, 5242880, array['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

-- Text comparison instead of a uuid cast, so odd object names can never make a policy throw.
create function public.is_member_folder(object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id::text = (storage.foldername(object_name))[1] and user_id = auth.uid()
  );
$$;
revoke execute on function public.is_member_folder(text) from public, anon;
grant execute on function public.is_member_folder(text) to authenticated;

create policy "members read workspace images" on storage.objects for select to authenticated
  using (bucket_id = 'images' and public.is_member_folder(name));
create policy "members upload workspace images" on storage.objects for insert to authenticated
  with check (bucket_id = 'images' and public.is_member_folder(name));
