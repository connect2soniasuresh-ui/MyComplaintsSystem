"use strict";
/* Sangam Bank Grievance Desk — public site.
   Talks to Supabase through the checked functions in supabase/schema.sql.
   With no config it runs in demo mode: everything stays in this tab. */

const SERVICES = [
  {id:"acct", name:"Savings & current accounts", sub:"Charges, interest, freezes", issues:["Wrong charge or deduction","Interest not credited","Account frozen or blocked","Statement or passbook error","Account closure delayed"]},
  {id:"debit", name:"Debit cards & ATMs", sub:"Cash, card, ATM", issues:["Cash not dispensed but account debited","!Unauthorised transaction on debit card","Card blocked or not received","Excess ATM charges"]},
  {id:"credit", name:"Credit cards", sub:"Billing, disputes, fees", issues:["!Unauthorised transaction on credit card","Billing dispute","Late fee or interest dispute","Card closure not processed","Conduct of recovery agent"]},
  {id:"pay", name:"UPI, NEFT, IMPS & RTGS", sub:"Transfers and payments", issues:["Debited but not credited to beneficiary","Failed transaction, refund pending","!Money sent to wrong account","Transaction limit problem"]},
  {id:"digital", name:"Internet & mobile banking", sub:"Login, OTP, app errors", issues:["Cannot log in","OTP not received","App error during a transaction","!Phishing or fraud attempt"]},
  {id:"loan", name:"Loans", sub:"Home, personal, vehicle, gold", issues:["EMI debited wrongly","Interest rate not revised","Foreclosure or prepayment charges","Property documents or NOC not returned","Conduct of recovery agent"]},
  {id:"dep", name:"Fixed & recurring deposits", sub:"Maturity, interest", issues:["Maturity amount not credited","Wrong interest paid","Premature closure problem","TDS deducted wrongly"]},
  {id:"chq", name:"Cheques & drafts", sub:"Clearing, returns", issues:["Cheque not cleared","Cheque returned wrongly","Cheque book not received","Demand draft not issued"]},
  {id:"branch", name:"Branch service", sub:"Staff, queues, documents", issues:["Staff behaviour","Service refused or long wait","Documents not accepted","Senior citizen or disability access"]},
  {id:"third", name:"Insurance & investments", sub:"Sold through Sangam Bank", issues:["Product mis-sold","Policy not issued","Product added without consent","Redemption delayed"]},
  {id:"locker", name:"Safe deposit lockers", sub:"Allotment, rent, access", issues:["Allotment delayed","Rent dispute","Cannot access locker"]},
  {id:"kyc", name:"KYC, nomination & records", sub:"Updates and changes", issues:["KYC update pending","Nomination not registered","Name, address or mobile change pending"]},
];
const SVC = Object.fromEntries(SERVICES.map(s=>[s.id,s]));
const STATUS = {received:"Received", review:"Under review", info:"Waiting for you", resolved:"Resolved"};
// SLA: RBI's 30-day final-reply deadline. TARGET_H: the bank's own 24-hour resolution target, well inside it.
const SLA = 30, TARGET_H = 24, DAY = 864e5, HOUR = 36e5, IDLE_MS = 15*60*1000;
const TEAMS = {cards:"Cards & ATMs", payments:"Payments & UPI", digital:"Digital banking", loans:"Loans & recovery", accounts:"Accounts & deposits", branch:"Branch operations", wealth:"Insurance & investments", records:"KYC & records", fraud:"Fraud cell"};
const LEVELS = ["Complaints officer", "Team lead", "Principal Nodal Officer", "Internal Ombudsman / GM"];
const ROUTED_BY = {rules:"Rules", ai:"AI", staff:"Staff"};
const WHO = {bank:"Sangam Bank", customer:"Customer", system:"Routing & escalation"};

