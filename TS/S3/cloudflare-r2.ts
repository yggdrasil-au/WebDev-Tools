import { existsSync } from "@std/fs";
import { extname, resolve } from "@std/path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export interface R2CredentialsConfig {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    bucket: string;
    region?: string;
}

export interface UploadToR2Options {
    filePath: string;
    destinationKey: string;
    contentType?: string;
    config?: R2CredentialsConfig;
    rootPath?: string;
    configDbPath?: string;
    sqlWasmPath?: string;
}

function resolveDefaultPaths(options?: Partial<UploadToR2Options>) {
    const rootPath = options?.rootPath || Deno.cwd();
    const configDbPath = resolve(rootPath, "subModules/Database-Orchestrator/config.sqlite3");
    const sqlWasmPath = resolve(rootPath, "node_modules/sql.js/dist/sql-wasm.wasm");
    return { rootPath, configDbPath, sqlWasmPath };
}

function guessContentType(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    switch (ext) {
        case ".png": {
            return "image/png";
        }
        case ".jpg":
        case ".jpeg": {
            return "image/jpeg";
        }
        case ".webp": {
            return "image/webp";
        }
        case ".gif": {
            return "image/gif";
        }
        case ".svg": {
            return "image/svg+xml";
        }
        case ".json": {
            return "application/json";
        }
        case ".txt": {
            return "text/plain; charset=utf-8";
        }
        case ".html": {
            return "text/html; charset=utf-8";
        }
        case ".css": {
            return "text/css; charset=utf-8";
        }
        case ".js":
        case ".mjs":
        case ".ts": {
            return "text/javascript; charset=utf-8";
        }
        default: {
            return "application/octet-stream";
        }
    }
}

export async function getConfigFromSqlite(options?: Partial<UploadToR2Options>): Promise<R2CredentialsConfig> {
    const defaults = resolveDefaultPaths(options);
    const configDbPath = options?.configDbPath || defaults.configDbPath;
    const sqlWasmPath = options?.sqlWasmPath || defaults.sqlWasmPath;

    if (!existsSync(configDbPath)) {
        throw new Error(`Config database not found at '${configDbPath}'. Provide --configDb or --root.`);
    }
    if (!existsSync(sqlWasmPath)) {
        throw new Error(`sql.js wasm not found at '${sqlWasmPath}'. Provide --sqlWasm or --root.`);
    }

    const SQLMod = await import("sql.js");
    const initSqlJs = SQLMod.default || SQLMod;
    const SQL = await initSqlJs({ wasmBinary: Deno.readFileSync(sqlWasmPath) });

    const fileBuffer = Deno.readFileSync(configDbPath);
    const db = new SQL.Database(fileBuffer);

    const stmt = db.prepare("SELECT access_key_id, secret_access_key, endpoint, bucket, region FROM r2_config LIMIT 1");
    try {
        if (!stmt.step()) {
            throw new Error("No configuration found in 'r2_config' table.");
        }
        const row = stmt.getAsObject();
        return {
            accessKeyId: String(row.access_key_id || ""),
            secretAccessKey: String(row.secret_access_key || ""),
            endpoint: String(row.endpoint || ""),
            bucket: String(row.bucket || ""),
            region: row.region ? String(row.region) : undefined,
        };
    } finally {
        stmt.free();
        db.close();
    }
}

