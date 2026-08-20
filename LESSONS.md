# Custom ThoughtSpot Chart — Lessons Learned

Compiled across the waterfall, dumbbell, KPI-detailed, multi-axis-bar, and
multi-y-axis-line charts. Read before starting a new viz.

## If the chart doesn't load at all (#1 source of pain)

- `visualPropEditorDefinition` throwing kills the whole chart silently. Wrap every data access with `?.` and `??`.
- `getDefaultChartConfig` throwing also kills it — same issue. Return empty-slot defaults instead and handle the empty case in `render()` with a polite in-chart message.
- **`getQueriesFromChartConfig` must return at least one query with at least one column.** If your defaults bind columns to `[]`, your reducer will produce `[{ queryColumns: [] }]` and the SDK validator rejects it with `"queries[0].queryColumns" must contain at least 1 items` — the chart fails to load with the generic 55009 "Cannot display custom chart". Fix: filter empty queries, and if none remain include a placeholder column from `chartModel.columns[0]`.
- `text` input `defaultValue` cannot be `''` (empty string). Use `' '` (single space). Then in render, `.trim() || fallback` to detect the placeholder. Forgetting this means `?? fallback` never fires.
- Highcharts `columnrange` (and several other types) needs `highcharts-more.js` — easy to forget in `index.html`.
- If the chart URL 403s in a browser tab, it's Vercel Deployment Protection — disable in the Vercel dashboard.
- **Highcharts loaded from `code.highcharts.com` → "Cannot display the custom chart" in export/scheduled/headless, but FINE in your own browser.** That CDN can return 403 to server/headless contexts; the chart then hits `ReferenceError: Highcharts is not defined` → `CHART_RENDER_ERROR`. It still works for *you* because your browser cached the CDN script — so it looks fine on the liveboard but is broken for image export, scheduled refresh, and any headless renderer. **Fix: bundle Highcharts from npm (see SDK imports); never depend on the CDN.** Diagnose by loading the chart in a fresh/headless browser (no cache) and watching the chart iframe console for the 403 + "Highcharts is not defined".

## SDK imports (recurring rollup/tsc trap)

- Never import from `@thoughtspot/ts-chart-sdk/src/...`. Those internal paths aren't in the installed package and Vite/tsc will fail to resolve them. Only use top-level exports.
- **For Highcharts, BUNDLE from npm — never load it from `code.highcharts.com` (or any CDN) via `index.html`.** `import HighchartsNS from 'highcharts'` (+ `import HighchartsMore from 'highcharts/highcharts-more'; HighchartsMore(HighchartsNS)` and `highcharts/modules/<name>` for module series), then `const Highcharts: any = HighchartsNS;` to keep the loose typing. The old "npm-bundled tripped Vite" issue is resolved — bundling builds cleanly and is the only reliable option (the CDN 403s in headless/export, see above).

## Build / Vercel

- `package.json` build script should be just `"vite build"`. Adding `tsc &&` upfront breaks because tsc in bundler mode rejects the SDK's internal paths.
- If the chart lives in a subfolder, Vercel uses *that* folder's `package.json`.
- **Every chart subfolder needs its own `package.json` with `vite build`** so Vercel bundles it. If you ship just `index.html` + `main.js` with no build, the browser sees the raw `import { ... } from '@thoughtspot/ts-chart-sdk'` and throws `Failed to resolve module specifier "@thoughtspot/ts-chart-sdk". Relative references must start with either "/", "./", or "../"`. Symptom: chart never renders, console shows that error. Fix: add a subfolder `package.json` (mirror `custom_bar_chart/package.json` — vite as devDep, sdk + lodash + numeral as deps) and re-deploy.
- **Folder names: snake_case, no spaces.** A folder like `KPI - Detailed/` becomes `/KPI%20-%20Detailed/` in the BYOC URL and can break routing in deployed iframes. Stick to `kpi_detailed/` like the other charts.
- **No external CDN scripts/styles if the deploy uses `default-src 'self'` CSP.** Either bundle the dependency from npm (preferred — works under any CSP) or relax the CSP. Icon webfonts and stylesheets from a CDN will silently fail under the default policy. Inline SVG icons are the safe default.
- `vercel.json` needs `frame-ancestors *` (or specific TS domain) for the iframe to load.
- Vercel Deployment Protection re-enables itself after every deploy by default — disable in the dashboard.

### Per-chart Vercel projects + Ignored Build Step

In a monorepo of charts, each chart can live in its own Vercel project with **Settings → Build and Deployment → Ignored Build Step**:

```
git diff HEAD^ HEAD --quiet -- ./<chart-folder>
```

Exit 0 (no changes in that folder) → Vercel skips the build for that project; exit 1 → builds. This means commits to one chart don't churn through builds of the others.

**Gotcha:** Empty commits do NOT trigger rebuilds when this is configured. An empty commit doesn't change any files, so `git diff` exits 0 and the build is skipped. To force a chart-specific rebuild without touching code, either temporarily clear the Command field in that project's Ignored Build Step → save → push → restore the command, or make a one-character cosmetic change inside the folder. "Deploys haven't appeared in hours for chart X" is almost always this — check git log for the last commit that touched that folder.

A yellow **"Configuration Settings differ from your current Project Settings"** banner means the last successful Production deploy used a different Ignored-Build-Step config than what's now saved. Hit Save to lock the current settings in for future deploys.

## Visual prop types

