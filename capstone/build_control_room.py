"""Build control-room.html (the Grievance Desk Control Room) from the CSV files
in capstone/control_room_data/.

The page is static HTML with inline SVG and no JavaScript, so it works under the
site's Content Security Policy and prints cleanly to PDF.

    python capstone/build_control_room.py

All figures in the CSV files are an illustrative SAMPLE projection, not real data.
"""
import csv
import html
import os
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "control_room_data")
OUT = os.path.join(os.path.dirname(HERE), "control-room.html")

GROUPS = [
    ("leading", "Leading indicators",
     "Signs that move before revenue does: whether customers lodge online, whether officers act fast, and whether pilots turn into paying banks."),
    ("financial", "Financial health",
     "Lagging measures of whether Grievance Desk is a business: recurring revenue, margin, what it costs to win a bank, whether banks stay, and how fast they pay."),
    ("control", "Misuse and long-term viability",
     "Control metrics that catch misuse of the product by customers, staff or the AI, and costs that would make the model unviable as it grows. The two marked Guardrail must never be in the worst band."),
    ("tech", "Tech health",
     "Whether the site, the AI assistant, the notifications and the escalation job are up and fast enough for customers on slow rural connections."),
]
BAND_LABEL = {"best": "Best", "average": "Average", "worst": "Worst"}
# Scenario rule (also written out on the page)
WORST_IF_COUNT = 4
BEST_SHARE = 0.7

e = html.escape


def read(name):
    with open(os.path.join(DATA, name), encoding="utf8") as f:
        return list(csv.DictReader(f))


def num(v):
    return None if v is None or v == "" else float(v)


def band_of(d, v):
    if v is None or d["direction"] == "track":
        return None
    b, w = float(d["best"]), float(d["worst"])
    if d["direction"] == "up":
        return "best" if v >= b else "worst" if v < w else "average"
    return "best" if v <= b else "worst" if v > w else "average"


def unit_parts(u):
    if u == "₹":
        return "₹", ""
    if u == "₹ lakh":
        return "₹", " lakh"
    if u in ("%", "/5"):
        return "", u
    if not u:
        return "", ""
    return "", " " + u


def fmt(v, dec):
    return "—" if v is None else f"{v:,.{dec}f}"


def full(d, v):
    p, s = unit_parts(d["unit"])
    return "no data" if v is None else p + fmt(v, int(d["decimals"])) + s


def thr(d, v):
    p, s = unit_parts(d["unit"])
    v = float(v)
    t = f"{v:,.2f}".rstrip("0").rstrip(".")
    return p + t + s


def ranges(d):
    if d["direction"] == "track":
        return ("Tracked only", "", "")
    b, w = d["best"], d["worst"]
    same = float(b) == float(w)
    if d["direction"] == "up":
        return ("≥ " + thr(d, b), "—" if same else thr(d, w) + " to " + thr(d, b), "< " + thr(d, w))
    return ("≤ " + thr(d, b), "—" if same else thr(d, b) + " to " + thr(d, w), "> " + thr(d, w))


def month_long(m):
    return datetime.strptime(m, "%Y-%m").strftime("%b %Y")


def month_short(m):
    return datetime.strptime(m, "%Y-%m").strftime("%b")


monthly = read("monthly.csv")
defs = read("definitions.csv")
banks = read("banks.csv")
banded = [d for d in defs if d["direction"] != "track"]
last, prev = monthly[-1], monthly[-2]

bands = {d["id"]: band_of(d, num(last[d["id"]])) for d in banded}
counts = {k: sum(1 for b in bands.values() if b == k) for k in BAND_LABEL}
counted = sum(counts.values())
guard_breach = any(d["guardrail"] == "yes" and bands[d["id"]] == "worst" for d in banded)
if guard_breach or counts["worst"] >= WORST_IF_COUNT:
    scenario = "worst"
elif counts["worst"] == 0 and counts["best"] / counted >= BEST_SHARE:
    scenario = "best"
else:
    scenario = "average"


def group_counts(g):
    return {k: sum(1 for d in banded if d["group"] == g and bands[d["id"]] == k) for k in BAND_LABEL}


