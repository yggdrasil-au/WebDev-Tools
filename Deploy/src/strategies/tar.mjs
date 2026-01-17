import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { joinRemote } from '../utils/paths.mjs';
import { runCommandsOverSSH } from '../core/ssh.mjs';
import { listLocalFiles, createBatches } from '../utils/fs.mjs';
import { ProgressBar, formatSize } from '../utils/ui.mjs';

export async function uploadTar(client, config, remoteDir) {
    const { localDir, batchSizeMB, concurrency, host, port, username, privateKey, passphrase, password } = config;
    
    console.log('[deploy] Scanning files for tar batching...');
    const allFiles = listLocalFiles(localDir);
    // batchSizeMB in Config is default 0, check logic from main.mjs
    const maxBytes = (batchSizeMB || 0) * 1024 * 1024;
    const batches = createBatches(allFiles, maxBytes);
    
    console.log(`[deploy] Found ${allFiles.length} files. Created ${batches.length} batch(es).`);

    const processBatch = async (batchFiles, index) => {
        const batchId = index + 1;
         // unique names to avoid collision
        const tarName = `deploy-batch-${batchId}-${Date.now()}.tar.gz`;
        const tarPath = path.join(tmpdir(), tarName);
        const listName = `deploy-list-${batchId}-${Date.now()}.txt`;
        const listPath = path.join(tmpdir(), listName);

        // Map files relative to localDir
        const fileListContent = batchFiles.map(f => f.relPath).join('\n');
        fs.writeFileSync(listPath, fileListContent);

        const label = `[Batch ${batchId}/${batches.length}]`;
        console.log(`${label} Compressing...`); // Keep consistent log for start

        await new Promise((resolve, reject) => {
            execFile('tar', ['-czf', tarPath, '-T', listPath], { cwd: localDir }, (err) => {
                if (err) reject(err); else resolve();
            });
        });

        const remoteTarPath = joinRemote(remoteDir, tarName);
        try {
            const stats = fs.statSync(tarPath);
            const totalSize = stats.size;
            
            // Render Type: 'bar' if concurrency is 1, else 'log' to avoid garbled output
            const renderType = concurrency === 1 ? 'bar' : 'log';
            const bar = new ProgressBar(label, totalSize, { renderType });
            
            // Only log "Uploading" if we are in log mode, otherwise the bar handles it
            if (renderType === 'log') console.log(`${label} Uploading ${formatSize(totalSize)}...`);

            await client.put(tarPath, remoteTarPath, {
                step: (transferred, chunk, total) => {
                    bar.update(transferred);
                }
            });
            bar.finish(); // Ensure 100%
            
        } catch(e) {
             throw new Error(`Upload failed for batch ${batchId}: ${e.message}`);
        } finally {
             try { fs.unlinkSync(tarPath); fs.unlinkSync(listPath); } catch {}
        }

        console.log(`${label} Extracting remote...`);

        // MITIGATION: Add random delay to spread out SSH connection attempts and avoid "handshake timeout"
        // Only if concurrency > 1
        if (concurrency > 1) {
            const delay = Math.floor(Math.random() * 2000) + 500;
            await new Promise(r => setTimeout(r, delay));
        }

        // Note: passing config to ssh run commands
        await runCommandsOverSSH(
            { host, port, username, privateKey, passphrase, password },
            [`tar -xzf "${remoteTarPath}" -C "${remoteDir}"`, `rm "${remoteTarPath}"`],
            { verbose: false }
        );
        console.log(`${label} Done.`);
    };

    const queue = [...batches.entries()]; 
    const activeWorkers = [];

    async function worker() {
        while (queue.length > 0) {
            const [index, batch] = queue.shift();
            await processBatch(batch, index);
        }
    }

    const threadCount = Math.min(concurrency, batches.length);
    for (let i = 0; i < threadCount; i++) activeWorkers.push(worker());
    await Promise.all(activeWorkers);
}
