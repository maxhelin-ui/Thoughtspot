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
import Highcharts from 'highcharts';
import HighchartsMore from 'highcharts/highcharts-more';
import HighchartsCustomEvents from 'highcharts-custom-events';

// Bundle the Highcharts modules instead of loading them from a CDN. The
// CDN <script> tags were blocked by the deployment's Content-Security-Policy
// (default-src 'self'), leaving `Highcharts` undefined at render time.
// Importing here lets Vite bundle everything from our own origin.
// highcharts-more provides the `columnrange` series; highcharts-custom-events
// provides the point `contextmenu` event used for the right-click menu.
HighchartsMore(Highcharts);
HighchartsCustomEvents(Highcharts);

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
    basePillField?: string;
    netChangeLabel?: string;
    basePillDiffLabel?: string;
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
let globalAppConfig: any = null;
let renderDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let firstRenderDone = false;
let lastRenderedDataRef: unknown = null;

// Returns the org-configured chart palette if TS provided one, else the
// SLICE_PALETTE fallback.
function getEffectivePalette(): string[] {
    const palettes = globalAppConfig?.styleConfig?.chartColorPalettes;
    if (Array.isArray(palettes) && palettes.length > 0
        && Array.isArray(palettes[0]?.colors) && palettes[0].colors.length > 0) {
        return palettes[0].colors;
    }
    return SLICE_PALETTE;
}
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

    // Progressive shrink: first push the legend to the chart's right edge
    // (drop right padding), then push the slicer pills to the left edge
    // (drop left padding). Only after both edges are flush do we accept a
    // 2-row layout. align-items: center can offset shorter children a few
    // pixels even on the same row, so we use a tolerance on the outer
    // check.
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

    const tooltipExtraColumns =
        chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'tooltipExtras')?.columns ?? [];

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

    // One summed value per bound tooltip-extra column — paired with the
    // Y-column at the same index (extra[0] -> y[0], etc.).
    const tooltipExtraValues = tooltipExtraColumns.map(col => {
        const colIdx = dataArr.columns.indexOf(col.id);
        if (colIdx < 0) return null;
        const sum = visibleRows.reduce(
            (acc, row) => acc + (parseFloat(String(row[colIdx] ?? 0)) || 0),
            0,
        );
        return sum;
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

    return { values, names, sliceColumns, slicesByColumn, yColumns, tooltipExtraColumns, tooltipExtraValues };
}

function render(ctx: CustomChartContext) {
    const chartModel   = ctx.getChartModel();
    const { values, names, sliceColumns, slicesByColumn, yColumns, tooltipExtraColumns, tooltipExtraValues } = getDataModel(chartModel);
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
    const basePillField       = visualProps.basePillField       ?? 'None';
    // Optional labels shown inside each right-side change pill. netChangeLabel
    // labels the start→end pill; basePillDiffLabel labels the base→end pill.
    const netChangeLabel      = (visualProps.netChangeLabel      ?? '').trim();
    const basePillDiffLabel   = (visualProps.basePillDiffLabel   ?? '').trim();
    const showStartEndMarkers = visualProps.showStartEndMarkers ?? true;
    const showStartEndPills   = visualProps.showStartEndPills   ?? true;
    const showGridLines       = visualProps.showGridLines       ?? true;

    // Reserve right-margin space when either right-side difference indicator
    // (overall net change and/or the base→end difference) is shown.
    const showRightDiff = showNetChange || basePillField !== 'None';
    // Labels make the change pills a bit wider (value + % share line 1, label
    // on line 2), so reserve more right margin when any label is set.
    const anyDiffLabel  = (showNetChange && !!netChangeLabel)
        || (basePillField !== 'None' && !!basePillDiffLabel);
    const rightReserve  = showRightDiff ? (anyDiffLabel ? 150 : 116) : 40;

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

    const palette = getEffectivePalette();
    const sliceColors = activeSlice ? activeSlice.sliceNames.map((s, i) => pickColor(
        visualProps[`sliceColor_${activeSlice.column.id}_${s}`],
        palette[i % palette.length],
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
    adjustButtonContainer(sliceColumns.length > 0, rightReserve);

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

    // Resolve the optional "additional base" pill. The dropdown stores the
    // middle field's (possibly renamed) name; match it back to a delta index.
    // runningTotals[k+1] is the running total at the k-th middle category
    // (category index k+1), i.e. the value that point's pill should show.
    let baseSelected = false;
    let baseCatIdx = -1;
    let baseRunningTotal = 0;
    if (basePillField && basePillField !== 'None') {
        const di = deltaNames.indexOf(basePillField);
        if (di >= 0) {
            baseSelected     = true;
            baseCatIdx       = di + 1;
            baseRunningTotal = runningTotals[di + 1];
        }
    }

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
            // The selected base shows only its pill — no bar (or slice bars).
            if (baseSelected && catIdx === baseCatIdx) {
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

    // X-axis labels render as wrapped HTML (width:90px), so Highcharts'
    // own measure-and-grow doesn't account for them. Estimate the line
    // count from the longest category and reserve enough marginBottom so
    // 2- or 3-line labels (e.g. "Price Increase / Discount Removal ARR")
    // don't get clipped.
    const LABEL_WIDTH_PX  = 90;
    const APPROX_CHARS_PER_LINE = 13;   // ~7px per char at 11px font
    const LINE_HEIGHT_PX  = 14;
    const maxLabelLines = Math.max(1, ...categories.map(
        cat => Math.ceil(String(cat ?? '').length / APPROX_CHARS_PER_LINE),
    ));
    const dynamicMarginBottom = Math.max(50, maxLabelLines * LINE_HEIGHT_PX + 28);

    globalChartReference = Highcharts.chart('chart', {
        chart: {
            type: 'columnrange',
            marginLeft:   80,
            marginRight:  rightReserve,
            marginBottom: dynamicMarginBottom,
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
                const seriesName = point.series?.name ?? '';
                const isStartMarker = seriesName === 'start-marker';
                const isEndMarker   = seriesName === 'end-marker';
                const isBaseMarker  = seriesName === 'base-marker';
                // Suppress tooltip on the invisible zero-height columnrange
                // totals; the scatter start/end/base markers carry the tooltip
                // instead (and are mouse-tracked).
                if (point.isTotal && !isStartMarker && !isEndMarker && !isBaseMarker) return false;

                const colIdx = point.x ?? 0;
                // Tooltip extras are bound by index: extra[i] pairs with y[i].
                // Pull every non-null extra for this column and render them as
                // additional rows in the tooltip.
                const extraRows: Array<{ label: string; value: string }> = [];
                if (tooltipExtraColumns[colIdx] != null && tooltipExtraValues[colIdx] != null) {
                    extraRows.push({
                        label: `${tooltipExtraColumns[colIdx].name}:`,
                        value: formatNumber(tooltipExtraValues[colIdx] as number, numberFormat),
                    });
                }

                const borderColor = point.color ?? point.series?.color ?? colorTotal ?? '#52B788';

                const rows: Array<{ label: string; value: string }> = [];

                if (isStartMarker || isEndMarker || isBaseMarker) {
                    const totalValue = point.y;
                    rows.push({
                        label: `${categories[colIdx] ?? ''}:`,
                        value: formatNumber(totalValue, numberFormat),
                    });
                } else if (point.isSlice) {
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
                        label: `${categories[colIdx] ?? ''}:`,
                        value: `${sign}${formatNumber(delta, numberFormat)}`,
                    });
                    rows.push({
                        label: 'Running total:',
                        value: formatNumber(runningTotal, numberFormat),
                    });
                }

                rows.push(...extraRows);

                const rowsHtml = rows.map(({ label, value }, i) => {
                    const labelHtml = label
                        ? `<span style="font-weight:600;">${label}</span><br/><span style="font-weight:700;">${value}</span>`
                        : `<span style="font-weight:400;opacity:0.9;">${value}</span>`;
                    return `<div style="${i > 0 ? 'margin-top:10px;' : ''}">${labelHtml}</div>`;
                }).join('');

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
                    // The selected "additional base" shows only its pill, not a
                    // delta bar — null it out so no bar is drawn for it.
                    if (baseSelected && i === baseCatIdx) {
                        return { low: null, high: null, color: 'transparent', delta: d.delta, isTotal: false };
                    }
                    // When slicing, hide middle bars (slice series draws them instead)
                    const isMiddle = i > 0 && i < seriesData.length - 1;
                    if (showSlicing && isMiddle) {
                        return { low: null, high: null, color: 'transparent', delta: d.delta, isTotal: false };
                    }
                    // Null-out the start/end totals so Highcharts doesn't
                    // catch hovers on the zero-height transparent bars — the
                    // scatter hit-zones below own the start/end tooltip.
                    if (d.isTotal) {
                        return { low: null, high: null, color: 'transparent', delta: d.delta, isTotal: true };
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
                // Visible small dots (no mouse tracking).
                {
                    type:                'scatter',
                    name:                'start-marker-dot',
                    data:                [{ x: 0, y: startValue }],
                    marker:              { symbol: 'circle', radius: 6, fillColor: colorTotal, lineWidth: 0 },
                    showInLegend:        false,
                    enableMouseTracking: false,
                },
                {
                    type:                'scatter',
                    name:                'end-marker-dot',
                    data:                [{ x: categories.length - 1, y: endValue }],
                    marker:              { symbol: 'circle', radius: 6, fillColor: colorTotal, lineWidth: 0 },
                    showInLegend:        false,
                    enableMouseTracking: false,
                },
                // Invisible large hit-zones so hovering anywhere on the
                // start/end pill fires the tooltip. stickyTracking:false
                // means moving the cursor off the pill hides it again.
                {
                    type:                'scatter',
                    name:                'start-marker',
                    data:                [{ x: 0, y: startValue }],
                    // Near-zero alpha (not fully transparent) so SVG hit-testing still fires.
                    marker:              { symbol: 'circle', radius: 26, fillColor: 'rgba(0,0,0,0.001)', lineWidth: 0 },
                    showInLegend:        false,
                    stickyTracking:      false,
                    enableMouseTracking: true,
                },
                {
                    type:                'scatter',
                    name:                'end-marker',
                    data:                [{ x: categories.length - 1, y: endValue }],
                    // Near-zero alpha (not fully transparent) so SVG hit-testing still fires.
                    marker:              { symbol: 'circle', radius: 26, fillColor: 'rgba(0,0,0,0.001)', lineWidth: 0 },
                    showInLegend:        false,
                    stickyTracking:      false,
                    enableMouseTracking: true,
                },
            ] : []),
            ...(baseSelected ? [
                // Visible dot at the base milestone.
                {
                    type:                'scatter',
                    name:                'base-marker-dot',
                    data:                [{ x: baseCatIdx, y: baseRunningTotal }],
                    marker:              { symbol: 'circle', radius: 6, fillColor: colorTotal, lineWidth: 0 },
                    showInLegend:        false,
                    enableMouseTracking: false,
                },
                // Invisible hit-zone so the base pill shares the start/end
                // hover-tooltip behaviour.
                {
                    type:                'scatter',
                    name:                'base-marker',
                    data:                [{ x: baseCatIdx, y: baseRunningTotal }],
                    marker:              { symbol: 'circle', radius: 26, fillColor: 'rgba(0,0,0,0.001)', lineWidth: 0 },
                    showInLegend:        false,
                    stickyTracking:      false,
                    enableMouseTracking: true,
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
        // pointer-events:none so the pill doesn't swallow hovers — the
        // invisible scatter hit-zone underneath catches them instead.
        chart.renderer.rect(px - w / 2, py - h / 2, w, h, r)
            .attr({ fill: color, zIndex: 5 })
            .css({ pointerEvents: 'none' })
            .add();
        chart.renderer.text(label, px, py + 5)
            .attr({ align: 'center', zIndex: 6 })
            .css({ color: '#fff', fontSize: '12px', fontWeight: '700', pointerEvents: 'none' })
            .add();
    };

    if (showStartEndPills) {
        drawCallout(0,                     startValue, formatNumber(startValue, numberFormat), colorTotal);
        drawCallout(categories.length - 1, endValue,   formatNumber(endValue,   numberFormat), colorTotal);
    }

    // Additional "base" milestone pill on a chosen middle category: a pill
    // showing the running total at that point, plus a marker dot — drawn like
    // the start/end pills, while the underlying delta bar stays intact.
    if (baseSelected) {
        // Pill only — the visible dot + hover hit-zone are scatter series
        // (base-marker-dot / base-marker), so the base shares the start/end
        // tooltip behaviour and shows no delta bar.
        drawCallout(baseCatIdx, baseRunningTotal, formatNumber(baseRunningTotal, numberFormat), colorTotal);
    }

    // Right-side difference indicators. Each pill shows the absolute change
    // (with up/down arrow) on the first line and the % change on the second.
    // When both the overall (start→end) and the base→end differences are
    // shown they stack vertically — they can point in opposite directions, so
    // each is coloured by its own sign.
    if (showRightDiff) {
        const endPx  = yAxisObj.toPixels(endValue, false);

        // Each difference is drawn the same way ("mirrored"): a vertical
        // connector from the "from" value's level to the end level, plus a
        // pill anchored at the "from" height — overall (start→end) anchors at
        // the start level, base→end at the base level. All connectors share
        // the same x so they line up into one continuous line. Each is
        // coloured by its own sign (green up, red down).
        const diffs: Array<{ fromVal: number; label: string }> = [];
        if (showNetChange) diffs.push({ fromVal: startValue,       label: netChangeLabel });
        if (baseSelected)  diffs.push({ fromVal: baseRunningTotal, label: basePillDiffLabel });

        // When any pill has a label, the value + % share one line (pushed to
        // the pill's left/right edges) and the label sits underneath, so the
        // pill grows taller/wider. Otherwise value over %, centred, compact.
        const labeled = diffs.some(d => !!d.label);
        const pillW = labeled ? 132 : 96;
        const pillH = labeled ? 44 : 40;
        const pillR = 14, lineW = 6, gap = 6;
        // Flush the pills (and the shared connector x) to the right edge of
        // the tile so the whole chart uses the maximum width.
        const cx = chart.chartWidth - pillW / 2 - 6;

        // Place pills at their anchor height, then push later ones apart so
        // stacked pills never collide.
        let prevBottom = -Infinity;
        const placements = diffs.map((d) => {
            const fromPx = yAxisObj.toPixels(d.fromVal, false);
            let top = fromPx - pillH / 2;
            top = Math.max(chart.plotTop + 2, Math.min(top, chart.plotTop + chart.plotHeight - pillH - 2));
            if (top < prevBottom + 4) top = prevBottom + 4;
            prevBottom = top + pillH;
            return { ...d, fromPx, top };
        });

        for (const p of placements) {
            const change = endValue - p.fromVal;
            const isUp   = change >= 0;
            const color  = isUp ? colorPositive : colorNegative;

            // Connector line from the pill edge (with a small gap) to the end
            // level — shared x across diffs so they line up.
            const pillBot = p.top + pillH;
            let lineTop: number, lineH = 0;
            if (endPx >= pillBot) {            // end is below the pill
                lineTop = pillBot + gap;
                lineH   = endPx - lineTop;
            } else if (endPx <= p.top) {        // end is above the pill
                lineTop = endPx;
                lineH   = (p.top - gap) - endPx;
            }
            if (lineH > 1) {
                chart.renderer.rect(cx - lineW / 2, lineTop!, lineW, lineH)
                    .attr({ fill: color, zIndex: 5 })
                    .add();
            }

            const arrow   = isUp ? '▲' : '▼';
            const absText = `${arrow}${formatNumber(Math.abs(change), numberFormat)}`;
            const pct     = (p.fromVal !== 0 && Number.isFinite(p.fromVal))
                ? (change / Math.abs(p.fromVal)) * 100 : null;
            const pctRaw  = pct == null ? '' : `${isUp ? '+' : '-'}${formatNumber(Math.abs(pct), '0.[0]')}%`;

            chart.renderer.rect(cx - pillW / 2, p.top, pillW, pillH, pillR)
                .attr({ fill: color, zIndex: 6 })
                .add();

            if (p.label) {
                // Line 1: value at the left edge, (%) at the right edge.
                const pad = 10;
                chart.renderer.text(absText, cx - pillW / 2 + pad, p.top + 17)
                    .attr({ align: 'left', zIndex: 7 })
                    .css({ color: '#fff', fontSize: '12px', fontWeight: '700' })
                    .add();
                if (pctRaw) {
                    chart.renderer.text(`(${pctRaw})`, cx + pillW / 2 - pad, p.top + 17)
                        .attr({ align: 'right', zIndex: 7 })
                        .css({ color: '#fff', fontSize: '11px', fontWeight: '600' })
                        .add();
                }
                // Line 2: the label, centred.
                chart.renderer.text(p.label, cx, p.top + 34)
                    .attr({ align: 'center', zIndex: 7 })
                    .css({ color: '#fff', fontSize: '11px', fontWeight: '600' })
                    .add();
            } else {
                // No label: value over % change, centred.
                chart.renderer.text(absText, cx, p.top + 16)
                    .attr({ align: 'center', zIndex: 7 })
                    .css({ color: '#fff', fontSize: '12px', fontWeight: '700' })
                    .add();
                if (pctRaw) {
                    chart.renderer.text(pctRaw, cx, p.top + 31)
                        .attr({ align: 'center', zIndex: 7 })
                        .css({ color: '#fff', fontSize: '11px', fontWeight: '600' })
                        .add();
                }
            }
        }
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
                        maxColumnCount:        20,
                    },
                    {
                        key:                   'tooltipExtras',
                        label:                 'Tooltip extras (one per Y measure, same order)',
                        allowAttributeColumns: false,
                        allowMeasureColumns:   true,
                        maxColumnCount:        20,
                    },
                ],
            },
        ],
        visualPropEditorDefinition: (chartModel: ChartModel) => {
            const yCols = chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'y')?.columns ?? [];
            const sliceCols = chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === 'slice')?.columns ?? [];

            // Middle fields (everything between the first/start and last/end
            // measures) are the candidates for the "additional base" pill.
            // Use the same renamed names that render() matches against.
            const vpForEditor = (chartModel.visualProps ?? {}) as VisualProps;
            const middleNames = yCols.slice(1, -1).map(col => {
                const o = vpForEditor[`label_${col.id}`];
                return (typeof o === 'string' && o.trim()) ? o : col.name;
            });

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
                            defaultValue: getEffectivePalette()[i % getEffectivePalette().length],
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
                    { key: 'netChangeLabel',      type: 'text',        defaultValue: ' ',       label: 'Net change pill label (start→end; blank = no label)' },
                    { key: 'basePillField',       type: 'dropdown',    defaultValue: 'None',    values: ['None', ...middleNames], label: 'Additional base pill (middle field) + base→end difference' },
                    { key: 'basePillDiffLabel',   type: 'text',        defaultValue: ' ',       label: 'Base→end change pill label (blank = no label)' },
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