function assertNonEmpty(value: any, name: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Missing required '${name}'.`);
    }
}

function normalizeConfig(config: R2CredentialsConfig): R2CredentialsConfig {
    assertNonEmpty(config.accessKeyId, "accessKeyId");
    assertNonEmpty(config.secretAccessKey, "secretAccessKey");
    assertNonEmpty(config.endpoint, "endpoint");
    assertNonEmpty(config.bucket, "bucket");
    return {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        endpoint: config.endpoint,
        bucket: config.bucket,
        region: config.region || "auto",
    };
}

export async function uploadToR2(options: UploadToR2Options): Promise<{ bucket: string; key: string; contentType: string }> {
    if (!options || typeof options !== "object") {
        throw new Error("uploadToR2(options) requires an options object.");
    }

    assertNonEmpty(options.filePath, "filePath");
    assertNonEmpty(options.destinationKey, "destinationKey");

    if (!existsSync(options.filePath)) {
        throw new Error(`File not found at '${options.filePath}'.`);
    }

    const config = options.config
        ? normalizeConfig(options.config)
        : normalizeConfig(await getConfigFromSqlite({
            rootPath: options.rootPath,
            configDbPath: options.configDbPath,
            sqlWasmPath: options.sqlWasmPath,
        }));

    const s3 = new S3Client({
        region: config.region || "auto",
        endpoint: config.endpoint,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });

    const contentType = options.contentType || guessContentType(options.filePath);
    const fileBytes = await Deno.readFile(options.filePath);
    
    const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: options.destinationKey,
        Body: fileBytes,
        ContentType: contentType,
    });

    await s3.send(command);
    
    // Explicitly destroy the client to prevent dangling Node.js compatible handles from keeping Deno alive
    s3.destroy();
    
    return { bucket: config.bucket, key: options.destinationKey, contentType };
}

function printHelp(): void {
    const lines = [
        "cloudflare-r2 - upload files to Cloudflare R2",
        "",
        "Usage:",
        "  cloudflare-r2 --file <path> --key <r2-key> [options]",
        "",
        "Config (choose one):",
        "  --configDb <path>     Path to SQLite config DB (table r2_config)",
        "  --sqlWasm <path>      Path to sql.js wasm (sql-wasm.wasm)",
        "  --root <path>         Root used to resolve defaults for configDb/sqlWasm",
        "",
        "  OR provide credentials directly:",
        "  --accessKeyId <id>",
        "  --secretAccessKey <secret>",
        "  --endpoint <url>",
        "  --bucket <name>",
        "  --region <region>     Optional (default: auto)",
        "",
        "Other:",
        "  --contentType <type>  Override guessed content-type",
        "  --help                Show help",
        "",
        "Examples:",
        "  cloudflare-r2 --file ./logo.png --key assets/logo.png --root a:/WebDev/Sites/Anime-Dimension/main",
        "  cloudflare-r2 --file ./data.json --key data/data.json --configDb a:/path/config.sqlite3 --sqlWasm a:/path/sql-wasm.wasm",
    ];
    console.log(lines.join("\n"));
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        if (!token.startsWith("--")) {
            continue;
        }
        const key = token.slice(2);
        const next = argv[index + 1];
        if (!next || next.startsWith("--")) {
            out[key] = true;
            continue;
        }
        out[key] = next;
        index++;
    }
    return out;
}

export async function runCli(argv?: string[]): Promise<number> {
    const args = parseArgs(argv || Deno.args);
    if (args.help) {
        printHelp();
        return 0;
    }

    const filePath = args.file as string;
    const destinationKey = args.key as string;
    const contentType = typeof args.contentType === "string" ? args.contentType : undefined;

    let config: R2CredentialsConfig | undefined = undefined;
    if (typeof args.accessKeyId === "string" || typeof args.secretAccessKey === "string" || typeof args.endpoint === "string" || typeof args.bucket === "string") {
        config = {
            accessKeyId: String(args.accessKeyId || ""),
            secretAccessKey: String(args.secretAccessKey || ""),
            endpoint: String(args.endpoint || ""),
            bucket: String(args.bucket || ""),
            region: typeof args.region === "string" ? args.region : undefined,
        };
    }

    try {
        const result = await uploadToR2({
            filePath,
            destinationKey,
            contentType,
            config,
            rootPath: typeof args.root === "string" ? args.root : undefined,
            configDbPath: typeof args.configDb === "string" ? args.configDb : undefined,
            sqlWasmPath: typeof args.sqlWasm === "string" ? args.sqlWasm : undefined,
        });
        console.log(`Uploaded '${result.key}' to bucket '${result.bucket}' (${result.contentType})`);
        return 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        return 1;
    }
}

if (import.meta.main) {
    const code = await runCli();
    Deno.exit(code);
}