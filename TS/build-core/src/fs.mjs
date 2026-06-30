import path from 'node:path'
import { defaultLogger } from './logger.mjs'

const { vlog } = defaultLogger(false)

function readEntryFlag(entry, flagNames) {
    for (const flagName of flagNames) {
        const value = entry?.[flagName]

        if (typeof value === 'function') {
            return value.call(entry)
        }

        if (typeof value !== 'undefined') {
            return Boolean(value)
        }
    }

    return false
}

function entryIsDirectory(entry) {
    return readEntryFlag(entry, ['isDirectory'])
}

function entryIsFile(entry) {
    return readEntryFlag(entry, ['isFile'])
}

function entryIsSymbolicLink(entry) {
    return readEntryFlag(entry, ['isSymbolicLink', 'isSymlink'])
}

export async function pathExists(p) {
    try {
        await Deno.stat(p)
        return true
    } catch {
        return false
    }
}

export async function ensureDir(dir) {
    await Deno.mkdir(dir, { recursive: true })
}

export async function removePath(targetPath) {
    try {
        await Deno.remove(targetPath, { recursive: true })
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
            throw error
        }
    }
}

export async function emptyDir(dir) {
    await removePath(dir)
    await ensureDir(dir)
}

// Pre-calculate the total byte size of the target directory/file
async function calculateTotalSize(target, dereference) {
    let total = 0
    const st = await Deno.lstat(target)

    if (entryIsDirectory(st)) {
        for await (const entry of Deno.readDir(target)) {
            total += await calculateTotalSize(path.join(target, entry.name), dereference)
        }
    } else if (entryIsSymbolicLink(st)) {
        if (dereference) {
            const real = await Deno.realPath(target)
            const realSt = await Deno.stat(real)
            if (realSt.isFile) {
                total += realSt.size
            }
        }
    } else if (st.isFile) {
        total += st.size
    }

    return total
}

// Inline terminal progress bar with ETA calculation
function renderProgress(state) {
    const { current, total, startTime } = state
    const width = 40
    const percent = total === 0 ? 100 : Math.floor((current / total) * 100)
    const completed = total === 0 ? width : Math.floor((width * current) / total)
    const bar = "█".repeat(completed) + "-".repeat(width - completed)

    const currentMB = (current / 1024 / 1024).toFixed(2)
    const totalMB = (total / 1024 / 1024).toFixed(2)

    let etaStr = ""
    const SHOW_ETA_THRESHOLD = 500 * 1024 * 1024 // 500 MB

    if (total > SHOW_ETA_THRESHOLD) {
        if (current > 0) {
            const elapsedMs = Date.now() - startTime
            // Wait 1 second before showing ETA to let the speed average out and prevent wild fluctuations
            if (elapsedMs > 1000) {
                const speedBps = current / (elapsedMs / 1000)
                const remainingBytes = total - current
                const remainingSec = Math.ceil(remainingBytes / speedBps)

                if (remainingSec > 0) {
                    const m = Math.floor(remainingSec / 60)
                    const s = remainingSec % 60
                    etaStr = ` | ETA: ${m > 0 ? `${m}m ` : ""}${s}s`
                } else {
                    etaStr = ` | ETA: 0s`
                }
            } else {
                etaStr = ` | ETA: calc...`
            }
        } else {
            etaStr = ` | ETA: calc...`
        }
    }

    // padEnd ensures that if the ETA string shrinks (e.g., "10s" to "9s"), the trailing characters are overwritten
    const text = `\rCopying: [${bar}] ${percent}% (${currentMB} / ${totalMB} MB)${etaStr}`.padEnd(85, " ")
    Deno.stdout.writeSync(new TextEncoder().encode(text))
}

