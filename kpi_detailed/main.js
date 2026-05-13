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
 * Configurable BYOC card that renders as either:
 *   - single-stat (e.g. Renewal uplift, Indexation)
 *   - split two-stat (e.g. Multi-year vs Single-year)
 *
 * Six measure slots: primary value / primary percent / secondary value /
 * secondary percent / footer metric 1 / footer metric 2. Everything else
 * (labels, suffixes, colors, icon, layout, formatting) is driven by visual
 * props.
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

function formatPercent(value) {
  if (value == null || isNaN(value)) return '';
  // Accept either fractions (0-1) or pre-scaled percents (0-100).
  const pct = Math.abs(value) <= 1 ? value * 100 : value;
  try {
    return numeral(pct).format('0') + '%';
  } catch {
    return Math.round(pct) + '%';
  }
}

function clampPercentFill(value) {
  if (value == null || isNaN(value)) return 0;
  const pct = Math.abs(value) <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, pct));
}

// ---------- data access ----------

function getDataForColumn(column, dataArr) {
  if (!column || !dataArr) return [];
  const idx = _.findIndex(dataArr.columns ?? [], (colId) => column.id === colId);
  if (idx === -1) return [];
  return _.map(dataArr.dataValue ?? [], (row) => row?.[idx]);
}

function sumForKey(chartModel, key) {
  const dataArr = chartModel?.data?.[0]?.data ?? null;
  if (!dataArr) return null;
  const dims = chartModel?.config?.chartConfig?.[0]?.dimensions ?? [];
  const dim = dims.find((d) => d?.key === key);
  const col = dim?.columns?.[0];
  if (!col) return null;
  const values = getDataForColumn(col, dataArr);
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

function renderHeader(vp) {
  setText('cardTitle', (vp?.cardTitle ?? '').trim());
  const iconEl = document.getElementById('cardIcon');
  if (iconEl) {
    const key = vp?.icon ?? 'trending-up';
    iconEl.innerHTML = ICON_SVG[key] ?? '';
    iconEl.classList.toggle('hidden', !iconEl.innerHTML);
  }
}

function renderSingle(vp, values) {
  setHidden('singleLayout', false);
  setHidden('splitLayout', true);

  const formatted = vp?.primaryAsNumber
    ? formatNumber(values.primaryValue, vp?.numberFormat, vp?.currencySymbol)
    : (values.primaryValue == null ? '' : String(Math.round(values.primaryValue)));

  setText('singleValue', formatted);
  setText('singleSuffix', vp?.primarySuffix ?? '');
  setText('singleDescription', (vp?.primaryDescription ?? '').trim());
  setText('singleFooter', (vp?.primaryFooter ?? '').trim());
  setText('singlePercent', formatPercent(values.primaryPercent));

  const fill = document.getElementById('singleBarFill');
  if (fill) {
    fill.style.width = clampPercentFill(values.primaryPercent) + '%';
    fill.style.background = 'var(--ts-accent-bar)';
  }
  const label = document.getElementById('singlePercent');
  if (label) label.style.color = 'var(--ts-accent)';
}

function renderSplit(vp, values) {
  setHidden('singleLayout', true);
  setHidden('splitLayout', false);

  const fmt = (v) => vp?.primaryAsNumber
    ? formatNumber(v, vp?.numberFormat, vp?.currencySymbol)
    : (v == null ? '' : String(Math.round(v)));

  setText('leftLabel', (vp?.leftLabel ?? '').trim());
  setText('leftValue', fmt(values.primaryValue));
  setText('leftSuffix', vp?.primarySuffix ?? '');
  setText('leftPercent', formatPercent(values.primaryPercent));
  const leftFill = document.getElementById('leftBarFill');
  if (leftFill) {
    leftFill.style.width = clampPercentFill(values.primaryPercent) + '%';
    leftFill.style.background = 'var(--ts-accent-bar)';
  }
  const leftLabel = document.getElementById('leftPercent');
  if (leftLabel) leftLabel.style.color = 'var(--ts-accent)';

  setText('rightLabel', (vp?.rightLabel ?? '').trim());
  setText('rightValue', fmt(values.secondaryValue));
  setText('rightSuffix', (vp?.secondarySuffix ?? vp?.primarySuffix ?? ''));
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
  const label1 = (vp?.metric1Label ?? '').trim();
  const label2 = (vp?.metric2Label ?? '').trim();
  const hasMetric1 = values.metric1 != null && label1 !== '';
  const hasMetric2 = values.metric2 != null && label2 !== '';
  setHidden('footerMetrics', !(hasMetric1 || hasMetric2));

  setText('metric1Label', label1);
  setText('metric1Value', hasMetric1
    ? formatNumber(values.metric1, vp?.numberFormat, vp?.currencySymbol)
    : '');

  setText('metric2Label', label2);
  setText('metric2Value', hasMetric2
    ? formatNumber(values.metric2, vp?.numberFormat, vp?.currencySymbol)
    : '');
}

function render(ctx) {
  const maybeModel = ctx.getChartModel();
  // The SDK has returned either a Promise or a sync value depending on version,
  // so normalize both cases.
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
    };

    renderHeader(vp);

    if ((vp?.mode ?? 'single') === 'split') {
      renderSplit(vp, values);
    } else {
      renderSingle(vp, values);
    }

    renderFooterMetrics(vp, values);
  });
}

