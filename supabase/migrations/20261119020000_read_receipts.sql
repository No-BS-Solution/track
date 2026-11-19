-- Live read receipts: members see each other's last_read_at change (rows are already readable by members via RLS).
alter publication supabase_realtime add table public.workspace_members;
