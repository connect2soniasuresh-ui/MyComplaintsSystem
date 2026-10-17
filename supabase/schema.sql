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
--   * Routing and escalation: every complaint is routed to a team by rules when lodged, then the
--     "ai" Edge Function may re-route it once (ai_* functions, service_role only). Escalation
--     levels only go up and are recorded as 'system' events that customers don't see.

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

-- Routing and escalation (added after the first release; safe to re-run).
alter table public.complaints add column if not exists team         text;
alter table public.complaints add column if not exists level        int  not null default 0;  -- 0 officer, 1 team lead, 2 nodal officer, 3 Internal Ombudsman / GM
alter table public.complaints add column if not exists escalated_at timestamptz;
alter table public.complaints add column if not exists routed_by    text;                     -- rules | ai | staff
alter table public.complaints add column if not exists route_reason text;
alter table public.complaints add column if not exists ai_risk      text;                     -- low | medium | high
create index if not exists complaints_mobile_idx on public.complaints(mobile, created_at);
alter table public.complaint_events drop constraint if exists complaint_events_by_role_check;
alter table public.complaint_events add constraint complaint_events_by_role_check check (by_role in ('customer','bank','system'));

-- Per-caller limit on AI requests (keys are hashes, never raw IP addresses).
create table if not exists public.ai_calls (
  key          text not null,
  window_start timestamptz not null,
  n            int not null default 0,
  primary key (key, window_start)
);

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
alter table public.ai_calls           enable row level security;
-- No policies are created on purpose: direct table access is denied to everyone.
revoke all on public.staff, public.complaints, public.complaint_events, public.contact_access_log, public.ai_calls from anon, authenticated;

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

-- internal = true includes routing and escalation events, which only staff see.
drop function if exists private.history(uuid);
create or replace function private.history(cid uuid, internal boolean) returns json
language sql stable as $$
  select coalesce(json_agg(json_build_object('at', at, 'by', by_role, 'status', status, 'note', note) order by at, id), '[]'::json)
  from public.complaint_events where complaint_id = cid and (internal or by_role <> 'system')
$$;

-- What a customer sees about their own complaint (no internal fields).
create or replace function private.customer_view(cid uuid) returns json
language sql stable as $$
  select json_build_object('ref', ref, 'createdAt', created_at, 'updatedAt', updated_at, 'service', service,
    'issue', issue, 'urgent', urgent, 'status', status, 'amount', amount, 'description', description,
    'history', private.history(id, false))
  from public.complaints where id = cid
$$;

-- ---------------------------------------------------------------- routing and escalation

create or replace function private.team_name(t text) returns text
language sql immutable as $$
  select case t
    when 'cards' then 'Cards & ATMs' when 'payments' then 'Payments & UPI' when 'digital' then 'Digital banking'
    when 'loans' then 'Loans & recovery' when 'accounts' then 'Accounts & deposits' when 'branch' then 'Branch operations'
    when 'wealth' then 'Insurance & investments' when 'records' then 'KYC & records' when 'fraud' then 'Fraud cell' end
$$;

create or replace function private.level_name(l int) returns text
language sql immutable as $$
  select (array['Complaints officer','Team lead','Principal Nodal Officer','Internal Ombudsman / GM'])[l + 1]
$$;

-- Rule-based routing: used the moment a complaint is lodged, and whenever AI is unavailable.
create or replace function private.default_team(svc text, urgent boolean) returns text
language sql immutable as $$
  select case when urgent then 'fraud' else case svc
    when 'acct' then 'accounts' when 'debit' then 'cards' when 'credit' then 'cards' when 'pay' then 'payments'
    when 'digital' then 'digital' when 'loan' then 'loans' when 'dep' then 'accounts' when 'chq' then 'accounts'
    when 'branch' then 'branch' when 'third' then 'wealth' when 'locker' then 'branch' when 'kyc' then 'records'
    else 'branch' end end
$$;

-- "5 hours" up to 47 hours, then "3 days". Matches dur() in app.js.
create or replace function private.duration(h int) returns text
language sql immutable as $$
  select case when h < 48 then h || ' hour' || case when h = 1 then '' else 's' end else (h / 24) || ' days' end
$$;

-- The escalation matrix. Returns the level a complaint should be at now, and why.
create or replace function private.escalation_target(c public.complaints, out lvl int, out reason text)
language plpgsql stable as $$
declare hrs int := floor(extract(epoch from now() - c.created_at) / 3600);
        last_at timestamptz := (select max(at) from public.complaint_events e where e.complaint_id = c.id and e.by_role <> 'system');
        repeats int := (select count(*) from public.complaints o where o.mobile = c.mobile and o.id <> c.id
                          and o.created_at > c.created_at - interval '90 days' and o.created_at <= c.created_at);
