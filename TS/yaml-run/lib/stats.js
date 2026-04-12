// --- Stats ---
const executionStats = [];
let nextStatId = 1;
let nextSequence = 1;

const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_COLORS = {
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    blue: '\x1b[34m',
    gray: '\x1b[90m',
};

function getDisplayName(name) {
    if (name.length <= 50) {
        return name;
    }

    return `${name.substring(0, 47)}...`;
}

function getDurationLabel(duration) {
    return `${(duration / 1000).toFixed(2)}s`;
}

function colorize(text, color, isBold = false) {
    const colorCode = ANSI_COLORS[color];
    const boldCode = isBold ? ANSI_BOLD : '';
    return `${boldCode}${colorCode}${text}${ANSI_RESET}`;
}

function formatType(type) {
    switch (type) {
        case 'TASK': {
            return colorize(type.padEnd(5), 'cyan', true);
        }
        case 'CMD': {
            return colorize(type.padEnd(5), 'yellow', true);
        }
        case 'PATH': {
            return colorize(type.padEnd(5), 'green', true);
        }
        case 'TOOL': {
            return colorize(type.padEnd(5), 'magenta', true);
        }
        default: {
            return colorize(type.padEnd(5), 'gray', true);
        }
    }
}

function formatStatus(status) {
    switch (status) {
        case 'PASS': {
            return colorize(status.padEnd(7), 'green', true);
        }
        case 'FAIL': {
            return colorize(status.padEnd(7), 'red', true);
        }
        case 'RUNNING': {
            return `${ANSI_DIM}${colorize(status.padEnd(7), 'yellow', true)}${ANSI_RESET}`;
        }
        default: {
            return colorize(status.padEnd(7), 'gray', true);
        }
    }
}

function formatDuration(duration) {
    return colorize(getDurationLabel(duration).padStart(8), 'gray');
}

function buildRowText(stat, ancestry = [], isLast = true) {
    const indent = ancestry.map((hasMoreSiblings) => (hasMoreSiblings ? '|   ' : '    ')).join('');
    const connector = ancestry.length === 0 ? '' : `${isLast ? '\\-- ' : '|-- '}`;
    const displayName = getDisplayName(stat.name);

    return {
        plainLeft: `${indent}${connector}${stat.type.padEnd(5)} ${displayName}`,
        coloredLeft: `${indent}${connector}${formatType(stat.type)} ${displayName}`,
    };
}

function collectRows(stat, childrenByParentId, ancestry, isLast, rows) {
    rows.push({
        ...buildRowText(stat, ancestry, isLast),
        status: stat.status,
        duration: stat.duration,
    });

    const children = childrenByParentId.get(stat.id) || [];
    for (let index = 0; index < children.length; index++) {
        const child = children[index];
        const childIsLast = index === children.length - 1;
        collectRows(child, childrenByParentId, [...ancestry, !isLast], childIsLast, rows);
    }
}

function getChildrenByParentId() {
    const childrenByParentId = new Map();

    for (const stat of executionStats) {
        const parentId = stat.parentId ?? null;

        if (!childrenByParentId.has(parentId)) {
            childrenByParentId.set(parentId, []);
        }

        childrenByParentId.get(parentId).push(stat);
    }

    for (const children of childrenByParentId.values()) {
        children.sort((left, right) => left.sequence - right.sequence);
    }

    return childrenByParentId;
}

/**
 * Records a task, tool, PATH command, or shell command execution node.
 *
 * @param {{ type: 'TASK' | 'CMD' | 'PATH' | 'TOOL', name: string, parentId?: number | null, depth?: number, status?: 'RUNNING' | 'PASS' | 'FAIL', duration?: number }} stat
 * @returns {{ id: number, sequence: number, type: 'TASK' | 'CMD' | 'PATH' | 'TOOL', name: string, parentId: number | null, depth: number, status: 'RUNNING' | 'PASS' | 'FAIL', duration: number }}
 */
export function addStat(stat) {
    const record = {
        id: nextStatId++,
        sequence: nextSequence++,
        type: stat.type,
        name: stat.name,
        parentId: stat.parentId ?? null,
        depth: stat.depth ?? 0,
        status: stat.status ?? 'RUNNING',
        duration: stat.duration ?? 0,
    };

    executionStats.push(record);
    return record;
}

/**
 * Prints the execution summary as a tree shaped by task nesting.
 *
 * @param {number} totalTime
 */
export function printStatsSummary(totalTime) {
    console.log('\n--- Execution Summary ---');

    const childrenByParentId = getChildrenByParentId();
    const rootStats = childrenByParentId.get(null) || [];
    /** @type {Array<{ plainLeft: string, coloredLeft: string, status: 'RUNNING' | 'PASS' | 'FAIL', duration: number }>} */
    const rows = [];

    for (let index = 0; index < rootStats.length; index++) {
        const rootStat = rootStats[index];
        const isLastRoot = index === rootStats.length - 1;
        collectRows(rootStat, childrenByParentId, [], isLastRoot, rows);
    }

    const leftColumnWidth = rows.reduce((maximum, row) => Math.max(maximum, row.plainLeft.length), 0) + 1;

    for (const row of rows) {
        const paddingWidth = Math.max(leftColumnWidth - row.plainLeft.length, 1);
        console.log(`${row.coloredLeft}${' '.repeat(paddingWidth)}${formatStatus(row.status)} ${formatDuration(row.duration)}`);
    }

    console.log(`\nTotal Time: ${(totalTime / 1000).toFixed(2)}s`);
}
