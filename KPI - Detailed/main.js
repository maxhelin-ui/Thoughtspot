import {
  ChartToTSEvent,
  ColumnType,
  getChartContext,
} from '@thoughtspot/ts-chart-sdk';
import _ from 'lodash';
import numeral from 'numeral';

/**
 * KPI - Detailed
 *
 * A single configurable BYOC chart that can be styled as any of the three
 * "detail" cards from the renewals dashboard:
 *
 *   1. Single-stat card — e.g. "Renewal uplift" or "Indexation"
 *   2. Split two-stat card — e.g. "Multi-year vs Single-year"
 *
 * Data binding (chart config -> "column" section):
 *   - Primary value     (measure, required)       big number on the left/single side
 *   - Primary percent   (measure, optional)       0-1 or 0-100, drives left/single bar
 *   - Secondary value   (measure, optional)       big number on the right (split only)
 *   - Secondary percent (measure, optional)       0-1 or 0-100, drives right bar
 *   - Footer metric 1   (measure, optional)       small tile, bottom-left
 *   - Footer metric 2   (measure, optional)       small tile, bottom-right
 *
 * All labels, colors, icon, mode (single vs split) and number formatting are
 * controlled through the visual prop editor.
 */

// ---------- formatting helpers ----------

function formatNumber(value, format, currency) {
  if (value == null || isNaN(value)) return '';
  const fmt = format || '0,0.[00]';
  const abs = Math.abs(value);
  let out;
  if (abs >= 1e9) {
    out = numeral(value / 1e9).format(fmt) + 'B';
  } else if (abs >= 1e6) {
    out = numeral(value / 1e6).format(fmt) + 'M';
  } else if (abs >= 1e3) {
    out = numeral(value / 1e3).format(fmt) + 'K';
  } else {
    out = numeral(value).format(fmt);
  }
  return (currency || '') + out;
}

function formatPercent(value) {
  if (value == null || isNaN(value)) return '';
  // Accept either fractions (0-1) or already-scaled percents (0-100).
  const pct = Math.abs(value) <= 1 ? value * 100 : value;
  return numeral(pct).format('0') + '%';
}

function clampPercentFill(value) {
  if (value == null || isNaN(value)) return 0;
  const pct = Math.abs(value) <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, pct));
}

// ---------- data access ----------

function getDataForColumn(column, dataArr) {
  if (!column || !dataArr) return [];
  const idx = _.findIndex(dataArr.columns, (colId) => column.id === colId);
  if (idx === -1) return [];
  return _.map(dataArr.dataValue, (row) => row[idx]);
}

function sumForKey(chartModel, key) {
  const dataArr = chartModel.data?.[0]?.data ?? null;
  if (!dataArr) return null;
  const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
  const dim = dims.find((d) => d.key === key);
  const col = dim?.columns?.[0];
  if (!col) return null;
  const values = getDataForColumn(col, dataArr);
  if (!values.length) return null;
  // Single-row aggregates are common; multi-row sums fall back to a sum.
  return values.length === 1 ? values[0] : _.sum(values);
}

// ---------- rendering ----------

function applyCardStyles(vp) {
  const root = document.documentElement;
  if (vp.primaryAccentColor) root.style.setProperty('--ts-accent', vp.primaryAccentColor);
  if (vp.primaryBarColor) root.style.setProperty('--ts-accent-bar', vp.primaryBarColor);
  if (vp.secondaryAccentColor) root.style.setProperty('--ts-secondary-accent', vp.secondaryAccentColor);
  if (vp.secondaryBarColor) root.style.setProperty('--ts-secondary-accent-bar', vp.secondaryBarColor);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text ?? '';
}

function setHidden(id, hidden) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('hidden', hidden);
}

function renderSingle(vp, values) {
  setHidden('singleLayout', false);
  setHidden('splitLayout', true);

  const formatted = vp.primaryAsNumber
    ? formatNumber(values.primaryValue, vp.numberFormat, vp.currencySymbol)
    : (values.primaryValue == null ? '' : String(Math.round(values.primaryValue)));

  setText('singleValue', formatted);
  setText('singleSuffix', vp.primarySuffix || '');
  setText('singleDescription', vp.primaryDescription || '');
  setText('singleFooter', vp.primaryFooter || '');
  setText('singlePercent', formatPercent(values.primaryPercent));

  const fill = document.getElementById('singleBarFill');
  if (fill) fill.style.width = clampPercentFill(values.primaryPercent) + '%';
  const label = document.getElementById('singlePercent');
  if (label) label.style.color = 'var(--ts-accent)';
  if (fill) fill.style.background = 'var(--ts-accent-bar)';
}

