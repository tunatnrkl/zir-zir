-- =====================================================================
-- ZIR ZIR – Supabase veritabanı kurulumu
-- Supabase panelinde: SQL Editor → New query → bu dosyanın tamamını
-- yapıştır → Run. Tekrar çalıştırmak güvenlidir (veriyi silmez).
--
-- Bütün yazma işlemleri aşağıdaki fonksiyonlardan geçer. Tablolara
-- dışarıdan doğrudan yazılamaz (RLS). Yönetici kodu burada, sunucu
-- tarafında doğrulanır; veritabanında yalnızca bcrypt özeti saklanır.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- Tablolar ----------
create table if not exists public.players (
  id          bigserial primary key,
  name        text   not null,
  name_key    text   not null unique,
  created_at  bigint not null
);

create table if not exists public.matches (
  id          bigserial primary key,
  player_a    bigint not null references public.players(id) on delete cascade,
  player_b    bigint not null references public.players(id) on delete cascade,
  score_a     int,
  score_b     int,
  result      text   not null check (result in ('A','B','D')),
  played_at   bigint not null,
  check (player_a <> player_b)
);
create index if not exists matches_played_at_idx on public.matches(played_at);

create table if not exists public.adjustments (
  id          bigserial primary key,
  player_id   bigint not null references public.players(id) on delete cascade,
  amount      int    not null,
  reason      text   not null default '',
  created_at  bigint not null
);

-- Silinmeyen yönetici işlem kaydı
create table if not exists public.audit_log (
  id          bigserial primary key,
  action      text   not null,
  details     jsonb  not null,
  created_at  bigint not null
);

create table if not exists public.app_meta (
  id          int primary key default 1 check (id = 1),
  version     bigint not null default 0,
  admin_hash  text   not null
);
-- Varsayılan yönetici kodunun bcrypt özeti (kodun kendisi burada yok).
insert into public.app_meta(id, version, admin_hash)
values (1, 0, '$2a$10$UbvQIkjhDyZdSN7jkrm4weAUrB/SAGWOvVK6Q71iPJmXBDbsUGI36')
on conflict (id) do nothing;

create table if not exists public.admin_sessions (
  token_hash  text primary key,
  expires_at  bigint not null
);

create table if not exists public.login_attempts (
  ip        text primary key,
  first_at  bigint not null,
  count     int    not null
);

-- ---------- Erişim: herkes okur, kimse doğrudan yazamaz ----------
alter table public.players        enable row level security;
alter table public.matches        enable row level security;
alter table public.adjustments    enable row level security;
alter table public.audit_log      enable row level security;
alter table public.app_meta       enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.login_attempts enable row level security;

revoke all on public.players, public.matches, public.adjustments, public.audit_log,
              public.app_meta, public.admin_sessions, public.login_attempts
  from anon, authenticated;
grant select on public.players, public.matches, public.adjustments to anon, authenticated;

drop policy if exists zz_read on public.players;
drop policy if exists zz_read on public.matches;
drop policy if exists zz_read on public.adjustments;
create policy zz_read on public.players     for select to anon, authenticated using (true);
create policy zz_read on public.matches     for select to anon, authenticated using (true);
create policy zz_read on public.adjustments for select to anon, authenticated using (true);

-- ---------- Yardımcı (iç) fonksiyonlar ----------
create or replace function public.zz_now() returns bigint
language sql volatile as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

create or replace function public.zz_bump() returns void
language sql security definer set search_path = public as
$$ update public.app_meta set version = version + 1 where id = 1 $$;

create or replace function public.zz_audit(p_action text, p_details jsonb) returns void
language sql security definer set search_path = public as
$$ insert into public.audit_log(action, details, created_at) values (p_action, p_details, public.zz_now()) $$;

