#!/usr/bin/env deno

import { resolve } from "jsr:@std/path@1.1.5";
import { getExecutablePath } from "./lib/runtime-paths.ts";

const textDecoder = new TextDecoder();

/* :: :: Helpers :: START :: */

function printUsage () {
    console.log([
        "caddy-cli usage:",
        "  caddy-cli start --ConfigFile <path> --DocumentRoot <path> --port <number> [--output]",
        "",
        "Example:",
        "  caddy-cli start --output --ConfigFile ./buildConfig/Caddyfile --DocumentRoot ./www/website --port 8080",
    ].join("\n"));
}

interface ParsedFlags {
    ConfigFile?: string;
    DocumentRoot?: string;
    port?: string;
    output?: boolean;
    [key: string]: string | boolean | undefined;
}

function parseFlags (args: string[]): ParsedFlags {
    const flags: ParsedFlags = {};

    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];

        if (token === "--output") {
            flags.output = true;
            continue;
        }

        if (!token.startsWith("--")) {
            continue;
        }

        const key = token.slice(2);
        const next = args[index + 1];

        if (!next || next.startsWith("--")) {
            flags[key] = true;
            continue;
        }

        flags[key] = next;
        index += 1;
    }

    return flags;
}

function resolveAbsolutePath (inputPath: string | undefined) {
    if (!inputPath) {
        return "";
    }
    return resolve(Deno.cwd(), inputPath);
}

async function pathExists (inputPath: string | URL) {
    try {
        await Deno.stat(inputPath);
        return true;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return false;
        }

        throw error;
    }
}

function validatePort (portValue: any) {
    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --port value: ${portValue}`);
    }
    return String(port);
}

function buildRunArguments (configPath: string) {
    const lowerConfigPath = configPath.toLowerCase();
    if (lowerConfigPath.endsWith(".json")) {
        return ["run", "--config", configPath];
    }

    return ["run", "--adapter", "caddyfile", "--config", configPath];
}

/* :: :: Helpers :: END :: */

// //

/* :: :: Commands :: START :: */

async function startServer (args: string[]): Promise<number> {
    const flags = parseFlags(args);

    const configPath = resolveAbsolutePath(flags.ConfigFile);
    const documentRoot = resolveAbsolutePath(flags.DocumentRoot);

    if (!configPath) {
        throw new Error("Missing required flag: --ConfigFile");
    }
    if (!documentRoot) {
        throw new Error("Missing required flag: --DocumentRoot");
    }
    if (!await pathExists(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }
    if (!await pathExists(documentRoot)) {
        throw new Error(`Document root not found: ${documentRoot}`);
    }

    const port = validatePort(flags.port ?? "8080");

    const caddyPath = getExecutablePath();
    if (!await pathExists(caddyPath)) {
        throw new Error([
            `Caddy binary not found: ${caddyPath}`,
            "Run installation again to trigger postinstall download.",
        ].join("\n"));
    }

    const runArgs = buildRunArguments(configPath);

    const child = new Deno.Command(caddyPath, {
        args: runArgs,
        cwd: Deno.cwd(),
        env: {
            ...Deno.env.toObject(),
            DOCUMENT_ROOT: documentRoot,
            PORT: port,
        },
        stdin: "inherit",
        stdout: flags.output ? "inherit" : "null",
        stderr: flags.output ? "inherit" : "null",
    }).spawn();

    const status = await child.status;
    return status.success ? 0 : (status.code ?? 1);
}

/* :: :: Commands :: END :: */

// //

/* :: :: Main :: START :: */

async function main () {
    const command = Deno.args[0];
    const args = Deno.args.slice(1);

    if (!command || command === "--help" || command === "-h") {
        printUsage();
        return;
    }

    switch (command) {
        case "start": {
            const exitCode = await startServer(args);
            if (exitCode !== 0) {
                Deno.exit(exitCode);
            }
            break;
        }
        default: {
            throw new Error(`Unsupported command: ${command}`);
        }
    }
}

try {
    await main();
} catch (error) {
    console.error(`[caddy-cli] ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    Deno.exit(1);
}

/* :: :: Main :: END :: */
