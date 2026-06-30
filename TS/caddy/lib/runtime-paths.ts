import { join, resolve, dirname } from "jsr:@std/path@1.1.5";
import { fromFileUrl } from "jsr:@std/path@1.1.5";

/* :: :: Constants :: START :: */

const __dirname = dirname(fromFileUrl(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const RUNTIME_DIR = join(PACKAGE_ROOT, ".runtime");

/* :: :: Constants :: END :: */

// //

/* :: :: Exports :: START :: */

export function getExecutableNameForPlatform (): string {
    return Deno.build.os === "windows" ? "caddy.exe" : "caddy";
}

export function getExecutablePath (): string {
    return join(RUNTIME_DIR, getExecutableNameForPlatform());
}

export async function ensureRuntimeDir (): Promise<void> {
    await Deno.mkdir(RUNTIME_DIR, { recursive: true });
}

export function getRuntimeDir (): string {
    return RUNTIME_DIR;
}

/* :: :: Exports :: END :: */