def month_counts(m):
    c = {k: 0 for k in BAND_LABEL}
    for d in banded:
        b = band_of(d, num(m[d["id"]]))
        if b:
            c[b] += 1
    return c


def slipping():
    out = []
    for d in banded:
        v = [num(m[d["id"]]) for m in monthly[-4:]]
        if None in v:
            continue
        worse = [(v[i] < v[i - 1]) if d["direction"] == "up" else (v[i] > v[i - 1]) for i in range(1, 4)]
        if all(worse):
            out.append((d, v[0], v[-1]))
    return out


def stack(c):
    parts = []
    for k in BAND_LABEL:
        if c[k]:
            parts.append(f'<span class="seg-{k}" style="flex-grow:{c[k]}" title="{BAND_LABEL[k]}: {c[k]}">{c[k]}</span>')
    return '<div class="stack">' + "".join(parts) + "</div>"


def spark(d):
    W, H, pad = 240, 54, 5
    pts = [(i, m["month"], num(m[d["id"]])) for i, m in enumerate(monthly)]
    vals = [p[2] for p in pts if p[2] is not None]
    ref = None if d["direction"] == "track" else float(d["best"])
    lo, hi = min(vals + ([ref] if ref is not None else [])), max(vals + ([ref] if ref is not None else []))
    if lo == hi:
        lo, hi = lo - 1, hi + 1
    n = len(pts)
    X = lambda i: pad + i * (W - 2 * pad) / (n - 1)
    Y = lambda v: H - pad - (v - lo) * (H - 2 * pad) / (hi - lo)
    first = next(p for p in pts if p[2] is not None)
    lastp = [p for p in pts if p[2] is not None][-1]
    label = f'{d["name"]}, {month_long(first[1])} to {month_long(lastp[1])}: from {full(d, first[2])} to {full(d, lastp[2])}'
    out = [f'<svg class="spark" viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="{e(label)}">']
    if ref is not None:
        out.append(f'<line class="ref" x1="{pad}" x2="{W - pad}" y1="{Y(ref):.1f}" y2="{Y(ref):.1f}"/>')
    path, pen = [], False
    for i, _, v in pts:
        if v is None:
            pen = False
            continue
        path.append(("L" if pen else "M") + f"{X(i):.1f},{Y(v):.1f}")
        pen = True
    out.append(f'<path class="line" d="{" ".join(path)}"/>')
    for i, m, v in pts:
        if v is None:
            continue
        r = 3.5 if i == lastp[0] else 2
        out.append(f'<circle class="{"end" if i == lastp[0] else "pt"}" cx="{X(i):.1f}" cy="{Y(v):.1f}" r="{r}"><title>{e(month_long(m))}: {e(full(d, v))}</title></circle>')
    out.append("</svg>")
    return "".join(out)


def tile(d):
    v = num(last[d["id"]])
    b = bands.get(d["id"])
    p, s = unit_parts(d["unit"])
    chips = ""
    if d["guardrail"] == "yes":
        chips += '<span class="chip chip-guard">Guardrail</span>'
    if b:
        chips += f'<span class="chip chip-{b}">{BAND_LABEL[b]}</span>'
    elif d["direction"] == "track":
        chips += '<span class="chip chip-track">Tracked</span>'
    a, z = num(last[d["id"]]), num(prev[d["id"]])
    if a is None or z is None:
        chg = '<p class="tile-chg">No change figure</p>'
    else:
        c = round(a - z, int(d["decimals"]))
        good = None if d["direction"] == "track" else (c > 0 if d["direction"] == "up" else c < 0)
        cls = "" if c == 0 or good is None else ("good" if good else "bad")
        cu = " pts" if d["unit"] == "%" else s
        sign = "+" if c > 0 else ""
        chg = f'<p class="tile-chg"><span class="{cls}">{sign}{fmt(c, int(d["decimals"]))}</span>{e(cu)} vs {month_short(prev["month"])}</p>'
    r = ranges(d)
    foot = "Tracked for context, no bands" if d["direction"] == "track" else f"Best {r[0]} · Worst {r[2]}"
    unit_html = f'<span class="u">{e(s.strip())}</span>' if s else ""
    return (f'<article class="tile" id="m-{d["id"]}"><div class="tile-head"><h4>{e(d["name"])}</h4><div class="chips">{chips}</div></div>'
            f'<p class="tile-val">{e(p)}{fmt(v, int(d["decimals"]))}{unit_html}</p>{chg}{spark(d)}<p class="tile-foot">{e(foot)}</p></article>')


