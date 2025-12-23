#!/usr/bin/env node
// Cross-platform SFTP deploy script using ssh2-sftp-client
// Layered configuration with support for:
// - Optional deploy.config.(mjs|json) with `defaults` and `deployments` (named profiles)
// - .env.deploy (dotenv) and/or environment variables
// - CLI flags (override all)
// Merge precedence: CLI > env > profile > config.defaults > built-ins
//
// Required final config: username, ssh key path, remote dir
// Optional:
//   host (default 100.106.185.12) | port (22) | local dir (www/website)
//   passphrase | cleanRemote | archiveExisting | archiveDir | minRemoteDepth (2)
//   preserveDir | preserveFiles (array)

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import SftpClient from 'ssh2-sftp-client';
import url from 'node:url';

// Load .env.deploy if present
const envPath = path.resolve(process.cwd(), '.env.deploy');
if (fs.existsSync(envPath)) {
    try {
        const dotenv = await import('dotenv');
        dotenv.config({ path: envPath });
        console.log(`[deploy] Loaded env from ${path.basename(envPath)}`);
    } catch (error) {
        console.warn('[deploy] Could not load dotenv. Proceeding with process.env');
        console.warn(error);
    }
}

function boolFromEnv(val, defaultVal = false) {
    if (val == null) return defaultVal;
    const s = String(val).trim().toLowerCase();
    return ['1', 'true', 'yes', 'y'].includes(s);
}

// ---------------- CLI parsing ----------------
function parseArgs(argv) {
    const out = {
        flags: {},
        profile: undefined,
        list: false,
        unknown: [],
    };
    const recognized = new Set([
        'check', 'dry-run', 'archive', 'profile', 'config', 'list',
        'host', 'port', 'username', 'key', 'password', 'local', 'remote',
        'clean', 'archive-dir', 'min-depth',
        'preserve-dir',
        // ssh command hooks
        'pre', 'post',
    ]);
    for (let i = 0; i < argv.length; i++) {
        let token = argv[i];
        if (!token.startsWith('--')) { out.unknown.push(token); continue; }
        token = token.slice(2);
        if (token.includes('=')) {
            const [k, ...rest] = token.split('=');
            const v = rest.join('=');
            if (recognized.has(k)) out.flags[k] = v;
            else out.profile = k; // shorthand --<profile>
            continue;
        }
        if (recognized.has(token)) {
            // boolean flags
            if (['check', 'dry-run', 'archive', 'list', 'clean'].includes(token)) {
                // For clean we allow explicit true without value
                if (token === 'clean') out.flags[token] = true; else out.flags[token] = true;
            } else {
                // value flags expect next token
                const next = argv[i + 1];
                if (next && !next.startsWith('-')) { out.flags[token] = next; i++; }
                else out.flags[token] = true; // tolerate missing value
            }
        } else {
            // treat as shorthand profile selector: --cs
            out.profile = token;
        }
    }
    out.list = Boolean(out.flags['list']);
    return out;
}

const argv = process.argv.slice(2);
const parsed = parseArgs(argv);
const dryRun = Boolean(parsed.flags['check'] || parsed.flags['dry-run']);
const forceArchive = Boolean(parsed.flags['archive']);
let earlyExit = false;

// ---------------- Config file loading ----------------
const builtinDefaults = {
    host: '100.106.185.12',
    port: 22,
    localDir: 'www/website',
    cleanRemote: false,
    archiveExisting: false,
    minRemoteDepth: 2,
};

