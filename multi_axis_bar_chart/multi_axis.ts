import {
    ChartToTSEvent,
    ColumnType,
    ColumnTimeBucket,
    DataType,
    getChartContext,
    CustomChartContext,
    ChartModel,
    ChartConfig,
    DataPointsArray,
    Query,
    RenderErrorEventPayload,
} from '@thoughtspot/ts-chart-sdk';
import numeral from 'numeral';

declare const Highcharts: any;

interface VisualProps {
    chartTitle?: string;
    xAxisTitle?: string;
    yAxisTitle?: string;
    numberFormat?: string;
    currency?: string;
    showDataLabels?: boolean;
    showStackTotals?: boolean;
    showLegend?: boolean;
    showGridLines?: boolean;
    stackingMode?: string;
    sortBy?: string;
    excludeNulls?: boolean;
    [key: string]: any;
}

const MAX_FORMULAS = 4;

const SORT_OPTIONS = [
    'Descending by value',
    'Ascending by value',
    'Alphabetical',
    'Default order',
];

const PALETTE = [
    '#378ADD', '#E24B4A', '#534AB7', '#F0A937', '#52B788',
    '#9B5DE5', '#00BBF9', '#FB6F92', '#80B918', '#F08080',
];

const CURRENCY_OPTIONS = ['None', '$', '€', '£', '¥', '₹', 'kr'];

const STACKING_OPTIONS = ['None', 'Stacked', '100% Stacked'];

let globalChartReference: any = null;
let activeXColumnId: string | null = null;
const hiddenSeriesByX = new Map<string, Set<string>>();
let globalAppConfig: any = null;
let renderDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let firstRenderDone = false;
let lastRenderedDataRef: unknown = null;

// Returns the org-configured chart colour palette if TS provided one, else
// falls back to our hardcoded PALETTE. This is the user's "company" palette
// configured in TS Admin → Styling.
function getEffectivePalette(): string[] {
    const palettes = globalAppConfig?.styleConfig?.chartColorPalettes;
    if (Array.isArray(palettes) && palettes.length > 0
        && Array.isArray(palettes[0]?.colors) && palettes[0].colors.length > 0) {
        return palettes[0].colors;
    }
    return PALETTE;
}

function getHiddenSet(xColumnId: string): Set<string> {
    let set = hiddenSeriesByX.get(xColumnId);
    if (!set) {
        set = new Set<string>();
        hiddenSeriesByX.set(xColumnId, set);
    }
    return set;
}

function formatNumber(value: number, format: string): string {
    try {
        return numeral(value).format(format).replace('k', 'K').replace('m', 'M').replace('b', 'B');
    } catch {
        return value?.toString() ?? '0';
    }
}

function formatCurrency(value: number, format: string, currency: string): string {
    const cleanFormat = format.replace(/^[\$€£¥₹]/, '');
    const formatted = formatNumber(value, cleanFormat);
    if (!currency || currency === 'None') return formatted;
    if (formatted.startsWith('-')) return '-' + currency + formatted.slice(1);
    return currency + formatted;
}

function formatPercent(value: number): string {
    // ThoughtSpot percentages come through as decimals (0.85 = 85%). Render with
    // up to one decimal place, trimming trailing zeros.
    try {
        return numeral(value).format('0.[0]%');
    } catch {
        return `${(value * 100).toFixed(1)}%`;
    }
}

function detectPercentByName(name: string): boolean {
    const n = (name || '').toLowerCase();
    return /(?:%|\bpct\b|\bpercent\b|\bnrr\b|\bgrr\b|\brate\b|\bratio\b)/.test(n);
}

// Tiny recursive-descent math evaluator. CSP-safe (no Function/eval); supports
// numbers (including scientific notation), unary +/-, binary + - * /, and
// parens. The input is the formula AFTER column-name substitution, so only
// arithmetic tokens should remain.
function evalMathExpression(s: string): number {
    let pos = 0;
    const len = s.length;
    const skipWs = () => { while (pos < len && (s.charCodeAt(pos) === 32 || s.charCodeAt(pos) === 9)) pos++; };

    const parseNumber = (): number => {
        skipWs();
        const start = pos;
        while (pos < len && s[pos] >= '0' && s[pos] <= '9') pos++;
        if (s[pos] === '.') { pos++; while (pos < len && s[pos] >= '0' && s[pos] <= '9') pos++; }
        if (s[pos] === 'e' || s[pos] === 'E') {
            pos++;
            if (s[pos] === '+' || s[pos] === '-') pos++;
            while (pos < len && s[pos] >= '0' && s[pos] <= '9') pos++;
        }
        const n = parseFloat(s.slice(start, pos));
        if (Number.isNaN(n)) throw new Error('Expected number');
        return n;
    };

    const parsePrimary = (): number => {
        skipWs();
        if (s[pos] === '(') {
            pos++;
            const v = parseAdditive();
            skipWs();
            if (s[pos] !== ')') throw new Error('Expected )');
            pos++;
            return v;
        }
        return parseNumber();
    };

    const parseUnary = (): number => {
        skipWs();
        if (s[pos] === '+') { pos++; return parseUnary(); }
        if (s[pos] === '-') { pos++; return -parseUnary(); }
        return parsePrimary();
    };

    const parseMultiplicative = (): number => {
        let left = parseUnary();
        skipWs();
        while (s[pos] === '*' || s[pos] === '/') {
            const op = s[pos++];
            const right = parseUnary();
            left = op === '*' ? left * right : (right !== 0 ? left / right : 0);
            skipWs();
        }
        return left;
    };

    const parseAdditive = (): number => {
        let left = parseMultiplicative();
        skipWs();
        while (s[pos] === '+' || s[pos] === '-') {
            const op = s[pos++];
            const right = parseMultiplicative();
            left = op === '+' ? left + right : left - right;
            skipWs();
        }
        return left;
    };

    const result = parseAdditive();
    skipWs();
    if (pos < len) throw new Error('Unexpected trailing input');
    return result;
}

