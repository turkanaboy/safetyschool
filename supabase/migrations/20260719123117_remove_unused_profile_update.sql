revoke update (display_name) on public.profiles from authenticated;
drop policy if exists profiles_update_self on public.profiles;
