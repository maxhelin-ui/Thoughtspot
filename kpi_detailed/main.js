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
 * Four column sections:
 *   - base       : 1 column. Shared denominator for ALL primary bars.
 *   - primaries  : up to 4 columns. Each renders as a "primary value" card
 *                  (label / big number / progress bar = value/base / footer).
 *   - metrics    : up to 4 columns. Small tiles under the primaries (Split),
 *                  or rows under the big number (Main + Secondaries).
 *   - footers    : up to 4 columns. Each footer N pairs with primary N
 *                  (Split layout, under the bar) or metric N (Main+Sec,
 *                  appended after " · ").
 *
 * Two layouts:
 *   - Split: N primary cards side-by-side; M metric tiles below.
 *   - Main + Secondaries: big primary[0] + rows of "metric · footer".
 *
 * Per-primary description supports {base} and {percent} tokens.
 */

const MAX_PRIMARIES = 4;
const MAX_METRICS   = 4;
const MAX_FOOTERS   = 4;

const FORMAT_OPTIONS   = ['currency', 'number', 'percent'];
const ICON_OPTIONS     = ['none', 'trending-up', 'arrows-up', 'calendar-repeat', 'clock', 'chart-pie'];
const LAYOUT_OPTIONS   = ['split', 'main-secondaries'];
const CURRENCY_OPTIONS = ['€', '$', '£', '¥', '₹', 'kr'];

const SIGN_GREEN = '#038922';
const SIGN_RED   = '#D54035';

// ---------- icons ----------

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

// ---------- formatting ----------

function abbreviated(value, pattern) {
  const abs = Math.abs(value);
  const fmt = pattern || '0,0.[0]';
  if (abs >= 1e9) return numeral(value / 1e9).format(fmt) + 'B';
  if (abs >= 1e6) return numeral(value / 1e6).format(fmt) + 'M';
  if (abs >= 1e3) return numeral(value / 1e3).format(fmt) + 'K';
  return numeral(value).format(fmt);
}

function formatValue(value, mode, currencySymbol) {
  if (value == null || isNaN(value)) return '';
  try {
    if (mode === 'percent') {
      const pct = Math.abs(value) <= 1 ? value * 100 : value;
      return numeral(pct).format('0.[0]') + '%';
    }
    if (mode === 'number') return abbreviated(value, '0,0.[0]');
    return (currencySymbol || '') + abbreviated(value, '0,0.[0]');
  } catch {
    return String(value);
  }
}

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

function fractionOf(value, base) {
  if (value == null || base == null || isNaN(value) || isNaN(base) || base === 0) return null;
  return value / base;
}

function colourForSign(v) {
  if (v == null || isNaN(v)) return '';
  if (v > 0) return SIGN_GREEN;
  if (v < 0) return SIGN_RED;
  return '';
}

// Substitute {base} / {percent} tokens in description text.
function substituteTokens(template, baseFormatted, percentFormatted) {
  if (!template) return '';
  return String(template)
    .replace(/\{base\}/g, baseFormatted ?? '')
    .replace(/\{percent\}/g, percentFormatted ?? '');
}

// ---------- data access ----------

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function getDimColumns(chartModel, key) {
  const dims = chartModel?.config?.chartConfig?.[0]?.dimensions ?? [];
  return dims.find((d) => d?.key === key)?.columns ?? [];
}

function aggregateColumn(chartModel, column) {
  if (!column) return null;
  const dataArr = chartModel?.data?.[0]?.data ?? null;
  if (!dataArr) return null;
  const idx = _.findIndex(dataArr.columns ?? [], (colId) => column.id === colId);
  if (idx === -1) return null;
  const values = _.map(dataArr.dataValue ?? [], (row) => toNumber(row?.[idx])).filter((v) => v != null);
  if (!values.length) return null;
  if (values.length === 1) return values[0];

  const aggName = String(column.aggregationType ?? '').toUpperCase();
  if (aggName.includes('AVERAGE') || aggName.includes('MEDIAN') || aggName.includes('PERCENTILE')) {
    return _.sum(values) / values.length;
  }
  if (aggName.includes('MIN')) return _.min(values);
  if (aggName.includes('MAX')) return _.max(values);
  return _.sum(values);
}

