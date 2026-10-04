-- Grievance Desk: database setup for Supabase.
-- Run this whole file once in Supabase: SQL Editor -> New query -> paste -> Run.
-- It is safe to run again; it replaces functions and keeps existing data.
--
-- Security model
--   * No one (anonymous visitors or signed-in users) can read or write the tables directly.
--   * Customers act only through lodge_complaint / track_complaint / customer_reply,
--     and must prove ownership with reference number + registered mobile.
--   * Staff are signed-in users listed in public.staff. They act through staff_* functions.
--     Contact details are masked; revealing them is logged in contact_access_log.
--   * Confidential details (OTP, CVV, PIN, passwords, card / Aadhaar / PAN / account numbers)
--     are rejected server-side, so the browser checks cannot be bypassed.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------- tables

create table if not exists public.staff (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

create table if not exists public.complaints (
  id             uuid primary key default gen_random_uuid(),
  ref            text not null unique,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  service        text not null check (service in ('acct','debit','credit','pay','digital','loan','dep','chq','branch','third','locker','kyc')),
  issue          text not null check (char_length(issue) between 3 and 120),
  urgent         boolean not null default false,
  acct_last4     text check (acct_last4 ~ '^[0-9]{4}$'),
  txn_date       date,
  amount         numeric(14,2) check (amount >= 0 and amount < 1000000000000),
  txn_ref        text check (char_length(txn_ref) <= 40),
  description    text not null check (char_length(description) between 20 and 3000),
  outcome        text check (char_length(outcome) <= 200),
  name           text not null check (char_length(name) between 2 and 80),
  mobile         text not null check (mobile ~ '^[6-9][0-9]{9}$'),
  email          text check (char_length(email) <= 120 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  status         text not null default 'received' check (status in ('received','review','info','resolved')),
  consent_at     timestamptz not null,
  failed_lookups int not null default 0,
  locked_until   timestamptz
);

create table if not exists public.complaint_events (
  id           bigint generated always as identity primary key,
  complaint_id uuid not null references public.complaints(id) on delete cascade,
  at           timestamptz not null default now(),
  by_role      text not null check (by_role in ('customer','bank')),
  staff_id     uuid references auth.users(id),
  status       text,
  note         text not null check (char_length(note) between 1 and 3000)
);
create index if not exists complaint_events_complaint_idx on public.complaint_events(complaint_id, at);

create table if not exists public.contact_access_log (
  id           bigint generated always as identity primary key,
  complaint_id uuid not null references public.complaints(id) on delete cascade,
  staff_id     uuid not null references auth.users(id),
  at           timestamptz not null default now()
);

alter table public.staff              enable row level security;
alter table public.complaints         enable row level security;
alter table public.complaint_events   enable row level security;
alter table public.contact_access_log enable row level security;
-- No policies are created on purpose: direct table access is denied to everyone.
revoke all on public.staff, public.complaints, public.complaint_events, public.contact_access_log from anon, authenticated;

-- ---------------------------------------------------------------- private helpers

create or replace function private.luhn(digits text) returns boolean
language plpgsql immutable as $$
declare s int := 0; d int; alt boolean := false; i int;
begin
  for i in reverse char_length(digits)..1 loop
    d := substr(digits, i, 1)::int;
    if alt then d := d * 2; if d > 9 then d := d - 9; end if; end if;
    s := s + d; alt := not alt;
  end loop;
  return s % 10 = 0;
end $$;

-- Returns the kinds of confidential details found in t (empty array if none).
create or replace function private.sensitive_kinds(t text, staff boolean default false) returns text[]
language plpgsql immutable as $$
declare k text[] := '{}'; r record;
begin
  if t is null or t = '' then return k; end if;
  if t ~* '\m(otp|one[- ]?time ?pass(word|code)?)\M\D{0,8}\d{4,8}\M' then k := array_append(k, 'an OTP'); end if;
  if t ~* '\m(cvv2?|cvc)\M\D{0,10}\d{3,4}\M' then k := array_append(k, 'a CVV'); end if;
  if t ~* '\m(atm |upi |card |m)?pin\M(?!\s*code)\D{0,10}\d{4,6}\M' then k := array_append(k, 'a PIN'); end if;
  if t ~* '\m(password|passcode|pwd)\M\s*(is|:|=|-)\s*(?=\S*[0-9@#$%!&*])\S{4,}' then k := array_append(k, 'a password'); end if;
  for r in select x[1] as v from regexp_matches(t, '\m\d(?:[ -]?\d){12,18}\M', 'g') as x loop
    if private.luhn(regexp_replace(r.v, '\D', '', 'g')) then k := array_append(k, 'a full card number'); exit; end if;
  end loop;
  if t ~* '\m(aadhaa?r|uidai?|uid)\M\D{0,15}[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}'
     or (not 'a full card number' = any(k) and t ~ '(^|\D)[2-9]\d{3} \d{4} \d{4}(\D|$)') then
    k := array_append(k, 'an Aadhaar number');
  end if;
  if t ~* '\m[a-z]{3}[pchfatbljg][a-z]\d{4}[a-z]\M' then k := array_append(k, 'a PAN'); end if;
  if t ~* '\m(a/c|acc(ount)?|acct)\.?(\s*(no\.?|number))?\s*(is|:|#|-)?\s*\d{9,18}\M' then k := array_append(k, 'a full account number'); end if;
  if staff and t ~* '\m(share|send|tell|give|provide|confirm|enter|reply with|need)\M[^.?!\n]{0,40}\m(otp|pin|cvv|password|card number|aadhaa?r|pan)\M' then
    k := array_append(k, 'a request for confidential details');
  end if;
  return k;
end $$;

create or replace function private.assert_clean(field text, t text, staff boolean default false) returns void
language plpgsql immutable as $$
declare k text[] := private.sensitive_kinds(t, staff);
begin
  if array_length(k, 1) > 0 then
    raise exception using errcode = '22023', message = 'sensitive:' || field || ':' || array_to_string(k, ', ');
  end if;
end $$;

-- Accepts "98765 43210", "+91 9876543210", "09876543210"; returns 10 digits or null.
create or replace function private.norm_mobile(m text) returns text
language sql immutable as $$
  select case when d ~ '^[6-9][0-9]{9}$' then d end
  from (select regexp_replace(regexp_replace(coalesce(m, ''), '[\s-]', '', 'g'), '^(\+?91|0)(?=[6-9][0-9]{9}$)', '') as d) s
$$;

create or replace function private.mask(s text) returns text
language sql immutable as $$
  select case when s is null then null
              when char_length(s) <= 4 then s
              else repeat('•', char_length(s) - 4) || right(s, 4) end
$$;

create or replace function private.mask_email(e text) returns text
language sql immutable as $$
  select case when e is null then null else left(e, 1) || '•••' || substring(e from '@.*$') end
$$;

create or replace function private.new_ref() returns text
language plpgsql volatile as $$
declare alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; b bytea := extensions.gen_random_bytes(8); s text := ''; i int;
begin
  for i in 0..7 loop s := s || substr(alphabet, (get_byte(b, i) % 31) + 1, 1); end loop;
  return 'GD-' || to_char(now() at time zone 'Asia/Kolkata', 'YYMMDD') || '-' || s;
end $$;

create or replace function private.history(cid uuid) returns json
language sql stable as $$
  select coalesce(json_agg(json_build_object('at', at, 'by', by_role, 'status', status, 'note', note) order by at, id), '[]'::json)
  from public.complaint_events where complaint_id = cid
$$;

-- What a customer sees about their own complaint (no internal fields).
create or replace function private.customer_view(cid uuid) returns json
language sql stable as $$
  select json_build_object('ref', ref, 'createdAt', created_at, 'updatedAt', updated_at, 'service', service,
    'issue', issue, 'urgent', urgent, 'status', status, 'amount', amount, 'description', description,
    'history', private.history(id))
  from public.complaints where id = cid
$$;

-- Finds a complaint by ref + mobile. Wrong mobiles count towards a 1-hour lock after 5 tries.
create or replace function private.find_for_customer(p_ref text, p_mobile text) returns uuid
language plpgsql as $$
declare c public.complaints;
begin
  select * into c from public.complaints where ref = upper(trim(p_ref));
  if not found then return null; end if;
  if c.locked_until is not null and c.locked_until > now() then
    raise exception using errcode = '22023', message = 'locked';
  end if;
  if c.mobile is distinct from private.norm_mobile(p_mobile) then
    update public.complaints
       set failed_lookups = failed_lookups + 1,
           locked_until = case when failed_lookups + 1 >= 5 then now() + interval '1 hour' else locked_until end
     where id = c.id;
    return null;
  end if;
  if c.failed_lookups > 0 then update public.complaints set failed_lookups = 0, locked_until = null where id = c.id; end if;
  return c.id;
end $$;

create or replace function private.require_staff() returns void
language plpgsql stable as $$
begin
  if auth.uid() is null or not exists (select 1 from public.staff where user_id = auth.uid()) then
    raise exception using errcode = '42501', message = 'not_staff';
  end if;
end $$;

-- ---------------------------------------------------------------- customer API (anon)

create or replace function public.lodge_complaint(p jsonb) returns json
language plpgsql security definer set search_path = public, private, extensions as $$
declare v_ref text; v_id uuid; v_mobile text; v_issue text := trim(p->>'issue');
begin
  if coalesce((p->>'consent')::boolean, false) is not true then
    raise exception using errcode = '22023', message = 'consent_required';
  end if;
  v_mobile := private.norm_mobile(p->>'mobile');
  if v_mobile is null then raise exception using errcode = '22023', message = 'invalid:mobile'; end if;
  perform private.assert_clean('description', p->>'description');
  perform private.assert_clean('outcome', p->>'outcome');
  perform private.assert_clean('txnRef', p->>'txnRef');
  perform private.assert_clean('name', p->>'name');
  perform private.assert_clean('issue', v_issue);

  v_ref := private.new_ref();
  insert into public.complaints (ref, service, issue, urgent, acct_last4, txn_date, amount, txn_ref,
                                 description, outcome, name, mobile, email, consent_at)
  values (v_ref, p->>'service', v_issue,
          v_issue ~* '^(unauthorised transaction|money sent to wrong account|phishing or fraud attempt)',
          nullif(p->>'acct', ''), nullif(p->>'txnDate', '')::date, nullif(p->>'amount', '')::numeric,
          nullif(trim(p->>'txnRef'), ''), trim(p->>'description'), nullif(trim(p->>'outcome'), ''),
          trim(p->>'name'), v_mobile, lower(nullif(trim(p->>'email'), '')), now())
  returning id into v_id;

  insert into public.complaint_events (complaint_id, by_role, status, note)
  values (v_id, 'customer', 'received', 'Complaint lodged.');
  return private.customer_view(v_id);
end $$;

create or replace function public.track_complaint(p_ref text, p_mobile text) returns json
language plpgsql security definer set search_path = public, private as $$
declare v_id uuid := private.find_for_customer(p_ref, p_mobile);
begin
  if v_id is null then return null; end if;
  return private.customer_view(v_id);
end $$;

create or replace function public.customer_reply(p_ref text, p_mobile text, p_note text) returns json
language plpgsql security definer set search_path = public, private as $$
declare v_id uuid := private.find_for_customer(p_ref, p_mobile);
begin
  if v_id is null then return null; end if;
  if (select status from public.complaints where id = v_id) <> 'info' then
    raise exception using errcode = '22023', message = 'not_waiting';
  end if;
  perform private.assert_clean('note', p_note);
  insert into public.complaint_events (complaint_id, by_role, status, note) values (v_id, 'customer', 'review', trim(p_note));
  update public.complaints set status = 'review', updated_at = now() where id = v_id;
  return private.customer_view(v_id);
end $$;

-- ---------------------------------------------------------------- staff API (authenticated + on staff list)

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select 1 from public.staff where user_id = auth.uid())
$$;

create or replace function public.staff_list() returns json
language plpgsql stable security definer set search_path = public, private as $$
begin
  perform private.require_staff();
  return (select coalesce(json_agg(json_build_object(
      'id', id, 'ref', ref, 'createdAt', created_at, 'updatedAt', updated_at, 'service', service,
      'issue', issue, 'urgent', urgent, 'amount', amount, 'status', status,
      'name', name, 'mobile', private.mask(mobile)) order by created_at), '[]'::json)
    from public.complaints);
end $$;

create or replace function public.staff_get(p_id uuid) returns json
language plpgsql stable security definer set search_path = public, private as $$
begin
  perform private.require_staff();
  return (select json_build_object(
      'id', id, 'ref', ref, 'createdAt', created_at, 'updatedAt', updated_at, 'service', service,
      'issue', issue, 'urgent', urgent, 'acct', acct_last4, 'txnDate', txn_date, 'amount', amount,
      'txnRef', txn_ref, 'description', description, 'outcome', outcome, 'status', status,
      'name', name, 'mobile', private.mask(mobile), 'email', private.mask_email(email),
      'contactViews', (select count(*) from public.contact_access_log l where l.complaint_id = c.id),
      'history', private.history(id))
    from public.complaints c where id = p_id);
end $$;

create or replace function public.reveal_contact(p_id uuid) returns json
language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require_staff();
  insert into public.contact_access_log (complaint_id, staff_id) values (p_id, auth.uid());
  return (select json_build_object('mobile', mobile, 'email', email) from public.complaints where id = p_id);
end $$;

create or replace function public.staff_update(p_id uuid, p_status text, p_note text) returns json
language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require_staff();
  if p_status not in ('review', 'info', 'resolved') then
    raise exception using errcode = '22023', message = 'invalid:status';
  end if;
  perform private.assert_clean('note', p_note, true);
  insert into public.complaint_events (complaint_id, by_role, staff_id, status, note)
  values (p_id, 'bank', auth.uid(), p_status, trim(p_note));
  update public.complaints set status = p_status, updated_at = now() where id = p_id;
  return public.staff_get(p_id);
end $$;

-- ---------------------------------------------------------------- permissions

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.lodge_complaint(jsonb), public.track_complaint(text, text), public.customer_reply(text, text, text),
                       public.is_staff(), public.staff_list(), public.staff_get(uuid), public.reveal_contact(uuid),
                       public.staff_update(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.lodge_complaint(jsonb), public.track_complaint(text, text), public.customer_reply(text, text, text)
  to anon, authenticated;
grant execute on function public.is_staff(), public.staff_list(), public.staff_get(uuid), public.reveal_contact(uuid),
                          public.staff_update(uuid, text, text)
  to authenticated;
grant usage on schema private to postgres;

-- ---------------------------------------------------------------- adding staff
-- 1. Authentication -> Users -> Add user -> Create new user (tick "Auto Confirm User").
-- 2. Then run, with their email:
--      insert into public.staff (user_id) select id from auth.users where email = 'officer@yourbank.example';
-- To remove someone:
--      delete from public.staff where user_id = (select id from auth.users where email = 'officer@yourbank.example');