- `checkbox` works. `toggle` renders but **doesn't fire updates** in TS UI — don't use it.
- `dropdown` needs `values: string[]`.
- `colorpicker`, `number`, `text` all fine (with the empty-default caveat).
- **`visualPropEditorDefinition` can be a function** `(chartModel) => ({ elements: [...] })` — use this to generate per-bound-column inputs dynamically:
  - One colorpicker per measure: `measureColor_<col.id>`.
  - One rename input per measure/slicer: `measureLabel_<col.id>`, `sliceLabel_<col.id>`.
  - Per-slice-value colorpickers: iterate `chartModel.data?.[last]?.data` to find distinct values for each bound slicer, emit `sliceValueColor_<slicerId>_<value>` per unique value.
  - Progressive "add formula" UX: show N+1 formula slots where N is the index of the highest-numbered slot the user has typed into.

## Render event order (the SDK actually checks this)

```ts
const renderChart = async (ctx: CustomChartContext) => {
    try {
        ctx.emitEvent(ChartToTSEvent.RenderStart);
        render(ctx);
        ctx.emitEvent(ChartToTSEvent.RenderComplete);
    } catch (error) {
        console.error('Error during render:', error);
        ctx.emitEvent(ChartToTSEvent.RenderError, {
            hasError: true,
            error,
        } as RenderErrorEventPayload);
    }
};
```

## Resilience patterns

Make every chart match the waterfall's robustness. The patterns the waterfall uses:

- Every `dataArr.columns.indexOf(colId)` is guarded — `if (idx < 0) return 0` (or skip the row). Without this, `row[-1]` silently returns `undefined` and produces zeros, masking the real "column missing from data" issue.
- `if (values.length < 2) return;` style early-exits when there's nothing to draw.
- `renderChartMessage(text)` helper that clears the chart container and writes a centred message ("Add a measure to render this chart"). Replace silent `return;` paths with this — users need to know *why* the chart is empty.

If you find yourself debugging "chart shows blank with valid bindings", the cause is almost always an unguarded `indexOf` returning -1 somewhere.

## Date column handling

Date-bucketed columns come over the wire as **epoch-second strings** (e.g. `"1775001600"`), not formatted date strings.

```ts
function isDateLikeCol(col): boolean {
    if (col?.dataType === DataType.DATE || col?.dataType === DataType.DATE_TIME) return true;
    if (col?.timeBucket != null && col.timeBucket !== ColumnTimeBucket.NO_BUCKET) return true;
    return false;
}
```

- Sort categories **numerically** (by epoch) for date columns — not alphabetically.
- Format display labels via `timeBucket`: MONTHLY → `"Apr 2026"`, QUARTERLY → `"Q2 2026"`, YEARLY → `"2026"`, DAILY/WEEKLY → `"Apr 1, 2026"`, MONTH_OF_YEAR → `"Apr"`, etc.
- Use **UTC** methods (`d.getUTCFullYear()`, `toLocaleString({ timeZone: 'UTC' })`) — viewer's local timezone shouldn't shift bucket boundaries.

## Number formatting

- **Axis labels: always abbreviate** to K/M/B regardless of the user's `numberFormat`. Otherwise verbose formats like `0,0.00` blow up the axis with `1,775,001,600.00` labels. Use `0.[0]a` for non-percent, `0.[0]%` for percent.
- **Tooltip / data labels: respect numberFormat but force abbreviation** — append `'a'` to the format if not present. Keeps user-chosen precision (decimals, grouping) but always gets K/M/B.
- **Detect percent measures by name + format**: `/[\/]/` in the expression (for formulas), or `%/pct/percent` in the column name. Percent measures should be **averaged** across rows that fed each bucket (mean), not summed — five 70% values summed to 350% is meaningless.
- **Currency symbol on labels only**: strip the leading `[\$€£¥₹]` from the axis format so the axis stays clean, then prepend the symbol again for tooltip values.

## Data aggregation & truncation (the formula workaround)

TS GROUP BYs across every column you put into a single `Query`. With many bound attributes, the cross-product cardinality explodes and TS silently drops groups when it hits the row limit. Symptom: slice values disappear under broad filters, totals undercount, and the SAME quarter shows different values when filters change.

**Don't** bind 5+ attribute columns to a single `Query` without considering this. If you must, set `queryParams.size: 100000` to push past the default row limit.

**Don't** try to fix percent-measure aggregation by averaging at the chart side. The percent at the (Month) GROUP BY level is *not* the mean of the percents at the (Month, Region) level — it depends on the underlying counts. You can't recover the coarse percent from finer-grained percent rows.

**Do** use the formula pattern: bind the raw SUM components (numerator + denominator) to a "Formula inputs" slot, define a formula in settings like `Multi Year / (Multi Year + Single Year)`, and the chart sums the inputs per (x, slice) and divides. SUM is aggregation-invariant, so the ratio is the same regardless of GROUP BY granularity.

### Formula pattern recipe

