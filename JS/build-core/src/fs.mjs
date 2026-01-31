import { promises as fs } from 'node:fs'
import path from 'node:path'

export async function pathExists(p) {
    try {
        await fs.access(p)
        return true
    } catch {
        return false
    }
}

export async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true })
}

export async function removePath(targetPath) {
    await fs.rm(targetPath, { recursive: true, force: true })
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

    if (typeof fs.cp === 'function') {
        await fs.cp(from, to, { recursive: true, force: overwrite, dereference })
        return
    }

    const st = await fs.lstat(from)
    if (st.isDirectory()) {
        await ensureDir(to)
        const entries = await fs.readdir(from, { withFileTypes: true })
        for (const entry of entries) {
            const src = path.join(from, entry.name)
            const dst = path.join(to, entry.name)
            await copyPath(src, dst, { overwrite, dereference })
        }
        return
    }

    if (st.isSymbolicLink()) {
        if (!dereference) {
            const link = await fs.readlink(from)
            try { await fs.unlink(to) } catch {}
            await fs.symlink(link, to)
            return
        }
        const real = await fs.realpath(from)
        await fs.copyFile(real, to)
        return
    }

    await fs.copyFile(from, to)
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
        const entries = await fs.readdir(abs, { withFileTypes: true })
        for (const entry of entries) {
            if (!shouldIncludeName(entry.name, { includeDot })) continue
            const childAbs = path.join(abs, entry.name)
            const childRel = rel ? path.join(rel, entry.name) : entry.name
            if (entry.isDirectory()) {
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