def bank_rows():
    cols = ["bank", "kind", "status", "branches", "complaints_lodged", "resolved_24h_pct", "open_past_30", "weekly_active_officers_pct", "contact_reveals_per_case"]
    dmap = {d["id"]: d for d in defs}
    rows = []
    for r in banks:
        cells = []
        for i, c in enumerate(cols):
            if c in dmap:
                v = num(r[c])
                b = band_of(dmap[c], v)
                cells.append(f'<td class="n{" b-" + b if b else ""}">{e(full(dmap[c], v))}</td>')
            elif i > 2:
                cells.append(f'<td class="n">{fmt(num(r[c]), 0)}</td>')
            else:
                cells.append(f"<td>{e(r[c])}</td>")
        rows.append("<tr>" + "".join(cells) + "</tr>")
    return "\n".join(rows)


def def_rows():
    gl = {g: n for g, n, _ in GROUPS}
    out = []
    for g, _, _ in GROUPS:
        out.append(f'<tr class="grp-row"><th colspan="7">{e(gl[g])}</th></tr>')
        for d in defs:
            if d["group"] != g:
                continue
            r = ranges(d)
            badge = ' <span class="chip chip-guard">Guardrail</span>' if d["guardrail"] == "yes" else ""
            out.append(f'<tr><td><b>{e(d["name"])}</b>{badge}</td><td>{e(d["computation"])}</td><td>{e(d["why"])}</td>'
                       f'<td class="nw">{e(r[0])}</td><td class="nw">{e(r[1])}</td><td class="nw">{e(r[2])}</td><td>{e(d["if_worst"] or "—")}</td></tr>')
    return "\n".join(out)


worst_items = "".join(
    f'<li><b><a href="#m-{d["id"]}">{e(d["name"])}</a>: {e(full(d, num(last[d["id"]])))}</b><span>{e(d["if_worst"])}</span></li>'
    for d in banded if bands[d["id"]] == "worst") or '<li class="empty">Nothing is in the worst band this month.</li>'
slip_items = "".join(
    f'<li><b><a href="#m-{d["id"]}">{e(d["name"])}</a></b><span>From {e(full(d, a))} to {e(full(d, z))} over three months.</span></li>'
    for d, a, z in slipping()) or '<li class="empty">No metric has worsened three months in a row.</li>'

group_rows = "".join(f'<a href="#{g}">{e(n)}</a>{stack(group_counts(g))}' for g, n, _ in GROUPS)
trend_rows = "".join(f'<span>{month_long(m["month"])}</span>{stack(month_counts(m))}' for m in monthly)
group_sections = "".join(
    f'<section class="sec page" id="{g}"><h2>{e(n)}</h2><p class="lede">{e(intro)}</p>'
    f'<div class="tiles">{"".join(tile(d) for d in defs if d["group"] == g)}</div></section>'
    for g, n, intro in GROUPS)


def scn(key, title, how, looks, actions, owner):
    cur = key == scenario
    lis = "".join(f"<li>{e(a)}</li>" for a in actions)
    here = '<span class="here">This month</span>' if cur else ""
    return (f'<div class="card scn-card{" is-current" if cur else ""}"><h3>{e(title)} {here}</h3>'
            f'<p class="label">How we know</p><p>{e(how)}</p><p class="label">What it looks like</p><p>{e(looks)}</p>'
            f'<p class="label">Action plan</p><ol>{lis}</ol><p><b>Owner and review:</b> {e(owner)}</p></div>')