// Substitutes column names with their numeric values, then evaluates the
// arithmetic expression with the CSP-safe parser above. Supports both bare
// names (`Renewed ARR Closed Won`) and bracketed names (`[name]`). Longer
// names match first so overlapping names (e.g. "ARR" inside "Renewed ARR")
// don't collide.
function evalFormula(expr: string, columnValues: Record<string, number>): number | null {
    if (!expr || !expr.trim()) return null;
    const names = Object.keys(columnValues).sort((a, b) => b.length - a.length);
    let processed = expr;
    for (const name of names) {
        const bracketed = `[${name}]`;
        while (processed.indexOf(bracketed) !== -1) {
            processed = processed.split(bracketed).join(`(${columnValues[name]})`);
        }
    }
    for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        processed = processed.replace(new RegExp(escaped, 'g'), `(${columnValues[name]})`);
    }
    if (/[a-zA-Z_\[\]]/.test(processed)) return null; // unresolved name → invalid
    try {
        const result = evalMathExpression(processed);
        return Number.isFinite(result) ? result : 0;
    } catch {
        return null;
    }
}

function pickColor(picker: unknown, fallback: string): string {
    return (typeof picker === 'string' && picker) ? picker : fallback;
}

function naturalCompare(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// True for date/datetime columns and any column with an explicit time bucket
// (e.g. MONTHLY, QUARTERLY). These come over the wire as epoch seconds and
// would otherwise render as raw 10-digit numbers on the x-axis.
function isDateLikeCol(col: { dataType?: DataType; timeBucket?: ColumnTimeBucket } | undefined): boolean {
    if (!col) return false;
    if (col.dataType === DataType.DATE || col.dataType === DataType.DATE_TIME) return true;
    if (col.timeBucket != null && col.timeBucket !== ColumnTimeBucket.NO_BUCKET) return true;
    return false;
}

// Pick a Date formatter that matches the column's bucket granularity. UTC
// formatting throughout so we don't shift bucket boundaries by the viewer's
// local timezone.
function formatEpochByBucket(epochStr: string, bucket: ColumnTimeBucket | undefined): string {
    const n = Number(epochStr);
    if (!Number.isFinite(n)) return epochStr;
    const d = new Date(n * 1000);
    if (Number.isNaN(d.getTime())) return epochStr;
    const utc = (opts: Intl.DateTimeFormatOptions) =>
        d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
    switch (bucket) {
        case ColumnTimeBucket.YEARLY:           return String(d.getUTCFullYear());
        case ColumnTimeBucket.QUARTERLY:        return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
        case ColumnTimeBucket.MONTHLY:          return utc({ month: 'short', year: 'numeric' });
        case ColumnTimeBucket.WEEKLY:           return utc({ month: 'short', day: 'numeric', year: 'numeric' });
        case ColumnTimeBucket.DAILY:            return utc({ month: 'short', day: 'numeric', year: 'numeric' });
        case ColumnTimeBucket.HOURLY:           return utc({ month: 'short', day: 'numeric', hour: 'numeric' });
        case ColumnTimeBucket.HOUR_OF_DAY:      return `${d.getUTCHours()}:00`;
        case ColumnTimeBucket.DAY_OF_WEEK:      return utc({ weekday: 'short' });
        case ColumnTimeBucket.DAY_OF_MONTH:     return String(d.getUTCDate());
        case ColumnTimeBucket.DAY_OF_QUARTER:   return String(d.getUTCDate());
        case ColumnTimeBucket.DAY_OF_YEAR:      return utc({ month: 'short', day: 'numeric' });
        case ColumnTimeBucket.WEEK_OF_MONTH:    return `Wk ${Math.ceil(d.getUTCDate() / 7)}`;
        case ColumnTimeBucket.WEEK_OF_QUARTER:  return `Wk ${Math.ceil(d.getUTCDate() / 7)}`;
        case ColumnTimeBucket.WEEK_OF_YEAR:     return `Wk ${Math.ceil(d.getUTCDate() / 7)}`;
        case ColumnTimeBucket.MONTH_OF_QUARTER: return utc({ month: 'short' });
        case ColumnTimeBucket.MONTH_OF_YEAR:    return utc({ month: 'short' });
        case ColumnTimeBucket.QUARTER_OF_YEAR:  return `Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
        default:                                return utc({ month: 'short', day: 'numeric', year: 'numeric' });
    }
}

function renderXButtons(
    xColumns: Array<{ id: string; name: string }>,
    activeId: string | null,
    onClick: (id: string) => void,
) {
    const togglesEl = document.getElementById('sliceToggles');
    if (!togglesEl) return;
    togglesEl.innerHTML = '';
    xColumns.forEach(col => {
        const button = document.createElement('button');
        const isActive = col.id === activeId;
        button.className = 'slice-toggle-btn' + (isActive ? ' active' : '');
        button.type = 'button';
        button.textContent = col.name;
        button.onclick = () => onClick(col.id);
        togglesEl.appendChild(button);
    });
}

function renderCustomLegend(
    items: Array<{ name: string; color: string }>,
    hidden: Set<string>,
    onToggle: (name: string) => void,
) {
    const legendEl = document.getElementById('customLegend');
    if (!legendEl) return;
    legendEl.innerHTML = '';
    items.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'legend-item' + (hidden.has(item.name) ? ' legend-hidden' : '');
        const swatch = document.createElement('span');
        swatch.className = 'legend-swatch';
        swatch.style.background = item.color;
        const label = document.createElement('span');
        label.textContent = item.name;
        btn.appendChild(swatch);
        btn.appendChild(label);
        btn.onclick = () => onToggle(item.name);
        legendEl.appendChild(btn);
    });
}

function adjustButtonContainer(hasContent: boolean) {
    const container = document.getElementById('buttonContainer');
    const toggles   = document.getElementById('sliceToggles');
    const legend    = document.getElementById('customLegend');
    if (!container) return;
    container.style.display = hasContent ? 'flex' : 'none';
    container.style.paddingLeft  = '80px';
    container.style.paddingRight = '40px';
    if (!hasContent || !toggles || !legend) return;

    // Progressive shrink: if the legend has to wrap to a new row, first push
    // the legend to the chart's right edge (drop right padding). If it still
    // wraps, also push the slicer pills to the left edge (drop left padding).
    // Only after both edges are flush do we accept a 2-row layout.
    const isWrappedInside = (el: HTMLElement): boolean => {
        const items = Array.from(el.children) as HTMLElement[];
        if (items.length < 2) return false;
        const firstTop = items[0].offsetTop;
        return items.some(item => Math.abs(item.offsetTop - firstTop) > 4);
    };
    const isOuterWrapped = () =>
        Math.abs(legend.offsetTop - toggles.offsetTop) > 15
        || isWrappedInside(legend)
        || isWrappedInside(toggles);

    if (isOuterWrapped()) {
        container.style.paddingRight = '6px';
        if (isOuterWrapped()) {
            container.style.paddingLeft = '6px';
        }
    }
}

function renderChartMessage(text: string) {
    const el = document.getElementById('chart');
    if (!el) return;
    if (globalChartReference) { try { globalChartReference.destroy(); } catch { /* noop */ } globalChartReference = null; }
    el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6B7280;font-size:14px;font-family:inherit;text-align:center;padding:20px;">${text}</div>`;
}

function clearCustomLegend() {
    const legendEl = document.getElementById('customLegend');
    if (legendEl) legendEl.innerHTML = '';
}

type DataModel = {
    xColumns: Array<{ id: string; name: string; dataType?: DataType; timeBucket?: ColumnTimeBucket }>;
    yColumns: Array<{ id: string; name: string }>;
    formulaInputColumns: Array<{ id: string; name: string }>;
    sliceColumn?: { id: string; name: string };
    dataArr: DataPointsArray;
};

function getDataModel(chartModel: ChartModel): DataModel {
    const dataArr: DataPointsArray =
        chartModel.data?.[chartModel.data.length - 1]?.data ?? { columns: [], dataValue: [] };
    const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
    const xColumns            = dims.find(d => d.key === 'xOptions')?.columns ?? [];
    const yColumns            = dims.find(d => d.key === 'y')?.columns ?? [];
    const formulaInputColumns = dims.find(d => d.key === 'formulaInputs')?.columns ?? [];
    const sliceColumn         = dims.find(d => d.key === 'slice')?.columns?.[0];
    return { xColumns, yColumns, formulaInputColumns, sliceColumn, dataArr };
}

function computeChartData(
    dataArr: DataPointsArray,
    activeXCol: { id: string; dataType?: DataType; timeBucket?: ColumnTimeBucket },
    measureColumns: Array<{ id: string }>,
    sliceColumn: { id: string } | undefined,
    isMeasurePercent: boolean[],
) {
    const xColIdx     = dataArr.columns.indexOf(activeXCol.id);
    const sliceColIdx = sliceColumn ? dataArr.columns.indexOf(sliceColumn.id) : -1;

    // If the active X column isn't present in the dataset (e.g. user changed
    // the binding but data hasn't refreshed yet, or the column was removed),
    // bail with empty results so render() doesn't read row[-1] for every row
    // and silently produce a chart with no categories.
    if (xColIdx < 0) {
        return { xCategories: [] as string[], sliceNames: [''] as string[], data: [] as number[][][] };
    }

    // Always drop null tokens (JS null/undefined, empty strings, and TS's
    // "{Null}" / "(Null)" / "null" display tokens). TS's native bar chart
    // does this unconditionally, so we match it.
    const isExcluded = (v: any): boolean => {
        if (v == null) return true;
        const s = String(v).trim();
        if (!s) return true;
        const lower = s.toLowerCase();
        return lower === '{null}' || lower === '(null)' || lower === 'null';
    };

    const xCatSet = new Set<string>();
    const sliceSet = new Set<string>();
    for (const row of dataArr.dataValue) {
        const xRaw = row[xColIdx];
        if (isExcluded(xRaw)) continue;
        xCatSet.add(String(xRaw));
        if (sliceColIdx >= 0) {
            const sRaw = row[sliceColIdx];
            if (isExcluded(sRaw)) continue;
            sliceSet.add(String(sRaw));
        }
    }
    // For date columns the raw values are epoch seconds — sort numerically so
    // months/years appear in time order on the x-axis. Other columns keep the
    // natural-string ordering they had before.
    const xIsDate = isDateLikeCol(activeXCol);
    const xCategories = Array.from(xCatSet).sort(
        xIsDate ? (a, b) => Number(a) - Number(b) : naturalCompare,
    );
    const sliceNames  = sliceColIdx >= 0 ? Array.from(sliceSet).sort(naturalCompare) : [''];

    // data[mIdx][sIdx][xCatIdx] = aggregated value
    // Sum for normal measures, mean for percent measures (since summing
    // percentages across a row-level breakdown yields nonsense — e.g. five
    // 70% NRR rows would sum to 350%).
    const data: number[][][] = measureColumns.map((mCol, mIdx) => {
        const yColIdx = dataArr.columns.indexOf(mCol.id);
        // Measure column not in this dataset — produce zeros rather than
        // reading row[-1] (which silently returns the last array element).
        if (yColIdx < 0) {
            return sliceNames.map(() => xCategories.map(() => 0));
        }
        const useMean = isMeasurePercent[mIdx];
        return sliceNames.map(sliceName =>
            xCategories.map(xCat => {
                let sum = 0;
                let count = 0;
                for (const row of dataArr.dataValue) {
                    if (String(row[xColIdx] ?? '') !== xCat) continue;
                    if (sliceColIdx >= 0 && String(row[sliceColIdx] ?? '') !== sliceName) continue;
                    const raw = row[yColIdx];
                    if (raw == null) continue;
                    const v = parseFloat(String(raw));
                    if (Number.isNaN(v)) continue;
                    sum += v;
                    count++;
                }
                if (useMean) return count > 0 ? sum / count : 0;
                return sum;
            }),
        );
    });

    return { xCategories, sliceNames, data };
}

function render(ctx: CustomChartContext) {
    const chartModel = ctx.getChartModel();
    const { xColumns, yColumns, formulaInputColumns, sliceColumn, dataArr } = getDataModel(chartModel);
    const visualProps = (chartModel.visualProps ?? {}) as VisualProps;

    if (xColumns.length === 0) {
        adjustButtonContainer(false);
        clearCustomLegend();
        renderChartMessage('Add an X-axis attribute and at least one measure (or a formula) to render this chart.');
        return;
    }

    if (!activeXColumnId || !xColumns.some(c => c.id === activeXColumnId)) {
        activeXColumnId = xColumns[0].id;
    }
    const activeXCol = xColumns.find(c => c.id === activeXColumnId)!;

    const chartTitle      = visualProps.chartTitle      ?? '';
    const xAxisTitleProp  = visualProps.xAxisTitle      ?? '';
    const yAxisTitle      = visualProps.yAxisTitle      ?? (yColumns.length === 1 ? yColumns[0].name : 'Value');
    const numberFormat    = visualProps.numberFormat    ?? '0,0.[0]a';
    const currency        = visualProps.currency        ?? 'None';
    const showDataLabels  = visualProps.showDataLabels  ?? false;
    const showStackTotals = visualProps.showStackTotals ?? false;
    const showLegend      = visualProps.showLegend      ?? true;
    const showGridLines   = visualProps.showGridLines   ?? true;
    const stackingMode    = visualProps.stackingMode    ?? 'None';
    const sortBy          = visualProps.sortBy          ?? 'Descending by value';
    // Collect any defined formulas. Each (name, expr) pair is one computed
    // measure. The chart sums each component measure across the active group,
    // then evaluates the expression — same way TS resolves formulas internally.
    type FormulaDef = { name: string; expr: string };
    const formulas: FormulaDef[] = [];
    for (let i = 1; i <= MAX_FORMULAS; i++) {
        const name = (visualProps[`formula${i}Name`] ?? '').trim();
        const expr = (visualProps[`formula${i}Expr`] ?? '').trim();
        if (name && expr) formulas.push({ name, expr });
    }

    // We need component-sum data for everything the user might reference:
    // y-axis measures (so non-formula rendering still works) AND formula inputs
    // (so formulas can reference them). Dedupe by column id.
    const allMeasureCols: Array<{ id: string; name: string }> = [];
    const seenMeasureIds = new Set<string>();
    for (const c of [...yColumns, ...formulaInputColumns]) {
        if (seenMeasureIds.has(c.id)) continue;
        seenMeasureIds.add(c.id);
        allMeasureCols.push(c);
    }

    if (formulas.length === 0 && yColumns.length === 0) {
        adjustButtonContainer(false);
        clearCustomLegend();
        renderChartMessage('Add at least one measure to the Y-axis, or define a formula.');
        return;
    }

    // For raw aggregation: sum normally; only fall back to mean if the column
    // looks like a percent. When formulas are active, component sums must stay
    // as sums (the formula computes the ratio).
    const allIsMeasurePercent = allMeasureCols.map(c => {
        if (formulas.length > 0) return false;
        const override = visualProps[`measureAsPercent_${c.id}`];
        if (typeof override === 'boolean') return override;
        return detectPercentByName(c.name);
    });

    let { xCategories, sliceNames, data } = computeChartData(
        dataArr, activeXCol, allMeasureCols, sliceColumn, allIsMeasurePercent,
    );

    // Effective measures = formula results if any defined, else y-axis measures
    // (in their original order, looked up from allMeasureCols).
    let effectiveYColumns: Array<{ id: string; name: string }>;
    let effectiveIsPercent: boolean[];
    if (formulas.length > 0) {
        const formulaData: number[][][] = formulas.map(f => {
            return sliceNames.map((_, sIdx) =>
                xCategories.map((_, catIdx) => {
                    const valuesByName: Record<string, number> = {};
                    allMeasureCols.forEach((col, mIdx) => {
                        valuesByName[col.name] = data[mIdx]?.[sIdx]?.[catIdx] ?? 0;
                    });
                    const v = evalFormula(f.expr, valuesByName);
                    return v ?? 0;
                }),
            );
        });
        data = formulaData;
        effectiveYColumns = formulas.map((f, i) => ({ id: `formula_${i}`, name: f.name }));
        effectiveIsPercent = formulas.map(f => /[\/]/.test(f.expr) || detectPercentByName(f.name));
    } else {
        const yIdxInAll = yColumns.map(yCol => allMeasureCols.findIndex(c => c.id === yCol.id));
        effectiveYColumns = yColumns;
        effectiveIsPercent = yColumns.map((_, i) => allIsMeasurePercent[yIdxInAll[i]]);
        data = yIdxInAll.map(idx => data[idx]);
    }
    const allPercent = effectiveIsPercent.length > 0 && effectiveIsPercent.every(Boolean);

    const fmtForMeasure = (v: number, yIdx: number) =>
        effectiveIsPercent[yIdx]
            ? formatPercent(v)
            : formatCurrency(v, numberFormat, currency);
    const fmtAxis = (v: number) =>
        allPercent
            ? formatPercent(v)
            : formatNumber(v, numberFormat.replace(/^[\$€£¥₹]/, ''));

    // Sort x categories per the user's choice. Default = descending by value
    // (sum of the first measure across all slices, per category).
    if (sortBy !== 'Default order') {
        const totalsByCat = xCategories.map((_, catIdx) => {
            let total = 0;
            // Use the first measure as the sort key. If multiple, that's the
            // "primary" one. Mixed units (eg $ + %) make summing meaningless.
            const yIdx = 0;
            for (let s = 0; s < sliceNames.length; s++) {
                total += data[yIdx]?.[s]?.[catIdx] ?? 0;
            }
            return total;
        });
        const order = xCategories.map((_, i) => i);
        if (sortBy === 'Descending by value') {
            order.sort((a, b) => totalsByCat[b] - totalsByCat[a]);
        } else if (sortBy === 'Ascending by value') {
            order.sort((a, b) => totalsByCat[a] - totalsByCat[b]);
        } else {
            // Alphabetical (natural)
            order.sort((a, b) => naturalCompare(xCategories[a], xCategories[b]));
        }
        xCategories = order.map(i => xCategories[i]);
        data = data.map(perY => perY.map(perS => order.map(i => perS[i])));
    }

    // Date columns come over as epoch-second strings; format the x-axis labels
    // here (post-sort) so values like "1775001600" render as "Apr 2026".
    // Indexes line up with xCategories so the data binding is untouched.
    const xIsDateRender = isDateLikeCol(activeXCol);
    const xCategoryLabels = xIsDateRender
        ? xCategories.map(v => formatEpochByBucket(v, activeXCol.timeBucket))
        : xCategories;

    // Build series: one per (measure, sliceValue). When no slice, sliceNames=[''] and the
    // series name is just the measure. When sliced, name depends on whether there's >1 measure.
    type SeriesSpec = { name: string; data: number[]; color: string; yColIdx: number; sliceIdx: number };
    const seriesSpecs: SeriesSpec[] = [];
    effectiveYColumns.forEach((yCol, yIdx) => {
        sliceNames.forEach((sliceName, sIdx) => {
            const isSliced = !!sliceColumn;
            const name = isSliced
                ? (effectiveYColumns.length > 1 ? `${yCol.name} — ${sliceName}` : sliceName)
                : yCol.name;
            const palette = getEffectivePalette();
            const defaultColor = isSliced
                ? palette[sIdx % palette.length]
                : palette[yIdx % palette.length];
            const colorKey = isSliced
                ? `sliceColor_${sliceColumn!.id}_${sliceName}`
                : `measureColor_${yCol.id}`;
            const color = pickColor(visualProps[colorKey], defaultColor);
            seriesSpecs.push({
                name,
                data: data[yIdx][sIdx],
                color,
                yColIdx: yIdx,
                sliceIdx: sIdx,
            });
        });
    });

    const seriesNameToYIdx = new Map<string, number>();
    seriesSpecs.forEach(s => seriesNameToYIdx.set(s.name, s.yColIdx));

    const hidden = getHiddenSet(activeXCol.id);

    // Slicing semantics (matching the waterfall): when a slice column is bound,
    // each bar splits into stacked segments per slice value. With multiple
    // measures, each measure becomes its own grouped column, and the slices
    // stack within that group (`stack: m{yIdx}`). The user's stackingMode
    // setting can still upgrade to percent normalization.
    const sliceStackingActive = !!sliceColumn && sliceNames.length > 0 && sliceNames[0] !== '';
    const stacking = sliceStackingActive
        ? (stackingMode === '100% Stacked' ? 'percent' : 'normal')
        : (stackingMode === 'Stacked' ? 'normal'
           : stackingMode === '100% Stacked' ? 'percent'
           : undefined);

    renderXButtons(xColumns, activeXColumnId, (columnId) => {
        activeXColumnId = columnId;
        render(ctx);
    });

    if (showLegend) {
        renderCustomLegend(
            seriesSpecs.map(s => ({ name: s.name, color: s.color })),
            hidden,
            (name) => {
                if (hidden.has(name)) hidden.delete(name);
                else hidden.add(name);
                render(ctx);
            },
        );
    } else {
        clearCustomLegend();
    }

    if (globalChartReference) {
        globalChartReference.destroy();
        globalChartReference = null;
    }

    globalChartReference = Highcharts.chart('chart', {
        chart: {
            type: 'column',
            marginLeft:   80,
            marginRight:  40,
            marginTop:    chartTitle ? 50 : 25,
            spacingBottom: 20,
            style: { fontFamily: 'Optimo-Plain, "Helvetica Neue", Helvetica, Arial, sans-serif' },
        },
        title: {
            text:  chartTitle,
            style: { fontWeight: 'bold', fontSize: '14px', color: '#1A1F2C' },
        },
        credits: { enabled: false },
        xAxis: {
            categories: xCategoryLabels,
            title: {
                text:  xAxisTitleProp.trim() ? xAxisTitleProp : activeXCol.name,
                style: { fontWeight: 'bold', color: '#555' },
            },
            labels: {
                // Highcharts auto-rotation: try horizontal first, then -30° if
                // labels would otherwise be cropped. Re-evaluated per render so
                // each x-axis selection gets the right treatment independently.
                autoRotation: [0, -30],
                autoRotationLimit: 80,
                style: { fontSize: '12px', color: '#333', fontWeight: 'normal' },
            },
            lineColor: '#ddd',
            tickWidth: 0,
        },
        yAxis: {
            title: { text: yAxisTitle, style: { fontWeight: '500', color: '#555' } },
            gridLineWidth: showGridLines ? 1 : 0,
            gridLineColor: '#EEF1F4',
            labels: {
                formatter: function (this: any) {
                    return fmtAxis(this.value);
                },
                style: { color: '#555', fontSize: '11px' },
            },
            // Stack totals shown above each stack when "Show bar totals" is on
            // and the chart is stacked. Format using the stack's measure
            // (stack name is `m{yColIdx}` — see series.stack below).
            stackLabels: {
                enabled: showStackTotals && !!stacking,
                crop: false,
                overflow: 'allow',
                style: { fontSize: '11px', fontWeight: '700', textOutline: 'none', color: '#1A1F2C' },
                formatter: function (this: any) {
                    if (this.total == null || this.total === 0) return '';
                    const match = String(this.stack ?? '').match(/^m(\d+)$/);
                    const yIdx  = match ? Number(match[1]) : 0;
                    return fmtForMeasure(this.total, yIdx);
                },
            },
        },
        legend: { enabled: false },
        tooltip: {
            useHTML: true,
            backgroundColor: 'rgba(0,0,0,0)',
            borderWidth: 0,
            shadow: false,
            padding: 0,
            formatter: function (this: any) {
                const p = this.point as any;
                const seriesName = this.series.name;
                const color = this.series.color;
                const yIdx = seriesNameToYIdx.get(seriesName) ?? 0;
                return `<div style="border:1px solid ${color};border-radius:8px;background:#3A3F48;padding:12px;color:#FFFFFF;font-size:13px;">
                    <div style="font-weight:600;margin-bottom:6px;">${p.category}</div>
                    <div>${seriesName}:<br/><b>${fmtForMeasure(p.y, yIdx)}</b></div>
                </div>`;
            },
        },
        plotOptions: {
            column: {
                stickyTracking: false,
                borderWidth: 0,
                borderRadius: 0,
                pointPadding: 0.05,
                groupPadding: 0.12,
                stacking,
                dataLabels: [
                    // (a) Existing inside-bar label (per-series value). Kept
                    // at normal weight — the bold treatment is reserved for
                    // the per-bar total/stack total above the bar so the
                    // total stands out from its sub-labels.
                    {
                        enabled: showDataLabels,
                        style: { fontSize: '11px', fontWeight: '400', textOutline: 'none', color: '#333' },
                        formatter: function (this: any) {
                            if (this.y == null || this.y === 0) return '';
                            const yIdx = seriesNameToYIdx.get(this.series.name) ?? 0;
                            return fmtForMeasure(this.y, yIdx);
                        },
                    },
                    // (b) Total above each bar when "Show bar totals" is on AND
                    // the chart isn't stacked (in stacked mode, yAxis.stackLabels
                    // already covers it).
                    {
                        enabled: showStackTotals && !stacking,
                        verticalAlign: 'bottom',
                        y: -4,
                        crop: false,
                        overflow: 'allow',
                        style: { fontSize: '11px', fontWeight: '700', textOutline: 'none', color: '#1A1F2C' },
                        formatter: function (this: any) {
                            if (this.y == null || this.y === 0) return '';
                            const yIdx = seriesNameToYIdx.get(this.series.name) ?? 0;
                            return fmtForMeasure(this.y, yIdx);
                        },
                    },
                ],
            },
        },
        series: seriesSpecs.map(s => ({
            type:    'column',
            name:    s.name,
            data:    s.data,
            color:   s.color,
            visible: !hidden.has(s.name),
            showInLegend: false,
            // Grouping key — same-measure slices share a stack so they sit
            // on top of each other; different measures land in separate
            // groups side-by-side. Ignored when stacking is undefined.
            stack:   sliceStackingActive ? `m${s.yColIdx}` : undefined,
        })),
    });

    adjustButtonContainer(true);
}

const renderChart = async (ctx: CustomChartContext) => {
    // Cache the org's chart styling so getEffectivePalette() can read it.
    if (!globalAppConfig) {
        try { globalAppConfig = (ctx as any).getAppConfig?.() ?? null; } catch { /* ignore */ }
    }

    const doRender = () => {
        try {
            ctx.emitEvent(ChartToTSEvent.RenderStart);
            render(ctx);
            ctx.emitEvent(ChartToTSEvent.RenderComplete);
            firstRenderDone = true;
            lastRenderedDataRef = ctx.getChartModel().data;
        } catch (error) {
            console.error('Error during render:', error);
            ctx.emitEvent(ChartToTSEvent.RenderError, {
                hasError: true,
                error,
            } as RenderErrorEventPayload);
        }
    };

    // First render paints immediately. After that, only debounce when the
    // visualProps changed (typing into the settings panel) — data changes
    // from filters/queries must apply right away, otherwise the chart would
    // appear blank while the debounce timer is pending.
    if (!firstRenderDone) {
        doRender();
        return;
    }
    const currentData = ctx.getChartModel().data;
    if (currentData !== lastRenderedDataRef) {
        if (renderDebounceTimer) { clearTimeout(renderDebounceTimer); renderDebounceTimer = null; }
        doRender();
        return;
    }
    if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(doRender, 1000);
};

(async () => {
    const ctx = await getChartContext({
        getDefaultChartConfig: (chartModel: ChartModel) => {
            // Pre-bind the first attribute and first measure if available, but
            // never throw — the chart should still load (and show an empty-state
            // message) so the user can fix the binding from inside TS instead of
            // hitting a generic 'Cannot display custom chart' error.
            const cols = chartModel.columns;
            const attributeColumns = cols.filter(c => c.type === ColumnType.ATTRIBUTE);
            const measureColumns   = cols.filter(c => c.type === ColumnType.MEASURE);
            return [{
                key: 'main',
                dimensions: [
                    { key: 'xOptions',      columns: attributeColumns.slice(0, 1) },
                    { key: 'y',             columns: measureColumns.slice(0, 1)   },
                    { key: 'formulaInputs', columns: []                           },
                    { key: 'slice',         columns: []                           },
                ],
            }];
        },
        getQueriesFromChartConfig: (chartConfig: ChartConfig[], chartModel: ChartModel): Array<Query> => {
            // TS rejects queries with zero columns; include a placeholder from
            // chartModel.columns when nothing is bound so init can proceed.
            const queries = chartConfig.map(config =>
                config.dimensions.reduce(
                    (acc: Query, dimension) => ({
                        queryColumns: [...acc.queryColumns, ...dimension.columns],
                    }),
                    { queryColumns: [] } as Query,
                ),
            ).filter(q => q.queryColumns.length > 0);
            if (queries.length > 0) return queries;
            const placeholder = chartModel?.columns?.[0];
            return placeholder ? [{ queryColumns: [placeholder] }] : [];
        },
        renderChart,
        chartConfigEditorDefinition: [{
            key:             'main',
            label:           'Multi Axis Bar Chart',
            descriptionText: 'Each attribute in "X-axis options" becomes a button; clicking it switches the x-axis. Top = default. Add measures for the y-axis (rendered as bars) and/or formula inputs (referenced by formulas in settings). Optional slice attribute colours the bars.',
            columnSections: [
                {
                    key:                   'xOptions',
                    label:                 'X-axis options (top = default; buttons switch)',
                    allowAttributeColumns: true,
                    allowMeasureColumns:   false,
                    allowTimeSeriesColumns: true,
                    maxColumnCount:        20,
                },
                {
                    key:                   'y',
                    label:                 'Measures (Y-axis bars)',
                    allowAttributeColumns: false,
                    allowMeasureColumns:   true,
                    maxColumnCount:        10,
                },
                {
                    key:                   'formulaInputs',
                    label:                 'Formula inputs (referenced by formulas in settings; not rendered as bars)',
                    allowAttributeColumns: false,
                    allowMeasureColumns:   true,
                    maxColumnCount:        20,
                },
                {
                    key:                   'slice',
                    label:                 'Slice with colour (optional)',
                    allowAttributeColumns: true,
                    allowMeasureColumns:   false,
                    maxColumnCount:        1,
                },
            ],
        }],
        visualPropEditorDefinition: (chartModel: ChartModel) => {
            const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
            const yCols    = dims.find(d => d.key === 'y')?.columns ?? [];
            const sliceCol = dims.find(d => d.key === 'slice')?.columns?.[0];

            const measureColorPickers: any[] = [];
            const measurePercentToggles: any[] = [];
            const editorPalette = getEffectivePalette();
            yCols.forEach((col, i) => {
                measureColorPickers.push({
                    key:          `measureColor_${col.id}`,
                    type:         'colorpicker' as const,
                    defaultValue: editorPalette[i % editorPalette.length],
                    label:        `Colour: ${col.name}`,
                });
                measurePercentToggles.push({
                    key:          `measureAsPercent_${col.id}`,
                    type:         'checkbox' as const,
                    defaultValue: detectPercentByName(col.name),
                    label:        `Format "${col.name}" as %`,
                });
            });

            // Formula editor: dynamic "+ formula" UX. We compute how many slots
            // to show based on what the user has filled in: always at least 1
            // slot, plus one empty slot after the last filled formula (capped
            // at MAX_FORMULAS). When the user fills in a formula's name, the
            // next slot appears automatically — the closest the SDK editor
            // schema allows to a real "+ formula" button.
            const visualPropsForEditor = (chartModel.visualProps ?? {}) as VisualProps;
            let maxFilledIndex = 0;
            for (let i = 1; i <= MAX_FORMULAS; i++) {
                const n = (visualPropsForEditor[`formula${i}Name`] ?? '').trim();
                if (n) maxFilledIndex = i;
            }
            const visibleFormulas = Math.max(1, Math.min(maxFilledIndex + 1, MAX_FORMULAS));

            const formulaSettings: any[] = [];
            for (let i = 1; i <= visibleFormulas; i++) {
                formulaSettings.push(
                    { key: `formula${i}Name`,                 type: 'text',        defaultValue: ' ',                                              label: `Formula ${i} name (blank = unused)` },
                    { key: `formula${i}Expr`,                 type: 'text',        defaultValue: ' ',                                              label: `Formula ${i} expression` },
                    { key: `measureColor_formula_${i - 1}`,   type: 'colorpicker', defaultValue: editorPalette[(yCols.length + i - 1) % editorPalette.length], label: `Colour: Formula ${i}` },
                );
            }

            const sliceColorPickers: any[] = [];
            if (sliceCol) {
                const dataArr = chartModel.data?.[chartModel.data.length - 1]?.data;
                if (dataArr) {
                    const sliceColIdx = dataArr.columns.indexOf(sliceCol.id);
                    if (sliceColIdx >= 0) {
                        const seen = new Set<string>();
                        const uniqueSlices: string[] = [];
                        for (const row of dataArr.dataValue) {
                            const raw = row[sliceColIdx];
                            if (raw == null) continue;
                            const v = String(raw);
                            if (!v.trim()) continue;
                            if (!seen.has(v)) {
                                seen.add(v);
                                uniqueSlices.push(v);
                            }
                        }
                        uniqueSlices.sort((a, b) =>
                            a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
                        );
                        uniqueSlices.forEach((s, i) => {
                            sliceColorPickers.push({
                                key:          `sliceColor_${sliceCol.id}_${s}`,
                                type:         'colorpicker' as const,
                                defaultValue: editorPalette[i % editorPalette.length],
                                label:        `${sliceCol.name} — ${s}`,
                            });
                        });
                    }
                }
            }

            return {
                elements: [
                    { key: 'chartTitle',     type: 'text',     defaultValue: ' ',                       label: 'Chart title' },
                    { key: 'xAxisTitle',     type: 'text',     defaultValue: ' ',                       label: 'X-axis title (blank = column name)' },
                    { key: 'yAxisTitle',     type: 'text',     defaultValue: ' ',                       label: 'Y-axis title (blank = measure name)' },
                    { key: 'numberFormat',   type: 'text',     defaultValue: '0,0.[0]a',                label: 'Number format' },
                    { key: 'currency',       type: 'dropdown', defaultValue: 'None',                    values: CURRENCY_OPTIONS, label: 'Currency symbol (labels only, not axis)' },
                    { key: 'stackingMode',   type: 'dropdown', defaultValue: 'None',                    values: STACKING_OPTIONS, label: 'Stacking' },
                    { key: 'showDataLabels', type: 'checkbox', defaultValue: false,                     label: 'Show data labels on bars' },
                    { key: 'showStackTotals', type: 'checkbox', defaultValue: false,                    label: 'Show bar totals on top' },
                    { key: 'showLegend',     type: 'checkbox', defaultValue: true,                      label: 'Show legend' },
                    { key: 'showGridLines',  type: 'checkbox', defaultValue: true,                      label: 'Show grid lines' },
                    { key: 'sortBy',         type: 'dropdown', defaultValue: 'Descending by value',     values: SORT_OPTIONS, label: 'Sort x-axis by' },
                    ...formulaSettings,
                    ...measurePercentToggles,
                    ...measureColorPickers,
                    ...sliceColorPickers,
                ],
            };
        },
    });

    renderChart(ctx);
})();
