import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * Cloudflare R2 upload helper.
 *
 * Supports two usage styles:
 * 1) Library import: `import { uploadToR2 } from '@yggdrasil-au/cloudflare-r2'`
 * 2) CLI/bin usage: `cloudflare-r2 --file ... --key ... [--configDb ... --sqlWasm ...]`
 *
 * This module intentionally does not call `process.exit()` from library functions.
 */

/**
 * @typedef {Object} R2CredentialsConfig
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} endpoint
 * @property {string} bucket
 * @property {string | undefined} [region]
 */

/**
 * @typedef {Object} UploadToR2Options
 * @property {string} filePath
 * @property {string} destinationKey
 * @property {string | undefined} [contentType]
 * @property {R2CredentialsConfig | undefined} [config]
 * @property {string | undefined} [rootPath]
 * @property {string | undefined} [configDbPath]
 * @property {string | undefined} [sqlWasmPath]
 */

function resolveDefaultPaths(options) {
	const rootPath = options?.rootPath || process.cwd();
	const configDbPath = path.resolve(rootPath, 'subModules/Database-Orchestrator/config.sqlite3');
	const sqlWasmPath = path.resolve(rootPath, 'node_modules/sql.js/dist/sql-wasm.wasm');
	return { rootPath, configDbPath, sqlWasmPath };
}

function guessContentType(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case '.png': return 'image/png';
		case '.jpg':
		case '.jpeg': return 'image/jpeg';
		case '.webp': return 'image/webp';
		case '.gif': return 'image/gif';
		case '.svg': return 'image/svg+xml';
		case '.json': return 'application/json';
		case '.txt': return 'text/plain; charset=utf-8';
		case '.html': return 'text/html; charset=utf-8';
		case '.css': return 'text/css; charset=utf-8';
		case '.js': return 'text/javascript; charset=utf-8';
		case '.mjs': return 'text/javascript; charset=utf-8';
		default: return 'application/octet-stream';
	}
}

/**
 * Loads R2 config from a SQLite database using sql.js.
 *
 * Table expected: `r2_config`
 * Columns: access_key_id, secret_access_key, endpoint, bucket, region
 *
 * @param {{rootPath?: string, configDbPath?: string, sqlWasmPath?: string}} [options]
 * @returns {Promise<R2CredentialsConfig>}
 */
async function getConfigFromSqlite(options) {
	const defaults = resolveDefaultPaths(options);
	const configDbPath = options?.configDbPath || defaults.configDbPath;
	const sqlWasmPath = options?.sqlWasmPath || defaults.sqlWasmPath;

	if (!fs.existsSync(configDbPath)) {
		throw new Error(`Config database not found at '${configDbPath}'. Provide --configDb or --root.`);
	}
	if (!fs.existsSync(sqlWasmPath)) {
		throw new Error(`sql.js wasm not found at '${sqlWasmPath}'. Provide --sqlWasm or --root.`);
	}

	const SQLMod = await import('sql.js');
	const initSqlJs = SQLMod.default || SQLMod;
	const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(sqlWasmPath) });

	const fileBuffer = fs.readFileSync(configDbPath);
	const db = new SQL.Database(fileBuffer);

	const stmt = db.prepare('SELECT access_key_id, secret_access_key, endpoint, bucket, region FROM r2_config LIMIT 1');
	try {
		if (!stmt.step()) {
			throw new Error("No configuration found in 'r2_config' table.");
		}
		const row = stmt.getAsObject();
		return {
			accessKeyId: String(row.access_key_id || ''),
			secretAccessKey: String(row.secret_access_key || ''),
			endpoint: String(row.endpoint || ''),
			bucket: String(row.bucket || ''),
			region: row.region ? String(row.region) : undefined,
		};
	} finally {
		stmt.free();
		db.close();
	}
}

function assertNonEmpty(value, name) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`Missing required '${name}'.`);
	}
}

function normalizeConfig(config) {
	assertNonEmpty(config.accessKeyId, 'accessKeyId');
	assertNonEmpty(config.secretAccessKey, 'secretAccessKey');
	assertNonEmpty(config.endpoint, 'endpoint');
	assertNonEmpty(config.bucket, 'bucket');
	return {
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		endpoint: config.endpoint,
		bucket: config.bucket,
		region: config.region || 'auto',
	};
}

/**
 * Uploads a file to Cloudflare R2.
 *
 * You can either:
 * - pass `options.config` directly, OR
 * - omit `options.config` and pass `configDbPath/sqlWasmPath` (or `rootPath`) to load config from SQLite.
 *
 * @param {UploadToR2Options} options
 * @returns {Promise<{bucket: string, key: string, contentType: string}>}
 */