1. Add a `formulaInputs` dimension to `chartConfigEditorDefinition` (measures only).
2. In `visualPropEditorDefinition` add a "progressive" set of formula slots: name + expression + colour per slot, where slot N+1 appears once the user has filled slot N.
3. Read `formula1Name`/`formula1Expr` etc. in render, build a list of `{name, expr}`.
4. CSP-safe math evaluator (recursive descent — never use `Function`/`eval`):
   - Parse digits, `.`, scientific notation, unary `+/-`, binary `+ - * /`, parens.
   - Substitute column names with their numeric values FIRST (longest-name-first so `ARR` doesn't clobber `Renewed ARR`).
   - Support `[Bracketed Name]` syntax for names with spaces.
   - **Match column names case-insensitively** and **normalize runs of whitespace** so the user doesn't have to byte-match.
   - After substitution, if any letter or bracket remains in the expression, the name is unresolved → return null → render as 0.
5. **Formulas-referencing-formulas**: iteratively resolve formulas — each pass tries `evalFormula(expr, valuesByName)` for each formula whose name isn't yet in `valuesByName`; if it resolves, add the result. Bounded by the number of formulas to cap cycles.
6. **Diagnostic logs are critical**: print `EXPRESSION`, `BOUND NAMES`, `AFTER SUBSTITUTION`, `RESULT` on separate `console.log` lines (not collapsed inside one Object) so the user can spot which name didn't resolve.

### Critical reminder

A formula can only reference columns the chart actually receives, which means columns **dragged into a chart slot** — not just "in the search". If your `BOUND NAMES` log doesn't include a name your expression mentions, bind that column to either `yOptions` or `formulaInputs`.

## Highcharts tips

- **`chart.reflow()` after container changes.** When you set padding on outer divs after the chart has rendered, Highcharts doesn't auto-resize — the SVG keeps its original dimensions and overflows. Call `reflow()` to make it remeasure.
- **Shared tooltip ordering**: with `shared: true`, sort `this.points` by `p.y` descending so the entry at the top of the tooltip matches the line that's visually highest at that x point.
- **Stacked-by-slice bars**: when a slicer is bound, force `stacking: 'normal'` and tag each series with `stack: m<measureIdx>` so series for the same measure stack together but different measures land side-by-side (grouped-stacked bars).
- **In-bar segment labels vs stack totals**: keep segment labels at normal weight (`fontWeight: '400'`) and stack totals at bold (`fontWeight: '700'`) so the total is visually emphasised over its sub-labels.

## Layout patterns

### CSS Grid for button areas

For charts with switchable buttons (Y-axis switcher, slicer toggles, etc.), use a 5-area grid:

```css
#layout {
    display: grid;
    grid-template-rows: auto 1fr auto;
    grid-template-columns: auto 1fr auto;
    grid-template-areas:
        "top    top    top"
        "left   chart  right"
        "bottom bottom bottom";
    width: 100vw;
    height: 100vh;
    overflow: hidden;
}
```

`overflow: hidden` on body + `#layout` prevents stray page scrollbars when content overflows.

### Aligning buttons to the chart's gridlines

Pin chart margins to fixed values (e.g. `marginLeft: 80, marginRight: 40`) so plot positions are predictable, then `padding-left = plotLeftAbs` on the button area aligns its content with the chart's gridline.

**Wrapped rows must use `padding-left`, not a flex spacer.** A leading flex spacer only fills the start of row 1; wrapped rows have no padding and end up at the layout's left edge. `padding-left` on the container applies to every wrapped row, keeping all rows aligned with the gridline.

Set `padding-right: 0` so each row can extend to the layout's right edge before wrapping (more horizontal room before items spill into a new row).

### Custom legend that flows with buttons

Don't wrap legend items in their own flex container. Append each `.legend-item` as a **direct sibling** of the button groups in the top area:

```css
.legend-item {
    flex-shrink: 0;
    white-space: nowrap;
}
```

`#topArea`'s `flex-wrap: wrap` then distributes everything (buttons + legend items) across rows naturally. Each item is treated as an atomic unit — they wrap to a new row instead of getting truncated mid-text.

### Highcharts container reflow on layout change

When the button-area padding changes the chart cell size, the chart SVG can end up larger than its container and produce a horizontal scrollbar in the chart cell. Call `chart.reflow()` at the end of `alignButtonAreasToPlot()` so the chart re-measures its new container size.

## Switchable Y-axis / X-axis pattern

For charts where the user picks one of N bound measures or attributes via on-chart buttons (multi-axis-bar's X, multi-y-axis-line's Y):

- Bind multiple to a `yOptions` / `xOptions` slot.
- Render a button per option; **skip rendering the button row when there's only one option** (no point in a one-option switcher).
- Module-level `activeYColumnId` / `activeXColumnId` tracks the choice; self-heal to first bound when the column is removed.
- Y-axis title defaults to the active measure's name when the user leaves the setting blank — handle whitespace-only defaults explicitly (`yAxisTitleRaw.trim() ? yAxisTitleRaw : activeY.name`).
- Y-axis formatter adapts to the active measure (`yIsPercent` detection at render time, not once at init).

## Multi-slicer color + legend strategy

When a chart supports multiple toggleable slicers (multi_y_axis_line):

- **Legend = one item per (active slicer, distinct value)**, NOT per cross-product combination. With 2 slicers each having 3 values you get 6 legend items, not 9. Prefix with slicer name when more than one slicer is active (`Region: APAC`).
- **Hidden tracking is per-slicer-per-value**: `Map<slicerId, Set<value>>`. A cross-product series is hidden if ANY of its component values is in the corresponding slicer's hidden set. Lets the user "zoom in" by toggling individual values off.
- **Color hierarchy**:
  - 1 active slicer → each line uses its primary value's user-picked color (`sliceValueColor_<slicer>_<value>`), falling back to a shade of the slicer's base.
  - 2+ active slicers → use the PRIMARY value's color, then derive light/dark shades from the SECONDARY slicer's value index. Each primary value keeps its picked color; secondary just varies lightness within that hue.
- **Hidden-value lifecycle**:
  - Adding a new slicer (toggle on) → keep existing hidden values for the original slicer (existing "zoom-in" state persists).
  - Removing a slicer (toggle off OR unbind from the chart) → clear that slicer's hidden values so re-activating starts fresh.
- **Slicer value ordering in the legend**: preserve insertion order from `dataArr.dataValue` — that matches whatever default sort TS applied to the column. Don't `localeCompare` it.

## Date filter sanity check

If you see different aggregates for the same quarter under different overall date filters, suspect TS truncation. Log `samplingRatio` / `completionRatio` / `totalRowCount` from `chartModel.data[i]` to confirm. Fixing it requires the formula pattern (above) or fewer GROUP BY attributes — not more chart-side averaging.

## SDK gotchas you'll hit

- `emitEvent(GetDataForQuery, ...)` resolves to `Promise<any>` — the response shape isn't documented. Multi-query approaches (one Query per X option) didn't reliably return per-query data in our tests and broke the slicer. **Stick to single combined queries.** The simplest fix for "too many rows" is `queryParams.size: 100000`, plus the formula pattern for correct ratios.
- `chartModel.data` is `QueryData[]` — if you emit multiple queries, you'd get multiple entries. Picking the right one based on column ids was unreliable; another reason to use a single query.

## Workflow

- Every squash-merge diverges the feature branch. Before each new PR: `git rebase origin/main && git push -f`.
- After a merge, wait ~30s for Vercel, then hard-refresh in TS (Cmd/Ctrl+Shift+R).
- If a chart's Vercel project isn't redeploying after a push, check git log for the last commit touching that folder — and check the project's Ignored Build Step.

## Settings panels in TS (for end users)

- **Chart configuration** (where columns go): three-dot menu on chart → *Edit chart configuration*.
- **Visual properties** (where `visualPropEditorDefinition` lives): separate panel — usually *Edit visualization* / settings cog. Different from chart configuration.

## In-chart UI controls

The `index.html` `#buttonContainer` (or `#topArea` etc.) div is mounted above the chart. Use it for dashboard-viewer-facing controls (toggle buttons, measure switchers, pager arrows) that should work without entering edit mode. Combine with a module-level state variable that persists for the page lifetime; reset it when the corresponding settings default changes.

## Debug checklist when the chart doesn't show

1. Open the chart URL directly in a browser tab — if it 403s, it's deployment protection.
2. If it loads but errors, check devtools console. Common errors:
   - `Failed to resolve module specifier "@thoughtspot/ts-chart-sdk"` → chart isn't being bundled. Subfolder needs its own `package.json` + `vite build`.
   - `"queries[0].queryColumns" must contain at least 1 items` → your `getQueriesFromChartConfig` is returning an empty query. Add a placeholder column fallback.
   - CSP `Refused to load the stylesheet/script` → external CDN blocked by `default-src 'self'`. Bundle from npm or drop the dependency.
3. If TS shows nothing, check Vercel build log for a failed deploy.
4. Verify the custom viz is pointed at the correct Vercel URL in TS settings.
5. If "deploy hasn't appeared in hours", check whether the chart's folder has any changes since the last successful build — Ignored Build Step might be skipping it.

## Visual prop editor: sections (`type: 'section'`)

The TS prop-editor host (BYOC SDK) is picky about `type: 'section'` elements. Hard-won rules:

- **A section with a `children` array displays, but the host DROPS all child prop changes.** Fields nested inside a section render visually but never persist — dropdowns do nothing, text inputs don't save, colour pickers don't apply. So **never put real fields inside a section's `children`.** Keep every editable field at the top level of `elements`.
- **A section with NO `children` key at all → "cannot display the custom chart" (hard crash).**
- **A section with `children: []` (empty array) works perfectly as a heading** — bigger/bold title with natural spacing, no input box. This is the only reliable way to add section/sub-section headings. Use a helper: `{ key, type: 'section', label, layoutType: 'none', children: [] }`.
- **Consecutive childless sections are fine** (e.g. a group header `Primary values` immediately followed by an item header `1. CXOC`). Earlier suspicion that back-to-back sections crash was WRONG — verified working.
- **Empty-string text defaults (`defaultValue: ''`) can make the host refuse to render.** Use a single space `' '` as the default for text inputs.

## Visual prop editor: dynamic element lists are unreliable

`visualPropEditorDefinition` can be a function `(chartModel) => ({ elements })`, and reading bound columns to vary the element list at runtime *seems* supported — but **emitting a DIFFERENT NUMBER of elements based on bound-column counts crashed the chart** ("cannot display"). Baking the bound column NAME into a static set of element labels is fine; changing how MANY elements exist is not. Keep the element COUNT static (always emit MAX slots); only vary label text.

## Filling the tile height

By default the card is content-height, leaving white space at the bottom of taller tiles. To fit the tile: chain `height: 100%` from `html, body` down through the card wrapper, and `flex: 1` the visible layout + its grey detail card so it grows to fill available vertical space (bounded by the tile, so it never grows infinitely).

## Editor text inputs: debounce ALL re-render triggers (typing lag / dropped edits)

Symptom: typing into a visual-prop text box lags, the chart re-lays-out on every
keystroke, and/or the final typed text sometimes doesn't show in the chart.

Cause: on every keystroke the host fires BOTH `onPropChange` AND the
`TSToChartEvent.ChartModelUpdate` event. If either calls your render
synchronously, you re-render per character. Debouncing only `onPropChange`
is not enough — `ChartModelUpdate` still thrashes the chart.

Fix: funnel BOTH through a single debounced scheduler (~250ms). Keep
`DataUpdate` (real data) immediate. The latest scheduled call wins, so the
final typed value is what renders. Pattern:

```js
let renderTimer = null;
function scheduleRender(ctx, model) {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { renderTimer = null; renderChart(ctx, model); }, 250);
}
// onPropChange: () => scheduleRender(ctx)
// ChartModelUpdate: (p) => { scheduleRender(ctx, p?.chartModel); return { triggerRenderChart: false }; }
// DataUpdate: render immediately
```

This applies to every BYOC chart with text settings — worth copying into each.

## Dragging a column onto a `maxColumnCount: 1` section "jumps back"

Single-column config sections (e.g. a denominator slot) have a finicky, short
drop target — dropping directly on the outlined box often bounces the column
back. Workaround: drop slightly BELOW the outlined box. This is a ThoughtSpot
host DnD quirk, not something the chart code can control.

## Editable default = column name (instead of a fake "blank" sentinel)

To make a text setting show a sensible default that the user can edit or
clear, set its `defaultValue` to the dynamic value (e.g. the bound column
name) inside the `visualPropEditorDefinition` function. The box shows the
name, the user can overwrite it, and clearing it means "hide". In render,
treat `undefined` (untouched) as the default, `''` (cleared) as hidden.
Empty-string defaults crash the host, so fall back to a single space `' '`
for slots with no dynamic value (e.g. an unbound column). Keep any old
sentinel (like typing `none` → hidden) for back-compat with saved charts.

## Smooth resize: clamp() + vw, not media-query breakpoints

Fixed px sizes jump at `@media` breakpoints as the tile resizes. For smooth
scaling, size fonts/bars with `clamp(min, Nvw, max)`. Inside a BYOC iframe,
`1vw` = 1% of the iframe = the tile width, so text grows/shrinks continuously
with the tile and is capped at `max`. Drop the per-size media-query overrides
for anything using clamp (keep breakpoints only for things clamp can't cover,
e.g. a fixed-size sibling layout or the corner icon).

## Debounce follow-up: stale model at fire time (typed text still missing)

Even with all render triggers debounced, the chart can render WITHOUT the
last keystrokes: when the debounce fires, `ctx.getChartModel()` may still
lag behind what the user typed (the SDK cache updates asynchronously).

Fix: keep a `pendingProps` map. `onPropChange(key, value)` records every
edit; at render time overlay `{ ...model.visualProps, ...pendingProps }`
so the freshest typed values always win. Reconcile on host events
(`ChartModelUpdate` / `VisualPropsUpdate`): delete a pending key only when
the host's copy matches its value — never blanket-clear, events can arrive
out of order vs keystrokes. Also listen to `VisualPropsUpdate`; some host
versions push prop edits there instead of `ChartModelUpdate`.

## Debounce follow-up #2: apply the pendingProps overlay EVERYWHERE, not just the debounced path

The `pendingProps` overlay (above) only helps if every render entry point
uses it. It's easy to miss one: a `DataUpdate` (or any other host event that
can fire mid-edit, not just literal data changes) often renders immediately,
un-debounced, straight from `ctx.getChartModel()` or a hand-built model —
bypassing the overlay entirely. If that fires while the user is typing, it
redraws the chart from the host's (possibly stale) model and visibly drops
whatever was just typed, even though the debounce/overlay logic elsewhere is
correct.

