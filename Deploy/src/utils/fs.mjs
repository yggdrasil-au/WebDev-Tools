import fs from 'node:fs';
import path from 'node:path';

export function listLocalFiles(rootDir) {
    const results = [];
    const stack = [rootDir];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                stack.push(full);
            } else if (ent.isFile()) {
                try {
                    const st = fs.statSync(full);
                    // store relative path for tar
                    results.push({ fullPath: full, relPath: path.relative(rootDir, full), size: st.size });
                } catch { /* ignore */ }
            }
        }
    }
    return results;
}

export function createBatches(files, maxBytes) {
    if (maxBytes <= 0) return [files]; // Single batch
    const batches = [];
    let currentBatch = [];
    let currentSize = 0;

    for (const file of files) {
        // If single file is larger than maxBytes, it goes in its own batch or pushes the limit
        if (currentSize + file.size > maxBytes && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentSize = 0;
        }
        currentBatch.push(file);
        currentSize += file.size;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);
    return batches;
}