// Render event order: emit RenderComplete only after success.
// RenderError is reserved for the catch path.
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
          'Bind the measures that drive this card. Primary value is the big number; Primary percent fills its bar. Secondary measures are used by the Split layout. Footer metrics fill the two small tiles.',
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
            label: 'Primary percent (drives bar)',
            allowAttributeColumns: false,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'secondaryValue',
            label: 'Secondary value (split layout)',
            allowAttributeColumns: false,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'secondaryPercent',
            label: 'Secondary percent (split layout)',
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
        { key: 'mode', type: 'radio', label: 'Card layout', defaultValue: 'single', values: ['single', 'split'] },
        { key: 'cardTitle', type: 'text', label: 'Card title', defaultValue: 'Renewal uplift' },
        {
          key: 'icon',
          type: 'dropdown',
          label: 'Header icon',
          defaultValue: 'trending-up',
          values: ['trending-up', 'arrows-up', 'calendar-repeat', 'clock', 'chart-pie', 'none'],
        },
        { key: 'primarySuffix', type: 'text', label: 'Suffix after big number', defaultValue: 'accts' },
        { key: 'primaryDescription', type: 'text', label: 'Description (single layout)', defaultValue: 'with renewal uplift applied' },
        { key: 'primaryFooter', type: 'text', label: 'Footer line (single layout)', defaultValue: 'of closed accounts' },
        { key: 'leftLabel', type: 'text', label: 'Left label (split layout)', defaultValue: 'Multi-year' },
        { key: 'primaryAccentColor', type: 'colorpicker', label: 'Primary percent text color', defaultValue: '#534AB7' },
        { key: 'primaryBarColor', type: 'colorpicker', label: 'Primary bar color', defaultValue: '#7F77DD' },
        { key: 'primaryAsNumber', type: 'checkbox', label: 'Format primary value as number (currency + K/M/B)', defaultValue: false },
        { key: 'secondarySuffix', type: 'text', label: 'Secondary suffix (split)', defaultValue: 'accts' },
        { key: 'rightLabel', type: 'text', label: 'Right label (split)', defaultValue: 'Single-year' },
        { key: 'secondaryAccentColor', type: 'colorpicker', label: 'Secondary percent text color', defaultValue: '#5F5E5A' },
        { key: 'secondaryBarColor', type: 'colorpicker', label: 'Secondary bar color', defaultValue: '#888780' },
        { key: 'metric1Label', type: 'text', label: 'Metric 1 label', defaultValue: 'Total uplift ARR' },
        { key: 'metric2Label', type: 'text', label: 'Metric 2 label', defaultValue: 'Avg uplift %' },
        { key: 'numberFormat', type: 'text', label: 'Numeral.js format', defaultValue: '0,0.[0]' },
        { key: 'currencySymbol', type: 'text', label: 'Currency symbol prefix', defaultValue: '€' },
      ],
    },
    onPropChange: () => renderChart(ctx),
  });

  renderChart(ctx);
})();
