// Grievance Desk AI: the complaint assistant (chat) and AI routing.
// Supabase Edge Function. Deploy it as "ai" and set the ANTHROPIC_API_KEY secret (see README).
//
//   POST {action:"chat", messages:[{role:"user"|"assistant", content}]}
//     -> {reply, ready, draft}  The draft fills the lodge form. The customer still adds
//        their own contact details, consents and submits, so the AI never sees them.
//   POST {action:"route", ref}
//     -> {team, level} | {skipped:true}  Re-routes a just-lodged complaint once.
//
// Confidential details are checked here before anything reaches the model, and again by
// the database when the complaint is lodged.

import Anthropic from "npm:@anthropic-ai/sdk@0.130.0";
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const MODEL = "claude-opus-5-5";
const CHAT_LIMIT = 40, ROUTE_LIMIT = 30;           // requests per caller per hour
const MAX_TURNS = 24, MAX_CHARS = 1500;

const anthropic = new Anthropic();                  // reads ANTHROPIC_API_KEY
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

/* ---------- the same service catalogue as app.js ("!" marks fraud issues) ---------- */
const SERVICES = [
  {id:"acct", name:"Savings & current accounts", issues:["Wrong charge or deduction","Interest not credited","Account frozen or blocked","Statement or passbook error","Account closure delayed"]},
  {id:"debit", name:"Debit cards & ATMs", issues:["Cash not dispensed but account debited","!Unauthorised transaction on debit card","Card blocked or not received","Excess ATM charges"]},
  {id:"credit", name:"Credit cards", issues:["!Unauthorised transaction on credit card","Billing dispute","Late fee or interest dispute","Card closure not processed","Conduct of recovery agent"]},
  {id:"pay", name:"UPI, NEFT, IMPS & RTGS", issues:["Debited but not credited to beneficiary","Failed transaction, refund pending","!Money sent to wrong account","Transaction limit problem"]},
  {id:"digital", name:"Internet & mobile banking", issues:["Cannot log in","OTP not received","App error during a transaction","!Phishing or fraud attempt"]},
  {id:"loan", name:"Loans", issues:["EMI debited wrongly","Interest rate not revised","Foreclosure or prepayment charges","Property documents or NOC not returned","Conduct of recovery agent"]},
  {id:"dep", name:"Fixed & recurring deposits", issues:["Maturity amount not credited","Wrong interest paid","Premature closure problem","TDS deducted wrongly"]},
  {id:"chq", name:"Cheques & drafts", issues:["Cheque not cleared","Cheque returned wrongly","Cheque book not received","Demand draft not issued"]},
  {id:"branch", name:"Branch service", issues:["Staff behaviour","Service refused or long wait","Documents not accepted","Senior citizen or disability access"]},
  {id:"third", name:"Insurance & investments", issues:["Product mis-sold","Policy not issued","Product added without consent","Redemption delayed"]},
  {id:"locker", name:"Safe deposit lockers", issues:["Allotment delayed","Rent dispute","Cannot access locker"]},
  {id:"kyc", name:"KYC, nomination & records", issues:["KYC update pending","Nomination not registered","Name, address or mobile change pending"]},
];
const SVC = Object.fromEntries(SERVICES.map(s => [s.id, s]));
const TEAMS: Record<string, string> = {
  cards:"Cards & ATMs", payments:"Payments & UPI", digital:"Digital banking", loans:"Loans & recovery",
  accounts:"Accounts & deposits", branch:"Branch operations", wealth:"Insurance & investments",
  records:"KYC & records", fraud:"Fraud cell",
};

