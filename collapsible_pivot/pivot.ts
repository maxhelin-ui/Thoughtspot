import {
    ChartToTSEvent,
    ColumnTimeBucket,
    ColumnType,
    DataType,
    getChartContext,
    CustomChartContext,
    ChartModel,
    ChartConfig,
    DataPointsArray,
    Query,
    RenderErrorEventPayload,
} from '@thoughtspot/ts-chart-sdk';
import numeral from 'numeral';

// Collapsible Pivot
// -----------------
// A pivot table whose COLUMN groups collapse (the row-collapsing you get in
// Excel, but applied to columns). Attributes bound to "Column groups" form a
// hierarchy — one nesting level per bound attribute — and any group header can
// be collapsed. Per spec: a collapsed group keeps its FIRST member visible as
// the stand-in for the whole group, and collapsing cascades, so nested groups
// collapse underneath each other. Nesting is optional: bind one attribute (or
// none) and you get a flat table.
//
// Rendered as a plain HTML table — no Highcharts. See LESSONS.md.

interface VisualProps {
    chartTitle?: string;
    numberFormat?: string;
    currency?: string;
    defaultCollapsed?: boolean;
    showRowTotals?: boolean;
    showGrandTotalRow?: boolean;
    stripedRows?: boolean;
    showGridLines?: boolean;
    [key: string]: any;
}

type Col = { id: string; name: string; dataType?: DataType; timeBucket?: ColumnTimeBucket };

const CURRENCY_OPTIONS = ['None', '$', '€', '£', '¥', '₹', 'kr'];

// Separator for composite lookup keys. NUL can't appear in real cell
// values, so joining/splitting on it is unambiguous (a space would not be).
const SEP = '\u0000';

// Collapse state, persisted for the page lifetime (survives re-renders the
// same way the other charts keep their button state). Two explicit sets plus
// a default, so flipping the "start collapsed" setting still lets per-group
// clicks win.
const explicitCollapsed = new Set<string>();
const explicitExpanded = new Set<string>();

let globalAppConfig: any = null;

// ---------- formatting ----------

function formatNumber(value: number, format: string): string {
    try {
        return numeral(value).format(format);
    } catch {
        return String(value);
    }
}

function formatPercent(value: number): string {
    // ThoughtSpot percentages come through as decimals (0.85 = 85%).
    try {
        return numeral(value).format('0.[0]%');
    } catch {
        return `${(value * 100).toFixed(1)}%`;
    }
}

function formatCurrency(value: number, format: string, currency: string): string {
    const base = formatNumber(value, format.replace(/^[$€£¥₹]/, ''));
    return currency && currency !== 'None' ? `${currency}${base}` : base;
}

function detectPercentByName(name: string): boolean {
    return /%|\bpct\b|percent|percentage|\brate\b|\bratio\b|\bshare\b/i.test(name ?? '');
}

