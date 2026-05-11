import {
    ChartToTSEvent,
    ColumnType,
    getChartContext,
    CustomChartContext,
    ChartModel,
    ChartConfig,
    DataPointsArray,
    Query,
    ChartColumn,
    AxisMenuActions,
} from '@thoughtspot/ts-chart-sdk';
import Highcharts from 'highcharts';
import HighchartsMore from 'highcharts/highcharts-more';
import numeral from 'numeral';
import * as _ from 'lodash';
import HighchartsCustomEvents from 'highcharts-custom-events';

HighchartsMore(Highcharts);
HighchartsCustomEvents(Highcharts);

interface VisualProps {
    numberFormat?: string;
    DatalabelsToggle?: boolean;
}

// Utility function to format numbers
function formatNumber(value: number, format: string): string {
    try {
        return numeral(value).format(format).replace('k', 'K').replace('m', 'M').replace('b', 'B');
    } catch (error) {
        console.error("Error formatting number:", error);
        return value.toString();
    }
}

// Simple data extractor — no internal SDK utils needed
function getDataForColumn(column: ChartColumn, dataArr: DataPointsArray) {
    const idx = _.findIndex(dataArr.columns, (colId) => column.id === colId);
    return _.map(dataArr.dataValue, (row) => {
        const val = row[idx];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object' && val.v) return String(val.v.s ?? val.v);
        return String(val);
    });
}

// ✅ Look up dimensions by key name, not position
function getDimensionByKey(chartModel: ChartModel, key: string) {
    return chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === key);
}

const SLICE_KEY_SEPARATOR = ' | ';

// Extract data from ThoughtSpot ChartModel
function getDataModel(chartModel: ChartModel, selectedMeasureId: string) {
    const dataArr = chartModel.data?.[chartModel.data?.length - 1]?.data ?? { columns: [], dataValue: [] };

    const xAxisColumn = getDimensionByKey(chartModel, 'x')?.columns?.[0];
    const sliceByColumns = getDimensionByKey(chartModel, 'sliceBy')?.columns ?? [];

    // Measures-only mode: render as a waterfall.
    // First measure = START (raw value, gray pill), middle measures = floating deltas,
    // last measure = END (auto-summed via isSum, gray pill).
    if (!xAxisColumn) {
        const yColumns = getDimensionByKey(chartModel, 'y')?.columns || [];

        const measureValues = yColumns.map(measureCol => {
            const colIdx = dataArr.columns.indexOf(measureCol.id);
            if (colIdx < 0) return 0;
            return dataArr.dataValue.reduce(
                (sum, row) => sum + (parseFloat(row[colIdx]) || 0),
                0,
            );
        });

        const lastIdx = yColumns.length - 1;
        const startValue = measureValues[0] ?? 0;
        const endValue = measureValues
            .slice(0, Math.max(lastIdx, 0))
            .reduce((s, v) => s + v, 0);

        const xAxisLabels = yColumns.map((col, i) => {
            if (i === 0) return '__START__';
            if (i === lastIdx && yColumns.length > 1) return '__END__';
            return col.name;
        });

        const waterfallPoints = yColumns.map((col, i) => {
            if (i === lastIdx && yColumns.length > 1) {
                return { name: col.name, isSum: true, color: '#9CA3AF', borderRadius: 30 };
            }
            if (i === 0) {
                return { name: col.name, y: measureValues[i], color: '#9CA3AF', borderRadius: 30 };
            }
            return { name: col.name, y: measureValues[i] };
        });

        const seriesData = [{
            name: 'Waterfall',
            type: 'waterfall' as const,
            data: waterfallPoints,
            upColor: '#7CB5EC',
            color: '#F45B5B',
        }];
        return {
            xAxisLabels,
            seriesData,
            isWaterfall: true,
            startValue,
            endValue,
            startName: yColumns[0]?.name ?? '',
            endName: yColumns[lastIdx]?.name ?? '',
            lastIdx,
        };
    }

    const measureColumn = chartModel.columns.find(col => col.id === selectedMeasureId);
    if (!measureColumn) {
        console.error('Selected measure not found.');
        return { xAxisLabels: [], seriesData: [] };
    }

    const xAxisLabels = _.uniq(getDataForColumn(xAxisColumn, dataArr));
    const xAxisFormattedValues = getDataForColumn(xAxisColumn, dataArr);

    // Combine all slice-by columns row-by-row into a single compound key
    const sliceByPerColumn = sliceByColumns.map(col => getDataForColumn(col, dataArr));
    const sliceByCombined = sliceByColumns.length > 0
        ? xAxisFormattedValues.map((_label, rowIdx) =>
            sliceByPerColumn.map(values => values[rowIdx]).join(SLICE_KEY_SEPARATOR))
        : [];

    const sliceByValues = sliceByColumns.length > 0
        ? _.uniq(sliceByCombined)
        : ['Default'];

    const seriesData = sliceByValues.map(slice => ({
        name: slice,
        data: xAxisLabels.map(label => {
            const index = xAxisFormattedValues.findIndex((formattedLabel, idx) =>
                formattedLabel === label &&
                (sliceByColumns.length > 0 ? sliceByCombined[idx] === slice : true)
            );
            if (index === -1) return 0;
            const row = dataArr.dataValue[index];
            return row
                ? parseFloat(row[dataArr.columns.indexOf(measureColumn.id)]) || 0
                : 0;
        }),
    }));

    return { xAxisLabels, seriesData, isWaterfall: false };
}

