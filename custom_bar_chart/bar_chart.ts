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
    getCustomCalendarGuidFromColumn,
    AxisMenuActions,
    ColumnProp,
    AppConfig,
} from '@thoughtspot/ts-chart-sdk';
import Highcharts from 'highcharts';
import {
    generateMapOptions,
    getDataFormatter,
} from '@thoughtspot/ts-chart-sdk';
import numeral from 'numeral';
import * as _ from 'lodash';
import HighchartsCustomEvents from 'highcharts-custom-events';

HighchartsCustomEvents(Highcharts);

interface VisualProps {
    numberFormat?: string;
    DatalabelsToggle?: boolean;
}

let appConfigGlobal: AppConfig;

// Utility function to format numbers
function formatNumber(value: number, format: string): string {
    try {
        return numeral(value).format(format).replace('k', 'K').replace('m', 'M').replace('b', 'B');
    } catch (error) {
        console.error("Error formatting number:", error);
        return value.toString();
    }
}

function getDataForColumn(column: ChartColumn, dataArr: DataPointsArray) {
    const formatter = getDataFormatter(column, { isMillisIncluded: false });
    const idx = _.findIndex(dataArr.columns, (colId) => column.id === colId);
    const dataForCol = _.map(dataArr.dataValue, (row) => {
        const colValue = row[idx];
        return colValue;
    });
    const options = generateMapOptions(appConfigGlobal, column, dataForCol);
    const formattedValuesForData = _.map(dataArr.dataValue, (row) => {
        const colValue = row[idx];
        if (getCustomCalendarGuidFromColumn(column))
            return formatter(colValue.v.s, options);
        return formatter(colValue, options);
    });

    return formattedValuesForData;
}

// ✅ Look up dimensions by key name, not position
function getDimensionByKey(chartModel: ChartModel, key: string) {
    return chartModel.config?.chartConfig?.[0]?.dimensions?.find(d => d.key === key);
}

// Extract data from ThoughtSpot ChartModel
function getDataModel(chartModel: ChartModel, selectedMeasureId: string) {
    const dataArr = chartModel.data?.[chartModel.data?.length - 1]?.data ?? { columns: [], dataValue: [] };

    const measureColumn = chartModel.columns.find(col => col.id === selectedMeasureId);
    if (!measureColumn) {
        console.error('Selected measure not found.');
        return { xAxisLabels: [], seriesData: [] };
    }

    // ✅ Look up by key, not hardcoded index
    const xAxisDimension = getDimensionByKey(chartModel, 'x');
    const sliceByDimension = getDimensionByKey(chartModel, 'sliceBy');

    const xAxisColumn = xAxisDimension?.columns?.[0];
    const sliceByColumn = sliceByDimension?.columns?.[0];

    if (!xAxisColumn) {
        console.error('X-axis column is undefined.');
        return { xAxisLabels: [], seriesData: [] };
    }

    const xAxisLabels = _.uniq(getDataForColumn(xAxisColumn, dataArr));
    const sliceByValues = sliceByColumn
        ? _.uniq(getDataForColumn(sliceByColumn, dataArr))
        : ['Default'];

    const xAxisFormattedValues = getDataForColumn(xAxisColumn, dataArr);
    const sliceByFormattedValues = sliceByColumn
        ? getDataForColumn(sliceByColumn, dataArr)
        : [];

    const seriesData = sliceByValues.map(slice => ({
        name: slice,
        data: xAxisLabels.map(label => {
            const index = xAxisFormattedValues.findIndex((formattedLabel, idx) =>
                formattedLabel === label &&
                (sliceByColumn ? sliceByFormattedValues[idx] === slice : true)
            );
            if (index === -1) return 0;
            const row = dataArr.dataValue[index];
            return row
                ? parseFloat(row[dataArr.columns.indexOf(measureColumn.id)]) || 0
                : 0;
        }),
    }));

    return { xAxisLabels, seriesData };
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
    appConfigGlobal = ctx.getAppConfig();
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

    // ✅ Look up by key
    const xAxisDimension = getDimensionByKey(chartModel, 'x');
    const sliceByDimension = getDimensionByKey(chartModel, 'sliceBy');

    const xAxisColumn = xAxisDimension?.columns?.[0];
    const sliceByColumn = sliceByDimension?.columns?.[0];

    const xAxisTitle = xAxisColumn ? xAxisColumn.name : 'Categories';
    const sliceByColumnName = sliceByColumn ? sliceByColumn.name : 'Category Group';

    createMeasureButtons(chartModel, (newMeasure) => render(ctx, newMeasure), firstMeasure);

    const dataModel = getDataModel(chartModel, firstMeasure);
    const numberFormat = (chartModel.visualProps as any)?.numberFormat || '0.[0]a';

    Highcharts.chart({
        chart: {
            renderTo: 'chart',
            type: 'column',
            height: window.innerHeight * 0.9,
            events: {
                load: function () {
                    const chartInstance = this;

                    chartInstance.container.addEventListener('contextmenu', function (event) {
                        event.preventDefault();

                        const pointerEvent = chartInstance.pointer.normalize(event);
                        let clickedPoint: any = null;

                        chartInstance.series.forEach((series) => {
                            series.points.forEach((point) => {
                                if (point.graphic && point.graphic.element === event.target) {
                                    clickedPoint = point;
                                }
                            });
                        });

                        if (clickedPoint) {
                            // ✅ Look up by key
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
            title: {
                text: xAxisTitle,
                style: { fontWeight: 'bold' },
                events: {
                    click: function (e) {
                        // ✅ Look up by key
                        const columnIds = getDimensionByKey(chartModel, 'x')?.columns.map(col => col.id) || [];
                        ctx.emitEvent(ChartToTSEvent.OpenAxisMenu, {
                            columnIds,
                            event: { clientX: e.clientX, clientY: e.clientY },
                            selectedActions: AxisMenuActions[this.value],
                        });
                    },
                },
            } as any,
            gridLineWidth: 0,
            minorGridLineWidth: 0,
            lineWidth: 0,
        },
        yAxis: {
            min: 0,
            gridLineWidth: 0,
            title: {
                text: selectedMeasureName,
                style: { fontWeight: 'bold' },
                events: {
                    click: function (e) {
                        // ✅ Look up by key
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
            enabled: true,
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
                    ${xAxisName}:</b><br> ${xValue}<br><br>
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
        },
        series: dataModel.seriesData.map(series => ({
            ...series,
            type: 'column'
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
    const ctx = await getChartContext({
        getDefaultChartConfig: (chartModel: ChartModel) => {
            const cols = chartModel.columns;
            const attributeColumns = cols.filter(col => col.type === ColumnType.ATTRIBUTE);
            // ✅ No cap on measures
            const measureColumns = cols.filter(col => col.type === ColumnType.MEASURE);
            // ✅ All remaining attributes available for slice by
            const sliceByColumns = attributeColumns.slice(1);

            if (attributeColumns.length < 1 || measureColumns.length < 1) {
                throw new Error('Insufficient attributes or measures for the chart.');
            }

            return [
                {
                    key: 'column',
                    dimensions: [
                        { key: 'x', columns: [attributeColumns[0]] },
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
                        // ✅ No maxColumnCount — unlimited measures
                    },
                    {
                        key: 'color-axis',
                        label: 'Slice By Color',
                        allowAttributeColumns: true,
                        allowMeasureColumns: false,
                        allowTimeSeriesColumns: false,
                        // ✅ No maxColumnCount — unlimited slice by columns
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
})();
