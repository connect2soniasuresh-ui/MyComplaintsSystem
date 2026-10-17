-- Test complaints for demos. Run in Supabase: SQL Editor -> New query -> paste -> Run.
-- Run schema.sql first. Every test complaint uses a mobile number starting 90000000,
-- and every name starts with "Test", so they're easy to find and remove:
--
--   delete from public.complaints where mobile like '90000000%';
--
-- Complaints are backdated so the clocks and the escalation matrix have something to show:
-- new, urgent fraud, a long-running loan case, Day 22, Day 27, resolved, waiting for the customer,
-- and a customer complaining for the third time in 90 days.
-- With the 24-hour target, every open case backdated a day or more escalates to the
-- Internal Ombudsman / GM (open 20+ hours); the comments below give each case's original purpose.

-- Lodges a complaint through the real lodge function (so routing and checks apply),
-- then moves it and its history `days` into the past.
create or replace function pg_temp.seed(days int, p jsonb) returns uuid
language plpgsql as $$
declare v json; cid uuid;
begin
  v := public.lodge_complaint(p || '{"consent": true}'::jsonb);
  select id into cid from public.complaints where ref = v->>'ref';
  update public.complaints set created_at = created_at - make_interval(days => days),
                               updated_at = updated_at - make_interval(days => days),
                               consent_at = consent_at - make_interval(days => days)
   where id = cid;
  update public.complaint_events set at = at - make_interval(days => days) where complaint_id = cid;
  return cid;
end $$;

-- A bank update `days_ago` days ago (as a complaints officer would send it).
create or replace function pg_temp.bank(cid uuid, days_ago int, st text, note text) returns void
language plpgsql as $$
begin
  insert into public.complaint_events (complaint_id, at, by_role, status, note)
  values (cid, now() - make_interval(days => days_ago), 'bank', st, note);
  update public.complaints set status = st, updated_at = now() - make_interval(days => days_ago) where id = cid;
end $$;