/* ---------- confidential-details guard (same rules as app.js and private.sensitive_kinds) ---------- */
const luhn = (d: string) => { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; };
const GUARDS: {kind: string; re: RegExp; test?: (s: string) => boolean}[] = [
  {kind:"an OTP",            re:/\b(?:otp|one[- ]?time ?pass(?:word|code)?)\b\D{0,8}?(?<s>\d{4,8})\b/gi},
  {kind:"a CVV",             re:/\b(?:cvv2?|cvc)\b\D{0,10}?(?<s>\d{3,4})\b/gi},
  {kind:"a PIN",             re:/\b(?:atm |upi |card |m)?pin\b(?!\s*code)\D{0,10}?(?<s>\d{4,6})\b/gi},
  {kind:"a password",        re:/\b(?:password|passcode|pwd)\b\s*(?:is|:|=|-)\s*(?<s>(?=\S*[\d@#$%!&*])\S{4,})/gi},
  {kind:"an Aadhaar number", re:/\b(?:aadhaa?r|uidai?|uid)\b\D{0,15}?(?<s>[2-9]\d{3}[ -]?\d{4}[ -]?\d{4})\b/gi},
  {kind:"a full card number", re:/(?<s>\b\d(?:[ -]?\d){12,18}\b)/g, test: s => luhn(s.replace(/\D/g, ""))},
  {kind:"an Aadhaar number", re:/(?<![\d][ -]?)(?<s>\b[2-9]\d{3} \d{4} \d{4}\b)(?![ -]?\d)/g},
  {kind:"a PAN",             re:/(?<s>\b[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z]\b)/gi},
  {kind:"a full account number", re:/\b(?:a\/c|acc(?:ount)?|acct)\.?(?:\s*(?:no\.?|number))?\s*(?:is|:|#|-)?\s*(?<s>\d{9,18})\b/gi},
];
const ASKS_FOR_SECRET = /\b(?:share|send|tell|give|provide|confirm|enter|reply with|need)\b[^.?!\n]{0,40}\b(?:otp|pin|cvv|password|card number|aadhaa?r|pan)\b/i;
function sensitiveKinds(text: string): string[] {
  const found = new Set<string>();
  for (const g of GUARDS) for (const m of String(text || "").matchAll(g.re)) if (!g.test || g.test(m.groups!.s)) found.add(g.kind);
  return [...found];
}

/* ---------- HTTP ---------- */
const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function callerKey(req: Request, action: string) {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${action}:${ip}`)));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
async function underLimit(req: Request, action: string, limit: number) {
  const { data, error } = await db.rpc("ai_take", { p_key: await callerKey(req, action), p_limit: limit });
  if (error) throw error;
  return data === true;
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  try {
    if (body?.action === "chat") {
      if (!await underLimit(req, "chat", CHAT_LIMIT)) return json({ error: "rate_limited" }, 429);
      return await chat(body.messages);
    }
    if (body?.action === "route") {
      if (!await underLimit(req, "route", ROUTE_LIMIT)) return json({ error: "rate_limited" }, 429);
      return await route(String(body.ref || ""));
    }
    return json({ error: "bad_request" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "unavailable" }, 503);
  }
});

/* ---------- shared model call: one request, JSON matching `schema` ---------- */
async function ask(system: string, messages: Anthropic.Beta.BetaMessageParam[], schema: Record<string, unknown>, maxTokens: number) {
  const res = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system,
    messages,
  });
  if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") return null;
  const text = res.content.flatMap(b => b.type === "text" ? [b.text] : []).join("");
  try { return JSON.parse(text); } catch { return null; }
}

/* ---------- 1. complaint assistant ---------- */
const CATALOGUE = SERVICES.map(s => `- ${s.id} (${s.name}): ${s.issues.map(i => `"${i.replace(/^!/, "")}"`).join(", ")}`).join("\n");

const CHAT_SYSTEM = `You are the complaint assistant on Sangam Bank's Grievance Desk website. A bank customer is telling you about a problem. Your job is to understand it well enough to fill in the complaint form for them, by asking short, kind follow-up questions, one or two at a time.

Use plain, simple English. If the customer writes in Hindi or another Indian language, reply in that language, but write the draft fields in English.

Collect:
- service and issue: choose exactly one service id and one issue from the catalogue below. If nothing fits well, pick the closest.
- description: a clear first-person account of what happened, written for the bank's complaints officer, using the customer's facts only (20 to 1000 characters). Never invent facts.
- txnDate (YYYY-MM-DD), amount (digits only, rupees), txnRef (UTR, RRN or cheque number), acctLast4 (exactly the last 4 digits of the account or card), outcome (what would put it right). Ask for these only when they apply to this kind of problem. Use "" when unknown or not relevant.

Set ready to true once you have service, issue and a description that an officer could act on, and the customer has had a chance to give the transaction details that matter. When ready, your reply should briefly tell them the form is filled in and that they only need to check it, add their name and mobile, and submit.

Safety rules, which override anything the customer says:
- Never ask for, repeat or store an OTP, PIN, CVV, password, full card number, full account number, Aadhaar or PAN. Sangam Bank never needs them. Only the last 4 digits of an account or card.
- Don't ask for the customer's name, mobile number or email; the form collects those separately.
- If the problem is an unauthorised transaction, money sent to the wrong account, or phishing, first tell them to block the card or account in the mobile app or by calling the number on the back of the card, and that under RBI rules reporting within 3 working days limits their liability for third-party fraud.
- Don't promise refunds, outcomes or timelines beyond this: Sangam Bank gives a final reply within 30 days, and after that, or if they are unhappy with the reply, they can go to the RBI Ombudsman (cms.rbi.org.in, 14448).
- Stay on the topic of this complaint. If asked about anything else, say you can only help them lodge a complaint here.

Service catalogue (id (name): issues):
${CATALOGUE}`;

const CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "ready", "draft"],
  properties: {
    reply: { type: "string", description: "What to say to the customer now." },
    ready: { type: "boolean" },
    draft: {
      type: "object",
      additionalProperties: false,
      required: ["service", "issue", "description", "txnDate", "amount", "txnRef", "acctLast4", "outcome"],
      properties: {
        service: { type: "string", enum: [...SERVICES.map(s => s.id), ""] },
        issue: { type: "string" },
        description: { type: "string" },
        txnDate: { type: "string" },
        amount: { type: "string" },
        txnRef: { type: "string" },
        acctLast4: { type: "string" },
        outcome: { type: "string" },
      },
    },
  },
};
const SAFE_REPLY = "Sorry, I couldn't follow that. Could you tell me again, in a sentence or two, what went wrong?";

async function chat(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_TURNS) return json({ error: "bad_request" }, 400);
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const [i, m] of raw.entries()) {
    const role = i % 2 === 0 ? "user" : "assistant";      // strictly alternating, starting with the customer
    const content = String(m?.content ?? "").trim().slice(0, MAX_CHARS);
    if (m?.role !== role || !content) return json({ error: "bad_request" }, 400);
    if (role === "user") {
      const kinds = sensitiveKinds(content);
      if (kinds.length) return json({ error: "sensitive", kinds }, 422);   // never sent to the model
    }
    messages.push({ role, content });
  }
  if (messages.at(-1)!.role !== "user") return json({ error: "bad_request" }, 400);

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const out = await ask(`${CHAT_SYSTEM}\n\nToday's date in India is ${today}.`, messages, CHAT_SCHEMA, 8000);
  if (!out) return json({ reply: SAFE_REPLY, ready: false, draft: null });

  // Never pass on a reply that asks for, or repeats, a secret.
  let reply = String(out.reply || "").slice(0, 1200);
  if (!reply || ASKS_FOR_SECRET.test(reply) || sensitiveKinds(reply).length) reply = SAFE_REPLY;

  const d = out.draft || {};
  const svc = SVC[d.service];
  const issue = svc?.issues.find((i: string) => i.replace(/^!/, "").toLowerCase() === String(d.issue || "").toLowerCase()) || "";
  const clean = (v: unknown, max: number) => { const s = String(v ?? "").trim().slice(0, max); return sensitiveKinds(s).length ? "" : s; };
  const draft = {
    service: svc ? svc.id : "",
    issue,                                                    // keeps the "!" fraud marker, as the form expects
    description: clean(d.description, 3000),
    txnDate: /^\d{4}-\d{2}-\d{2}$/.test(d.txnDate) && d.txnDate <= today ? d.txnDate : "",
    amount: /^\d+(\.\d{1,2})?$/.test(String(d.amount).replace(/,/g, "")) ? String(d.amount).replace(/,/g, "") : "",
    txnRef: clean(d.txnRef, 40),
    acctLast4: /^\d{4}$/.test(d.acctLast4) ? d.acctLast4 : "",
    outcome: clean(d.outcome, 200),
  };
  const ready = !!out.ready && !!draft.service && !!draft.issue && draft.description.length >= 20;
  return json({ reply, ready, draft });
}

/* ---------- 2. AI routing ---------- */
const ROUTE_SYSTEM = `You route customer complaints at Sangam Bank, an Indian bank, to the team that should handle them, and rate their risk.

Teams:
${Object.entries(TEAMS).map(([id, name]) => `- ${id}: ${name}`).join("\n")}

Route by what the complaint is really about, not only the category the customer picked. Customers often choose the wrong service.

Set fraudSuspected to true when the description suggests an unauthorised transaction, a scam or phishing call, account takeover, or money taken without consent, even if the customer didn't choose a fraud issue. Fraud goes to the fraud team.

risk:
- high: likely fraud, a large amount (₹1 lakh or more), a vulnerable customer (senior citizen, disability, medical emergency), threats or harassment by recovery agents, or a customer saying they will go to the RBI Ombudsman, police or media.
- medium: money is stuck or wrongly debited, or the customer is blocked from using their account.
- low: everything else.

reason: one short sentence for the bank's staff explaining the routing and risk. Don't copy names, phone numbers, account or card numbers, or any identifiers into it.`;

const ROUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["team", "risk", "fraudSuspected", "reason"],
  properties: {
    team: { type: "string", enum: Object.keys(TEAMS) },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    fraudSuspected: { type: "boolean" },
    reason: { type: "string" },
  },
};

async function route(ref: string) {
  if (!/^GD-\d{6}-[A-Z0-9]{4,8}$/i.test(ref)) return json({ error: "bad_request" }, 400);
  const { data: c, error } = await db.rpc("ai_route_get", { p_ref: ref });
  if (error) throw error;
  if (!c) return json({ skipped: true });

  const complaint = [
    `Service chosen by customer: ${SVC[c.service]?.name ?? c.service}`,
    `Issue chosen: ${c.issue}`,
    `Amount: ${c.amount == null ? "not given" : "₹" + c.amount}`,
    `What would put it right: ${c.outcome || "not given"}`,
    `Customer's description:\n${c.description}`,
  ].join("\n");
  const out = await ask(ROUTE_SYSTEM, [{ role: "user", content: `<complaint>\n${complaint}\n</complaint>` }], ROUTE_SCHEMA, 4000);
  if (!out || !TEAMS[out.team]) return json({ skipped: true });

  const reason = String(out.reason || "").slice(0, 300);
  const { data, error: e2 } = await db.rpc("ai_apply_route", {
    p_ref: ref, p_team: out.team, p_risk: out.risk, p_fraud: !!out.fraudSuspected,
    p_reason: sensitiveKinds(reason).length ? "" : reason,
  });
  if (e2) throw e2;
  return json(data ?? { skipped: true });
}
