# KPI — Detailed

A ThoughtSpot BYOC card that renders one or more KPIs with progress bars, descriptions, supporting metrics, and footers. Two visual layouts; everything is driven by which columns you bind and what you type into the visual props.

This doc is the "how to use it" reference for analysts building tiles with this chart. If you maintain the code, see the source in `kpi_detailed/`.

---

## Quick start

1. In a Liveboard tile or Answer, switch chart type to **KPI — Detailed**.
2. Open the **Layout** editor (columns) and bind, at minimum, one column under **Primary values**.
3. Open **Settings** (visual props) and pick your **Card layout**: `split` (default) or `main-secondaries`.
4. Set per-primary **Format** (the chart guesses `percent` vs `number` automatically — override if needed).

That's it. The rest of the controls are about labels, colours, and what to show alongside the primary value.

---

## Bindings (the Layout panel)

Four drop zones. Each accepts up to 4 columns except **Denominator**, which takes 1.

| Section | Max | What it's for |
|---|---|---|
| **Denominator for Primary Values Bar** | 1 | Shared denominator. Every primary's progress bar fills as `primary / denominator`. |
| **Primary values** | 4 | The "big number" cards. Position 1..4 in the dropzone = primary 1..4 in the chart. |
| **Footers** | 4 | Footer N pairs with primary N (in Split) or metric N (in Main + Secondaries). |
| **Metrics** | 4 | Smaller supporting numbers shown under the primaries (Split) or as rows (Main + Secondaries). |

> Position matters. If you drop only one column into **Primary values**, that's primary 1 — all the "1." settings apply to it. Drag a second column in: it becomes primary 2, and the "2." settings light up.

---

## Layouts

### Split (default)

A single grey card with N primary value mini-cards side by side, plus an optional row of metric tiles below.

```
┌───────────────────────────────────────────────────────────┐
│ Label 1      │ Label 2      │ Label 3      │ Label 4     │
│ €199         │ €96          │ €184         │ €1          │
│ ▓▓▓▓░░ 30%   │ ▓▓░░░░ 15%   │ ▓▓▓▓░ 28%    │ ░░░░░░ 0%   │
│ {footer 1}   │ {footer 2}   │ {footer 3}   │ {footer 4}  │
│ ────────────────────────────────────────────────────────  │
│ Metric 1 │ Metric 2 │ Metric 3 │ Metric 4                 │
└───────────────────────────────────────────────────────────┘
```

- The grid sizes to however many primaries you bound (1 → 1 column, 4 → 4 columns).
- Each primary's progress bar uses its colour, fills to `primary / denominator`, and shows the percent on the right.
- Footer N sits under primary N. If you bind a column to footer N, you get `{label} {value}`. If you only type a label (no column bound), just the label text shows.
- Metric tiles run flush against each other inside the same grey card — no per-tile background, thin divider between them.

### Main + Secondaries

The first primary as a big number with an optional description suffix, then one row per metric (with a footer appended after `·`).

```
€-55.6M  of 1,200 closed accounts
655 closed accounts · Avg €54.3K
113 renewals · Median €42.1K
```

- Top: primary 1's value (big) + primary 1's description (suffix).
- Rows below: one per bound metric. Row N is `{metric N value} {metric N label} · {footer N label} {footer N value}`.
- Add more metrics → more rows. Add more footers → each appears after the matching metric's row.
- Primaries 2..4 are ignored in this layout — main + secondaries is intentionally one-big-number.

---

## Settings (visual props)

### General

| Setting | What it does |
|---|---|
| **Card layout** | `split` (default) or `main-secondaries`. See layouts above. |
| **Header icon** | Small icon in the top-right of the card. Default `none`. |
| **Currency symbol prefix** | Dropdown: € / $ / £ / ¥ / ₹ / kr. Applied when a field's format is `currency`. |
| **Green/Red for +/- for Primary Values** | When on, every primary value is rendered green if positive, red if negative, default colour at zero. |

### Primary values (per-item, 1..4)

The accordion contains one sub-section per slot. Each sub-section is titled with the bound column name (e.g. `1. CXUC`) so you always know which settings apply to which column.

| Field | What it does |
|---|---|
| **Format** | `number` (default — auto-detected) · `percent` · `currency`. The chart sniffs the column's format pattern and name (`%`, "rate", "ratio", etc.) and defaults to `percent` when those signals are present. |
| **Label** | The small label above the value. Blank → falls back to the bound column's name. Type a single space to hide the label entirely. |
| **Description — tokens: `{base}`, `{percent}`** | Text shown next to the big value (Split: same line; Main + Secondaries: after the big number). `{base}` is replaced with the denominator's formatted value, `{percent}` with `primary/denominator` as a percent. Example: `of {base} closed accounts (current rate {percent})`. |
| **Bar colour** | Colour of the progress bar and the percent label. Defaults pull from the TS palette. |

### Footers (per-item, 1..4)

| Field | What it does |
|---|---|
| **Format** | Same options as primaries. Auto-detects percent. |
| **Label — tokens: `{value}`** | Default rendering is `{label} - {value}`. Blank → bound column name (so default is `{column name} - {value}`). Type `{value}` anywhere in the label to control where the number lands — useful when you want it in the middle or at the end of a sentence. |

Behaviour notes:

