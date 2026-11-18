-- Run with: npx supabase test db
-- Simulates attackers calling the API directly with the anon key or their own session.
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'eve@example.com');

select is((select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'alice', 'profile auto-created with email prefix');

-- alice: owner of ws (list L1, card C1) and ws2 (list L2)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select set_config('t.ws', public.create_workspace('Team')::text, true);
select set_config('t.ws2', public.create_workspace('Other')::text, true);
select set_config('t.code', (select invite_code from public.workspaces where id = current_setting('t.ws')::uuid), true);
insert into public.lists (id, workspace_id, title, position) values
  ('aaaaaaaa-0000-0000-0000-000000000001', current_setting('t.ws')::uuid, 'Todo', 'a0'),
  ('aaaaaaaa-0000-0000-0000-000000000002', current_setting('t.ws2')::uuid, 'Elsewhere', 'a0');
insert into public.cards (id, list_id, workspace_id, title, position) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', current_setting('t.ws')::uuid, 'Card', 'a0');
with m as (insert into public.messages (workspace_id, body) values (current_setting('t.ws')::uuid, 'hello') returning id)
select set_config('t.m1', id::text, true) from m;

select matches(current_setting('t.code'), '^[0-9a-f]{12}$', 'invite code is 12 hex chars');
select is((select role from public.workspace_members where workspace_id = current_setting('t.ws')::uuid
  and user_id = auth.uid()), 'owner', 'creator is owner');
select throws_ok($$ insert into public.workspaces (name) values ('x') $$, '42501', null, 'no direct workspace insert');
select throws_ok($$ insert into public.workspace_members (workspace_id, user_id) values (current_setting('t.ws')::uuid, '33333333-3333-3333-3333-333333333333') $$,
  '42501', null, 'no direct member insert');
select throws_ok($$ insert into public.cards (list_id, workspace_id, title, position) values ('aaaaaaaa-0000-0000-0000-000000000002', current_setting('t.ws')::uuid, 'x', 'a1') $$,
  '42501', null, 'card list must be in same workspace (insert)');
select throws_ok($$ update public.cards set list_id = 'aaaaaaaa-0000-0000-0000-000000000002' where id = 'cccccccc-0000-0000-0000-000000000001' $$,
  '42501', null, 'card list must be in same workspace (update)');
select throws_ok($$ update public.cards set workspace_id = current_setting('t.ws2')::uuid $$,
  '42501', null, 'card workspace cannot change');
select throws_ok($$ update public.messages set created_at = now() - interval '1 year' $$,
  '42501', null, 'message timestamps cannot be changed');

-- eve: authenticated but not a member
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select count(*) from public.workspaces), 0::bigint, 'non-member sees no workspaces');
select is((select count(*) from public.workspace_members), 0::bigint, 'non-member sees no members');
select is((select count(*) from public.messages), 0::bigint, 'non-member sees no messages');
select is((select count(*) from public.lists), 0::bigint, 'non-member sees no lists');
select is((select count(*) from public.cards), 0::bigint, 'non-member sees no cards');
select is((select count(*) from public.profiles), 1::bigint, 'non-member sees only own profile');
select throws_ok($$ insert into public.messages (workspace_id, body) values (current_setting('t.ws')::uuid, 'hi') $$,
  '42501', null, 'non-member cannot post');
select throws_ok($$ select public.join_workspace('000000000000') $$, 'P0001', 'invalid invite code', 'bad invite code rejected');
update public.cards set title = 'pwned';
delete from public.lists;

-- bob joins with the invite code
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is(public.join_workspace(upper(current_setting('t.code'))), current_setting('t.ws')::uuid, 'join with invite code');
select is((select count(*) from public.workspaces), 1::bigint, 'member sees joined workspace only');
select is((select title from public.cards), 'Card', 'non-member update had no effect');
select is((select count(*) from public.profiles), 2::bigint, 'member sees co-member profiles');
select throws_ok($$ update public.workspace_members set role = 'owner' where user_id = auth.uid() $$,
  '42501', null, 'cannot change own role');
update public.workspaces set name = 'mine';
select is((select name from public.workspaces), 'Team', 'member cannot rename workspace');
delete from public.workspace_members where role = 'owner';
select is((select count(*) from public.workspace_members), 2::bigint, 'member cannot remove owner');
select throws_ok($$ insert into public.messages (workspace_id, user_id, body) values (current_setting('t.ws')::uuid, '11111111-1111-1111-1111-111111111111', 'spoof') $$,
  '42501', null, 'cannot post as someone else');
with m as (insert into public.messages (workspace_id, body) values (current_setting('t.ws')::uuid, 'mine') returning id)
select set_config('t.m2', id::text, true) from m;
update public.messages set body = 'edited' where id = current_setting('t.m1')::uuid;
delete from public.messages where id = current_setting('t.m1')::uuid;
select is((select body from public.messages where id = current_setting('t.m1')::uuid), 'hello', 'cannot edit or delete others messages');
update public.messages set body = 'mine!' where id = current_setting('t.m2')::uuid;
select isnt((select edited_at from public.messages where id = current_setting('t.m2')::uuid), null, 'author edit sets edited_at');
update public.cards set title = 'Bob card';
select is((select title from public.cards), 'Bob card', 'member can edit cards');

-- alice removes bob
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
update public.workspaces set name = 'Renamed' where id = current_setting('t.ws')::uuid;
select is((select name from public.workspaces where id = current_setting('t.ws')::uuid), 'Renamed', 'owner can rename');
delete from public.workspace_members where user_id = '22222222-2222-2222-2222-222222222222';
select is((select count(*) from public.workspace_members where workspace_id = current_setting('t.ws')::uuid), 1::bigint, 'owner can remove member');

-- anon (just the public key)
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*) from public.workspaces), 0::bigint, 'anon sees no workspaces');
select is((select count(*) from public.messages), 0::bigint, 'anon sees no messages');
select throws_ok($$ select public.create_workspace('x') $$, '42501', null, 'anon cannot call RPC');

select * from finish();
rollback;