async function loadConfig(configPath) {
    const candidates = [];
    if (configPath) candidates.push(path.resolve(process.cwd(), configPath));
    const envConfig = process.env.DEPLOY_CONFIG;
    if (envConfig) candidates.push(path.resolve(process.cwd(), envConfig));
    candidates.push(
        path.resolve(process.cwd(), 'deploy.config.mjs'),
        path.resolve(process.cwd(), 'deploy.config.json'),
    );

    let cfgPath = candidates.find((p) => fs.existsSync(p));
    if (!cfgPath) return { path: undefined, defaults: {}, deployments: {} };

    try {
        if (cfgPath.endsWith('.json')) {
            const raw = fs.readFileSync(cfgPath, 'utf8');
            const obj = JSON.parse(raw);
            return { path: cfgPath, defaults: obj.defaults || {}, deployments: obj.deployments || {} };
        }
        // mjs loader
        const mod = await import(url.pathToFileURL(cfgPath).href);
        const obj = (mod && (mod.default ?? mod.config)) || mod || {};
        return { path: cfgPath, defaults: obj.defaults || {}, deployments: obj.deployments || {} };
    } catch (error) {
        console.warn(`[deploy] Failed to load config ${cfgPath}:`, error.message || error);
        return { path: cfgPath, defaults: {}, deployments: {} };
    }
}

const loadedConfig = await loadConfig(parsed.flags['config']);
if (loadedConfig.path) {
    console.log(`[deploy] Loaded config from ${path.basename(loadedConfig.path)}`);
}

const availableProfiles = Object.keys(loadedConfig.deployments || {});
if (parsed.list) {
    console.log('[deploy] Available deployments:', availableProfiles.length ? availableProfiles.join(', ') : '(none)');
    earlyExit = true;
}

const selectedProfile = parsed.flags['profile'] || parsed.profile; // explicit --profile name or shorthand --name
const profileCfg = (selectedProfile && loadedConfig.deployments?.[selectedProfile]) || {};

// ---------------- Merge environment variables ----------------
const envMap = {
    DEPLOY_HOST: 'host',
    DEPLOY_PORT: 'port',
    DEPLOY_USERNAME: 'username',
    DEPLOY_PASSWORD: 'password',
    DEPLOY_SSH_KEY: 'privateKeyPath',
    // removed: DEPLOY_SSH_PASSPHRASE
    DEPLOY_LOCAL_DIR: 'localDir',
    DEPLOY_REMOTE_DIR: 'remoteDir',
    DEPLOY_CLEAN_REMOTE: 'cleanRemote',
    DEPLOY_ARCHIVE_EXISTING: 'archiveExisting',
    DEPLOY_ARCHIVE_DIR: 'archiveDir',
    DEPLOY_MIN_REMOTE_DEPTH: 'minRemoteDepth',
    DEPLOY_PRESERVE_DIR: 'preserveDir'
};

function coerceTypes(obj) {
    const out = { ...obj };
    if (out.port != null) out.port = Number(out.port);
    if (out.minRemoteDepth != null) out.minRemoteDepth = Number(out.minRemoteDepth);
    if (out.cleanRemote != null) out.cleanRemote = boolFromEnv(out.cleanRemote);
    if (out.archiveExisting != null) out.archiveExisting = boolFromEnv(out.archiveExisting);
    if (out.localDir != null) out.localDir = path.resolve(String(out.localDir));
    return out;
}

const envCfg = {};
for (const [envKey, cfgKey] of Object.entries(envMap)) {
    if (process.env[envKey] != null) envCfg[cfgKey] = process.env[envKey];
}

// ---------------- Merge CLI overrides ----------------
const cliCfgRaw = {
    host: parsed.flags['host'],
    port: parsed.flags['port'],
    username: parsed.flags['username'],
    password: parsed.flags['password'],
    privateKeyPath: parsed.flags['key'],
    localDir: parsed.flags['local'],
    remoteDir: parsed.flags['remote'],
    cleanRemote: parsed.flags['clean'],
    archiveExisting: parsed.flags['archive'],
    archiveDir: parsed.flags['archive-dir'],
    minRemoteDepth: parsed.flags['min-depth'],
    preserveDir: parsed.flags['preserve-dir']
};

// Only keep CLI keys explicitly provided (avoid overwriting with undefined)
const cliCfg = Object.fromEntries(
    Object.entries(cliCfgRaw).filter(([, v]) => v !== undefined),
);

const merged = {
    ...builtinDefaults,
    ...loadedConfig.defaults,
    ...profileCfg,
    ...envCfg,
    ...cliCfg,
};

