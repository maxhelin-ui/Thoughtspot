# Collapsible Pivot

A pivot table where the **columns** collapse — the outline/grouping you get on rows in Excel, but applied across the top instead.

You bind attributes to build a column hierarchy. Every group header gets a small ▾ button. Click it and the group folds down to **its first column**, which stands in for the whole group. Groups nest, so you can have several layers collapsed underneath each other.

---

## Layout (binding columns)

| Zone | Max | What it's for |
|---|---|---|
| **Rows** | 1 | The left-hand labels — a flat list, one row per value. Rows don't group in this chart. |
| **Column groups (outermost first)** | 4 | One nesting level per attribute. The first one you drop is the outermost group, the next nests inside it, and so on. |
| **Measures** | 6 | The numbers in the cells. |

All the grouping happens across the top. Rows stay flat.

**Order matters** in Column groups — first = outermost. Leaving it empty is fine: you just get a flat table of measures.

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

The single `ENT` column under EMEA now represents that whole group, and its header shows a `…` so you can tell it's standing in for more. Click again to expand.

Key points:

- **Collapsing cascades.** Collapse an outer group and everything under it folds to the first path all the way down. Multiple layers can be collapsed at once, independently.
- **It shows the first column, not a total.** This is deliberate — collapsing is for hiding detail while keeping a representative column, not for rolling up. If you want roll-ups, turn on **Show total column**.
- **With several measures bound**, collapsing a group leaves the first sub-group's measures visible (you keep seeing every measure, just for one sub-group).
- **Collapse state is per-session.** It's remembered while the liveboard is open but isn't saved into the chart. Use **Start with column groups collapsed** if you want it collapsed by default for everyone.

---

## Settings

| Setting | What it does |
|---|---|
| **Title** | Optional heading above the table. Leave blank for none. |
| **Number format** | Numeral.js pattern, default `0,0.[0]a` (so `1.2M`). |
| **Currency symbol** | Prefix for non-percent measures. |
| **Start with column groups collapsed** | Everything starts folded. Per-group clicks still override it. |
| **Show total column** | Adds a Total column on the right, one per measure. Totals cover **all** column groups, including collapsed/hidden ones. |
| **Show grand total row** | Adds a totals row at the bottom. |
| **Striped rows** | Alternating row shading. |
| **Show column dividers** | Vertical grid lines. |
| **Label: `<measure>`** | Rename a measure's column header. |
| **Treat "`<measure>`" as a percent (averaged)** | Formats as a percent and **averages** instead of summing. Auto-ticked when the name looks like a rate/ratio/percent. |

---

## Good to know

- **Headers and row labels stay put** when you scroll — both the header rows and the left label columns are pinned.
- **Percent measures are averaged, not summed** — five 70% values summing to 350% is meaningless. Everything else sums.
- **Empty branches are dropped.** A column value that has no data under a particular parent won't render an empty column there.
- **Row cap** is raised to 100,000 because pivots fan out across the row × column cross-product. If totals still look low, you're hitting ThoughtSpot's truncation — reduce the number of bound attributes.
- **Debugging?** Open DevTools and search `[Collapsible Pivot]` to see the bindings, row count, visible column count, and which groups are collapsed.

---

## Limits

- 1 row attribute (flat), 4 column-group levels, 6 measures.
- Collapse state isn't persisted into the saved chart (only the "start collapsed" default is).
- Cells are plain values — no conditional formatting or heatmap shading.
