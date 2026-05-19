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
    yAxisTitle?: string;
    numberFormat?: string;
    currency?: string;
    showDataLabels?: boolean;
    showLegend?: boolean;
    showGridLines?: boolean;
    stackingMode?: string;
    sortBy?: string;
    excludeNulls?: boolean;
    [key: string]: any;
}

const MAX_FORMULAS = 4;

const SORT_OPTIONS = [
    'Descending by value',
    'Ascending by value',
    'Alphabetical',
    'Default order',
];

const PALETTE = [
    '#378ADD', '#E24B4A', '#534AB7', '#F0A937', '#52B788',
    '#9B5DE5', '#00BBF9', '#FB6F92', '#80B918', '#F08080',
];

const CURRENCY_OPTIONS = ['None', '$', '€', '£', '¥', '₹', 'kr'];

const STACKING_OPTIONS = ['None', 'Stacked', '100% Stacked'];

let globalChartReference: any = null;
let activeXColumnId: string | null = null;
const hiddenSeriesByX = new Map<string, Set<string>>();

function getHiddenSet(xColumnId: string): Set<string> {
    let set = hiddenSeriesByX.get(xColumnId);
    if (!set) {
        set = new Set<string>();
        hiddenSeriesByX.set(xColumnId, set);
    }
    return set;
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

function formatPercent(value: number): string {
    // ThoughtSpot percentages come through as decimals (0.85 = 85%). Render with
    // up to one decimal place, trimming trailing zeros.
    try {
        return numeral(value).format('0.[0]%');
    } catch {
        return `${(value * 100).toFixed(1)}%`;
    }
}

function detectPercentByName(name: string): boolean {
    const n = (name || '').toLowerCase();
    return /(?:%|\bpct\b|\bpercent\b|\bnrr\b|\bgrr\b|\brate\b|\bratio\b)/.test(n);
}

// Substitutes column names with their numeric values, then evaluates the
// arithmetic expression. Supports both bare names (`Renewed ARR Closed Won`)
// and bracketed names (`[Renewed ARR Closed Won]`). Longer names match first
// so that overlapping names (e.g. "ARR" inside "Renewed ARR") don't collide.
function evalFormula(expr: string, columnValues: Record<string, number>): number | null {
    if (!expr || !expr.trim()) return null;
    const names = Object.keys(columnValues).sort((a, b) => b.length - a.length);
    let processed = expr;
    for (const name of names) {
        const bracketed = `[${name}]`;
        while (processed.indexOf(bracketed) !== -1) {
            processed = processed.split(bracketed).join(`(${columnValues[name]})`);
        }
    }
    for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        processed = processed.replace(new RegExp(escaped, 'g'), `(${columnValues[name]})`);
    }
    if (/[a-zA-Z_\[\]]/.test(processed)) return null; // unresolved name → invalid
    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`"use strict"; return (${processed});`);
        const result = fn();
        return typeof result === 'number' && Number.isFinite(result) ? result : 0;
    } catch {
        return null;
    }
}

function pickColor(picker: unknown, fallback: string): string {
    return (typeof picker === 'string' && picker) ? picker : fallback;
}

function naturalCompare(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function renderXButtons(
    xColumns: Array<{ id: string; name: string }>,
    activeId: string | null,
    onClick: (id: string) => void,
) {
    const togglesEl = document.getElementById('sliceToggles');
    if (!togglesEl) return;
    togglesEl.innerHTML = '';
    xColumns.forEach(col => {
        const button = document.createElement('button');
        const isActive = col.id === activeId;
        button.className = 'slice-toggle-btn' + (isActive ? ' active' : '');
        button.type = 'button';
        button.textContent = col.name;
        button.onclick = () => onClick(col.id);
        togglesEl.appendChild(button);
    });
}

function renderCustomLegend(
    items: Array<{ name: string; color: string }>,
    hidden: Set<string>,
    onToggle: (name: string) => void,
) {
    const legendEl = document.getElementById('customLegend');
    if (!legendEl) return;
    legendEl.innerHTML = '';
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
        legendEl.appendChild(btn);
    });
}