// ✅ All measure columns, no cap
function getMeasureColumns(chartModel: ChartModel) {
    return chartModel.columns.filter(col => col.type === ColumnType.MEASURE);
}

function createMeasureButtons(
    chartModel: ChartModel,
    updateChart: (selectedMeasure: string) => void,
    selectedMeasure?: string
) {
    const measureContainer = document.getElementById('buttonContainer');

    if (!measureContainer) {
        console.error("❌ Error: 'buttonContainer' container not found.");
        return;
    }

    measureContainer.innerHTML = '';

    const measureColumns = getMeasureColumns(chartModel);
    const defaultMeasure = selectedMeasure || measureColumns[0]?.id;

    measureColumns.forEach((measure) => {
        const button = document.createElement('button');
        button.innerText = measure.name;
        button.classList.add('measure-button');

        if (measure.id === defaultMeasure) {
            button.classList.add('active-measure');
        }

        button.onclick = () => {
            document.querySelectorAll('.measure-button').forEach(btn => btn.classList.remove('active-measure'));
            button.classList.add('active-measure');
            updateChart(measure.id);
        };

        measureContainer.appendChild(button);
    });
}

function render(ctx: CustomChartContext, selectedMeasure?: string) {
    const chartModel = ctx.getChartModel();
    const measureColumns = getMeasureColumns(chartModel);
    const visualProps = chartModel.visualProps as VisualProps;
    const datalablestoggle = visualProps?.DatalabelsToggle ?? true;

    if (measureColumns.length === 0) {
        console.warn('No measure columns available.');
        return;
    }

    const firstMeasure = selectedMeasure || measureColumns[0]?.id;
    const selectedMeasureColumn = measureColumns.find(m => m.id === firstMeasure);
    const selectedMeasureName = selectedMeasureColumn ? selectedMeasureColumn.name : 'Measure';

    const xAxisColumn = getDimensionByKey(chartModel, 'x')?.columns?.[0];
    const sliceByColumns = getDimensionByKey(chartModel, 'sliceBy')?.columns ?? [];
    const measuresOnlyMode = !xAxisColumn;

    const xAxisTitle = xAxisColumn ? xAxisColumn.name : 'Measure';
    const yAxisTitle = measuresOnlyMode ? 'Value' : selectedMeasureName;
    const sliceByColumnName = sliceByColumns.length > 0
        ? sliceByColumns.map(c => c.name).join(' / ')
        : 'Category Group';

    if (measuresOnlyMode) {
        const measureContainer = document.getElementById('buttonContainer');
        if (measureContainer) measureContainer.innerHTML = '';
    } else {
        createMeasureButtons(chartModel, (newMeasure) => render(ctx, newMeasure), firstMeasure);
    }

    const dataModel = getDataModel(chartModel, firstMeasure);
    const numberFormat = (chartModel.visualProps as any)?.numberFormat || '0.[0]a';

    const chartType: 'waterfall' | 'column' = dataModel.isWaterfall ? 'waterfall' : 'column';

    Highcharts.chart({
        chart: {
            renderTo: 'chart',
            type: chartType,
            height: window.innerHeight * 0.9,
            events: {
                load: function () {
                    const chartInstance = this;

                    chartInstance.container.addEventListener('contextmenu', function (event) {
                        event.preventDefault();

                        let clickedPoint: any = null;

                        chartInstance.series.forEach((series) => {
                            series.points.forEach((point) => {
                                if (point.graphic && point.graphic.element === event.target) {
                                    clickedPoint = point;
                                }
                            });
                        });

                        if (clickedPoint) {
                            const xAxisCol = getDimensionByKey(chartModel, 'x')?.columns?.[0];
                            const measureCols = getDimensionByKey(chartModel, 'y')?.columns || [];
                            const measureCol = measureCols[0];

                            ctx.emitEvent(ChartToTSEvent.OpenContextMenu, {
                                event: {
                                    clientX: event.clientX,
                                    clientY: event.clientY,
                                },
                                clickedPoint: {
                                    tuple: [
                                        {
                                            columnId: xAxisCol?.id ?? '',
                                            value: clickedPoint?.category || clickedPoint?.name,
                                        },
                                        {
                                            columnId: measureCol?.id ?? '',
                                            value: clickedPoint?.y,
                                        },
                                    ],
                                },
                            });
                        }
                    });
                },
            },
        },
        title: { text: '' },
        xAxis: {
            categories: dataModel.xAxisLabels,
            title: dataModel.isWaterfall
                ? { text: '' }
                : ({
                    text: xAxisTitle,
                    style: { fontWeight: 'bold' },
                    events: {
                        click: function (e) {
                            const columnIds = getDimensionByKey(chartModel, 'x')?.columns.map(col => col.id) || [];
                            ctx.emitEvent(ChartToTSEvent.OpenAxisMenu, {
                                columnIds,
                                event: { clientX: e.clientX, clientY: e.clientY },
                                selectedActions: AxisMenuActions[this.value],
                            });
                        },
                    },
                } as any),
            gridLineWidth: 0,
            minorGridLineWidth: 0,
            lineWidth: 0,
            labels: dataModel.isWaterfall
                ? {
                    useHTML: true,
                    rotation: 0,
                    style: { fontSize: '11px', color: '#4B5563' },
                    formatter: function () {
                        const text = String(this.value);
                        if (text === '__START__') {
                            return `<div style="text-align:center"><div style="color:#9CA3AF;font-size:10px;font-weight:bold;letter-spacing:1px">START</div><div style="color:#9CA3AF;font-weight:bold;font-size:13px">${formatNumber(dataModel.startValue ?? 0, numberFormat)}</div></div>`;
                        }
                        if (text === '__END__') {
                            return `<div style="text-align:center"><div style="color:#9CA3AF;font-size:10px;font-weight:bold;letter-spacing:1px">END</div><div style="color:#9CA3AF;font-weight:bold;font-size:13px">${formatNumber(dataModel.endValue ?? 0, numberFormat)}</div></div>`;
                        }
                        return `<div style="text-align:center;font-size:11px;color:#1F2937">${text}</div>`;
                    },
                }
                : undefined,
        },
        yAxis: {
            min: dataModel.isWaterfall ? undefined : 0,
            gridLineWidth: dataModel.isWaterfall ? 1 : 0,
            gridLineColor: '#E5E7EB',
            gridLineDashStyle: 'Dot',
            title: {
                text: yAxisTitle,
                style: { fontWeight: 'bold' },
                events: {
                    click: function (e) {
                        const columnIds = getDimensionByKey(chartModel, 'y')?.columns.map(col => col.id) || [];
                        ctx.emitEvent(ChartToTSEvent.OpenAxisMenu, {
                            columnIds,
                            event: { clientX: e.clientX, clientY: e.clientY },
                            selectedActions: AxisMenuActions[this.value],
                        });
                    },
                },
            } as any,
            labels: {
                formatter: function () {
                    return formatNumber(this.value as number, numberFormat);
                },
            },
        },
        legend: {
            enabled: !dataModel.isWaterfall,
            align: 'center',
            layout: 'horizontal',
            verticalAlign: 'top',
            itemMarginBottom: 5,
            floating: true,
            x: 0,
            title: {
                text: sliceByColumnName,
            },
        },
        credits: { enabled: false },
        tooltip: {
            followPointer: true,
            padding: 10,
            shadow: true,
            backgroundColor: '#3A3F48',
            borderColor: '#808080',
            borderRadius: 4,
            borderWidth: 1,
            style: {
                color: '#FFFFFF',
                fontSize: '12px',
                fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
                fontWeight: 'normal',
                textAlign: 'left',
            },
            useHTML: true,
            formatter: function () {
                const point = this;
                const series = this.series;
                const chart = series.chart;

                const xAxis = Array.isArray(chart.options.xAxis) ? chart.options.xAxis[0] : chart.options.xAxis;
                const yAxis = Array.isArray(chart.options.yAxis) ? chart.options.yAxis[0] : chart.options.yAxis;

                const xAxisName = xAxis?.title?.text || "X-Axis";
                const yAxisName = yAxis?.title?.text || "Measure";
                const xValue = point.key || 'N/A';

                return `
                    <b>${xAxisName}:</b><br> ${xValue}<br><br>
                    <b>${yAxisName}:</b><br> ${formatNumber(point.y || 0, numberFormat)}
                `;
            },
        },
        plotOptions: {
            column: {
                grouping: true,
                pointPadding: 0.1,
                groupPadding: 0.275,
                pointWidth: 20,
                dataLabels: {
                    enabled: datalablestoggle,
                    formatter: function () {
                        return formatNumber(this.y, numberFormat);
                    },
                },
                borderWidth: 0,
            },
            waterfall: {
                pointPadding: 0.05,
                borderRadius: 8,
                borderWidth: 0,
                lineWidth: 2,
                lineColor: '#9CA3AF',
                dashStyle: 'Dot',
                dataLabels: {
                    enabled: datalablestoggle,
                    inside: true,
                    color: '#FFFFFF',
                    style: {
                        textOutline: 'none',
                        fontWeight: 'bold',
                        fontSize: '12px',
                    },
                    formatter: function () {
                        const p = this.point as any;
                        if (p.isSum || p.isIntermediateSum) {
                            return formatNumber(p.y, numberFormat);
                        }
                        if (p.x === 0) {
                            return formatNumber(this.y as number, numberFormat);
                        }
                        const value = this.y as number;
                        const sign = value > 0 ? '+' : '';
                        return sign + formatNumber(value, numberFormat);
                    },
                },
            },
        },
        series: dataModel.seriesData.map(series => ({
            type: chartType,
            ...series,
        })) as Highcharts.SeriesOptionsType[],
    });
}

