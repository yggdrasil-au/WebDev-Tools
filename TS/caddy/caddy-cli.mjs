#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { getExecutablePath } from "./lib/runtime-paths.mjs";

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

function parseFlags (args) {
    const flags = {};

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

function resolveAbsolutePath (inputPath) {
    if (!inputPath) {
        return "";
    }
    return path.resolve(process.cwd(), inputPath);
}

function validatePort (portValue) {
    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --port value: ${portValue}`);
    }
    return String(port);
}

function buildRunArguments (configPath) {
    const lowerConfigPath = configPath.toLowerCase();
    if (lowerConfigPath.endsWith(".json")) {
        return ["run", "--config", configPath];
    }

    return ["run", "--adapter", "caddyfile", "--config", configPath];
}

/* :: :: Helpers :: END :: */

// //

/* :: :: Commands :: START :: */

function startServer (args) {
    const flags = parseFlags(args);

    const configPath = resolveAbsolutePath(flags.ConfigFile);
    const documentRoot = resolveAbsolutePath(flags.DocumentRoot);

    if (!configPath) {
        throw new Error("Missing required flag: --ConfigFile");
    }
    if (!documentRoot) {
        throw new Error("Missing required flag: --DocumentRoot");
    }
    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }
    if (!fs.existsSync(documentRoot)) {
        throw new Error(`Document root not found: ${documentRoot}`);
    }

    const port = validatePort(flags.port ?? "8080");

    const caddyPath = getExecutablePath();
    if (!fs.existsSync(caddyPath)) {
        throw new Error([
            `Caddy binary not found: ${caddyPath}`,
            "Run installation again to trigger postinstall download.",
        ].join("\n"));
    }

    const runArgs = buildRunArguments(configPath);

    const child = spawn(caddyPath, runArgs, {
        cwd: process.cwd(),
        env: {
            ...process.env,
            DOCUMENT_ROOT: documentRoot,
            PORT: port,
        },
        stdio: flags.output ? "inherit" : "pipe",
    });

    child.on("error", (error) => {
        console.error(`[caddy-cli] failed to start caddy: ${error.message}`);
        process.exitCode = 1;
    });

    child.on("exit", (code, signal) => {
        if (signal) {
            process.exitCode = 1;
            return;
        }
        process.exitCode = code ?? 0;
    });
}

/* :: :: Commands :: END :: */

// //

/* :: :: Main :: START :: */

function main () {
    const command = process.argv[2];
    const args = process.argv.slice(3);

    if (!command || command === "--help" || command === "-h") {
        printUsage();
        return;
    }

    switch (command) {
        case "start": {
            startServer(args);
            break;
        }
        default: {
            throw new Error(`Unsupported command: ${command}`);
        }
    }
}

try {
    main();
} catch (error) {
    console.error(`[caddy-cli] ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    process.exitCode = 1;
}

/* :: :: Main :: END :: */
