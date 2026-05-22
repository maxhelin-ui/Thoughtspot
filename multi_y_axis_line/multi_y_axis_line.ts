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
    showLegend?: boolean;
    showGridLines?: boolean;
    lineWidth?: number;
    markerEnabled?: boolean;
    markerRadius?: number;
    smoothLines?: boolean;
    yButtonsPosition?: string;
    sliceButtonsPosition?: string;
    showSlicingByDefault?: boolean;
    [key: string]: any;
}

const CURRENCY_OPTIONS = ['None', '$', '€', '£', '¥', '₹', 'kr'];
const POSITION_OPTIONS = ['Top', 'Bottom', 'Left', 'Right'];
const MAX_FORMULAS = 4;

// Fixed chart margins. Pinning these here (instead of letting Highcharts
// auto-size) lets us align the button areas predictably with the plot
// gridlines: top/bottom buttons start at marginLeft, left/right buttons start
// at marginTop. Without fixed margins we'd be chasing dynamic plotLeft values
// every render.
const CHART_MARGIN_LEFT   = 80;
const CHART_MARGIN_RIGHT  = 40;
const CHART_MARGIN_BOTTOM = 60;
const CHART_MARGIN_TOP_NO_TITLE   = 25;
const CHART_MARGIN_TOP_WITH_TITLE = 50;

let globalChartReference: any = null;
let globalAppConfig: any = null;
let renderDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let firstRenderDone = false;
let lastRenderedDataRef: unknown = null;

let activeYColumnId: string | null = null;
const activeSliceColumnIds = new Set<string>();
let sliceDefaultsInitialised = false;
let lastSeenSlicingDefault: boolean | null = null;

// When any slicer is active, the user wants one legend entry per
// (slicer, value) pair — not per cross-product combination — so they can
// toggle individual values off to "zoom in". This map persists those hidden
// values across renders; a cross-product series is hidden if any of its
// component slice values is in the corresponding slicer's set.
const hiddenValuesBySlicer = new Map<string, Set<string>>();

const FALLBACK_PALETTE = ['#378ADD', '#E24B4A', '#534AB7', '#F0A937', '#52B788', '#E78AC3', '#67C2A5', '#FB9A99'];

