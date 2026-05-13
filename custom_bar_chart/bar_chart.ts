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
    showSlicing?: boolean;
    showNetChange?: boolean;
    connectorColor?: string;
    connectorWidth?: number;
    connectorStyle?: string;
    [labelKey: string]: any;
}

const SLICE_PALETTE = [
    '#378ADD', '#E24B4A', '#534AB7', '#F0A937', '#52B788',
    '#9B5DE5', '#00BBF9', '#FB6F92', '#80B918', '#F08080',
];

function resolveColor(hexInput: unknown, picker: unknown, fallback: string): string {
    if (typeof hexInput === 'string') {
        const trimmed = hexInput.trim();
        const normalized = trimmed.startsWith('#') ? trimmed : '#' + trimmed;
        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(normalized)) {
            return normalized;
        }
    }
    return (typeof picker === 'string' && picker) ? picker : fallback;
}

let globalChartReference: any = null;
let runtimeSlicingOverride: boolean | null = null;
let lastSeenSlicingDefault: boolean | undefined = undefined;

function renderSliceToggle(
    sliceColumn: { name: string } | undefined,
    isActive: boolean,
    onToggle: () => void,
) {
    const container = document.getElementById('buttonContainer');
    if (!container) return;
    container.innerHTML = '';
    if (!sliceColumn) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'flex';

    const button = document.createElement('button');
    button.className = 'slice-toggle-btn' + (isActive ? ' active' : '');
    button.type = 'button';
    button.innerHTML = `<span class="dot"></span>Slice by ${sliceColumn.name}`;
    button.onclick = onToggle;
    container.appendChild(button);
}

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

    const sliceColumn =
        chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'slice')?.columns?.[0];

    const visualProps = (chartModel.visualProps ?? {}) as VisualProps;

    const values = yColumns.map(col => {
        const colIdx = dataArr.columns.indexOf(col.id);
        if (colIdx < 0) return 0;
        return dataArr.dataValue.reduce(
            (sum, row) => sum + (parseFloat(String(row[colIdx] ?? 0)) || 0),
            0,
        );
    });

    const names = yColumns.map(col => {
        const override = visualProps[`label_${col.id}`];
        return (typeof override === 'string' && override.trim()) ? override : col.name;
    });

    const sliceNames: string[] = [];
    const sliceByColumn: number[][] = [];
    if (sliceColumn) {
        const sliceColIdx = dataArr.columns.indexOf(sliceColumn.id);
        if (sliceColIdx >= 0) {
            const seen = new Set<string>();
            for (const row of dataArr.dataValue) {
                const v = String(row[sliceColIdx] ?? '');
                if (!seen.has(v)) {
                    seen.add(v);
                    sliceNames.push(v);
                }
            }
            yColumns.forEach(col => {
                const colIdx = dataArr.columns.indexOf(col.id);
                if (colIdx < 0) {
                    sliceByColumn.push(sliceNames.map(() => 0));
                    return;
                }
                sliceByColumn.push(sliceNames.map(sliceName =>
                    dataArr.dataValue.reduce((sum, row) => {
                        if (String(row[sliceColIdx] ?? '') !== sliceName) return sum;
                        return sum + (parseFloat(String(row[colIdx] ?? 0)) || 0);
                    }, 0),
                ));
            });
        }
    }

    return { values, names, sliceColumn, sliceNames, sliceByColumn };
}