const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtDate = iso => new Date(iso).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"});
const fmtDT = iso => new Date(iso).toLocaleString("en-IN",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
const inr = n => n==null||n==="" ? "—" : "₹" + Number(n).toLocaleString("en-IN",{maximumFractionDigits:2});
const daysOpen = c => Math.floor(((c.status==="resolved" ? new Date(c.updatedAt) : new Date()) - new Date(c.createdAt))/DAY);
const isLate = c => c.status!=="resolved" && daysOpen(c) > SLA;
const hoursOpen = c => Math.floor(((c.status==="resolved" ? new Date(c.updatedAt) : new Date()) - new Date(c.createdAt))/HOUR);
const isOverdue = c => c.status!=="resolved" && hoursOpen(c) >= TARGET_H;
const dur = h => h < 48 ? `${h} hour${h===1?"":"s"}` : `${Math.floor(h/24)} days`;
const pill = s => `<span class="pill s-${esc(s)}">${esc(STATUS[s])}</span>`;
function clock(c){
  const d = daysOpen(c), h = hoursOpen(c);
  if (c.status==="resolved") return `<span class="clock">Closed in ${dur(h)}</span>`;
  if (isLate(c)) return `<span class="clock late">${d-SLA} day${d-SLA===1?"":"s"} past 30</span>`;
  return isOverdue(c) ? `<span class="clock late">Past 24h · Day ${d} of 30</span>` : `<span class="clock">${h}h of 24h</span>`;
}
function meter(c){
  const pct = c.status==="resolved" ? 100 : Math.min(100, hoursOpen(c)/TARGET_H*100);
  return `<div class="meter ${isOverdue(c)?"late":""}"><i style="width:${pct}%"></i></div>`;
}
function normMobile(m){
  const d = String(m||"").replace(/[\s-]/g,"").replace(/^(?:\+?91|0)(?=[6-9]\d{9}$)/,"");
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/* ---------- guardrails: confidential details ----------
   Same rules run again in the database (private.sensitive_kinds), so they can't be bypassed.
   Secrets (OTP, CVV, PIN, passwords) are removed outright.
   Identifiers (card, Aadhaar, PAN, account numbers) keep only their last 4 characters. */
const luhn = d => { let s=0, alt=false; for (let i=d.length-1;i>=0;i--){ let n=+d[i]; if(alt){n*=2;if(n>9)n-=9} s+=n; alt=!alt } return s%10===0; };
const GUARDS = [
  {kind:"an OTP",          secret:true, re:/\b(?:otp|one[- ]?time ?pass(?:word|code)?)\b\D{0,8}?(?<s>\d{4,8})\b/gi},
  {kind:"a CVV",           secret:true, re:/\b(?:cvv2?|cvc)\b\D{0,10}?(?<s>\d{3,4})\b/gi},
  {kind:"a PIN",           secret:true, re:/\b(?:atm |upi |card |m)?pin\b(?!\s*code)\D{0,10}?(?<s>\d{4,6})\b/gi},
  {kind:"a password",      secret:true, re:/\b(?:password|passcode|pwd)\b\s*(?:is|:|=|-)\s*(?<s>(?=\S*[\d@#$%!&*])\S{4,})/gi},
  {kind:"an Aadhaar number",            re:/\b(?:aadhaa?r|uidai?|uid)\b\D{0,15}?(?<s>[2-9]\d{3}[ -]?\d{4}[ -]?\d{4})\b/gi},
  {kind:"a full card number",           re:/(?<s>\b\d(?:[ -]?\d){12,18}\b)/g, test: s => luhn(s.replace(/\D/g,""))},
  {kind:"an Aadhaar number",            re:/(?<![\d][ -]?)(?<s>\b[2-9]\d{3} \d{4} \d{4}\b)(?![ -]?\d)/g},
  {kind:"a PAN",                        re:/(?<s>\b[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z]\b)/gi},
  {kind:"a full account number",        re:/\b(?:a\/c|acc(?:ount)?|acct)\.?(?:\s*(?:no\.?|number))?\s*(?:is|:|#|-)?\s*(?<s>\d{9,18})\b/gi},
];
const STAFF_ASK = /\b(?:share|send|tell|give|provide|confirm|enter|reply with|need)\b[^.?!\n]{0,40}\b(?:otp|pin|cvv|password|card number|aadhaa?r|pan)\b/i;
const keep4 = s => { const d = s.replace(/[^\dA-Z]/gi,""); return "•".repeat(Math.max(0,d.length-4)) + d.slice(-4); };

function scan(text, staff){
  const found = new Set();
  for (const g of GUARDS) for (const m of String(text||"").matchAll(g.re)) if (!g.test || g.test(m.groups.s)) found.add(g.kind);
  if (staff && STAFF_ASK.test(text)) found.add("a request for confidential details");
  return [...found];
}
function scrub(text){
  for (const g of GUARDS) text = text.replace(g.re, (...a) => {
    const full = a[0], s = a.at(-1).s;
    if (g.test && !g.test(s)) return full;
    return full.replace(s, g.secret ? "[removed]" : keep4(s));
  });
  return text;
}
const maskPhone = m => String(m||"").replace(/\d(?=(?:\D*\d){4})/g,"•");
const maskEmail = e => e ? e.replace(/^(.)[^@]*(@.*)$/, "$1•••$2") : "";
const listKinds = k => k.length < 2 ? k[0] : k.slice(0,-1).join(", ") + " and " + k.at(-1);

function updateGuard(el){
  const staff = el.hasAttribute("data-staff");
  const kinds = scan(el.value, staff);
  let box = el.nextElementSibling?.classList.contains("guard") ? el.nextElementSibling : null;
  el.classList.toggle("flagged", kinds.length > 0);
  el.setAttribute("aria-invalid", String(kinds.length > 0));
  if (!kinds.length){ box?.remove(); return false; }
  if (!box){ box = document.createElement("div"); box.className = "guard"; box.setAttribute("role","alert"); el.after(box); }
  const asksOnly = kinds.length === 1 && kinds[0].startsWith("a request");
  box.innerHTML = staff
    ? `<span><b>This message contains ${esc(listKinds(kinds))}.</b> Staff must never ask for or repeat OTPs, PINs, CVVs, passwords or full card, account or Aadhaar numbers.${asksOnly ? " Rephrase the message." : ""}</span>${asksOnly ? "" : `<button type="button" data-scrub>Remove them for me</button>`}`
    : `<span><b>This looks like ${esc(listKinds(kinds))}.</b> Sangam Bank never needs it here, and the complaint can't be sent with it.</span><button type="button" data-scrub>Remove it for me</button>`;
  return true;
}
let guardTimer;
document.addEventListener("input", e => {
  if (!e.target.matches("[data-scan]")) return;
  clearTimeout(guardTimer); guardTimer = setTimeout(() => updateGuard(e.target), 250);
});
document.addEventListener("click", e => {
  if (!e.target.matches("[data-scrub]")) return;
  const el = e.target.closest(".guard").previousElementSibling;
  el.value = scrub(el.value); updateGuard(el); el.focus();
});
function blockedField(root){
  let first = null;
  root.querySelectorAll("[data-scan]").forEach(el => { if (updateGuard(el) && !first) first = el; });
  return first;
}

/* ---------- data layer ---------- */
const CFG = window.GD_CONFIG || {};
// ?demo forces demo mode on the live site, so reviewers can walk through every screen without touching real data.
const FORCED_DEMO = new URLSearchParams(location.search).has("demo");
const LIVE = !FORCED_DEMO && !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
const sb = LIVE ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
  auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
}) : null;
async function rpc(name, args){ const {data, error} = await sb.rpc(name, args); if (error) throw error; return data; }

const API = LIVE ? {
  lodge:  c => rpc("lodge_complaint", {p: c}),
  track:  (ref, mobile) => rpc("track_complaint", {p_ref: ref, p_mobile: mobile}),
  reply:  (ref, mobile, note) => rpc("customer_reply", {p_ref: ref, p_mobile: mobile, p_note: note}),
  signIn: async (email, password) => { const {error} = await sb.auth.signInWithPassword({email, password}); if (error) throw error; },
  signOut: () => sb.auth.signOut(),
  session: async () => (await sb.auth.getSession()).data.session,
  isStaff: () => rpc("is_staff"),
  list:   () => rpc("staff_list"),
  get:    id => rpc("staff_get", {p_id: id}),
  reveal: id => rpc("reveal_contact", {p_id: id}),
  update: (id, status, note) => rpc("staff_update", {p_id: id, p_status: status, p_note: note}),
  route:  (id, team) => rpc("staff_route", {p_id: id, p_team: team}),
  aiChat: messages => ai({action: "chat", messages}),
  aiRoute: ref => ai({action: "route", ref}),
} : DemoAPI();

// The AI Edge Function (supabase/functions/ai; its name is set in config.js). Errors come back as {code:"ai", message}.
async function ai(body){
  const {data, error} = await sb.functions.invoke(CFG.aiFunction || "ai", {body});
  if (!error) return data;
  let detail = null; try { detail = await error.context.json(); } catch(e){}
  throw {code: "ai", message: detail?.error || "unavailable", kinds: detail?.kinds};
}

function DemoAPI(){
  const rows = []; let signed = false;
  const now = () => new Date().toISOString();
  const ref = (d = new Date()) => { const p = n=>String(n).padStart(2,"0"), A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    return `GD-${String(d.getFullYear()).slice(2)}${p(d.getMonth()+1)}${p(d.getDate())}-` + Array.from(crypto.getRandomValues(new Uint8Array(8)), b => A[b%31]).join(""); };
  const view = r => ({ref:r.ref, createdAt:r.createdAt, updatedAt:r.updatedAt, service:r.service, issue:r.issue, urgent:r.urgent, status:r.status, amount:r.amount, description:r.description, history:r.history.filter(h => h.by !== "system")});
  const find = (rf, m) => rows.find(r => r.ref === String(rf).trim().toUpperCase() && r.mobile === normMobile(m));
  const clean = (t, field, staff) => { const k = scan(t, staff); if (k.length) throw {code:"22023", message:`sensitive:${field}:${k.join(", ")}`}; };
  const get = async id => { const r = rows.find(x => x.id === id);
    return {...view(r), id:r.id, acct:r.acct, txnDate:r.txnDate, txnRef:r.txnRef, outcome:r.outcome, name:r.name, mobile:maskPhone(r.mobile), email:maskEmail(r.email), contactViews:r.views,
      team:r.team, level:r.level, routedBy:r.routedBy, routeReason:r.routeReason, aiRisk:null, history:r.history}; };
  // Same rules as private.default_team and private.escalation_target in schema.sql.
  const defaultTeam = (svc, urgent) => urgent ? "fraud" : ({acct:"accounts", debit:"cards", credit:"cards", pay:"payments", digital:"digital", loan:"loans", dep:"accounts", chq:"accounts", branch:"branch", third:"wealth", locker:"branch", kyc:"records"})[svc] || "branch";
  const escalate = r => {
    if (r.status === "resolved") return;
    const hrs = Math.floor((Date.now() - Date.parse(r.createdAt)) / HOUR);
    const lastAt = Math.max(...r.history.filter(h => h.by !== "system").map(h => Date.parse(h.at)));
    const repeats = rows.filter(o => o !== r && o.mobile === r.mobile && Date.parse(o.createdAt) <= Date.parse(r.createdAt) && Date.parse(o.createdAt) > Date.parse(r.createdAt) - 90*DAY).length;
    const [lvl, why] = hrs >= 20 ? [3, `Open ${dur(hrs)} against the 24-hour target`] : hrs >= 12 ? [2, `Open ${dur(hrs)} against the 24-hour target`]
      : r.urgent && Number(r.amount) >= 100000 ? [2, "Suspected fraud of ₹1 lakh or more"] : repeats >= 2 ? [2, "Third complaint from this customer in 90 days"]
      : r.urgent ? [1, "Fraud complaint"] : lastAt < Date.now() - 4*HOUR ? [1, "No action for 4 hours"] : [0, ""];
    if (lvl > r.level){ r.level = lvl; r.history.push({at:now(), by:"system", status:null, note:`Escalated to ${LEVELS[lvl]}: ${why}.`}); }
  };
  // Sample cases (backdated) so the staff queue, escalations and monthly report have something to show.
  [[0.25,"pay","Debited but not credited to beneficiary",2500,"received","Priya Nair","9000000001","Paid ₹2,500 by UPI to a grocery shop. Money left my account but the shop says it never arrived."],
   [3,"debit","Unauthorised transaction on debit card",145000,"review","Ramesh Patil","9000000002","Three transactions I never made appeared on my debit card overnight. I have blocked the card."],
   [9,"loan","EMI debited wrongly",18400,"review","Sunita Deshmukh","9000000003","My home loan EMI was debited twice this month."],
   [22,"acct","Wrong charge or deduction",590,"review","Mohammed Shaikh","9000000004","A minimum balance charge was deducted although my balance never went below the limit."],
   [27,"chq","Cheque not cleared",42000,"info","Anita Kulkarni","9000000005","A cheque I deposited at the Kothrud branch has not been credited after two weeks."],
   [12,"locker","Rent dispute",3500,"resolved","Vijay Joshi","9000000006","Locker rent was charged twice for the same year."],
   [40,"digital","Cannot log in",null,"resolved","Kavita Rao","9000000007","The mobile app says my account is locked every time I log in."],
   [33,"credit","Billing dispute",7800,"review","Farah Khan","9000000009","My credit card bill shows a hotel booking of ₹7,800 that was cancelled and refunded by the hotel."],
   [0.08,"kyc","Name, address or mobile change pending",null,"received","Arjun Mehta","9000000008","I submitted my new address at the branch a month ago but it still shows the old one."],
  ].forEach(([age, service, issue, amount, status, name, mobile, description], i) => {
    const at = d => new Date(Date.now() - d*DAY).toISOString(), t = at(age), urgent = /^unauthorised/i.test(issue), team = defaultTeam(service, urgent);
    const r = {service, issue, amount, description, name, mobile, acct:"", txnDate:t.slice(0,10), txnRef:"", outcome:"", email:"", id:crypto.randomUUID(), ref:ref(new Date(t)), views:0, urgent,
      team, level:0, routedBy:"rules", routeReason:"Default team for this service", createdAt:t, updatedAt:t, status,
      history:[{at:t, by:"customer", status:"received", note:"Complaint lodged."}, {at:t, by:"system", status:null, note:`Routed to ${TEAMS[team]} by rules.`}]};
    if (status !== "received"){ const u = at(Math.max(0, age - (status === "resolved" ? (service === "locker" ? 0.5 : Math.min(age, 6 + i)) : Math.min(age / 2, 2))));
      r.history.push({at:u, by:"bank", status, note: status === "resolved" ? "We have refunded the amount to your account." : status === "info" ? "Please tell us the cheque number and date." : "We are looking into this with the team concerned."});
      r.updatedAt = u; }
    rows.push(r);
  });
  rows.forEach(escalate);

  return {
    async lodge(c){
      ["description","outcome","txnRef","name"].forEach(f => clean(c[f], f));
      const t = now(), urgent = /^(unauthorised transaction|money sent to wrong account|phishing or fraud attempt)/i.test(c.issue), team = defaultTeam(c.service, urgent);
      const r = {...c, id:crypto.randomUUID(), ref:ref(), mobile:normMobile(c.mobile), views:0, urgent,
        team, level:0, routedBy:"rules", routeReason:"Default team for this service",
        createdAt:t, updatedAt:t, status:"received", history:[{at:t, by:"customer", status:"received", note:"Complaint lodged."}, {at:t, by:"system", status:null, note:`Routed to ${TEAMS[team]} by rules.`}]};
      rows.push(r); escalate(r); return view(r);
    },
    async track(rf, m){ const r = find(rf, m); return r ? view(r) : null; },
    async reply(rf, m, note){
      const r = find(rf, m); if (!r) return null;
      if (r.status !== "info") throw {code:"22023", message:"not_waiting"};
      clean(note, "note"); const t = now();
      r.history.push({at:t, by:"customer", status:"review", note}); r.status = "review"; r.updatedAt = t; return view(r);
    },
    async signIn(){ signed = true; }, async signOut(){ signed = false; },
    async session(){ return signed ? {user:{email:"demo staff"}} : null; },
    async isStaff(){ return signed; },
    async list(){ rows.forEach(escalate); return rows.map(r => ({id:r.id, ref:r.ref, createdAt:r.createdAt, updatedAt:r.updatedAt, service:r.service, issue:r.issue, urgent:r.urgent, amount:r.amount, status:r.status, team:r.team, level:r.level, routedBy:r.routedBy, name:r.name, mobile:maskPhone(r.mobile)})); },
    get,
    async route(id, team){
      const r = rows.find(x => x.id === id);
      if (r.team !== team){ r.team = team; r.routedBy = "staff"; r.routeReason = "Re-routed by staff"; r.history.push({at:now(), by:"system", status:null, note:`Re-routed to ${TEAMS[team]} by staff.`}); }
      return get(id);
    },
    async aiChat(){ throw {code:"ai", message:"demo"}; },
    async aiRoute(){ return {skipped:true}; },
    async reveal(id){ const r = rows.find(x => x.id === id); r.views++; return {mobile:r.mobile, email:r.email}; },
    async update(id, status, note){
      clean(note, "note", true); const r = rows.find(x => x.id === id), t = now();
      r.history.push({at:t, by:"bank", status, note}); r.status = status; r.updatedAt = t; return get(id);
    },
  };
}

const FIELD = {description:"problem description", outcome:"“What would put this right” box", txnRef:"transaction reference", name:"name", issue:"issue", note:"message"};
function errText(e){
  const m = String(e?.message || "");
  if (m.startsWith("sensitive:")){ const [, f, ...k] = m.split(":"); return `The ${FIELD[f] || "text"} contains ${k.join(":")}. Remove it and try again.`; }
  if (m === "locked") return "Too many tries with the wrong mobile number. For your security, tracking for this reference is paused for an hour.";
  if (m === "consent_required") return "Tick the confirmation box to submit.";
  if (m === "invalid:mobile") return "Enter a valid 10-digit mobile number.";
  if (m === "not_waiting") return "Sangam Bank isn't waiting for a reply on this complaint any more. Search again to see its latest status.";
  if (m === "not_staff" || e?.code === "42501") return "This account isn't on the staff list. Ask your administrator to add you.";
  if (/invalid login credentials/i.test(m)) return "The email or password is wrong.";
  if (e?.code === "23514" || e?.code === "22P02" || e?.code === "22007") return "Some details weren't accepted. Check the form and try again.";
  if (e instanceof TypeError || /fetch|network/i.test(m)) return "Couldn't reach the server. Check your connection and try again.";
  return "Something went wrong. Try again in a minute.";
}

/* ---------- tabs (hash routing so #track and #staff can be linked) ---------- */
const TABS = ["lodge","track","staff"];
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => { location.hash = b.dataset.tab === "lodge" ? "" : b.dataset.tab; setTab(b.dataset.tab); }));
window.addEventListener("hashchange", () => setTab(location.hash.slice(1) || "lodge"));
function setTab(t){
  if (!TABS.includes(t)) t = "lodge";
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab===t)));
  TABS.forEach(v => $("#view-"+v).hidden = v!==t);
  if (t === "staff") staffEnter();
}

/* ---------- lodge ---------- */
$("#svcGrid").innerHTML = SERVICES.map(s => `
  <div class="svc"><input type="radio" name="svc" id="svc-${s.id}" value="${s.id}"><label for="svc-${s.id}">${esc(s.name)}<span>${esc(s.sub)}</span></label></div>`).join("");
$("#svcGrid").addEventListener("change", e => {
  const s = SVC[e.target.value];
  $("#f-issue").innerHTML = `<option value="">Choose the issue</option>` + s.issues.map(i => `<option value="${esc(i)}">${esc(i.replace(/^!/,""))}</option>`).join("");
  $("#fraudNote").hidden = true;
});
$("#f-issue").addEventListener("change", e => $("#fraudNote").hidden = !e.target.value.startsWith("!"));

$("#f-acct").addEventListener("input", e => {
  const d = e.target.value.replace(/\D/g,""), hint = $("#acctHint");
  if (d.length > 4){ e.target.value = d.slice(-4); hint.textContent = "We kept only the last 4 digits. Never enter your full number."; hint.className = "hint note-ok"; }
  else { e.target.value = d; if (!d.length){ hint.textContent = "Only the last 4 digits"; hint.className = "hint"; } }
});

$("#form").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#formErr"); err.textContent = "";
  const svc = document.querySelector('input[name="svc"]:checked')?.value;
  const issueRaw = $("#f-issue").value, acct = $("#f-acct").value.trim(), mobile = $("#f-mobile").value;
  const problems = [];
  if (!svc) problems.push("choose a service");
  if (!issueRaw) problems.push("choose the issue");
  if (acct && !/^\d{4}$/.test(acct)) problems.push("enter exactly 4 digits for the account or card");
  if ($("#f-desc").value.trim().length < 20) problems.push("describe the problem in at least 20 characters");
  if (!/^[\p{L} .'-]{2,80}$/u.test($("#f-name").value.trim())) problems.push("enter your name using letters only");
  if (!normMobile(mobile)) problems.push("enter a valid 10-digit mobile number");
  const em = $("#f-email").value.trim();
  if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) problems.push("check the email address");
  if (!$("#f-consent").checked) problems.push("tick the confirmation box");
  const flagged = blockedField($("#form"));
  if (flagged){ err.textContent = "Remove the confidential details flagged in red before submitting."; flagged.focus(); return; }
  if (problems.length){ err.textContent = "To submit, " + problems.join(", ") + "."; return; }

  const payload = {
    service: svc, issue: issueRaw.replace(/^!/,""), acct, txnDate: $("#f-date").value,
    amount: $("#f-amt").value, txnRef: $("#f-txn").value.trim(), description: $("#f-desc").value.trim(),
    outcome: $("#f-want").value.trim(), name: $("#f-name").value.trim(), mobile, email: em, consent: true,
  };
  const btn = $("#submitBtn"); btn.disabled = true; btn.textContent = "Submitting…";
  try {
    const c = await API.lodge(payload);
    API.aiRoute(c.ref).catch(() => {});   // AI re-routing in the background; rule-based routing already applies
    rememberRef(c.ref);
    showReceipt(c, mobile);
    resetChat(); $("#draftNote").hidden = true;
    $("#form").reset(); $("#acctHint").textContent = "Only the last 4 digits"; $("#acctHint").className = "hint";
    $("#f-issue").innerHTML = `<option value="">Choose a service first</option>`; $("#fraudNote").hidden = true;
  } catch(ex) { err.textContent = errText(ex); }
  finally { btn.disabled = false; btn.textContent = "Submit complaint"; }
});

