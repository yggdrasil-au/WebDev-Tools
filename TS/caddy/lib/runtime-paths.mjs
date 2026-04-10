import path from "node:path";
import { fileURLToPath } from "node:url";

/* :: :: Constants :: START :: */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(PACKAGE_ROOT, ".runtime");

/* :: :: Constants :: END :: */

// //

/* :: :: Exports :: START :: */

export function getExecutableNameForPlatform () {
    return Deno.build.os === "windows" ? "caddy.exe" : "caddy";
}

export function getExecutablePath () {
    return path.join(RUNTIME_DIR, getExecutableNameForPlatform());
}

export async function ensureRuntimeDir () {
    await Deno.mkdir(RUNTIME_DIR, { recursive: true });
}

export function getRuntimeDir () {
    return RUNTIME_DIR;
}

/* :: :: Exports :: END :: */