Fix: route every render call — debounced or immediate — through the same
`withPendingProps` helper. Also make sure the "last known good model"
fallback variable is actually assigned somewhere (e.g. inside the main
render function itself); a fallback that's declared but never written is a
silent no-op that's easy to miss in review.

## ColumnType is MEASURE=1, ATTRIBUTE=2 — never hardcode the number

`getDefaultChartConfig` is a top-3 cause of "Cannot display the custom chart",
and this is a silent way to break it. The enum is:

```
UNKNOWN = 0, MEASURE = 1, ATTRIBUTE = 2, VIRTUAL = 3
```

Filtering attributes with `c.type === 1` actually selects **measures**. If the
default config then seeds a measure into a section declared
`allowMeasureColumns: false` (or an attribute into a measure-only section), the
host rejects the config at init and the chart never loads — no console error
from your code, just the generic "Cannot display the custom chart".

Always `import { ColumnType }` and compare against `ColumnType.ATTRIBUTE` /
`ColumnType.MEASURE`. Symptom to watch for: the chart fails only on worksheets
with a particular attribute/measure mix (it can accidentally "work" when the
seeded columns happen to be type-compatible).

## Diagnosing "Cannot display the custom chart" from outside ThoughtSpot

You don't need the TS host to rule out half the causes. Against the chart's
**production** Vercel domain:

