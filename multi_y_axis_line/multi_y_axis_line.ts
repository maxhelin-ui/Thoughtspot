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

const hiddenSeriesByY = new Map<string, Set<string>>();

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

function renderCustomLegend(
    items: Array<{ name: string; color: string }>,
    hidden: Set<string>,
    onToggle: (name: string) => void,
) {
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
        btn.className = 'legend-item' + (hidden.has(item.name) ? ' legend-hidden' : '');
        const swatch = document.createElement('span');
        swatch.className = 'legend-swatch';
        swatch.style.background = item.color;
        const label = document.createElement('span');
        label.textContent = item.name;
        btn.appendChild(swatch);
        btn.appendChild(label);
        btn.onclick = () => onToggle(item.name);
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
    setStyle('topArea', {
        paddingLeft:  `${Math.max(0, plotLeftAbs)}px`,
        paddingRight: `${Math.max(0, plotRightAbs)}px`,
        paddingTop:    '6px',
        paddingBottom: '6px',
    });
    setStyle('bottomArea', {
        paddingLeft:  `${Math.max(0, plotLeftAbs)}px`,
        paddingRight: `${Math.max(0, plotRightAbs)}px`,
        paddingTop:    '6px',
        paddingBottom: '6px',
    });
    setStyle('leftArea', {
        paddingTop:    `${Math.max(0, plotTopAbs)}px`,
        paddingBottom: `${Math.max(0, plotBottomAbs)}px`,
        paddingLeft:   '6px',
        paddingRight:  '6px',
    });
    setStyle('rightArea', {
        paddingTop:    `${Math.max(0, plotTopAbs)}px`,
        paddingBottom: `${Math.max(0, plotBottomAbs)}px`,
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
    sliceColumns: Array<{ id: string; name: string }>;
    dataArr: DataPointsArray;
};

function getDataModel(chartModel: ChartModel): DataModel {
    const dataArr: DataPointsArray =
        chartModel.data?.[chartModel.data.length - 1]?.data ?? { columns: [], dataValue: [] };
    const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
    const xColumn      = dims.find(d => d.key === 'xAxis')?.columns?.[0];
    const yColumns     = dims.find(d => d.key === 'yOptions')?.columns ?? [];
    const sliceColumns = dims.find(d => d.key === 'slices')?.columns ?? [];
    return { xColumn, yColumns, sliceColumns, dataArr };
}

function computeSeries(
    dataArr: DataPointsArray,
    xCol: { id: string; dataType?: DataType; timeBucket?: ColumnTimeBucket },
    yCol: { id: string },
    activeSliceCols: Array<{ id: string; name: string }>,
) {
    const xColIdx = dataArr.columns.indexOf(xCol.id);
    const yColIdx = dataArr.columns.indexOf(yCol.id);
    if (xColIdx < 0 || yColIdx < 0) {
        return { xCategories: [] as string[], seriesGroups: [] as Array<{ name: string; data: number[] }> };
    }
    const sliceIdxs = activeSliceCols.map(c => dataArr.columns.indexOf(c.id)).filter(i => i >= 0);

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

    const sums: Record<string, number[]> = {};
    const counts: Record<string, number[]> = {};
    for (const k of sliceKeys) {
        sums[k] = new Array(xCategories.length).fill(0);
        counts[k] = new Array(xCategories.length).fill(0);
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
        const raw = row[yColIdx];
        if (raw == null) continue;
        const v = parseFloat(String(raw));
        if (Number.isNaN(v)) continue;
        sums[key][xi] += v;
        counts[key][xi] += 1;
    }

    const seriesGroups = sliceKeys.map(key => ({
        name: key === NO_SLICE_KEY ? '' : key,
        data: sums[key],
        counts: counts[key],
    }));
    return { xCategories, seriesGroups };
}

function render(ctx: CustomChartContext) {
    const chartModel = ctx.getChartModel();
    const visualProps = (chartModel.visualProps ?? {}) as VisualProps;
    const { xColumn, yColumns, sliceColumns, dataArr } = getDataModel(chartModel);

    if (!xColumn || yColumns.length === 0) {
        ['topArea', 'bottomArea', 'leftArea', 'rightArea'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });
        renderChartMessage('Add an X-axis attribute and at least one Y-axis measure to render this chart.');
        return;
    }

    if (!activeYColumnId || !yColumns.some(c => c.id === activeYColumnId)) {
        activeYColumnId = yColumns[0].id;
    }
    const activeYCol = yColumns.find(c => c.id === activeYColumnId)!;

    for (const id of Array.from(activeSliceColumnIds)) {
        if (!sliceColumns.some(c => c.id === id)) activeSliceColumnIds.delete(id);
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
    const yAxisTitle    = yAxisTitleRaw.trim() ? yAxisTitleRaw : activeYCol.name;
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
        yColumns.map(c => ({ id: c.id, name: c.name })),
        sliceColumns.map(c => ({ id: c.id, name: c.name })),
        (id) => {
            activeYColumnId = id;
            render(ctx);
        },
        (id) => {
            if (activeSliceColumnIds.has(id)) activeSliceColumnIds.delete(id);
            else activeSliceColumnIds.add(id);
            render(ctx);
        },
    );

    const activeSliceCols = sliceColumns.filter(c => activeSliceColumnIds.has(c.id));
    let { xCategories, seriesGroups } = computeSeries(dataArr, xColumn, activeYCol, activeSliceCols);

    if (xCategories.length === 0 || seriesGroups.length === 0) {
        renderChartMessage('No data to render for the current selection.');
        return;
    }

    const xIsDate = isDateLikeCol(xColumn);
    const xCategoryLabels = xIsDate
        ? xCategories.map(v => formatEpochByBucket(v, xColumn.timeBucket))
        : xCategories;

    // Detect whether the active y measure is a percent — drives both the
    // axis label formatter and the tooltip/data-label formatter, so 0.85
    // renders as 85% on a percent measure and as 0.85 or $0.85 on a normal one.
    const yIsPercent = detectPercentByName(activeYCol.name, (activeYCol as any)?.format?.pattern);

    // Percent measures get averaged across the rows that fed each x bucket
    // rather than summed — five 70% values shouldn't add up to 350%.
    // computeSeries already tracked counts alongside sums; just divide here.
    if (yIsPercent) {
        seriesGroups = seriesGroups.map(g => ({
            ...g,
            data: g.data.map((s, i) => g.counts[i] > 0 ? s / g.counts[i] : 0),
        }));
    }
    const fmtY = (v: number) => yIsPercent
        ? formatPercent(v, numberFormat.replace(/[\$€£¥₹]/g, ''))
        : formatCurrency(v, numberFormat, currency);
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
    const yKey = activeYCol.id;
    if (!hiddenSeriesByY.has(yKey)) hiddenSeriesByY.set(yKey, new Set());
    const hidden = hiddenSeriesByY.get(yKey)!;

    const seriesSpecs = seriesGroups.map((g, i) => {
        const isNoSlice = g.name === '';
        const displayName = isNoSlice ? activeYCol.name : g.name;
        const colorKey = isNoSlice
            ? `measureColor_${activeYCol.id}`
            : `seriesColor_${g.name}`;
        const color = pickColor(visualProps[colorKey], palette[i % palette.length]);
        return { name: displayName, data: g.data, color };
    });

    // Legend is meaningful when there's actually multiple series to
    // distinguish (slicer active OR multiple measures combined).
    if (showLegend && seriesSpecs.length > 1) {
        renderCustomLegend(
            seriesSpecs.map(s => ({ name: s.name, color: s.color })),
            hidden,
            (name) => {
                if (hidden.has(name)) hidden.delete(name);
                else hidden.add(name);
                render(ctx);
            },
        );
    }

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
            visible: !hidden.has(s.name),
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
                    { key: 'xAxis',    columns: attributeColumns.slice(0, 1) },
                    { key: 'yOptions', columns: measureColumns.slice(0, 1)   },
                    { key: 'slices',   columns: []                           },
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
                    key: 'slices',
                    label: 'Slicers (attributes) — toggleable',
                    allowAttributeColumns: true,
                    allowMeasureColumns: false,
                    allowTimeSeriesColumns: true,
                },
            ],
        }],
        visualPropEditorDefinition: {
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
                { key: 'showDataLabels',     type: 'checkbox',    defaultValue: false,          label: 'Show data labels on points' },
            ],
        },
    });

    renderChart(ctx);
})();