do $$
declare c uuid;
begin
  -- 1. New UPI complaint, routed to Payments by rules.
  perform pg_temp.seed(1, '{"service":"pay","issue":"Debited but not credited to beneficiary","name":"Test Asha Rao","mobile":"9000000001",
    "txnDate":"2026-10-12","amount":"2500","txnRef":"UTR 412988301176","acct":"4821",
    "description":"On 12 October I paid Rs 2,500 by UPI to a grocery shop. The money left my account but the shopkeeper says he never received it.",
    "outcome":"Refund of Rs 2,500 to my savings account"}');

  -- 2. Card fraud above Rs 1 lakh: Fraud cell, escalated straight to the Principal Nodal Officer.
  perform pg_temp.seed(0, '{"service":"debit","issue":"Unauthorised transaction on debit card","name":"Test Ramesh Iyer","mobile":"9000000002",
    "txnDate":"2026-10-14","amount":"185000","acct":"7710",
    "description":"Three ATM withdrawals in another city took Rs 1,85,000 from my account last night. My card is with me and I did not make them. I have blocked the card in the app.",
    "outcome":"Reverse the fraudulent withdrawals"}');

  -- 3. Loan EMI debited twice, no action for 9 days: Team lead.
  perform pg_temp.seed(9, '{"service":"loan","issue":"EMI debited wrongly","name":"Test Priya Nair","mobile":"9000000003",
    "txnDate":"2026-10-05","amount":"18450","acct":"3302",
    "description":"My home loan EMI of Rs 18,450 was debited twice on 5 October. My account went negative and a cheque bounced because of it.",
    "outcome":"Refund the extra EMI and the cheque bounce charges"}');

  -- 4. Credit card billing dispute on Day 22, under review: Principal Nodal Officer.
  c := pg_temp.seed(22, '{"service":"credit","issue":"Billing dispute","name":"Test Imran Shaikh","mobile":"9000000004",
    "txnDate":"2026-09-18","amount":"12999","acct":"9021",
    "description":"My statement shows a charge of Rs 12,999 from an online electronics store. I cancelled the order the same day and the store confirmed the refund, but it has not reached my card.",
    "outcome":"Remove the charge and the interest on it"}');
  perform pg_temp.bank(c, 15, 'review', 'We have raised a chargeback with the merchant''s bank. We will update you when they respond.');

  -- 5. ATM cash not dispensed, Day 27: Internal Ombudsman / GM.
  perform pg_temp.seed(27, '{"service":"debit","issue":"Cash not dispensed but account debited","name":"Test Kavita Joshi","mobile":"9000000005",
    "txnDate":"2026-09-17","amount":"10000","txnRef":"RRN 726119004512","acct":"5567",
    "description":"I tried to withdraw Rs 10,000 from the ATM at Shivaji Nagar. No cash came out but my account was debited.",
    "outcome":"Credit back Rs 10,000 with compensation for the delay"}');

  -- 6. Locker access, resolved in 12 days.
  c := pg_temp.seed(18, '{"service":"locker","issue":"Cannot access locker","name":"Test Suresh Menon","mobile":"9000000006",
    "description":"The branch has refused me access to my locker for two weeks saying the key register is being audited. I need my documents urgently.",
    "outcome":"Access to my locker"}');
  perform pg_temp.bank(c, 14, 'review', 'We have spoken to the branch manager and asked for the audit to be completed this week.');
  perform pg_temp.bank(c, 6, 'resolved', 'The audit is complete and your locker is available. We apologise for the inconvenience. If you are not satisfied, you can approach the RBI Ombudsman.');

  -- 7. KYC update, waiting for the customer.
  c := pg_temp.seed(4, '{"service":"kyc","issue":"KYC update pending","name":"Test Meena Pillai","mobile":"9000000007",
    "description":"I submitted my new address proof at the branch a month ago but my KYC still shows pending in the app.",
    "outcome":"KYC updated with my new address"}');
  perform pg_temp.bank(c, 2, 'info', 'Please tell us the date you visited the branch and which branch it was, so we can trace your documents.');

  -- 8. Senior citizen access at a branch, new.
  perform pg_temp.seed(1, '{"service":"branch","issue":"Senior citizen or disability access","name":"Test Gopal Krishnan","mobile":"9000000008",
    "description":"I am 78 and use a walker. The branch moved the cash counter upstairs and there is no lift or help available. I had to go home without withdrawing my pension.",
    "outcome":"A ground-floor counter for senior citizens"}');

  -- 9 to 11. The same customer three times in 90 days: the third goes to the Principal Nodal Officer.
  c := pg_temp.seed(60, '{"service":"acct","issue":"Wrong charge or deduction","name":"Test Farah Khan","mobile":"9000000009",
    "amount":"590","description":"A minimum balance charge of Rs 590 was deducted although my balance was above the limit all month.",
    "outcome":"Refund of Rs 590"}');
  perform pg_temp.bank(c, 52, 'resolved', 'We have refunded the Rs 590 charge. It was applied in error.');
  c := pg_temp.seed(30, '{"service":"acct","issue":"Interest not credited","name":"Test Farah Khan","mobile":"9000000009",
    "description":"Interest for the last quarter has not been credited to my savings account.",
    "outcome":"Credit the interest"}');
  perform pg_temp.bank(c, 19, 'resolved', 'The quarterly interest has now been credited to your account.');
  perform pg_temp.seed(2, '{"service":"chq","issue":"Cheque not cleared","name":"Test Farah Khan","mobile":"9000000009",
    "amount":"45000","txnRef":"Cheque 004512",
    "description":"A cheque for Rs 45,000 deposited a week ago has still not been cleared. This is my third problem with my account in two months.",
    "outcome":"Clear the cheque today"}');

  -- 12. Filed under the wrong service: a "login problem" that is really a scam call.
  -- New complaints are re-routed by the AI Edge Function. Seeded ones can't be, so this
  -- applies a sample routing in the same way the AI would, marked as sample data.
  perform pg_temp.seed(0, '{"service":"digital","issue":"Cannot log in","name":"Test Anil Deshmukh","mobile":"9000000010",
    "amount":"42000",
    "description":"Someone called saying he was from the bank and needed to update my app. After that I could not log in, and Rs 42,000 has gone from my account.",
    "outcome":"Get my money back and unlock my account"}');
  perform public.ai_apply_route((select ref from public.complaints where mobile = '9000000010' order by created_at desc limit 1),
    'fraud', 'high', true, 'Sample data: caller posed as the bank, then money left the account. Likely vishing, not a login fault');
end $$;

-- Apply the escalation matrix to the backdated complaints now.
select private.run_escalations() as complaints_escalated;

select ref, name, private.team_name(team) as team, private.level_name(level) as level, status,
       floor(extract(epoch from now() - created_at) / 86400) as days_open
  from public.complaints where mobile like '90000000%' order by created_at;