// ---------- DOM helpers ----------

function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.style) Object.assign(node.style, opts.style);
  return node;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function setHidden(id, hidden) {
  const node = document.getElementById(id);
  if (node) node.classList.toggle('hidden', hidden);
}

// Whitespace-only (including the default ' ') falls back to the bound
// column name. Anything else uses the trimmed user-typed value.
// Note: TS rejects empty-string defaults for text inputs, so we can't
// distinguish "user wants no label" from "user hasn't touched it" via
// the value alone — the previous space-as-blank attempt broke the host.
function labelOrColumnName(userValue, column) {
  const trimmed = (userValue ?? '').toString().trim();
  if (trimmed !== '') return trimmed;
  return column?.name ?? '';
}

// Best-effort percent detection so the per-field Format default falls
// to 'percent' when the bound column is clearly a ratio. We look at the
// column's numeric format pattern first (most reliable — TS sets it when
// the worksheet/measure is declared as percent) and fall back to a name
// heuristic. Returns 'percent' or 'number'.
function defaultFormatForColumn(column) {
  if (!column) return 'number';
  const pattern = (column?.format?.pattern ?? '').toString();
  if (pattern.includes('%')) return 'percent';
  const name = (column?.name ?? '').toLowerCase();
  if (name.includes('%')) return 'percent';
  if (/(\b|_)(pct|percent|percentage|rate|ratio|share|uplift)(\b|_)/.test(name)) return 'percent';
  return 'number';
}

function renderHeaderIcons(iconKey) {
  const svg = ICON_SVG[iconKey] ?? '';
  document.querySelectorAll('[data-icon-slot]').forEach((node) => {
    node.innerHTML = svg;
    node.classList.toggle('hidden', !svg);
  });
}

function applyAccents(vp, palette) {
  // Apply the FIRST primary's color as the page-level accent fallback.
  const root = document.documentElement;
  const first = vp?.primary1Color || palette[0];
  if (first) {
    root.style.setProperty('--ts-accent', first);
    root.style.setProperty('--ts-accent-bar', first);
  }
}

// ---------- render: split layout ----------