1. `curl -sD- <domain>/` — expect `200` + your HTML. A `302` to
   `vercel.com/sso-api` plus `x-frame-options: DENY` is Deployment Protection,
   and the iframe can never load.
2. Grab the `<script src>` from that HTML and curl it — confirms the bundle
   built and is being served (check for a couple of your own string literals;
   function names are minified away).
3. If both pass, the page is fine and the failure is SDK-side config
   validation — look at `getDefaultChartConfig`, `getQueriesFromChartConfig`,
   and `visualPropEditorDefinition` in that order.

**Test the production domain, not the deployment URL.** Per-deployment URLs
(`<project>-<hash>-<org>.vercel.app`) are SSO-protected by default even when
the production domain (`<project>.vercel.app`) is wide open — testing the wrong
one sends you chasing a Deployment Protection problem that doesn't exist.

## Build a fake-host harness instead of guessing at "Cannot display" / error codes

ThoughtSpot's chart errors (55003 etc.) are opaque: no code mapping in the SDK,
nothing public, and your own `console.error` never fires because the failure is
in the host's validation of what your chart returned. Guessing burns days.

The whole host side is just `postMessage` + `MessageChannel`, so you can fake
it locally in ~80 lines. A page that iframes the chart and sends
`Initialize` → `GetDataQuery` → `InitializeComplete` → `ChartModelUpdate` →
`TriggerRenderChart`, logging every `source:'ts-chart-sdk'` message coming back,
reproduces the real handshake and shows you the actual response objects.

