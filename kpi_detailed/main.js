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
 *   - Metric 1
 *   - Metric 2
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
  'plus-minus':
    '<svg viewBox="0 0 24 24"><line x1="7" y1="7" x2="15" y2="7"/><line x1="11" y1="3" x2="11" y2="11"/><line x1="9" y1="18" x2="17" y2="18"/></svg>',
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

function isSlotBound(chartModel, key) {
  return !!getDimColumn(chartModel, key);
}

// Aggregate this column's values into a single number for the card.
// Single-row results (the common case for a KPI with no group-by) just
// return that one value. Multi-row results get aggregated according to
// the column's declared aggregationType — averaging an AVERAGE/MEDIAN
// column instead of naively summing it, which is why the chart number
// could disagree with the worksheet table.
function sumForKey(chartModel, key) {
  const dataArr = chartModel?.data?.[0]?.data ?? null;
  if (!dataArr) return null;
  const col = getDimColumn(chartModel, key);
  if (!col) return null;
  const values = getDataForColumn(col, dataArr).filter((v) => v != null);
  if (!values.length) return null;
  if (values.length === 1) return values[0];

  const aggName = String(col.aggregationType ?? '').toUpperCase();
  const isAvgLike =
    aggName.includes('AVERAGE') ||
    aggName.includes('MEDIAN') ||
    aggName.includes('PERCENTILE');
  const isMin = aggName.includes('MIN');
  const isMax = aggName.includes('MAX');

  if (isAvgLike) return _.sum(values) / values.length;
  if (isMin) return _.min(values);
  if (isMax) return _.max(values);
  return _.sum(values);
}

// ---------- rendering ----------