function renderSplitLayout({ vp, primaryCols, metricCols, footerCols, baseValue, currency, baseFormatted, palette, greenRed }) {
  setHidden('mainSecLayout', true);
  setHidden('emptyState', true);
  setHidden('splitLayout', false);

  const grid = document.getElementById('primariesGrid');
  clearNode(grid);
  const primaryCount = primaryCols.length;
  grid.style.gridTemplateColumns = `repeat(${Math.max(primaryCount, 1)}, minmax(0, 1fr))`;

  primaryCols.forEach((col, i) => {
    const n = i + 1;
    const value = aggregateColumn(chartModelRef.current, col);
    const fraction = fractionOf(value, baseValue);
    const percentFormatted = formatPercent(fraction);
    const format = vp[`primary${n}Format`] ?? defaultFormatForColumn(col);
    const valueFormatted = formatValue(value, format, currency);
    const labelText = labelOrColumnName(vp[`primary${n}Label`], col);
    const description = substituteTokens(vp[`primary${n}Description`], baseFormatted, percentFormatted);
    const color = vp[`primary${n}Color`] || palette[i % palette.length];

    const side = el('div', { className: 'ts-split-side' });

    if (labelText) side.appendChild(el('div', { className: 'ts-side-label', text: labelText }));

    const statRow = el('div', { className: 'ts-stat-row' });
    const valueSpan = el('span', { className: 'ts-stat-medium', text: valueFormatted });
    if (greenRed) valueSpan.style.color = colourForSign(value);
    statRow.appendChild(valueSpan);
    if (description) statRow.appendChild(el('span', { className: 'ts-stat-desc', text: description }));
    side.appendChild(statRow);

    if (baseValue != null) {
      const progRow = el('div', { className: 'ts-progress-row' });
      const track   = el('div', { className: 'ts-progress-track' });
      const fill    = el('div', { className: 'ts-progress-fill' });
      fill.style.width = clampPercentFill(fraction) + '%';
      fill.style.background = color;
      track.appendChild(fill);
      progRow.appendChild(track);
      const pctLabel = el('span', { className: 'ts-progress-label', text: percentFormatted });
      pctLabel.style.color = color;
      progRow.appendChild(pctLabel);
      side.appendChild(progRow);
    }

    // Footer for this primary position.
    // labelOrColumnName resolves: empty → col name (or '' if no col bound);
    // whitespace → '' (explicit no-label); text → trimmed text.
    const footerCol    = footerCols[i] ?? null;
    const footerFormat = vp[`footer${n}Format`] ?? defaultFormatForColumn(footerCol);
    const footerLabel  = labelOrColumnName(vp[`footer${n}Label`], footerCol);
    if (footerCol) {
      const footerValue = aggregateColumn(chartModelRef.current, footerCol);
      const formatted   = formatValue(footerValue, footerFormat, currency);
      const text = footerLabel ? `${footerLabel} ${formatted}` : formatted;
      if (text) side.appendChild(el('div', { className: 'ts-stat-footer', text }));
    } else if (footerLabel) {
      side.appendChild(el('div', { className: 'ts-stat-footer', text: footerLabel }));
    }

    grid.appendChild(side);
  });

  // Metrics row
  const metricsRow = document.getElementById('metricsRow');
  clearNode(metricsRow);
  const tiles = metricCols.map((col, i) => {
    const n = i + 1;
    const value = aggregateColumn(chartModelRef.current, col);
    const format = vp[`metric${n}Format`] ?? defaultFormatForColumn(col);
    const formatted = formatValue(value, format, currency);
    const label = labelOrColumnName(vp[`metric${n}Label`], col);
    if (!formatted && !label) return null;
    const tile = el('div', { className: 'ts-metric' });
    if (label) tile.appendChild(el('div', { className: 'ts-metric-label', text: label }));
    tile.appendChild(el('div', { className: 'ts-metric-value', text: formatted }));
    return tile;
  }).filter(Boolean);
  tiles.forEach((t) => metricsRow.appendChild(t));
  metricsRow.classList.toggle('hidden', tiles.length === 0);
}

// ---------- render: main + secondaries ----------

