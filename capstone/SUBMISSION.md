# Group 5 capstone submission: Grievance Desk

Product Management with AI, IIM Calcutta. Deadline: 25 November 2026.

| # | Deliverable (from the brief) | File or link |
|---|---|---|
| 1 | Functional product, with project folder and CLAUDE.md | The repository: `index.html`, `app.js`, `styles.css`, `supabase/`, [CLAUDE.md](../CLAUDE.md), [README.md](../README.md). Live: https://connect2soniasuresh-ui.github.io/MyComplaintsSystem/ (reviewers add `?demo`) |
| 2 | Consumer and segment analysis | [Group5_Consumer_Segment_Analysis.pdf](Group5_Consumer_Segment_Analysis.pdf) (source: `consumer_segment_analysis.html`) |
| 3 | Product marketing strategy and execution plan | [Group5_Strategy_GTM_Execution_Plan.pdf](Group5_Strategy_GTM_Execution_Plan.pdf) (source: `strategy_gtm_execution_plan.html`) |
| 4 | Presentation deck | https://claude.ai/artifact/DxmPEBWQ5KAMHrBd8zzFZG (15 slides with speaker notes; download as PowerPoint or PDF from the deck's Share › Export) |

Optional supporting artefact (the brief allows these): [Group5_Simulated_Interviews.pdf](Group5_Simulated_Interviews.pdf). Seven AI-simulated stakeholder interviews used to rehearse the guide and stress-test hypotheses. Clearly labelled as not primary research.

## Before submitting

- [x] Merge the `capstone/submission` branch into `main` and push, so the live site has the monthly report and `?demo` mode.
- [x] Open the live site with `?demo` and walk through: lodge (type `OTP 123456` to see it blocked), track, Staff tab (any email), Monthly report.
- [ ] Run the nodal-officer interviews (guide in the segment analysis, section 11). Then replace the illustrative persona quotes and re-render the PDFs.
- [x] Export the deck to PowerPoint and PDF (no specific LMS format required).
- [x] Re-run `supabase/schema.sql` on the live database (24-hour escalations).
- [x] Redeploy the Edge Function (deployed as `dynamic-service`) from `supabase/functions/ai/index.ts` so the chat assistant mentions the 24-hour target.
- [x] Repository is public.

## Re-rendering the PDFs after edits

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --no-pdf-header-footer --print-to-pdf="Group5_Consumer_Segment_Analysis.pdf" consumer_segment_analysis.html
```

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --no-pdf-header-footer --print-to-pdf="Group5_Strategy_GTM_Execution_Plan.pdf" strategy_gtm_execution_plan.html
```