function applyCardStyles(vp) {
  const root = document.documentElement;
  // One colour per side now — both the percent text and its progress bar
  // use the same colour. primaryColor / secondaryColor are the new
  // single-source-of-truth settings; the older primaryAccentColor /
  // primaryBarColor (and secondary counterparts) are honoured as
  // fallbacks for charts saved before the merge.
  const primary   = vp?.primaryColor   ?? vp?.primaryAccentColor   ?? vp?.primaryBarColor;
  const secondary = vp?.secondaryColor ?? vp?.secondaryAccentColor ?? vp?.secondaryBarColor;
  if (primary) {
    root.style.setProperty('--ts-accent', primary);
    root.style.setProperty('--ts-accent-bar', primary);
  }
  if (secondary) {
    root.style.setProperty('--ts-secondary-accent', secondary);
    root.style.setProperty('--ts-secondary-accent-bar', secondary);
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text ?? '';
}

// When the 'colourBySign' visualProp is on, render any displayed numeric
// value with a green/red colour based on the raw value's sign (zero stays
// the inherited colour). Helpers below colour individual text spans
// (singleValue, msMainValue, etc.) and build the main+secondary footer
// line as HTML so the secondary and footer values can be coloured
// independently.
const SIGN_GREEN = '#038922';
const SIGN_RED   = '#D54035';

function colourForValue(v, on) {
  if (!on || v == null || isNaN(v)) return '';
  if (v > 0) return SIGN_GREEN;
  if (v < 0) return SIGN_RED;
  return '';
}

function setTextColoured(id, text, colour) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text ?? '';
  el.style.color = colour || '';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function renderHeader(vp) {
  // One icon per layout (each detail card has its own slot). Update
  // every [data-icon-slot] so both single + split stay in sync.
  const key = vp?.icon ?? 'trending-up';
  const svg = ICON_SVG[key] ?? '';
  document.querySelectorAll('[data-icon-slot]').forEach((iconEl) => {
    iconEl.innerHTML = svg;
    iconEl.classList.toggle('hidden', !svg);
  });
}

// Compose the "{footer} · {avgLabel} {avgValue}" line. Shared by both
// single and split layouts so the configured footer text + bound
// footerAvg measure render identically regardless of mode.
function composeFooterLine(vp, values, chartModel, fraction) {
  const baseFormatted = values.primaryPercent != null
    ? formatMetricValue(values.primaryPercent, 'number', vp?.numberFormat, vp?.currencySymbol)
    : '';
  const valueFormatted = values.primaryValue != null
    ? formatMetricValue(values.primaryValue, 'number', vp?.numberFormat, vp?.currencySymbol)
    : '';
  const percentFormatted = formatPercent(fraction);

  const footerText = (vp?.primaryFooter ?? '').trim()
    .replace(/\{base\}/g, baseFormatted)
    .replace(/\{value\}/g, valueFormatted)
    .replace(/\{percent\}/g, percentFormatted);

  const avgFormatted = values.footerAvg != null
    ? formatMetricValue(values.footerAvg, vp?.footerAvgFormat ?? 'currency', vp?.numberFormat, vp?.currencySymbol)
    : '';

  let avgPart = '';
  if (avgFormatted) {
    const avgLabel = labelOrColumnName(vp?.footerAvgLabel, getColumnName(chartModel, 'footerAvg'));
    avgPart = avgLabel ? `${avgLabel} ${avgFormatted}` : avgFormatted;
  }

  return footerText && avgPart
    ? `${footerText} · ${avgPart}`
    : (footerText || avgPart);
}

// Always abbreviates with K/M/B; the format argument decides whether the
// currency prefix is applied ('currency'), plain number ('number'), or
// percent ('percent'). Falls back to currency for backwards-compat with
// the older primaryAsNumber boolean shape.
function formatBigValue(v, vp, format) {
  if (v == null) return '';
  // Back-compat: if 'format' isn't passed, derive from primaryAsNumber.
  const mode = format ?? (vp?.primaryAsNumber === true ? 'number' : 'currency');
  return formatMetricValue(v, mode, vp?.numberFormat, vp?.currencySymbol);
}

function renderSingle(vp, values, chartModel) {
  const hasPrimary  = isSlotBound(chartModel, 'primaryValue');
  const hasBase     = isSlotBound(chartModel, 'primaryPercent');
  const hasFootAvg  = isSlotBound(chartModel, 'footerAvg');
  const footerText  = (vp?.primaryFooter ?? '').trim();
  // If nothing in this layout is bound, drop the whole grey card so the
  // chart shows only what the user actually configured (e.g. just the
  // footer metric tiles).
  const showLayout  = hasPrimary || hasBase || hasFootAvg || !!footerText;

  setHidden('singleLayout', !showLayout);
  setHidden('splitLayout', true);
  setHidden('mainSecLayout', true);
  if (!showLayout) return;

  setHidden('singleStatRow',     !hasPrimary);
  setHidden('singleProgressRow', !hasBase);

  setText('singleValue', formatBigValue(values.primaryValue, vp, vp?.primaryFormat ?? (vp?.primaryAsNumber ? 'number' : 'currency')));
  setText('singleSuffix', hasPrimary ? (vp?.primarySuffix ?? '') : '');
  const desc = (vp?.primaryDescription ?? '').trim();
  setText('singleDescription', hasPrimary && desc ? `· ${desc}` : '');

  const fraction = computeBarFraction(values.primaryValue, values.primaryPercent, vp?.primaryPercentMode ?? 'ratio');
  const percentFormatted = formatPercent(fraction);

  const footerLine = composeFooterLine(vp, values, chartModel, fraction);
  setHidden('singleFooter', !footerLine);
  setText('singleFooter', footerLine);

  setText('singlePercent', percentFormatted);

  const fill = document.getElementById('singleBarFill');
  if (fill) {
    fill.style.width = clampPercentFill(fraction) + '%';
    fill.style.background = 'var(--ts-accent-bar)';
  }
  const label = document.getElementById('singlePercent');
  if (label) label.style.color = 'var(--ts-accent)';
}

function renderSplit(vp, values, chartModel) {
  const hasPrimary    = isSlotBound(chartModel, 'primaryValue');
  const hasSecondary  = isSlotBound(chartModel, 'secondaryValue');
  const hasLeftBase   = isSlotBound(chartModel, 'primaryPercent');
  const hasRightBase  = isSlotBound(chartModel, 'secondaryPercent');
  const hasFootAvg    = isSlotBound(chartModel, 'footerAvg');
  const footerText    = (vp?.primaryFooter ?? '').trim();
  const showLayout    = hasPrimary || hasSecondary || hasFootAvg || !!footerText;

  setHidden('singleLayout', true);
  setHidden('splitLayout', !showLayout);
  setHidden('mainSecLayout', true);
  if (!showLayout) return;

  setHidden('splitLeftSide',     !hasPrimary);
  setHidden('splitRightSide',    !hasSecondary);
  setHidden('splitDivider',      !(hasPrimary && hasSecondary));
  setHidden('leftProgressRow',   !hasLeftBase);
  setHidden('rightProgressRow',  !hasRightBase);

  setText('leftLabel', labelOrColumnName(vp?.leftLabel, getColumnName(chartModel, 'primaryValue')));
  setText('leftValue', formatBigValue(values.primaryValue, vp, vp?.primaryFormat ?? (vp?.primaryAsNumber ? 'number' : 'currency')));
  setText('leftSuffix', hasPrimary ? (vp?.primarySuffix ?? '') : '');
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
  setText('rightValue', formatBigValue(values.secondaryValue, vp, vp?.secondaryFormat ?? 'currency'));
  setText('rightSuffix', hasSecondary ? (vp?.secondarySuffix ?? vp?.primarySuffix ?? '') : '');
  const rightFraction = computeBarFraction(values.secondaryValue, values.secondaryPercent, vp?.secondaryPercentMode ?? 'ratio');
  setText('rightPercent', formatPercent(rightFraction));
  const rightFill = document.getElementById('rightBarFill');
  if (rightFill) {
    rightFill.style.width = clampPercentFill(rightFraction) + '%';
    rightFill.style.background = 'var(--ts-secondary-accent-bar)';
  }
  const rightLabelEl = document.getElementById('rightPercent');
  if (rightLabelEl) rightLabelEl.style.color = 'var(--ts-secondary-accent)';

  const footerLine = composeFooterLine(vp, values, chartModel, leftFraction);
  setHidden('splitFooter', !footerLine);
  setText('splitFooter', footerLine);
}

// Compact "main + secondary" layout: big primary value on top, then a
// single footer line that joins the secondary value and the footerAvg
// value with a " · " separator. Footer line uses a larger font than the
// stat-footer in the single / split layouts so it reads as a key piece
// of context rather than a fine-print line.
function renderMainSecondary(vp, values, chartModel) {
  const hasPrimary   = isSlotBound(chartModel, 'primaryValue');
  const hasSecondary = isSlotBound(chartModel, 'secondaryValue');
  const showLayout   = hasPrimary || hasSecondary;

  setHidden('singleLayout', true);
  setHidden('splitLayout', true);
  setHidden('mainSecLayout', !showLayout);
  if (!showLayout) return;

  setHidden('msMainRow', !hasPrimary);

  // Title (msMainLabel) intentionally not set — main+secondary layout
  // drops the column-name title above the big value. CSS also hides
  // #msMainLabel inside .ts-main-sec so it doesn't reserve any vertical
  // space.
  setText('msMainLabel', '');
  setTextColoured(
    'msMainValue',
    formatBigValue(values.primaryValue, vp, vp?.primaryFormat ?? (vp?.primaryAsNumber ? 'number' : 'currency')),
    colourForValue(values.primaryValue, vp?.colourBySign),
  );
  setText('msMainSuffix', hasPrimary ? (vp?.primarySuffix ?? '') : '');

  // Footer line = "<secondary value+suffix> · <footerAvg value> <label>"
  // — value first, then label (with a space between), per the user's
  // request to flip the order so values lead and labels read as units.
  const secValueFormatted = hasSecondary
    ? formatBigValue(values.secondaryValue, vp, vp?.secondaryFormat ?? 'currency')
    : '';
  const secSuffix = hasSecondary ? (vp?.secondarySuffix ?? vp?.primarySuffix ?? '') : '';
  const secPart = hasSecondary
    ? `${secValueFormatted}${secSuffix ? ' ' + secSuffix : ''}`.trim()
    : '';

  const avgFormatted = values.footerAvg != null
    ? formatMetricValue(values.footerAvg, vp?.footerAvgFormat ?? 'currency', vp?.numberFormat, vp?.currencySymbol)
    : '';
  const avgLabel = labelOrColumnName(vp?.footerAvgLabel, getColumnName(chartModel, 'footerAvg'));
  // value first, label after.
  const avgPart = avgFormatted
    ? `${avgFormatted}${avgLabel ? ` ${avgLabel}` : ''}`.trim()
    : '';

  let footerLine = '';
  if (secPart && avgPart) footerLine = `${secPart} · ${avgPart}`;
  else if (secPart)       footerLine = secPart;
  else if (avgPart)       footerLine = avgPart;

  setHidden('msFooterLine', !footerLine);
  setText('msFooterLine', footerLine);
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

let lastModel = null;
let globalAppConfig = null;

// Visual-prop keys whose editor is a free-text input. Typing into these
// fires onPropChange on every keystroke, so we hold renders for 2s of
// idle before applying — otherwise the chart flashes on every letter.
// Dropdowns / colorpickers / checkboxes commit once per click and render
// immediately.
const TEXT_PROP_KEYS = new Set([
  'primarySuffix', 'primaryDescription', 'primaryFooter',
  'footerAvgLabel', 'leftLabel', 'rightLabel',
  'metric1Label', 'metric2Label', 'numberFormat', 'currencySymbol',
  'secondarySuffix',
]);
const TEXT_PROP_DEBOUNCE_MS = 2000;

const FALLBACK_PALETTE = ['#7F77DD', '#888780', '#534AB7', '#5F5E5A'];

function getEffectivePalette() {
    const palettes = globalAppConfig?.styleConfig?.chartColorPalettes;
    if (Array.isArray(palettes) && palettes.length > 0
        && Array.isArray(palettes[0]?.colors) && palettes[0].colors.length > 0) {
        return palettes[0].colors;
    }
    return FALLBACK_PALETTE;
}

function renderChartMessage(text) {
  const el = document.getElementById('chart');
  if (!el) return;
  el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6B7280;font-size:14px;font-family:inherit;text-align:center;padding:20px;">${text}</div>`;
}

function render(ctx, providedModel) {
  // When DataUpdate / ChartModelUpdate fires we pass the fresh model/data
  // straight in; otherwise fetch from ctx. Avoids races where
  // getChartModel() returns stale numbers after a formula edit.
  const modelPromise = providedModel
    ? Promise.resolve(providedModel)
    : Promise.resolve(ctx.getChartModel());
  return modelPromise.then((chartModel) => {
    lastModel = chartModel;

    // Empty-state: no slots bound at all. Show a helpful message instead of
    // rendering NaN/blank text from null values.
    const dims0 = chartModel?.config?.chartConfig?.[0]?.dimensions ?? [];
    const anyBound = dims0.some((d) => (d?.columns?.length ?? 0) > 0);
    if (!anyBound) {
      renderChartMessage('Add at least a Primary value column to render this KPI.');
      return;
    }

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

    // Surface the raw query result + computed values so any chart-vs-
    // table discrepancy can be traced from the browser devtools.
    const dims = chartModel?.config?.chartConfig?.[0]?.dimensions ?? [];
    console.log('[KPI - Detailed]', {
      bindings: dims.map((d) => ({
        slot: d?.key,
        column: d?.columns?.[0]?.name,
        aggregationType: d?.columns?.[0]?.aggregationType,
      })),
      rawRows: chartModel?.data?.[0]?.data?.dataValue,
      computedValues: values,
    });

    renderHeader(vp);

    const mode = vp?.mode ?? 'single';
    if (mode === 'split') {
      renderSplit(vp, values, chartModel);
    } else if (mode === 'main-secondary') {
      renderMainSecondary(vp, values, chartModel);
    } else {
      renderSingle(vp, values, chartModel);
    }

    renderFooterMetrics(vp, values, chartModel);
  });
}

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

(async () => {
  let propChangeTimer = null;
  const ctx = await getChartContext({
    // Leave every slot empty by default. Previously this auto-bound
    // measureCols[0..6] to slots in order, which meant adding or removing
    // a column in the worksheet would shift every binding (e.g. removing
    // the first measure would slide everything one slot to the left).
    // Empty defaults force the user to bind each slot explicitly so the
    // layout stays exactly where they put it, regardless of worksheet edits.
    getDefaultChartConfig: () => [
      {
        key: 'column',
        dimensions: [
          { key: 'primaryValue', columns: [] },
          { key: 'primaryPercent', columns: [] },
          { key: 'secondaryValue', columns: [] },
          { key: 'secondaryPercent', columns: [] },
          { key: 'metric1', columns: [] },
          { key: 'metric2', columns: [] },
          { key: 'footerAvg', columns: [] },
        ],
      },
    ],
    getQueriesFromChartConfig: (chartConfig, chartModel) => {
      // TS's host validator (validateGetDataForQueryEventPayloadObject)
      // requires every query to have at least 1 column. With our intentionally
      // empty-by-default slots, the natural reduce produces { queryColumns: [] }
      // and TS rejects it with "queries[0].queryColumns must contain at least
      // 1 items" → the chart fails to load (55009). Fix: filter empty queries,
      // and if none remain include a placeholder column so init can proceed.
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
            label: 'Metric 1',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'metric2',
            label: 'Metric 2',
            allowAttributeColumns: true,
            allowMeasureColumns: true,
            allowTimeSeriesColumns: false,
            maxColumnCount: 1,
          },
          {
            key: 'footerAvg',
            label: 'Footer value (appended to footer line)',
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
        { key: 'mode', type: 'dropdown', label: 'Card layout', defaultValue: 'single', values: ['single', 'split', 'main-secondary'] },
        {
          key: 'icon',
          type: 'dropdown',
          label: 'Header icon',
          defaultValue: 'trending-up',
          values: ['trending-up', 'arrows-up', 'calendar-repeat', 'clock', 'chart-pie', 'plus-minus', 'none'],
        },
        { key: 'primarySuffix', type: 'text', label: 'Suffix after big number', defaultValue: 'accounts' },
        { key: 'primaryDescription', type: 'text', label: 'Description (single layout)', defaultValue: ' ' },
        { key: 'primaryFooter', type: 'text', label: 'Footer line — tokens: {base}, {value}, {percent}', defaultValue: 'of {base} closed accounts' },
        { key: 'footerAvgLabel', type: 'text', label: 'Footer value label (blank = use bound column name)', defaultValue: ' ' },
        {
          key: 'footerAvgFormat',
          type: 'dropdown',
          label: 'Footer value format',
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
        { key: 'primaryColor', type: 'colorpicker', label: 'Primary colour (percent text + bar)', defaultValue: getEffectivePalette()[0] ?? '#534AB7' },
        { key: 'colourBySign', type: 'checkbox', label: 'Colour main+secondary primary by sign (positive = green, negative = red)', defaultValue: false },
        {
          key: 'primaryFormat',
          type: 'dropdown',
          label: 'Primary value format',
          defaultValue: 'currency',
          values: ['currency', 'number', 'percent'],
        },
        { key: 'secondarySuffix', type: 'text', label: 'Secondary suffix (split)', defaultValue: 'accounts' },
        { key: 'rightLabel', type: 'text', label: 'Right label (split, blank = use Secondary value column name)', defaultValue: ' ' },
        {
          key: 'secondaryPercentMode',
          type: 'dropdown',
          label: 'Secondary bar calculation',
          defaultValue: 'ratio',
          values: ['ratio', 'as-is'],
        },
        { key: 'secondaryColor', type: 'colorpicker', label: 'Secondary colour (percent text + bar)', defaultValue: getEffectivePalette()[1] ?? '#5F5E5A' },
        {
          key: 'secondaryFormat',
          type: 'dropdown',
          label: 'Secondary value format',
          defaultValue: 'currency',
          values: ['currency', 'number', 'percent'],
        },
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

  // Use the event payload directly when the SDK pushes an update — the
  // cached chartModel returned by ctx.getChartModel() can lag behind the
  // payload by a tick, which is how a formula edit ended up rendering a
  // stale number.
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
