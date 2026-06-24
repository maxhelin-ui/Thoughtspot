import {
    ChartToTSEvent,
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
import Highcharts from 'highcharts';
import HighchartsMore from 'highcharts/highcharts-more';
import numeral from 'numeral';

HighchartsMore(Highcharts);

interface VisualProps {
    chartTitle?: string;
    xAxisTitle?: string;
    yAxisTitle?: string;
    numberFormat?: string;
    currency?: string;
    pointColourMode?: string;
    showGridLines?: boolean;
    showLegend?: boolean;
    showDots?: boolean;
    showViolins?: boolean;
    violinFill?: string;
    violinStroke?: string;
    violinOpacity?: number;
    violinMaxWidth?: number;
    violinMinWidth?: number;
    dotRadius?: number;
    dotOpacity?: number;
    jitterWidth?: number;
    categoryButtonsPosition?: string;
    yValueFormat?: string;
    singlePointColor?: string;
    [key: string]: any;
}

type BoundColumn = {
    id: string;
    name: string;
    dataType?: DataType;
    timeBucket?: ColumnTimeBucket;
    format?: any;
};

type PlotPoint = {
    x: number;
    y: number;
    category: string;
    categoryLabel: string;
    categoryColor: string;
    categoryValueColor: string;
    slice?: string;
    sliceColor?: string;
};

type CategoryGroup = {
    raw: string;
    label: string;
    color: string;
    values: number[];
    points: PlotPoint[];
};

const CURRENCY_OPTIONS = ['None', '$', '€', '£', '¥', '₹', 'kr'];
const POINT_COLOUR_OPTIONS = ['Category', 'Slice', 'Single'];
const CATEGORY_BUTTON_POSITION_OPTIONS = ['Top', 'Bottom'];
const Y_VALUE_FORMAT_OPTIONS = ['Number', 'Currency', 'Percent'];
const DEFAULT_PALETTE = ['#378ADD', '#E24B4A', '#00A64F', '#F01313', '#534AB7', '#F0A937', '#52B788', '#E78AC3'];
const KDE_SAMPLE_COUNT = 64;

let globalChartReference: any = null;
let globalAppConfig: any = null;
let renderDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let firstRenderDone = false;
let lastRenderedDataRef: unknown = null;
let activeXColumnId: string | null = null;

function getEffectivePalette(): string[] {
    const palettes = globalAppConfig?.styleConfig?.chartColorPalettes;
    if (Array.isArray(palettes) && palettes.length > 0
        && Array.isArray(palettes[0]?.colors) && palettes[0].colors.length > 0) {
        return palettes[0].colors;
    }
    return DEFAULT_PALETTE;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function pickColor(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value : fallback;
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
    const cleanFormat = format.replace(/^[\$€£¥₹]/, '');
    try {
        return numeral(value).format(cleanFormat.endsWith('%') ? cleanFormat : cleanFormat + '%');
    } catch {
        return `${(value * 100).toFixed(1)}%`;
    }
}

function isExcluded(value: unknown): boolean {
    if (value == null) return true;
    const text = String(value).trim();
    if (!text) return true;
    const lower = text.toLowerCase();
    return lower === '{null}' || lower === '(null)' || lower === 'null';
}

function isDateLikeCol(col: BoundColumn | undefined): boolean {
    if (!col) return false;
    if (col.dataType === DataType.DATE || col.dataType === DataType.DATE_TIME) return true;
    return col.timeBucket != null && col.timeBucket !== ColumnTimeBucket.NO_BUCKET;
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
        case ColumnTimeBucket.WEEKLY:
        case ColumnTimeBucket.DAILY:            return utc({ month: 'short', day: 'numeric', year: 'numeric' });
        case ColumnTimeBucket.HOURLY:           return utc({ month: 'short', day: 'numeric', hour: 'numeric' });
        case ColumnTimeBucket.HOUR_OF_DAY:      return `${d.getUTCHours()}:00`;
        case ColumnTimeBucket.DAY_OF_WEEK:      return utc({ weekday: 'short' });
        case ColumnTimeBucket.DAY_OF_MONTH:
        case ColumnTimeBucket.DAY_OF_QUARTER:   return String(d.getUTCDate());
        case ColumnTimeBucket.DAY_OF_YEAR:      return utc({ month: 'short', day: 'numeric' });
        case ColumnTimeBucket.WEEK_OF_MONTH:
        case ColumnTimeBucket.WEEK_OF_QUARTER:
        case ColumnTimeBucket.WEEK_OF_YEAR:     return `Wk ${Math.ceil(d.getUTCDate() / 7)}`;
        case ColumnTimeBucket.MONTH_OF_QUARTER:
        case ColumnTimeBucket.MONTH_OF_YEAR:    return utc({ month: 'short' });
        case ColumnTimeBucket.QUARTER_OF_YEAR:  return `Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
        default:                                return utc({ month: 'short', day: 'numeric', year: 'numeric' });
    }
}

function hashToUnit(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
}

function mean(values: number[]): number {
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Loop-based min/max. `Math.min(...values)` passes every element as a call
// argument and overflows the call stack once a category holds tens of
// thousands of points (the query allows up to 100000 rows) — which crashed
// render() and left the tile blank.
function arrayMin(values: number[]): number {
    let m = Infinity;
    for (const v of values) if (v < m) m = v;
    return m;
}

function arrayMax(values: number[]): number {
    let m = -Infinity;
    for (const v of values) if (v > m) m = v;
    return m;
}

function standardDeviation(values: number[]): number {
    if (values.length < 2) return 0;
    const m = mean(values);
    const variance = values.reduce((sum, v) => sum + Math.pow(v - m, 2), 0) / (values.length - 1);
    return Math.sqrt(variance);
}

function bandwidth(values: number[]): number {
    const min = arrayMin(values);
    const max = arrayMax(values);
    const range = max - min;
    const sd = standardDeviation(values);
    const silverman = 1.06 * sd * Math.pow(values.length, -0.2);
    if (Number.isFinite(silverman) && silverman > 0) return silverman;
    if (range > 0) return range / 6;
    const center = Math.abs(values[0] ?? 1);
    return Math.max(center * 0.05, 1);
}

function gaussianKernel(u: number): number {
    return Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
}

function buildViolinPolygon(values: number[], x: number, maxHalfWidth: number, minHalfWidth: number): Array<[number, number]> {
    if (values.length === 0) return [];
    const bw = bandwidth(values);
    const minValue = arrayMin(values);
    const maxValue = arrayMax(values);
    const domainMin = minValue === maxValue ? minValue - bw : minValue - bw * 1.4;
    const domainMax = minValue === maxValue ? maxValue + bw : maxValue + bw * 1.4;
    const samples: Array<{ y: number; density: number }> = [];

    for (let i = 0; i < KDE_SAMPLE_COUNT; i++) {
        const t = KDE_SAMPLE_COUNT === 1 ? 0 : i / (KDE_SAMPLE_COUNT - 1);
        const y = domainMin + (domainMax - domainMin) * t;
        const density = values.reduce((sum, v) => sum + gaussianKernel((y - v) / bw), 0) / (values.length * bw);
        samples.push({ y, density });
    }

    const maxDensity = Math.max(...samples.map(s => s.density), 0);
    if (!Number.isFinite(maxDensity) || maxDensity <= 0) return [];

    const left: Array<[number, number]> = samples.map(s => {
        const width = Math.max(minHalfWidth, (s.density / maxDensity) * maxHalfWidth);
        return [x - width, s.y];
    });
    const right: Array<[number, number]> = samples.slice().reverse().map(s => {
        const width = Math.max(minHalfWidth, (s.density / maxDensity) * maxHalfWidth);
        return [x + width, s.y];
    });
    return [...left, ...right, left[0]];
}

function customLabel(visualProps: VisualProps, key: string, fallback: string): string {
    const value = visualProps[key];
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function renderCategoryButtons(
    position: string,
    items: Array<{ id: string; name: string }>,
    onClick: (id: string) => void,
) {
    const top = document.getElementById('topArea');
    const bottom = document.getElementById('bottomArea');
    if (top) top.innerHTML = '';
    if (bottom) bottom.innerHTML = '';
    if (items.length <= 1) return;

    const target = position === 'Bottom' ? bottom : top;
    if (!target) return;
    const group = document.createElement('div');
    group.className = 'button-group';
    items.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'category-toggle-btn' + (item.id === activeXColumnId ? ' active' : '');
        btn.textContent = item.name;
        btn.onclick = () => onClick(item.id);
        group.appendChild(btn);
    });
    target.appendChild(group);
}

function renderChartMessage(text: string) {
    const el = document.getElementById('chart');
    if (!el) return;
    if (globalChartReference) {
        try { globalChartReference.destroy(); } catch { /* noop */ }
        globalChartReference = null;
    }
    el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6B7280;font-size:14px;font-family:inherit;text-align:center;padding:20px;">${text}</div>`;
}

function getDataModel(chartModel: ChartModel) {
    const dataArr: DataPointsArray =
        chartModel.data?.[chartModel.data.length - 1]?.data ?? { columns: [], dataValue: [] };
    const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
    const xColumns = (dims.find(d => d.key === 'xAxis')?.columns ?? []) as BoundColumn[];
    const yColumn = dims.find(d => d.key === 'yValue')?.columns?.[0] as BoundColumn | undefined;
    const colorColumn = dims.find(d => d.key === 'color')?.columns?.[0] as BoundColumn | undefined;
    return { dataArr, xColumns, yColumn, colorColumn };
}

function buildGroups(
    dataArr: DataPointsArray,
    xColumn: BoundColumn,
    yColumn: BoundColumn,
    colorColumn: BoundColumn | undefined,
    visualProps: VisualProps,
): { groups: CategoryGroup[]; sliceColors: Map<string, string> } {
    const xIdx = dataArr.columns.indexOf(xColumn.id);
    const yIdx = dataArr.columns.indexOf(yColumn.id);
    const colorIdx = colorColumn ? dataArr.columns.indexOf(colorColumn.id) : -1;
    const palette = getEffectivePalette();
    const rawGroups = new Map<string, Array<{ y: number; slice?: string; ordinal: number }>>();
    const sliceColors = new Map<string, string>();
    let pointOrdinal = 0;

    if (xIdx < 0 || yIdx < 0) return { groups: [], sliceColors };

    for (const row of dataArr.dataValue) {
        const rawCategory = row[xIdx];
        if (isExcluded(rawCategory)) continue;
        const rawValue = row[yIdx];
        const y = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue));
        if (!Number.isFinite(y)) continue;

        const category = String(rawCategory);
        let slice: string | undefined;
        if (colorIdx >= 0) {
            const rawSlice = row[colorIdx];
            slice = isExcluded(rawSlice) ? '(Blank)' : String(rawSlice);
            if (!sliceColors.has(slice)) {
                sliceColors.set(slice, palette[(sliceColors.size + 1) % palette.length]);
            }
        }
        if (!rawGroups.has(category)) rawGroups.set(category, []);
        rawGroups.get(category)!.push({ y, slice, ordinal: pointOrdinal });
        pointOrdinal++;
    }

    const orderedCategories = Array.from(rawGroups.keys()).sort(
        isDateLikeCol(xColumn)
            ? (a, b) => Number(a) - Number(b)
            : (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
    );

    const jitterRange = clamp(Number(visualProps.jitterWidth ?? 0.24), 0, 0.45);
    const groups = orderedCategories.map((category, categoryIndex) => {
        const label = isDateLikeCol(xColumn) ? formatEpochByBucket(category, xColumn.timeBucket) : category;
        const categoryColor = pickColor(visualProps[`categoryValueColor_${xColumn.id}_${category}`], palette[categoryIndex % palette.length]);
        const rows = rawGroups.get(category) ?? [];
        const group: CategoryGroup = {
            raw: category,
            label,
            color: categoryColor,
            values: rows.map(r => r.y),
            points: [],
        };
        group.points = rows.map(row => {
            const jitter = (hashToUnit(`${category}|${row.slice ?? ''}|${row.ordinal}|${row.y}`) - 0.5) * jitterRange * 2;
            return {
                x: categoryIndex + jitter,
                y: row.y,
                category,
                categoryLabel: label,
                categoryColor,
                categoryValueColor: categoryColor,
                slice: row.slice,
                sliceColor: row.slice ? sliceColors.get(row.slice) : undefined,
            };
        });
        return group;
    });

    return { groups, sliceColors };
}

function render(ctx: CustomChartContext) {
    const chartModel = ctx.getChartModel();
    const visualProps = (chartModel.visualProps ?? {}) as VisualProps;
    const { dataArr, xColumns, yColumn, colorColumn } = getDataModel(chartModel);

    for (const id of [activeXColumnId]) {
        if (id && !xColumns.some(c => c.id === id)) activeXColumnId = null;
    }
    if (!activeXColumnId && xColumns.length > 0) activeXColumnId = xColumns[0].id;
    const xColumn = xColumns.find(c => c.id === activeXColumnId);
    const categoryButtonsPosition = visualProps.categoryButtonsPosition ?? 'Top';
    renderCategoryButtons(
        categoryButtonsPosition,
        xColumns.map(c => ({ id: c.id, name: customLabel(visualProps, `categoryLabel_${c.id}`, c.name) })),
        (id) => {
            activeXColumnId = id;
            render(ctx);
        },
    );

    if (!xColumn || !yColumn) {
        renderChartMessage('Add one category attribute and one numeric value measure to render this violin plot.');
        return;
    }

    const { groups, sliceColors } = buildGroups(dataArr, xColumn, yColumn, colorColumn, visualProps);
    if (groups.length === 0) {
        renderChartMessage('No numeric values found for the current violin plot selection.');
        return;
    }

    if (globalChartReference) {
        try { globalChartReference.destroy(); } catch { /* noop */ }
        globalChartReference = null;
    }

    const chartTitle = visualProps.chartTitle ?? '';
    const xColumnLabel = customLabel(visualProps, `categoryLabel_${xColumn.id}`, xColumn.name);
    const xAxisTitle = (visualProps.xAxisTitle ?? '').trim() || xColumnLabel;
    const yAxisTitle = (visualProps.yAxisTitle ?? '').trim() || yColumn.name;
    const numberFormat = visualProps.numberFormat ?? '0,0.[0]a';
    const currency = visualProps.currency ?? 'None';
    const yValueFormat = Y_VALUE_FORMAT_OPTIONS.includes(visualProps.yValueFormat ?? '')
        ? visualProps.yValueFormat
        : 'Number';
    const showGridLines = visualProps.showGridLines ?? true;
    const showLegend = visualProps.showLegend ?? true;
    const showDots = visualProps.showDots ?? true;
    const showViolins = visualProps.showViolins ?? true;
    const violinFill = pickColor(visualProps.violinFill, '#D9D9D9');
    const violinStroke = pickColor(visualProps.violinStroke, '#7A7A7A');
    const violinOpacity = clamp(Number(visualProps.violinOpacity ?? 0.78), 0.05, 1);
    const violinMaxWidth = clamp(Number(visualProps.violinMaxWidth ?? 0.38), 0.001, 0.48);
    const violinMinWidth = clamp(Number(visualProps.violinMinWidth ?? 0.004), 0, 0.2);
    const dotRadius = clamp(Number(visualProps.dotRadius ?? 3.5), 1, 12);
    const dotOpacity = clamp(Number(visualProps.dotOpacity ?? 0.9), 0.05, 1);
    const singlePointColor = pickColor(visualProps.singlePointColor, '#378ADD');
    const pointColourMode = POINT_COLOUR_OPTIONS.includes(visualProps.pointColourMode ?? '')
        ? visualProps.pointColourMode
        : 'Category';

    const fmt = (value: number) => {
        if (yValueFormat === 'Percent') return formatPercent(value, numberFormat);
        if (yValueFormat === 'Currency') return formatCurrency(value, numberFormat, currency);
        return formatNumber(value, numberFormat);
    };
    const scatterData: PlotPoint[] = groups.flatMap(g => g.points.map(p => {
        let color = p.categoryValueColor;
        if (pointColourMode === 'Single') color = singlePointColor;
        if (pointColourMode === 'Slice' && p.sliceColor) color = p.sliceColor;
        return { ...p, color } as PlotPoint & { color: string };
    }));

    const violinSeries = showViolins
        ? groups.map((group, idx) => ({
            type: 'polygon',
            name: group.label,
            data: buildViolinPolygon(group.values, idx, violinMaxWidth, violinMinWidth),
            color: violinFill,
            fillColor: violinFill,
            lineColor: violinStroke,
            lineWidth: 2,
            opacity: violinOpacity,
            enableMouseTracking: false,
            showInLegend: false,
            zIndex: 1,
        }))
        : [];

    const scatterSeries = showDots
        ? [{
            type: 'scatter',
            name: pointColourMode === 'Slice' && colorColumn ? colorColumn.name : yColumn.name,
            data: scatterData.map((p: any) => ({
                x: p.x,
                y: p.y,
                categoryLabel: p.categoryLabel,
                slice: p.slice,
                color: p.color,
            })),
            marker: {
                symbol: 'circle',
                radius: dotRadius,
                lineWidth: 0,
            },
            opacity: dotOpacity,
            showInLegend: pointColourMode !== 'Category',
            zIndex: 3,
        }]
        : [];

    const sliceLegendSeries = pointColourMode === 'Slice' && colorColumn && showLegend
        ? Array.from(sliceColors.entries()).map(([slice, color]) => ({
            type: 'scatter',
            name: slice,
            data: [],
            color,
            marker: { symbol: 'circle', radius: dotRadius },
            showInLegend: true,
            enableMouseTracking: false,
        }))
        : [];

    globalChartReference = Highcharts.chart('chart', {
        chart: {
            type: 'scatter',
            spacing: [14, 18, 12, 12],
            style: { fontFamily: 'Optimo-Plain, "Helvetica Neue", Helvetica, Arial, sans-serif' },
        },
        title: {
            text: chartTitle,
            style: { fontWeight: 'bold', fontSize: '14px', color: '#1A1F2C' },
        },
        credits: { enabled: false },
        xAxis: {
            min: -0.6,
            max: Math.max(groups.length - 0.4, 0.6),
            tickPositions: groups.map((_, i) => i),
            labels: {
                formatter: function (this: any) {
                    return groups[this.value]?.label ?? '';
                },
                style: { fontSize: '12px', color: '#1A1F2C' },
            },
            title: { text: xAxisTitle, style: { fontWeight: '500', color: '#555' } },
            lineColor: '#D8DCE2',
            tickLength: 0,
            gridLineWidth: 0,
        },
        yAxis: {
            title: { text: yAxisTitle, style: { fontWeight: '500', color: '#555' } },
            gridLineWidth: showGridLines ? 1 : 0,
            gridLineColor: '#EEF1F4',
            labels: {
                formatter: function (this: any) { return fmt(Number(this.value)); },
                style: { color: '#555', fontSize: '11px' },
            },
        },
        legend: {
            enabled: showLegend && pointColourMode === 'Slice' && !!colorColumn,
            align: 'center',
            verticalAlign: 'top',
            itemStyle: { fontSize: '12px', color: '#333', fontWeight: '500' },
            symbolRadius: 4,
        },
        tooltip: {
            useHTML: true,
            backgroundColor: 'rgba(0,0,0,0)',
            borderWidth: 0,
            shadow: false,
            padding: 0,
            formatter: function (this: any) {
                const point = this.point ?? {};
                const sliceLine = point.slice
                    ? `<div style="display:flex;justify-content:space-between;gap:18px;"><span>${colorColumn?.name ?? 'Slice'}</span><b>${point.slice}</b></div>`
                    : '';
                return `<div style="border:1px solid #555;border-radius:8px;background:#3A3F48;padding:10px 12px;color:#FFFFFF;font-size:12px;min-width:170px;">
                    <div style="font-weight:600;margin-bottom:6px;">${point.categoryLabel ?? this.x}</div>
                    <div style="display:flex;justify-content:space-between;gap:18px;"><span>${yColumn.name}</span><b>${fmt(this.y)}</b></div>
                    ${sliceLine}
                </div>`;
            },
        },
        plotOptions: {
            series: {
                animation: false,
                states: { inactive: { opacity: 1 } },
            },
            scatter: {
                turboThreshold: 0,
            },
            polygon: {
                stickyTracking: false,
            },
        },
        series: [...violinSeries, ...scatterSeries, ...sliceLegendSeries],
    });
}

const safeRender = (ctx: CustomChartContext) => {
    try {
        ctx.emitEvent(ChartToTSEvent.RenderStart);
        render(ctx);
        ctx.emitEvent(ChartToTSEvent.RenderComplete);
        firstRenderDone = true;
        lastRenderedDataRef = ctx.getChartModel().data;
        lastRenderedSize = measureChartContainer();
    } catch (error) {
        console.error('Violin Plot render error:', error);
        ctx.emitEvent(ChartToTSEvent.RenderError, {
            hasError: true,
            error,
        } as RenderErrorEventPayload);
    }
};

const renderChart = async (ctx: CustomChartContext) => {
    if (!globalAppConfig) {
        try { globalAppConfig = (ctx as any).getAppConfig?.() ?? null; } catch { /* ignore */ }
    }
    const doRender = () => safeRender(ctx);
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

// ---- resize re-render ------------------------------------------------------
// The chart only lays out correctly for the size it renders at. Highcharts
// reflows on window resize, but the tile can also settle at a new size after
// the initial render (dashboard layout, headless screenshot runners) and the
// jitter/label layout is only optimal for the rendered size. Watch the chart
// container and re-run the full render, debounced, and only when the size
// really changed and the first data render has happened.
const RESIZE_DEBOUNCE_MS  = 150;
const RESIZE_MIN_DELTA_PX = 2;
let resizeRenderTimer: ReturnType<typeof setTimeout> | null = null;
let lastRenderedSize: { width: number; height: number } | null = null;

function measureChartContainer(): { width: number; height: number } {
    // Watch the whole grid layout, not just the #chart cell: the button area
    // can change height during render, which resizes the #chart cell.
    const el = document.getElementById('layout') ?? document.body;
    return { width: el.clientWidth, height: el.clientHeight };
}

function chartContainerSizeChanged(): boolean {
    if (!lastRenderedSize) return true;
    const now = measureChartContainer();
    return Math.abs(now.width  - lastRenderedSize.width)  > RESIZE_MIN_DELTA_PX
        || Math.abs(now.height - lastRenderedSize.height) > RESIZE_MIN_DELTA_PX;
}

function setupResizeRerender(ctx: CustomChartContext) {
    const onResize = () => {
        if (!firstRenderDone) return;             // never render before first data render
        if (!chartContainerSizeChanged()) return; // ignore <=2px jitter (no re-render storms)
        if (resizeRenderTimer) clearTimeout(resizeRenderTimer);
        resizeRenderTimer = setTimeout(() => {
            resizeRenderTimer = null;
            // Re-check at fire time: a TS-triggered render may already have
            // painted at the current size while the debounce was pending.
            if (!firstRenderDone || !chartContainerSizeChanged()) return;
            safeRender(ctx); // render() reads the container's CURRENT dimensions
        }, RESIZE_DEBOUNCE_MS);
    };
    const target = document.getElementById('layout');
    if (typeof ResizeObserver !== 'undefined' && target) {
        new ResizeObserver(onResize).observe(target);
    } else {
        window.addEventListener('resize', onResize);
    }
}

(async () => {
    const ctx = await getChartContext({
        getDefaultChartConfig: (chartModel: ChartModel) => {
            return [{
                key: 'main',
                dimensions: [
                    { key: 'xAxis', columns: [] },
                    { key: 'yValue', columns: [] },
                    { key: 'color', columns: [] },
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
            ).filter(q => q.queryColumns.length > 0)
             .map(q => ({ ...q, queryParams: { size: 100000 } }));
            if (queries.length > 0) return queries;
            const placeholder = chartModel?.columns?.[0];
            return placeholder ? [{ queryColumns: [placeholder], queryParams: { size: 100000 } } as Query] : [];
        },
        renderChart,
        chartConfigEditorDefinition: [{
            key: 'main',
            label: 'Violin Plot',
            descriptionText: 'Bind a category and numeric value. Each returned ThoughtSpot row becomes one dot; the violin shape estimates the value distribution per category. Add an optional colour field for slice-based point colouring.',
            columnSections: [
                {
                    key: 'xAxis',
                    label: 'Category',
                    allowAttributeColumns: true,
                    allowMeasureColumns: false,
                    allowTimeSeriesColumns: true,
                    maxColumnCount: 20,
                },
                {
                    key: 'yValue',
                    label: 'Value',
                    allowAttributeColumns: false,
                    allowMeasureColumns: true,
                    allowTimeSeriesColumns: false,
                    maxColumnCount: 1,
                },
                {
                    key: 'color',
                    label: 'Colour / slice (optional)',
                    allowAttributeColumns: true,
                    allowMeasureColumns: false,
                    allowTimeSeriesColumns: true,
                    maxColumnCount: 1,
                },
            ],
        }],
        visualPropEditorDefinition: (chartModel: ChartModel) => {
            const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
            const xCols = (dims.find(d => d.key === 'xAxis')?.columns ?? []) as BoundColumn[];
            const yCol = dims.find(d => d.key === 'yValue')?.columns?.[0] as BoundColumn | undefined;
            const dataArr: DataPointsArray | undefined = chartModel.data?.[chartModel.data.length - 1]?.data;
            const palette = getEffectivePalette();

            const categoryControls: any[] = [];
            xCols.forEach((col, colIdx) => {
                categoryControls.push({
                    key: `categoryLabel_${col.id}`,
                    type: 'text' as const,
                    defaultValue: ' ',
                    label: `Category button label: ${col.name} (blank = column name)`,
                });
                if (dataArr) {
                    const idx = dataArr.columns.indexOf(col.id);
                    if (idx >= 0) {
                        const uniqueValues: string[] = [];
                        const seen = new Set<string>();
                        for (const row of dataArr.dataValue) {
                            const raw = row[idx];
                            if (isExcluded(raw)) continue;
                            const value = String(raw);
                            if (!seen.has(value)) {
                                seen.add(value);
                                uniqueValues.push(value);
                            }
                        }
                        uniqueValues.sort(
                            isDateLikeCol(col)
                                ? (a, b) => Number(a) - Number(b)
                                : (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
                        );
                        uniqueValues.forEach((value, valueIdx) => {
                            const display = isDateLikeCol(col) ? formatEpochByBucket(value, col.timeBucket) : value;
                            categoryControls.push({
                                key: `categoryValueColor_${col.id}_${value}`,
                                type: 'colorpicker' as const,
                                defaultValue: palette[(colIdx + valueIdx) % palette.length],
                                label: `${col.name} — ${display}`,
                            });
                        });
                    }
                }
            });

            return {
                elements: [
                { key: 'chartTitle', type: 'text', defaultValue: ' ', label: 'Chart title' },
                { key: 'xAxisTitle', type: 'text', defaultValue: ' ', label: 'X-axis title (blank = category name)' },
                { key: 'yAxisTitle', type: 'text', defaultValue: ' ', label: 'Y-axis title (blank = value name)' },
                { key: 'numberFormat', type: 'text', defaultValue: '0,0.[0]a', label: 'Number format' },
                { key: 'yValueFormat', type: 'dropdown', defaultValue: 'Number', values: Y_VALUE_FORMAT_OPTIONS, label: `Y value format${yCol ? ` (${yCol.name})` : ''}` },
                { key: 'currency', type: 'dropdown', defaultValue: 'None', values: CURRENCY_OPTIONS, label: 'Currency symbol' },
                { key: 'categoryButtonsPosition', type: 'dropdown', defaultValue: 'Top', values: CATEGORY_BUTTON_POSITION_OPTIONS, label: 'Category buttons position' },
                { key: 'pointColourMode', type: 'dropdown', defaultValue: 'Category', values: POINT_COLOUR_OPTIONS, label: 'Dot colour mode' },
                { key: 'singlePointColor', type: 'colorpicker', defaultValue: '#378ADD', label: 'Single dot colour' },
                { key: 'showLegend', type: 'checkbox', defaultValue: true, label: 'Show slice legend' },
                { key: 'showGridLines', type: 'checkbox', defaultValue: true, label: 'Show grid lines' },
                { key: 'showViolins', type: 'checkbox', defaultValue: true, label: 'Show violins' },
                { key: 'showDots', type: 'checkbox', defaultValue: true, label: 'Show dots' },
                { key: 'violinFill', type: 'colorpicker', defaultValue: '#D9D9D9', label: 'Violin fill' },
                { key: 'violinStroke', type: 'colorpicker', defaultValue: '#7A7A7A', label: 'Violin outline' },
                { key: 'violinOpacity', type: 'number', defaultValue: 0.78, label: 'Violin opacity' },
                { key: 'violinMaxWidth', type: 'number', defaultValue: 0.38, label: 'Violin max half-width' },
                { key: 'violinMinWidth', type: 'number', defaultValue: 0.004, label: 'Violin minimum half-width' },
                { key: 'dotRadius', type: 'number', defaultValue: 3.5, label: 'Dot radius' },
                { key: 'dotOpacity', type: 'number', defaultValue: 0.9, label: 'Dot opacity' },
                { key: 'jitterWidth', type: 'number', defaultValue: 0.24, label: 'Dot jitter width' },
                ...categoryControls,
            ],
            };
        },
    });

    setupResizeRerender(ctx);
    renderChart(ctx);
})().catch((error) => {
    // Without this, a failed SDK handshake rejects silently and the tile
    // stays blank with no console breadcrumb.
    console.error('violin_plot: failed to initialise chart context:', error);
});