function getEffectivePalette(): string[] {
    const palettes = globalAppConfig?.styleConfig?.chartColorPalettes;
    if (Array.isArray(palettes) && palettes.length > 0
        && Array.isArray(palettes[0]?.colors) && palettes[0].colors.length > 0) {
        return palettes[0].colors;
    }
    return FALLBACK_PALETTE;
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

function formatPercent(value: number, format: string): string {
    // numeral percent multiplies by 100, so divide here first to keep the
    // y-axis values as the raw 0.85, 1.2 etc. that the source data provides.
    try {
        return numeral(value).format(format.endsWith('%') ? format : format + '%');
    } catch {
        return `${(value * 100).toFixed(1)}%`;
    }
}

function pickColor(picker: unknown, fallback: string): string {
    return (typeof picker === 'string' && picker) ? picker : fallback;
}

// CSP-safe recursive-descent math evaluator. Supports +, -, *, /, parens,
// unary +/-, and scientific notation. Same parser as multi-axis-bar — the
// chart uses it to evaluate user-defined formula expressions on top of the
// raw input-column sums, so percent-like formulas (numerator/denominator)
// give the right answer at every aggregation level.
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
        if (s[pos] === '(') { pos++; const v = parseAdditive(); skipWs(); if (s[pos] !== ')') throw new Error('Expected )'); pos++; return v; }
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

// Substitute the user's formula-input column names with their numeric sums,
// then run the math evaluator. Longer names match first so overlapping
// names ('ARR' inside 'Renewed ARR') don't collide. Supports `[bracketed]`
// names too so users can disambiguate names containing spaces. Matching is
// case-insensitive and collapses runs of whitespace so the user's formula
// text doesn't need to byte-match the bound column name exactly.
function evalFormula(expr: string, columnValues: Record<string, number>): number | null {
    if (!expr || !expr.trim()) return null;
    const normalizeWs = (s: string) => s.replace(/\s+/g, ' ').trim();
    const names = Object.keys(columnValues).sort((a, b) => b.length - a.length);
    let processed = normalizeWs(expr);
    for (const name of names) {
        const norm = normalizeWs(name);
        const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // [bracketed] form first.
        processed = processed.replace(new RegExp(`\\[${escaped}\\]`, 'gi'), `(${columnValues[name]})`);
    }
    for (const name of names) {
        const norm = normalizeWs(name);
        const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        processed = processed.replace(new RegExp(escaped, 'gi'), `(${columnValues[name]})`);
    }
    if (/[a-zA-Z_\[\]]/.test(processed)) return null;
    try {
        const result = evalMathExpression(processed);
        return Number.isFinite(result) ? result : 0;
    } catch {
        return null;
    }
}

// Hex → HSL → hex helpers used to derive shades of a slicer's base colour
// for the per-slice-combination series colours. Lightness varies; hue and
// saturation are preserved so a "blue" slicer produces shades of blue.
function hexToHsl(hex: string): { h: number; s: number; l: number } {
    const raw = (hex || '').trim();
    const clean = raw.startsWith('#') ? raw.slice(1) : raw;
    const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
    if (full.length !== 6) return { h: 0, s: 0, l: 50 };
    const r = parseInt(full.slice(0, 2), 16) / 255;
    const g = parseInt(full.slice(2, 4), 16) / 255;
    const b = parseInt(full.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
    const sN = s / 100;
    const lN = l / 100;
    const c = (1 - Math.abs(2 * lN - 1)) * sN;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = lN - c / 2;
    let r1 = 0; let g1 = 0; let b1 = 0;
    if (h < 60)       { r1 = c; g1 = x; b1 = 0; }
    else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
    else              { r1 = c; g1 = 0; b1 = x; }
    const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

// Generate N evenly-spaced lightness shades around the base colour's L,
// preserving hue + saturation. Range is ±25% lightness clamped to [10, 90]
// so very light / very dark base colours still produce visible variation.
function generateShades(baseColor: string, n: number): string[] {
    if (n <= 1) return [baseColor];
    const { h, s, l } = hexToHsl(baseColor);
    const minL = Math.max(10, l - 25);
    const maxL = Math.min(90, l + 25);
    return Array.from({ length: n }, (_, i) => {
        const lightness = minL + (maxL - minL) * (i / (n - 1));
        return hslToHex(h, s, lightness);
    });
}

function naturalCompare(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// Heuristic: treat the active measure as a percent if its name or format
// indicates one. Matches the pattern used in multi-axis-bar.
function detectPercentByName(name?: string, format?: string): boolean {
    const n = (name ?? '').toLowerCase();
    if (n.includes('%') || /\bpct\b/.test(n) || /\bpercent\b/.test(n)) return true;
    if ((format ?? '').includes('%')) return true;
    return false;
}

function isDateLikeCol(col: { dataType?: DataType; timeBucket?: ColumnTimeBucket } | undefined): boolean {
    if (!col) return false;
    if (col.dataType === DataType.DATE || col.dataType === DataType.DATE_TIME) return true;
    if (col.timeBucket != null && col.timeBucket !== ColumnTimeBucket.NO_BUCKET) return true;
    return false;
}

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

function renderChartMessage(text: string) {
    const el = document.getElementById('chart');
    if (!el) return;
    if (globalChartReference) { try { globalChartReference.destroy(); } catch { /* noop */ } globalChartReference = null; }
    el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6B7280;font-size:14px;font-family:inherit;text-align:center;padding:20px;">${text}</div>`;
}

function renderToggleButtons(
    containerEl: HTMLElement,
    items: Array<{ id: string; name: string }>,
    isActive: (id: string) => boolean,
    onClick: (id: string) => void,
) {
    if (items.length === 0) return;
    const group = document.createElement('div');
    group.className = 'button-group';
    items.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'slice-toggle-btn' + (isActive(item.id) ? ' active' : '');
        btn.textContent = item.name;
        btn.onclick = () => onClick(item.id);
        group.appendChild(btn);
    });
    containerEl.appendChild(group);
}

function paintButtonsInto(
    yPos: string,
    slicePos: string,
    yItems: Array<{ id: string; name: string }>,
    sliceItems: Array<{ id: string; name: string }>,
    onYClick: (id: string) => void,
    onSliceClick: (id: string) => void,
) {
    const areas: Record<string, HTMLElement | null> = {
        Top:    document.getElementById('topArea'),
        Bottom: document.getElementById('bottomArea'),
        Left:   document.getElementById('leftArea'),
        Right:  document.getElementById('rightArea'),
    };
    Object.values(areas).forEach(el => { if (el) el.innerHTML = ''; });

    // For the HORIZONTAL areas (top/bottom) only: padding-left will be set
    // to plotLeftAbs in alignButtonAreasToPlot so the buttons start at the
    // gridline — and so any wrapped rows (legend overflow) also start at
    // the gridline rather than the layout's left edge.
    ['topArea', 'bottomArea'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        // Nothing else to do here — the area itself is empty before the
        // buttons/legend are appended below.
    });

    // Skip the y-button group entirely when only one y measure is bound —
    // no point in offering a switcher with a single option.
    if (yItems.length > 1) {
        const yTarget = areas[yPos] ?? areas.Top;
        if (yTarget) renderToggleButtons(yTarget, yItems, id => id === activeYColumnId, onYClick);
    }
    if (sliceItems.length > 0) {
        const sliceTarget = areas[slicePos] ?? areas.Top;
        if (sliceTarget) renderToggleButtons(sliceTarget, sliceItems, id => activeSliceColumnIds.has(id), onSliceClick);
    }
}

type LegendItem = { name: string; color: string; hidden: boolean; onClick: () => void };

function renderCustomLegend(items: Array<LegendItem>) {
    const host = document.getElementById('topArea');
    if (!host) return;
    // Each legend item is appended as a direct sibling of the button groups.
    // #topArea is a wrap flex row, so items fill the remaining space on the
    // first row alongside the buttons, then wrap to row 2, 3, ... as needed
    // — instead of the legend being a single block that either fits or
    // overflows.
    items.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'legend-item' + (item.hidden ? ' legend-hidden' : '');
        const swatch = document.createElement('span');
        swatch.className = 'legend-swatch';
        swatch.style.background = item.color;
        const label = document.createElement('span');
        label.textContent = item.name;
        btn.appendChild(swatch);
        btn.appendChild(label);
        btn.onclick = item.onClick;
        host.appendChild(btn);
    });
}

// Push the button areas so their content lines up with the chart's plot
// area: top/bottom buttons start at plotLeft (i.e. after the y-axis labels)
// and end at plotRight; left/right buttons sit within plotTop..plotBottom
// vertically. Reads positions from getBoundingClientRect so it adapts to the
// actual rendered layout, then applies padding to the four area elements.
function alignButtonAreasToPlot(chart: any, chartTitle: string) {
    const layoutEl = document.getElementById('layout');
    const chartEl  = document.getElementById('chart');
    if (!layoutEl || !chartEl) return;
    const layoutRect = layoutEl.getBoundingClientRect();
    const chartRect  = chartEl.getBoundingClientRect();
    const marginTop = chartTitle.trim() ? CHART_MARGIN_TOP_WITH_TITLE : CHART_MARGIN_TOP_NO_TITLE;

    const plotLeftAbs   = (chartRect.left   - layoutRect.left) + CHART_MARGIN_LEFT;
    const plotTopAbs    = (chartRect.top    - layoutRect.top)  + marginTop;
    const plotRightAbs  = layoutRect.right  - (chartRect.right - CHART_MARGIN_RIGHT);
    const plotBottomAbs = layoutRect.bottom - (chartRect.bottom - CHART_MARGIN_BOTTOM);

    const setStyle = (id: string, s: Record<string, string>) => {
        const el = document.getElementById(id);
        if (el) Object.assign(el.style, s);
    };
    // Horizontal areas: padding-left = plotLeftAbs so every row (including
    // wrapped legend rows) starts at the chart's gridline. padding-right
    // stays 0 so the row can run to the layout's right edge before
    // wrapping — gives the most horizontal room on row 1 before items
    // spill into row 2, while keeping wrapped rows visually aligned with
    // the original buttons above.
    setStyle('topArea', {
        paddingLeft:  `${Math.max(0, plotLeftAbs)}px`,
        paddingRight: '0px',
        paddingTop:    '6px',
        paddingBottom: '6px',
    });
    setStyle('bottomArea', {
        paddingLeft:  `${Math.max(0, plotLeftAbs)}px`,
        paddingRight: '0px',
        paddingTop:    '6px',
        paddingBottom: '6px',
    });
    setStyle('leftArea', {
        paddingTop:    `${Math.max(0, plotTopAbs)}px`,
        // Same idea for the vertical button column — gridline-aligned start,
        // but allow the column to use the chart's full height before
        // wrapping into a second column.
        paddingBottom: '0px',
        paddingLeft:   '6px',
        paddingRight:  '6px',
    });
    setStyle('rightArea', {
        paddingTop:    `${Math.max(0, plotTopAbs)}px`,
        paddingBottom: '0px',
        paddingLeft:   '6px',
        paddingRight:  '6px',
    });

    // Padding changes shifted the chart cell size. Tell Highcharts to
    // re-measure and re-render to match its new container — otherwise the
    // SVG keeps its original size and overflows the (now-smaller) cell,
    // producing the horizontal scrollbar the user was seeing when the
    // legend wrapped to extra rows.
    try { chart?.reflow(); } catch { /* noop */ }
}