scenarios = "".join([
    scn("best", "Best case",
        f"At least {int(BEST_SHARE * 100)}% of metrics in their best band, none in the worst, no guardrail breached.",
        "ARR of ₹12 lakh or more, 75% or more of complaints resolved within 24 hours, half of pilots converting, and officers using the console every week.",
        ["Move new banks to the full Professional tier price and close the founding-bank offer.",
         "Open a second state federation and start a regional rural bank pilot.",
         "Hire a second customer success person before the number of banks outgrows one.",
         "Build voice lodging in regional languages for customers who don't type.",
         "Keep the guardrails: the monthly confidential-data audit and reveal-log review continue."],
        "PM with the GTM lead; monthly."),
    scn("average", "Average case",
        "Neither the best nor the worst rule applies.",
        "Growing, but some metrics stall: 60–75% within 24 hours, payments slow to arrive, and one or two control metrics drifting the wrong way.",
        ["Take the two weakest metrics and run their fix from Metric definitions for 30 days.",
         "Fortnightly review with each bank's Principal Nodal Officer, using the bank table.",
         "Push online lodging: QR posters in branches and tracking links in SMS.",
         "Move new contracts to annual billing in advance to bring collection time down.",
         "Hold new pilots until pilot-to-paid conversion is back at 50%."],
        "PM with the CX lead; fortnightly."),
    scn("worst", "Worst case",
        f"A guardrail is breached (confidential details stored, or a complaint open past RBI's 30 days), or {WORST_IF_COUNT} or more metrics are in the worst band.",
        "A bank is exposed to RBI or losing trust in the product, revenue stalls and the first cancellations appear.",
        ["Incident response within 24 hours for any guardrail breach: fix it, tell the bank in writing, write a root-cause note.",
         "Freeze new sales and onboarding until the breach is closed.",
         "Founder call to every bank this week, then a weekly written update until back to Average.",
         "Switch AI routing to rules only if AI errors or overrides are part of the cause.",
         "Cut events and ads to protect cash, and re-check the target segment."],
        "PM and TECH lead with the whole team; daily until out."),
])

