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

function withAlpha(color: string, alpha: number): string {
    if (typeof color !== 'string' || !color.startsWith('#')) return color;
    const clean = color.slice(1);
    let r = 0, g = 0, b = 0;
    if (clean.length === 3) {
        r = parseInt(clean[0] + clean[0], 16);
        g = parseInt(clean[1] + clean[1], 16);
        b = parseInt(clean[2] + clean[2], 16);
    } else if (clean.length === 6 || clean.length === 8) {
        r = parseInt(clean.slice(0, 2), 16);
        g = parseInt(clean.slice(2, 4), 16);
        b = parseInt(clean.slice(4, 6), 16);
    } else {
        return color;
    }
    return `rgba(${r},${g},${b},${alpha})`;
}

function pickColor(picker: unknown, fallback: string): string {
    return (typeof picker === 'string' && picker) ? picker : fallback;
}

let globalChartReference: any = null;
let activeSliceColumnId: string | null = null;
let lastSeenSlicingDefault: boolean | undefined = undefined;
const hiddenSlicesByColumn = new Map<string, Set<string>>();

function getHiddenSet(columnId: string): Set<string> {
    let set = hiddenSlicesByColumn.get(columnId);
    if (!set) {
        set = new Set<string>();
        hiddenSlicesByColumn.set(columnId, set);
    }
    return set;
}

function renderSliceToggles(
    sliceColumns: Array<{ id: string; name: string }>,
    activeId: string | null,
    onToggle: (columnId: string) => void,
) {
    const togglesEl = document.getElementById('sliceToggles');
    if (!togglesEl) return;
    togglesEl.innerHTML = '';

    sliceColumns.forEach(col => {
        const isActive = col.id === activeId;
        const button   = document.createElement('button');
        button.className = 'slice-toggle-btn' + (isActive ? ' active' : '');
        button.type      = 'button';
        button.textContent = col.name;
        button.onclick   = () => onToggle(col.id);
        togglesEl.appendChild(button);
    });
}

function renderCustomLegend(
    sliceColumnId: string | null,
    sliceNames: string[],
    sliceColors: string[],
    onToggle: (sliceName: string) => void,
) {
    const legendEl = document.getElementById('customLegend');
    if (!legendEl) return;
    legendEl.innerHTML = '';
    if (!sliceColumnId) return;
    const hidden = getHiddenSet(sliceColumnId);
    sliceNames.forEach((name, i) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'legend-item' + (hidden.has(name) ? ' legend-hidden' : '');
        const swatch = document.createElement('span');
        swatch.className = 'legend-swatch';
        swatch.style.background = sliceColors[i] ?? '#999';
        const label = document.createElement('span');
        label.textContent = name;
        item.appendChild(swatch);
        item.appendChild(label);
        item.onclick = () => onToggle(name);
        legendEl.appendChild(item);
    });
}

function adjustButtonContainer(hasContent: boolean, marginRight: number) {
    const container = document.getElementById('buttonContainer');
    const toggles   = document.getElementById('sliceToggles');
    const legend    = document.getElementById('customLegend');
    if (!container) return;
    container.style.display = hasContent ? 'flex' : 'none';
    container.style.paddingLeft  = '80px';
    container.style.paddingRight = marginRight + 'px';
    if (!hasContent || !toggles || !legend) return;

    // If the layout had to wrap — either the outer container (legend
    // dropped onto its own row) or inner items (toggles/legend items
    // wrapped within their container) — drop the right padding so the
    // legend can spill to the chart's right edge.
    // Use a tolerance for the outer check because align-items: center
    // can offset the shorter container by a few pixels even on the same row.
    const isWrapped = (el: HTMLElement): boolean => {
        const items = Array.from(el.children) as HTMLElement[];
        if (items.length < 2) return false;
        const firstTop = items[0].offsetTop;
        return items.some(item => Math.abs(item.offsetTop - firstTop) > 4);
    };
    const outerWrapped = Math.abs(legend.offsetTop - toggles.offsetTop) > 15;
    if (outerWrapped || isWrapped(legend) || isWrapped(toggles)) {
        container.style.paddingRight = '6px';
    }
}

function formatNumber(value: number, format: string): string {
    try {
        return numeral(value).format(format).replace('k', 'K').replace('m', 'M').replace('b', 'B');
    } catch {
        return value?.toString() ?? '0';
    }
}

type SliceInfo = {
    column: { id: string; name: string };
    sliceNames: string[];
    contribsByMeasure: number[][];
};