Harness gotchas:
- **`hostUrl` must be a real origin.** The SDK passes it straight to
  `postMessage(msg, targetOrigin)`, so `hostUrl:'harness'` makes every
  `emitEvent` throw — you'll see `InitStart` (hardcoded `'*'`) and then silence,
  which looks exactly like "the chart never renders".
- Reply on `event.ports[0]` — the SDK awaits that port for every event.
- Serve the harness from the SAME origin as the built chart if you want to
  inspect/click inside the iframe; cross-origin blocks `contentDocument`.
- Drive it with a realistic model (right column COUNT and right
  `ColumnType`s) — bugs here are shape-dependent.

Assert on invariants, not just "did it render": for a table, check on every
header row that Σcolspan (accounting for rowSpan carry-down) equals the body
cell count. That caught a real misalignment a screenshot did not.

## Chart works in the harness but not in ThoughtSpot? Suspect the SAVED config

`validateConfig` defaults to `() => ({ isValid: true })`. If you don't define
it, **any** previously-saved chart config is reported valid forever — including
one written by an earlier, buggy build of your chart. Fixing
`getDefaultChartConfig` only helps NEW charts; existing visualizations keep
handing back the broken config and keep failing.

Always implement `validateConfig` to check the saved config against your own
section rules (right column types in each slot, required slots non-empty,
counts within `maxColumnCount`). Return `isValid:false` and the SDK falls back
to `getDefaultChartConfig`, so bad saved state self-heals instead of wedging.

## ThoughtSpot link columns arrive as `{caption}…{/caption}URL`

Link/attachment columns don't come through as plain text — the raw value is
`{caption}Display Name{/caption}https://real/url`. Render it verbatim and the
cell shows the whole URL blob. Parse with
`/^\{caption\}([\s\S]*?)\{\/caption\}([\s\S]*)$/`, show group 1 as the text,
and only use group 2 as an `href` when it matches `^https?://` (never emit
`javascript:`/`data:` from cell data).

## Persisting chart-local UI state (column widths, etc.) — use `clientState`

Visual props the user never edits (dragged column widths, pinned state, any
in-chart UI the chart itself mutates) belong in `visualProps.clientState`. It's
the one key the SDK preserves across changes to `visualPropEditorDefinition`;
everything else not listed in `persistedVisualPropKeys` gets dropped. It must
be a STRING — `JSON.stringify` your state object.

Write it back with
`ctx.emitEvent(ChartToTSEvent.UpdateVisualProps, { visualProps: { ...current, clientState } })`.
Spread the existing visualProps or you'll wipe the user's real settings.

Pattern that works for drag-resize:
- Keep a module-level `Record<colKey, px>` as the live source of truth; seed it
  from `clientState` ONCE (a `seeded` flag), so a re-render can't clobber a
  width the user just dragged.
- Put `mousemove`/`mouseup` listeners on `document`, not the grip — the pointer
  routinely leaves a 7px handle mid-drag.
- Emit `UpdateVisualProps` on `mouseup` only. Emitting per `mousemove` floods
  the host with postMessages.
