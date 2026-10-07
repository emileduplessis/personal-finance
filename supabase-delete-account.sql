-- ============================================================
-- delete_my_account() — lets a signed-in user delete their own account.
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- Deleting the auth.users row removes the email/login, and every app table
-- references auth.users(id) ON DELETE CASCADE, so all of the user's rows go
-- with it in the same transaction.
--
-- SECURITY DEFINER is needed because ordinary users can't touch auth.users.
-- It is safe here: the function takes no arguments and only ever deletes the
-- caller's own row (auth.uid()), and search_path is pinned to stop
-- object-shadowing tricks.
-- ============================================================
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