function adjustButtonContainer(hasContent: boolean) {
    const container = document.getElementById('buttonContainer');
    const toggles   = document.getElementById('sliceToggles');
    const legend    = document.getElementById('customLegend');
    if (!container) return;
    container.style.display = hasContent ? 'flex' : 'none';
    container.style.paddingLeft  = '80px';
    container.style.paddingRight = '40px';
    if (!hasContent || !toggles || !legend) return;

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

function clearCustomLegend() {
    const legendEl = document.getElementById('customLegend');
    if (legendEl) legendEl.innerHTML = '';
}

type DataModel = {
    xColumns: Array<{ id: string; name: string }>;
    yColumns: Array<{ id: string; name: string }>;
    formulaInputColumns: Array<{ id: string; name: string }>;
    sliceColumn?: { id: string; name: string };
    dataArr: DataPointsArray;
};

function getDataModel(chartModel: ChartModel): DataModel {
    const dataArr: DataPointsArray =
        chartModel.data?.[chartModel.data.length - 1]?.data ?? { columns: [], dataValue: [] };
    const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
    const xColumns            = dims.find(d => d.key === 'xOptions')?.columns ?? [];
    const yColumns            = dims.find(d => d.key === 'y')?.columns ?? [];
    const formulaInputColumns = dims.find(d => d.key === 'formulaInputs')?.columns ?? [];
    const sliceColumn         = dims.find(d => d.key === 'slice')?.columns?.[0];
    return { xColumns, yColumns, formulaInputColumns, sliceColumn, dataArr };
}

function computeChartData(
    dataArr: DataPointsArray,
    activeXCol: { id: string },
    measureColumns: Array<{ id: string }>,
    sliceColumn: { id: string } | undefined,
    isMeasurePercent: boolean[],
    excludeNulls: boolean,
) {
    const xColIdx     = dataArr.columns.indexOf(activeXCol.id);
    const sliceColIdx = sliceColumn ? dataArr.columns.indexOf(sliceColumn.id) : -1;

    // Always drop null/undefined/empty values; when excludeNulls is on, also
    // drop ThoughtSpot's "{Null}" / "(Null)" / "null" string tokens.
    const isExcluded = (v: any): boolean => {
        if (v == null) return true;
        const s = String(v).trim();
        if (!s) return true;
        if (!excludeNulls) return false;
        const lower = s.toLowerCase();
        return lower === '{null}' || lower === '(null)' || lower === 'null';
    };

    const xCatSet = new Set<string>();
    const sliceSet = new Set<string>();
    for (const row of dataArr.dataValue) {
        const xRaw = row[xColIdx];
        if (isExcluded(xRaw)) continue;
        xCatSet.add(String(xRaw));
        if (sliceColIdx >= 0) {
            const sRaw = row[sliceColIdx];
            if (isExcluded(sRaw)) continue;
            sliceSet.add(String(sRaw));
        }
    }
    const xCategories = Array.from(xCatSet).sort(naturalCompare);
    const sliceNames  = sliceColIdx >= 0 ? Array.from(sliceSet).sort(naturalCompare) : [''];

    // data[mIdx][sIdx][xCatIdx] = aggregated value
    // Sum for normal measures, mean for percent measures (since summing
    // percentages across a row-level breakdown yields nonsense — e.g. five
    // 70% NRR rows would sum to 350%).
    const data: number[][][] = measureColumns.map((mCol, mIdx) => {
        const yColIdx = dataArr.columns.indexOf(mCol.id);
        const useMean = isMeasurePercent[mIdx];
        return sliceNames.map(sliceName =>
            xCategories.map(xCat => {
                let sum = 0;
                let count = 0;
                for (const row of dataArr.dataValue) {
                    if (String(row[xColIdx] ?? '') !== xCat) continue;
                    if (sliceColIdx >= 0 && String(row[sliceColIdx] ?? '') !== sliceName) continue;
                    const raw = row[yColIdx];
                    if (raw == null) continue;
                    const v = parseFloat(String(raw));
                    if (Number.isNaN(v)) continue;
                    sum += v;
                    count++;
                }
                if (useMean) return count > 0 ? sum / count : 0;
                return sum;
            }),
        );
    });

    return { xCategories, sliceNames, data };
}

function render(ctx: CustomChartContext) {
    const chartModel = ctx.getChartModel();
    const { xColumns, yColumns, formulaInputColumns, sliceColumn, dataArr } = getDataModel(chartModel);
    const visualProps = (chartModel.visualProps ?? {}) as VisualProps;

    if (xColumns.length === 0) return;

    if (!activeXColumnId || !xColumns.some(c => c.id === activeXColumnId)) {
        activeXColumnId = xColumns[0].id;
    }
    const activeXCol = xColumns.find(c => c.id === activeXColumnId)!;

    const chartTitle      = visualProps.chartTitle      ?? '';
    const xAxisTitleProp  = visualProps.xAxisTitle      ?? '';
    const yAxisTitle      = visualProps.yAxisTitle      ?? (yColumns.length === 1 ? yColumns[0].name : 'Value');
    const numberFormat    = visualProps.numberFormat    ?? '0,0.[0]a';
    const currency        = visualProps.currency        ?? 'None';
    const showDataLabels  = visualProps.showDataLabels  ?? false;
    const showLegend      = visualProps.showLegend      ?? true;
    const showGridLines   = visualProps.showGridLines   ?? true;
    const stackingMode    = visualProps.stackingMode    ?? 'None';
    const sortBy          = visualProps.sortBy          ?? 'Descending by value';
    const excludeNulls    = visualProps.excludeNulls    ?? true;

    // Collect any defined formulas. Each (name, expr) pair is one computed
    // measure. The chart sums each component measure across the active group,
    // then evaluates the expression — same way TS resolves formulas internally.
    type FormulaDef = { name: string; expr: string };
    const formulas: FormulaDef[] = [];
    for (let i = 1; i <= MAX_FORMULAS; i++) {
        const name = (visualProps[`formula${i}Name`] ?? '').trim();
        const expr = (visualProps[`formula${i}Expr`] ?? '').trim();
        if (name && expr) formulas.push({ name, expr });
    }

    // We need component-sum data for everything the user might reference:
    // y-axis measures (so non-formula rendering still works) AND formula inputs
    // (so formulas can reference them). Dedupe by column id.
    const allMeasureCols: Array<{ id: string; name: string }> = [];
    const seenMeasureIds = new Set<string>();
    for (const c of [...yColumns, ...formulaInputColumns]) {
        if (seenMeasureIds.has(c.id)) continue;
        seenMeasureIds.add(c.id);
        allMeasureCols.push(c);
    }

    if (formulas.length === 0 && yColumns.length === 0) return;

    // For raw aggregation: sum normally; only fall back to mean if the column
    // looks like a percent. When formulas are active, component sums must stay
    // as sums (the formula computes the ratio).
    const allIsMeasurePercent = allMeasureCols.map(c => {
        if (formulas.length > 0) return false;
        const override = visualProps[`measureAsPercent_${c.id}`];
        if (typeof override === 'boolean') return override;
        return detectPercentByName(c.name);
    });

    let { xCategories, sliceNames, data } = computeChartData(
        dataArr, activeXCol, allMeasureCols, sliceColumn, allIsMeasurePercent, excludeNulls,
    );

    // Effective measures = formula results if any defined, else y-axis measures
    // (in their original order, looked up from allMeasureCols).
    let effectiveYColumns: Array<{ id: string; name: string }>;
    let effectiveIsPercent: boolean[];
    if (formulas.length > 0) {
        const formulaData: number[][][] = formulas.map(f => {
            return sliceNames.map((_, sIdx) =>
                xCategories.map((_, catIdx) => {
                    const valuesByName: Record<string, number> = {};
                    allMeasureCols.forEach((col, mIdx) => {
                        valuesByName[col.name] = data[mIdx]?.[sIdx]?.[catIdx] ?? 0;
                    });
                    const v = evalFormula(f.expr, valuesByName);
                    return v ?? 0;
                }),
            );
        });
        data = formulaData;
        effectiveYColumns = formulas.map((f, i) => ({ id: `formula_${i}`, name: f.name }));
        effectiveIsPercent = formulas.map(f => /[\/]/.test(f.expr) || detectPercentByName(f.name));
    } else {
        const yIdxInAll = yColumns.map(yCol => allMeasureCols.findIndex(c => c.id === yCol.id));
        effectiveYColumns = yColumns;
        effectiveIsPercent = yColumns.map((_, i) => allIsMeasurePercent[yIdxInAll[i]]);
        data = yIdxInAll.map(idx => data[idx]);
    }
    const allPercent = effectiveIsPercent.length > 0 && effectiveIsPercent.every(Boolean);

    const fmtForMeasure = (v: number, yIdx: number) =>
        effectiveIsPercent[yIdx]
            ? formatPercent(v)
            : formatCurrency(v, numberFormat, currency);
    const fmtAxis = (v: number) =>
        allPercent
            ? formatPercent(v)
            : formatNumber(v, numberFormat.replace(/^[\$€£¥₹]/, ''));

    // Sort x categories per the user's choice. Default = descending by value
    // (sum of the first measure across all slices, per category).
    if (sortBy !== 'Default order') {
        const totalsByCat = xCategories.map((_, catIdx) => {
            let total = 0;
            // Use the first measure as the sort key. If multiple, that's the
            // "primary" one. Mixed units (eg $ + %) make summing meaningless.
            const yIdx = 0;
            for (let s = 0; s < sliceNames.length; s++) {
                total += data[yIdx]?.[s]?.[catIdx] ?? 0;
            }
            return total;
        });
        const order = xCategories.map((_, i) => i);
        if (sortBy === 'Descending by value') {
            order.sort((a, b) => totalsByCat[b] - totalsByCat[a]);
        } else if (sortBy === 'Ascending by value') {
            order.sort((a, b) => totalsByCat[a] - totalsByCat[b]);
        } else {
            // Alphabetical (natural)
            order.sort((a, b) => naturalCompare(xCategories[a], xCategories[b]));
        }
        xCategories = order.map(i => xCategories[i]);
        data = data.map(perY => perY.map(perS => order.map(i => perS[i])));
    }

    // Build series: one per (measure, sliceValue). When no slice, sliceNames=[''] and the
    // series name is just the measure. When sliced, name depends on whether there's >1 measure.
    type SeriesSpec = { name: string; data: number[]; color: string; yColIdx: number; sliceIdx: number };
    const seriesSpecs: SeriesSpec[] = [];
    effectiveYColumns.forEach((yCol, yIdx) => {
        sliceNames.forEach((sliceName, sIdx) => {
            const isSliced = !!sliceColumn;
            const name = isSliced
                ? (effectiveYColumns.length > 1 ? `${yCol.name} — ${sliceName}` : sliceName)
                : yCol.name;
            const defaultColor = isSliced
                ? PALETTE[sIdx % PALETTE.length]
                : PALETTE[yIdx % PALETTE.length];
            const colorKey = isSliced
                ? `sliceColor_${sliceColumn!.id}_${sliceName}`
                : `measureColor_${yCol.id}`;
            const color = pickColor(visualProps[colorKey], defaultColor);
            seriesSpecs.push({
                name,
                data: data[yIdx][sIdx],
                color,
                yColIdx: yIdx,
                sliceIdx: sIdx,
            });
        });
    });

    const seriesNameToYIdx = new Map<string, number>();
    seriesSpecs.forEach(s => seriesNameToYIdx.set(s.name, s.yColIdx));

    const hidden = getHiddenSet(activeXCol.id);

    const stacking = stackingMode === 'Stacked' ? 'normal'
                   : stackingMode === '100% Stacked' ? 'percent'
                   : undefined;

    renderXButtons(xColumns, activeXColumnId, (columnId) => {
        activeXColumnId = columnId;
        render(ctx);
    });

    if (showLegend) {
        renderCustomLegend(
            seriesSpecs.map(s => ({ name: s.name, color: s.color })),
            hidden,
            (name) => {
                if (hidden.has(name)) hidden.delete(name);
                else hidden.add(name);
                render(ctx);
            },
        );
    } else {
        clearCustomLegend();
    }

    if (globalChartReference) {
        globalChartReference.destroy();
        globalChartReference = null;
    }

    globalChartReference = Highcharts.chart('chart', {
        chart: {
            type: 'column',
            marginLeft:   80,
            marginRight:  40,
            marginTop:    chartTitle ? 50 : 25,
            spacingBottom: 20,
            style: { fontFamily: 'Optimo-Plain, "Helvetica Neue", Helvetica, Arial, sans-serif' },
        },
        title: {
            text:  chartTitle,
            style: { fontWeight: 'bold', fontSize: '14px', color: '#1A1F2C' },
        },
        credits: { enabled: false },
        xAxis: {
            categories: xCategories,
            title: {
                text:  xAxisTitleProp.trim() ? xAxisTitleProp : activeXCol.name,
                style: { fontWeight: 'bold', color: '#555' },
            },
            labels: {
                // Highcharts auto-rotation: try horizontal first, then -30° if
                // labels would otherwise be cropped. Re-evaluated per render so
                // each x-axis selection gets the right treatment independently.
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
                formatter: function (this: any) {
                    return fmtAxis(this.value);
                },
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
            formatter: function (this: any) {
                const p = this.point as any;
                const seriesName = this.series.name;
                const color = this.series.color;
                const yIdx = seriesNameToYIdx.get(seriesName) ?? 0;
                return `<div style="border:1px solid ${color};border-radius:8px;background:#3A3F48;padding:12px;color:#FFFFFF;font-size:13px;">
                    <div style="font-weight:600;margin-bottom:6px;">${p.category}</div>
                    <div>${seriesName}:<br/><b>${fmtForMeasure(p.y, yIdx)}</b></div>
                </div>`;
            },
        },
        plotOptions: {
            column: {
                stickyTracking: false,
                borderWidth: 0,
                borderRadius: 0,
                pointPadding: 0.05,
                groupPadding: 0.12,
                stacking,
                dataLabels: {
                    enabled: showDataLabels,
                    style: { fontSize: '11px', fontWeight: '600', textOutline: 'none', color: '#333' },
                    formatter: function (this: any) {
                        if (this.y == null || this.y === 0) return '';
                        const yIdx = seriesNameToYIdx.get(this.series.name) ?? 0;
                        return fmtForMeasure(this.y, yIdx);
                    },
                },
            },
        },
        series: seriesSpecs.map(s => ({
            type:    'column',
            name:    s.name,
            data:    s.data,
            color:   s.color,
            visible: !hidden.has(s.name),
            showInLegend: false,
        })),
    });

    adjustButtonContainer(true);
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
            const attributeColumns = cols.filter(c => c.type === ColumnType.ATTRIBUTE);
            const measureColumns   = cols.filter(c => c.type === ColumnType.MEASURE);
            if (attributeColumns.length < 1 || measureColumns.length < 1) {
                throw new Error('Need at least 1 attribute (x-axis option) and 1 measure.');
            }
            return [{
                key: 'main',
                dimensions: [
                    { key: 'xOptions',      columns: [attributeColumns[0]] },
                    { key: 'y',             columns: [measureColumns[0]]   },
                    { key: 'formulaInputs', columns: []                    },
                    { key: 'slice',         columns: []                    },
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
            label:           'Multi Axis Bar Chart',
            descriptionText: 'Each attribute in "X-axis options" becomes a button; clicking it switches the x-axis. Top = default. Add measures for the y-axis (rendered as bars) and/or formula inputs (referenced by formulas in settings). Optional slice attribute colours the bars.',
            columnSections: [
                {
                    key:                   'xOptions',
                    label:                 'X-axis options (top = default; buttons switch)',
                    allowAttributeColumns: true,
                    allowMeasureColumns:   false,
                    allowTimeSeriesColumns: true,
                    maxColumnCount:        8,
                },
                {
                    key:                   'y',
                    label:                 'Measures (Y-axis bars)',
                    allowAttributeColumns: false,
                    allowMeasureColumns:   true,
                    maxColumnCount:        10,
                },
                {
                    key:                   'formulaInputs',
                    label:                 'Formula inputs (referenced by formulas in settings; not rendered as bars)',
                    allowAttributeColumns: false,
                    allowMeasureColumns:   true,
                    maxColumnCount:        20,
                },
                {
                    key:                   'slice',
                    label:                 'Slice with colour (optional)',
                    allowAttributeColumns: true,
                    allowMeasureColumns:   false,
                    maxColumnCount:        1,
                },
            ],
        }],
        visualPropEditorDefinition: (chartModel: ChartModel) => {
            const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
            const yCols    = dims.find(d => d.key === 'y')?.columns ?? [];
            const sliceCol = dims.find(d => d.key === 'slice')?.columns?.[0];

            const measureColorPickers: any[] = [];
            const measurePercentToggles: any[] = [];
            yCols.forEach((col, i) => {
                measureColorPickers.push({
                    key:          `measureColor_${col.id}`,
                    type:         'colorpicker' as const,
                    defaultValue: PALETTE[i % PALETTE.length],
                    label:        `Colour: ${col.name}`,
                });
                measurePercentToggles.push({
                    key:          `measureAsPercent_${col.id}`,
                    type:         'checkbox' as const,
                    defaultValue: detectPercentByName(col.name),
                    label:        `Format "${col.name}" as %`,
                });
            });

            // Formula editor: up to 4 (name, formula) pairs. Each formula can
            // reference any measure in the "Y-axis" or "Formula inputs" column
            // sections by name, e.g.:
            //   Renewed ARR Closed Won / (Up for Renewal ARR Converted - Open Renewal ARR Converted)
            // Component sums are computed per (x-category, slice) bucket, then
            // the expression is evaluated. Names with operators (+ - / * ( )) must
            // be bracketed: [My Measure - test].
            const formulaInputCols = dims.find(d => d.key === 'formulaInputs')?.columns ?? [];
            const referenceableMeasures = [...yCols, ...formulaInputCols].map(c => c.name);
            const formulaHint = referenceableMeasures.length > 0
                ? `Reference any of: ${referenceableMeasures.join(', ')}`
                : 'Add measures to "Y-axis" or "Formula inputs" first.';
            const formulaSettings: any[] = [];
            for (let i = 1; i <= MAX_FORMULAS; i++) {
                formulaSettings.push(
                    { key: `formula${i}Name`, type: 'text', defaultValue: '', label: `Formula ${i} — name (blank = unused)` },
                    { key: `formula${i}Expr`, type: 'text', defaultValue: '', label: `Formula ${i} — expression. ${formulaHint}` },
                );
            }
            const formulaColorPickers: any[] = [];
            for (let i = 1; i <= MAX_FORMULAS; i++) {
                formulaColorPickers.push({
                    key:          `measureColor_formula_${i - 1}`,
                    type:         'colorpicker' as const,
                    defaultValue: PALETTE[(yCols.length + i - 1) % PALETTE.length],
                    label:        `Colour: Formula ${i} (if used)`,
                });
            }

            const sliceColorPickers: any[] = [];
            if (sliceCol) {
                const dataArr = chartModel.data?.[chartModel.data.length - 1]?.data;
                if (dataArr) {
                    const sliceColIdx = dataArr.columns.indexOf(sliceCol.id);
                    if (sliceColIdx >= 0) {
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
                                defaultValue: PALETTE[i % PALETTE.length],
                                label:        `${sliceCol.name} — ${s}`,
                            });
                        });
                    }
                }
            }

            return {
                elements: [
                    { key: 'chartTitle',     type: 'text',     defaultValue: ' ',                       label: 'Chart title' },
                    { key: 'xAxisTitle',     type: 'text',     defaultValue: ' ',                       label: 'X-axis title (blank = column name)' },
                    { key: 'yAxisTitle',     type: 'text',     defaultValue: ' ',                       label: 'Y-axis title (blank = measure name)' },
                    { key: 'numberFormat',   type: 'text',     defaultValue: '0,0.[0]a',                label: 'Number format' },
                    { key: 'currency',       type: 'dropdown', defaultValue: 'None',                    values: CURRENCY_OPTIONS, label: 'Currency symbol (labels only, not axis)' },
                    { key: 'stackingMode',   type: 'dropdown', defaultValue: 'None',                    values: STACKING_OPTIONS, label: 'Stacking' },
                    { key: 'showDataLabels', type: 'checkbox', defaultValue: false,                     label: 'Show data labels on bars' },
                    { key: 'showLegend',     type: 'checkbox', defaultValue: true,                      label: 'Show legend' },
                    { key: 'showGridLines',  type: 'checkbox', defaultValue: true,                      label: 'Show grid lines' },
                    { key: 'sortBy',         type: 'dropdown', defaultValue: 'Descending by value',     values: SORT_OPTIONS, label: 'Sort x-axis by' },
                    { key: 'excludeNulls',   type: 'checkbox', defaultValue: true,                      label: 'Exclude null values (x-axis & slice)' },
                    ...formulaSettings,
                    ...measurePercentToggles,
                    ...measureColorPickers,
                    ...formulaColorPickers,
                    ...sliceColorPickers,
                ],
            };
        },
    });

    renderChart(ctx);
})();