function renderSplit(vp, values) {
  setHidden('singleLayout', true);
  setHidden('splitLayout', false);

  const fmt = (v) => vp.primaryAsNumber
    ? formatNumber(v, vp.numberFormat, vp.currencySymbol)
    : (v == null ? '' : String(Math.round(v)));

  setText('leftLabel', vp.leftLabel || '');
  setText('leftValue', fmt(values.primaryValue));
  setText('leftSuffix', vp.primarySuffix || '');
  setText('leftPercent', formatPercent(values.primaryPercent));
  const leftFill = document.getElementById('leftBarFill');
  if (leftFill) {
    leftFill.style.width = clampPercentFill(values.primaryPercent) + '%';
    leftFill.style.background = 'var(--ts-accent-bar)';
  }
  const leftLabel = document.getElementById('leftPercent');
  if (leftLabel) leftLabel.style.color = 'var(--ts-accent)';

  setText('rightLabel', vp.rightLabel || '');
  setText('rightValue', fmt(values.secondaryValue));
  setText('rightSuffix', vp.secondarySuffix || vp.primarySuffix || '');
  setText('rightPercent', formatPercent(values.secondaryPercent));
  const rightFill = document.getElementById('rightBarFill');
  if (rightFill) {
    rightFill.style.width = clampPercentFill(values.secondaryPercent) + '%';
    rightFill.style.background = 'var(--ts-secondary-accent-bar)';
  }
  const rightLabel = document.getElementById('rightPercent');
  if (rightLabel) rightLabel.style.color = 'var(--ts-secondary-accent)';
}

function renderFooterMetrics(vp, values) {
  const hasMetric1 = values.metric1 != null && (vp.metric1Label || '').trim() !== '';
  const hasMetric2 = values.metric2 != null && (vp.metric2Label || '').trim() !== '';
  const showAny = hasMetric1 || hasMetric2;
  setHidden('footerMetrics', !showAny);

  setText('metric1Label', vp.metric1Label || '');
  setText('metric1Value', hasMetric1
    ? formatNumber(values.metric1, vp.numberFormat, vp.currencySymbol)
    : '');

  setText('metric2Label', vp.metric2Label || '');
  setText('metric2Value', hasMetric2
    ? formatNumber(values.metric2, vp.numberFormat, vp.currencySymbol)
    : '');
}

function renderHeader(vp) {
  setText('cardTitle', vp.cardTitle || '');
  const iconEl = document.getElementById('cardIcon');
  if (iconEl) {
    iconEl.className = 'ti ' + (vp.iconClass || 'ti-trending-up');
    iconEl.classList.toggle('hidden', !vp.iconClass);
  }
}

function render(ctx) {
  return ctx.getChartModel().then((chartModel) => {
    const vp = chartModel.visualProps || {};
    applyCardStyles(vp);

    const values = {
      primaryValue: sumForKey(chartModel, 'primaryValue'),
      primaryPercent: sumForKey(chartModel, 'primaryPercent'),
      secondaryValue: sumForKey(chartModel, 'secondaryValue'),
      secondaryPercent: sumForKey(chartModel, 'secondaryPercent'),
      metric1: sumForKey(chartModel, 'metric1'),
      metric2: sumForKey(chartModel, 'metric2'),
    };

    renderHeader(vp);

    if ((vp.mode || 'single') === 'split') {
      renderSplit(vp, values);
    } else {
      renderSingle(vp, values);
    }

    renderFooterMetrics(vp, values);
  });
}

const renderChart = async (ctx) => {
  try {
    ctx.emitEvent(ChartToTSEvent.RenderStart);
    await render(ctx);
  } catch (e) {
    console.error('KPI - Detailed render error:', e);
    ctx.emitEvent(ChartToTSEvent.RenderError, { hasError: true, error: e });
  } finally {
    ctx.emitEvent(ChartToTSEvent.RenderComplete);
  }
};

