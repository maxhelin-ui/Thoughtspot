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
    numberFormat?: string;
    chartTitle?: string;
    xAxisTitle?: string;
    yAxisTitle?: string;
    colorPositive?: string;
    colorNegative?: string;
    colorTotal?: string;
    showDataLabels?: boolean;
    showConnector?: boolean;
    showStartEndMarkers?: boolean;
    showStartEndPills?: boolean;
    showGridLines?: boolean;
}

let globalChartReference: any = null;

function formatNumber(value: number, format: string): string {
    try {
        return numeral(value).format(format).replace('k', 'K').replace('m', 'M').replace('b', 'B');
    } catch {
        return value?.toString() ?? '0';
    }
}

function getDataModel(chartModel: ChartModel) {
    const dataArr: DataPointsArray =
        chartModel.data?.[chartModel.data.length - 1]?.data ?? { columns: [], dataValue: [] };

    const yColumns =
        chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'y')?.columns ?? [];

    const values = yColumns.map(col => {
        const colIdx = dataArr.columns.indexOf(col.id);
        if (colIdx < 0) return 0;
        return dataArr.dataValue.reduce(
            (sum, row) => sum + (parseFloat(String(row[colIdx] ?? 0)) || 0),
            0,
        );
    });

    return { values, names: yColumns.map(col => col.name) };
}