async function uploadToR2(options) {
	if (!options || typeof options !== 'object') {
		throw new Error('uploadToR2(options) requires an options object.');
	}

	assertNonEmpty(options.filePath, 'filePath');
	assertNonEmpty(options.destinationKey, 'destinationKey');

	if (!fs.existsSync(options.filePath)) {
		throw new Error(`File not found at '${options.filePath}'.`);
	}

	/** @type {R2CredentialsConfig} */
	const config = options.config
		? normalizeConfig(options.config)
		: normalizeConfig(await getConfigFromSqlite({
			rootPath: options.rootPath,
			configDbPath: options.configDbPath,
			sqlWasmPath: options.sqlWasmPath,
		}));

	const s3 = new S3Client({
		region: config.region || 'auto',
		endpoint: config.endpoint,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		},
	});

	const contentType = options.contentType || guessContentType(options.filePath);
	const fileStream = fs.createReadStream(options.filePath);
	const command = new PutObjectCommand({
		Bucket: config.bucket,
		Key: options.destinationKey,
		Body: fileStream,
		ContentType: contentType,
	});

	await s3.send(command);
	return { bucket: config.bucket, key: options.destinationKey, contentType };
}

function printHelp() {
	const lines = [
		'cloudflare-r2 - upload files to Cloudflare R2',
		'',
		'Usage:',
		'  cloudflare-r2 --file <path> --key <r2-key> [options]',
		'',
		'Config (choose one):',
		'  --configDb <path>     Path to SQLite config DB (table r2_config)',
		'  --sqlWasm <path>      Path to sql.js wasm (sql-wasm.wasm)',
		'  --root <path>         Root used to resolve defaults for configDb/sqlWasm',
		'',
		'  OR provide credentials directly:',
		'  --accessKeyId <id>',
		'  --secretAccessKey <secret>',
		'  --endpoint <url>',
		'  --bucket <name>',
		'  --region <region>     Optional (default: auto)',
		'',
		'Other:',
		'  --contentType <type>  Override guessed content-type',
		'  --help                Show help',
		'',
		'Examples:',
		'  cloudflare-r2 --file ./logo.png --key assets/logo.png --root a:/WebDev/Sites/Anime-Dimension/main',
		'  cloudflare-r2 --file ./data.json --key data/data.json --configDb a:/path/config.sqlite3 --sqlWasm a:/path/sql-wasm.wasm',
	];
	// eslint-disable-next-line no-console
	console.log(lines.join('\n'));
}

function parseArgs(argv) {
	/** @type {Record<string, string | boolean>} */
	const out = {};
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!token.startsWith('--')) {
			continue;
		}
		const key = token.slice(2);
		const next = argv[index + 1];
		if (!next || next.startsWith('--')) {
			out[key] = true;
			continue;
		}
		out[key] = next;
		index++;
	}
	return out;
}

/**
 * CLI runner for the `cloudflare-r2` bin.
 *
 * @param {string[]} [argv]
 * @returns {Promise<number>} exit code
 */
async function runCli(argv) {
	const args = parseArgs(argv || process.argv.slice(2));
	if (args.help) {
		printHelp();
		return 0;
	}

	const filePath = /** @type {string} */ (args.file);
	const destinationKey = /** @type {string} */ (args.key);
	const contentType = typeof args.contentType === 'string' ? args.contentType : undefined;

	/** @type {R2CredentialsConfig | undefined} */
	let config;
	if (typeof args.accessKeyId === 'string' || typeof args.secretAccessKey === 'string' || typeof args.endpoint === 'string' || typeof args.bucket === 'string') {
		config = {
			accessKeyId: String(args.accessKeyId || ''),
			secretAccessKey: String(args.secretAccessKey || ''),
			endpoint: String(args.endpoint || ''),
			bucket: String(args.bucket || ''),
			region: typeof args.region === 'string' ? args.region : undefined,
		};
	}

	try {
		const result = await uploadToR2({
			filePath,
			destinationKey,
			contentType,
			config,
			rootPath: typeof args.root === 'string' ? args.root : undefined,
			configDbPath: typeof args.configDb === 'string' ? args.configDb : undefined,
			sqlWasmPath: typeof args.sqlWasm === 'string' ? args.sqlWasm : undefined,
		});
		// eslint-disable-next-line no-console
		console.log(`Uploaded '${result.key}' to bucket '${result.bucket}' (${result.contentType})`);
		return 0;
	} catch (error) {
		// eslint-disable-next-line no-console
		console.error(error instanceof Error ? error.message : error);
		return 1;
	}
}

export {
	getConfigFromSqlite,
	uploadToR2,
	runCli,
};

// If somebody runs this file directly (node cloudflare-R2.mjs ...), behave like the CLI.
const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(selfPath)) {
	const code = await runCli();
	process.exitCode = code;
}

