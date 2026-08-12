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

// Searches here run to 100+ columns, and the point of this chart is to tame a
// wide table by grouping it — so allow plenty of measures rather than the
// handful a normal chart would want.
const MAX_MEASURES = 60;

// Row attributes render as flat, side-by-side label columns on the left —
// one column each, no hierarchy and no collapsing. (Grouping/collapsing in
// this chart is columns-only; "no nested rows" means no row outline, not
// "only one row attribute".)
const MAX_ROWS = 4;

// How many named measure-groups the settings panel offers. Must be a fixed
// number — the visual-prop element COUNT has to stay static (LESSONS.md).
const MAX_GROUPS = 8;

// Separator for composite lookup keys. NUL can't appear in real cell
// values, so joining/splitting on it is unambiguous (a space would not be).
const SEP = '\u0000';

// Collapse state, persisted for the page lifetime (survives re-renders the
// same way the other charts keep their button state). Two explicit sets plus
// a default, so flipping the "start collapsed" setting still lets per-group
// clicks win.
const explicitCollapsed = new Set<string>();
const explicitExpanded = new Set<string>();

// User-dragged column widths, keyed by a stable per-column key. Seeded from
// visualProps.clientState (the SDK's documented place for chart-local state
// that must survive a save) and written back there when a drag finishes.
const columnWidths: Record<string, number> = {};
let widthsSeeded = false;

const MIN_COL_PX = 48;

type ClientState = { widths?: Record<string, number> };

function readClientState(vp: VisualProps): ClientState {
    try {
        const raw = vp?.clientState;
        if (typeof raw !== 'string' || !raw.trim()) return {};
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        return {};
    }
}

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

// ThoughtSpot link/attachment columns arrive as
//   {caption}Display Text{/caption}https://actual/url
// Rendering that raw dumps the whole URL into the cell. Split it so the cell
// can show just the caption, hyperlinked.
const CAPTION_RE = /^\{caption\}([\s\S]*?)\{\/caption\}([\s\S]*)$/;

function parseLinkValue(raw: string): { text: string; href: string | null } {
    const m = CAPTION_RE.exec(String(raw ?? ''));
    if (!m) return { text: String(raw ?? ''), href: null };
    const text = m[1].trim();
    const url  = m[2].trim();
    // Only ever emit http(s) — never javascript:/data: from cell data.
    const safe = /^https?:\/\//i.test(url) ? url : null;
    return { text: text || url, href: safe };
}

function labelForValue(raw: string, col?: Col): string {
    if (raw === '' || raw == null) return '(blank)';
    if (isDateLikeCol(col)) return formatEpochByBucket(raw, col?.timeBucket);
    return parseLinkValue(String(raw)).text;
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

// ---------- column resizing ----------

// Live drag state. The handle sets these on mousedown; document-level
// listeners (not element-level, so the pointer can leave the 4px grip) do the
// rest. onCommit persists once the drag ends, never per mousemove.
let dragState: { key: string; startX: number; startW: number } | null = null;
let onWidthCommit: (() => void) | null = null;
let applyWidthsLive: (() => void) | null = null;

function addResizeHandle(th: HTMLTableCellElement, key: string) {
    th.dataset.colKey = key;
    const grip = document.createElement('span');
    grip.className = 'col-resize';
    grip.title = 'Drag to resize this column';
    // Keep the grip from triggering the collapse button or text selection.
    grip.onmousedown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragState = {
            key,
            startX: e.clientX,
            startW: columnWidths[key] ?? th.getBoundingClientRect().width,
        };
        document.body.classList.add('col-resizing');
    };
    th.appendChild(grip);
}

document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const next = Math.max(MIN_COL_PX, Math.round(dragState.startW + (e.clientX - dragState.startX)));
    columnWidths[dragState.key] = next;
    applyWidthsLive?.();
});

