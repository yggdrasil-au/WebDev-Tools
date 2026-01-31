#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

/* :: :: Entry :: START :: */

const isWin = os.platform() === "win32";
const binaryName = isWin ? "NetDeploy.exe" : "NetDeploy";
const binaryPath = path.join(__dirname, "dist", binaryName);

if (!fs.existsSync(binaryPath)) {
    console.error(`[netdeploy] ERROR: executable not found at "${binaryPath}"`);
    console.error(`[netdeploy] Please run "pnpm build" in this directory.`);
    process.exit(1);
}

const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: "inherit",
    env: process.env,
});

child.on("close", (code) => {
    process.exit(code);
});

/* :: :: Entry :: END :: */
