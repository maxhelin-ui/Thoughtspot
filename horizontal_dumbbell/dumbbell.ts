import {
    ChartToTSEvent,
    ColumnType,
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
    numberFormat?: string;
    currency?: string;
    colorOriginal?: string;
    colorRenewed?: string;
    colorGain?: string;
    colorLoss?: string;
    connectorColor?: string;
    connectorWidth?: number;
    markerRadius?: number;
    showDataLabels?: boolean;
    showAbsoluteChange?: boolean;
    showLegend?: boolean;
    legendPosition?: string;
    showGridLines?: boolean;
    sortBy?: string;
    originalLabel?: string;
    renewedLabel?: string;
    showPager?: boolean;
    pageSize?: number;
    [key: string]: any;
}

const SORT_OPTIONS = [
    'Largest decline first',
    'Largest gain first',
    'Largest % decline first',
    'Largest % gain first',
    'Alphabetical',
    'Default order',
];

const CURRENCY_OPTIONS = ['$', '€', '£', '¥', '₹', 'kr', 'None'];

const LEGEND_POSITIONS = [
    'Bottom (horizontal)',
    'Top (horizontal)',
    'Right (vertical)',
];

let globalChartReference: any = null;
let globalAppConfig: any = null;
let renderDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let firstRenderDone = false;
let lastRenderedDataRef: unknown = null;

// Pager state: which slice of (post-sort) rows the user is currently viewing.
// Survives across renders so clicking Top/Bottom/arrows doesn't get reset on
// the next debounced re-render. Clamped to [0, totalRows - pageSize] each
// time we render so it stays valid if the dataset shrinks or sort changes.
let pagerWindowStart = 0;

const FALLBACK_PALETTE = ['#378ADD', '#E24B4A', '#534AB7', '#F0A937', '#52B788'];

// Returns the org-configured chart palette if TS provided one, else fallback.
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

function pickColor(picker: unknown, fallback: string): string {
    return (typeof picker === 'string' && picker) ? picker : fallback;
}

type Row = {
    category: string;
    original: number;
    renewed: number;
    change: number;
    percentChange: number;
};

function getDataModel(chartModel: ChartModel): {
    rows: Row[];
    categoryName: string;
    originalName: string;
    renewedName: string;
} {
    const dataArr: DataPointsArray =
        chartModel.data?.[chartModel.data.length - 1]?.data ?? { columns: [], dataValue: [] };

    const categoryColumn = chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'category')?.columns?.[0];
    const originalColumn = chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'original')?.columns?.[0];
    const renewedColumn  = chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'renewed')?.columns?.[0];

    if (!categoryColumn || !originalColumn || !renewedColumn) {
        return { rows: [], categoryName: '', originalName: '', renewedName: '' };
    }

    const catIdx    = dataArr.columns.indexOf(categoryColumn.id);
    const origIdx   = dataArr.columns.indexOf(originalColumn.id);
    const renewIdx  = dataArr.columns.indexOf(renewedColumn.id);
    if (catIdx < 0 || origIdx < 0 || renewIdx < 0) {
        return { rows: [], categoryName: '', originalName: '', renewedName: '' };
    }

    const grouped = new Map<string, { original: number; renewed: number }>();
    for (const row of dataArr.dataValue) {
        const raw = row[catIdx];
        if (raw == null) continue;
        const cat = String(raw);
        if (!cat.trim()) continue;
        const orig  = parseFloat(String(row[origIdx]  ?? 0)) || 0;
        const renew = parseFloat(String(row[renewIdx] ?? 0)) || 0;
        const existing = grouped.get(cat) ?? { original: 0, renewed: 0 };
        existing.original += orig;
        existing.renewed  += renew;
        grouped.set(cat, existing);
    }

    const rows: Row[] = Array.from(grouped.entries()).map(([category, { original, renewed }]) => ({
        category,
        original,
        renewed,
        change:        renewed - original,
        percentChange: original !== 0 ? ((renewed - original) / Math.abs(original)) * 100 : 0,
    }));

    return {
        rows,
        categoryName: categoryColumn.name,
        originalName: originalColumn.name,
        renewedName:  renewedColumn.name,
    };
}

