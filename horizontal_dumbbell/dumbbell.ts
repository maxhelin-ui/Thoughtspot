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
    const { rows, originalName, renewedName } = getDataModel(chartModel);
    const visualProps = (chartModel.visualProps ?? {}) as VisualProps;

    const chartTitle         = visualProps.chartTitle         ?? '';
    const xAxisTitle         = visualProps.xAxisTitle         ?? 'Value';
    const numberFormat       = visualProps.numberFormat       ?? '0,0.[0]a';
    const currency           = visualProps.currency           ?? 'None';
    const colorOriginal      = pickColor(visualProps.colorOriginal,  '#378ADD');
    const colorRenewed       = pickColor(visualProps.colorRenewed,   '#E24B4A');
    const connectorColor     = pickColor(visualProps.connectorColor, '#F4A0A0');
    const connectorWidth     = visualProps.connectorWidth     ?? 3;
    const markerRadius       = visualProps.markerRadius       ?? 8;
    const showDataLabels     = visualProps.showDataLabels     ?? true;
    const showAbsoluteChange = visualProps.showAbsoluteChange ?? true;
    const showLegend         = visualProps.showLegend         ?? true;
    const legendPosition     = visualProps.legendPosition     ?? 'Bottom (horizontal)';
    const showGridLines      = visualProps.showGridLines      ?? true;
    const sortBy             = visualProps.sortBy             ?? 'Largest % decline first';
    const originalLabel      = (typeof visualProps.originalLabel === 'string' && visualProps.originalLabel.trim())
        ? visualProps.originalLabel.trim() : (originalName || 'Original');
    const renewedLabel       = (typeof visualProps.renewedLabel === 'string' && visualProps.renewedLabel.trim())
        ? visualProps.renewedLabel.trim() : (renewedName || 'Renewed');

    if (rows.length === 0) return;

    const sortedRows = sortRows(rows, sortBy);
    const placement = legendPlacement(legendPosition, showLegend);
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
            const color      = row.change        >= 0 ? '#2D7A3A' : '#B23A3A';
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

(async () => {
    const ctx = await getChartContext({
        getDefaultChartConfig: (chartModel: ChartModel) => {
            const cols = chartModel.columns;
            const attributeColumns = cols.filter(col => col.type === ColumnType.ATTRIBUTE);
            const measureColumns   = cols.filter(col => col.type === ColumnType.MEASURE);
            if (attributeColumns.length < 1 || measureColumns.length < 2) {
                throw new Error('Need 1 attribute (category) and 2 measures (original, renewed).');
            }
            return [{
                key: 'main',
                dimensions: [
                    { key: 'category', columns: [attributeColumns[0]] },
                    { key: 'original', columns: [measureColumns[0]]   },
                    { key: 'renewed',  columns: [measureColumns[1]]   },
                ],
            }];
        },
        getQueriesFromChartConfig: (chartConfig: ChartConfig[], _chartModel: ChartModel): Array<Query> => {
            return chartConfig.map(config =>
                config.dimensions.reduce(
                    (acc: Query, dimension) => ({
                        queryColumns: [...acc.queryColumns, ...dimension.columns],
                    }),
                    { queryColumns: [] } as Query,
                ),
            );
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
                { key: 'colorOriginal',      type: 'colorpicker', defaultValue: '#378ADD',                  label: 'Original value colour' },
                { key: 'colorRenewed',       type: 'colorpicker', defaultValue: '#E24B4A',                  label: 'Renewed value colour' },
                { key: 'connectorColor',     type: 'colorpicker', defaultValue: '#F4A0A0',                  label: 'Connector colour' },
                { key: 'connectorWidth',     type: 'number',      defaultValue: 3,                          label: 'Connector width' },
                { key: 'markerRadius',       type: 'number',      defaultValue: 8,                          label: 'Marker size' },
                { key: 'showDataLabels',     type: 'checkbox',    defaultValue: true,                       label: 'Show change labels' },
                { key: 'showAbsoluteChange', type: 'checkbox',    defaultValue: true,                       label: 'Show absolute change in label' },
                { key: 'showLegend',         type: 'checkbox',    defaultValue: true,                       label: 'Show legend' },
                { key: 'legendPosition',     type: 'dropdown',    defaultValue: 'Bottom (horizontal)',      values: LEGEND_POSITIONS, label: 'Legend position' },
                { key: 'showGridLines',      type: 'checkbox',    defaultValue: true,                       label: 'Show grid lines' },
                { key: 'sortBy',             type: 'dropdown',    defaultValue: 'Largest % decline first',  values: SORT_OPTIONS, label: 'Sort by' },
            ],
        },
    });

    renderChart(ctx);
})();