type DataModel = {
    xColumn?: { id: string; name: string; dataType?: DataType; timeBucket?: ColumnTimeBucket };
    yColumns: Array<{ id: string; name: string; format?: any }>;
    formulaInputColumns: Array<{ id: string; name: string; format?: any }>;
    sliceColumns: Array<{ id: string; name: string }>;
    dataArr: DataPointsArray;
};

function getDataModel(chartModel: ChartModel): DataModel {
    const dataArr: DataPointsArray =
        chartModel.data?.[chartModel.data.length - 1]?.data ?? { columns: [], dataValue: [] };
    const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
    const xColumn             = dims.find(d => d.key === 'xAxis')?.columns?.[0];
    const yColumns            = dims.find(d => d.key === 'yOptions')?.columns ?? [];
    const formulaInputColumns = dims.find(d => d.key === 'formulaInputs')?.columns ?? [];
    const sliceColumns        = dims.find(d => d.key === 'slices')?.columns ?? [];
    return { xColumn, yColumns, formulaInputColumns, sliceColumns, dataArr };
}

// One pass over the rows that builds per-(slice, x) sums + counts for every
// measure column the caller might need (the active y measure if it's a real
// column, plus all formula input columns). The caller picks a column for
// regular measures, or evaluates a formula against the summed inputs for
// formula-as-y.
function computeAllMeasureSums(
    dataArr: DataPointsArray,
    xCol: { id: string; dataType?: DataType; timeBucket?: ColumnTimeBucket },
    measureCols: Array<{ id: string; name: string }>,
    activeSliceCols: Array<{ id: string; name: string }>,
) {
    const xColIdx = dataArr.columns.indexOf(xCol.id);
    if (xColIdx < 0) {
        return {
            xCategories: [] as string[],
            sliceKeys:   [] as string[],
            // sumsByCol[col.id][sliceKey][xIdx] = aggregated value
            sumsByCol:   {} as Record<string, Record<string, number[]>>,
            countsByCol: {} as Record<string, Record<string, number[]>>,
        };
    }

    const sliceIdxs = activeSliceCols.map(c => dataArr.columns.indexOf(c.id)).filter(i => i >= 0);
    const measureIdxs = measureCols.map(c => ({ col: c, idx: dataArr.columns.indexOf(c.id) }));

    const isExcluded = (v: any): boolean => {
        if (v == null) return true;
        const s = String(v).trim();
        if (!s) return true;
        const lower = s.toLowerCase();
        return lower === '{null}' || lower === '(null)' || lower === 'null';
    };

    const xSet = new Set<string>();
    const sliceKeySet = new Set<string>();
    const SEP = ' — ';
    const NO_SLICE_KEY = '__noslice__';

    for (const row of dataArr.dataValue) {
        const xRaw = row[xColIdx];
        if (isExcluded(xRaw)) continue;
        xSet.add(String(xRaw));
        if (sliceIdxs.length === 0) {
            sliceKeySet.add(NO_SLICE_KEY);
        } else {
            const parts = sliceIdxs.map(i => {
                const v = row[i];
                if (isExcluded(v)) return null;
                return String(v);
            });
            if (parts.some(p => p == null)) continue;
            sliceKeySet.add(parts.join(SEP));
        }
    }

    const xIsDate = isDateLikeCol(xCol);
    const xCategories = Array.from(xSet).sort(
        xIsDate ? (a, b) => Number(a) - Number(b) : naturalCompare,
    );
    const sliceKeys = Array.from(sliceKeySet).sort(naturalCompare);

    const xIndex = new Map<string, number>();
    xCategories.forEach((x, i) => xIndex.set(x, i));

    const sumsByCol: Record<string, Record<string, number[]>> = {};
    const countsByCol: Record<string, Record<string, number[]>> = {};
    for (const { col } of measureIdxs) {
        sumsByCol[col.id]   = {};
        countsByCol[col.id] = {};
        for (const k of sliceKeys) {
            sumsByCol[col.id][k]   = new Array(xCategories.length).fill(0);
            countsByCol[col.id][k] = new Array(xCategories.length).fill(0);
        }
    }

    for (const row of dataArr.dataValue) {
        const xRaw = row[xColIdx];
        if (isExcluded(xRaw)) continue;
        const xi = xIndex.get(String(xRaw));
        if (xi == null) continue;
        let key: string;
        if (sliceIdxs.length === 0) {
            key = NO_SLICE_KEY;
        } else {
            const parts = sliceIdxs.map(i => {
                const v = row[i];
                if (isExcluded(v)) return null;
                return String(v);
            });
            if (parts.some(p => p == null)) continue;
            key = parts.join(SEP);
        }
        for (const { col, idx } of measureIdxs) {
            if (idx < 0) continue;
            const raw = row[idx];
            if (raw == null) continue;
            const v = parseFloat(String(raw));
            if (Number.isNaN(v)) continue;
            sumsByCol[col.id][key][xi]   += v;
            countsByCol[col.id][key][xi] += 1;
        }
    }

    return { xCategories, sliceKeys, sumsByCol, countsByCol };
}