function showReceipt(c, mobile){
  $("#lodgeWrap").hidden = true;
  const r = $("#receipt"); r.hidden = false;
  r.innerHTML = `<div class="receipt">
    <p class="label">Complaint received · ${esc(fmtDT(c.createdAt))}</p>
    <div class="ref">${esc(c.ref)}</div>
    <p style="margin:0">Write this reference number down. You'll need it and your mobile number to track the complaint. We aim to resolve it within <strong>24 hours</strong>, and you'll have our final reply by <strong>${esc(fmtDate(new Date(Date.parse(c.createdAt)+SLA*DAY).toISOString()))}</strong> at the latest.</p>
    ${c.urgent ? `<div class="alert bad"><strong>Marked urgent</strong>Unauthorised-transaction complaints go to the fraud team first.</div>` : ""}
    <div class="actions"><button class="btn" id="goTrack" type="button">Track this complaint</button><button class="btn ghost" id="another" type="button">Lodge another</button></div>
  </div>`;
  $("#goTrack").onclick = () => { resetLodge(); $("#t-ref").value = c.ref; $("#t-mobile").value = mobile; location.hash = "track"; setTab("track"); doTrack(); };
  $("#another").onclick = resetLodge;
  r.scrollIntoView({block:"start"});
}
function resetLodge(){ $("#receipt").hidden = true; $("#lodgeWrap").hidden = false; }