create or replace function public.zz_require_admin(p_token text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_token is null or length(p_token) > 200 or not exists (
    select 1 from public.admin_sessions
    where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
      and expires_at > public.zz_now()
  ) then
    raise exception 'Yönetici yetkisi gerekli.' using errcode = '28000';
  end if;
end $$;

create or replace function public.zz_clean_name(p_name text) returns text
language plpgsql immutable as $$
declare n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  n := regexp_replace(n, '[[:cntrl:]]', '', 'g');
  if char_length(n) < 2 or char_length(n) > 20 then
    raise exception 'Oyuncu adı 2-20 karakter olmalı.';
  end if;
  return n;
end $$;

-- Maç girdisini doğrular, sonucu (gerekirse skordan) belirler.
create or replace function public.zz_check_match(
  p_a bigint, p_b bigint, p_result text, p_score_a int, p_score_b int
) returns text
language plpgsql security definer set search_path = public as $$
declare from_score text;
begin
  if p_a is null or p_b is null then raise exception 'İki oyuncuyu da seç.'; end if;
  if p_a = p_b then raise exception 'Bir oyuncu kendisiyle maç yapamaz.'; end if;
  if not exists (select 1 from public.players where id = p_a)
     or not exists (select 1 from public.players where id = p_b) then
    raise exception 'Oyuncu bulunamadı.';
  end if;
  if (p_score_a is null) <> (p_score_b is null) then
    raise exception 'Skor girilecekse iki taraf da girilmeli.';
  end if;
  if p_score_a is not null then
    if p_score_a not between 0 and 99 or p_score_b not between 0 and 99 then
      raise exception 'Skor 0-99 arası bir tam sayı olmalı.';
    end if;
    from_score := case when p_score_a > p_score_b then 'A' when p_score_a < p_score_b then 'B' else 'D' end;
  end if;
  if p_result is null or p_result = '' then
    if from_score is null then raise exception 'Kazananı seç.'; end if;
    return from_score;
  end if;
  if p_result not in ('A','B','D') then raise exception 'Geçersiz sonuç.'; end if;
  if from_score is not null and from_score <> p_result then
    raise exception 'Skor ile seçilen sonuç uyuşmuyor.';
  end if;
  return p_result;
end $$;

-- ---------- Herkese açık fonksiyonlar ----------
create or replace function public.zz_version() returns bigint
language sql stable security definer set search_path = public as
$$ select version from public.app_meta where id = 1 $$;

create or replace function public.zz_add_match(
  p_a bigint, p_b bigint, p_result text default null, p_score_a int default null, p_score_b int default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare r text; t bigint := public.zz_now(); new_id bigint;
begin
  r := public.zz_check_match(p_a, p_b, p_result, p_score_a, p_score_b);
  if exists (select 1 from public.matches
             where player_a = p_a and player_b = p_b and result = r and played_at > t - 15000) then
    raise exception 'Bu maç az önce kaydedildi. İki kere basmış olabilirsin.';
  end if;
  insert into public.matches(player_a, player_b, score_a, score_b, result, played_at)
  values (p_a, p_b, p_score_a, p_score_b, r, t) returning id into new_id;
  perform public.zz_bump();
  return new_id;
end $$;

create or replace function public.zz_admin_login(p_code text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_ip text := coalesce(split_part(
    coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1), '');
  t bigint := public.zz_now();
  att public.login_attempts;
  stored text;
  token text;
begin
  if v_ip = '' then v_ip := 'unknown'; end if;
  select * into att from public.login_attempts where login_attempts.ip = v_ip;
  if found and t - att.first_at < 900000 and att.count >= 8 then
    return json_build_object('ok', false, 'error', 'Çok fazla deneme. 15 dakika sonra tekrar dene.');
  end if;

  select admin_hash into stored from public.app_meta where id = 1;
  if p_code is null or length(p_code) > 200 or stored is null
     or extensions.crypt(p_code, stored) <> stored then
    insert into public.login_attempts(ip, first_at, count) values (v_ip, t, 1)
    on conflict (ip) do update set
      first_at = case when t - login_attempts.first_at >= 900000 then t else login_attempts.first_at end,
      count    = case when t - login_attempts.first_at >= 900000 then 1 else login_attempts.count + 1 end;
    return json_build_object('ok', false, 'error', 'Yanlış kod. ZIR ZIR AĞLAMA.');
  end if;

  delete from public.login_attempts where login_attempts.ip = v_ip;
  delete from public.admin_sessions where expires_at < t;
  token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.admin_sessions(token_hash, expires_at)
  values (encode(extensions.digest(token, 'sha256'), 'hex'), t + 12 * 3600 * 1000);
  perform public.zz_audit('admin_login', '{}'::jsonb);
  return json_build_object('ok', true, 'token', token);
end $$;

-- ---------- Yönetici fonksiyonları ----------
create or replace function public.zz_admin_check(p_token text) returns boolean
language plpgsql security definer set search_path = public as $$
begin perform public.zz_require_admin(p_token); return true; end $$;

create or replace function public.zz_admin_logout(p_token text) returns void
language sql security definer set search_path = public, extensions as
$$ delete from public.admin_sessions where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') $$;

create or replace function public.zz_admin_log(p_token text) returns setof public.audit_log
language plpgsql security definer set search_path = public as $$
begin
  perform public.zz_require_admin(p_token);
  return query select * from public.audit_log order by id desc limit 300;
end $$;

-- Oyuncu eklemek herkese açık
drop function if exists public.zz_admin_add_player(text, text);
create or replace function public.zz_add_player(p_name text) returns bigint
language plpgsql security definer set search_path = public as $$
declare n text; new_id bigint;
begin
  n := public.zz_clean_name(p_name);
  if exists (select 1 from public.players where name_key = lower(n)) then
    raise exception 'Bu isimde bir oyuncu zaten var.';
  end if;
  insert into public.players(name, name_key, created_at) values (n, lower(n), public.zz_now()) returning id into new_id;
  perform public.zz_audit('player_add', jsonb_build_object('playerId', new_id, 'name', n));
  perform public.zz_bump();
  return new_id;
end $$;

create or replace function public.zz_admin_rename_player(p_token text, p_id bigint, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare n text; old text;
begin
  perform public.zz_require_admin(p_token);
  n := public.zz_clean_name(p_name);
  select name into old from public.players where id = p_id;
  if not found then raise exception 'Oyuncu bulunamadı.'; end if;
  if exists (select 1 from public.players where name_key = lower(n) and id <> p_id) then
    raise exception 'Bu isimde bir oyuncu zaten var.';
  end if;
  update public.players set name = n, name_key = lower(n) where id = p_id;
  perform public.zz_audit('player_rename', jsonb_build_object('playerId', p_id, 'from', old, 'to', n));
  perform public.zz_bump();
end $$;

-- p_rating: istemcinin hesapladığı silinmeden önceki puan (yalnızca kayıt için)
create or replace function public.zz_admin_delete_player(p_token text, p_id bigint, p_rating int default null) returns void
language plpgsql security definer set search_path = public as $$
declare old text; n int;
begin
  perform public.zz_require_admin(p_token);
  select name into old from public.players where id = p_id;
  if not found then raise exception 'Oyuncu bulunamadı.'; end if;
  select count(*) into n from public.matches where player_a = p_id or player_b = p_id;
  delete from public.players where id = p_id; -- maçlar ve düzeltmeler CASCADE ile silinir
  perform public.zz_audit('player_delete',
    jsonb_build_object('playerId', p_id, 'name', old, 'rating', p_rating, 'matchesRemoved', n));
  perform public.zz_bump();
end $$;

create or replace function public.zz_admin_adjust(
  p_token text, p_player bigint, p_amount int, p_reason text default '', p_before int default null
) returns void
language plpgsql security definer set search_path = public as $$
declare old text; r text := left(btrim(coalesce(p_reason, '')), 120); new_id bigint;
begin
  perform public.zz_require_admin(p_token);
  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000 then
    raise exception 'Miktar -1000 ile +1000 arasında, sıfırdan farklı bir tam sayı olmalı.';
  end if;
  select name into old from public.players where id = p_player;
  if not found then raise exception 'Oyuncu bulunamadı.'; end if;
  insert into public.adjustments(player_id, amount, reason, created_at)
  values (p_player, p_amount, r, public.zz_now()) returning id into new_id;
  perform public.zz_audit('elo_adjust', jsonb_build_object(
    'adjustmentId', new_id, 'playerId', p_player, 'name', old, 'amount', p_amount, 'reason', r, 'before', p_before));
  perform public.zz_bump();
end $$;

create or replace function public.zz_admin_edit_match(
  p_token text, p_id bigint, p_a bigint, p_b bigint, p_result text, p_score_a int default null, p_score_b int default null
) returns void
language plpgsql security definer set search_path = public as $$
declare old public.matches; r text;
begin
  perform public.zz_require_admin(p_token);
  select * into old from public.matches where id = p_id;
  if not found then raise exception 'Maç bulunamadı.'; end if;
  r := public.zz_check_match(p_a, p_b, p_result, p_score_a, p_score_b);
  update public.matches set player_a = p_a, player_b = p_b, score_a = p_score_a, score_b = p_score_b, result = r
  where id = p_id;
  perform public.zz_audit('match_edit', jsonb_build_object(
    'matchId', p_id,
    'before', jsonb_build_object('player_a', old.player_a, 'player_b', old.player_b,
      'name_a', (select name from public.players where id = old.player_a),
      'name_b', (select name from public.players where id = old.player_b),
      'score_a', old.score_a, 'score_b', old.score_b, 'result', old.result),
    'after', jsonb_build_object('playerA', p_a, 'playerB', p_b, 'scoreA', p_score_a, 'scoreB', p_score_b, 'result', r)));
  perform public.zz_bump();
end $$;

create or replace function public.zz_admin_delete_match(p_token text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare old public.matches;
begin
  perform public.zz_require_admin(p_token);
  select * into old from public.matches where id = p_id;
  if not found then raise exception 'Maç bulunamadı.'; end if;
  delete from public.matches where id = p_id;
  perform public.zz_audit('match_delete', jsonb_build_object('matchId', p_id, 'match', jsonb_build_object(
    'name_a', (select name from public.players where id = old.player_a),
    'name_b', (select name from public.players where id = old.player_b),
    'score_a', old.score_a, 'score_b', old.score_b, 'result', old.result)));
  perform public.zz_bump();
end $$;

-- ---------- Fonksiyon yetkileri ----------
-- İç yardımcılar dışarıya kapalı
revoke execute on function
  public.zz_now(), public.zz_bump(), public.zz_audit(text, jsonb), public.zz_require_admin(text),
  public.zz_clean_name(text), public.zz_check_match(bigint, bigint, text, int, int)
  from public, anon, authenticated;

-- Dışarıya açık olanlar (yönetici olanlar zaten token ister)
revoke execute on function
  public.zz_version(), public.zz_add_match(bigint, bigint, text, int, int), public.zz_admin_login(text),
  public.zz_admin_check(text), public.zz_admin_logout(text), public.zz_admin_log(text),
  public.zz_add_player(text), public.zz_admin_rename_player(text, bigint, text),
  public.zz_admin_delete_player(text, bigint, int), public.zz_admin_adjust(text, bigint, int, text, int),
  public.zz_admin_edit_match(text, bigint, bigint, bigint, text, int, int), public.zz_admin_delete_match(text, bigint)
  from public;
grant execute on function
  public.zz_version(), public.zz_add_match(bigint, bigint, text, int, int), public.zz_admin_login(text),
  public.zz_admin_check(text), public.zz_admin_logout(text), public.zz_admin_log(text),
  public.zz_add_player(text), public.zz_admin_rename_player(text, bigint, text),
  public.zz_admin_delete_player(text, bigint, int), public.zz_admin_adjust(text, bigint, int, text, int),
  public.zz_admin_edit_match(text, bigint, bigint, bigint, text, int, int), public.zz_admin_delete_match(text, bigint)
  to anon, authenticated;

-- PostgREST'in yeni fonksiyonları hemen görmesi için
notify pgrst, 'reload schema';
