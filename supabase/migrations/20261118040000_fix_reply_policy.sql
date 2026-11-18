-- The subquery's own `reply_to` column shadowed the new row's, so every reply was rejected. Qualify both.
drop policy "members post as self" on public.messages;
create policy "members post as self" on public.messages for insert to authenticated
  with check (
    user_id = auth.uid() and public.is_member(workspace_id)
    and (messages.reply_to is null or exists (
      select 1 from public.messages r where r.id = messages.reply_to and r.workspace_id = messages.workspace_id
    ))
    and (messages.card_id is null or exists (
      select 1 from public.cards c where c.id = messages.card_id and c.workspace_id = messages.workspace_id
    ))
  );