/* ---------- AI complaint assistant ----------
   The conversation goes to the "ai" Edge Function, which returns a draft for the form.
   Contact details never go through the chat: the customer types them into the form. */
const GREETING = "Hello! Tell me what went wrong, in your own words. For example, which service it's about, what happened and when. I'll ask a few questions and fill in the complaint form for you.";
const chat = { msgs: [], draft: null, busy: false };
$("#assistCta").hidden = !LIVE;   // needs the Edge Function, so not in demo mode
$("#openChat").onclick = () => openChat();
$("#chatToForm").onclick = () => closeChat();
function openChat(){
  $("#assistCta").hidden = true; $("#form").hidden = true; $("#draftNote").hidden = true; $("#chatPanel").hidden = false;
  if (!chat.msgs.length) renderChat();
  $("#chatText").focus();
}
function closeChat(){ $("#chatPanel").hidden = true; $("#form").hidden = false; $("#assistCta").hidden = !LIVE; }
function resetChat(){ chat.msgs = []; chat.draft = null; $("#chatLog").innerHTML = ""; closeChat(); }
function renderChat(){
  const log = $("#chatLog");
  log.innerHTML = `<div class="msg bot">${esc(GREETING)}</div>` +
    chat.msgs.map(m => `<div class="msg ${m.role === "user" ? "me" : "bot"}">${esc(m.content)}</div>`).join("") +
    (chat.busy ? `<div class="msg bot typing">Thinking…</div>` : "") +
    (chat.draft && !chat.busy ? draftCard(chat.draft) : "");
  const use = $("#useDraft"); if (use) use.onclick = () => applyDraft(chat.draft);
  log.scrollTop = log.scrollHeight;
}
function draftCard(d){
  const kv = [["Service", SVC[d.service]?.name], ["Issue", d.issue.replace(/^!/,"")], ["What happened", d.description],
    ["Transaction date", d.txnDate ? fmtDate(d.txnDate) : ""], ["Amount", d.amount ? inr(d.amount) : ""], ["Transaction ref.", d.txnRef],
    ["Account or card", d.acctLast4 ? "•••• " + d.acctLast4 : ""], ["What would put it right", d.outcome]].filter(([, v]) => v);
  return `<div class="draft"><p class="label" style="margin:0">Your complaint so far</p>
    <dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <div class="actions"><button class="btn" type="button" id="useDraft">Use these details</button><span class="muted" style="font-size:12.5px">You can still change anything on the form.</span></div></div>`;
}
$("#chatForm").addEventListener("submit", async e => {
  e.preventDefault();
  const ta = $("#chatText"), err = $("#chatErr"), text = ta.value.trim(); err.textContent = "";
  if (!text || chat.busy) return;
  if (updateGuard(ta)){ err.textContent = "Remove the confidential details flagged in red. They weren't sent."; ta.focus(); return; }
  chat.msgs.push({role: "user", content: text}); ta.value = ""; chat.busy = true; $("#chatSend").disabled = true; renderChat();
  try {
    const r = await API.aiChat(chat.msgs);
    chat.msgs.push({role: "assistant", content: r.reply});
    chat.draft = r.ready ? r.draft : null;
  } catch(ex){
    chat.msgs.pop(); ta.value = text;   // nothing was saved; let them edit and resend
    err.textContent = ex?.message === "sensitive" ? `That message contains ${listKinds(ex.kinds || ["confidential details"])}. Remove it and send again.`
      : ex?.message === "rate_limited" ? "Too many messages for now. Please use the form below, or try again in an hour."
      : "The assistant isn't available right now. Please fill in the form instead.";
    if (ex?.message !== "sensitive") $("#chatToForm").focus();
  } finally { chat.busy = false; $("#chatSend").disabled = false; renderChat(); }
  if (chat.msgs.length >= 22 && !chat.draft) err.textContent = "This chat is getting long. Fill in the form for the rest.";
});
$("#chatText").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); $("#chatForm").requestSubmit(); } });