function render(ctx: CustomChartContext) {
    const chartModel   = ctx.getChartModel();
    const { values, names } = getDataModel(chartModel);
    const visualProps  = (chartModel.visualProps ?? {}) as VisualProps;

    const numberFormat        = visualProps.numberFormat        ?? '0.[0]a';
    const chartTitle          = visualProps.chartTitle          ?? '';
    const xAxisTitle          = visualProps.xAxisTitle          ?? '';
    const yAxisTitle          = visualProps.yAxisTitle          ?? 'Value';
    const colorPositive       = visualProps.colorPositive       ?? '#378ADD';
    const colorNegative       = visualProps.colorNegative       ?? '#E24B4A';
    const colorTotal          = visualProps.colorTotal          ?? '#534AB7';
    const showDataLabels      = visualProps.showDataLabels      ?? true;
    const showConnector       = visualProps.showConnector       ?? true;
    const showStartEndMarkers = visualProps.showStartEndMarkers ?? true;
    const showStartEndPills   = visualProps.showStartEndPills   ?? true;
    const showGridLines       = visualProps.showGridLines       ?? true;

    if (values.length < 2) return;

    const startValue = values[0];
    const endValue   = values[values.length - 1];

    // Middle values are deltas; compute running totals from startValue
    const deltas     = values.slice(1, -1);
    const deltaNames = names.slice(1, -1);

    const runningTotals: number[] = [startValue];
    let cum = startValue;
    for (const d of deltas) {
        cum += d;
        runningTotals.push(cum);
    }

    const movements = deltaNames.map((name, i) => {
        const delta = deltas[i];
        const from  = runningTotals[i];
        const to    = runningTotals[i + 1];
        return {
            name,
            low:   Math.min(from, to),
            high:  Math.max(from, to),
            delta,
            color: delta >= 0 ? colorPositive : colorNegative,
        };
    });

    const allValues = [...runningTotals, endValue];
    const yMin      = Math.min(...allValues);
    const yMax      = Math.max(...allValues);
    const padding   = (yMax - yMin) * 0.15;

    const categories = [
        'START\n' + formatNumber(startValue, numberFormat),
        ...movements.map(m => m.name),
        'END\n' + formatNumber(endValue, numberFormat),
    ];

    const seriesData = [
        { low: startValue, high: startValue, color: 'transparent', delta: startValue, isTotal: true },
        ...movements.map(m => ({ low: m.low, high: m.high, color: m.color, delta: m.delta, isTotal: false })),
        { low: endValue,   high: endValue,   color: 'transparent', delta: endValue,   isTotal: true },
    ];

    // Connector line follows the running total: top of up-bars, bottom of down-bars
    const connectorY = [
        startValue,
        ...movements.map(m => m.delta >= 0 ? m.high : m.low),
        endValue,
    ];

    if (globalChartReference) {
        globalChartReference.destroy();
        globalChartReference = null;
    }

    globalChartReference = Highcharts.chart('chart', {
        chart: {
            type: 'columnrange',
            marginLeft:   80,
            marginRight:  40,
            marginBottom: 100,
        },
        title:   { text: chartTitle, style: { fontWeight: 'bold', fontSize: '14px' } },
        credits: { enabled: false },

        xAxis: {
            categories,
            lineWidth:     1,
            lineColor:     '#ddd',
            gridLineWidth: 0,
            title:         { text: xAxisTitle, style: { fontWeight: 'bold' } },
            labels: {
                useHTML:   true,
                rotation:  0,
                style: { fontSize: '11px' },
                formatter: function (this: any) {
                    const cat = this.value as string;
                    const isStartEnd = cat.startsWith('START') || cat.startsWith('END');
                    const parts = cat.split('\n');
                    if (isStartEnd) {
                        return `<div style="text-align:center;width:90px;white-space:normal;word-break:break-word;">
                            <div style="font-size:10px;color:#888;text-transform:uppercase;font-weight:600;">${parts[0]}</div>
                            <div style="font-size:13px;font-weight:700;color:${colorTotal};">${parts[1] ?? ''}</div>
                        </div>`;
                    }
                    return `<div style="text-align:center;width:90px;white-space:normal;word-break:break-word;font-size:11px;font-weight:600;color:#333;">${cat}</div>`;
                },
            },
        },

        yAxis: {
            min:           yMin - padding,
            max:           yMax + padding,
            title:         { text: yAxisTitle, style: { fontWeight: 'bold' } },
            gridLineWidth: showGridLines ? 1 : 0,
            gridLineColor: '#f0f0f0',
            labels: {
                formatter: function (this: any) {
                    return formatNumber(this.value, numberFormat);
                },
            },
        },

        legend: { enabled: false },

        tooltip: {
            backgroundColor: '#3A3F48',
            borderColor:     '#FFD700',
            borderRadius:    4,
            borderWidth:     1,
            style: { color: '#FFFFFF', fontSize: '12px' },
            useHTML: true,
            formatter: function (this: any) {
                const point = this.point as any;
                if (point.isTotal) return false;
                const delta = point.delta ?? 0;
                const sign  = delta >= 0 ? '+' : '';
                const runningTotal = delta >= 0 ? point.high : point.low;
                return `<b>${categories[point.x]}</b><br/>
                    <b>Change:</b> ${sign}${formatNumber(delta, numberFormat)}<br/>
                    <b>Running total:</b> ${formatNumber(runningTotal, numberFormat)}`;
            },
        },

        plotOptions: {
            columnrange: {
                borderWidth:  0,
                pointPadding: 0.05,
                groupPadding: 0.1,
                dataLabels: {
                    enabled:      showDataLabels,
                    inside:       true,
                    verticalAlign: 'middle',
                    style: { fontWeight: '600', fontSize: '11px', color: '#fff', textOutline: 'none' },
                    formatter: function (this: any) {
                        const point = this.point as any;
                        if (point.isTotal) return '';
                        const delta = point.delta ?? 0;
                        const sign  = delta >= 0 ? '+' : '-';
                        return sign + formatNumber(Math.abs(delta), numberFormat);
                    },
                },
                point: {
                    events: {
                        contextmenu: function (e: MouseEvent) {
                            e.preventDefault();
                            const point = this as any;
                            const yColumns =
                                chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'y')?.columns ?? [];
                            ctx.emitEvent(ChartToTSEvent.OpenContextMenu, {
                                event: { clientX: e.clientX, clientY: e.clientY },
                                clickedPoint: {
                                    tuple: [
                                        { columnId: yColumns[0]?.id ?? '', value: categories[point.x] },
                                        { columnId: yColumns[yColumns.length - 1]?.id ?? '', value: point.high },
                                    ],
                                },
                            });
                        },
                    },
                },
            },
            line: {
                marker:             { enabled: false },
                enableMouseTracking: false,
                states:             { hover: { enabled: false } },
            },
        },

        series: [
            {
                type:         'columnrange',
                name:         'Movements',
                data:         seriesData.map(d => ({
                    low:     d.low,
                    high:    d.high,
                    color:   d.color,
                    delta:   d.delta,
                    isTotal: d.isTotal,
                })),
                showInLegend: false,
            },
            ...(showConnector ? [{
                type:                'line',
                name:                'connector',
                data:                connectorY.map((y, i) => ({ x: i, y })),
                color:               '#bbb',
                dashStyle:           'Dot',
                lineWidth:           1,
                marker:              { enabled: false },
                showInLegend:        false,
                enableMouseTracking: false,
            }] : []),
            ...(showStartEndMarkers ? [
                {
                    type:                'scatter',
                    name:                'start-marker',
                    data:                [{ x: 0, y: startValue }],
                    marker:              { symbol: 'circle', radius: 6, fillColor: colorTotal, lineWidth: 0 },
                    showInLegend:        false,
                    enableMouseTracking: false,
                },
                {
                    type:                'scatter',
                    name:                'end-marker',
                    data:                [{ x: categories.length - 1, y: endValue }],
                    marker:              { symbol: 'circle', radius: 6, fillColor: colorTotal, lineWidth: 0 },
                    showInLegend:        false,
                    enableMouseTracking: false,
                },
            ] : []),
        ],
    });

    // Draw SVG pill callouts on top of the START and END bars
    const chart    = globalChartReference;
    const xAxisObj = chart.xAxis[0];
    const yAxisObj = chart.yAxis[0];

    const drawCallout = (xCat: number, yVal: number, label: string, color: string) => {
        const px = xAxisObj.toPixels(xCat, false);
        const py = yAxisObj.toPixels(yVal, false);
        const w = 80, h = 28, r = 14;
        chart.renderer.rect(px - w / 2, py - h / 2, w, h, r)
            .attr({ fill: color, zIndex: 5 })
            .add();
        chart.renderer.text(label, px, py + 5)
            .attr({ align: 'center', zIndex: 6 })
            .css({ color: '#fff', fontSize: '12px', fontWeight: '700' })
            .add();
    };

    if (showStartEndPills) {
        drawCallout(0,                     startValue, formatNumber(startValue, numberFormat), colorTotal);
        drawCallout(categories.length - 1, endValue,   formatNumber(endValue,   numberFormat), colorTotal);
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
            const measureColumns = chartModel.columns.filter(col => col.type === ColumnType.MEASURE);
            if (measureColumns.length < 1) {
                throw new Error('At least one measure is required.');
            }
            return [
                {
                    key: 'column',
                    dimensions: [
                        { key: 'y', columns: measureColumns },
                    ],
                },
            ];
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
        chartConfigEditorDefinition: [
            {
                key:             'column',
                label:           'Waterfall Chart Configuration',
                descriptionText: 'Add measures in order: Start value → deltas → End value.',
                columnSections: [
                    {
                        key:                   'y',
                        label:                 'Measures (Start → deltas → End)',
                        allowAttributeColumns: false,
                        allowMeasureColumns:   true,
                        maxColumnCount:        20,
                    },
                ],
            },
        ],
        visualPropEditorDefinition: {
            elements: [
                { key: 'chartTitle',          type: 'text',     defaultValue: ' ',       label: 'Chart title' },
                { key: 'xAxisTitle',          type: 'text',     defaultValue: ' ',       label: 'X-axis title' },
                { key: 'yAxisTitle',          type: 'text',     defaultValue: 'Value',   label: 'Y-axis title' },
                { key: 'numberFormat',        type: 'text',     defaultValue: '0.[0]a',  label: 'Number format' },
                { key: 'colorPositive',       type: 'colorpicker', defaultValue: '#378ADD', label: 'Positive bar colour' },
                { key: 'colorNegative',       type: 'colorpicker', defaultValue: '#E24B4A', label: 'Negative bar colour' },
                { key: 'colorTotal',          type: 'colorpicker', defaultValue: '#534AB7', label: 'Total bar colour' },
                { key: 'showDataLabels',      type: 'toggle',      defaultValue: true,      label: 'Show data labels' },
                { key: 'showConnector',       type: 'toggle',      defaultValue: true,      label: 'Show connector line' },
                { key: 'showStartEndMarkers', type: 'toggle',      defaultValue: true,      label: 'Show start/end markers' },
                { key: 'showStartEndPills',   type: 'toggle',      defaultValue: true,      label: 'Show start/end pill labels' },
                { key: 'showGridLines',       type: 'toggle',      defaultValue: true,      label: 'Show grid lines' },
            ],
        },
    });

    renderChart(ctx);
})();