- Key columns by something stable across collapse/expand (the node's path key),
  not by column index.
- Apply the width to the header cell AND every body cell in that column, and
  set `width`/`minWidth`/`maxWidth` together — with `table-layout: auto` a lone
  `width` is only a hint and long content will force the column back open. Add
  `overflow:hidden; text-overflow:ellipsis` so content clips instead.

## Sticky table headers: three CSS traps

Building a scrollable table with frozen headers/columns, these each cost a
debugging round:

1. **A later `position: relative` on the same selector silently un-sticks your
   header.** Adding `thead th { position: relative }` so an absolutely
   positioned resize grip has a containing block overrides the earlier
   `position: sticky` — headers stop sticking and nothing warns you. `sticky`
   is ALREADY a containing block for absolute children, so just delete the
   rule. Assert on `getComputedStyle(th).position === 'sticky'`, since it looks
   fine until you scroll.

2. **Horizontal padding on the scroll container makes columns visible to the
   left of a frozen column.** `left: 0` is relative to the scrollport, which
   INCLUDES the container's padding, so a `padding-left: 12px` leaves a 12px
   strip where scrolling content shows through beside the pinned cell. Put the
   padding on the table (or the cells), never on the element that scrolls.

3. **Letting every header wrap collapses a wide table.** With `white-space:
   nowrap`, columns size to their content and the table stays wide and
   horizontally scrollable. Switch headers to `white-space: normal` globally
   and the browser instead shrinks all 60 columns to fit the tile, turning
   every title into a vertical tower of letters. Apply wrapping ONLY to columns
   with an explicit user-set width (a `.sized` class alongside the inline
   width); leave the rest nowrap.

Related: a cell that spans header rows (`rowSpan`) defaults to
`vertical-align: middle`, so its text floats halfway down and reads as a gap
under the group title above it. `vertical-align: bottom` puts the rowspanning
label on the same line as the leaf column names.

## Reordering columns within ONE multi-column config section — and why the fix is NOT free

Drag-to-reorder chips inside a single multi-column section (`maxColumnCount: 4`)
does not work in the ThoughtSpot layout panel; the chip springs back. This is
NOT your `validateConfig` rejecting it — proved with a harness by sending a
genuinely reordered `ChartConfigValidate` payload: `isValid` came back `true`
and `GetDataQuery` preserved the new order. The bounce happens in the host UI
before the chart is consulted.

The obvious fix — split the section into N single-column sections (`row1`..
`row4`) — **breaks every chart that already has a config saved against the old
key**, with "Cannot display the custom chart". Changing a `columnSections` key
orphans the saved config's dimension key, and the host rejects it at init even
though `validateConfig` returns `isValid:false` and a valid replacement from
`getDefaultChartConfig`. A local fake-host harness will NOT catch this: the
harness doesn't run ThoughtSpot's own config validation, so init succeeds and
the chart renders perfectly in the harness while failing in the product.

Takeaways:
- **Renaming/splitting a `columnSections` key is a BREAKING change** for saved
  answers. Treat it like a schema migration, not a UI tweak.
- The harness verifies YOUR code, not the host's validation. Anything that
  changes the config *shape* still needs a real-instance test before shipping.
- Ship shape changes on their own, never bundled with unrelated fixes, so a
  revert doesn't take working fixes down with it.

## A resize/drag grip that overflows into a sibling cell gets covered by it

Positioning a drag handle at `right: -3px` so it visually sits ON a cell
border (straddling into the next `<td>`/`<th>`) breaks unpredictably once
BOTH cells are `position: sticky` (or otherwise separately stacked): each
sticky element is its OWN stacking context, so the grip's local `z-index`
only wins comparisons against siblings inside its OWN cell — it can't
out-rank the next cell's entire stacking context, which (being later in DOM
order) paints over the overflowing sliver regardless of the grip's z-index.

Symptom is exactly this confusing: the very LAST column in a row has no
sibling to be covered by, so it resizes fine; every other boundary is
unreliable depending on precisely where in the sliver you click — which
reads as "some columns work, some don't," not "resizing is broken."

Fix: keep the grip **fully inside its own cell's box** (`right: 0`, not
negative). No cross-cell stacking-context comparison needed once the
grip never leaves the cell it belongs to.

## Silent truncation reads as "the setting isn't working"

If a numeric setting can request more than's actually available (a measure
group asking for 51 columns when only 20 are bound, a page size bigger than
the row count, etc.), NEVER just quietly clamp it. From the user's side that
looks identical to a broken setting — nothing on screen indicates why 51
became 20. Show the shortfall directly where the result renders, e.g. a
group header reading `"Assets (20 of 51)"`, and log the requested vs. actual
counts in the diagnostic console output. Costs one string template; saves a
support round-trip every time someone hits the limit.

## A nearly-full config section silently refuses drag-reorder

If users report they can reorder chips in one multi-column section but NOT
another, compare the sections' `maxColumnCount` before assuming it's a host
bug. A section at (or close to) capacity rejects the drop that a reorder is
implemented as, so the chip springs back — indistinguishable from "reordering
is broken". In this chart, `measures` allowed 200 and reordered fine while
`rows` was capped at 4 with 3 bound and would not.

Set `maxColumnCount` to a generous sanity cap rather than the number you
expect people to use. It costs nothing and avoids a failure mode that looks
like a platform limitation.

## Make the whole header the hit target, not a 15px button

A collapse/expand affordance rendered as a small button inside a header is
easy to miss and easy for any overlapping absolutely-positioned element (a
resize grip, a tooltip layer) to intercept — which users report as "this
group won't collapse". Put the click handler on the whole header cell and
keep the button purely as the visual affordance
(`btn.onclick = e => { e.stopPropagation(); toggle(); }` so it doesn't fire
twice). Costs two lines, removes an entire category of "it doesn't respond".

## "Sometimes my saved state doesn't stick" — re-assert, don't just write once

Writing chart-local state to `visualProps.clientState` once (on the gesture
that changed it) is not enough. Anything else that rewrites visualProps — a
settings-panel edit, some host round-trips — can come back WITHOUT your
clientState, silently dropping it. The user sees "it saved that time but not
this time".

Fix: on every render, compare the host's copy against your local copy and push
yours back when they differ. Two traps doing this:

1. **Don't guard the re-assert with "what I last sent".** A `lastPersisted`
   string is right for skipping no-op writes, but the self-heal path must be
   able to bypass it (`commit(force = true)`) — the whole point is that the
   host does NOT have what you last sent. Guarding on it makes the self-heal
   silently never fire, which is exactly the bug you were fixing.
2. **Guard against a host that never echoes back**, or you emit on every
   render forever. Key the re-assert on the PAIR `(hostState, localState)` and
   fire once per distinct pair.

Verify both halves explicitly: that it re-asserts after a simulated drop, AND
that N further renders produce zero extra emits.

## Ambiguity is not a reason to omit an affordance

This chart deliberately gave resize grips only to leaf headers, reasoning that
"dragging a group header's edge is ambiguous about which column it resizes."
Users then reported the groups as broken — they had no way to widen a group,
especially a collapsed one (where the group IS a single column and there's
nothing ambiguous about it at all).