// Final coercion + special cases
const host = merged.host || builtinDefaults.host;
const port = Number(merged.port ?? builtinDefaults.port);
const username = merged.username;
const privateKeyPath = merged.privateKeyPath;
let passphrase = merged.passphrase; // prompt only if needed
const localDir = path.resolve(merged.localDir || builtinDefaults.localDir);
const remoteDir = merged.remoteDir;
const cleanRemote = boolFromEnv(merged.cleanRemote, builtinDefaults.cleanRemote);
const archiveExisting = forceArchive || boolFromEnv(merged.archiveExisting, builtinDefaults.archiveExisting);
const archiveDir = merged.archiveDir; // optional
const minRemoteDepth = Number(merged.minRemoteDepth ?? builtinDefaults.minRemoteDepth);
const preserveDir = merged.preserveDir; // optional
// Command hooks (arrays)
const toCmdArray = (cfgVal, cliVal) => {
    const arr = [];
    if (Array.isArray(cfgVal)) arr.push(...cfgVal.filter(Boolean).map(String));
    // Allow a single CLI-provided command (string). If multiple are needed, user can chain with &&
    if (typeof cliVal === 'string' && cliVal.trim()) arr.push(cliVal.trim());
    return arr;
};
const preCommands = toCmdArray(merged.preCommands, parsed.flags['pre']);
const postCommands = toCmdArray(merged.postCommands, parsed.flags['post']);
const preserveFiles = Array.isArray(merged.preserveFiles) ? merged.preserveFiles : [];

// Helpers for remote posix paths
const pposix = path.posix;
const normalizeRemote = (p) => String(p).replace(/\\+/g, '/').replace(/\/+$|^$/, '');
const joinRemote = (...parts) => pposix.join(...parts.map((p) => String(p).replace(/\\+/g, '/')));
const remoteBaseName = (p) => pposix.basename(String(p).replace(/\\+/g, '/'));
const remoteDirName = (p) => pposix.dirname(String(p).replace(/\\+/g, '/'));

function fail(msg) {
    // Throw to be handled by outer logic; avoids direct process.exit for lint compliance
    throw new Error(`[deploy] ${msg}`);
}

// Predeclare for later usage in upload phase
let remoteDirNorm = '';
let remoteSegments = [];

if (!earlyExit) {
    // Compute normalized remote dir if present
    if (remoteDir) {
        remoteDirNorm = normalizeRemote(remoteDir);
        remoteSegments = remoteDirNorm.split('/').filter(Boolean);
    }

    if (dryRun) {
        console.log('[deploy] Configuration check');
        if (selectedProfile) console.log('- profile:', selectedProfile);
        console.log('- host:', host);
        console.log('- port:', port);
        console.log('- username:', username ?? '(missing)');
        console.log('- key file:', privateKeyPath ?? '(missing)');
        console.log('- local dir:', localDir, fs.existsSync(localDir) ? '' : '(not found)');
        console.log('- remote dir:', remoteDirNorm || '(missing)');
        console.log('- clean remote:', cleanRemote);
        console.log('- archive existing:', archiveExisting);
        if (archiveExisting) console.log('- archive dir:', archiveDir || '(same parent as remote dir)');
        if (preserveFiles.length) {
            console.log('- preserve files:', preserveFiles.join(', '));
            console.log('- preserve dir:', preserveDir || '(missing)');
        }
        if (preCommands.length) {
            console.log('- pre-commands:');
            for (const c of preCommands) console.log(`    > ${c}`);
        } else {
            console.log('- pre-commands: (none)');
        }
        if (postCommands.length) {
            console.log('- post-commands:');
            for (const c of postCommands) console.log(`    > ${c}`);
        } else {
            console.log('- post-commands: (none)');
        }

        let bad = false;
        if (!username) { console.log('! missing: username'); bad = true; }
        if (!privateKeyPath && !merged.password) { console.log('! missing: privateKeyPath or password'); bad = true; }
        if (!remoteDir) { console.log('! missing: remoteDir'); bad = true; }
        if (privateKeyPath && !fs.existsSync(privateKeyPath)) { console.log(`! key not found: ${privateKeyPath}`); bad = true; }
        if (!privateKeyPath && merged.password) { console.log('! warning: using password authentication'); }
        if (!fs.existsSync(localDir)) { console.log(`! local dir not found: ${localDir}`); bad = true; }
        if (remoteDirNorm && remoteSegments.length < minRemoteDepth) {
            console.log(`! remote path too shallow: ${remoteDirNorm} (segments=${remoteSegments.length}, min=${minRemoteDepth})`);
            bad = true;
        }
        if (preserveFiles.length > 0 && !preserveDir) {
            console.log('! missing: preserveDir (required when preserveFiles is set)');
            bad = true;
        }

        console.log('\n[deploy] Check complete. No connection attempted.');
        if (bad) process.exitCode = 1;
        earlyExit = true;
    } else {
        // Strict validation for real deployment
        if (!username) fail('DEPLOY_USERNAME/username is required');
        if (!privateKeyPath && !merged.password) fail('DEPLOY_SSH_KEY/privateKeyPath or DEPLOY_PASSWORD/password is required');
        if (!remoteDir) fail('DEPLOY_REMOTE_DIR/remoteDir is required (remote target directory)');
        if (!fs.existsSync(localDir)) fail(`Local directory not found: ${localDir}`);
        if (privateKeyPath && !fs.existsSync(privateKeyPath)) fail(`SSH key file not found: ${privateKeyPath}`);
        if (!privateKeyPath && merged.password) {
            console.warn('[deploy] WARNING: Using password authentication. It is recommended to use SSH keys for better security.');
        }
        if (remoteSegments.length < minRemoteDepth) {
            fail(`DEPLOY_REMOTE_DIR seems too shallow: ${remoteDirNorm} (segments=${remoteSegments.length}, min=${minRemoteDepth})`);
        }
        if (preserveFiles.length > 0 && !preserveDir) {
            fail('preserveDir is required when preserveFiles is configured');
        }
    }
}