// Web stream chunk copier to measure progress mid-file
async function streamCopyWithProgress(from, to, state) {
    const src = await Deno.open(from, { read: true })
    const dst = await Deno.open(to, { write: true, create: true, truncate: true })

    const transform = new TransformStream({
        transform(chunk, controller) {
            state.current += chunk.byteLength
            renderProgress(state)
            controller.enqueue(chunk)
        }
    })

    await src.readable.pipeThrough(transform).pipeTo(dst.writable)
}

// The internal recursive worker
async function _copyPathRecursive(from, to, options, state) {
    const { overwrite, dereference } = options
    await ensureDir(path.dirname(to))

    try {
        const st = await Deno.lstat(from)
        if (entryIsDirectory(st)) {
            await ensureDir(to)
            for await (const entry of Deno.readDir(from)) {
                const src = path.join(from, entry.name)
                const dst = path.join(to, entry.name)
                await _copyPathRecursive(src, dst, options, state)
            }
            return
        }

        if (entryIsSymbolicLink(st)) {
            vlog(`[symlink] ${from} -> ${to}`)
            if (!dereference) {
                const link = await Deno.readLink(from)
                if (overwrite) {
                    await removePath(to).catch(() => {})
                }
                await Deno.symlink(link, to)
                return
            }

            const real = await Deno.realPath(from)
            const realSt = await Deno.stat(real) // Get stats of the actual target

            if (realSt.isDirectory) {
                // FIX: If the target is a directory, recurse instead of streaming
                await ensureDir(to)
                for await (const entry of Deno.readDir(real)) {
                    const src = path.join(real, entry.name)
                    const dst = path.join(to, entry.name)
                    await _copyPathRecursive(src, dst, options, state)
                }
                return
            }

            // Otherwise, it is a file; perform stream copy
            if (overwrite) {
                await removePath(to).catch(() => {})
            }
            await streamCopyWithProgress(real, to, state)
            return
        }

        if (overwrite) {
            await removePath(to).catch(() => {})
        }

        await streamCopyWithProgress(from, to, state)
    } catch (err) {
        console.error(`\n[FATAL] Error copying file: "${from}" -> "${to}"`);
        throw err;
    }
}

// Main exported function
export async function copyPath(from, to, {
    overwrite = true,
    dereference = false,
} = {}) {
    const totalSize = await calculateTotalSize(from, dereference)

    // Pass state object by reference so the transform stream can mutate it
    const state = {
        current: 0,
        total: totalSize,
        startTime: Date.now()
    }

    // Render the initial 0% state
    renderProgress(state)

    await _copyPathRecursive(from, to, { overwrite, dereference }, state)

    // Drop down to a fresh line when finished so subsequent logs aren't overwritten
    Deno.stdout.writeSync(new TextEncoder().encode("\n"))
}

function shouldIncludeName(name, { includeDot }) {
    if (includeDot) {
        return true
    }
    return !name.startsWith('.')
}

export async function listTreeRelative(rootDir, {
    includeDot = true,
    includeDirs = true,
    includeFiles = true,
} = {}) {
    const out = []
    if (!(await pathExists(rootDir))) {
        return out
    }

    const stack = [{ abs: rootDir, rel: '' }]
    while (stack.length) {
        const { abs, rel } = stack.pop()
        for await (const entry of Deno.readDir(abs)) {
            if (!shouldIncludeName(entry.name, { includeDot })) {
                continue
            }
            const childAbs = path.join(abs, entry.name)
            const childRel = rel ? path.join(rel, entry.name) : entry.name
            if (entryIsDirectory(entry)) {
                if (includeDirs) {
                    out.push(childRel)
                }
                stack.push({ abs: childAbs, rel: childRel })
            } else if (includeFiles) {
                out.push(childRel)
            }
        }
    }
    return out
}

export async function listFilesRelative(rootDir, { includeDot = true } = {}) {
    return listTreeRelative(rootDir, { includeDot, includeDirs: false, includeFiles: true })
}

export function toPosixPath(p) {
    return p.split(path.sep).join('/')
}

export {
    entryIsDirectory,
    entryIsFile,
    entryIsSymbolicLink,
}