- **Split layout**: footer N appears under primary N's bar.
  - Plain label → `{label} - {value}` (e.g. `Avg - €54.3K`).
  - Label with `{value}` token → token gets replaced with the formatted number; the rest of the label is verbatim (e.g. `we hit {value} this quarter` → `we hit 199 this quarter`).
  - Label only (no column bound) → just the label text shows under the bar (useful for footnotes).
- **Main + Secondaries**: footer N is appended after metric N's row, separated by ` · `. Same `{value}` token rules apply.

### Metrics (per-item, 1..4)

| Field | What it does |
|---|---|
| **Format** | Same options as primaries. Auto-detects percent. |
| **Label** | Text shown **after** the value (Main + Secondaries) / **above** the value (Split metric tile). Blank → bound column name. Single space → no label. |

---

## Labels: the "blank vs space" rule

Every label field follows the same rule, so you can predict what it'll do without checking:

| What you type | What renders |
|---|---|
| (empty) | The bound column's name. This is the default — easy to leave fields alone. |
| `Anything` | `Anything` (leading/trailing spaces are trimmed). |
| ` ` (space) | Nothing. The label is intentionally hidden. Use this when you want only the value. |

---

## Description tokens

`Description` on each primary supports two tokens that the chart substitutes at render time:

| Token | Replaced with |
|---|---|
| `{base}` | The denominator column's value, formatted as a plain number with K/M/B abbreviation. |
| `{percent}` | `primary / denominator`, formatted as a percent. |

Examples:

| Description text | What renders (with primary=41, denominator=113) |
|---|---|
| `of {base} closed accounts` | `of 113 closed accounts` |
| `({percent} of total)` | `(36% of total)` |
| `vs {base} target` | `vs 113 target` |
| (empty) | nothing — the big number stands alone |

---

## Format auto-detection (percent)

When a Format dropdown is left at its default, the chart picks `percent` or `number` based on the bound column:

- The column's numeric format pattern contains `%` → **percent**.
- The column name contains `%` or matches `pct`, `percent`, `percentage`, `rate`, `ratio`, `share`, `uplift` → **percent**.
- Otherwise → **number**.

To force a format regardless of column hints, set the dropdown explicitly.

---

## Common recipes

### "Renewal uplift" KPI (single primary, percent)

- Bind `Uplifted accounts` → Primary values (slot 1)
- Bind `Total closed accounts` → Denominator
- Set primary 1 Description: `of {base} closed accounts ({percent})`
- Card layout: `split`
- Result: one big card showing the uplifted count, a bar to its share of total, and `of 113 closed accounts (36%)` next to it.

### Multi-year vs Single-year (two primaries)

- Bind `Multi-year ARR` → Primary 1, set Label = `Multi-year`
- Bind `Single-year ARR` → Primary 2, set Label = `Single-year`
- Bind `Total ARR` → Denominator
- Card layout: `split` → two cards side by side, each with its own bar.

### Account snapshot (Main + Secondaries)

- Bind `Net ARR Change` → Primary 1, Format `currency`, Description `vs {base} prior period`
- Bind `Renewed Accounts` → Metric 1
- Bind `Renewed ARR` → Metric 2
- Bind `Avg Deal Size` → Footer 2 (will hang off metric 2's row)
- Card layout: `main-secondaries`
- Result: big delta on top, accounts row, then `Renewed ARR · Avg €54.3K`.

---

## Behaviour quirks worth knowing

- **Text-input debounce**: editing Label / Description / Currency fields debounces re-render for 2s of typing-idle. Dropdowns, colour pickers, and checkboxes apply immediately. This keeps the chart from flashing on every keystroke.
- **Long footer text wraps**: footers and descriptions wrap to a second row inside the card if needed.
- **Single-value aggregation**: when the query returns multiple rows, the chart aggregates by the column's declared aggregation type (AVERAGE/MEDIAN columns get averaged; MIN/MAX columns get min/max; everything else gets summed).
- **`primary / denominator` bar**: a primary's bar always fills based on `primary value / denominator value`. If the denominator is 0 or unbound, the bar disappears.
- **Diagnostic log**: open DevTools and search for `[KPI - Detailed]` to see the bindings + computed values for each render — useful when the chart number disagrees with the table.

---

## When things look wrong

| Symptom | Likely cause |
|---|---|
| Card is blank | Nothing bound. Bind at least one column. |
| Bar is missing | Denominator not bound, or denominator value is 0. |
| Percent looks wrong | Format set to `percent` on a column that's not a fraction. The auto-detector handles most cases; override the Format dropdown if needed. |
| Label shows column name when I want it blank | Type a single space into the Label field. Empty = column name; space = no label. |
| Description shows literal `{base}` | The token text is right but the denominator isn't bound. Bind it and the substitution kicks in. |
| Settings panel is empty | TS is loading the chart definition. If it stays empty, hard-refresh the tile. |
| Tile flashes on every keystroke in settings | Should not happen — text inputs debounce 2s. If it does, the chart isn't on the latest version. |

---

## Limits

- 4 primary values max, 4 footers max, 4 metrics max.
- One denominator (shared across all bars).
- Main + Secondaries uses only primary 1 — additional primaries are ignored in that layout. Switch to Split if you want all of them.
- No grouping / time-series — this is a single-snapshot card, not a trend.
