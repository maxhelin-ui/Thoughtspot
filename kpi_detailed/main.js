import {
  ChartToTSEvent,
  ColumnType,
  TSToChartEvent,
  getChartContext,
} from '@thoughtspot/ts-chart-sdk';
import _ from 'lodash';
import numeral from 'numeral';

/**
 * KPI - Detailed
 *
 * Configurable BYOC card that renders as either:
 *   - single-stat (e.g. Renewal uplift, Indexation)
 *   - split two-stat (e.g. Multi-year vs Single-year)
 *
 * Six measure / formula slots:
 *   - Primary value (numerator)
 *   - Primary percent base
 *   - Secondary value (numerator, split layout)
 *   - Secondary percent base (split layout)
 *   - Footer metric 1
 *   - Footer metric 2
 *
 * The progress bar fills based on `primaryPercentMode`:
 *   - "ratio" (default): bar = primaryValue / primaryPercent  (the typical
 *      "41 uplifted accounts / 113 closed = 36%" pattern)
 *   - "as-is": treat primaryPercent as the percent itself (fraction 0-1 or
 *      pre-scaled 0-100)
 *
 * Label defaults: when the user hasn't typed a custom label, the chart
 * falls back to the bound column's display name (e.g. the card title
 * mirrors the Primary value column name).
 */

// ---------- icons (inline SVG, no external font) ----------

const ICON_SVG = {
  'trending-up':
    '<svg viewBox="0 0 24 24"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></svg>',
  'arrows-up':
    '<svg viewBox="0 0 24 24"><polyline points="7 11 7 4 4 7"/><line x1="7" y1="4" x2="10" y2="7"/><polyline points="17 11 17 4 14 7"/><line x1="17" y1="4" x2="20" y2="7"/><line x1="7" y1="20" x2="7" y2="15"/><line x1="17" y1="20" x2="17" y2="15"/></svg>',
  'calendar-repeat':
    '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/><polyline points="14 14 17 14 17 17"/><path d="M17 14a4 4 0 1 0 -1 4"/></svg>',
  'clock':
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  'chart-pie':
    '<svg viewBox="0 0 24 24"><path d="M12 3v9h9"/><path d="M21 12a9 9 0 1 1 -9 -9"/></svg>',
  'none': '',
};

// ---------- formatting helpers ----------

function formatNumber(value, format, currency) {
  if (value == null || isNaN(value)) return '';
  const fmt = format || '0,0.[00]';
  const abs = Math.abs(value);
  let out;
  try {
    if (abs >= 1e9) {
      out = numeral(value / 1e9).format(fmt) + 'B';
    } else if (abs >= 1e6) {
      out = numeral(value / 1e6).format(fmt) + 'M';
    } else if (abs >= 1e3) {
      out = numeral(value / 1e3).format(fmt) + 'K';
    } else {
      out = numeral(value).format(fmt);
    }
  } catch {
    out = String(value);
  }
  return (currency || '') + out;
}

// formatPercent / clampPercentFill operate on a fraction (e.g. 0.36 = 36%).
function formatPercent(fraction) {
  if (fraction == null || isNaN(fraction)) return '';
  try {
    return numeral(fraction * 100).format('0') + '%';
  } catch {
    return Math.round(fraction * 100) + '%';
  }
}

function clampPercentFill(fraction) {
  if (fraction == null || isNaN(fraction)) return 0;
  return Math.max(0, Math.min(100, fraction * 100));
}

// Formats a single value for a footer metric tile. `mode` is one of:
//   - "currency" : numberFormat + currency prefix + K/M/B
//   - "number"   : numberFormat + K/M/B, no currency
//   - "percent"  : auto-detect fraction (<=1) vs pre-scaled, append "%"
function formatMetricValue(value, mode, numberFormat, currencySymbol) {
  if (value == null || isNaN(value)) return '';
  if (mode === 'percent') {
    const pct = Math.abs(value) <= 1 ? value * 100 : value;
    try {
      return numeral(pct).format(numberFormat || '0.[0]') + '%';
    } catch {
      return Math.round(pct) + '%';
    }
  }
  if (mode === 'number') {
    return formatNumber(value, numberFormat, '');
  }
  return formatNumber(value, numberFormat, currencySymbol);
}

function computeBarFraction(value, base, mode) {
  if (base == null || isNaN(base)) return null;
  if (mode === 'as-is') {
    // Accept a fraction (0..1) or a pre-scaled percent (0..100).
    return Math.abs(base) <= 1 ? base : base / 100;
  }
  // 'ratio' mode (default): bar = value / base.
  if (value == null || isNaN(value) || base === 0) return null;
  return value / base;
}

