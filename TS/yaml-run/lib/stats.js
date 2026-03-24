// --- Stats ---
const executionStats = [];

export function addStat(stat) {
    executionStats.push(stat);
}

export function printStatsSummary(totalTime) {
    console.log('\n--- Execution Summary ---');
    console.table(executionStats.map(s => ({
        Type: s.type,
        Name: s.name.length > 50 ? s.name.substring(0, 47) + '...' : s.name,
        Status: s.status,
        Duration: `${(s.duration / 1000).toFixed(2)}s`
    })));
    console.log(`\nTotal Time: ${(totalTime / 1000).toFixed(2)}s`);
}
