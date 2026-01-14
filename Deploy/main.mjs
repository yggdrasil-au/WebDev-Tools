#!/usr/bin/env node
// Cross-platform Deploy script
// Updates: Added 'symlink' strategy, 'tar' transfer, and 'batching' logic.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import SftpClient from 'ssh2-sftp-client';
import url from 'node:url';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

// Load .env.deploy if present
const envPath = path.resolve(process.cwd(), '.env.deploy');
if (fs.existsSync(envPath)) {
    try {
        const dotenv = await import('dotenv');
        dotenv.config({ path: envPath });
    } catch (e) { /* ignore */ }
}

// ---------------- CLI parsing ----------------
function parseArgs(argv) {
    const out = { flags: {}, profile: undefined, list: false, unknown: [] };
    const recognized = new Set([
        'check', 'dry-run', 'archive', 'profile', 'config', 'list',
        'host', 'port', 'username', 'key', 'password', 'local', 'remote',
        'clean', 'archive-dir', 'min-depth', 'preserve-dir',
        'pre', 'post',
        // New flags
        'strategy', 'transfer', 'releases-dir', 'keep-releases',
        'batch-size', 'concurrency'
    ]);

    for (let i = 0; i < argv.length; i++) {
        let token = argv[i];
        if (!token.startsWith('--')) { out.unknown.push(token); continue; }
        token = token.slice(2);
        if (token.includes('=')) {
            const [k, ...rest] = token.split('=');
            if (recognized.has(k)) out.flags[k] = rest.join('=');
            else out.profile = k;
            continue;
        }
        if (recognized.has(token)) {
            if (['check', 'dry-run', 'archive', 'list', 'clean'].includes(token)) {
                out.flags[token] = true;
            } else {
                const next = argv[i + 1];
                if (next && !next.startsWith('-')) { out.flags[token] = next; i++; }
                else out.flags[token] = true;
            }
        } else {
            out.profile = token;
        }
    }
    out.list = Boolean(out.flags['list']);
    return out;
}

const parsed = parseArgs(process.argv.slice(2));
const dryRun = Boolean(parsed.flags['check'] || parsed.flags['dry-run']);
let earlyExit = false;

// ---------------- Config file loading ----------------
const builtinDefaults = {
    host: '100.106.185.12',
    port: 22,
    localDir: 'www/website',
    cleanRemote: false,
    archiveExisting: false,
    minRemoteDepth: 2,
    strategy: 'inplace', // 'inplace' | 'symlink'
    transfer: 'sftp',    // 'sftp' | 'tar'
    keepReleases: 5,
    batchSizeMB: 0,      // 0 = unlimited (single tar), 50 = 50MB chunks
    concurrency: 1       // simultaneous uploads
};