// ---------- Progress Utilities ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function formatDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '?:??';
    const s = Math.floor(totalSeconds % 60);
    const m = Math.floor((totalSeconds / 60) % 60);
    const h = Math.floor(totalSeconds / 3600);
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

function shortenPath(p, maxLen) {
    if (!p) return '';
    if (p.length <= maxLen) return p;
    const ell = '…';
    const keep = Math.max(4, Math.floor((maxLen - ell.length) / 2));
    return p.slice(0, keep) + ell + p.slice(-keep);
}

function createProgressRenderer(totalFiles, totalBytes) {
    const tty = process.stdout.isTTY;
    const barMin = 10;
    let lastLines = 0;
    return ({ processedFiles, doneBytes, currentPath, startTime }) => {
        if (!tty) return; // don't spam if not a TTY

        const elapsed = (Date.now() - startTime) / 1000;
        const rate = elapsed > 0 ? doneBytes / elapsed : 0; // bytes/sec
        const remainBytes = Math.max(0, totalBytes - doneBytes);
        const eta = rate > 0 ? remainBytes / rate : Infinity;
        const pct = totalFiles > 0 ? Math.min(1, processedFiles / totalFiles) : 0;

        // Compute bar width from terminal columns
        const cols = Math.max(40, (process.stdout.columns || 80));
        const infoPrefix = `Files ${processedFiles}/${totalFiles} (${Math.floor(pct * 100)}%) | elapsed ${formatDuration(elapsed)} | eta ${formatDuration(eta)}`;
        const barWidth = Math.max(barMin, Math.min(40, cols - 10));
        const done = Math.round(pct * barWidth);
        const bar = `[${'#'.repeat(done)}${'.'.repeat(barWidth - done)}]`;
        const pathPrefix = 'Last: ';
        const pathRoom = Math.max(20, cols - pathPrefix.length - 2);
        const shownPath = shortenPath(currentPath || '', pathRoom);

        // Move cursor up to overwrite previous lines
        if (lastLines > 0) {
            readline.moveCursor(process.stdout, 0, -lastLines);
        }
        // Clear down from cursor
        readline.clearScreenDown(process.stdout);

        const lines = [
            infoPrefix,
            bar,
            `${pathPrefix}${shownPath}`,
        ];
        process.stdout.write(lines.join('\n') + '\n');
        lastLines = lines.length;
    };
}

