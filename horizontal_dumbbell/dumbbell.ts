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
    colorOriginal?: string;
    colorRenewed?: string;
    connectorColor?: string;
    connectorWidth?: number;
    markerRadius?: number;
    showDataLabels?: boolean;
    showAbsoluteChange?: boolean;
    showLegend?: boolean;
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

let globalChartReference: any = null;

function formatNumber(value: number, format: string): string {
    try {
        return numeral(value).format(format).replace('k', 'K').replace('m', 'M').replace('b', 'B');
    } catch {
        return value?.toString() ?? '0';
    }
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

    // Aggregate by category in case there are multiple rows per category
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

function render(ctx: CustomChartContext) {
    const chartModel = ctx.getChartModel();
    const { rows, originalName, renewedName } = getDataModel(chartModel);
    const visualProps = (chartModel.visualProps ?? {}) as VisualProps;

    const chartTitle         = visualProps.chartTitle         ?? '';
    const xAxisTitle         = visualProps.xAxisTitle         ?? 'Value';
    const numberFormat       = visualProps.numberFormat       ?? '$0,0.[0]a';
    const colorOriginal      = pickColor(visualProps.colorOriginal,  '#378ADD');
    const colorRenewed       = pickColor(visualProps.colorRenewed,   '#E24B4A');
    const connectorColor     = pickColor(visualProps.connectorColor, '#F4A0A0');
    const connectorWidth     = visualProps.connectorWidth     ?? 3;
    const markerRadius       = visualProps.markerRadius       ?? 8;
    const showDataLabels     = visualProps.showDataLabels     ?? true;
    const showAbsoluteChange = visualProps.showAbsoluteChange ?? true;
    const showLegend         = visualProps.showLegend         ?? true;
    const showGridLines      = visualProps.showGridLines      ?? true;
    const sortBy             = visualProps.sortBy             ?? 'Largest % decline first';
    const originalLabel      = (typeof visualProps.originalLabel === 'string' && visualProps.originalLabel.trim())
        ? visualProps.originalLabel.trim() : (originalName || 'Original');
    const renewedLabel       = (typeof visualProps.renewedLabel === 'string' && visualProps.renewedLabel.trim())
        ? visualProps.renewedLabel.trim() : (renewedName || 'Renewed');

    if (rows.length === 0) return;

    const sortedRows = sortRows(rows, sortBy);

    // Per-point colour assignment: keep "original" always coloured as colorOriginal
    // and "renewed" always coloured as colorRenewed, regardless of which is larger.
    // Highcharts dumbbell uses `color` for the high marker and `lowColor` for the low.
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
            marginRight:  120,
            marginTop:    chartTitle ? 50 : 30,
            marginBottom: 60,
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
                    return formatNumber(this.value, numberFormat);
                },
                style: { color: '#555', fontSize: '11px' },
            },
        },
        legend: {
            enabled:       showLegend,
            align:         'right',
            verticalAlign: 'bottom',
            floating:      true,
            backgroundColor: 'rgba(255,255,255,0.9)',
            borderColor:   '#D0D7DE',
            borderWidth:   1,
            borderRadius:  4,
            padding:       8,
            itemStyle:     { fontWeight: '500', fontSize: '12px', color: '#1A1F2C' },
            symbolHeight:  10,
            symbolWidth:   10,
            symbolRadius:  5,
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
                    <div style="margin-bottom:4px;">${originalLabel}:<br/><b>${formatNumber(p.original, numberFormat)}</b></div>
                    <div style="margin-bottom:4px;">${renewedLabel}:<br/><b>${formatNumber(p.renewed, numberFormat)}</b></div>
                    <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.15);padding-top:6px;">
                        Change:<br/><b>${changeSign}${formatNumber(p.change, numberFormat)} (${pctSign}${Math.round(p.percentChange)}%)</b>
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
                dataLabels: {
                    enabled:  showDataLabels,
                    align:    'left',
                    inside:   false,
                    crop:     false,
                    overflow: 'allow',
                    useHTML:  true,
                    x:        markerRadius + 4,
                    style:    { textOutline: 'none' },
                    formatter: function (this: any) {
                        const p = this.point;
                        // dataLabels render for both the low and high markers in a
                        // dumbbell series; only draw on the high (rightmost when
                        // inverted) marker, otherwise we get duplicates.
                        if (this.y !== p.high) return null;
                        const pctSign    = p.percentChange >= 0 ? '+' : '';
                        const changeSign = p.change        >= 0 ? '+' : '';
                        const changeCol  = p.change        >= 0 ? '#2D7A3A' : '#B23A3A';
                        const pctText    = `${pctSign}${Math.round(p.percentChange)}%`;
                        if (!showAbsoluteChange) {
                            return `<span style="font-size:11px;font-weight:600;color:${changeCol};">${pctText}</span>`;
                        }
                        return `<div style="text-align:left;font-size:11px;line-height:1.3;">
                            <div style="font-weight:600;color:${changeCol};">${pctText}</div>
                            <div style="font-size:10px;color:#888;">(${changeSign}${formatNumber(p.change, numberFormat)})</div>
                        </div>`;
                    },
                },
            },
        },
        series: [
            {
                type:         'dumbbell',
                name:         'Values',
                data:         data,
                showInLegend: false,
            },
            // Two empty scatter series to display the legend with the two colours
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
                { key: 'numberFormat',       type: 'text',        defaultValue: '$0,0.[0]a',                label: 'Number format' },
                { key: 'colorOriginal',      type: 'colorpicker', defaultValue: '#378ADD',                  label: 'Original value colour' },
                { key: 'colorRenewed',       type: 'colorpicker', defaultValue: '#E24B4A',                  label: 'Renewed value colour' },
                { key: 'connectorColor',     type: 'colorpicker', defaultValue: '#F4A0A0',                  label: 'Connector colour' },
                { key: 'connectorWidth',     type: 'number',      defaultValue: 3,                          label: 'Connector width' },
                { key: 'markerRadius',       type: 'number',      defaultValue: 8,                          label: 'Marker size' },
                { key: 'showDataLabels',     type: 'checkbox',    defaultValue: true,                       label: 'Show change labels' },
                { key: 'showAbsoluteChange', type: 'checkbox',    defaultValue: true,                       label: 'Show absolute change in label' },
                { key: 'showLegend',         type: 'checkbox',    defaultValue: true,                       label: 'Show legend' },
                { key: 'showGridLines',      type: 'checkbox',    defaultValue: true,                       label: 'Show grid lines' },
                { key: 'sortBy',             type: 'dropdown',    defaultValue: 'Largest % decline first',  values: SORT_OPTIONS, label: 'Sort by' },
            ],
        },
    });

    renderChart(ctx);
})();