function getDataModel(chartModel: ChartModel) {
    const dataArr: DataPointsArray =
        chartModel.data?.[chartModel.data.length - 1]?.data ?? { columns: [], dataValue: [] };

    const yColumns =
        chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'y')?.columns ?? [];

    const sliceColumns =
        chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'slice')?.columns ?? [];

    const visualProps = (chartModel.visualProps ?? {}) as VisualProps;

    // Filter rows by the active slicer's hidden values AND drop rows whose
    // slice column is null/empty, so totals/deltas/running totals/y-axis all
    // reflect the visible subset and match the sum of slice segments.
    const activeSliceCol    = activeSliceColumnId ? sliceColumns.find(c => c.id === activeSliceColumnId) : null;
    const activeSliceColIdx = activeSliceCol ? dataArr.columns.indexOf(activeSliceCol.id) : -1;
    const activeHidden      = activeSliceColumnId ? hiddenSlicesByColumn.get(activeSliceColumnId) : undefined;
    const visibleRows = (activeSliceCol && activeSliceColIdx >= 0)
        ? dataArr.dataValue.filter(row => {
            const raw = row[activeSliceColIdx];
            if (raw == null) return false;
            const v = String(raw);
            if (!v.trim()) return false;
            if (activeHidden && activeHidden.has(v)) return false;
            return true;
        })
        : dataArr.dataValue;

    const values = yColumns.map(col => {
        const colIdx = dataArr.columns.indexOf(col.id);
        if (colIdx < 0) return 0;
        return visibleRows.reduce(
            (sum, row) => sum + (parseFloat(String(row[colIdx] ?? 0)) || 0),
            0,
        );
    });

    const names = yColumns.map(col => {
        const override = visualProps[`label_${col.id}`];
        return (typeof override === 'string' && override.trim()) ? override : col.name;
    });

    const slicesByColumn: SliceInfo[] = sliceColumns.map(sliceColumn => {
        const sliceNames: string[] = [];
        const contribsByMeasure: number[][] = [];
        const sliceColIdx = dataArr.columns.indexOf(sliceColumn.id);
        if (sliceColIdx >= 0) {
            // Names from ALL rows so hidden slices still appear in the legend.
            // Skip null/empty values — they shouldn't appear in the legend.
            const seen = new Set<string>();
            for (const row of dataArr.dataValue) {
                const raw = row[sliceColIdx];
                if (raw == null) continue;
                const v = String(raw);
                if (!v.trim()) continue;
                if (!seen.has(v)) {
                    seen.add(v);
                    sliceNames.push(v);
                }
            }
            // Sort with natural order so tier_1 < tier_2 < tier_10, etc.
            sliceNames.sort((a, b) =>
                a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
            );
            // Contributions from the filtered subset
            yColumns.forEach(col => {
                const colIdx = dataArr.columns.indexOf(col.id);
                if (colIdx < 0) {
                    contribsByMeasure.push(sliceNames.map(() => 0));
                    return;
                }
                contribsByMeasure.push(sliceNames.map(sliceName =>
                    visibleRows.reduce((sum, row) => {
                        if (String(row[sliceColIdx] ?? '') !== sliceName) return sum;
                        return sum + (parseFloat(String(row[colIdx] ?? 0)) || 0);
                    }, 0),
                ));
            });
        }
        return { column: { id: sliceColumn.id, name: sliceColumn.name }, sliceNames, contribsByMeasure };
    });

    return { values, names, sliceColumns, slicesByColumn };
}