function sortRows(rows: Row[], sortBy: string): Row[] {
    const sorted = [...rows];
    switch (sortBy) {
        case 'Largest decline first':
            return sorted.sort((a, b) => a.change - b.change);
        case 'Largest gain first':
            return sorted.sort((a, b) => b.change - a.change);
        case 'Largest % decline first':
            return sorted.sort((a, b) => a.percentChange - b.percentChange);
        case 'Largest % gain first':
            return sorted.sort((a, b) => b.percentChange - a.percentChange);
        case 'Alphabetical':
            return sorted.sort((a, b) =>
                a.category.localeCompare(b.category, undefined, { numeric: true, sensitivity: 'base' }),
            );
        default:
            return sorted;
    }
}

function renderChartMessage(text: string) {
    const el = document.getElementById('chart');
    if (!el) return;
    if (globalChartReference) { try { globalChartReference.destroy(); } catch { /* noop */ } globalChartReference = null; }
    el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6B7280;font-size:14px;font-family:inherit;text-align:center;padding:20px;">${text}</div>`;
}

function renderPagerButtons(
    show: boolean,
    totalRows: number,
    pageSize: number,
    windowStart: number,
    onChange: (newStart: number) => void,
) {
    const container = document.getElementById('pagerButtons');
    if (!container) return;
    // Hide entirely when the user has disabled the pager, or when every row
    // already fits in one page (no scrolling needed).
    if (!show || totalRows <= pageSize) {
        container.className = 'hidden';
        container.innerHTML = '';
        return;
    }
    container.className = '';
    container.innerHTML = '';

    const maxStart   = Math.max(0, totalRows - pageSize);
    const atStart    = windowStart <= 0;
    const atEnd      = windowStart >= maxStart;
    const isTop      = atStart;
    const isBottom   = atEnd;

    const mk = (label: string, opts: { active?: boolean; disabled?: boolean; title?: string; onClick: () => void }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pager-btn' + (opts.active ? ' active' : '');
        btn.textContent = label;
        if (opts.title) btn.title = opts.title;
        if (opts.disabled) btn.disabled = true;
        btn.onclick = opts.onClick;
        return btn;
    };

    container.appendChild(mk('‹', {
        disabled: atStart,
        title: `Previous ${pageSize}`,
        onClick: () => onChange(Math.max(0, windowStart - pageSize)),
    }));
    container.appendChild(mk(`Top ${pageSize}`, {
        active: isTop,
        onClick: () => onChange(0),
    }));
    container.appendChild(mk(`Bottom ${pageSize}`, {
        active: isBottom,
        onClick: () => onChange(maxStart),
    }));
    container.appendChild(mk('›', {
        disabled: atEnd,
        title: `Next ${pageSize}`,
        onClick: () => onChange(Math.min(maxStart, windowStart + pageSize)),
    }));
}

function legendPlacement(position: string, showLegend: boolean) {
    if (!showLegend) {
        return { align: 'right', verticalAlign: 'bottom', layout: 'horizontal',
                 marginRight: 60, marginTop: 30, marginBottom: 50 };
    }
    switch (position) {
        case 'Right (vertical)':
            return { align: 'right', verticalAlign: 'middle', layout: 'vertical',
                     marginRight: 160, marginTop: 30, marginBottom: 50 };
        case 'Top (horizontal)':
            return { align: 'center', verticalAlign: 'top', layout: 'horizontal',
                     marginRight: 60, marginTop: 60, marginBottom: 50 };
        default:
            return { align: 'center', verticalAlign: 'bottom', layout: 'horizontal',
                     marginRight: 60, marginTop: 30, marginBottom: 70 };
    }
}