function render(ctx: CustomChartContext) {
    const chartModel   = ctx.getChartModel();
    const { values, names, sliceColumn, sliceNames, sliceByColumn } = getDataModel(chartModel);
    const visualProps  = (chartModel.visualProps ?? {}) as VisualProps;

    const numberFormat        = visualProps.numberFormat        ?? '0.[0]a';
    const chartTitle          = visualProps.chartTitle          ?? '';
    const xAxisTitle          = visualProps.xAxisTitle          ?? '';
    const yAxisTitle          = visualProps.yAxisTitle          ?? 'Value';
    const colorPositive       = resolveColor(visualProps.colorPositiveHex,  visualProps.colorPositive,  '#378ADD');
    const colorNegative       = resolveColor(visualProps.colorNegativeHex,  visualProps.colorNegative,  '#E24B4A');
    const colorTotal          = resolveColor(visualProps.colorTotalHex,     visualProps.colorTotal,     '#534AB7');
    const showDataLabels      = visualProps.showDataLabels      ?? true;
    const showConnector       = visualProps.showConnector       ?? true;
    const showNetChange       = visualProps.showNetChange       ?? false;
    const showStartEndMarkers = visualProps.showStartEndMarkers ?? true;
    const showStartEndPills   = visualProps.showStartEndPills   ?? true;
    const showGridLines       = visualProps.showGridLines       ?? true;
    const settingsDefault     = visualProps.showSlicing ?? false;
    if (settingsDefault !== lastSeenSlicingDefault) {
        runtimeSlicingOverride = null;
        lastSeenSlicingDefault = settingsDefault;
    }
    const baseShowSlicing     = runtimeSlicingOverride ?? settingsDefault;
    const showSlicing         = baseShowSlicing && !!sliceColumn && sliceNames.length > 0;

    renderSliceToggle(sliceColumn, showSlicing, () => {
        runtimeSlicingOverride = !baseShowSlicing;
        render(ctx);
    });
    const connectorColor      = resolveColor(visualProps.connectorColorHex, visualProps.connectorColor, '#bbbbbb');
    const connectorWidth      = visualProps.connectorWidth      ?? 1;
    const connectorStyle      = visualProps.connectorStyle      ?? 'Dot';

    const sliceColors = sliceNames.map((s, i) => resolveColor(
        visualProps[`sliceColorHex_${s}`],
        visualProps[`sliceColor_${s}`],
        SLICE_PALETTE[i % SLICE_PALETTE.length],
    ));

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

    // When slicing is enabled, each middle bar splits into per-slice columnrange segments.
    // Same-sign within a column is assumed, so segments stack cleanly from running_total_before.
    const sliceSeries: any[] = showSlicing ? sliceNames.map((sliceName, sIdx) => {
        const data = categories.map((_, catIdx) => {
            if (catIdx === 0 || catIdx === categories.length - 1) {
                return { x: catIdx, low: null, high: null };
            }
            const deltaIdx     = catIdx - 1;
            const yColIdx      = deltaIdx + 1;
            const contribs     = sliceByColumn[yColIdx] ?? [];
            let stackBase      = runningTotals[deltaIdx];
            for (let i = 0; i < sIdx; i++) stackBase += contribs[i] ?? 0;
            const contribution = contribs[sIdx] ?? 0;
            const segStart     = stackBase;
            const segEnd       = stackBase + contribution;
            return {
                x:            catIdx,
                low:          Math.min(segStart, segEnd),
                high:         Math.max(segStart, segEnd),
                contribution,
                sliceName,
                isTotal:      false,
                isSlice:      true,
            };
        });
        return {
            type:         'columnrange',
            name:         sliceName,
            data,
            color:        sliceColors[sIdx],
            showInLegend: true,
        };
    }) : [];

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
            marginRight:  showNetChange ? 110 : 40,
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

        legend: {
            enabled:       showSlicing,
            align:         'center',
            verticalAlign: 'bottom',
            layout:        'horizontal',
            itemStyle:     { color: '#333', fontWeight: '500', fontSize: '12px' },
            symbolRadius:  2,
            symbolHeight:  10,
            symbolWidth:   10,
            itemDistance:  18,
            margin:        12,
            padding:       6,
            title:         sliceColumn ? { text: sliceColumn.name, style: { fontWeight: '600', fontSize: '11px', color: '#666' } } : undefined,
        },

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
                if (point.isSlice) {
                    const contribution = point.contribution ?? 0;
                    const sign         = contribution >= 0 ? '+' : '';
                    return `<b>${categories[point.x]}</b><br/>
                        <b>${point.sliceName}:</b> ${sign}${formatNumber(contribution, numberFormat)}<br/>
                        <b>Running total:</b> ${formatNumber(point.high, numberFormat)}`;
                }
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
                grouping:     false,
                dataLabels: {
                    enabled:      showDataLabels,
                    inside:       true,
                    verticalAlign: 'middle',
                    style: { fontWeight: '600', fontSize: '11px', color: '#fff', textOutline: 'none' },
                    formatter: function (this: any) {
                        const point = this.point as any;
                        if (point.isTotal) return '';
                        if (point.isSlice) {
                            const c = point.contribution ?? 0;
                            if (c === 0) return '';
                            const sign = c >= 0 ? '+' : '-';
                            return sign + formatNumber(Math.abs(c), numberFormat);
                        }
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
                data:         seriesData.map((d, i) => {
                    // When slicing, hide middle bars (slice series draws them instead)
                    const isMiddle = i > 0 && i < seriesData.length - 1;
                    if (showSlicing && isMiddle) {
                        return { low: null, high: null, color: 'transparent', delta: d.delta, isTotal: false };
                    }
                    return {
                        low:     d.low,
                        high:    d.high,
                        color:   d.color,
                        delta:   d.delta,
                        isTotal: d.isTotal,
                    };
                }),
                showInLegend: false,
            },
            ...sliceSeries,
            ...(showConnector ? [{
                type:                'line',
                name:                'connector',
                data:                connectorY.map((y, i) => ({ x: i, y })),
                color:               connectorColor,
                dashStyle:           connectorStyle,
                lineWidth:           connectorWidth,
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

    if (showNetChange) {
        const netChange = endValue - startValue;
        const isUp      = netChange >= 0;
        const arrow     = isUp ? '▲' : '▼';
        const startPx   = yAxisObj.toPixels(startValue, false);
        const endPx     = yAxisObj.toPixels(endValue,   false);
        const barX      = chart.plotLeft + chart.plotWidth + 35;
        const barTop    = Math.min(startPx, endPx);
        const barH      = Math.abs(startPx - endPx);

        chart.renderer.rect(barX - 3, barTop, 6, barH)
            .attr({ fill: colorTotal, zIndex: 5 })
            .add();

        const pillText = `${arrow}${formatNumber(Math.abs(netChange), numberFormat)}`;
        const pillW = 80, pillH = 28, pillR = 14;
        const pillY = barTop - pillH - 6;
        chart.renderer.rect(barX - pillW / 2, pillY, pillW, pillH, pillR)
            .attr({ fill: colorTotal, zIndex: 6 })
            .add();
        chart.renderer.text(pillText, barX, pillY + 18)
            .attr({ align: 'center', zIndex: 7 })
            .css({ color: '#fff', fontSize: '12px', fontWeight: '700' })
            .add();
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
                        { key: 'y',     columns: measureColumns },
                        { key: 'slice', columns: [] },
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
                    {
                        key:                   'slice',
                        label:                 'Slice middle bars by (optional)',
                        allowAttributeColumns: true,
                        allowMeasureColumns:   false,
                        maxColumnCount:        1,
                    },
                ],
            },
        ],
        visualPropEditorDefinition: (chartModel: ChartModel) => {
            const yCols = chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'y')?.columns ?? [];
            const sliceCol = chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'slice')?.columns?.[0];

            const labelOverrides = yCols.map(col => ({
                key:          `label_${col.id}`,
                type:         'text' as const,
                defaultValue: col.name,
                label:        `Rename: ${col.name}`,
            }));

            const sliceColorPickers: any[] = [];
            if (sliceCol) {
                const dataArr = chartModel.data?.[chartModel.data.length - 1]?.data;
                if (dataArr) {
                    const sliceColIdx = dataArr.columns.indexOf(sliceCol.id);
                    if (sliceColIdx >= 0) {
                        const seen = new Set<string>();
                        const uniqueSlices: string[] = [];
                        for (const row of dataArr.dataValue) {
                            const v = String(row[sliceColIdx] ?? '');
                            if (!seen.has(v)) {
                                seen.add(v);
                                uniqueSlices.push(v);
                            }
                        }
                        uniqueSlices.forEach((s, i) => {
                            const defaultColor = SLICE_PALETTE[i % SLICE_PALETTE.length];
                            sliceColorPickers.push({
                                key:          `sliceColor_${s}`,
                                type:         'colorpicker' as const,
                                defaultValue: defaultColor,
                                label:        `Slice colour: ${s}`,
                            });
                            sliceColorPickers.push({
                                key:          `sliceColorHex_${s}`,
                                type:         'text' as const,
                                defaultValue: defaultColor,
                                label:        `Slice colour hex: ${s}`,
                            });
                        });
                    }
                }
            }

            return {
                elements: [
                    { key: 'chartTitle',          type: 'text',        defaultValue: ' ',       label: 'Chart title' },
                    { key: 'xAxisTitle',          type: 'text',        defaultValue: ' ',       label: 'X-axis title' },
                    { key: 'yAxisTitle',          type: 'text',        defaultValue: 'Value',   label: 'Y-axis title' },
                    { key: 'numberFormat',        type: 'text',        defaultValue: '0.[0]a',  label: 'Number format' },
                    { key: 'colorPositive',       type: 'colorpicker', defaultValue: '#378ADD', label: 'Positive bar colour' },
                    { key: 'colorPositiveHex',    type: 'text',        defaultValue: '#378ADD', label: 'Positive bar colour hex' },
                    { key: 'colorNegative',       type: 'colorpicker', defaultValue: '#E24B4A', label: 'Negative bar colour' },
                    { key: 'colorNegativeHex',    type: 'text',        defaultValue: '#E24B4A', label: 'Negative bar colour hex' },
                    { key: 'colorTotal',          type: 'colorpicker', defaultValue: '#534AB7', label: 'Total bar colour' },
                    { key: 'colorTotalHex',       type: 'text',        defaultValue: '#534AB7', label: 'Total bar colour hex' },
                    { key: 'connectorColor',      type: 'colorpicker', defaultValue: '#bbbbbb', label: 'Connector line colour' },
                    { key: 'connectorColorHex',   type: 'text',        defaultValue: '#bbbbbb', label: 'Connector line colour hex' },
                    { key: 'connectorWidth',      type: 'number',      defaultValue: 1,         label: 'Connector line width' },
                    { key: 'connectorStyle',      type: 'dropdown',    defaultValue: 'Dot',     values: ['Solid', 'Dot', 'Dash', 'DashDot', 'LongDash'], label: 'Connector line style' },
                    { key: 'showDataLabels',      type: 'checkbox',    defaultValue: true,      label: 'Show data labels' },
                    { key: 'showConnector',       type: 'checkbox',    defaultValue: true,      label: 'Show connector line' },
                    { key: 'showStartEndMarkers', type: 'checkbox',    defaultValue: true,      label: 'Show start/end markers' },
                    { key: 'showStartEndPills',   type: 'checkbox',    defaultValue: true,      label: 'Show start/end pill labels' },
                    { key: 'showNetChange',       type: 'checkbox',    defaultValue: false,     label: 'Show net change indicator (right)' },
                    { key: 'showGridLines',       type: 'checkbox',    defaultValue: true,      label: 'Show grid lines' },
                    { key: 'showSlicing',         type: 'checkbox',    defaultValue: false,     label: 'Slice middle bars by default' },
                    ...labelOverrides,
                    ...sliceColorPickers,
                ],
            };
        },
    });

    renderChart(ctx);
})();
