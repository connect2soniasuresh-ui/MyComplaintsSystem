# Grievance Desk

A complaints website for every banking service. Customers lodge a complaint, get a reference number and track it. Complaints officers work through a shared queue with a 30-day clock, following the RBI rule that a bank must reply within 30 days before a customer can go to the RBI Ombudsman.

The site is static (GitHub Pages) and stores data in [Supabase](https://supabase.com) (hosted Postgres).

## What's in this folder

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The website |
| `config.js` | Your Supabase project URL and public (anon) key |
| `supabase/schema.sql` | Database tables, access rules and functions. Run once in Supabase. |
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
- **Bank name.** "Grievance Desk" is a placeholder name.
