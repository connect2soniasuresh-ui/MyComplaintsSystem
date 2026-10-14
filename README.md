# Sangam Bank Grievance Desk

A complaints website for every banking service. Customers lodge a complaint, get a reference number and track it. Complaints officers work through a shared queue with a 30-day clock, following the RBI rule that a bank must reply within 30 days before a customer can go to the RBI Ombudsman.

The site is static (GitHub Pages) and stores data in [Supabase](https://supabase.com) (hosted Postgres).

## What's in this folder

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The website |
| `config.js` | Your Supabase project URL and public (anon) key |
| `supabase/schema.sql` | Database tables, access rules and functions. Run once in Supabase. |
| `supabase/functions/ai/index.ts` | Edge Function for the AI complaint assistant and AI routing |
| `supabase/seed_test_complaints.sql` | Optional test complaints for demos |
| `claude-artifact/grievance-desk.html` | The original version that runs inside claude.ai |

With `config.js` left empty the site runs in **demo mode**: it works, but complaints live only in the browser tab.

## Set up the database (about 10 minutes)

1. Create a free account at supabase.com and a **New project**. Pick the **Mumbai (ap-south-1)** region so customer data stays in India.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open **Authentication → Sign In / Providers** and turn **off** "Allow new users to sign up". Only people you add can sign in.
4. Add each complaints officer:
   - **Authentication → Users → Add user → Create new user**, tick **Auto Confirm User**.
   - Then in the SQL Editor:
     ```sql
     insert into public.staff (user_id) select id from auth.users where email = 'officer@yourbank.example';
     ```
5. Open **Project Settings → API**. Copy the **Project URL** and the **anon public** key into `config.js`. Never use the `service_role` key in the website.
6. Commit and push. GitHub Pages updates in about a minute.

If you set up the database before routing and escalation existed, run the updated `supabase/schema.sql` again. It keeps your data, routes existing complaints by rules, and schedules escalations.

## Turn on the AI features (about 10 minutes)

Two features run in the `ai` Edge Function (`supabase/functions/ai/index.ts`), which calls Claude. The Claude API key lives only in Supabase, never in the website.

- **AI complaint assistant.** On the Lodge tab, "Describe it in a chat" lets a customer explain the problem in their own words. The assistant asks follow-up questions and fills in the form. The customer still adds their own name and mobile, ticks consent and submits, so contact details never go to the AI. Messages with an OTP, PIN, CVV, card, Aadhaar or PAN number are blocked before they reach the model.
- **AI routing and auto-escalation.** Each complaint is routed to a team by rules the moment it's lodged. The AI then reads it once and may re-route it (for example a "login problem" that is really a scam call goes to the Fraud cell), mark it as possible fraud and rate its risk. The escalation matrix in the database raises cases automatically:

  | Rule | Escalated to |
  |---|---|
  | Fraud complaint, or AI rates it high risk, or no action for 7 days | Team lead |
  | Day 20 without a final reply, fraud of ₹1 lakh or more, or third complaint from the same customer in 90 days | Principal Nodal Officer |
  | Day 25 without a final reply | Internal Ombudsman / GM |

  Every routing decision and escalation is logged in the case history with the reason. Staff can re-route a case from its detail view. Customers don't see these internal entries.

Setup:

1. Get an API key at console.anthropic.com.
2. In Supabase open **Edge Functions → Secrets** and add `ANTHROPIC_API_KEY` with your key. Optionally add `ALLOWED_ORIGIN` set to your site's address (for example `https://youraccount.github.io`), so only your site can call the function.
3. Open **Edge Functions → Deploy a new function → Via editor**. Name it `ai`, delete the sample code in the editor, paste all of `supabase/functions/ai/index.ts`, and click **Deploy**. If you use a different name, put it in `aiFunction` in `config.js`. (With the Supabase CLI: `supabase functions deploy ai`.)
4. Escalations run every 30 minutes through `pg_cron`, which `schema.sql` enables. If your project doesn't allow it, escalations still run whenever staff open the queue.

If the function isn't deployed, the site still works: the chat option tells customers to use the form, and complaints stay on rule-based routing.

Each caller is limited to 40 chat messages and 30 routing requests an hour.

## Test complaints

`supabase/seed_test_complaints.sql` adds 12 backdated test complaints that show every routing and escalation rule: a new UPI case, card fraud over ₹1 lakh, a loan case with no action for 9 days, cases on Day 22 and Day 27, a resolved case, one waiting for the customer, a customer's third complaint in 90 days, and a scam call filed as a login problem. Run it in the SQL Editor after `schema.sql`. To remove them:

```sql
delete from public.complaints where mobile like '90000000%';
```

## How personal and confidential data is protected

- **No direct table access.** Row-level security is on and there are no policies, so neither visitors nor signed-in users can read or write the tables. Everything goes through the checked functions in `schema.sql`.
- **Customers prove ownership** with reference number + registered mobile. After 5 wrong mobile numbers, tracking for that reference locks for an hour. Reference numbers have 8 random characters, so they can't be guessed.
- **Confidential details are rejected twice**, in the browser and again in the database: OTP, CVV, PIN, passwords, full card numbers (Luhn-checked), Aadhaar, PAN and full account numbers. Staff messages that ask for these are blocked too.
- **Least exposure for staff.** Mobile and email are masked. Revealing them is a deliberate click, logged in `contact_access_log` with who and when.
- **Short staff sessions.** Sessions are kept in `sessionStorage` (gone when the tab closes), and staff are signed out after 15 minutes without activity.
- **Browser hardening.** A Content Security Policy allows scripts only from this site and the pinned, integrity-checked Supabase library. All customer text is escaped before display.
- **Data minimisation.** Only the last 4 digits of an account or card are accepted, email is optional, there are no uploads, and only reference numbers (never mobile numbers) are remembered on the customer's device.

## Before using it for real customers

- **Legal review.** Have the privacy notice and data handling reviewed against the Digital Personal Data Protection Act, 2023 and RBI guidelines. Decide and publish a retention period, and schedule deletion of closed complaints after it.
- **Spam protection.** Add a CAPTCHA (Supabase supports Cloudflare Turnstile and hCaptcha) to stop automated submissions.
- **Staff accounts.** Turn on multi-factor authentication for staff in Supabase.
- **Custom domain.** Use the bank's own domain (GitHub Pages → Custom domain, with HTTPS enforced) so customers can trust the address.
- **Bank name.** The site is branded Sangam Bank; search index.html and app.js for "Sangam Bank" to change it.