(async () => {
  const ctx = await getChartContext({
    getDefaultChartConfig: (chartModel) => {
      const measureCols = _.filter(
        chartModel.columns,
        (col) => col.type === ColumnType.MEASURE,
      );
      return [
        {
          key: 'column',
          dimensions: [
            { key: 'primaryValue', columns: measureCols[0] ? [measureCols[0]] : [] },
            { key: 'primaryPercent', columns: measureCols[1] ? [measureCols[1]] : [] },
            { key: 'secondaryValue', columns: measureCols[2] ? [measureCols[2]] : [] },
            { key: 'secondaryPercent', columns: measureCols[3] ? [measureCols[3]] : [] },
            { key: 'metric1', columns: measureCols[4] ? [measureCols[4]] : [] },
            { key: 'metric2', columns: measureCols[5] ? [measureCols[5]] : [] },
          ],
        },
      ];
    },
    getQueriesFromChartConfig: (chartConfig) =>
      chartConfig.map((config) =>
        _.reduce(
          config.dimensions,
          (acc, dimension) => ({
            queryColumns: [...acc.queryColumns, ...dimension.columns],
          }),
          { queryColumns: [] },
        ),
      ),
    renderChart,
    chartConfigEditorDefinition: [
      {
        key: 'column',
        label: 'Measures',
        descriptionText:
          'Bind the measures that drive this card. The Primary value is the big number; Primary percent fills its bar. Use the Secondary measures for the Split layout. Footer metrics power the two small tiles at the bottom.',
        columnSections: [
          {
            key: 'primaryValue',
            label: 'Primary value (big number)',
            allowAttributeColumns: false,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'primaryPercent',
            label: 'Primary percent (drives left/single bar)',
            allowAttributeColumns: false,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'secondaryValue',
            label: 'Secondary value (split layout only)',
            allowAttributeColumns: false,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'secondaryPercent',
            label: 'Secondary percent (drives right bar)',
            allowAttributeColumns: false,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'metric1',
            label: 'Footer metric 1',
            allowAttributeColumns: false,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'metric2',
            label: 'Footer metric 2',
            allowAttributeColumns: false,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
        ],
      },
    ],
    visualPropEditorDefinition: {
      elements: [
        {
          type: 'section',
          key: 'layout',
          label: 'Layout',
          layoutType: 'accordion',
          isAccordianExpanded: true,
          children: [
            {
              key: 'mode',
              type: 'radio',
              label: 'Card layout',
              defaultValue: 'single',
              values: ['single', 'split'],
            },
            {
              key: 'cardTitle',
              type: 'text',
              label: 'Card title',
              defaultValue: 'Renewal uplift',
              placeholder: 'e.g. Renewal uplift',
            },
            {
              key: 'iconClass',
              type: 'text',
              label: 'Tabler icon class (e.g. ti-trending-up)',
              defaultValue: 'ti-trending-up',
              placeholder: 'ti-trending-up',
            },
          ],
        },
        {
          type: 'section',
          key: 'primary',
          label: 'Primary stat',
          layoutType: 'accordion',
          children: [
            {
              key: 'primarySuffix',
              type: 'text',
              label: 'Suffix after big number',
              defaultValue: 'accts',
              placeholder: 'accts',
            },
            {
              key: 'primaryDescription',
              type: 'text',
              label: 'Description line (single layout)',
              defaultValue: 'with renewal uplift applied',
            },
            {
              key: 'primaryFooter',
              type: 'text',
              label: 'Footer line (single layout)',
              defaultValue: 'of closed accounts · avg uplift €9.3K',
            },
            {
              key: 'leftLabel',
              type: 'text',
              label: 'Left label (split layout)',
              defaultValue: 'Multi-year',
            },
            {
              key: 'primaryAccentColor',
              type: 'colorpicker',
              label: 'Primary percent text color',
              defaultValue: '#534AB7',
            },
            {
              key: 'primaryBarColor',
              type: 'colorpicker',
              label: 'Primary bar color',
              defaultValue: '#7F77DD',
            },
            {
              key: 'primaryAsNumber',
              type: 'checkbox',
              label: 'Format primary value as number (currency + K/M/B)',
              defaultValue: false,
            },
          ],
        },
        {
          type: 'section',
          key: 'secondary',
          label: 'Secondary stat (split only)',
          layoutType: 'accordion',
          children: [
            {
              key: 'secondarySuffix',
              type: 'text',
              label: 'Suffix after right big number',
              defaultValue: 'accts',
            },
            {
              key: 'rightLabel',
              type: 'text',
              label: 'Right label',
              defaultValue: 'Single-year',
            },
            {
              key: 'secondaryAccentColor',
              type: 'colorpicker',
              label: 'Secondary percent text color',
              defaultValue: '#5F5E5A',
            },
            {
              key: 'secondaryBarColor',
              type: 'colorpicker',
              label: 'Secondary bar color',
              defaultValue: '#888780',
            },
          ],
        },
        {
          type: 'section',
          key: 'footerMetrics',
          label: 'Footer metrics',
          layoutType: 'accordion',
          children: [
            {
              key: 'metric1Label',
              type: 'text',
              label: 'Metric 1 label',
              defaultValue: 'Total uplift ARR',
            },
            {
              key: 'metric2Label',
              type: 'text',
              label: 'Metric 2 label',
              defaultValue: 'Avg uplift %',
            },
          ],
        },
        {
          type: 'section',
          key: 'formatting',
          label: 'Number formatting',
          layoutType: 'accordion',
          children: [
            {
              key: 'numberFormat',
              type: 'text',
              label: 'Numeral.js format (e.g. 0,0.[0])',
              defaultValue: '0,0.[0]',
            },
            {
              key: 'currencySymbol',
              type: 'text',
              label: 'Currency symbol prefix (e.g. €)',
              defaultValue: '€',
            },
          ],
        },
      ],
    },
    onPropChange: () => renderChart(ctx),
  });

  renderChart(ctx);
})();