latest = month_long(last["month"])
page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<meta name="description" content="Grievance Desk Control Room: product and business health metrics, scenarios and action plans (sample data).">
<title>Grievance Desk Control Room</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='none' stroke='%23E8711C' stroke-width='3'/%3E%3C/svg%3E">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@112,600;112,800&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="styles.css?v=6">
<style>
/* Not .wrap: styles.css hides .wrap when printing (it prints only the monthly report). */
.crwrap{{max-width:1120px;margin:0 auto}}
.cr{{display:flex;flex-direction:column;gap:40px;padding-top:28px}}
.sec{{display:flex;flex-direction:column;gap:16px}}
.sec h2{{font-size:24px}}
.sample{{font-size:13px;color:var(--muted);border:1px dashed var(--line);border-radius:var(--r);padding:8px 12px;max-width:80ch}}
.headline{{font-size:17px;max-width:70ch;margin:0}}
.headline b{{color:var(--petrol)}}
.jump{{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:13px}}
.cr .card{{display:block;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px;min-width:0}}
.ov{{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;align-items:start}}
.big{{font:800 34px/1.1 var(--f-display);font-stretch:112%;color:var(--petrol);margin:4px 0 8px}}
.small{{font-size:13px;color:var(--muted);margin:0}}
.grp{{display:grid;grid-template-columns:minmax(110px,10rem) 1fr;gap:8px 12px;align-items:center;font-size:13px;margin-top:10px}}
.grp a{{color:var(--ink)}}
.stack{{display:flex;height:22px;border-radius:4px;overflow:hidden;min-width:0}}
.stack span{{display:flex;align-items:center;justify-content:center;font:500 12px var(--f-mono);color:#fff;min-width:0;overflow:hidden}}
.seg-best{{background:var(--ok)}} .seg-average{{background:var(--warn)}} .seg-worst{{background:var(--bad)}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]) .stack span{{color:var(--paper)}}}}
.legend{{display:flex;gap:16px;font-size:12.5px;color:var(--muted);margin-top:10px}}
.legend i{{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}}
.att h3{{margin-top:10px}}
.att ul{{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:10px}}
.att li{{display:grid;gap:2px;font-size:13px}}
.att li span{{color:var(--muted)}}
.att li.empty{{color:var(--muted)}}
.att a{{color:inherit}}
.trend{{display:grid;grid-template-columns:5.5rem 1fr;gap:6px 12px;align-items:center;font-size:13px;margin-top:10px}}
.tiles{{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}}
.tile{{display:flex;flex-direction:column;gap:4px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:14px;min-width:0;break-inside:avoid}}
.tile-head{{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}}
.tile-head h4{{margin:0;font-size:13px;font-weight:600;line-height:1.35}}
.chips{{display:flex;flex-direction:column;align-items:flex-end;gap:4px}}
.chip{{flex:none;font-size:11.5px;padding:1px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}}
.chip-best{{color:var(--ok);background:var(--ok-soft)}}
.chip-average{{color:var(--warn);background:var(--warn-soft)}}
.chip-worst{{color:var(--bad);background:var(--bad-soft);font-weight:600}}
.chip-track,.chip-guard{{color:var(--muted)}} .chip-guard{{border-style:dashed}}
.tile-val{{font:800 28px/1.15 var(--f-display);font-stretch:112%;font-variant-numeric:tabular-nums;margin:2px 0 0}}
.tile-val .u{{font:500 12.5px var(--f-body);color:var(--muted);margin-left:3px}}
.tile-chg{{font-size:12.5px;color:var(--muted);margin:0;font-variant-numeric:tabular-nums}}
.tile-chg .good{{color:var(--ok);font-weight:600}} .tile-chg .bad{{color:var(--bad);font-weight:600}}
.tile-foot{{font-size:12px;color:var(--muted);margin:0}}
.spark{{display:block;width:100%;height:54px;margin:4px 0}}
.spark .ref{{stroke:var(--muted);stroke-dasharray:3 3;stroke-width:1;opacity:.7;vector-effect:non-scaling-stroke}}
.spark .line{{stroke:var(--petrol);stroke-width:2;fill:none;vector-effect:non-scaling-stroke}}
.spark circle{{fill:var(--petrol)}}
.tablewrap{{overflow-x:auto}}
.cr table{{border-collapse:collapse;width:100%;font-size:13px}}
.cr th,.cr td{{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}}
.cr thead th{{font-weight:600;color:var(--muted);font-size:12px}}
.cr td.n,.cr th.n{{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}}
.cr td.nw{{white-space:nowrap}}
.b-best{{color:var(--ok)}} .b-average{{color:var(--warn)}} .b-worst{{color:var(--bad);font-weight:600}}
.grp-row th{{background:var(--petrol-soft);color:var(--petrol);font-family:var(--f-display);font-stretch:112%}}
.scn{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}}
.cr .card.scn-card{{display:flex;flex-direction:column;gap:6px;font-size:13.5px;break-inside:avoid}}
.scn-card p{{margin:0}} .scn-card .label{{margin-top:6px}}
.scn-card ol{{margin:0;padding-left:1.2em;display:grid;gap:4px}}
.scn-card h3{{font-size:19px;display:flex;align-items:center;gap:10px}}
.scn-card.is-current{{border:2px solid var(--petrol)}}
.here{{font:500 11.5px var(--f-body);background:var(--petrol);color:var(--petrol-ink);border-radius:999px;padding:2px 8px}}
.back{{font-size:13px}}
@page{{size:A4 landscape;margin:12mm}}
@media print{{
  body{{padding:0;background:#fff;font-size:12px}}
  .crwrap{{max-width:none;zoom:.74}}
  .cr .card.tablewrap{{overflow:visible;break-inside:auto}}
  .cr tr{{break-inside:avoid}}
  .ov .card{{padding:14px}}
  .jump,.back{{display:none}}
  .page{{break-before:page}}
  .cr{{gap:24px;padding-top:12px}}
  .tiles{{grid-template-columns:repeat(4,1fr)}}
  .card,.tile{{break-inside:avoid}}
  *{{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
}}
</style>
</head>
<body>
<div class="crwrap">
  <header class="mast">
    <div class="brand">
      <div class="seal" aria-hidden="true">GD</div>
      <div><h1>Grievance Desk Control Room</h1><small>Health of the product and the business · Group 5 capstone</small></div>
    </div>
    <a class="back" href="./?demo">Open the product demo</a>
  </header>
  <main class="cr">
    <section class="sec" id="top">
      <p class="headline">{latest} reads as an <b>{BAND_LABEL[scenario]}</b> month: {counts["best"]} of {counted} metrics are in their best band, {counts["average"]} are average and {counts["worst"]} are in the worst band.</p>
      <p class="sample"><b>Sample projection.</b> Every number on this page is illustrative: made up to match the Group 5 capstone's targets for January to June 2027, before the pilot banks report real data. Banks B to E are placeholders.</p>
      <nav class="jump" aria-label="Sections"><a href="#overview">Overview</a><a href="#leading">Leading indicators</a><a href="#financial">Financial health</a><a href="#control">Misuse and viability</a><a href="#tech">Tech health</a><a href="#banks">By bank</a><a href="#scenarios">Scenarios and action plans</a><a href="#definitions">Metric definitions</a></nav>
    </section>

    <section class="sec" id="overview">
      <h2>Overview</h2>
      <div class="ov">
        <div class="card">
          <p class="label">Scenario this month</p>
          <p class="big">{BAND_LABEL[scenario]}</p>
          <p class="small">Worst if a guardrail metric (confidential details stored, or a complaint open past RBI's 30 days) is in its worst band, or {WORST_IF_COUNT} or more metrics are. Best if at least {int(BEST_SHARE * 100)}% of metrics are in their best band and none is in the worst. Average otherwise.</p>
        </div>
        <div class="card">
          <p class="label">Bands by metric group</p>
          <div class="grp">{group_rows}</div>
          <div class="legend"><span><i class="seg-best"></i>Best</span><span><i class="seg-average"></i>Average</span><span><i class="seg-worst"></i>Worst</span></div>
        </div>
        <div class="card att">
          <p class="label">Needs attention</p>
          <h3>In the worst band</h3>
          <ul>{worst_items}</ul>
          <h3>Getting worse three months running</h3>
          <ul>{slip_items}</ul>
        </div>
      </div>
      <div class="card">
        <p class="label">Health by month: number of metrics in each band</p>
        <div class="trend">{trend_rows}</div>
        <div class="legend"><span><i class="seg-best"></i>Best</span><span><i class="seg-average"></i>Average</span><span><i class="seg-worst"></i>Worst</span></div>
      </div>
    </section>

    {group_sections}

    <section class="sec page" id="banks">
      <h2>By bank, {latest}</h2>
      <p class="lede">The same metrics for each live bank, coloured by the same bands as the tiles. A problem in one bank shows up here before it moves the total.</p>
      <div class="card tablewrap">
        <table>
          <thead><tr><th>Bank</th><th>Type</th><th>Status</th><th class="n">Branches</th><th class="n">Complaints</th><th class="n">Within 24 h</th><th class="n">Past 30 days</th><th class="n">Active officers</th><th class="n">Reveals per case</th></tr></thead>
          <tbody>
{bank_rows()}
          </tbody>
        </table>
      </div>
    </section>

    <section class="sec page" id="scenarios">
      <h2>Scenarios and action plans</h2>
      <p class="lede">Three scenarios set by the metric bands. The one that matches this month is outlined. Each metric's own fix is in the last column of Metric definitions.</p>
      <div class="scn">{scenarios}</div>
    </section>

    <section class="sec page" id="definitions">
      <h2>Metric definitions</h2>
      <p class="lede">How each metric is worked out, why it matters, its bands, and what to do when it is in the worst band.</p>
      <div class="card tablewrap">
        <table>
          <thead><tr><th>Metric</th><th>How it is worked out</th><th>Why it matters</th><th>Best</th><th>Average</th><th>Worst</th><th>If in the worst band</th></tr></thead>
          <tbody>
{def_rows()}
          </tbody>
        </table>
      </div>
    </section>
  </main>
  <footer class="foot">
    <span>Sample data for illustration. Source files: capstone/control_room_data/ in the repository.</span>
    <span><a href="./?demo">Grievance Desk demo</a></span>
  </footer>
</div>
</body>
</html>
"""

with open(OUT, "w", encoding="utf8", newline="\n") as f:
    f.write(page)
print("wrote", OUT, "scenario:", scenario, counts)