function applyDraft(d){
  const radio = $(`#svc-${d.service}`); if (!radio) return;
  radio.checked = true; radio.dispatchEvent(new Event("change", {bubbles: true}));
  $("#f-issue").value = d.issue; $("#fraudNote").hidden = !d.issue.startsWith("!");
  $("#f-acct").value = d.acctLast4 || ""; $("#f-date").value = d.txnDate || ""; $("#f-amt").value = d.amount || "";
  $("#f-txn").value = d.txnRef || ""; $("#f-desc").value = d.description || ""; $("#f-want").value = d.outcome || "";
  closeChat(); $("#assistCta").hidden = true; $("#draftNote").hidden = false;
  $("#form").querySelectorAll("[data-scan]").forEach(updateGuard);
  $("#f-name").scrollIntoView({block: "center"}); $("#f-name").focus({preventScroll: true});
}

/* refs only (never mobile numbers) are remembered on this device for convenience */
function deviceRefs(){ try { return JSON.parse(localStorage.getItem("gd-refs") || "[]"); } catch(e){ return []; } }
function rememberRef(ref){ try { localStorage.setItem("gd-refs", JSON.stringify([ref, ...deviceRefs().filter(r => r!==ref)].slice(0,10))); } catch(e){} renderDeviceRefs(); }
function renderDeviceRefs(){
  const refs = deviceRefs(), box = $("#deviceRefs");
  box.hidden = !refs.length;
  box.innerHTML = `<span class="muted">Lodged on this device:</span>` + refs.map(r => `<button class="chip" type="button" data-ref="${esc(r)}">${esc(r)}</button>`).join("") +
    ` <button class="reveal" type="button" id="forgetRefs">Forget these</button>`;
  box.querySelectorAll("[data-ref]").forEach(b => b.onclick = () => { $("#t-ref").value = b.dataset.ref; $("#t-mobile").focus(); });
  const f = $("#forgetRefs"); if (f) f.onclick = () => { try { localStorage.removeItem("gd-refs"); } catch(e){} renderDeviceRefs(); };
}