begin
  lvl := 0; reason := null;
  if c.status = 'resolved' then return; end if;
  -- Time rules follow the bank's 24-hour resolution target (RBI's 30-day limit is the outer deadline).
  if    hrs >= 20 then lvl := 3; reason := 'Open ' || private.duration(hrs) || ' against the 24-hour target';
  elsif hrs >= 12 then lvl := 2; reason := 'Open ' || private.duration(hrs) || ' against the 24-hour target';
  elsif c.urgent and coalesce(c.amount, 0) >= 100000 then lvl := 2; reason := 'Suspected fraud of ₹1 lakh or more';
  elsif repeats >= 2 then lvl := 2; reason := 'Third complaint from this customer in 90 days';
  elsif c.ai_risk = 'high' then lvl := 1; reason := 'AI rated this complaint high risk';
  elsif c.urgent then lvl := 1; reason := 'Fraud complaint';
  elsif last_at < now() - interval '4 hours' then lvl := 1; reason := 'No action for 4 hours';
  end if;
end $$;

-- Raises one complaint's level if the matrix says so. Levels never go down.
create or replace function private.check_escalation(cid uuid) returns void
language plpgsql as $$
declare c public.complaints; t record;
begin
  select * into c from public.complaints where id = cid for update;
  if not found then return; end if;
  t := private.escalation_target(c);
  if t.lvl > c.level then
    update public.complaints set level = t.lvl, escalated_at = now() where id = cid;
    insert into public.complaint_events (complaint_id, by_role, note)
    values (cid, 'system', 'Escalated to ' || private.level_name(t.lvl) || ': ' || t.reason || '.');
  end if;
end $$;

create or replace function private.run_escalations() returns int
language plpgsql as $$
declare r record; n int := 0; before int;
begin
  for r in select id, level from public.complaints where status <> 'resolved' and level < 3 loop
    before := r.level;
    perform private.check_escalation(r.id);
    if (select level from public.complaints where id = r.id) > before then n := n + 1; end if;
  end loop;
  return n;
end $$;

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
declare v_ref text; v_id uuid; v_mobile text; v_issue text := trim(p->>'issue'); v_urgent boolean;
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
  v_urgent := v_issue ~* '^(unauthorised transaction|money sent to wrong account|phishing or fraud attempt)';
  insert into public.complaints (ref, service, issue, urgent, acct_last4, txn_date, amount, txn_ref,
                                 description, outcome, name, mobile, email, consent_at, team, routed_by, route_reason)
  values (v_ref, p->>'service', v_issue, v_urgent,
          nullif(p->>'acct', ''), nullif(p->>'txnDate', '')::date, nullif(p->>'amount', '')::numeric,
          nullif(trim(p->>'txnRef'), ''), trim(p->>'description'), nullif(trim(p->>'outcome'), ''),
          trim(p->>'name'), v_mobile, lower(nullif(trim(p->>'email'), '')), now(),
          private.default_team(p->>'service', v_urgent), 'rules', 'Default team for this service')
  returning id into v_id;

  insert into public.complaint_events (complaint_id, by_role, status, note)
  values (v_id, 'customer', 'received', 'Complaint lodged.');
  insert into public.complaint_events (complaint_id, by_role, note)
  values (v_id, 'system', 'Routed to ' || private.team_name(private.default_team(p->>'service', v_urgent)) || ' by rules.');
  perform private.check_escalation(v_id);
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