function render(ctx: CustomChartContext) {
    const chartModel = ctx.getChartModel();

    // Check what's bound so we can give a specific "missing X" message
    // instead of a generic blank chart when something's not configured yet.
    const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
    const has = (k: string) => (dims.find(d => d.key === k)?.columns?.length ?? 0) > 0;
    if (!has('category') || !has('original') || !has('renewed')) {
        const missing: string[] = [];
        if (!has('category')) missing.push('Category');
        if (!has('original')) missing.push('Original measure');
        if (!has('renewed'))  missing.push('Renewed measure');
        renderChartMessage(`Add: ${missing.join(', ')}.`);
        return;
    }

    const { rows, originalName, renewedName } = getDataModel(chartModel);
    const visualProps = (chartModel.visualProps ?? {}) as VisualProps;

    const chartTitle         = visualProps.chartTitle         ?? '';
    const xAxisTitle         = visualProps.xAxisTitle         ?? 'Value';
    const numberFormat       = visualProps.numberFormat       ?? '0,0.[0]a';
    const currency           = visualProps.currency           ?? 'None';
    const palette            = getEffectivePalette();
    const colorOriginal      = pickColor(visualProps.colorOriginal,  palette[0]);
    const colorRenewed       = pickColor(visualProps.colorRenewed,   palette[1] ?? palette[0]);
    const colorGain          = pickColor(visualProps.colorGain,      '#2D7A3A');
    const colorLoss          = pickColor(visualProps.colorLoss,      '#B23A3A');
    const connectorColor     = pickColor(visualProps.connectorColor, palette[1] ?? palette[0]);
    const connectorWidth     = visualProps.connectorWidth     ?? 3;
    const markerRadius       = visualProps.markerRadius       ?? 8;
    const showDataLabels     = visualProps.showDataLabels     ?? true;
    const showAbsoluteChange = visualProps.showAbsoluteChange ?? true;
    const showLegend         = visualProps.showLegend         ?? true;
    const legendPosition     = visualProps.legendPosition     ?? 'Bottom (horizontal)';
    const showGridLines      = visualProps.showGridLines      ?? true;
    const sortBy             = visualProps.sortBy             ?? 'Largest % decline first';
    const showPager          = visualProps.showPager          ?? false;
    const pageSize           = Math.max(1, Math.floor(visualProps.pageSize ?? 10));
    const originalLabel      = (typeof visualProps.originalLabel === 'string' && visualProps.originalLabel.trim())
        ? visualProps.originalLabel.trim() : (originalName || 'Original');
    const renewedLabel       = (typeof visualProps.renewedLabel === 'string' && visualProps.renewedLabel.trim())
        ? visualProps.renewedLabel.trim() : (renewedName || 'Renewed');

    if (rows.length === 0) {
        renderPagerButtons(false, 0, pageSize, 0, () => {});
        renderChartMessage('No data to display. Check the data and column bindings.');
        return;
    }

    const allSortedRows = sortRows(rows, sortBy);

    // Apply paging window. When the pager is off, show everything (existing
    // behavior). When on, clamp the saved windowStart in case the dataset
    // shrank since the last render, then slice.
    const maxStart = Math.max(0, allSortedRows.length - pageSize);
    if (pagerWindowStart > maxStart) pagerWindowStart = maxStart;
    if (pagerWindowStart < 0) pagerWindowStart = 0;
    const sortedRows = showPager
        ? allSortedRows.slice(pagerWindowStart, pagerWindowStart + pageSize)
        : allSortedRows;

    renderPagerButtons(showPager, allSortedRows.length, pageSize, pagerWindowStart, (newStart) => {
        pagerWindowStart = newStart;
        render(ctx);
    });
    const placement = legendPlacement(legendPosition, showLegend);
    // When the pager sits absolutely in the top-right and the legend is
    // also at the top, slide the legend left so they share the row instead
    // of overlapping. Also bump marginRight to reserve space for the pills.
    const pagerVisible = showPager && allSortedRows.length > pageSize;
    if (pagerVisible && legendPosition === 'Top (horizontal)') {
        placement.align = 'left';
        placement.marginRight = Math.max(placement.marginRight, 220);
    }
    const fmt = (v: number) => formatCurrency(v, numberFormat, currency);

    const data = sortedRows.map(r => ({
        name:          r.category,
        low:           Math.min(r.original, r.renewed),
        high:          Math.max(r.original, r.renewed),
        color:         r.original >= r.renewed ? colorOriginal : colorRenewed,
        lowColor:      r.original >= r.renewed ? colorRenewed  : colorOriginal,
        original:      r.original,
        renewed:       r.renewed,
        change:        r.change,
        percentChange: r.percentChange,
    }));

    if (globalChartReference) {
        globalChartReference.destroy();
        globalChartReference = null;
    }

    globalChartReference = Highcharts.chart('chart', {
        chart: {
            type:     'dumbbell',
            inverted: true,
            marginLeft:   180,
            marginRight:  placement.marginRight,
            marginTop:    chartTitle ? Math.max(placement.marginTop, 50) : placement.marginTop,
            marginBottom: placement.marginBottom,
            style: { fontFamily: 'Optimo-Plain, "Helvetica Neue", Helvetica, Arial, sans-serif' },
        },
        title: {
            text:  chartTitle,
            style: { fontWeight: 'bold', fontSize: '14px', color: '#1A1F2C' },
        },
        credits: { enabled: false },
        xAxis: {
            type:       'category',
            categories: sortedRows.map(r => r.category),
            title:      { text: null },
            lineWidth:  0,
            tickWidth:  0,
            labels: {
                style: { fontSize: '12px', color: '#333', fontWeight: '500' },
            },
        },
        yAxis: {
            title: { text: xAxisTitle, style: { fontWeight: '500', color: '#555' } },
            gridLineWidth: showGridLines ? 1 : 0,
            gridLineColor: '#EEF1F4',
            labels: {
                formatter: function (this: any) {
                    // Axis never shows the currency symbol — keeps the axis clean.
                    return formatNumber(this.value, numberFormat.replace(/^[\$€£¥₹]/, ''));
                },
                style: { color: '#555', fontSize: '11px' },
            },
        },
        legend: {
            enabled:         showLegend,
            align:           placement.align,
            verticalAlign:   placement.verticalAlign,
            layout:          placement.layout,
            floating:        false,
            backgroundColor: 'transparent',
            borderWidth:     0,
            shadow:          false,
            padding:         4,
            itemStyle:       { fontWeight: '500', fontSize: '12px', color: '#1A1F2C' },
            symbolHeight:    10,
            symbolWidth:     10,
            symbolRadius:    5,
            itemMarginBottom: 4,
            itemDistance:    18,
        },
        tooltip: {
            useHTML:         true,
            backgroundColor: 'rgba(0,0,0,0)',
            borderWidth:     0,
            shadow:          false,
            padding:         0,
            formatter: function (this: any) {
                const p = this.point;
                const pctSign    = p.percentChange >= 0 ? '+' : '';
                const changeSign = p.change        >= 0 ? '+' : '';
                const borderCol  = p.change >= 0 ? colorOriginal : colorRenewed;
                return `<div style="border:1px solid ${borderCol};border-radius:8px;background:#3A3F48;padding:12px;color:#FFFFFF;font-size:13px;">
                    <div style="font-weight:600;margin-bottom:8px;">${p.name}</div>
                    <div style="margin-bottom:4px;">${originalLabel}:<br/><b>${fmt(p.original)}</b></div>
                    <div style="margin-bottom:4px;">${renewedLabel}:<br/><b>${fmt(p.renewed)}</b></div>
                    <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.15);padding-top:6px;">
                        Change:<br/><b>${changeSign}${fmt(p.change)} (${pctSign}${Math.round(p.percentChange)}%)</b>
                    </div>
                </div>`;
            },
        },
        plotOptions: {
            dumbbell: {
                connectorColor: connectorColor,
                connectorWidth: connectorWidth,
                marker: {
                    radius:    markerRadius,
                    lineWidth: 0,
                },
                dataLabels: { enabled: false },
            },
        },
        series: [
            {
                type:         'dumbbell',
                name:         'Values',
                data:         data,
                showInLegend: false,
            },
            ...(showLegend ? [
                {
                    type:    'scatter',
                    name:    originalLabel,
                    data:    [],
                    color:   colorOriginal,
                    marker:  { symbol: 'circle', radius: 5, lineWidth: 0 },
                },
                {
                    type:    'scatter',
                    name:    renewedLabel,
                    data:    [],
                    color:   colorRenewed,
                    marker:  { symbol: 'circle', radius: 5, lineWidth: 0 },
                },
            ] : []),
        ],
    });

    // Draw the % (and optional absolute) label centred above the connector line
    // for each row. SVG renderer lets us position freely, which the built-in
    // dumbbell dataLabels can't (they sit on the high marker only).
    if (showDataLabels) {
        const chart        = globalChartReference;
        const valueAxis    = chart.yAxis[0];
        const categoryAxis = chart.xAxis[0];
        sortedRows.forEach((row, i) => {
            const low  = Math.min(row.original, row.renewed);
            const high = Math.max(row.original, row.renewed);
            const x1   = valueAxis.toPixels(low,  false);
            const x2   = valueAxis.toPixels(high, false);
            const yPos = categoryAxis.toPixels(i, false);
            const midX = (x1 + x2) / 2;
            const pctSign    = row.percentChange >= 0 ? '+' : '';
            const changeSign = row.change        >= 0 ? '+' : '';
            const color      = row.change        >= 0 ? colorGain  : colorLoss;
            const pctText    = `${pctSign}${Math.round(row.percentChange)}%`;
            const fullText   = showAbsoluteChange
                ? `${pctText} (${changeSign}${fmt(row.change)})`
                : pctText;
            chart.renderer.text(fullText, midX, yPos - markerRadius - 4)
                .attr({ align: 'center', zIndex: 5 })
                .css({
                    fontSize:   '11px',
                    fontWeight: '600',
                    color,
                })
                .add();
        });
    }
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
            // Pre-bind what's available but never throw — show an in-chart
            // message for missing pieces instead of erroring at init time.
            const cols = chartModel.columns;
            const attributeColumns = cols.filter(col => col.type === ColumnType.ATTRIBUTE);
            const measureColumns   = cols.filter(col => col.type === ColumnType.MEASURE);
            return [{
                key: 'main',
                dimensions: [
                    { key: 'category', columns: attributeColumns.slice(0, 1) },
                    { key: 'original', columns: measureColumns.slice(0, 1)   },
                    { key: 'renewed',  columns: measureColumns.slice(1, 2)   },
                ],
            }];
        },
        getQueriesFromChartConfig: (chartConfig: ChartConfig[], chartModel: ChartModel): Array<Query> => {
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
            label:           'Dumbbell Chart Configuration',
            descriptionText: 'Add a category (Y-axis) and two measures: original (start) and renewed (end).',
            columnSections: [
                {
                    key:                   'category',
                    label:                 'Category (Y-axis)',
                    allowAttributeColumns: true,
                    allowMeasureColumns:   false,
                    allowTimeSeriesColumns: true,
                    maxColumnCount:        1,
                },
                {
                    key:                   'original',
                    label:                 'Original value (start point)',
                    allowAttributeColumns: false,
                    allowMeasureColumns:   true,
                    maxColumnCount:        1,
                },
                {
                    key:                   'renewed',
                    label:                 'Renewed value (end point)',
                    allowAttributeColumns: false,
                    allowMeasureColumns:   true,
                    maxColumnCount:        1,
                },
            ],
        }],
        visualPropEditorDefinition: {
            elements: [
                { key: 'chartTitle',         type: 'text',        defaultValue: ' ',                        label: 'Chart title' },
                { key: 'xAxisTitle',         type: 'text',        defaultValue: 'Value',                    label: 'Value-axis title' },
                { key: 'originalLabel',      type: 'text',        defaultValue: ' ',                        label: 'Original legend label (blank = column name)' },
                { key: 'renewedLabel',       type: 'text',        defaultValue: ' ',                        label: 'Renewed legend label (blank = column name)' },
                { key: 'numberFormat',       type: 'text',        defaultValue: '0,0.[0]a',                 label: 'Number format (without currency)' },
                { key: 'currency',           type: 'dropdown',    defaultValue: 'None',                     values: CURRENCY_OPTIONS, label: 'Currency symbol (labels only, not axis)' },
                { key: 'colorOriginal',      type: 'colorpicker', defaultValue: getEffectivePalette()[0] ?? '#378ADD', label: 'Original value colour' },
                { key: 'colorRenewed',       type: 'colorpicker', defaultValue: getEffectivePalette()[1] ?? '#E24B4A', label: 'Renewed value colour' },
                { key: 'colorGain',          type: 'colorpicker', defaultValue: '#2D7A3A',                  label: 'Positive change label colour' },
                { key: 'colorLoss',          type: 'colorpicker', defaultValue: '#B23A3A',                  label: 'Negative change label colour' },
                { key: 'connectorColor',     type: 'colorpicker', defaultValue: getEffectivePalette()[1] ?? '#F4A0A0', label: 'Connector colour' },
                { key: 'connectorWidth',     type: 'number',      defaultValue: 3,                          label: 'Connector width' },
                { key: 'markerRadius',       type: 'number',      defaultValue: 8,                          label: 'Marker size' },
                { key: 'showDataLabels',     type: 'checkbox',    defaultValue: true,                       label: 'Show change labels' },
                { key: 'showAbsoluteChange', type: 'checkbox',    defaultValue: true,                       label: 'Show absolute change in label' },
                { key: 'showLegend',         type: 'checkbox',    defaultValue: true,                       label: 'Show legend' },
                { key: 'legendPosition',     type: 'dropdown',    defaultValue: 'Bottom (horizontal)',      values: LEGEND_POSITIONS, label: 'Legend position' },
                { key: 'showGridLines',      type: 'checkbox',    defaultValue: true,                       label: 'Show grid lines' },
                { key: 'sortBy',             type: 'dropdown',    defaultValue: 'Largest % decline first',  values: SORT_OPTIONS, label: 'Sort by' },
                { key: 'showPager',          type: 'checkbox',    defaultValue: false,                      label: 'Show Top/Bottom pager buttons' },
                { key: 'pageSize',           type: 'number',      defaultValue: 10,                         label: 'Pager page size' },
            ],
        },
    });

    renderChart(ctx);
})();