/* ---------- track ---------- */
let tracked = null; // {ref, mobile, c}
$("#trackForm").addEventListener("submit", e => { e.preventDefault(); doTrack(); });
async function doTrack(){
  const err = $("#trackErr"); err.textContent = "";
  const ref = $("#t-ref").value.trim().toUpperCase(), mobile = $("#t-mobile").value;
  if (!/^GD-\d{6}-[A-Z0-9]{4,8}$/.test(ref)){ err.textContent = "Enter the reference number exactly as shown on your receipt, for example GD-261004-K7QZ8M2P."; return; }
  if (!normMobile(mobile)){ err.textContent = "Enter the 10-digit mobile number you gave when lodging."; return; }
  const btn = $("#trackBtn"); btn.disabled = true;
  try {
    const c = await API.track(ref, mobile);
    if (!c){ tracked = null; $("#trackResult").innerHTML = ""; err.textContent = "No complaint matches that reference number and mobile number. Check both and try again."; return; }
    tracked = {ref, mobile, c}; renderTracked();
  } catch(ex){ err.textContent = errText(ex); }
  finally { btn.disabled = false; }
}
function renderTracked(){
  const box = $("#trackResult");
  if (!tracked){ box.innerHTML = ""; return; }
  const c = tracked.c, st = c.status;
  const steps = [["Received", true, false], [st==="info" ? "Waiting for you" : "Under review", st!=="received", st==="info"], ["Resolved", st==="resolved", false]];
  box.innerHTML = `<div class="list"><article class="card">
    <div class="card-head">
      <div><span class="ref">${esc(c.ref)}</span> ${c.urgent?'<span class="urgent">· Urgent</span>':""}<h3 style="margin-top:4px">${esc(SVC[c.service]?.name)}: ${esc(c.issue)}</h3></div>
      <div style="display:flex;gap:10px;align-items:center">${clock(c)} ${pill(st)}</div>
    </div>
    <div class="track">${steps.map(([t,done,wait])=>`<div class="${wait?"wait":done?"done":""}">${t}</div>`).join("")}</div>
    <ul class="hist">${c.history.map(h=>`<li><time>${esc(fmtDT(h.at))}</time><div><span class="who">${h.by==="bank"?"Sangam Bank":"You"}</span>${h.status&&h.by==="bank"?` · ${esc(STATUS[h.status])}`:""}<p>${esc(h.note)}</p></div></li>`).join("")}</ul>
    ${st==="info" ? `<div class="field"><label for="reply">Your reply</label><textarea id="reply" maxlength="2000" data-scan placeholder="Answer Sangam Bank's question here"></textarea><div class="actions"><button class="btn" id="replyBtn" type="button">Send reply</button><span class="err" id="replyErr" role="alert"></span></div></div>` : ""}
    ${(isLate(c) || st==="resolved") ? `<div class="alert info"><strong>Not satisfied?</strong>${isLate(c)?"We haven't replied within 30 days.":"If you disagree with our reply,"} You can complain to the RBI Ombudsman online at <span class="mono">cms.rbi.org.in</span> or call 14448. Quote ${esc(c.ref)}.</div>` : ""}
  </article></div>`;
  const rb = $("#replyBtn");
  if (rb) rb.onclick = async () => {
    const ta = $("#reply"), note = ta.value.trim(), re = $("#replyErr"); re.textContent = "";
    if (!note){ re.textContent = "Write a reply before sending."; return; }
    if (updateGuard(ta)){ re.textContent = "Remove the confidential details flagged in red before sending."; ta.focus(); return; }
    rb.disabled = true;
    try { const c2 = await API.reply(tracked.ref, tracked.mobile, note); if (c2){ tracked.c = c2; renderTracked(); } }
    catch(ex){ re.textContent = errText(ex); rb.disabled = false; }
  };
}

/* ---------- staff ---------- */
const S = { rows: [], email: "" };
let idleTimer, pollTimer;
async function staffEnter(){
  const session = await API.session().catch(() => null);
  if (!session){ showSignin(); return; }
  const ok = await API.isStaff().catch(() => false);
  if (!ok){ await API.signOut(); showSignin("This account isn't on the staff list. Ask your administrator to add you."); return; }
  S.email = session.user?.email || "";
  $("#staffSignin").hidden = true; $("#staffQueue").hidden = false;
  $("#staffWho").textContent = `Signed in as ${S.email}. You'll be signed out after 15 minutes without activity.`;
  armIdle(); loadQueue();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!$("#view-staff").hidden && !$("#dlg").open) loadQueue(); }, 60000);
}
function showSignin(msg){
  $("#staffQueue").hidden = true; $("#staffSignin").hidden = false;
  $("#queueCount").hidden = true; clearInterval(pollTimer); clearTimeout(idleTimer);
  $("#signinErr").textContent = msg || "";
  if (!LIVE) $("#signinErr").textContent = msg || "Demo mode: any email and password signs you in.";
}
$("#signinForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#signinBtn"), err = $("#signinErr"); err.textContent = "";
  const email = $("#s-email").value.trim(), pass = $("#s-pass").value;
  if (LIVE && (!email || !pass)){ err.textContent = "Enter your work email and password."; return; }
  btn.disabled = true;
  try { await API.signIn(email, pass); $("#s-pass").value = ""; await staffEnter(); }
  catch(ex){ err.textContent = errText(ex); }
  finally { btn.disabled = false; }
});
async function signOut(msg){
  if ($("#dlg").open) $("#dlg").close();
  S.rows = []; $("#queueBody").innerHTML = ""; await API.signOut().catch(() => {}); showSignin(msg);
}
$("#signoutBtn").onclick = () => signOut("You've signed out.");
$("#refreshBtn").onclick = () => loadQueue();
function armIdle(){
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => signOut("You were signed out after 15 minutes without activity."), IDLE_MS);
}
["pointerdown","keydown"].forEach(ev => document.addEventListener(ev, () => { if (!$("#staffQueue").hidden) armIdle(); }, {passive:true}));

async function loadQueue(){
  if (!S.rows.length) $("#queueBody").innerHTML = `<p class="loading">Loading complaints…</p>`;
  try { S.rows = await API.list() || []; renderQueue(); }
  catch(ex){
    if (ex?.code === "42501" || ex?.message === "not_staff") return signOut(errText(ex));
    $("#queueBody").innerHTML = `<div class="alert bad">${esc(errText(ex))}</div>`;
  }
}

$("#fStatus").innerHTML = `<option value="">All statuses</option><option value="open">All open</option>` + Object.entries(STATUS).map(([k,v])=>`<option value="${k}">${v}</option>`).join("");
$("#fSvc").innerHTML = `<option value="">All services</option>` + SERVICES.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join("");
$("#fTeam").innerHTML = `<option value="">All teams</option>` + Object.entries(TEAMS).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join("");
["#q","#fStatus","#fSvc","#fTeam"].forEach(s => $(s).addEventListener("input", renderQueue));
const lvlBadge = l => l > 0 ? `<span class="lvl l${l}">↑ ${esc(LEVELS[l])}</span>` : "";
const teamLine = c => `<span class="team">${esc(TEAMS[c.team] || "Unrouted")}${c.routedBy ? `<span class="by">${esc(ROUTED_BY[c.routedBy] || c.routedBy)}</span>` : ""}</span>`;

