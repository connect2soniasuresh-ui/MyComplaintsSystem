# CLAUDE.md

Guidance for Claude Code (and anyone else) working in this repository.

## What this is

**Grievance Desk**: a white-label complaints website and staff console for India's smaller banks (urban cooperative banks, small finance banks, regional rural banks). The demo bank is the fictional **Sangam Bank**. It is the Group 5 capstone for *Product Management with AI* (IIM Calcutta).

Core flows:

1. **Lodge.** A customer picks one of 12 services and about 50 issues, or describes the problem to the AI complaint assistant, which fills in the form. They get a reference number like `GD-261017-K7QZ8M2P`, the 24-hour resolution target and the Day 30 final-reply date.
2. **Track.** Reference number plus registered mobile shows status and history, and lets the customer reply when the bank asks for information.
3. **Staff queue.** Officers sign in (invitation only) and see tiles, filters, a 24-hour clock per case (then Day X of 30), routing team and escalation level. They open a case, reveal contact details (logged), re-route it and send updates.
4. **Monthly report.** The staff console builds a monthly MIS summary (received, resolved, % within 24 hours and 30 days, average time, by service and team). It can be downloaded as CSV or printed to PDF for the board and RBI returns.

Live site: https://connect2soniasuresh-ui.github.io/MyComplaintsSystem/
Reviewer demo (no login, sample data, nothing saved): add `?demo` to the URL.

## Stack and layout

No build step and no framework. Plain HTML, CSS and JavaScript on GitHub Pages, with Supabase (Postgres, Mumbai region) as the backend.

| Path | Role |
|---|---|
| `index.html` | Markup for the three tabs and the dialog. Holds the Content Security Policy. |
| `app.js` | All front-end logic: service catalogue, confidential-data guard, data layer (`API` = Supabase RPC or `DemoAPI`), lodge, chat, track, staff queue, case detail, monthly report. |
| `styles.css` | Design tokens on `:root` with dark mode; print styles for the report. |
| `config.js` | Supabase URL, anon key, Edge Function name. Empty values mean demo mode. |
| `supabase/schema.sql` | Tables, row-level security (on, with no policies), and all `security definer` functions the site calls. Safe to re-run. |
| `supabase/functions/ai/index.ts` | Edge Function: `chat` (AI complaint assistant) and `route` (AI re-routing and risk rating) using the Claude API. |
| `supabase/seed_test_complaints.sql` | 12 backdated test complaints showing every routing and escalation rule. |
| `claude-artifact/grievance-desk.html` | The original single-file prototype that ran inside claude.ai. |
| `capstone/` | Capstone submission documents (strategy, segment analysis, deck) and their HTML sources. |
| `marketing_strategy.html`, `strategy_assets/` | Mini Project 3 strategy document and its screenshots. |

## Running it

- **Locally:** serve the folder with any static server, for example `python -m http.server 8080`, then open http://localhost:8080/?demo. Opening `index.html` directly from disk also works in demo mode.
- **Demo mode** (`?demo`, or `config.js` empty): `DemoAPI()` in `app.js` keeps everything in memory, preloads 9 sample complaints, and lets any email and password into the Staff tab. The AI chat is hidden in demo mode because it needs the Edge Function.
- **Live mode:** follow README.md (create the Supabase project, run `schema.sql`, add staff, deploy the `ai` function with `ANTHROPIC_API_KEY`).

## Rules to keep

- **Never weaken the confidential-data guard.** `GUARDS` in `app.js`, `private.sensitive_kinds` in `schema.sql` and the check in the Edge Function must stay in step. Any new free-text field gets `data-scan` in the HTML and an `assert_clean` call in SQL.
- **No direct table access.** Add new data access as a checked `security definer` function in `schema.sql`, never as an RLS policy that exposes rows.
- **Contact details stay masked** for staff unless revealed through `reveal_contact` (which logs the view). Exports and reports use the masked values.
- **The AI never sees contact details** and never decides alone. Rules route first. AI may re-route once, and every AI decision is logged with its reason and can be overridden by staff.
- **Two clocks.** `TARGET_H` (24 hours) is the bank's own resolution target and drives the case clock, the meter and the time-based escalations (4h no action → team lead, 12h → Principal Nodal Officer, 20h → Internal Ombudsman / GM). `SLA` (30 days) is RBI's legal deadline and drives the reply-by date and the Ombudsman route. Don't merge them.
- **Escalation levels only go up.** The rules in `private.escalation_target` and `escalate()` in `DemoAPI` must match.
- **Escape all customer text** with `esc()` before inserting HTML.
- **Keep the CSP** in `index.html` tight. Scripts come only from this site and the pinned, integrity-checked Supabase library.
- **Cache-busting:** bump the `?v=` on `styles.css`, `config.js` or `app.js` in `index.html` when you change them.
- **Plain language** in all customer-facing text. The audience includes rural and less tech-savvy customers.

## Checking a change

There is no automated test suite. Before committing, walk through these in `?demo` mode:

1. Lodge a UPI complaint and get a reference number. Type `OTP 123456` in the description: it must be flagged and block submission.
2. Track it with the reference and mobile.
3. Staff tab: tiles add up, the 2-hour KYC case shows “2h of 24h” with no escalation, the 6-hour UPI case is with the team lead (no action for 4 hours), and cases older than 20 hours are with the Internal Ombudsman / GM.
4. Open a case, reveal contacts, re-route, send an update. A staff message asking for an OTP must be blocked.
5. Monthly report: totals match the queue, and the locker case counts as resolved within 24 hours. CSV downloads and opens in Excel. Print preview shows only the report.