async function loadConfig(configPath) {
    const candidates = [];
    if (configPath) candidates.push(path.resolve(process.cwd(), configPath));
    const envConfig = process.env.DEPLOY_CONFIG;
    if (envConfig) candidates.push(path.resolve(process.cwd(), envConfig));
    candidates.push(
        path.resolve(process.cwd(), 'deploy.config.mjs'),
        path.resolve(process.cwd(), 'deploy.config.yaml'),
        path.resolve(process.cwd(), 'deploy.config.yml'),
        path.resolve(process.cwd(), 'deploy.config.json')
    );
    let cfgPath = candidates.find((p) => fs.existsSync(p));
    if (!cfgPath) return { defaults: {}, deployments: {} };

    try {
        if (cfgPath.endsWith('.yaml') || cfgPath.endsWith('.yml')) {
            const yaml = await import('js-yaml');
            const fileContent = fs.readFileSync(cfgPath, 'utf8');
            const parsed = yaml.load(fileContent);
            return { path: cfgPath, ...parsed };
        }
        if (cfgPath.endsWith('.json')) {
            return { path: cfgPath, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
        }
        const mod = await import(url.pathToFileURL(cfgPath).href);
        return { path: cfgPath, ...((mod.default ?? mod.config) || mod || {}) };
    } catch (e) {
        console.warn(`[deploy] Failed to load config ${cfgPath}:`, e.message);
        return { defaults: {}, deployments: {} };
    }
}

const loadedConfig = await loadConfig(parsed.flags['config']);
if (loadedConfig.path) console.log(`[deploy] Loaded config from ${path.basename(loadedConfig.path)}`);

const availableProfiles = Object.keys(loadedConfig.deployments || {});
if (parsed.list) {
    console.log('[deploy] Available deployments:', availableProfiles.join(', '));
    earlyExit = true;
}

const selectedProfile = parsed.flags['profile'] || parsed.profile;
const profileCfg = (selectedProfile && loadedConfig.deployments?.[selectedProfile]) || {};

// ---------------- Merge Configuration ----------------
const envCfg = {};
if (process.env.DEPLOY_STRATEGY) envCfg.strategy = process.env.DEPLOY_STRATEGY;
if (process.env.DEPLOY_TRANSFER) envCfg.transfer = process.env.DEPLOY_TRANSFER;

const cliCfgRaw = {
    host: parsed.flags['host'],
    port: parsed.flags['port'],
    username: parsed.flags['username'],
    privateKeyPath: parsed.flags['key'],
    password: parsed.flags['password'],
    localDir: parsed.flags['local'],
    remoteDir: parsed.flags['remote'],
    cleanRemote: parsed.flags['clean'],
    archiveExisting: parsed.flags['archive'],
    archiveDir: parsed.flags['archive-dir'],
    minRemoteDepth: parsed.flags['min-depth'],
    preserveDir: parsed.flags['preserve-dir'],
    strategy: parsed.flags['strategy'],
    transfer: parsed.flags['transfer'],
    releasesDir: parsed.flags['releases-dir'],
    keepReleases: parsed.flags['keep-releases'],
    batchSizeMB: parsed.flags['batch-size'],
    concurrency: parsed.flags['concurrency']
};
const cliCfg = Object.fromEntries(Object.entries(cliCfgRaw).filter(([, v]) => v !== undefined));

const merged = { ...builtinDefaults, ...loadedConfig.defaults, ...profileCfg, ...envCfg, ...cliCfg };

// ---------------- Final Values ----------------
const host = merged.host;
const port = Number(merged.port || 22);
const username = merged.username;
const privateKeyPath = merged.privateKeyPath;
const password = merged.password;
let passphrase = merged.passphrase;
const localDir = path.resolve(merged.localDir);
const remoteDir = merged.remoteDir;
const preserveDir = merged.preserveDir;
const preserveFiles = Array.isArray(merged.preserveFiles) ? merged.preserveFiles : [];
const strategy = merged.strategy;
const transfer = merged.transfer;
const keepReleases = Number(merged.keepReleases || 5);
const batchSizeMB = Number(merged.batchSizeMB || 0);
const concurrency = Number(merged.concurrency || 1);

// Command hooks
const toCmdArray = (cfg, cli) => {
    const arr = [];
    if (Array.isArray(cfg)) arr.push(...cfg);
    if (typeof cli === 'string' && cli) arr.push(cli);
    return arr;
};
const preCommands = toCmdArray(merged.preCommands, parsed.flags['pre']);
const postCommands = toCmdArray(merged.postCommands, parsed.flags['post']);

// Helpers
const normalizeRemote = (p) => String(p).replace(/\\+/g, '/').replace(/\/+$/, '');
const joinRemote = (...p) => path.posix.join(...p.map(x => String(x).replace(/\\+/g, '/')));
const remoteBaseName = (p) => path.posix.basename(normalizeRemote(p));
const remoteDirName = (p) => path.posix.dirname(normalizeRemote(p));

function fail(msg) { throw new Error(`[deploy] ${msg}`); }

// Derived Paths
let remoteDirNorm = '';
let releasesRoot = '';
let currentReleasePath = '';
let previousReleaseLink = '';

if (!earlyExit) {
    if (!remoteDir && !dryRun) fail('remoteDir is required');
    remoteDirNorm = normalizeRemote(remoteDir);

    if (strategy === 'symlink') {
        const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
        releasesRoot = merged.releasesDir ? normalizeRemote(merged.releasesDir) : joinRemote(remoteDirName(remoteDirNorm), 'releases');
        currentReleasePath = joinRemote(releasesRoot, ts);
        previousReleaseLink = remoteDirNorm;
    } else {
        currentReleasePath = remoteDirNorm;
    }

    if (dryRun) {
        console.log(`[deploy] DRY RUN`);
        console.log(`- Strategy: ${strategy} | Transfer: ${transfer}`);
        if (transfer === 'tar') console.log(`- Batching: ${batchSizeMB > 0 ? batchSizeMB + 'MB' : 'None (Single Tar)'} | Concurrency: ${concurrency}`);
        console.log(`- Local: ${localDir}`);
        console.log(`- Remote: ${currentReleasePath}`);
        earlyExit = true;
    } else {
        if (!fs.existsSync(localDir)) fail(`Local dir not found: ${localDir}`);
        if (transfer === 'tar') {
            try {
                await new Promise((resolve, reject) => {
                    execFile('tar', ['--version'], (err) => err ? reject(err) : resolve());
                });
            } catch (e) {
                fail('Transfer mode is "tar" but "tar" command not found locally.');
            }
        }
    }
}

// ---------------- File Scanning ----------------
function listLocalFiles(rootDir) {
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

// ---------------- Batching Logic ----------------
function createBatches(files, maxBytes) {
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

// ---------------- Main Logic ----------------

if (!earlyExit) {
    const client = new SftpClient();

    try {
        const privateKey = privateKeyPath ? fs.readFileSync(privateKeyPath) : undefined;

        // 1. Run Pre-commands
        if (preCommands.length) {
            console.log('[deploy] Executing pre-commands...');
            const { runCommandsOverSSH } = await import('./ssh.mjs');
            await runCommandsOverSSH(
                { host, port, username, privateKey, passphrase, password },
                preCommands
            );
        }

        console.log(`[deploy] Connecting to ${host}...`);
        try {
            await client.connect({ host, port, username, privateKey, passphrase, password });
        } catch (err) { throw err; }

        // 2. Prepare Target Directory
        if (strategy === 'symlink') {
            if (!(await client.exists(releasesRoot))) await client.mkdir(releasesRoot, true);
            await client.mkdir(currentReleasePath, true);
        } else {
            if (await client.exists(remoteDirNorm)) {
                if (merged.archiveExisting) {
                     const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
                     const arcParent = merged.archiveDir ? normalizeRemote(merged.archiveDir) : remoteDirName(remoteDirNorm);
                     if (!(await client.exists(arcParent))) await client.mkdir(arcParent, true);
                     const arcPath = joinRemote(arcParent, `${remoteBaseName(remoteDirNorm)}-${ts}`);
                     console.log(`[deploy] Archiving existing: ${arcPath}`);
                     await client.rename(remoteDirNorm, arcPath);
                     await client.mkdir(remoteDirNorm, true);
                } else if (merged.cleanRemote) {
                    await client.rmdir(remoteDirNorm, true);
                    await client.mkdir(remoteDirNorm, true);
                }
            } else {
                await client.mkdir(remoteDirNorm, true);
            }
        }

        // 3. Upload Content
        if (transfer === 'tar') {
            console.log('[deploy] Scanning files for tar batching...');
            const allFiles = listLocalFiles(localDir);
            const batches = createBatches(allFiles, batchSizeMB * 1024 * 1024);
            console.log(`[deploy] Found ${allFiles.length} files. Created ${batches.length} batch(es).`);

            // Helper to process one batch
            const processBatch = async (batchFiles, index) => {
                const batchId = index + 1;
                const tarName = `deploy-batch-${batchId}-${Date.now()}.tar.gz`;
                const tarPath = path.join(tmpdir(), tarName);
                const listName = `deploy-list-${batchId}-${Date.now()}.txt`;
                const listPath = path.join(tmpdir(), listName);

                // Create file list for tar
                // Tar -T expects file paths. We must be careful about CWD.
                // We will run tar from localDir.
                const fileListContent = batchFiles.map(f => f.relPath).join('\n');
                fs.writeFileSync(listPath, fileListContent);

                const label = `Batch ${batchId}/${batches.length}`;
                console.log(`[${label}] Compressing...`);

                await new Promise((resolve, reject) => {
                    execFile('tar', ['-czf', tarPath, '-T', listPath], { cwd: localDir }, (err) => {
                        if (err) reject(err); else resolve();
                    });
                });

                // Upload
                const remoteTarPath = joinRemote(currentReleasePath, tarName);
                const sizeMB = (fs.statSync(tarPath).size / 1024 / 1024).toFixed(2);
                console.log(`[${label}] Uploading ${sizeMB} MB...`);
                await client.put(tarPath, remoteTarPath);

                // Cleanup Local
                try { fs.unlinkSync(tarPath); fs.unlinkSync(listPath); } catch {}

                // Extract Remote
                console.log(`[${label}] Extracting remote...`);
                const { runCommandsOverSSH } = await import('./ssh.mjs');
                await runCommandsOverSSH(
                    { host, port, username, privateKey, passphrase, password },
                    [`tar -xzf "${remoteTarPath}" -C "${currentReleasePath}"`, `rm "${remoteTarPath}"`],
                    { verbose: false }
                );
                console.log(`[${label}] Done.`);
            };

            // Run batches with concurrency
            // We use a simple pointer system to limit active promises
            const queue = [...batches.entries()]; // [ [0, batch], [1, batch] ]
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

        } else {
            // Standard SFTP upload (Single file at a time, but parallel-ish internally)
            console.log('[deploy] Mode: SFTP (Individual files). Uploading...');
            let count = 0;
            client.on('upload', info => {
                count++;
                if (count % 100 === 0) process.stdout.write(`\rFiles: ${count}`);
            });
            await client.uploadDir(localDir, currentReleasePath);
            console.log('\n[deploy] Upload complete.');
        }

        // 4. Handle Preserve Files
        if (strategy === 'symlink' && preserveFiles.length) {
            console.log('[deploy] Copying preserved files...');
            const sourceBase = preserveDir ? normalizeRemote(preserveDir) : previousReleaseLink;
            if (await client.exists(sourceBase)) {
                const { runCommandsOverSSH } = await import('./ssh.mjs');
                for (const f of preserveFiles) {
                    const src = joinRemote(sourceBase, f);
                    const dest = joinRemote(currentReleasePath, f);
                    try {
                        await runCommandsOverSSH(
                            { host, port, username, privateKey, passphrase, password },
                            [`[ -e "${src}" ] && cp -rp "${src}" "${dest}" || true`],
                            { verbose: false }
                        );
                    } catch (e) { console.warn(`  ! Failed to copy ${f}: ${e.message}`); }
                }
            }
        }

        // 5. Finalize / Switch
        if (strategy === 'symlink') {
            console.log(`[deploy] Linking ${previousReleaseLink} -> ${currentReleasePath}`);
            const { runCommandsOverSSH } = await import('./ssh.mjs');
            await runCommandsOverSSH(
                { host, port, username, privateKey, passphrase, password },
                [`ln -sfn "${currentReleasePath}" "${previousReleaseLink}"`]
            );

            console.log('[deploy] Cleaning up old releases...');
            const releases = await client.list(releasesRoot);
            const sorted = releases
                .filter(r => r.type === 'd' && /^\d{14}$/.test(r.name))
                .sort((a, b) => b.name.localeCompare(a.name));

            const toRemove = sorted.slice(keepReleases);
            for (const r of toRemove) {
                await client.rmdir(joinRemote(releasesRoot, r.name), true);
            }
        }

        // 6. Post Commands
        if (postCommands.length) {
            console.log('[deploy] Executing post-commands...');
            const { runCommandsOverSSH } = await import('./ssh.mjs');
            await runCommandsOverSSH(
                { host, port, username, privateKey, passphrase, password },
                postCommands
            );
        }

        console.log('[deploy] Success!');
    } catch (e) {
        console.error('[deploy] Failed:', e.message);
        process.exitCode = 1;
    } finally {
        await client.end();
    }
}