document.addEventListener('mouseup', () => {
    if (!dragState) return;
    dragState = null;
    document.body.classList.remove('col-resizing');
    onWidthCommit?.();
});

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
    // How many of the left label columns stay pinned while scrolling
    // sideways. 0 = none. Contiguous from the left, like Excel freeze panes.
    const freezeCount = Math.max(0, Math.min(
        rowColumns.length,
        Math.floor(Number(visualProps.freezeColumnCount ?? 1) || 0),
    ));

    // Adopt any saved widths we haven't already got locally (local drags win).
    if (!widthsSeeded) {
        const saved = readClientState(visualProps).widths ?? {};
        for (const [k, v] of Object.entries(saved)) {
            if (typeof v === 'number' && isFinite(v) && !(k in columnWidths)) columnWidths[k] = v;
        }
        widthsSeeded = true;
    }

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

    // ---- measure groups ----
    // The main way to group here: carve the bound measures into named runs.
    // Group 1 takes the first N measures, group 2 the next M, and so on, in
    // the order they sit in the Measures slot. Anything past the last defined
    // group stays ungrouped. This is Excel-style column grouping — "these 20
    // columns are one group, the next 30 are another" — rather than grouping
    // by an attribute's values.
    type MGroup = { name: string; measures: Col[] };
    const measureGroups: MGroup[] = [];
    let ungrouped: Col[] = measureColumns;
    {
        let cursor = 0;
        for (let i = 1; i <= MAX_GROUPS; i++) {
            const name = (visualProps[`group${i}Name`] ?? '').toString().trim();
            const size = Math.max(0, Math.floor(Number(visualProps[`group${i}Size`] ?? 0) || 0));
            if (!name || size <= 0) continue;
            const slice = measureColumns.slice(cursor, cursor + size);
            if (slice.length === 0) break;
            measureGroups.push({ name, measures: slice });
            cursor += slice.length;
        }
        ungrouped = measureColumns.slice(cursor);
    }
    const hasMeasureGroups = measureGroups.length > 0;

    const multiMeasure = measureColumns.length > 1;
    const attrLevels = colColumns.length;
    // Depth: one level per bound column attribute, then a measure-group level
    // (only when groups are defined), then the measure level. With a single
    // measure, no groups and at least one attribute level, the deepest
    // attribute level is already the leaf.
    const measureLevels = hasMeasureGroups ? 2 : ((multiMeasure || attrLevels === 0) ? 1 : 0);
    const totalLevels = attrLevels + measureLevels;

    const leafFor = (mc: Col, parentPath: string[], level: number): ColNode => ({
        key: [...parentPath, `m:${mc.id}`].join(SEP),
        label: measureLabel(mc),
        level,
        children: [],
        pathKey: parentPath.join(SEP),
        measureId: mc.id,
    });

    // Everything below the attribute hierarchy: either grouped measures
    // (group nodes with measure children) or a flat run of measures.
    const measureNodes = (parentPath: string[], level: number): ColNode[] => {
        if (!hasMeasureGroups) return measureColumns.map(mc => leafFor(mc, parentPath, level));
        const out: ColNode[] = measureGroups.map(g => ({
            key: [...parentPath, `g:${g.name}`].join(SEP),
            label: g.name,
            level,
            children: g.measures.map(mc => leafFor(mc, parentPath, level + 1)),
            pathKey: parentPath.join(SEP),
        }));
        // Leftover measures sit at the group level so they stay visible
        // alongside the groups instead of vanishing.
        for (const mc of ungrouped) out.push(leafFor(mc, parentPath, level));
        return out;
    };

    const buildLevel = (level: number, parentPath: string[]): ColNode[] => {
        if (level >= attrLevels) {
            return measureLevels > 0 ? measureNodes(parentPath, level) : [];
        }
        const nodes: ColNode[] = [];
        const isLeafLevel = level === attrLevels - 1 && measureLevels === 0;
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
        ? measureNodes([], 0)
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
    // Column keys in visual order — drives width application and the resize
    // handles. Row labels first, then the visible leaf columns.
    // `leaves` is already left-to-right, so this matches the rendered order.
    const columnKeys: string[] = [
        ...rowColumns.map(rc => `row:${rc.id}`),
        ...leaves.map(lf => lf.key),
    ];

    // ---- header ----
    const thead = document.createElement('thead');
    const headerRows: HTMLTableRowElement[] = [];
    for (let l = 0; l < totalLevels; l++) {
        const tr = document.createElement('tr');
        headerRows.push(tr);
        thead.appendChild(tr);
    }

    // Row-label headers span every header row.
    rowColumns.forEach((rc, i) => {
        const th = document.createElement('th');
        th.className = 'row-head' + (i < freezeCount ? ' frozen' : '');
        th.rowSpan = totalLevels;
        th.textContent = rc.name;
        addResizeHandle(th, `row:${rc.id}`);
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
            // A leaf that sits above the deepest header level (e.g. a measure
            // left ungrouped while its neighbours are in groups) must span the
            // remaining header rows — otherwise those rows come up short and
            // every cell after it shifts left.
            if (isLeafRow && node.level < totalLevels - 1) {
                th.rowSpan = totalLevels - node.level;
            }

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
            // Only single-column headers get a resize grip — dragging a group
            // header's edge would be ambiguous about which column it resizes.
            if (isLeafRow) addResizeHandle(th, node.key);
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
        const raws   = rowSortByKey.get(rKey) ?? [];
        labels.forEach((lab, i) => {
            const td = document.createElement('td');
            td.className = 'row-label' + (i < freezeCount ? ' frozen' : '');
            // Link columns render as the caption text hyperlinked, not the
            // raw {caption}…{/caption}https://… blob.
            const link = isDateLikeCol(rowColumns[i]) ? { href: null } : parseLinkValue(raws[i] ?? '');
            if (link.href) {
                const a = document.createElement('a');
                a.href = link.href;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = lab;
                td.appendChild(a);
            } else {
                td.textContent = lab;
            }
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
            td.className = 'row-label' + (i < freezeCount ? ' frozen' : '');
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

    // Apply saved/dragged widths, then pin the frozen label columns. Widths
    // must land first: sticky left offsets are measured from real widths.
    const applyWidths = () => {
        const colgroupCells: HTMLElement[][] = columnKeys.map(() => []);
        const rowLabelCount = rowColumns.length;
        // Header: row-label headers are cells 0..n-1 of header row 0; leaf
        // headers carry their own key, so find them by the grip we attached.
        Array.from(table.tHead?.rows ?? []).forEach(r => {
            Array.from(r.cells).forEach(c => {
                const k = (c as HTMLElement).dataset.colKey;
                if (!k) return;
                const idx = columnKeys.indexOf(k);
                if (idx >= 0) colgroupCells[idx].push(c as HTMLElement);
            });
        });
        // Body: column index maps straight onto cell index.
        Array.from(table.tBodies[0]?.rows ?? []).forEach(r => {
            for (let i = 0; i < columnKeys.length && i < r.cells.length; i++) {
                colgroupCells[i].push(r.cells[i] as HTMLElement);
            }
        });
        columnKeys.forEach((k, i) => {
            const w = columnWidths[k];
            for (const el of colgroupCells[i]) {
                if (w == null) {
                    el.style.width = ''; el.style.minWidth = ''; el.style.maxWidth = '';
                } else {
                    const px = `${w}px`;
                    el.style.width = px; el.style.minWidth = px; el.style.maxWidth = px;
                }
            }
        });
        void rowLabelCount;
        applyStickyOffsets(table, freezeCount, totalLevels);
    };
    applyWidths();
    applyWidthsLive = applyWidths;
    // Persist only when a drag ends, so we don't spam the host mid-gesture.
    onWidthCommit = () => {
        try {
            const next = { ...readClientState(visualProps), widths: { ...columnWidths } };
            ctx.emitEvent(ChartToTSEvent.UpdateVisualProps, {
                visualProps: { ...(visualProps as any), clientState: JSON.stringify(next) },
            } as any);
        } catch (e) {
            console.error('[Collapsible Pivot] could not persist column widths', e);
        }
    };

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

    // Left offsets: measure the first body row's label cells. Only the first
    // `rowLabelCount` columns are frozen, so only those get a left offset.
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
            // Seed the way a plain table would look: the first attribute down
            // the side and EVERY measure from the search across the top, with
            // no grouping yet. The user then drags attributes into "Column
            // groups" to start grouping. Seeding a single measure made a
            // 100-column search render as one lonely column.
            return [
                {
                    key: 'column',
                    dimensions: [
                        { key: 'rows',     columns: attributes.slice(0, MAX_ROWS) },
                        { key: 'columns',  columns: [] },
                        { key: 'measures', columns: measures.slice(0, MAX_MEASURES) },
                    ],
                },
            ];
        },
        // Without this the SDK's default says "every saved config is valid",
        // so a stale/bad config saved by an earlier build is handed straight
        // back to the host and never repaired — the host then chokes on, say,
        // a measure sitting in the attribute-only Rows slot. Validating here
        // makes the SDK fall back to getDefaultChartConfig and self-heal.
        validateConfig: (chartConfig: ChartConfig[], chartModel: ChartModel) => {
            const dims = chartConfig?.[0]?.dimensions ?? [];
            const get = (k: string) => (dims.find(d => d.key === k)?.columns ?? []) as Col[];
            const byId = new Map((chartModel?.columns ?? []).map((c: any) => [c.id, c]));
            const typeOf = (c: Col) => (byId.get(c.id) as any)?.type ?? (c as any)?.type;
            const errors: string[] = [];

            const rows     = get('rows');
            const colGroups = get('columns');
            const measures = get('measures');

            if (rows.length < 1) errors.push('Bind one attribute to Rows.');
            if (rows.length > MAX_ROWS) errors.push(`Rows takes at most ${MAX_ROWS} attributes.`);
            if (measures.length < 1) errors.push('Bind at least one measure to Measures.');
            for (const c of [...rows, ...colGroups]) {
                if (typeOf(c) === ColumnType.MEASURE) {
                    errors.push(`"${c.name}" is a measure and cannot sit in Rows or Column groups.`);
                }
            }
            for (const c of measures) {
                if (typeOf(c) === ColumnType.ATTRIBUTE) {
                    errors.push(`"${c.name}" is an attribute and cannot sit in Measures.`);
                }
            }
            return errors.length
                ? { isValid: false, validationErrorMessage: errors }
                : { isValid: true };
        },
        getQueriesFromChartConfig: (chartConfig: ChartConfig[], chartModel: ChartModel): Query[] => {
            // Must return at least one query holding at least one column, or
            // the SDK validator rejects it and the chart won't load at all.
            // No queryParams override here: asking for more rows than the
            // chart's own advertised chartConfigParameters.batchSizeLimit
            // (default 20000) is inconsistent, and none of the working charts
            // in this repo set it. Let the host pick the batch size.
            const queries = (chartConfig ?? []).map(config => ({
                queryColumns: (config?.dimensions ?? []).flatMap(d => d?.columns ?? []),
            })).filter(q => q.queryColumns.length > 0);
            if (queries.length > 0) return queries as Query[];
            const placeholder = chartModel?.columns?.[0];
            return placeholder ? ([{ queryColumns: [placeholder] }] as Query[]) : [];
        },
        renderChart,
        chartConfigEditorDefinition: [
            {
                key: 'column',
                label: 'Layout',
                descriptionText:
                    'Rows = the left-hand label columns, flat and side by side (no row grouping — grouping in this chart is on columns only). Column groups = one nesting level per attribute (first = outermost); each group header can be collapsed, and a collapsed group keeps its first column visible. Measures fill the cells. Move an attribute from Rows into Column groups to start grouping by it.',
                columnSections: [
                    {
                        key: 'rows',
                        label: 'Rows',
                        allowAttributeColumns: true,
                        allowMeasureColumns: false,
                        allowTimeSeriesColumns: true,
                        maxColumnCount: MAX_ROWS,
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
                        maxColumnCount: MAX_MEASURES,
                    },
                ],
            },
        ],
        // STATIC element list. Per LESSONS.md, varying how MANY elements this
        // returns based on bound-column counts crashes the host — only label
        // TEXT may vary. With up to 60 measures allowed, per-measure settings
        // would make the count swing wildly, so there are none: percent
        // measures are detected from the column name instead.
        visualPropEditorDefinition: () => {
            // Fixed MAX_GROUPS slots — always the same count, so the element
            // list stays static. Each slot names a group and says how many of
            // the bound measures it swallows, consumed left to right.
            const groupSlots: any[] = [];
            for (let i = 1; i <= MAX_GROUPS; i++) {
                groupSlots.push(
                    { key: `group${i}Name`, type: 'text',   defaultValue: ' ', label: `Group ${i} name` },
                    { key: `group${i}Size`, type: 'number', defaultValue: 0,   label: `Group ${i} — how many measures` },
                );
            }
            return {
                elements: [
                    { key: 'chartTitle',        type: 'text',     defaultValue: ' ',        label: 'Title' },
                    { key: 'numberFormat',      type: 'text',     defaultValue: '0,0.[0]a', label: 'Number format' },
                    { key: 'currency',          type: 'dropdown', defaultValue: 'None',     values: CURRENCY_OPTIONS, label: 'Currency symbol' },
                    { key: 'defaultCollapsed',  type: 'checkbox', defaultValue: false,      label: 'Start with groups collapsed' },
                    { key: 'freezeColumnCount', type: 'number',   defaultValue: 1,          label: 'Freeze first N row label columns (0 = none)' },
                    { key: 'showRowTotals',     type: 'checkbox', defaultValue: false,      label: 'Show total column' },
                    { key: 'showGrandTotalRow', type: 'checkbox', defaultValue: false,      label: 'Show grand total row' },
                    { key: 'stripedRows',       type: 'checkbox', defaultValue: true,       label: 'Striped rows' },
                    { key: 'showGridLines',     type: 'checkbox', defaultValue: true,       label: 'Show column dividers' },
                    ...groupSlots,
                ],
            };
        },
    });

    renderChart(ctx);
})();