type FormulaDef = { name: string; expr: string };
type YOption =
    | { kind: 'measure'; id: string; name: string; column: { id: string; name: string; format?: any } }
    | { kind: 'formula'; id: string; name: string; expr: string; formulaIdx: number };

function render(ctx: CustomChartContext) {
    const chartModel = ctx.getChartModel();
    const visualProps = (chartModel.visualProps ?? {}) as VisualProps;
    const { xColumn, yColumns, formulaInputColumns, sliceColumns, dataArr } = getDataModel(chartModel);

    // Pick up any defined formulas — same pattern as multi-axis-bar. Each
    // (name, expr) pair becomes a switchable Y option alongside the bound
    // y measures. Formulas reference formulaInputColumns by name and the
    // chart evaluates them against the column-sum-per-(x,slice).
    const formulas: FormulaDef[] = [];
    for (let i = 1; i <= MAX_FORMULAS; i++) {
        const name = (visualProps[`formula${i}Name`] ?? '').trim();
        const expr = (visualProps[`formula${i}Expr`] ?? '').trim();
        if (name && expr) formulas.push({ name, expr });
    }

    // Resolve a per-column custom label, falling back to the bound column
    // name when the user hasn't typed one (or only typed whitespace).
    const customLabel = (key: string, fallback: string): string => {
        const v = visualProps[key];
        return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
    };

    // Build the unified Y option list: bound y measures first, then any
    // formula defs. Each gets a button in the Y switcher. Measure labels
    // honour measureLabel_<id> for the user-renamed display name; formula
    // names are already user-defined.
    const yOptions: YOption[] = [
        ...yColumns.map(c => ({
            kind: 'measure' as const,
            id: c.id,
            name: customLabel(`measureLabel_${c.id}`, c.name),
            column: c,
        })),
        ...formulas.map((f, i) => ({
            kind: 'formula' as const,
            id: `formula_${i}`,
            name: f.name,
            expr: f.expr,
            formulaIdx: i,
        })),
    ];

    if (!xColumn || yOptions.length === 0) {
        ['topArea', 'bottomArea', 'leftArea', 'rightArea'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });
        renderChartMessage('Add an X-axis attribute and at least one Y-axis measure (or define a formula in settings) to render this chart.');
        return;
    }

    if (!activeYColumnId || !yOptions.some(o => o.id === activeYColumnId)) {
        activeYColumnId = yOptions[0].id;
    }
    const activeY = yOptions.find(o => o.id === activeYColumnId)!;
    const activeYName = activeY.name;

    for (const id of Array.from(activeSliceColumnIds)) {
        if (!sliceColumns.some(c => c.id === id)) {
            activeSliceColumnIds.delete(id);
            // Slicer was unbound from the chart entirely — clear hidden
            // values too, matching the "remove + re-add = fresh slate"
            // expectation users have from re-binding columns.
            hiddenValuesBySlicer.delete(id);
        }
    }

    const slicingDefault = visualProps.showSlicingByDefault ?? false;
    if (!sliceDefaultsInitialised || slicingDefault !== lastSeenSlicingDefault) {
        sliceDefaultsInitialised = true;
        lastSeenSlicingDefault = slicingDefault;
        if (slicingDefault && sliceColumns.length > 0) {
            activeSliceColumnIds.clear();
            activeSliceColumnIds.add(sliceColumns[0].id);
        } else if (!slicingDefault) {
            activeSliceColumnIds.clear();
        }
    }

    const chartTitle    = visualProps.chartTitle    ?? '';
    const xAxisTitle    = visualProps.xAxisTitle    ?? '';
    const yAxisTitleRaw = visualProps.yAxisTitle    ?? '';
    // Default the y-axis title to the active measure's name when the user
    // leaves the setting blank (or at its placeholder ' ' value). The
    // setting defaults to a single space so we have to trim before deciding.
    const yAxisTitle    = yAxisTitleRaw.trim() ? yAxisTitleRaw : activeYName;
    const numberFormat  = visualProps.numberFormat  ?? '0,0.[0]a';
    const currency      = visualProps.currency      ?? 'None';
    const showDataLabels = visualProps.showDataLabels ?? false;
    const showLegend    = visualProps.showLegend    ?? true;
    const showGridLines = visualProps.showGridLines ?? true;
    const lineWidth     = visualProps.lineWidth     ?? 2;
    const markerEnabled = visualProps.markerEnabled ?? true;
    const markerRadius  = visualProps.markerRadius  ?? 4;
    const smoothLines   = visualProps.smoothLines   ?? false;
    const yButtonsPos     = visualProps.yButtonsPosition     ?? 'Top';
    const sliceButtonsPos = visualProps.sliceButtonsPosition ?? 'Top';

    paintButtonsInto(
        yButtonsPos,
        sliceButtonsPos,
        yOptions.map(o => ({ id: o.id, name: o.name })),
        sliceColumns.map(c => ({ id: c.id, name: customLabel(`sliceLabel_${c.id}`, c.name) })),
        (id) => {
            activeYColumnId = id;
            render(ctx);
        },
        (id) => {
            if (activeSliceColumnIds.has(id)) {
                activeSliceColumnIds.delete(id);
                // Deactivating a slicer is "remove" in the user's mental
                // model — drop its hidden values so re-activating starts
                // fresh and shows everything. Hidden values for OTHER
                // slicers stay intact, so the user can layer slicers
                // without losing their existing zoom-in state.
                hiddenValuesBySlicer.delete(id);
            } else {
                activeSliceColumnIds.add(id);
            }
            render(ctx);
        },
    );

    const activeSliceCols = sliceColumns.filter(c => activeSliceColumnIds.has(c.id));

    // Build the full set of measure columns we need sums for: the y measures
    // (so simple measure renders still work) AND the formula inputs (so
    // formulas can reference them). Dedupe by column id.
    const allMeasureCols: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    for (const c of [...yColumns, ...formulaInputColumns]) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        allMeasureCols.push(c);
    }

    const { xCategories, sliceKeys, sumsByCol, countsByCol } = computeAllMeasureSums(
        dataArr, xColumn, allMeasureCols, activeSliceCols,
    );

    if (xCategories.length === 0 || sliceKeys.length === 0) {
        renderChartMessage('No data to render for the current selection.');
        return;
    }

    const xIsDate = isDateLikeCol(xColumn);
    const xCategoryLabels = xIsDate
        ? xCategories.map(v => formatEpochByBucket(v, xColumn.timeBucket))
        : xCategories;

    // Percent detection: a measure is a percent if its column name/format
    // looks like one; a formula is a percent if its name looks like one OR
    // its expression contains a division (since 'numerator/denominator' is
    // almost always a ratio). The flag drives both the axis formatter and
    // whether we average vs sum.
    const yIsPercent = activeY.kind === 'measure'
        ? detectPercentByName(activeY.column.name, (activeY.column as any)?.format?.pattern)
        : (/[\/]/.test(activeY.expr) || detectPercentByName(activeY.name));

    // Build seriesGroups for the active y. For a measure: pick that column's
    // sums per (slice, x), divide by count if percent. For a formula:
    // evaluate the expression per (slice, x) cell using the per-cell sums
    // of every formulaInputColumn — that gives a SUM(num)/SUM(den) ratio
    // which is independent of the GROUP BY granularity, so the value stays
    // stable when you add/remove slicers.
    const NO_SLICE_KEY = '__noslice__';
    // Diagnostic log for formula debugging — shows up in DevTools whenever
    // the active Y is a formula. Logs the resolved input names, a sample
    // valuesByName, and whether evalFormula returned null (unresolved).
    let formulaDiagLogged = false;
    const seriesGroups: Array<{ name: string; data: number[] }> = sliceKeys.map(key => {
        let data: number[];
        if (activeY.kind === 'measure') {
            const sums   = sumsByCol[activeY.column.id][key]   ?? new Array(xCategories.length).fill(0);
            const counts = countsByCol[activeY.column.id][key] ?? new Array(xCategories.length).fill(0);
            data = sums.map((s, i) => yIsPercent ? (counts[i] > 0 ? s / counts[i] : 0) : s);
        } else {
            data = xCategories.map((_, xi) => {
                const valuesByName: Record<string, number> = {};
                for (const col of allMeasureCols) {
                    valuesByName[col.name] = sumsByCol[col.id]?.[key]?.[xi] ?? 0;
                }
                // Iteratively resolve formula → formula references. Each
                // pass tries every formula whose name isn't yet in
                // valuesByName; if its expression resolves with what we
                // already know, we add its result. Repeat until a pass
                // adds nothing new (or until we've made #formulas passes,
                // which caps cycles). After this loop every resolvable
                // formula value is available by name so the active
                // formula can reference any other.
                for (let pass = 0; pass <= formulas.length; pass++) {
                    let progress = false;
                    for (const f of formulas) {
                        if (valuesByName[f.name] != null) continue;
                        const r = evalFormula(f.expr, valuesByName);
                        if (r != null) { valuesByName[f.name] = r; progress = true; }
                    }
                    if (!progress) break;
                }
                const v = evalFormula(activeY.expr, valuesByName);
                if (!formulaDiagLogged) {
                    formulaDiagLogged = true;
                    // Reproduce the substitution evalFormula does, so the
                    // log shows EXACTLY what's left unresolved after column
                    // names are replaced. If processedExpr still contains
                    // letters or brackets, those are names the chart can't
                    // see — the user needs to bind that column to either
                    // 'Y-axis options' or 'Formula inputs'.
                    const sortedNames = Object.keys(valuesByName).sort((a, b) => b.length - a.length);
                    let processedExpr = activeY.expr;
                    for (const name of sortedNames) {
                        processedExpr = processedExpr.split(`[${name}]`).join(`(${valuesByName[name]})`);
                    }
                    for (const name of sortedNames) {
                        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        processedExpr = processedExpr.replace(new RegExp(escaped, 'g'), `(${valuesByName[name]})`);
                    }
                    const unresolved = /[a-zA-Z_\[\]]/.test(processedExpr);
                    // Print the expression and bound names on top-level lines
                    // so the user doesn't have to expand a collapsed Object in
                    // DevTools to see them.
                    console.log('[multi_y_axis_line formula] EXPRESSION:', activeY.expr);
                    console.log('[multi_y_axis_line formula] BOUND NAMES:', allMeasureCols.map(c => c.name));
                    console.log('[multi_y_axis_line formula] AFTER SUBSTITUTION:', processedExpr);
                    console.log('[multi_y_axis_line formula] RESULT @ first x:', v);
                    console.log('[multi_y_axis_line formula] (full diag)', {
                        formulaName:    activeY.name,
                        formulaExpr:    activeY.expr,
                        boundMeasures:  allMeasureCols.map(c => c.name),
                        sampleValuesByName: valuesByName,
                        processedExpr,
                        unresolvedNamesInExpr: unresolved,
                        result:         v,
                    });
                    if (unresolved) {
                        console.warn(
                            '[multi_y_axis_line formula] Could not resolve all names in the formula. ' +
                            'Names must match a column bound to "Y-axis options" or "Formula inputs" ' +
                            '(matching is case-insensitive). Currently bound: ' +
                            allMeasureCols.map(c => `"${c.name}"`).join(', '),
                        );
                    }
                }
                return v ?? 0;
            });
        }
        return { name: key === NO_SLICE_KEY ? '' : key, data };
    });
    // Always abbreviate non-percent values to K/M/B in tooltips and data
    // labels too — big numbers like 1,775,000,000 are unreadable. The
    // user's numberFormat is still honoured for decimals/grouping; we just
    // ensure 'a' (numeral's abbreviate modifier) is present.
    const tooltipNumberFormat = numberFormat.includes('a') ? numberFormat : numberFormat + 'a';
    const fmtY = (v: number) => yIsPercent
        ? formatPercent(v, numberFormat.replace(/[\$€£¥₹]/g, ''))
        : formatCurrency(v, tooltipNumberFormat, currency);
    // Axis labels are always abbreviated to K/M/B (or %) regardless of the
    // user's numberFormat — keeps the axis compact even when numberFormat is
    // set to something verbose like 0,0.00 for tooltip precision.
    const fmtAxis = (v: number) => {
        if (yIsPercent) return formatPercent(v, '0.[0]');
        try {
            return numeral(v).format('0.[0]a').replace('k', 'K').replace('m', 'M').replace('b', 'B');
        } catch {
            return String(v);
        }
    };

    const palette = getEffectivePalette();
    // Per-series-name hidden tracking was replaced by per-(slicer, value)
    // hidden tracking (hiddenValuesBySlicer) so the legend can stay flat —
    // one item per slicer value, not per cross-product combination.

    // Colour strategy:
    //   * No slicer active → series gets the active y's own colour
    //     (measureColor_<id> or formulaColor_<idx>), default = palette[0].
    //   * Exactly ONE slicer active → for each series, check if the user
    //     set a per-slice-value colour (sliceValueColor_<slicerId>_<value>);
    //     if so use that, else fall back to a shade of the slicer's base
    //     colour. Lets users individually colour every distinct value.
    //   * MULTIPLE slicers active → take the PRIMARY slicer's value colour
    //     for each series (so the user's per-value picks for the primary
    //     slicer are preserved) and then derive light/dark shades using the
    //     secondary slicer's value index, so secondary values just vary
    //     lightness within each primary colour.
    const primarySlicer = sliceColumns.find(c => activeSliceColumnIds.has(c.id));

    // Precompute unique values for each active slicer (insertion order from
    // dataArr — matches what the legend uses). Cached so colour derivation
    // and the legend itself don't both iterate dataValue.
    const slicerUniqueValues = new Map<string, string[]>();
    for (const slicer of activeSliceCols) {
        const slicerColIdx = dataArr.columns.indexOf(slicer.id);
        if (slicerColIdx < 0) continue;
        const set = new Set<string>();
        for (const row of dataArr.dataValue) {
            const v = row[slicerColIdx];
            if (v == null) continue;
            const s = String(v).trim();
            if (!s) continue;
            set.add(s);
        }
        slicerUniqueValues.set(slicer.id, Array.from(set));
    }

    const measureColorKey = activeY.kind === 'measure'
        ? `measureColor_${activeY.column.id}`
        : `formulaColor_${activeY.formulaIdx}`;

    // Look up the user-chosen colour for a specific primary-slicer value,
    // falling back to a shade of the slicer's base colour across its full
    // value list when no per-value pick exists.
    const primaryValueColor = (primaryValue: string): string => {
        if (!primarySlicer) return palette[0];
        const explicit = visualProps[`sliceValueColor_${primarySlicer.id}_${primaryValue}`];
        if (typeof explicit === 'string' && explicit) return explicit;
        const primaryValues = slicerUniqueValues.get(primarySlicer.id) ?? [];
        const base = pickColor(visualProps[`sliceBaseColor_${primarySlicer.id}`], palette[0]);
        const shades = generateShades(base, primaryValues.length);
        const idx = primaryValues.indexOf(primaryValue);
        return idx >= 0 ? shades[idx] : base;
    };

    const seriesSpecs = seriesGroups.map((g, i) => {
        const isNoSlice = g.name === '';
        const displayName = isNoSlice ? activeYName : g.name;
        let color: string;
        if (isNoSlice || !primarySlicer) {
            color = pickColor(visualProps[measureColorKey], palette[i % palette.length]);
        } else {
            const parts = g.name.split(' — ');
            const primaryValue = parts[0];
            const baseColor = primaryValueColor(primaryValue);
            if (activeSliceCols.length === 1) {
                color = baseColor;
            } else {
                // 2+ slicers: shade the primary value's colour by the
                // secondary slicer's value index. Each primary keeps its
                // user-picked colour; secondary just varies lightness.
                const secondarySlicer = activeSliceCols[1];
                const secondaryValues = slicerUniqueValues.get(secondarySlicer.id) ?? [];
                const secondaryIdx = secondaryValues.indexOf(parts[1] ?? '');
                if (secondaryValues.length > 1 && secondaryIdx >= 0) {
                    const shades = generateShades(baseColor, secondaryValues.length);
                    color = shades[secondaryIdx];
                } else {
                    color = baseColor;
                }
                // 3+ active slicers fall through with the 2-slicer shade —
                // additional slicers don't add further variation; the user
                // can hide individual values via the legend if needed.
            }
        }
        return { name: displayName, data: g.data, color };
    });

    // Legend: one item per (active slicer, distinct value). When multiple
    // slicers are active the user gets one row per *value* per slicer (not
    // one per cross-product combination), so they can click any single
    // value to hide every series containing it — "zoom in" by exclusion.
    // Series visibility below is then derived from hiddenValuesBySlicer.
    const SEP = ' — ';
    if (showLegend && activeSliceCols.length > 0) {
        const legendItems: LegendItem[] = [];
        for (const [sIdx, slicer] of activeSliceCols.entries()) {
            const sortedValues = slicerUniqueValues.get(slicer.id) ?? [];
            if (sortedValues.length === 0) continue;
            const slicerBase = pickColor(visualProps[`sliceBaseColor_${slicer.id}`], palette[sIdx % palette.length]);
            const valueShades = generateShades(slicerBase, sortedValues.length);
            const slicerLabel = customLabel(`sliceLabel_${slicer.id}`, slicer.name);
            sortedValues.forEach((value, valueIdx) => {
                const color = pickColor(
                    visualProps[`sliceValueColor_${slicer.id}_${value}`],
                    valueShades[valueIdx],
                );
                const displayName = activeSliceCols.length > 1 ? `${slicerLabel}: ${value}` : value;
                const hiddenSet = hiddenValuesBySlicer.get(slicer.id);
                const isHidden = hiddenSet?.has(value) ?? false;
                legendItems.push({
                    name:  displayName,
                    color,
                    hidden: isHidden,
                    onClick: () => {
                        if (!hiddenValuesBySlicer.has(slicer.id)) hiddenValuesBySlicer.set(slicer.id, new Set());
                        const set = hiddenValuesBySlicer.get(slicer.id)!;
                        if (set.has(value)) set.delete(value); else set.add(value);
                        render(ctx);
                    },
                });
            });
        }
        if (legendItems.length > 0) renderCustomLegend(legendItems);
    }

    // A cross-product series is hidden if any of its component slice values
    // is in the corresponding slicer's hidden set.
    const isSeriesHidden = (seriesName: string): boolean => {
        if (activeSliceCols.length === 0) return false;
        const parts = seriesName.split(SEP);
        return activeSliceCols.some((slicer, idx) => {
            const set = hiddenValuesBySlicer.get(slicer.id);
            if (!set) return false;
            return set.has(parts[idx] ?? '');
        });
    };

    if (globalChartReference) {
        try { globalChartReference.destroy(); } catch { /* noop */ }
        globalChartReference = null;
    }

    const marginTop = chartTitle.trim() ? CHART_MARGIN_TOP_WITH_TITLE : CHART_MARGIN_TOP_NO_TITLE;

    globalChartReference = Highcharts.chart('chart', {
        chart: {
            type: smoothLines ? 'spline' : 'line',
            marginLeft:   CHART_MARGIN_LEFT,
            marginRight:  CHART_MARGIN_RIGHT,
            marginTop,
            marginBottom: CHART_MARGIN_BOTTOM,
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
                text:  xAxisTitle.trim() ? xAxisTitle : xColumn.name,
                style: { fontWeight: 'bold', color: '#555' },
            },
            labels: {
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
                formatter: function (this: any) { return fmtAxis(this.value); },
                style: { color: '#555', fontSize: '11px' },
            },
        },
        legend: { enabled: false },
        tooltip: {
            useHTML: true,
            backgroundColor: 'rgba(0,0,0,0)',
            borderWidth: 0,
            shadow: false,
            padding: 0,
            shared: true,
            formatter: function (this: any) {
                const cat = this.x;
                // Order the rows by value descending so the entry at the top
                // of the tooltip matches the line that's visually highest at
                // this x point.
                const sorted = (this.points ?? []).slice().sort(
                    (a: any, b: any) => (b.y ?? -Infinity) - (a.y ?? -Infinity),
                );
                const rows = sorted.map((p: any) =>
                    `<div style="display:flex;align-items:center;gap:6px;">
                        <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${p.color};"></span>
                        <span>${p.series.name}:</span>
                        <b style="margin-left:auto;">${fmtY(p.y)}</b>
                    </div>`).join('');
                return `<div style="border:1px solid #555;border-radius:8px;background:#3A3F48;padding:10px 12px;color:#FFFFFF;font-size:12px;min-width:160px;">
                    <div style="font-weight:600;margin-bottom:6px;">${cat}</div>
                    ${rows}
                </div>`;
            },
        },
        plotOptions: {
            series: {
                lineWidth,
                marker: { enabled: markerEnabled, radius: markerRadius, symbol: 'circle' },
                dataLabels: {
                    enabled: showDataLabels,
                    formatter: function (this: any) {
                        if (this.y == null) return '';
                        return fmtY(this.y);
                    },
                    style: { fontSize: '11px', fontWeight: '600', textOutline: 'none', color: '#333' },
                },
                states: { hover: { lineWidthPlus: 1 } },
            },
        },
        series: seriesSpecs.map(s => ({
            type:    smoothLines ? 'spline' : 'line',
            name:    s.name,
            data:    s.data,
            color:   s.color,
            visible: !isSeriesHidden(s.name),
            showInLegend: false,
        })),
    });

    // Now that the chart has rendered with its fixed margins, push the
    // button areas in so they line up with the plot gridlines.
    alignButtonAreasToPlot(globalChartReference, chartTitle);
}