-- Volatile on purpose: it runs the escalation matrix first, so escalations happen
-- even if pg_cron isn't enabled.
drop function if exists public.staff_list();
create or replace function public.staff_list() returns json
language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require_staff();
  perform private.run_escalations();
  return (select coalesce(json_agg(json_build_object(
      'id', id, 'ref', ref, 'createdAt', created_at, 'updatedAt', updated_at, 'service', service,
      'issue', issue, 'urgent', urgent, 'amount', amount, 'status', status,
      'team', team, 'level', level, 'routedBy', routed_by,
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
      'team', team, 'level', level, 'escalatedAt', escalated_at, 'routedBy', routed_by,
      'routeReason', route_reason, 'aiRisk', ai_risk,
      'history', private.history(id, true))
    from public.complaints c where id = p_id);
end $$;

create or replace function public.staff_route(p_id uuid, p_team text) returns json
language plpgsql security definer set search_path = public, private as $$
begin
  perform private.require_staff();
  if private.team_name(p_team) is null then raise exception using errcode = '22023', message = 'invalid:team'; end if;
  update public.complaints set team = p_team, routed_by = 'staff', route_reason = 'Re-routed by staff', updated_at = now()
   where id = p_id and team is distinct from p_team;
  if found then
    insert into public.complaint_events (complaint_id, by_role, staff_id, note)
    values (p_id, 'system', auth.uid(), 'Re-routed to ' || private.team_name(p_team) || ' by staff.');
  end if;
  return public.staff_get(p_id);
end $$;

-- ---------------------------------------------------------------- AI API (service_role only, called by the "ai" Edge Function)

-- Counts one AI request for a caller; false once they're over p_limit this hour.
create or replace function public.ai_take(p_key text, p_limit int) returns boolean
language plpgsql security definer set search_path = public as $$
declare w timestamptz := date_trunc('hour', now()); v int;
begin
  delete from public.ai_calls where window_start < now() - interval '2 hours';
  insert into public.ai_calls (key, window_start, n) values (p_key, w, 1)
  on conflict (key, window_start) do update set n = public.ai_calls.n + 1
  returning n into v;
  return v <= p_limit;
end $$;

-- The fields AI needs to route a complaint. No name, mobile, email or account digits.
-- Returns null unless the complaint is still on rule-based routing, so each complaint is AI-routed at most once.
create or replace function public.ai_route_get(p_ref text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('service', service, 'issue', issue, 'urgent', urgent, 'amount', amount,
                           'description', description, 'outcome', outcome)
  from public.complaints
  where ref = upper(trim(p_ref)) and routed_by = 'rules' and created_at > now() - interval '2 days'
$$;

create or replace function public.ai_apply_route(p_ref text, p_team text, p_risk text, p_fraud boolean, p_reason text) returns json
language plpgsql security definer set search_path = public, private as $$
declare c public.complaints; v_reason text := left(trim(coalesce(p_reason, '')), 300);
begin
  if private.team_name(p_team) is null or p_risk not in ('low','medium','high') then
    raise exception using errcode = '22023', message = 'invalid:route';
  end if;
  perform private.assert_clean('reason', v_reason);
  update public.complaints
     set team = case when p_fraud or urgent then 'fraud' else p_team end,
         urgent = urgent or coalesce(p_fraud, false), ai_risk = p_risk,
         routed_by = 'ai', route_reason = nullif(v_reason, ''), updated_at = now()
   where ref = upper(trim(p_ref)) and routed_by = 'rules'
  returning * into c;
  if not found then return null; end if;
  insert into public.complaint_events (complaint_id, by_role, note)
  values (c.id, 'system', 'AI routed to ' || private.team_name(c.team) || ' (risk: ' || p_risk || ')'
                          || case when p_fraud then ', flagged as possible fraud' else '' end
                          || case when v_reason <> '' then '. ' || v_reason else '' end || '.');
  perform private.check_escalation(c.id);
  return json_build_object('team', c.team, 'level', (select level from public.complaints where id = c.id));
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
                       public.staff_update(uuid, text, text), public.staff_route(uuid, text),
                       public.ai_take(text, int), public.ai_route_get(text), public.ai_apply_route(text, text, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.lodge_complaint(jsonb), public.track_complaint(text, text), public.customer_reply(text, text, text)
  to anon, authenticated;
grant execute on function public.is_staff(), public.staff_list(), public.staff_get(uuid), public.reveal_contact(uuid),
                          public.staff_update(uuid, text, text), public.staff_route(uuid, text)
  to authenticated;
grant execute on function public.ai_take(text, int), public.ai_route_get(text), public.ai_apply_route(text, text, text, boolean, text)
  to service_role;
grant usage on schema private to postgres;

-- ---------------------------------------------------------------- data from before routing existed

update public.complaints set team = private.default_team(service, urgent), routed_by = 'rules',
       route_reason = 'Default team for this service'
 where team is null;

-- ---------------------------------------------------------------- scheduled escalations
-- Runs the escalation matrix every 10 minutes. If pg_cron isn't available, escalations
-- still run each time staff load the queue.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('gd-escalations', '*/10 * * * *', 'select private.run_escalations()');
exception when others then
  raise notice 'pg_cron not available (%). Escalations will run when staff open the queue.', sqlerrm;
end $$;

-- ---------------------------------------------------------------- adding staff
-- 1. Authentication -> Users -> Add user -> Create new user (tick "Auto Confirm User").
-- 2. Then run, with their email:
--      insert into public.staff (user_id) select id from auth.users where email = 'officer@yourbank.example';
-- To remove someone:
--      delete from public.staff where user_id = (select id from auth.users where email = 'officer@yourbank.example');
