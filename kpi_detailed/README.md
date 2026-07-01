# KPI — Detailed

A ThoughtSpot custom chart that shows one or more KPIs with progress bars, descriptions, supporting metrics, and footers. Everything is driven by which columns you bind and what you type in the settings. There are two layouts.

---

## Layouts

### Split (default)

One grey card with up to 4 primary "mini-cards" side by side, and an optional row of metric tiles below.

- The grid fits however many primaries you bind (1 column → 1 card, 4 → 4).
- Each primary shows: label, big value, a progress bar (value ÷ denominator), and the percent.
- **Footer N** sits under **primary N**. Bind a footer column → shows `label value`. Type only a label (no column) → just the text shows (handy for a note).
- Metric tiles sit in their own grey boxes below the primaries.

### Main + Secondaries

One big number on top, then one row per metric below it.

- **Top:** primary 1's value (big) + primary 1's description.
- **Rows:** one per metric, shown as `value label`. If a footer is bound to the same position, it's appended after a `·` (e.g. `655 closed accounts · Avg €54.3K`).
- Only **primary 1** is used here — this layout is intentionally one big number. Use Split if you want several.

---

## Layout panel (binding columns)

Four drop zones. Each takes up to 4 columns, except Denominator which takes 1.

| Zone | Max | What it's for |
|---|---|---|
| **Denominator for Primary Values Bar** | 1 | Shared denominator. Every primary's bar fills as `primary ÷ denominator`. |
| **Primary values** | 4 | The big-number cards. Order in the zone = primary 1..4. |
| **Footers** | 4 | Footer N pairs with primary N (Split) or metric N (Main + Secondaries). |
| **Metrics** | 4 | Smaller supporting numbers — tiles under the primaries (Split) or rows (Main + Secondaries). |

**Position matters.** The first column you drop into a zone is item 1, so the "1." settings apply to it; the second is item 2, and so on.

> Tip: dragging onto the single **Denominator** slot can bounce back — drop the column slightly *below* the outlined box and it sticks. (ThoughtSpot quirk.)

---

## Settings

Settings are grouped: **General**, **Primary values**, **Footers**, **Metrics**. Under each group, every bound column gets its own titled sub-section (e.g. `1. CXUC`) so you know which settings apply to which column. Only as many item blocks show as you'll typically need.

### General

| Setting | What it does |
|---|---|
| **Card layout** | `split` (default) or `main-secondaries`. |
| **Header icon** | Small icon in the top-right. Default `none`. |
| **Currency symbol prefix** | € / $ / £ / ¥ / ₹ / kr. Used when a field's format is `currency`. |
| **Green/Red for +/- for Primary Values** | Colours every primary value green if positive, red if negative. |

### Primary values (per column)

| Field | What it does |
|---|---|
| **Format** | `number` (default) · `percent` · `currency`. Auto-switches to `percent` if the column looks like a rate (name or format contains `%`, "rate", "ratio", etc.). |
| **Label** | Small label above the value. Pre-filled with the column name — edit it, or clear the box to hide the label. |
| **Description** | Text next to the big value. Supports tokens `{base}` and `{percent}` (see below). E.g. `of {base} closed accounts ({percent})`. |
| **Bar colour** | Colour of the progress bar and percent. |

### Footers (per column)

| Field | What it does |
|---|---|
| **Format** | Same options as primaries; auto-detects percent. |
| **Label (tokens: `{value}`)** | Shows as `label value` by default. Put `{value}` anywhere in the label to place the number yourself — before, in the middle, or at the end. |

Footer behaviour:
- **Split:** footer N appears under primary N's bar.
  - Plain label → `label value` (e.g. `Avg €54.3K`).
  - Label with `{value}` → the token becomes the number, rest is verbatim (e.g. `we hit {value} this quarter` → `we hit 199 this quarter`).
  - Label only, no column → just the text shows (a footnote).
- **Main + Secondaries:** footer N is appended after metric N's row with a `·`. Same `{value}` rule.

### Metrics (per column)

| Field | What it does |
|---|---|
| **Format** | Same options as primaries; auto-detects percent. |
| **Label** | Shown after the value (Main + Secondaries) or above it (Split tile). Pre-filled with the column name — edit or clear to hide. |

---

## Labels: how they behave

Every label box works the same way:

| The box contains | What shows |
|---|---|
| The column name (the default) | That name. Leave it as-is for a sensible default. |
| Your own text | Your text. |
| Nothing (you cleared it) | No label — just the value. |
| `none` | No label. (Older shortcut, still supported.) |

---

## Description tokens

`Description` on each primary supports two tokens, replaced when the chart renders:

| Token | Becomes |
|---|---|
| `{base}` | The denominator value (plain number, K/M/B abbreviated). |
| `{percent}` | `primary ÷ denominator`, as a percent. |

Examples (primary = 41, denominator = 113):

| You type | Shows |
|---|---|
| `of {base} closed accounts` | `of 113 closed accounts` |
| `({percent} of total)` | `(36% of total)` |
| `vs {base} target` | `vs 113 target` |
| (empty) | nothing — just the number |

---

## Good to know

- **Sizes scale with the tile.** In Split, text and bars grow/shrink smoothly as you resize the tile, up to a maximum.
- **Typing is debounced.** The chart updates shortly after you stop typing, so it doesn't flicker on every keystroke.
- **Multi-row data** is aggregated by the column's own aggregation type (AVERAGE/MEDIAN columns are averaged, MIN/MAX use min/max, everything else is summed).
- **No bar?** The denominator isn't bound, or it's 0.
- **Chart-vs-table mismatch?** Open browser DevTools and search `[KPI - Detailed]` to see the bindings and computed values for each render.

---

## Limits

- Up to 4 primaries, 4 footers, 4 metrics; 1 denominator (shared).
- Main + Secondaries uses only primary 1 — switch to Split for more.
- Single snapshot only — no time-series/trend.
