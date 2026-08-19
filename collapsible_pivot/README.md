# Collapsible Pivot

A pivot table where the **columns** collapse — the outline/grouping you get on rows in Excel, but applied across the top instead.

Every group header gets a small ▾ button. Click it and the group folds down to **its first column**, which stands in for the whole group. Groups nest, so you can have several layers collapsed underneath each other.

There are **two independent ways to group columns**, and you can use either or both:

1. **Measure groups (settings)** — hand-pick runs of your own measures into named groups: "these 20 columns are *Assets*, the next 30 are *Usage*". Nothing to do with attributes.
2. **Column groups (layout)** — group by an attribute's *values*, the classic pivot behaviour.

---

## Layout (binding columns)

| Zone | Max | What it's for |
|---|---|---|
| **Rows** | 20 | The left-hand label columns, flat and side by side. Bind as many as you need — one row per combination, no row hierarchy, no collapsing. |
| **Column groups (outermost first)** | 4 | One nesting level per attribute. The first one you drop is the outermost group, the next nests inside it, and so on. |
| **Measures** | 200 | The numbers in the cells. |

All the grouping happens across the top. Rows stay flat.

**What you see when you first pick this chart:** every attribute from your search goes into Rows and every measure into Measures — so it starts as a plain wide table of your query, with nothing grouped. To start grouping by an attribute's values, drag it out of **Rows** and into **Column groups**.

**Reordering:** measures reorder normally by dragging within the Measures slot. Row attributes were previously hard to reorder because the Rows slot was capped at 4 and a nearly-full slot rejects the drop; the cap is now 20, which should let them reorder like measures do. If a chip still springs back, remove the columns from **Rows** and re-add them in the order you want.

**Order matters** in Column groups — first = outermost. Leaving it empty is fine, and is the common case: most grouping here is done with **measure groups** in the settings instead.

Note **Column groups only accepts attributes.** To group measures together, don't drag them here (the chip will bounce back) — use the measure-group settings below.

---

## How collapsing works

Say you bind `Region` then `Segment` as column groups, with one measure:

```
Region    | EMEA                  | AMER                  |
Segment   | ENT   | MID   | SMB   | ENT   | MID   | SMB   |
```

Click the button on **EMEA** and it folds to its first segment:

```
Region    | EMEA  | AMER                  |
Segment   | ENT   | ENT   | MID   | SMB   |
```

The single `ENT` column under EMEA now represents that whole group. The button after the group name shows **+** when it's collapsed (there's more hidden behind it) and **−** when it's open. **Clicking anywhere on the group header toggles it** — you don't have to hit the small button.

Key points:

- **Collapsing cascades.** Collapse an outer group and everything under it folds to the first path all the way down. Multiple layers can be collapsed at once, independently.
- **It shows the first column, not a total.** This is deliberate — collapsing is for hiding detail while keeping a representative column, not for rolling up. If you want roll-ups, turn on **Show total column**.
- **With several measures bound**, collapsing a group leaves the first sub-group's measures visible (you keep seeing every measure, just for one sub-group).
- **Collapse state is per-session.** It's remembered while the liveboard is open but isn't saved into the chart. Use **Start with column groups collapsed** if you want it collapsed by default for everyone.

---

## Grouping your measures

In settings you get 8 group slots. Each has a **name** and a **how many measures** count. Groups eat the bound measures **in order**, left to right:

| Setting | Value |
|---|---|
| Group 1 name / size | `Assets` / `20` |
| Group 2 name / size | `Usage` / `30` |
| Group 3 name / size | `Engagement` / `5` |

With 60 measures bound that gives you *Assets* over the first 20, *Usage* over the next 30, *Engagement* over the next 5, and the remaining 5 left ungrouped at the end.

If a group asks for more measures than are actually available — because fewer are bound than you typed, or earlier groups already used them up — the header shows it plainly, e.g. **"Assets (18 of 51)"**, instead of silently coming up short. Reorder the measures in the **Measures** slot to change which ones land in which group. Leave a name blank or its size at 0 to skip a slot.