function renderQueue(){
  const rows = S.rows, open = rows.filter(c => c.status!=="resolved"), month = new Date().toISOString().slice(0,7);
  $("#queueCount").hidden = false; $("#queueCount").textContent = open.length;
  $("#tiles").innerHTML = [
    ["Open", open.length, false],
    ["Urgent and open", open.filter(c=>c.urgent).length, open.some(c=>c.urgent)],
    ["Escalated", open.filter(c=>c.level>0).length, open.some(c=>c.level>=2)],
    ["Past 24-hour target", open.filter(isOverdue).length, open.some(isOverdue)],
    ["Past 30 days", open.filter(isLate).length, open.some(isLate)],
    ["Resolved this month", rows.filter(c=>c.status==="resolved"&&c.updatedAt.startsWith(month)).length, false],
  ].map(([l,n,a])=>`<div class="tile ${a?"alarm":""}"><span class="label">${l}</span><span class="n">${n}</span></div>`).join("");

  const q = $("#q").value.trim().toLowerCase(), fs = $("#fStatus").value, fv = $("#fSvc").value, ft = $("#fTeam").value;
  const shown = rows.filter(c =>
    (!fs || (fs==="open" ? c.status!=="resolved" : c.status===fs)) && (!fv || c.service===fv) && (!ft || c.team===ft) &&
    (!q || `${c.ref} ${c.name}`.toLowerCase().includes(q))
  ).sort((a,b) => ((a.status==="resolved") - (b.status==="resolved")) || (b.urgent - a.urgent) || ((b.level||0) - (a.level||0)) || a.createdAt.localeCompare(b.createdAt));

  const body = $("#queueBody");
  if (!rows.length){ body.innerHTML = `<div class="empty"><h3>The queue is empty</h3><p>New complaints appear here when customers submit them, most urgent and oldest first.</p></div>`; return; }
  if (!shown.length){ body.innerHTML = `<div class="empty"><h3>No complaints match</h3><p>Clear the search or filters to see the full queue.</p></div>`; return; }
  body.innerHTML = `<div class="tablebox"><table><thead><tr><th>Reference</th><th>Customer</th><th>Service and issue</th><th>Team and level</th><th style="text-align:right">Amount</th><th>Clock (24h target)</th><th>Status</th></tr></thead><tbody>` +
    shown.map(c => `<tr data-id="${esc(c.id)}" tabindex="0">
      <td><span class="ref">${esc(c.ref)}</span><br><span class="muted" style="font-size:12px">${esc(fmtDate(c.createdAt))}</span></td>
      <td>${esc(c.name)}<br><span class="muted mono" style="font-size:12px">${esc(c.mobile)}</span></td>
      <td>${c.urgent?'<span class="urgent">Urgent · </span>':""}${esc(SVC[c.service]?.name)}<br><span class="muted">${esc(c.issue)}</span></td>
      <td>${teamLine(c)}${c.level > 0 ? "<br>" + lvlBadge(c.level) : ""}</td>
      <td class="num">${inr(c.amount)}</td>
      <td>${clock(c)}${meter(c)}</td>
      <td>${pill(c.status)}</td></tr>`).join("") + `</tbody></table></div>`;
  body.querySelectorAll("tbody tr").forEach(tr => {
    const go = () => openDetail(tr.dataset.id);
    tr.onclick = go; tr.onkeydown = e => { if (e.key==="Enter") go(); };
  });
}