// ---------- data access ----------

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function getDataForColumn(column, dataArr) {
  if (!column || !dataArr) return [];
  const idx = _.findIndex(dataArr.columns ?? [], (colId) => column.id === colId);
  if (idx === -1) return [];
  return _.map(dataArr.dataValue ?? [], (row) => toNumber(row?.[idx]));
}

function getDimColumn(chartModel, key) {
  const dims = chartModel?.config?.chartConfig?.[0]?.dimensions ?? [];
  return dims.find((d) => d?.key === key)?.columns?.[0] ?? null;
}

function getColumnName(chartModel, key) {
  return getDimColumn(chartModel, key)?.name ?? '';
}

function sumForKey(chartModel, key) {
  const dataArr = chartModel?.data?.[0]?.data ?? null;
  if (!dataArr) return null;
  const col = getDimColumn(chartModel, key);
  if (!col) return null;
  const values = getDataForColumn(col, dataArr).filter((v) => v != null);
  if (!values.length) return null;
  return values.length === 1 ? values[0] : _.sum(values);
}

// ---------- rendering ----------

function applyCardStyles(vp) {
  const root = document.documentElement;
  if (vp?.primaryAccentColor) root.style.setProperty('--ts-accent', vp.primaryAccentColor);
  if (vp?.primaryBarColor) root.style.setProperty('--ts-accent-bar', vp.primaryBarColor);
  if (vp?.secondaryAccentColor) root.style.setProperty('--ts-secondary-accent', vp.secondaryAccentColor);
  if (vp?.secondaryBarColor) root.style.setProperty('--ts-secondary-accent-bar', vp.secondaryBarColor);
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

// Use the user's typed value if non-empty, else fall back to the bound
// column name, else ''. This is why the editor defaults are blank spaces
// rather than hard-coded copy.
function labelOrColumnName(userValue, columnName) {
  const trimmed = (userValue ?? '').trim();
  return trimmed !== '' ? trimmed : (columnName ?? '');
}

function renderHeader(vp, chartModel) {
  const title = labelOrColumnName(vp?.cardTitle, getColumnName(chartModel, 'primaryValue'));
  setText('cardTitle', title);
  const iconEl = document.getElementById('cardIcon');
  if (iconEl) {
    const key = vp?.icon ?? 'trending-up';
    iconEl.innerHTML = ICON_SVG[key] ?? '';
    iconEl.classList.toggle('hidden', !iconEl.innerHTML);
  }
}

function renderSingle(vp, values, chartModel) {
  setHidden('singleLayout', false);
  setHidden('splitLayout', true);

  const formatted = vp?.primaryAsNumber
    ? formatNumber(values.primaryValue, vp?.numberFormat, vp?.currencySymbol)
    : (values.primaryValue == null ? '' : String(Math.round(values.primaryValue)));

  setText('singleValue', formatted);
  setText('singleSuffix', vp?.primarySuffix ?? '');
  const desc = (vp?.primaryDescription ?? '').trim();
  setText('singleDescription', desc ? `· ${desc}` : '');

  const footerText = (vp?.primaryFooter ?? '').trim();
  const avgFormatted = values.footerAvg != null
    ? formatMetricValue(values.footerAvg, vp?.footerAvgFormat ?? 'currency', vp?.numberFormat, vp?.currencySymbol)
    : '';

  let avgPart = '';
  if (avgFormatted) {
    const avgLabel = labelOrColumnName(vp?.footerAvgLabel, getColumnName(chartModel, 'footerAvg'));
    avgPart = avgLabel ? `${avgLabel} ${avgFormatted}` : avgFormatted;
  }

  const fullFooter = footerText && avgPart
    ? `${footerText} · ${avgPart}`
    : (footerText || avgPart);
  setText('singleFooter', fullFooter);

  const fraction = computeBarFraction(values.primaryValue, values.primaryPercent, vp?.primaryPercentMode ?? 'ratio');
  setText('singlePercent', formatPercent(fraction));

  const fill = document.getElementById('singleBarFill');
  if (fill) {
    fill.style.width = clampPercentFill(fraction) + '%';
    fill.style.background = 'var(--ts-accent-bar)';
  }
  const label = document.getElementById('singlePercent');
  if (label) label.style.color = 'var(--ts-accent)';
}

function renderSplit(vp, values, chartModel) {
  setHidden('singleLayout', true);
  setHidden('splitLayout', false);

  const fmt = (v) => vp?.primaryAsNumber
    ? formatNumber(v, vp?.numberFormat, vp?.currencySymbol)
    : (v == null ? '' : String(Math.round(v)));

  setText('leftLabel', labelOrColumnName(vp?.leftLabel, getColumnName(chartModel, 'primaryValue')));
  setText('leftValue', fmt(values.primaryValue));
  setText('leftSuffix', vp?.primarySuffix ?? '');
  const leftFraction = computeBarFraction(values.primaryValue, values.primaryPercent, vp?.primaryPercentMode ?? 'ratio');
  setText('leftPercent', formatPercent(leftFraction));
  const leftFill = document.getElementById('leftBarFill');
  if (leftFill) {
    leftFill.style.width = clampPercentFill(leftFraction) + '%';
    leftFill.style.background = 'var(--ts-accent-bar)';
  }
  const leftLabelEl = document.getElementById('leftPercent');
  if (leftLabelEl) leftLabelEl.style.color = 'var(--ts-accent)';

  setText('rightLabel', labelOrColumnName(vp?.rightLabel, getColumnName(chartModel, 'secondaryValue')));
  setText('rightValue', fmt(values.secondaryValue));
  setText('rightSuffix', vp?.secondarySuffix ?? vp?.primarySuffix ?? '');
  const rightFraction = computeBarFraction(values.secondaryValue, values.secondaryPercent, vp?.secondaryPercentMode ?? 'ratio');
  setText('rightPercent', formatPercent(rightFraction));
  const rightFill = document.getElementById('rightBarFill');
  if (rightFill) {
    rightFill.style.width = clampPercentFill(rightFraction) + '%';
    rightFill.style.background = 'var(--ts-secondary-accent-bar)';
  }
  const rightLabelEl = document.getElementById('rightPercent');
  if (rightLabelEl) rightLabelEl.style.color = 'var(--ts-secondary-accent)';
}

function renderFooterMetrics(vp, values, chartModel) {
  const label1 = labelOrColumnName(vp?.metric1Label, getColumnName(chartModel, 'metric1'));
  const label2 = labelOrColumnName(vp?.metric2Label, getColumnName(chartModel, 'metric2'));
  const hasMetric1 = values.metric1 != null && label1 !== '';
  const hasMetric2 = values.metric2 != null && label2 !== '';
  setHidden('footerMetrics', !(hasMetric1 || hasMetric2));

  setText('metric1Label', label1);
  setText('metric1Value', hasMetric1
    ? formatMetricValue(values.metric1, vp?.metric1Format ?? 'currency', vp?.numberFormat, vp?.currencySymbol)
    : '');

  setText('metric2Label', label2);
  setText('metric2Value', hasMetric2
    ? formatMetricValue(values.metric2, vp?.metric2Format ?? 'currency', vp?.numberFormat, vp?.currencySymbol)
    : '');
}

function render(ctx) {
  const maybeModel = ctx.getChartModel();
  return Promise.resolve(maybeModel).then((chartModel) => {
    const vp = chartModel?.visualProps ?? {};
    applyCardStyles(vp);

    const values = {
      primaryValue: sumForKey(chartModel, 'primaryValue'),
      primaryPercent: sumForKey(chartModel, 'primaryPercent'),
      secondaryValue: sumForKey(chartModel, 'secondaryValue'),
      secondaryPercent: sumForKey(chartModel, 'secondaryPercent'),
      metric1: sumForKey(chartModel, 'metric1'),
      metric2: sumForKey(chartModel, 'metric2'),
      footerAvg: sumForKey(chartModel, 'footerAvg'),
    };

    renderHeader(vp, chartModel);

    if ((vp?.mode ?? 'single') === 'split') {
      renderSplit(vp, values, chartModel);
    } else {
      renderSingle(vp, values, chartModel);
    }

    renderFooterMetrics(vp, values, chartModel);
  });
}

const renderChart = async (ctx) => {
  try {
    ctx.emitEvent(ChartToTSEvent.RenderStart);
    await render(ctx);
    ctx.emitEvent(ChartToTSEvent.RenderComplete);
  } catch (error) {
    console.error('KPI - Detailed render error:', error);
    ctx.emitEvent(ChartToTSEvent.RenderError, { hasError: true, error });
  }
};

(async () => {
  const ctx = await getChartContext({
    getDefaultChartConfig: (chartModel) => {
      const measureCols = _.filter(
        chartModel?.columns ?? [],
        (col) => col?.type === ColumnType.MEASURE,
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
            { key: 'footerAvg', columns: measureCols[6] ? [measureCols[6]] : [] },
          ],
        },
      ];
    },
    getQueriesFromChartConfig: (chartConfig) =>
      (chartConfig ?? []).map((config) =>
        _.reduce(
          config?.dimensions ?? [],
          (acc, dimension) => ({
            queryColumns: [...acc.queryColumns, ...(dimension?.columns ?? [])],
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
          'Bind measures or formulas. By default the bar = Primary value / Primary percent base (e.g. uplifted accounts / total closed accounts). Change "Percent calculation" in the visual props if your base column is already a percent. Secondary slots are used by the Split layout.',
        columnSections: [
          {
            key: 'primaryValue',
            label: 'Primary value (numerator / big number)',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'primaryPercent',
            label: 'Primary percent base (denominator that drives the bar)',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'secondaryValue',
            label: 'Secondary value (split layout)',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'secondaryPercent',
            label: 'Secondary percent base (split layout)',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'metric1',
            label: 'Footer metric 1',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'metric2',
            label: 'Footer metric 2',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'footerAvg',
            label: 'Footer avg value (appended to footer line)',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
        ],
      },
    ],
    visualPropEditorDefinition: {
      elements: [
        { key: 'mode', type: 'dropdown', label: 'Card layout', defaultValue: 'single', values: ['single', 'split'] },
        // All free-text labels default to a single space ('' is rejected
        // by the SDK). When left blank, the render code falls back to the
        // bound column's display name.
        { key: 'cardTitle', type: 'text', label: 'Card title (blank = use Primary value column name)', defaultValue: ' ' },
        {
          key: 'icon',
          type: 'dropdown',
          label: 'Header icon',
          defaultValue: 'trending-up',
          values: ['trending-up', 'arrows-up', 'calendar-repeat', 'clock', 'chart-pie', 'none'],
        },
        { key: 'primarySuffix', type: 'text', label: 'Suffix after big number', defaultValue: 'accounts' },
        { key: 'primaryDescription', type: 'text', label: 'Description (single layout)', defaultValue: ' ' },
        { key: 'primaryFooter', type: 'text', label: 'Footer line (single layout)', defaultValue: ' ' },
        { key: 'footerAvgLabel', type: 'text', label: 'Footer avg label (blank = use bound column name)', defaultValue: ' ' },
        {
          key: 'footerAvgFormat',
          type: 'dropdown',
          label: 'Footer avg value format',
          defaultValue: 'currency',
          values: ['currency', 'number', 'percent'],
        },
        { key: 'leftLabel', type: 'text', label: 'Left label (split, blank = use Primary value column name)', defaultValue: ' ' },
        {
          key: 'primaryPercentMode',
          type: 'dropdown',
          label: 'Primary bar calculation',
          defaultValue: 'ratio',
          values: ['ratio', 'as-is'],
        },
        { key: 'primaryAccentColor', type: 'colorpicker', label: 'Primary percent text color', defaultValue: '#534AB7' },
        { key: 'primaryBarColor', type: 'colorpicker', label: 'Primary bar color', defaultValue: '#7F77DD' },
        { key: 'primaryAsNumber', type: 'checkbox', label: 'Format primary value as number (currency + K/M/B)', defaultValue: false },
        { key: 'secondarySuffix', type: 'text', label: 'Secondary suffix (split)', defaultValue: 'accounts' },
        { key: 'rightLabel', type: 'text', label: 'Right label (split, blank = use Secondary value column name)', defaultValue: ' ' },
        {
          key: 'secondaryPercentMode',
          type: 'dropdown',
          label: 'Secondary bar calculation',
          defaultValue: 'ratio',
          values: ['ratio', 'as-is'],
        },
        { key: 'secondaryAccentColor', type: 'colorpicker', label: 'Secondary percent text color', defaultValue: '#5F5E5A' },
        { key: 'secondaryBarColor', type: 'colorpicker', label: 'Secondary bar color', defaultValue: '#888780' },
        { key: 'metric1Label', type: 'text', label: 'Metric 1 label (blank = use column name)', defaultValue: ' ' },
        {
          key: 'metric1Format',
          type: 'dropdown',
          label: 'Metric 1 format',
          defaultValue: 'currency',
          values: ['currency', 'number', 'percent'],
        },
        { key: 'metric2Label', type: 'text', label: 'Metric 2 label (blank = use column name)', defaultValue: ' ' },
        {
          key: 'metric2Format',
          type: 'dropdown',
          label: 'Metric 2 format',
          defaultValue: 'currency',
          values: ['currency', 'number', 'percent'],
        },
        { key: 'numberFormat', type: 'text', label: 'Numeral.js format', defaultValue: '0,0.[0]' },
        { key: 'currencySymbol', type: 'text', label: 'Currency symbol prefix', defaultValue: '€' },
      ],
    },
    onPropChange: () => renderChart(ctx),
  });

  // Explicit subscriptions so the chart re-renders on data/model changes
  // without a full iframe refresh. Without these the SDK falls back to
  // a full reload, which can leave the canvas showing stale numbers when
  // a worksheet formula or column binding changes.
  ctx.on(TSToChartEvent.DataUpdate, () => {
    renderChart(ctx);
    return { triggerRenderChart: false };
  });
  ctx.on(TSToChartEvent.ChartModelUpdate, () => {
    renderChart(ctx);
    return { triggerRenderChart: false };
  });

  renderChart(ctx);
})();