Pick the sane interpretation and ship it: a group's right edge resizes the
LAST leaf column inside it. Two details make it work:
- Do NOT tag the spanning `<th>` with that column's key, or width-application
  will force the whole multi-column header to one column's width.
- A drag that ends on a clickable header fires a click afterwards. Suppress
  the toggle for ~400ms after `mouseup`, or every resize also collapses the
  group.

## Use SVG icons, not text glyphs like "+" / "−" / "▾", for anything that must be pixel-centered

A `+`/`−`/chevron rendered as a font character doesn't sit at the visual
centre of its own font-metrics box — different fonts put different amounts of
"ink" above vs below the baseline (a `+` typically has zero descender, so it
visually floats high in a normal line box). Inside a flex container this is
un-fixable by CSS alone: `vertical-align` has no effect on flex children, so
the only lever is `align-items` (centers box heights, not glyph ink) or a
manual `padding`/`transform` nudge tuned to one specific font. That nudge
breaks the moment the host renders in a different font than whatever you
tested with — and a custom corporate webfont (this repo's `Optimo-Plain`)
usually isn't loadable in a local dev/test harness at all, so you can't even
verify the nudge before shipping it.

Fix: use a small inline SVG (`stroke="currentColor"` so it still inherits the
button's color) with a symmetric viewBox — a plus is two centered strokes, a
chevron is a centered V. It centers by geometry, which is exact in every font
on every host, with zero tuning. Costs a few lines of SVG path data, and
permanently removes an entire category of "recenter this pixel" back-and-forth
with a user who can see a font you can't.

## Don't let a shared header-icon style undermine a color-contrast feature

When a header can have a custom background color (a colorpicker `contrastTextColor` feature), an icon SITTING ON A FIXED-COLOR BADGE inside that header should generally keep the badge's own fixed contrast (dark icon on a light-grey pill stays dark regardless of the header behind it) — it's a self-contained control, not text painted directly on the header background. Before "fixing" an icon that looks like it isn't inheriting the header's dynamic text color, check what it's actually sitting on: if it has its own background, forcing it to inherit would make it invisible against ITS OWN box, not more readable.

## `validateConfig` returning false is DESTRUCTIVE — treat it as a last resort

`validateConfig` sounds advisory. It isn't. Returning `{isValid:false}` has two
side effects, and users experience both as "the chart rearranges itself":

1. **At init**, the SDK answers a false by calling `getDefaultChartConfig()` and
   handing the result to the host, which adopts it. If your default seeds "every
   attribute and every measure in the search" (a reasonable default for a FRESH
   chart), one spurious false silently re-binds columns the user had deliberately
   left unvisualised, and reorders the rest into `chartModel.columns` order —
   which is why formula columns, sorting last in that array, visibly migrate to
   the end.
2. **On `ChartConfigValidate`** (fired while the user edits the layout), a false
   makes the host REJECT the edit and snap the layout back.

So any condition you put in there fires on transient, mid-edit states too. A
check as innocent as `if (rows.length < 1) invalid` means "the moment the user
drags their only row attribute out, blow away their entire column selection."

Rule: reject ONLY a config that is unusable AND that you'd genuinely want reset
from scratch — in practice, one that binds nothing at all. Everything else
(missing rows, missing measures, a wrong-typed column left over from an old
build) should return `isValid:true` and be surfaced by `render()` as an on-chart
message. A message costs the user nothing; a reset costs them their layout.

Regression test worth keeping: feed a CURATED config (a scrambled subset of the
available columns) through `ChartConfigValidate` + `ChartModelUpdate`, and assert
the rendered columns match the subset EXACTLY, in order — same count, same
sequence. And note `ChartModelUpdate` only stores the model and returns
`{triggerRenderChart:true}`; the host must then send `TriggerRenderChart`, so a
harness that omits it will silently keep testing the previous model.

## Viewer-adjustable vs author-saved: gate the WRITE, not the interaction

In-chart controls fall into two camps and the difference matters to users:
state an author configures (should be saved with the answer) vs state a viewer
fiddles with while reading a liveboard (must NOT be saved — the next person,
and a reload, should see the author's version).

Get this wrong and viewers silently overwrite the author's setup just by
dragging something.

Implement it by gating the PERSIST call, never the interaction: the drag/click
always applies locally so the chart still feels responsive; only the
`UpdateVisualProps` emit is conditional. Remember to gate any self-heal/
re-assert path too, or it'll write on the next render anyway.

The SDK exposes no explicit edit/view flag. The usable signal is
`ctx.getAppConfig().appOptions.isLiveboardContext` — true when rendering in a
liveboard. Treat unknown/absent config as EDITABLE, so a chart set up outside a
liveboard can still save.

Ephemeral-by-default state (a sort order held in a plain module variable) needs
no gating at all — it dies on reload for free. Prefer that when the state
doesn't need saving.

## Harness gotcha: `emitEvent` is async — don't assert on it synchronously

`ctx.emitEvent(...)` is a postMessage round-trip. Counting emitted events in the
same tick as the interaction that triggers them reports zero every time, which
reads as "persistence is broken" (or worse, as "correctly suppressed" when you
were testing that it DOESN'T emit — a false pass). Always `await` a few hundred
ms before asserting on emit counts, and when testing suppression, also pump a
few extra renders so a deferred/self-heal write has a chance to appear.