let detail = null, contact = null;
async function openDetail(id){
  contact = null;
  try { detail = await API.get(id); } catch(ex){ alertQueue(errText(ex)); return; }
  renderDetail();
  if (!$("#dlg").open) $("#dlg").showModal();
}
function alertQueue(msg){ $("#queueBody").insertAdjacentHTML("afterbegin", `<div class="alert bad" style="margin-top:14px">${esc(msg)}</div>`); }
$("#dlg").addEventListener("close", () => { detail = null; contact = null; $("#dlg").innerHTML = ""; });
function renderDetail(){
  const c = detail; if (!c) return;
  const kv = [["Lodged", fmtDT(c.createdAt)],["Service", SVC[c.service]?.name],["Issue", c.issue],["Account or card", c.acct ? "•••• "+c.acct : "—"],["Transaction date", c.txnDate ? fmtDate(c.txnDate) : "—"],["Amount", inr(c.amount)],["Transaction ref.", c.txnRef || "—"],["Customer wants", c.outcome || "—"],["Customer", c.name],["Mobile", contact ? contact.mobile : c.mobile],["Email", (contact ? contact.email : c.email) || "—"]];
  $("#dlg").innerHTML = `
    <div class="dlg-head"><div><p class="label">${c.urgent?'<span class="urgent">Urgent · </span>':""}${esc(SVC[c.service]?.name)}</p><h2 style="font-family:var(--f-mono);font-size:20px;font-weight:500;color:var(--petrol)">${esc(c.ref)}</h2><div style="display:flex;gap:10px;align-items:center;margin-top:6px">${pill(c.status)} ${clock(c)}</div></div><button class="x" id="dlgX" type="button" aria-label="Close">×</button></div>
    <div class="dlg-body">
      <div><dl class="kv">${kv.map(([k,v])=>`<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <p style="margin:10px 0 0;font-size:13px" class="muted">${contact ? "Contact details shown. This view has been recorded." : `Contact details are masked. <button class="reveal" id="d-reveal" type="button">Show contact details</button> only when you're about to contact the customer. Each view is recorded.`} Viewed ${Number(c.contactViews)+(contact?1:0)} time${Number(c.contactViews)+(contact?1:0)===1?"":"s"} so far.</p></div>
      <div><p class="label">Customer's account of the problem</p><p style="white-space:pre-wrap;margin:6px 0 0">${esc(c.description)}</p></div>
      <div class="route-box">
        <p class="label">Routing and escalation</p>
        <dl class="kv">
          <dt>Team</dt><dd>${teamLine(c)}</dd>
          ${c.routeReason ? `<dt>Why</dt><dd>${esc(c.routeReason)}</dd>` : ""}
          ${c.aiRisk ? `<dt>AI risk</dt><dd>${esc(c.aiRisk[0].toUpperCase() + c.aiRisk.slice(1))}</dd>` : ""}
          <dt>Escalation level</dt><dd>${esc(LEVELS[c.level || 0])} ${lvlBadge(c.level || 0)}</dd>
        </dl>
        <div class="row">
          <div class="field"><label for="d-team">Re-route to</label><select id="d-team">${Object.entries(TEAMS).map(([k,v])=>`<option value="${k}" ${k===c.team?"selected":""}>${esc(v)}</option>`).join("")}</select></div>
          <div class="actions"><button class="btn ghost" id="d-route" type="button">Re-route</button><span class="err" id="d-rerr" role="alert"></span></div>
        </div>
      </div>
      <div><p class="label" style="margin-bottom:8px">History</p><ul class="hist">${c.history.map(h=>`<li class="${h.by==="system"?"sys":""}"><time>${esc(fmtDT(h.at))}</time><div><span class="who">${esc(WHO[h.by] || h.by)}</span>${h.status?` · ${esc(STATUS[h.status])}`:""}<p>${esc(h.note)}</p></div></li>`).join("")}</ul></div>
      <div style="display:grid;gap:12px;border-top:1px solid var(--line);padding-top:18px">
        <p class="label">Send an update to the customer</p>
        <div class="field"><label for="d-status">Set status to</label><select id="d-status">${Object.entries(STATUS).filter(([k])=>k!=="received").map(([k,v])=>`<option value="${k}" ${k===c.status?"selected":""}>${v}</option>`).join("")}</select></div>
        <div class="field"><label for="d-note">Message the customer will see</label><textarea id="d-note" maxlength="2000" data-scan data-staff placeholder="We've raised a chargeback with the beneficiary bank. You'll hear from us within 7 working days."></textarea></div>
        <div class="actions"><button class="btn" id="d-send" type="button">Send update</button><span class="err" id="d-err" role="alert"></span></div>
      </div>
    </div>`;
  $("#dlgX").onclick = () => $("#dlg").close();
  const rv = $("#d-reveal");
  if (rv) rv.onclick = async () => {
    const keep = $("#d-note").value;
    try { contact = await API.reveal(c.id); renderDetail(); $("#d-note").value = keep; }
    catch(ex){ $("#d-err").textContent = errText(ex); }
  };
  $("#d-route").onclick = async () => {
    const team = $("#d-team").value, keep = $("#d-note").value;
    if (team === c.team) { $("#d-rerr").textContent = "It's already with that team."; return; }
    $("#d-route").disabled = true;
    try { detail = await API.route(c.id, team); renderDetail(); $("#d-note").value = keep; loadQueue(); }
    catch(ex){ $("#d-rerr").textContent = errText(ex); $("#d-route").disabled = false; }
  };
  $("#d-send").onclick = async () => {
    const note = $("#d-note").value.trim(), status = $("#d-status").value, de = $("#d-err"); de.textContent = "";
    if (!note){ de.textContent = "Write a message for the customer before sending."; return; }
    if (updateGuard($("#d-note"))){ de.textContent = "Fix the message flagged in red before sending."; return; }
    $("#d-send").disabled = true;
    try { detail = await API.update(c.id, status, note); renderDetail(); loadQueue(); }
    catch(ex){ de.textContent = errText(ex); $("#d-send").disabled = false; }
  };
}

/* ---------- monthly MIS report ----------
   Built in the browser from the staff queue (contacts already masked), for the
   nodal officer's board and RBI reporting. Nothing extra is fetched or stored. */
const monthKey = iso => new Date(iso).toLocaleDateString("en-CA").slice(0,7);   // local YYYY-MM
const monthName = k => new Date(k + "-01T00:00").toLocaleDateString("en-IN",{month:"long",year:"numeric"});
$("#reportBtn").onclick = () => openReport();
function openReport(month){
  const months = [...new Set([monthKey(new Date().toISOString()), ...S.rows.map(c => monthKey(c.createdAt))])].sort().reverse();
  month = month || months[0];
  const got = S.rows.filter(c => monthKey(c.createdAt) === month);
  const closed = S.rows.filter(c => c.status === "resolved" && monthKey(c.updatedAt) === month);
  const inTime = closed.filter(c => daysOpen(c) <= SLA).length, inTarget = closed.filter(c => hoursOpen(c) < TARGET_H).length;
  const avgH = closed.length ? closed.reduce((s, c) => s + hoursOpen(c), 0) / closed.length : null;
  const avg = avgH == null ? "—" : avgH < 48 ? avgH.toFixed(1) + " h" : (avgH / 24).toFixed(1) + " days";
  const open = S.rows.filter(c => c.status !== "resolved");
  const pct = (n, d) => d ? Math.round(n / d * 100) + "%" : "—";
  const tiles = [["Received", got.length], ["Resolved", closed.length], ["Resolved within 24 hours", pct(inTarget, closed.length)], ["Resolved within 30 days", pct(inTime, closed.length)],
    ["Average time to resolve", avg], ["Open now", open.length], ["Open past 24 hours", open.filter(isOverdue).length], ["Open past 30 days", open.filter(isLate).length]];
  const breakdown = (title, keys, label, pick) => {
    const lines = keys.map(k => {
      const g = got.filter(c => pick(c) === k), r = closed.filter(c => pick(c) === k), o = open.filter(c => pick(c) === k);
      return [label(k), g.length, r.length, o.length, o.filter(isOverdue).length, o.filter(isLate).length];
    }).filter(l => l[1] + l[2] + l[3]);
    return `<div><p class="label" style="margin-bottom:6px">${title}</p>${lines.length ? `<div class="tablebox" style="margin-top:0"><table class="mis"><thead><tr><th>${title.split(" ").pop()}</th><th class="num">Received</th><th class="num">Resolved</th><th class="num">Open now</th><th class="num">Past 24h</th><th class="num">Past 30</th></tr></thead><tbody>${
      lines.map(l => `<tr><td>${esc(l[0])}</td>${l.slice(1).map(n => `<td class="num">${n}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<p class="muted" style="margin:0">No complaints.</p>`}</div>`;
  };
  $("#dlg").innerHTML = `
    <div class="dlg-head"><div><p class="label">MIS report · Sangam Bank Grievance Desk</p><h2 style="font-size:22px">${esc(monthName(month))}</h2></div><button class="x no-print" id="dlgX" type="button" aria-label="Close">×</button></div>
    <div class="dlg-body">
      <div class="mis-bar no-print">
        <div class="field"><label for="r-month">Month</label><select id="r-month">${months.map(m => `<option value="${m}" ${m===month?"selected":""}>${esc(monthName(m))}</option>`).join("")}</select></div>
        <div class="actions"><button class="btn" id="r-csv" type="button">Download CSV</button><button class="btn ghost" id="r-print" type="button">Print or save as PDF</button></div>
      </div>
      <div class="tiles mis-tiles">${tiles.map(([l, n]) => `<div class="tile"><span class="label">${l}</span><span class="n">${n}</span></div>`).join("")}</div>
      <p class="muted" style="margin:0;font-size:12.5px">Received and resolved count complaints lodged or closed in ${esc(monthName(month))}. “Open now”, “Past 24h” and “Past 30” are as of ${esc(fmtDT(new Date().toISOString()))}. Urgent (fraud) complaints received: ${got.filter(c => c.urgent).length}. Escalated above complaints officer: ${got.filter(c => c.level > 0).length}.</p>
      ${breakdown("By service", SERVICES.map(s => s.id), k => SVC[k].name, c => c.service)}
      ${breakdown("By team", Object.keys(TEAMS), k => TEAMS[k], c => c.team)}
    </div>`;
  $("#dlgX").onclick = () => $("#dlg").close();
  $("#r-month").onchange = e => openReport(e.target.value);
  $("#r-csv").onclick = () => downloadCsv(got, month);
  $("#r-print").onclick = () => window.print();
  if (!$("#dlg").open) $("#dlg").showModal();
}
function downloadCsv(rows, month){
  // Leading = + - @ would run as a formula in Excel, so those cells get a ' prefix.
  const cell = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["Reference","Lodged","Service","Issue","Urgent","Amount (INR)","Team","Routed by","Escalation level","Status","Hours open","Past 24-hour target","Days open","Past 30 days","Customer","Mobile (masked)"];
  const lines = rows.map(c => [c.ref, c.createdAt.slice(0,10), SVC[c.service]?.name, c.issue, c.urgent ? "Yes" : "No", c.amount ?? "", TEAMS[c.team] || "",
    ROUTED_BY[c.routedBy] || "", LEVELS[c.level || 0], STATUS[c.status], hoursOpen(c), isOverdue(c) ? "Yes" : "No", daysOpen(c), isLate(c) ? "Yes" : "No", c.name, c.mobile]);
  const blob = new Blob(["﻿" + [head, ...lines].map(l => l.map(cell).join(",")).join("\r\n")], {type: "text/csv;charset=utf-8"});
  const a = Object.assign(document.createElement("a"), {href: URL.createObjectURL(blob), download: `grievance-desk-${month}.csv`});
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- boot ---------- */
if (!LIVE){
  const b = $("#banner"); b.hidden = false;
  b.textContent = FORCED_DEMO ? "Demo mode for reviewers: sample complaints only. Nothing you enter is saved, and it disappears when you close this tab. Any email and password opens the Staff tab."
    : window.supabase || !(CFG.supabaseUrl && CFG.supabaseAnonKey)
    ? "Demo mode: this site isn't connected to a database yet, so complaints are kept only in this tab and disappear when you close it."
    : "Couldn't load the database library. Check your connection and reload the page.";
}
renderDeviceRefs();
setTab(location.hash.slice(1) || "lodge");