Each group slot also has a **colour** picker — pick a background colour for that group's header. Text colour switches automatically between dark and light so it stays readable against whatever you pick. By default the colour only paints the group's own header cell; turn on **Apply group colour to its measure headers too** (a single switch, applies to every group) to also paint the individual measure headers underneath it.

---

## Sorting rows

Every **row label** column and every **leaf measure** column has a small sort arrow after its name (group headers don't — sorting and grouping are independent). Click it:

- **First click** sorts by that column, highest to lowest, and the arrow turns solid.
- **Click the same arrow again** to flip to lowest to highest — the arrow flips to point the other way.
- **Click again** to flip back. It only ever toggles between the two once a column is active.
- **Click a different column's arrow** and that becomes the new sort; the previous column's arrow goes back to idle.

Sorting a specific column sorts by exactly what's shown in that column — if it's a measure under a collapsed or specific group, the sort uses that column's own values, not a total across all groups.

**This is entirely in the chart, for whoever's looking at it.** There's no setting for a default sort — anyone viewing can click any column's arrow to reorder for themselves, and reloading the page always goes back to the normal default order (rows sorted by whatever's bound to Rows).

---

## Settings

| Setting | What it does |
|---|---|
| **Title** | Optional heading above the table. Leave blank for none. |
| **Number format** | Numeral.js pattern, default `0,0.[0]a` (so `1.2M`). |
| **Currency symbol** | Prefix for non-percent measures. |
| **Start with groups collapsed** | Everything starts folded. Per-group clicks still override it. |
| **Collapse / expand all groups** | Folds or unfolds every collapsible group — column groups and measure groups alike — in one shot. It's a one-time action, not a persistent state: after it runs you can still expand or collapse individual groups by hand, and flipping the setting to a different value (or back) re-triggers it. |
| **Freeze first N row label columns (0 = none)** | How many of the left label columns stay pinned while you scroll sideways, counted from the left. `1` by default, `0` freezes nothing. |
| **Group N name / Group N — how many measures / Group N colour** | Defines a measure group and its header colour; see above. |
| **Apply group colour to its measure headers too** | When on, every group's colour also paints the measure headers nested under it, not just the group title. |
| **Show total column** | Adds a Total column on the right, one per measure. Totals cover **all** column groups, including collapsed/hidden ones. |
| **Show grand total row** | Adds a totals row at the bottom. |
| **Striped rows** | Alternating row shading. |
| **Show column dividers** | Vertical grid lines. |

---

## Good to know

- **Resize any column** by dragging the right edge of its header. **Group headers can be dragged too** — that moves the group's right edge (when a group is collapsed, that's just its one visible column). Widths are **saved with the answer**, so they come back next time.
- **Resized headers wrap, they don't truncate.** Squeeze a column and its title flows onto a second (or third) line, staying centred. Untouched columns still size themselves to their title on one line.
- **Headers always stay put** when you scroll vertically. Left label columns are pinned too, but only the first N — see **Freeze first N row label columns**. That pinning is deliberate, not a rendering glitch.
- **Link columns render as links.** ThoughtSpot sends these as `{caption}Name{/caption}https://…`; the cell shows just the name, hyperlinked (http/https only).
- **Percent measures are detected from the column name** (`%`, rate, ratio, share…) and are **averaged, not summed** — five 70% values summing to 350% is meaningless. Everything else sums.
- **Empty branches are dropped.** A column value that has no data under a particular parent won't render an empty column there.
- **Row limits** are whatever ThoughtSpot's default batch is. Pivots fan out across the row × column cross-product, so if totals look low you're hitting truncation — reduce the number of bound attributes.
- **Debugging?** Open DevTools and search `[Collapsible Pivot]` to see the bindings, row count, visible column count, and which groups are collapsed.

---

## Limits

- 4 row attributes (flat), 4 column-group levels, 200 measures.
- Collapse state isn't persisted into the saved chart (only the "start collapsed" default is).
- Cells are plain values — no conditional formatting or heatmap shading.