// Recursively walk a directory and return a list of file paths and sizes
function listLocalFiles(rootDir) {
    const results = [];
    const stack = [rootDir];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                stack.push(full);
            } else if (ent.isFile()) {
                try {
                    const st = fs.statSync(full);
                    results.push({ path: path.resolve(full), size: st.size });
                } catch {
                    // ignore
                }
            }
        }
    }
    return results;
}

// Add helpers for passphrase prompting
function isPassphraseError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return /passphrase|encrypted|decrypt|bad auth|pem_read_bio/.test(msg);
}
function promptHiddenPassphrase(question = 'SSH key passphrase: ') {
    if (!process.stdin.isTTY) return Promise.resolve('');
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl._writeToOutput = function _writeToOutput(stringToWrite) {
            if (!this.stdoutMuted) this.output.write(stringToWrite);
        };
        rl.stdoutMuted = true;
        rl.question(question, (answer) => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
    });
}

if (!earlyExit) {
    const client = new SftpClient();
    try {
        // Run any pre-deploy SSH commands (separate SSH connection)
        if (preCommands.length) {
            const { runCommandsOverSSH } = await import('./ssh.mjs');
            const privateKeyBuf = privateKeyPath ? fs.readFileSync(privateKeyPath) : undefined;
            console.log('[deploy] Running pre-deploy commands over SSH...');
            await runCommandsOverSSH({ host, port, username, privateKey: privateKeyBuf, passphrase, password: merged.password }, preCommands, { stopOnError: true });
        }
        // Pre-scan local files for progress tracking
        console.log('[deploy] Scanning local files for upload...');
        const localFiles = listLocalFiles(localDir);
        const totalFiles = localFiles.length;
        const totalBytes = localFiles.reduce((a, f) => a + (f.size || 0), 0);
        const sizeMap = new Map(localFiles.map((f) => [f.path, f.size]));
        // Also map with forward-slashes for robustness
        for (const f of localFiles) {
            sizeMap.set(f.path.replace(/\\/g, '/'), f.size);
        }

        const renderProgress = createProgressRenderer(totalFiles, totalBytes);
        let processedFiles = 0;
        let doneBytes = 0;
        let lastPath = '';
        const startTime = Date.now();

        const privateKey = privateKeyPath ? fs.readFileSync(privateKeyPath) : undefined;
        console.log(`[deploy] Connecting to ${host}:${port} as ${username} ...`);
        try {
            await client.connect({ host, port, username, privateKey, passphrase, password: merged.password });
        } catch (err) {
            if (isPassphraseError(err) && process.stdin.isTTY) {
                passphrase = await promptHiddenPassphrase('SSH key passphrase: ');
                await client.connect({ host, port, username, privateKey, passphrase, password: merged.password });
            } else {
                throw err;
            }
        }

        // ========================================================
        // PRESERVE FILES LOGIC (Move Out)
        // ========================================================
        const preserveDirNorm = preserveDir ? normalizeRemote(preserveDir) : null;
        if (preserveFiles.length > 0 && preserveDirNorm) {
            const exists = await client.exists(remoteDirNorm);
            if (exists) {
                // Ensure preserve folder exists
                if (!(await client.exists(preserveDirNorm))) {
                    console.log(`[deploy] Creating preserve directory: ${preserveDirNorm}`);
                    await client.mkdir(preserveDirNorm, true);
                }

                console.log(`[deploy] Preserving ${preserveFiles.length} file(s) to ${preserveDirNorm}...`);
                for (const file of preserveFiles) {
                    const src = joinRemote(remoteDirNorm, file);
                    const dest = joinRemote(preserveDirNorm, file);
                    const fileExists = await client.exists(src);
                    if (fileExists) {
                        try {
                            // remove dest if it exists to allow overwrite/move
                            if (await client.exists(dest)) await client.delete(dest);
                            await client.rename(src, dest);
                            console.log(`  -> Saved: ${file}`);
                        } catch (err) {
                            console.warn(`  ! Failed to preserve ${file}: ${err.message}`);
                        }
                    } else {
                        console.log(`  (Skipped missing: ${file})`);
                    }
                }
            }
        }

        const exists = await client.exists(remoteDirNorm);
        if (exists) {
            if (archiveExisting) {
                const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
                const baseName = remoteBaseName(remoteDirNorm);
                const archiveParent = archiveDir ? normalizeRemote(archiveDir) : remoteDirName(remoteDirNorm);

                // Ensure archive parent exists
                const archParentExists = await client.exists(archiveParent);
                if (!archParentExists) {
                    console.log(`[deploy] Creating archive parent: ${archiveParent}`);
                    await client.mkdir(archiveParent, true);
                }

                const archiveTarget = joinRemote(archiveParent, `${baseName}-${ts}`);
                console.log(`[deploy] Archiving existing remote: ${remoteDirNorm} -> ${archiveTarget}`);
                await client.rename(remoteDirNorm, archiveTarget);
            } else if (cleanRemote) {
                console.log(`[deploy] Cleaning remote directory: ${remoteDirNorm}`);
                await client.rmdir(remoteDirNorm, true);
            } else {
                console.log(`[deploy] Remote directory exists (${remoteDirNorm}). Proceeding to upload which may overwrite files.`);
            }
        }

        // Ensure fresh target dir exists
        const targetExists = await client.exists(remoteDirNorm);
        if (!targetExists) {
            console.log(`[deploy] Ensuring remote directory: ${remoteDirNorm}`);
            await client.mkdir(remoteDirNorm, true);
        }

        // ========================================================
        // PRESERVE FILES LOGIC (Restore)
        // ========================================================
        if (preserveFiles.length > 0 && preserveDirNorm) {
            console.log(`[deploy] Restoring preserved files from ${preserveDirNorm}...`);
            for (const file of preserveFiles) {
                const src = joinRemote(preserveDirNorm, file);
                const dest = joinRemote(remoteDirNorm, file);
                const fileExists = await client.exists(src);
                if (fileExists) {
                    try {
                        await client.rename(src, dest);
                        console.log(`  -> Restored: ${file}`);
                    } catch (err) {
                        console.warn(`  ! Failed to restore ${file}: ${err.message}`);
                    }
                }
            }
        }

        console.log(`[deploy] Uploading ${localDir} -> ${remoteDirNorm}`);

        // Hook upload progress events
        client.on('upload', (info) => {
            // info: {source, destination}
            // Update counters on each completed file
            processedFiles += 1;
            const src = info?.source ? String(info.source) : '';
            lastPath = path.relative(localDir, src || '') || src || '';
            const key = path.resolve(src);
            const fileSize = sizeMap.get(key) ?? sizeMap.get(src.replace(/\\/g, '/')) ?? 0;
            doneBytes += fileSize;
            renderProgress({ processedFiles, doneBytes, currentPath: lastPath, startTime });
        });

        // Initial render (in case there is a delay before first file)
        renderProgress({ processedFiles, doneBytes, currentPath: 'Starting upload…', startTime });

        await client.uploadDir(localDir, remoteDirNorm);

        // Final render to 100%
        renderProgress({ processedFiles: totalFiles, doneBytes: totalBytes, currentPath: 'Completed', startTime });
        // Add a blank line to separate from next logs
        process.stdout.write('\n');
        console.log('[deploy] Upload complete.');

        // Run any post-deploy SSH commands
        if (postCommands.length) {
            const { runCommandsOverSSH } = await import('./ssh.mjs');
            const privateKeyBuf = privateKeyPath ? fs.readFileSync(privateKeyPath) : undefined;
            console.log('[deploy] Running post-deploy commands over SSH...');
            await runCommandsOverSSH({ host, port, username, privateKey: privateKeyBuf, passphrase, password: merged.password }, postCommands, { stopOnError: false });
        }
    } catch (error) {
        console.error('[deploy] Failed:', error.message || error);
        process.exitCode = 1;
    } finally {
        try { await client.end(); } catch {
            // ignore
        }
    }
}