function naturalCompare(a: string, b: string): number {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function isDateLikeCol(col?: Col): boolean {
    if (!col) return false;
    if (col.dataType === DataType.DATE || col.dataType === DataType.DATE_TIME) return true;
    if (col.timeBucket != null && col.timeBucket !== ColumnTimeBucket.NO_BUCKET) return true;
    return false;
}

// Date-bucketed columns arrive as epoch-second strings. Format in UTC so the
// viewer's timezone can't shift a bucket across a boundary.
function formatEpochByBucket(raw: string, bucket?: ColumnTimeBucket): string {
    const secs = Number(raw);
    if (!isFinite(secs)) return String(raw);
    const d = new Date(secs * 1000);
    if (isNaN(d.getTime())) return String(raw);
    const utc = (opts: Intl.DateTimeFormatOptions) =>
        d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
    switch (bucket) {
        case ColumnTimeBucket.YEARLY:          return String(d.getUTCFullYear());
        case ColumnTimeBucket.QUARTERLY:       return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
        case ColumnTimeBucket.MONTHLY:         return utc({ month: 'short', year: 'numeric' });
        case ColumnTimeBucket.WEEKLY:          return utc({ month: 'short', day: 'numeric', year: 'numeric' });
        case ColumnTimeBucket.DAILY:           return utc({ month: 'short', day: 'numeric', year: 'numeric' });
        case ColumnTimeBucket.HOURLY:          return utc({ month: 'short', day: 'numeric', hour: 'numeric' });
        case ColumnTimeBucket.DAY_OF_WEEK:     return utc({ weekday: 'short' });
        case ColumnTimeBucket.MONTH_OF_YEAR:   return utc({ month: 'short' });
        case ColumnTimeBucket.QUARTER_OF_YEAR: return `Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
        default:                               return utc({ month: 'short', day: 'numeric', year: 'numeric' });
    }
}

function labelForValue(raw: string, col?: Col): string {
    if (raw === '' || raw == null) return '(blank)';
    return isDateLikeCol(col) ? formatEpochByBucket(raw, col?.timeBucket) : String(raw);
}

// ---------- data model ----------

type DataModel = {
    rowColumns: Col[];
    colColumns: Col[];
    measureColumns: Col[];
    dataArr: DataPointsArray;
};

function getDataModel(chartModel: ChartModel): DataModel {
    const dataArr: DataPointsArray =
        chartModel.data?.[chartModel.data.length - 1]?.data ?? ({ columns: [], dataValue: [] } as any);
    const dims = chartModel.config?.chartConfig?.[0]?.dimensions ?? [];
    const rowColumns     = (dims.find(d => d.key === 'rows')?.columns ?? []) as Col[];
    const colColumns     = (dims.find(d => d.key === 'columns')?.columns ?? []) as Col[];
    const measureColumns = (dims.find(d => d.key === 'measures')?.columns ?? []) as Col[];
    return { rowColumns, colColumns, measureColumns, dataArr };
}

function toNumber(v: unknown): number | null {
    if (v == null || v === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
}

// ---------- column tree ----------

type ColNode = {
    key: string;          // unique, stable across renders (the value path)
    label: string;
    level: number;
    children: ColNode[];
    pathKey: string;      // attribute-value path used for value lookup
    measureId?: string;   // set only on measure-level leaves
};

function isCollapsed(key: string, defaultCollapsed: boolean): boolean {
    if (explicitExpanded.has(key)) return false;
    if (explicitCollapsed.has(key)) return true;
    return defaultCollapsed;
}

// Leaves that are actually on screen. A collapsed node contributes only its
// FIRST child's subtree — recursively, so several collapsed layers still
// resolve down to exactly one visible column.
function visibleLeaves(node: ColNode, defaultCollapsed: boolean): ColNode[] {
    if (node.children.length === 0) return [node];
    if (isCollapsed(node.key, defaultCollapsed)) {
        return visibleLeaves(node.children[0], defaultCollapsed);
    }
    const out: ColNode[] = [];
    for (const c of node.children) out.push(...visibleLeaves(c, defaultCollapsed));
    return out;
}

function nodesAtLevel(roots: ColNode[], level: number, defaultCollapsed: boolean): ColNode[] {
    const out: ColNode[] = [];
    const walk = (n: ColNode) => {
        if (n.level === level) { out.push(n); return; }
        if (n.level > level || n.children.length === 0) return;
        const kids = isCollapsed(n.key, defaultCollapsed) ? [n.children[0]] : n.children;
        for (const c of kids) walk(c);
    };
    for (const r of roots) walk(r);
    return out;
}

// ---------- messages ----------

function showMessage(text: string) {
    const wrap = document.getElementById('tableWrap');
    const msg  = document.getElementById('message');
    const title = document.getElementById('chartTitle');
    if (wrap) wrap.innerHTML = '';
    if (title) title.className = 'hidden';
    if (!msg) return;
    msg.textContent = text;
    msg.className = '';
}

function hideMessage() {
    const msg = document.getElementById('message');
    if (msg) msg.className = 'hidden';
}

// ---------- render ----------

function render(ctx: CustomChartContext) {
    const chartModel = ctx.getChartModel();
    const { rowColumns, colColumns, measureColumns, dataArr } = getDataModel(chartModel);
    const visualProps = (chartModel.visualProps ?? {}) as VisualProps;

    if (measureColumns.length === 0) {
        showMessage('Add at least one measure to render this pivot.');
        return;
    }
    if (rowColumns.length === 0) {
        showMessage('Add at least one attribute to "Rows" to render this pivot.');
        return;
    }
    hideMessage();

    // Trim so the editor's ' ' placeholder default counts as "no title".
    const chartTitle        = (visualProps.chartTitle ?? '').trim();
    const numberFormat      = visualProps.numberFormat      ?? '0,0.[0]a';
    const currency          = visualProps.currency          ?? 'None';
    const defaultCollapsed  = visualProps.defaultCollapsed  ?? false;
    const showRowTotals     = visualProps.showRowTotals     ?? false;
    const showGrandTotalRow = visualProps.showGrandTotalRow ?? false;
    const stripedRows       = visualProps.stripedRows       ?? true;
    const showGridLines     = visualProps.showGridLines     ?? true;

    const measureLabel = (c: Col) => {
        const raw = (visualProps[`measureLabel_${c.id}`] ?? '').toString().trim();
        return raw || c.name;
    };
    const measureIsPercent = (c: Col) => {
        const override = visualProps[`measureAsPercent_${c.id}`];
        if (typeof override === 'boolean') return override;
        return detectPercentByName(c.name);
    };
    const fmtMeasure = (v: number | null, c: Col) => {
        if (v == null) return '';
        return measureIsPercent(c) ? formatPercent(v) : formatCurrency(v, numberFormat, currency);
    };

    // Resolve every bound column to its index in the returned data. A missing
    // column (-1) would silently read row[-1] === undefined, so bail loudly.
    const idxOf = (c: Col) => dataArr.columns.indexOf(c.id);
    const rowIdx = rowColumns.map(idxOf);
    const colIdx = colColumns.map(idxOf);
    const measIdx = measureColumns.map(idxOf);
    if (rowIdx.some(i => i < 0) || colIdx.some(i => i < 0) || measIdx.some(i => i < 0)) {
        showMessage('Waiting for data for every bound column…');
        return;
    }

    // ---- aggregate ----
    // sums/counts keyed by rowKey | colPathKey | measureId. Percent measures
    // are averaged (summing percentages is meaningless); everything else sums.
    const sums   = new Map<string, number>();
    const counts = new Map<string, number>();
    const bump = (map: Map<string, number>, cnt: Map<string, number>, key: string, v: number) => {
        map.set(key, (map.get(key) ?? 0) + v);
        cnt.set(key, (cnt.get(key) ?? 0) + 1);
    };
    // Row totals live in their own maps (keyed rowKey|measureId) rather than a
    // magic column path, so they can't collide with or pollute real paths.
    const totalSums   = new Map<string, number>();
    const totalCounts = new Map<string, number>();

    // Every column-path prefix that actually has data, so the tree can skip
    // empty branches without rescanning the value map.
    const pathPrefixes = new Set<string>();

    const rowKeys: string[] = [];
    const rowKeySeen = new Set<string>();
    const rowLabelsByKey = new Map<string, string[]>();
    const rowSortByKey = new Map<string, string[]>();

    // Distinct attribute values per column level, in insertion order.
    const levelValues: Array<Set<string>> = colColumns.map(() => new Set<string>());

    for (const row of dataArr.dataValue ?? []) {
        const rowRaw = rowIdx.map(i => (row[i] == null ? '' : String(row[i])));
        const rKey = rowRaw.join(SEP);
        if (!rowKeySeen.has(rKey)) {
            rowKeySeen.add(rKey);
            rowKeys.push(rKey);
            rowLabelsByKey.set(rKey, rowRaw.map((v, i) => labelForValue(v, rowColumns[i])));
            rowSortByKey.set(rKey, rowRaw);
        }

        const colRaw = colIdx.map(i => (row[i] == null ? '' : String(row[i])));
        colRaw.forEach((v, i) => levelValues[i].add(v));
        const cPath = colRaw.join(SEP);
        for (let n = 1; n <= colRaw.length; n++) pathPrefixes.add(colRaw.slice(0, n).join(SEP));

        measureColumns.forEach((mc, mi) => {
            const v = toNumber(row[measIdx[mi]]);
            if (v == null) return;
            bump(sums, counts, `${rKey}${SEP}${cPath}${SEP}${mc.id}`, v);
            // Row-total bucket: same measure across every column path.
            bump(totalSums, totalCounts, `${rKey}${SEP}${mc.id}`, v);
        });
    }

    if (rowKeys.length === 0) {
        showMessage('No data for the current filters.');
        return;
    }

    const reduce = (s: number | undefined, n: number, mc: Col): number | null => {
        if (s == null) return null;
        if (!measureIsPercent(mc)) return s;
        return n > 0 ? s / n : null;
    };
    const valueAt = (rKey: string, cPath: string, mc: Col): number | null => {
        const k = `${rKey}${SEP}${cPath}${SEP}${mc.id}`;
        return reduce(sums.get(k), counts.get(k) ?? 0, mc);
    };
    const rowTotalAt = (rKey: string, mc: Col): number | null => {
        const k = `${rKey}${SEP}${mc.id}`;
        return reduce(totalSums.get(k), totalCounts.get(k) ?? 0, mc);
    };

    // ---- sort rows ----
    rowKeys.sort((a, b) => {
        const av = rowSortByKey.get(a)!;
        const bv = rowSortByKey.get(b)!;
        for (let i = 0; i < av.length; i++) {
            const col = rowColumns[i];
            const cmp = isDateLikeCol(col)
                ? (Number(av[i]) || 0) - (Number(bv[i]) || 0)
                : naturalCompare(av[i], bv[i]);
            if (cmp !== 0) return cmp;
        }
        return 0;
    });

    // ---- build the column tree ----
    const sortedLevelValues = levelValues.map((set, i) => {
        const arr = Array.from(set);
        const col = colColumns[i];
        arr.sort((a, b) => (isDateLikeCol(col)
            ? (Number(a) || 0) - (Number(b) || 0)
            : naturalCompare(a, b)));
        return arr;
    });

    const multiMeasure = measureColumns.length > 1;
    // Depth: one level per bound column attribute, plus a measure level when
    // more than one measure is bound (with a single measure the deepest
    // attribute level is already the leaf).
    const attrLevels = colColumns.length;
    const totalLevels = attrLevels + (multiMeasure || attrLevels === 0 ? 1 : 0);

    const measureLeaves = (parentPath: string[], level: number): ColNode[] =>
        measureColumns.map(mc => ({
            key: [...parentPath, `m:${mc.id}`].join(SEP),
            label: measureLabel(mc),
            level,
            children: [],
            pathKey: parentPath.join(SEP),
            measureId: mc.id,
        }));

    const buildLevel = (level: number, parentPath: string[]): ColNode[] => {
        if (level >= attrLevels) {
            // Past the attribute hierarchy: either a measure level, or (single
            // measure) nothing — the caller already made the leaf.
            return multiMeasure || attrLevels === 0 ? measureLeaves(parentPath, level) : [];
        }
        const nodes: ColNode[] = [];
        const isLeafLevel = level === attrLevels - 1 && !multiMeasure;
        for (const val of sortedLevelValues[level]) {
            const path = [...parentPath, val];
            const prefix = path.join(SEP);
            // Skip branches with no data under them (a value can exist at this
            // level overall without existing under this particular parent).
            if (!pathPrefixes.has(prefix)) continue;
            const children = buildLevel(level + 1, path);
            if (!isLeafLevel && children.length === 0) continue;
            nodes.push({
                key: prefix,
                label: labelForValue(val, colColumns[level]),
                level,
                children,
                pathKey: prefix,
                measureId: isLeafLevel ? measureColumns[0].id : undefined,
            });
        }
        return nodes;
    };

    const roots = attrLevels === 0
        ? measureLeaves([], 0)
        : buildLevel(0, []);

    if (roots.length === 0) {
        showMessage('No column values to display.');
        return;
    }

    const leaves: ColNode[] = [];
    for (const r of roots) leaves.push(...visibleLeaves(r, defaultCollapsed));

    // Which measure a leaf renders, and which column path it reads.
    const leafMeasure = (leaf: ColNode) =>
        measureColumns.find(m => m.id === leaf.measureId) ?? measureColumns[0];

    // ---- build the DOM ----
    const titleEl = document.getElementById('chartTitle');
    if (titleEl) {
        titleEl.textContent = chartTitle;
        titleEl.className = chartTitle ? '' : 'hidden';
    }

    const table = document.createElement('table');
    table.className = 'pivot'
        + (stripedRows ? ' striped' : '')
        + (showGridLines ? '' : ' no-grid');

    // ---- header ----
    const thead = document.createElement('thead');
    const headerRows: HTMLTableRowElement[] = [];
    for (let l = 0; l < totalLevels; l++) {
        const tr = document.createElement('tr');
        headerRows.push(tr);
        thead.appendChild(tr);
    }

    // Row-label headers span every header row.
    rowColumns.forEach(rc => {
        const th = document.createElement('th');
        th.className = 'row-head';
        th.rowSpan = totalLevels;
        th.textContent = rc.name;
        headerRows[0].appendChild(th);
    });

    for (let l = 0; l < totalLevels; l++) {
        const nodes = nodesAtLevel(roots, l, defaultCollapsed);
        for (const node of nodes) {
            const span = visibleLeaves(node, defaultCollapsed).length;
            const th = document.createElement('th');
            th.colSpan = span;
            const isLeafRow = node.children.length === 0;
            if (isLeafRow) th.className = 'leaf-head';

            const wrapEl = document.createElement('span');
            wrapEl.className = 'grp';

            if (node.children.length > 0) {
                const collapsed = isCollapsed(node.key, defaultCollapsed);
                if (collapsed) wrapEl.className = 'grp collapsed';
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'chev';
                btn.textContent = collapsed ? '▸' : '▾';
                btn.title = collapsed
                    ? `Expand ${node.label} (showing its first column only)`
                    : `Collapse ${node.label}`;
                btn.onclick = () => {
                    if (collapsed) {
                        explicitCollapsed.delete(node.key);
                        explicitExpanded.add(node.key);
                    } else {
                        explicitExpanded.delete(node.key);
                        explicitCollapsed.add(node.key);
                    }
                    render(ctx);
                };
                wrapEl.appendChild(btn);
            }

            const lbl = document.createElement('span');
            lbl.className = 'grp-label';
            lbl.textContent = node.label;
            wrapEl.appendChild(lbl);
            th.appendChild(wrapEl);
            headerRows[l].appendChild(th);
        }
    }

    // Total column headers (one per measure), spanning all header rows.
    if (showRowTotals) {
        measureColumns.forEach(mc => {
            const th = document.createElement('th');
            th.className = 'total-head leaf-head';
            th.rowSpan = totalLevels;
            th.textContent = multiMeasure ? `Total — ${measureLabel(mc)}` : 'Total';
            headerRows[0].appendChild(th);
        });
    }

    table.appendChild(thead);

    // ---- body ----
    const tbody = document.createElement('tbody');
    for (const rKey of rowKeys) {
        const tr = document.createElement('tr');
        // Rows are a flat list — the grouping/outline in this chart is on the
        // columns only, so every row prints its own label.
        const labels = rowLabelsByKey.get(rKey) ?? [];
        labels.forEach(lab => {
            const td = document.createElement('td');
            td.className = 'row-label';
            td.textContent = lab;
            tr.appendChild(td);
        });

        for (const leaf of leaves) {
            const mc = leafMeasure(leaf);
            const td = document.createElement('td');
            td.textContent = fmtMeasure(valueAt(rKey, leaf.pathKey, mc), mc);
            tr.appendChild(td);
        }

        if (showRowTotals) {
            measureColumns.forEach(mc => {
                const td = document.createElement('td');
                td.className = 'total-cell';
                td.textContent = fmtMeasure(rowTotalAt(rKey, mc), mc);
                tr.appendChild(td);
            });
        }
        tbody.appendChild(tr);
    }

    // ---- grand total row ----
    if (showGrandTotalRow) {
        const tr = document.createElement('tr');
        tr.className = 'grand-total';
        rowColumns.forEach((_, i) => {
            const td = document.createElement('td');
            td.className = 'row-label';
            td.textContent = i === 0 ? 'Grand total' : '';
            tr.appendChild(td);
        });

        const totalOver = (pick: (rKey: string, mc: Col) => number | null, mc: Col): number | null => {
            let s = 0; let n = 0;
            for (const rKey of rowKeys) {
                const v = pick(rKey, mc);
                if (v == null) continue;
                s += v; n += 1;
            }
            if (n === 0) return null;
            return measureIsPercent(mc) ? s / n : s;
        };

        for (const leaf of leaves) {
            const mc = leafMeasure(leaf);
            const td = document.createElement('td');
            td.textContent = fmtMeasure(totalOver(rk => valueAt(rk, leaf.pathKey, mc), mc), mc);
            tr.appendChild(td);
        }
        if (showRowTotals) {
            measureColumns.forEach(mc => {
                const td = document.createElement('td');
                td.className = 'total-cell';
                td.textContent = fmtMeasure(totalOver(rk => rowTotalAt(rk, mc), mc), mc);
                tr.appendChild(td);
            });
        }
        tbody.appendChild(tr);
    }

    table.appendChild(tbody);

    const wrap = document.getElementById('tableWrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    wrap.appendChild(table);

    applyStickyOffsets(table, rowColumns.length, totalLevels);

    console.log('[Collapsible Pivot]', {
        rows: rowColumns.map(c => c.name),
        columnGroups: colColumns.map(c => c.name),
        measures: measureColumns.map(c => c.name),
        rowCount: rowKeys.length,
        visibleLeafColumns: leaves.length,
        collapsed: Array.from(explicitCollapsed),
    });
}

// Sticky headers/left columns need explicit top/left offsets once the browser
// has laid the table out — they can't be expressed in CSS alone because each
// header row and label column has its own measured size.
function applyStickyOffsets(table: HTMLTableElement, rowLabelCount: number, headerRowCount: number) {
    const headRows = Array.from(table.tHead?.rows ?? []);
    let top = 0;
    for (let r = 0; r < headRows.length; r++) {
        const cells = Array.from(headRows[r].cells) as HTMLTableCellElement[];
        for (const c of cells) {
            if (c.rowSpan > 1 && r === 0) c.style.top = '0px';
            else c.style.top = `${top}px`;
        }
        top += headRows[r].getBoundingClientRect().height;
    }

    // Left offsets: measure the first body row's label cells.
    const firstBodyRow = table.tBodies[0]?.rows[0];
    if (!firstBodyRow) return;
    const widths: number[] = [];
    for (let i = 0; i < rowLabelCount; i++) {
        const cell = firstBodyRow.cells[i] as HTMLTableCellElement | undefined;
        widths.push(cell ? cell.getBoundingClientRect().width : 0);
    }
    const lefts: number[] = [];
    let acc = 0;
    for (let i = 0; i < rowLabelCount; i++) { lefts.push(acc); acc += widths[i]; }

    // Header row-label cells live on header row 0 (they rowSpan the rest).
    const headLabelCells = Array.from(headRows[0]?.cells ?? []).slice(0, rowLabelCount);
    headLabelCells.forEach((c, i) => { (c as HTMLElement).style.left = `${lefts[i]}px`; });

    for (const row of Array.from(table.tBodies[0].rows)) {
        for (let i = 0; i < rowLabelCount; i++) {
            const cell = row.cells[i] as HTMLElement | undefined;
            if (cell) cell.style.left = `${lefts[i]}px`;
        }
    }
}

// ---------- SDK wiring ----------

const renderChart = async (ctx: CustomChartContext) => {
    if (!globalAppConfig) {
        try { globalAppConfig = (ctx as any).getAppConfig?.() ?? null; } catch { /* noop */ }
    }
    try {
        ctx.emitEvent(ChartToTSEvent.RenderStart);
        render(ctx);
        ctx.emitEvent(ChartToTSEvent.RenderComplete);
    } catch (error) {
        console.error('Collapsible Pivot render error:', error);
        ctx.emitEvent(ChartToTSEvent.RenderError, { hasError: true, error } as RenderErrorEventPayload);
    }
};

(async () => {
    const ctx = await getChartContext({
        getDefaultChartConfig: (chartModel: ChartModel): ChartConfig[] => {
            const cols = chartModel.columns ?? [];
            // ColumnType is UNKNOWN=0, MEASURE=1, ATTRIBUTE=2 — use the enum,
            // never a literal. Getting this backwards seeds a measure into the
            // attribute-only Rows slot, which the host rejects at init with
            // "Cannot display the custom chart".
            const attributes = cols.filter((c: any) => c.type === ColumnType.ATTRIBUTE);
            const measures   = cols.filter((c: any) => c.type === ColumnType.MEASURE);
            return [
                {
                    key: 'column',
                    dimensions: [
                        { key: 'rows',     columns: attributes.slice(0, 1) },
                        { key: 'columns',  columns: attributes.slice(1, 2) },
                        { key: 'measures', columns: measures.slice(0, 1) },
                    ],
                },
            ];
        },
        getQueriesFromChartConfig: (chartConfig: ChartConfig[], chartModel: ChartModel): Query[] => {
            // Must return at least one query holding at least one column, or
            // the SDK validator rejects it and the chart won't load at all.
            const queries = (chartConfig ?? []).map(config => ({
                queryColumns: (config?.dimensions ?? []).flatMap(d => d?.columns ?? []),
            })).filter(q => q.queryColumns.length > 0);
            if (queries.length > 0) {
                // Pivots fan out across the row × column cross-product, so push
                // past the default row cap (see LESSONS.md on truncation).
                return queries.map(q => ({ ...q, queryParams: { size: 100000 } })) as any;
            }
            const placeholder = chartModel?.columns?.[0];
            return placeholder ? ([{ queryColumns: [placeholder] }] as any) : [];
        },
        renderChart,
        chartConfigEditorDefinition: [
            {
                key: 'column',
                label: 'Layout',
                descriptionText:
                    'Rows = the left-hand labels (one attribute, flat — grouping in this chart is on columns only). Column groups = one nesting level per attribute (first = outermost); each group header can be collapsed, and a collapsed group keeps its first column visible. Measures fill the cells.',
                columnSections: [
                    {
                        key: 'rows',
                        label: 'Rows',
                        allowAttributeColumns: true,
                        allowMeasureColumns: false,
                        allowTimeSeriesColumns: true,
                        maxColumnCount: 1,
                    },
                    {
                        key: 'columns',
                        label: 'Column groups (outermost first)',
                        allowAttributeColumns: true,
                        allowMeasureColumns: false,
                        allowTimeSeriesColumns: true,
                        maxColumnCount: 4,
                    },
                    {
                        key: 'measures',
                        label: 'Measures',
                        allowAttributeColumns: false,
                        allowMeasureColumns: true,
                        allowTimeSeriesColumns: false,
                        maxColumnCount: 6,
                    },
                ],
            },
        ],
        visualPropEditorDefinition: (chartModel: ChartModel) => {
            const dims = chartModel?.config?.chartConfig?.[0]?.dimensions ?? [];
            const measures = (dims.find(d => d.key === 'measures')?.columns ?? []) as Col[];

            const perMeasure: any[] = [];
            measures.forEach(mc => {
                perMeasure.push(
                    { key: `measureLabel_${mc.id}`,     type: 'text',     defaultValue: ' ',  label: `Label: ${mc.name}` },
                    { key: `measureAsPercent_${mc.id}`, type: 'checkbox', defaultValue: detectPercentByName(mc.name), label: `Treat "${mc.name}" as a percent (averaged)` },
                );
            });

            return {
                elements: [
                    { key: 'chartTitle',        type: 'text',     defaultValue: ' ',        label: 'Title' },
                    { key: 'numberFormat',      type: 'text',     defaultValue: '0,0.[0]a', label: 'Number format' },
                    { key: 'currency',          type: 'dropdown', defaultValue: 'None',     values: CURRENCY_OPTIONS, label: 'Currency symbol' },
                    { key: 'defaultCollapsed',  type: 'checkbox', defaultValue: false,      label: 'Start with column groups collapsed' },
                    { key: 'showRowTotals',     type: 'checkbox', defaultValue: false,      label: 'Show total column' },
                    { key: 'showGrandTotalRow', type: 'checkbox', defaultValue: false,      label: 'Show grand total row' },
                    { key: 'stripedRows',       type: 'checkbox', defaultValue: true,       label: 'Striped rows' },
                    { key: 'showGridLines',     type: 'checkbox', defaultValue: true,       label: 'Show column dividers' },
                    ...perMeasure,
                ],
            };
        },
    });

    renderChart(ctx);
})();