function renderMainSecondariesLayout({ vp, primaryCols, metricCols, footerCols, baseValue, currency, baseFormatted, palette, greenRed }) {
  setHidden('splitLayout', true);
  setHidden('emptyState', true);
  setHidden('mainSecLayout', false);

  const primary = primaryCols[0] ?? null;
  const primaryValueEl = document.getElementById('msPrimaryValue');
  const primaryDescEl  = document.getElementById('msPrimaryDescription');
  if (primary) {
    const value = aggregateColumn(chartModelRef.current, primary);
    const fraction = fractionOf(value, baseValue);
    const percentFormatted = formatPercent(fraction);
    const format = vp.primary1Format ?? defaultFormatForColumn(primary);
    primaryValueEl.textContent = formatValue(value, format, currency);
    primaryValueEl.style.color = greenRed ? (colourForSign(value) || '') : '';
    primaryDescEl.textContent  = substituteTokens(vp.primary1Description, baseFormatted, percentFormatted);
  } else {
    primaryValueEl.textContent = '';
    primaryValueEl.style.color = '';
    primaryDescEl.textContent  = '';
  }

  // One row per bound metric. Footer N (if any) is appended with " · ".
  const rowsHost = document.getElementById('msRows');
  clearNode(rowsHost);
  const rowCount = Math.max(metricCols.length, footerCols.length);
  for (let i = 0; i < rowCount; i++) {
    const n = i + 1;
    const metricCol = metricCols[i] ?? null;
    const footerCol = footerCols[i] ?? null;

    let metricPart = '';
    if (metricCol) {
      const v = aggregateColumn(chartModelRef.current, metricCol);
      const format = vp[`metric${n}Format`] ?? defaultFormatForColumn(metricCol);
      const formatted = formatValue(v, format, currency);
      const label = labelOrColumnName(vp[`metric${n}Label`], metricCol);
      metricPart = label ? `${formatted} ${label}`.trim() : formatted;
    }

    const footerLabel = labelOrColumnName(vp[`footer${n}Label`], footerCol);
    let footerPart = '';
    if (footerCol) {
      const v = aggregateColumn(chartModelRef.current, footerCol);
      const format = vp[`footer${n}Format`] ?? defaultFormatForColumn(footerCol);
      const formatted = formatValue(v, format, currency);
      footerPart = footerLabel ? `${footerLabel} ${formatted}` : formatted;
    } else if (footerLabel) {
      footerPart = footerLabel;
    }

    const text = (metricPart && footerPart) ? `${metricPart} · ${footerPart}` : (metricPart || footerPart);
    if (!text) continue;
    rowsHost.appendChild(el('div', { className: 'ts-main-sec-row', text }));
  }
}

// ---------- main render ----------

const chartModelRef = { current: null };

function render(ctx, providedModel) {
  const modelPromise = providedModel
    ? Promise.resolve(providedModel)
    : Promise.resolve(ctx.getChartModel());
  return modelPromise.then((chartModel) => {
    chartModelRef.current = chartModel;
    const vp = chartModel?.visualProps ?? {};

    const baseCol      = getDimColumns(chartModel, 'base')[0] ?? null;
    const primaryCols  = getDimColumns(chartModel, 'primaries').slice(0, MAX_PRIMARIES);
    const metricCols   = getDimColumns(chartModel, 'metrics').slice(0, MAX_METRICS);
    const footerCols   = getDimColumns(chartModel, 'footers').slice(0, MAX_FOOTERS);

    const anyBound = !!baseCol || primaryCols.length || metricCols.length || footerCols.length;
    if (!anyBound) {
      setHidden('splitLayout', true);
      setHidden('mainSecLayout', true);
      const node = document.getElementById('emptyState');
      node.textContent = 'Bind at least one column to render this KPI.';
      node.classList.remove('hidden');
      return;
    }

    const palette       = getEffectivePalette();
    const currency      = vp.currencySymbol ?? '€';
    const baseValue     = aggregateColumn(chartModel, baseCol);
    const baseFormatted = baseValue != null ? formatValue(baseValue, 'number', currency) : '';
    const greenRed      = !!vp.greenRedBySign;

    renderHeaderIcons(vp.icon ?? 'none');
    applyAccents(vp, palette);

    const layout = vp.layout ?? 'split';
    const args = { vp, primaryCols, metricCols, footerCols, baseValue, currency, baseFormatted, palette, greenRed };
    if (layout === 'main-secondaries') {
      renderMainSecondariesLayout(args);
    } else {
      renderSplitLayout(args);
    }

    // Diagnostic trace for chart-vs-table debugging.
    console.log('[KPI - Detailed]', {
      bindings: {
        base: baseCol?.name,
        primaries: primaryCols.map((c) => c.name),
        metrics:   metricCols.map((c) => c.name),
        footers:   footerCols.map((c) => c.name),
      },
      baseValue,
      layout,
    });
  });
}

// ---------- app config / palette ----------

let globalAppConfig = null;
const FALLBACK_PALETTE = ['#7F77DD', '#888780', '#534AB7', '#5F5E5A'];

