import path from 'node:path'

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

export async function copyPath(from, to, {
    overwrite = true,
    dereference = false,
} = {}) {
    await ensureDir(path.dirname(to))

    const st = await Deno.lstat(from)
    if (entryIsDirectory(st)) {
        await ensureDir(to)
        for await (const entry of Deno.readDir(from)) {
            const src = path.join(from, entry.name)
            const dst = path.join(to, entry.name)
            await copyPath(src, dst, { overwrite, dereference })
        }
        return
    }

    if (entryIsSymbolicLink(st)) {
        if (!dereference) {
            const link = await Deno.readLink(from)
            if (overwrite) {
                await removePath(to).catch(() => {})
            }
            await Deno.symlink(link, to)
            return
        }
        const real = await Deno.realPath(from)
        if (overwrite) {
            await removePath(to).catch(() => {})
        }
        await Deno.copyFile(real, to)
        return
    }

    if (overwrite) {
        await removePath(to).catch(() => {})
    }
    await Deno.copyFile(from, to)
}

function shouldIncludeName(name, { includeDot }) {
    if (includeDot) return true
    return !name.startsWith('.')
}

export async function listTreeRelative(rootDir, {
    includeDot = true,
    includeDirs = true,
    includeFiles = true,
} = {}) {
    const out = []
    if (!(await pathExists(rootDir))) return out

    const stack = [{ abs: rootDir, rel: '' }]
    while (stack.length) {
        const { abs, rel } = stack.pop()
        for await (const entry of Deno.readDir(abs)) {
            if (!shouldIncludeName(entry.name, { includeDot })) continue
            const childAbs = path.join(abs, entry.name)
            const childRel = rel ? path.join(rel, entry.name) : entry.name
            if (entryIsDirectory(entry)) {
                if (includeDirs) out.push(childRel)
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

