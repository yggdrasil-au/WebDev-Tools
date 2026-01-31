#!/usr/bin/env node

// This script is invoked by `postinstall` in package.json
// It detects the OS and runs the appropriate build step for NetDeploy.

const { execSync } = require("child_process");
const os = require("os");

/* :: :: Prechecks :: START :: */

try {
    execSync("dotnet --version", { stdio: "ignore" });
} catch (error) {
    console.error("[netdeploy] ERROR: .NET SDK is not installed or not in PATH.");
    console.error("[netdeploy] Please install the .NET SDK to proceed with the build.");
    process.exit(1);
}

/* :: :: Prechecks :: END :: */

/* :: :: Entry :: START :: */

const platform = os.platform();

if (platform === "win32") {
    execSync("pnpm run build", { stdio: "inherit" });
} else if (platform === "linux") {
    execSync("pnpm run build-linux", { stdio: "inherit" });
} else if (platform === "darwin") {
    console.error("[netdeploy] ERROR: macOS build not configured in package.json.");
    console.error("[netdeploy] Add an osx-x64 publish script or run:\n  dotnet publish NetDeploy.csproj -c Release -r osx-x64 --self-contained false -o dist");
    process.exit(1);
} else {
    console.error("[netdeploy] ERROR: Unsupported OS for build script.");
    process.exit(1);
}

/* :: :: Entry :: END :: */
