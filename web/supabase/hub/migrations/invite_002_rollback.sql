-- Rollback of invite_002_every_ps_user.sql (PS 1.68). Deploy the earlier `squad` function first (without auto_join_account),
-- then run this. People let in by it stay in (they are admitted members like any other).
drop function if exists public.auto_join_account(text, text, text);
