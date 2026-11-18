-- G Squad hub (PS 1.68): one squad for everyone, PS accounts let in at once. NOT RUN: the developer applies it, THEN deploys the
-- `squad` function that goes with it (functions/squad/index.ts, case auto_join and isPsAccount). Applying this alone changes
-- nothing: only that function calls auto_join_account. Rollback: invite_002_rollback.sql.
-- Jan, 18 Nov 2026: "there is only one squad and everybody using this app is automatically in this one squad ... there should not
-- be an option to leave or join squad, we're all the app users."
--
-- Since V1.57 (invite_001) a new person waits until the admin lets them in. That closed a real leak (any new key pair got the squad
-- key). This keeps the leak closed and lets real PS users in by themselves: the squad function calls auto_join_account ONLY after it
-- checked the caller's own vault session with the developer's vault project (a PS account that owns its vault, vault_role() owner
-- or red) and that the join id is the one PS makes from that very account (sha256 of "gsquad-v1|who|<vault url>|<account id>").
-- A script with a fresh key pair still only gets a waiting row (auto_join, unchanged). The admin's Take out (squad_blocked) still
-- keeps anyone out. A person already waiting (asked before this) is let in the next time their PS shows its account.
-- Zero knowledge unchanged: no name, no key and no token is stored; RLS and grants unchanged (service role only).
-- Load: every lookup is by the unique sign_pub index or the (squad_id, who) lookup auto_join already does; one row written.
-- DB PROOF: not run on any database (code only, written for the developer to apply); same queries as auto_join, at most a few calls a day.

create or replace function public.auto_join_account(p_sign_pub text, p_box_pub text, p_who text)
returns jsonb language plpgsql set search_path = '' as $$
declare sid uuid; sq public.squads; old public.squad_members; n integer; mid uuid;
begin
  if p_who is null or p_who !~ '^[0-9a-f]{64}$' then raise exception 'removed' using errcode = 'P0001'; end if;
  sid := public.auto_squad();
  perform public.auto_heal(sid);
  select * into sq from public.squads where id = sid for update;
  if exists (select 1 from public.squad_blocked where squad_id = sid and who = p_who) then
    raise exception 'removed' using errcode = 'P0001';
  end if;
  -- The same key again: a retry, or a person who was waiting since V1.57 (their own row: same join id). Waiting: let in now.
  select * into old from public.squad_members where sign_pub = p_sign_pub and squad_id = sid and left_at is null;
  if found then
    if not old.admitted then
      if old.who is distinct from p_who then raise exception 'member' using errcode = 'P0001'; end if;
      select count(*) into n from public.squad_members where squad_id = sid and left_at is null and admitted;
      if n >= 200 then raise exception 'full' using errcode = 'P0001'; end if;
      update public.squad_members set admitted = true, ask_ct = null, updated_at = now() where id = old.id;
    end if;
    return jsonb_build_object('squad', sid, 'member', old.id, 'gen', sq.gen, 'start', sq.meta_ct is null and not old.has_key,
      'key', old.has_key, 'admitted', true);
  end if;
  select * into old from public.squad_members where squad_id = sid and who = p_who and left_at is null order by joined_at desc limit 1;
  if found then
    -- In already (their other device): it waits for its record through the vault, as before. A waiting ask: this one replaces it.
    if old.admitted then raise exception 'member' using errcode = 'P0001'; end if;
    delete from public.squad_members where id = old.id;
  end if;
  select count(*) into n from public.squad_members where squad_id = sid and left_at is null and admitted;
  if n >= 200 then raise exception 'full' using errcode = 'P0001'; end if;
  insert into public.squad_members (squad_id, sign_pub, box_pub, who, has_key, admitted) values (sid, p_sign_pub, p_box_pub, p_who, false, true)
    returning id into mid;
  return jsonb_build_object('squad', sid, 'member', mid, 'gen', sq.gen, 'start', sq.meta_ct is null, 'key', false, 'admitted', true);
end $$;

revoke all on function public.auto_join_account(text, text, text) from public, anon, authenticated;
grant execute on function public.auto_join_account(text, text, text) to service_role;