function render(ctx: CustomChartContext) {
    const chartModel   = ctx.getChartModel();
    const { values, names, sliceColumns, slicesByColumn } = getDataModel(chartModel);
    const visualProps  = (chartModel.visualProps ?? {}) as VisualProps;

    const numberFormat        = visualProps.numberFormat        ?? '0.[0]a';
    const chartTitle          = visualProps.chartTitle          ?? '';
    const xAxisTitle          = visualProps.xAxisTitle          ?? '';
    const yAxisTitle          = visualProps.yAxisTitle          ?? 'Value';
    const colorPositive       = pickColor(visualProps.colorPositive, '#378ADD');
    const colorNegative       = pickColor(visualProps.colorNegative, '#E24B4A');
    const colorTotal          = pickColor(visualProps.colorTotal,    '#534AB7');
    const showDataLabels      = visualProps.showDataLabels      ?? true;
    const showConnector       = visualProps.showConnector       ?? true;
    const showNetChange       = visualProps.showNetChange       ?? false;
    const showStartEndMarkers = visualProps.showStartEndMarkers ?? true;
    const showStartEndPills   = visualProps.showStartEndPills   ?? true;
    const showGridLines       = visualProps.showGridLines       ?? true;

    const settingsDefault     = visualProps.showSlicing ?? false;
    if (settingsDefault !== lastSeenSlicingDefault) {
        activeSliceColumnId = settingsDefault && sliceColumns.length > 0 ? sliceColumns[0].id : null;
        lastSeenSlicingDefault = settingsDefault;
    }
    // Drop the active id if the user removed that slice column
    if (activeSliceColumnId && !sliceColumns.some(c => c.id === activeSliceColumnId)) {
        activeSliceColumnId = null;
    }
    const activeSlice = slicesByColumn.find(s => s.column.id === activeSliceColumnId);
    const showSlicing = !!activeSlice && activeSlice.sliceNames.length > 0;

    renderSliceToggles(sliceColumns, activeSliceColumnId, (columnId) => {
        activeSliceColumnId = (activeSliceColumnId === columnId) ? null : columnId;
        render(ctx);
    });

    const connectorColor      = pickColor(visualProps.connectorColor, '#bbbbbb');
    const connectorWidth      = visualProps.connectorWidth      ?? 1;
    const connectorStyle      = visualProps.connectorStyle      ?? 'Dot';

    const sliceColors = activeSlice ? activeSlice.sliceNames.map((s, i) => pickColor(
        visualProps[`sliceColor_${activeSlice.column.id}_${s}`],
        SLICE_PALETTE[i % SLICE_PALETTE.length],
    )) : [];

    renderCustomLegend(
        activeSlice ? activeSlice.column.id : null,
        activeSlice ? activeSlice.sliceNames : [],
        sliceColors,
        (sliceName) => {
            if (!activeSlice) return;
            const set = getHiddenSet(activeSlice.column.id);
            if (set.has(sliceName)) set.delete(sliceName);
            else set.add(sliceName);
            render(ctx);
        },
    );
    adjustButtonContainer(sliceColumns.length > 0, showNetChange ? 110 : 40);

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
        names[0],
        ...movements.map(m => m.name),
        names[names.length - 1],
    ];

    const seriesData = [
        { low: startValue, high: startValue, color: 'transparent', delta: startValue, isTotal: true },
        ...movements.map(m => ({ low: m.low, high: m.high, color: m.color, delta: m.delta, isTotal: false })),
        { low: endValue,   high: endValue,   color: 'transparent', delta: endValue,   isTotal: true },
    ];

    // When slicing is enabled, each middle bar splits into per-slice columnrange segments.
    // Same-sign within a column is assumed. Stack from the bar's low edge upward using
    // |contribution|, so the first slice is always at the bottom regardless of direction.
    const sliceSeries: any[] = (showSlicing && activeSlice) ? activeSlice.sliceNames.map((sliceName, sIdx) => {
        const data = categories.map((_, catIdx) => {
            if (catIdx === 0 || catIdx === categories.length - 1) {
                return { x: catIdx, low: null, high: null };
            }
            const deltaIdx     = catIdx - 1;
            const yColIdx      = deltaIdx + 1;
            const contribs     = activeSlice.contribsByMeasure[yColIdx] ?? [];
            const before       = runningTotals[deltaIdx];
            const after        = runningTotals[deltaIdx + 1];
            const lowY         = Math.min(before, after);
            let stackBase      = lowY;
            let signedCumul    = 0;
            for (let i = 0; i < sIdx; i++) {
                stackBase   += Math.abs(contribs[i] ?? 0);
                signedCumul += contribs[i] ?? 0;
            }
            const contribution      = contribs[sIdx] ?? 0;
            const runningTotalAfter = before + signedCumul + contribution;
            return {
                x:                 catIdx,
                low:               stackBase,
                high:              stackBase + Math.abs(contribution),
                contribution,
                runningTotalAfter,
                sliceName,
                isTotal:           false,
                isSlice:           true,
            };
        });
        const hidden = activeSlice ? getHiddenSet(activeSlice.column.id).has(sliceName) : false;
        return {
            type:         'columnrange',
            name:         sliceName,
            data,
            color:        sliceColors[sIdx],
            showInLegend: false,
            visible:      !hidden,
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
            marginBottom: 50,
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
                    const isStartEnd = this.pos === 0 || this.pos === categories.length - 1;
                    if (isStartEnd) {
                        return `<div style="text-align:center;width:90px;white-space:normal;word-break:break-word;font-size:10px;color:#888;text-transform:uppercase;font-weight:600;">${cat}</div>`;
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
            backgroundColor: 'rgba(0,0,0,0)',
            borderWidth:     0,
            shadow:           false,
            padding:          0,
            style: { color: '#FFFFFF', fontSize: '13px' },
            useHTML: true,
            formatter: function (this: any) {
                const point = this.point as any;
                if (point.isTotal) return false;

                const borderColor = point.color ?? point.series?.color ?? '#52B788';

                const rows: Array<{ label: string; value: string }> = [];
                if (point.isSlice) {
                    const contribution = point.contribution ?? 0;
                    const sign         = contribution >= 0 ? '+' : '';
                    rows.push({
                        label: `${point.sliceName}:`,
                        value: `${sign}${formatNumber(contribution, numberFormat)}`,
                    });
                    rows.push({
                        label: 'Running total:',
                        value: formatNumber(point.runningTotalAfter ?? point.high, numberFormat),
                    });
                } else {
                    const delta = point.delta ?? 0;
                    const sign  = delta >= 0 ? '+' : '';
                    const runningTotal = delta >= 0 ? point.high : point.low;
                    rows.push({
                        label: `${categories[point.x] ?? ''}:`,
                        value: `${sign}${formatNumber(delta, numberFormat)}`,
                    });
                    rows.push({
                        label: 'Running total:',
                        value: formatNumber(runningTotal, numberFormat),
                    });
                }

                const rowsHtml = rows.map(({ label, value }, i) =>
                    `<div style="${i > 0 ? 'margin-top:10px;' : ''}font-weight:600;">${label}<br/><span style="font-weight:700;">${value}</span></div>`,
                ).join('');

                return `<div style="border:1px solid ${withAlpha(borderColor, 0.75)};border-radius:8px;background:#3A3F48;padding:12px;color:#FFFFFF;font-size:13px;">${rowsHtml}</div>`;
            },
        },

        plotOptions: {
            columnrange: {
                borderWidth:     0,
                pointPadding:    0.05,
                groupPadding:    0.1,
                grouping:        false,
                stickyTracking:  false,
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
        const netChange   = endValue - startValue;
        const isUp        = netChange >= 0;
        const arrow       = isUp ? '▲' : '▼';
        const deltaColor  = isUp ? colorPositive : colorNegative;
        const startPx     = yAxisObj.toPixels(startValue, false);
        const endPx       = yAxisObj.toPixels(endValue,   false);
        const barX        = chart.plotLeft + chart.plotWidth + 35;
        const barTop      = Math.min(startPx, endPx);
        const barH        = Math.abs(startPx - endPx);

        chart.renderer.rect(barX - 3, barTop, 6, barH)
            .attr({ fill: deltaColor, zIndex: 5 })
            .add();

        const pillText = `${arrow}${formatNumber(Math.abs(netChange), numberFormat)}`;
        const pillW = 80, pillH = 28, pillR = 14;
        const pillY = barTop - pillH - 6;
        chart.renderer.rect(barX - pillW / 2, pillY, pillW, pillH, pillR)
            .attr({ fill: deltaColor, zIndex: 6 })
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
                        label:                 'Slice middle bars by (optional, multiple allowed)',
                        allowAttributeColumns: true,
                        allowMeasureColumns:   false,
                        maxColumnCount:        5,
                    },
                ],
            },
        ],
        visualPropEditorDefinition: (chartModel: ChartModel) => {
            const yCols = chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'y')?.columns ?? [];
            const sliceCols = chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'slice')?.columns ?? [];

            const labelOverrides = yCols.map(col => ({
                key:          `label_${col.id}`,
                type:         'text' as const,
                defaultValue: col.name,
                label:        `Rename: ${col.name}`,
            }));

            const sliceColorPickers: any[] = [];
            const dataArr = chartModel.data?.[chartModel.data.length - 1]?.data;
            if (dataArr) {
                sliceCols.forEach(sliceCol => {
                    const sliceColIdx = dataArr.columns.indexOf(sliceCol.id);
                    if (sliceColIdx < 0) return;
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
                            defaultValue: SLICE_PALETTE[i % SLICE_PALETTE.length],
                            label:        `${sliceCol.name} — ${s}`,
                        });
                    });
                });
            }

            return {
                elements: [
                    { key: 'chartTitle',          type: 'text',        defaultValue: ' ',       label: 'Chart title' },
                    { key: 'xAxisTitle',          type: 'text',        defaultValue: ' ',       label: 'X-axis title' },
                    { key: 'yAxisTitle',          type: 'text',        defaultValue: 'Value',   label: 'Y-axis title' },
                    { key: 'numberFormat',        type: 'text',        defaultValue: '0.[0]a',  label: 'Number format' },
                    { key: 'colorPositive',       type: 'colorpicker', defaultValue: '#378ADD', label: 'Positive bar colour' },
                    { key: 'colorNegative',       type: 'colorpicker', defaultValue: '#E24B4A', label: 'Negative bar colour' },
                    { key: 'colorTotal',          type: 'colorpicker', defaultValue: '#534AB7', label: 'Total bar colour' },
                    { key: 'connectorColor',      type: 'colorpicker', defaultValue: '#bbbbbb', label: 'Connector line colour' },
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