function getEffectivePalette() {
  const palettes = globalAppConfig?.styleConfig?.chartColorPalettes;
  if (Array.isArray(palettes) && palettes.length > 0
      && Array.isArray(palettes[0]?.colors) && palettes[0].colors.length > 0) {
    return palettes[0].colors;
  }
  return FALLBACK_PALETTE;
}

// ---------- render orchestration + debounced prop changes ----------

let lastModel = null;

// Visual props whose editor is a free-text input. Typing fires onPropChange
// per keystroke, so we hold renders for 2s of idle. Dropdowns / colorpickers
// / checkboxes commit on click and render immediately.
const TEXT_PROP_KEYS = new Set([
  'currencySymbol',
  'primary1Label', 'primary1Description',
  'primary2Label', 'primary2Description',
  'primary3Label', 'primary3Description',
  'primary4Label', 'primary4Description',
  'metric1Label', 'metric2Label', 'metric3Label', 'metric4Label',
  'footer1Label', 'footer2Label', 'footer3Label', 'footer4Label',
]);
const TEXT_PROP_DEBOUNCE_MS = 2000;

const renderChart = async (ctx, providedModel) => {
  if (!globalAppConfig) {
    try { globalAppConfig = ctx.getAppConfig?.() ?? null; } catch { /* ignore */ }
  }
  try {
    ctx.emitEvent(ChartToTSEvent.RenderStart);
    await render(ctx, providedModel);
    ctx.emitEvent(ChartToTSEvent.RenderComplete);
  } catch (error) {
    console.error('KPI - Detailed render error:', error);
    ctx.emitEvent(ChartToTSEvent.RenderError, { hasError: true, error });
  }
};

// Disabled text field used purely as a visual separator in the prop editor.
// Stores an unused prop under the given key; users can't edit it.
function sectionHeader(key, label) {
  return { key, type: 'text', label, defaultValue: ' ', disabled: true };
}

// Build a flat list of per-item fields with the bound column name baked
// into each label, e.g. `1. CXUC — Format`. We deliberately don't nest
// sections inside the outer accordion — the TS prop-editor host drops
// children of inner sections silently, which made the labels/colors/
// formats all stop persisting. `kind` controls which fields the slot
// gets (primary/metric/footer).
function buildItemSections(chartModel, kind, dimKey, max, palette) {
  const cols = getDimColumns(chartModel, dimKey);
  const elements = [];
  for (let i = 1; i <= max; i++) {
    const col = cols[i - 1] ?? null;
    const tag = col ? `${i}. ${col.name}` : `${i}. (drag a column)`;
    if (kind === 'primary') {
      elements.push(
        { key: `primary${i}Format`,      type: 'dropdown',    label: `${tag} — Format`,      values: FORMAT_OPTIONS, defaultValue: 'number' },
        { key: `primary${i}Label`,       type: 'text',        label: `${tag} — Label`,       defaultValue: ' ' },
        { key: `primary${i}Description`, type: 'text',        label: `${tag} — Description (tokens: {base}, {percent})`, defaultValue: ' ' },
        { key: `primary${i}Color`,       type: 'colorpicker', label: `${tag} — Bar colour`,  defaultValue: palette[(i - 1) % palette.length] },
      );
    } else if (kind === 'footer') {
      elements.push(
        { key: `footer${i}Format`, type: 'dropdown', label: `${tag} — Format`, values: FORMAT_OPTIONS, defaultValue: 'number' },
        { key: `footer${i}Label`,  type: 'text',     label: `${tag} — Label`,  defaultValue: ' ' },
      );
    } else {
      elements.push(
        { key: `metric${i}Format`, type: 'dropdown', label: `${tag} — Format`, values: FORMAT_OPTIONS, defaultValue: 'number' },
        { key: `metric${i}Label`,  type: 'text',     label: `${tag} — Label`,  defaultValue: ' ' },
      );
    }
  }
  return elements;
}

