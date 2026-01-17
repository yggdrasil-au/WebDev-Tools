import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';

// Load .env.deploy if present
const envPath = path.resolve(process.cwd(), '.env.deploy');
if (fs.existsSync(envPath)) {
    try {
        const dotenv = await import('dotenv');
        dotenv.config({ path: envPath });
    } catch (e) { /* ignore */ }
}

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

async function loadConfigFile(configPath) {
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

export async function getConfiguration() {
    const parsed = parseArgs(process.argv.slice(2));
    const loadedConfig = await loadConfigFile(parsed.flags['config']);
    
    const availableProfiles = Object.keys(loadedConfig.deployments || {});
    const listMode = parsed.list;
    
    if (listMode) return { listMode, availableProfiles };

    if (loadedConfig.path) console.log(`[deploy] Loaded config from ${path.basename(loadedConfig.path)}`);

    const selectedProfile = parsed.flags['profile'] || parsed.profile;
    const profileCfg = (selectedProfile && loadedConfig.deployments?.[selectedProfile]) || {};

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
    
    const toCmdArray = (cfg, cli) => {
        const arr = [];
        if (Array.isArray(cfg)) arr.push(...cfg);
        if (typeof cli === 'string' && cli) arr.push(cli);
        return arr;
    };
    
    merged.preCommands = toCmdArray(merged.preCommands, parsed.flags['pre']);
    merged.postCommands = toCmdArray(merged.postCommands, parsed.flags['post']);
    merged.localDir = path.resolve(merged.localDir); // Resolve explicitly
    merged.dryRun = Boolean(parsed.flags['check'] || parsed.flags['dry-run']);

    return { config: merged, dryRun: merged.dryRun };
}
