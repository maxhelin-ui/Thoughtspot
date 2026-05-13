# Custom ThoughtSpot Chart — Lessons Learned

Compiled from building the waterfall chart. Read before starting a new viz.

## If the chart doesn't load at all (#1 source of pain)

- `visualPropEditorDefinition` throwing kills the whole chart silently. Wrap every data access with `?.` and `??`.
- `getDefaultChartConfig` throwing also kills it — double-check your throw conditions.
- `text` input `defaultValue` cannot be `''` (empty string). Use `' '` (single space). Hit this twice.
- Highcharts `columnrange` (and several other types) needs `highcharts-more.js` — easy to forget in `index.html`.
- If the chart URL 403s in a browser tab, it's Vercel Deployment Protection — disable in the Vercel dashboard.

## SDK imports (recurring rollup/tsc trap)

- Never import from `@thoughtspot/ts-chart-sdk/src/...`. Those internal paths aren't in the installed package and Vite/tsc will fail to resolve them. Only use top-level exports.
- For Highcharts, prefer CDN via `index.html` with `declare const Highcharts: any` in your TS. npm-bundled Highcharts tripped Vite when combined with the SDK.

## Build / Vercel

- `package.json` build script should be just `"vite build"`. Adding `tsc &&` upfront breaks because tsc in bundler mode rejects the SDK's internal paths.
- If the chart lives in a subfolder, Vercel uses *that* folder's `package.json`.
- `vercel.json` needs `frame-ancestors *` (or specific TS domain) for the iframe to load.
- Vercel Deployment Protection re-enables itself after every deploy by default — disable in the dashboard.

## Visual prop types

- `checkbox` works. `toggle` renders but **doesn't fire updates** in TS UI — don't use it.
- `dropdown` needs `values: string[]`.
- `colorpicker`, `number`, `text` all fine (with the empty-default caveat).
- `visualPropEditorDefinition` can be a **function** `(chartModel) => ({ elements: [...] })` — use this to generate per-column inputs dynamically (e.g. rename inputs, per-slice colour pickers).

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

## Workflow

- Every squash-merge diverges the feature branch. Before each new PR: `git rebase origin/main && git push -f`.
- After a merge, wait ~30s for Vercel, then hard-refresh in TS (Cmd/Ctrl+Shift+R).

## Settings panels in TS (for end users)

- **Chart configuration** (where columns go): three-dot menu on chart → *Edit chart configuration*.
- **Visual properties** (where `visualPropEditorDefinition` lives): separate panel — usually *Edit visualization* / settings cog. Different from chart configuration.

## In-chart UI controls

The `index.html` `#buttonContainer` div is mounted above the chart. Use it for dashboard-viewer-facing controls (toggle buttons, measure switchers) that should work without entering edit mode. Combine with a module-level state variable that persists for the page lifetime; reset it when the corresponding settings default changes.

## Debug checklist when the chart doesn't show

1. Open the chart URL directly in a browser tab — if it 403s, it's deployment protection.
2. If it loads but errors, check devtools console.
3. If TS shows nothing, check Vercel build log for a failed deploy.
4. Verify the custom viz is pointed at the correct Vercel URL in TS settings.