(async () => {
  let propChangeTimer = null;
  const palette = FALLBACK_PALETTE; // fallback before app config arrives

  const ctx = await getChartContext({
    getDefaultChartConfig: () => [
      {
        key: 'column',
        dimensions: [
          { key: 'base',      columns: [] },
          { key: 'primaries', columns: [] },
          { key: 'metrics',   columns: [] },
          { key: 'footers',   columns: [] },
        ],
      },
    ],
    getQueriesFromChartConfig: (chartConfig, chartModel) => {
      // TS rejects queries with zero columns; with everything empty by
      // default we'd fail init. Filter empty queries, and if none remain
      // include a placeholder column so init can proceed.
      const queries = (chartConfig ?? []).map((config) => ({
        queryColumns: _.flatMap(config?.dimensions ?? [], (d) => d?.columns ?? []),
      })).filter((q) => q.queryColumns.length > 0);
      if (queries.length > 0) return queries;
      const placeholder = chartModel?.columns?.[0];
      return placeholder ? [{ queryColumns: [placeholder] }] : [];
    },
    renderChart,
    chartConfigEditorDefinition: [
      {
        key: 'column',
        label: 'Layout',
        descriptionText:
          'Bind a Denominator, then drag up to 4 columns each into Primary values, Footers, and Metrics. Footer N pairs with primary N (Split) or metric N (Main+Secondaries).',
        columnSections: [
          {
            key: 'base',
            label: 'Denominator for Primary Values Bar',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'primaries',
            label: 'Primary values',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: MAX_PRIMARIES,
          },
          {
            key: 'footers',
            label: 'Footers',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: MAX_FOOTERS,
          },
          {
            key: 'metrics',
            label: 'Metrics',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: MAX_METRICS,
          },
        ],
      },
    ],
    // Flat list — wrapping anything in `type: 'section'` makes the TS
    // host drop child prop changes silently. Visual grouping is done via
    // disabled "header" rows whose label reads like a divider.
    visualPropEditorDefinition: (chartModel) => ({
      elements: [
        { key: 'layout',         type: 'dropdown', label: 'Card layout',            values: LAYOUT_OPTIONS,   defaultValue: 'split' },
        { key: 'icon',           type: 'dropdown', label: 'Header icon',            values: ICON_OPTIONS,     defaultValue: 'none' },
        { key: 'currencySymbol', type: 'dropdown', label: 'Currency symbol prefix', values: CURRENCY_OPTIONS, defaultValue: '€' },
        { key: 'greenRedBySign', type: 'checkbox', label: 'Green/Red for +/- for Primary Values', defaultValue: false },
        sectionHeader('hdrPrimaries', '── PRIMARY VALUES ──'),
        ...buildItemSections(chartModel, 'primary', 'primaries', MAX_PRIMARIES, palette),
        sectionHeader('hdrFooters',   '── FOOTERS ──'),
        ...buildItemSections(chartModel, 'footer', 'footers', MAX_FOOTERS, palette),
        sectionHeader('hdrMetrics',   '── METRICS ──'),
        ...buildItemSections(chartModel, 'metric', 'metrics', MAX_METRICS, palette),
      ],
    }),
    onPropChange: (propKey) => {
      if (propChangeTimer) clearTimeout(propChangeTimer);
      if (typeof propKey === 'string' && TEXT_PROP_KEYS.has(propKey)) {
        propChangeTimer = setTimeout(() => {
          propChangeTimer = null;
          renderChart(ctx);
        }, TEXT_PROP_DEBOUNCE_MS);
      } else {
        propChangeTimer = null;
        renderChart(ctx);
      }
    },
  });

  ctx.on(TSToChartEvent.DataUpdate, (payload) => {
    const merged = lastModel
      ? { ...lastModel, data: payload?.data ?? lastModel.data }
      : null;
    renderChart(ctx, merged);
    return { triggerRenderChart: false };
  });
  ctx.on(TSToChartEvent.ChartModelUpdate, (payload) => {
    renderChart(ctx, payload?.chartModel);
    return { triggerRenderChart: false };
  });

  renderChart(ctx);
})();