const renderChart = async (ctx: CustomChartContext) => {
    try {
        ctx.emitEvent(ChartToTSEvent.RenderStart);
        render(ctx);
    } catch (error) {
        console.error('Error during render:', error);
    } finally {
        ctx.emitEvent(ChartToTSEvent.RenderComplete);
    }
};

(async () => {
    try {
        const ctx = await getChartContext({
            getDefaultChartConfig: (chartModel: ChartModel) => {
                const cols = chartModel.columns;
                const attributeColumns = cols.filter(col => col.type === ColumnType.ATTRIBUTE);
                const measureColumns = cols.filter(col => col.type === ColumnType.MEASURE);
                const xColumns = attributeColumns.length > 0 ? [attributeColumns[0]] : [];
                const sliceByColumns = attributeColumns.slice(1);

                if (measureColumns.length < 1) {
                    throw new Error('At least one measure is required for the chart.');
                }

                return [
                    {
                        key: 'column',
                        dimensions: [
                            { key: 'x', columns: xColumns },
                            { key: 'y', columns: measureColumns },
                            { key: 'sliceBy', columns: sliceByColumns },
                        ],
                    },
                ];
            },
            getQueriesFromChartConfig: (chartConfig: ChartConfig[]) => {
                return chartConfig.map(config =>
                    config.dimensions.reduce(
                        (acc: Query, dimension) => ({
                            queryColumns: [...acc.queryColumns, ...dimension.columns],
                        }),
                        { queryColumns: [] } as Query
                    )
                );
            },
            renderChart,
            chartConfigEditorDefinition: [
                {
                    key: 'column',
                    label: 'Column Chart Configuration',
                    descriptionText: 'Configure the X-axis and Measures for your chart.',
                    columnSections: [
                        {
                            key: 'x',
                            label: 'X-Axis (Category)',
                            allowAttributeColumns: true,
                            allowMeasureColumns: false,
                            allowTimeSeriesColumns: true,
                            maxColumnCount: 1,
                        },
                        {
                            key: 'y',
                            label: 'Measure (Y-Axis)',
                            allowAttributeColumns: false,
                            allowMeasureColumns: true,
                        },
                        {
                            key: 'sliceBy',
                            label: 'Slice By Color',
                            allowAttributeColumns: true,
                            allowMeasureColumns: false,
                            allowTimeSeriesColumns: false,
                        }
                    ],
                },
            ],
            visualPropEditorDefinition: {
                elements: [
                    {
                        key: 'numberFormat',
                        type: 'text',
                        defaultValue: '0.[0]a',
                        label: 'Number Format',
                    },
                    {
                        key: 'DatalabelsToggle',
                        type: 'checkbox',
                        defaultValue: true,
                        label: 'Column Total Labels',
                    },
                ],
            },
        });

        renderChart(ctx);
    } catch (err) {
        console.error('Failed to initialize ThoughtSpot chart context:', err);
    }
})();