const renderChart = async (ctx: CustomChartContext) => {
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
    if (!firstRenderDone) { doRender(); return; }
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
            const cols = chartModel.columns;
            const attributeColumns = cols.filter(c => c.type === ColumnType.ATTRIBUTE);
            const measureColumns   = cols.filter(c => c.type === ColumnType.MEASURE);
            return [{
                key: 'main',
                dimensions: [
                    { key: 'xAxis',         columns: attributeColumns.slice(0, 1) },
                    { key: 'yOptions',      columns: measureColumns.slice(0, 1)   },
                    { key: 'formulaInputs', columns: []                           },
                    { key: 'slices',        columns: []                           },
                ],
            }];
        },
        getQueriesFromChartConfig: (chartConfig: ChartConfig[], chartModel: ChartModel): Array<Query> => {
            const queries = (chartConfig ?? []).map(config =>
                (config?.dimensions ?? []).reduce(
                    (acc: Query, dimension) => ({
                        queryColumns: [...acc.queryColumns, ...(dimension?.columns ?? [])],
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
            label:           'Multi Y-Axis Line Chart',
            descriptionText: 'Pick one attribute for the x-axis and one or more measures for the y-axis (toggle between them with the Y buttons; the button row is hidden if there is only one measure). Add any number of slicer attributes — each slicer can be toggled on/off, and any combination active simultaneously splits the line by the cross-product of slice values.',
            columnSections: [
                {
                    key: 'xAxis',
                    label: 'X-axis (attribute)',
                    allowAttributeColumns: true,
                    allowMeasureColumns: false,
                    allowTimeSeriesColumns: true,
                    maxColumnCount: 1,
                },
                {
                    key: 'yOptions',
                    label: 'Y-axis options (measures) — switchable',
                    allowAttributeColumns: false,
                    allowMeasureColumns: true,
                    allowTimeSeriesColumns: false,
                },
                {
                    key: 'formulaInputs',
                    label: 'Formula inputs (measures) — referenced by name in formula expressions',
                    allowAttributeColumns: false,
                    allowMeasureColumns: true,
                    allowTimeSeriesColumns: false,
                },
                {
                    key: 'slices',
                    label: 'Slicers (attributes) — toggleable',
                    allowAttributeColumns: true,
                    allowMeasureColumns: false,
                    allowTimeSeriesColumns: true,
                },
            ],
        }],
        visualPropEditorDefinition: (chartModel: ChartModel) => {
            // Dynamic so we can emit:
            //   - rename + colour per bound y measure (measureLabel_, measureColor_)
            //   - rename + base-colour per bound slicer (sliceLabel_, sliceBaseColor_)
            //   - per-slice-value colour picker for every distinct value of
            //     each bound slicer (sliceValueColor_<slicer>_<value>)
            //   - per-formula slots so the user can name formulas + their
            //     expression and pick a colour for each
            const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
            const yCols  = dims.find(d => d.key === 'yOptions')?.columns ?? [];
            const slices = dims.find(d => d.key === 'slices')?.columns ?? [];
            const editorPalette = getEffectivePalette();
            const dataArr = chartModel.data?.[chartModel.data.length - 1]?.data;

            const measureControls: any[] = [];
            yCols.forEach((col, i) => {
                measureControls.push({
                    key:          `measureLabel_${col.id}`,
                    type:         'text' as const,
                    defaultValue: ' ',
                    label:        `Label: ${col.name} (blank = column name)`,
                });
                measureControls.push({
                    key:          `measureColor_${col.id}`,
                    type:         'colorpicker' as const,
                    defaultValue: editorPalette[i % editorPalette.length],
                    label:        `Colour: ${col.name}`,
                });
            });

            const slicerControls: any[] = [];
            slices.forEach((col, i) => {
                slicerControls.push({
                    key:          `sliceLabel_${col.id}`,
                    type:         'text' as const,
                    defaultValue: ' ',
                    label:        `Slicer label: ${col.name} (blank = column name)`,
                });
                slicerControls.push({
                    key:          `sliceBaseColor_${col.id}`,
                    type:         'colorpicker' as const,
                    defaultValue: editorPalette[(yCols.length + i) % editorPalette.length],
                    label:        `Slicer base colour: ${col.name} (used when 2+ slicers active)`,
                });

                // Per-value colour pickers. Only meaningful when this slicer
                // is the only active one — otherwise the chart auto-shades.
                if (dataArr) {
                    const sliceColIdx = dataArr.columns.indexOf(col.id);
                    if (sliceColIdx >= 0) {
                        const uniqueValues: string[] = [];
                        const seen = new Set<string>();
                        for (const row of dataArr.dataValue) {
                            const raw = row[sliceColIdx];
                            if (raw == null) continue;
                            const v = String(raw);
                            if (!v.trim()) continue;
                            if (!seen.has(v)) { seen.add(v); uniqueValues.push(v); }
                        }
                        uniqueValues.sort((a, b) =>
                            a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
                        );
                        uniqueValues.forEach((v, j) => {
                            slicerControls.push({
                                key:          `sliceValueColor_${col.id}_${v}`,
                                type:         'colorpicker' as const,
                                defaultValue: editorPalette[(yCols.length + i + j + 1) % editorPalette.length],
                                label:        `${col.name} — ${v}`,
                            });
                        });
                    }
                }
            });

            // Formula slots. Progressive: always one empty slot after the
            // last filled formula (so the UI looks like an "add formula"
            // button without literally being one).
            const visualPropsForEditor = (chartModel.visualProps ?? {}) as VisualProps;
            let maxFilledIdx = 0;
            for (let i = 1; i <= MAX_FORMULAS; i++) {
                const n = (visualPropsForEditor[`formula${i}Name`] ?? '').trim();
                if (n) maxFilledIdx = i;
            }
            const visibleFormulas = Math.max(1, Math.min(maxFilledIdx + 1, MAX_FORMULAS));
            const formulaControls: any[] = [];
            for (let i = 1; i <= visibleFormulas; i++) {
                formulaControls.push(
                    { key: `formula${i}Name`,  type: 'text' as const,        defaultValue: ' ', label: `Formula ${i} name (blank = unused)` },
                    { key: `formula${i}Expr`,  type: 'text' as const,        defaultValue: ' ', label: `Formula ${i} expression (use Formula inputs by name)` },
                    { key: `formulaColor_${i - 1}`, type: 'colorpicker' as const, defaultValue: editorPalette[(yCols.length + slices.length + i - 1) % editorPalette.length], label: `Colour: Formula ${i}` },
                );
            }

            return {
                elements: [
                    { key: 'chartTitle',         type: 'text',        defaultValue: ' ',            label: 'Chart title' },
                    { key: 'xAxisTitle',         type: 'text',        defaultValue: ' ',            label: 'X-axis title (blank = column name)' },
                    { key: 'yAxisTitle',         type: 'text',        defaultValue: ' ',            label: 'Y-axis title (blank = measure name)' },
                    { key: 'numberFormat',       type: 'text',        defaultValue: '0,0.[0]a',     label: 'Number format' },
                    { key: 'currency',           type: 'dropdown',    defaultValue: 'None',         values: CURRENCY_OPTIONS, label: 'Currency symbol (labels only, not axis)' },
                    { key: 'yButtonsPosition',     type: 'dropdown', defaultValue: 'Top', values: POSITION_OPTIONS, label: 'Y-axis buttons position' },
                    { key: 'sliceButtonsPosition', type: 'dropdown', defaultValue: 'Top', values: POSITION_OPTIONS, label: 'Slicer buttons position' },
                    { key: 'showSlicingByDefault', type: 'checkbox', defaultValue: false, label: 'Activate first slicer by default' },
                    { key: 'showLegend',         type: 'checkbox',    defaultValue: true,           label: 'Show legend' },
                    { key: 'showGridLines',      type: 'checkbox',    defaultValue: true,           label: 'Show grid lines' },
                    { key: 'lineWidth',          type: 'number',      defaultValue: 2,              label: 'Line width' },
                    { key: 'markerEnabled',      type: 'checkbox',    defaultValue: true,           label: 'Show markers' },
                    { key: 'markerRadius',       type: 'number',      defaultValue: 4,              label: 'Marker size' },
                    { key: 'smoothLines',        type: 'checkbox',    defaultValue: false,          label: 'Smooth (spline) lines' },
                    { key: 'showDataLabels',     type: 'checkbox',    defaultValue: false,          label: 'Show value at each data point' },
                    ...measureControls,
                    ...formulaControls,
                    ...slicerControls,
                ],
            };
        },
    });

    renderChart(ctx);
})();
