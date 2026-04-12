import path from 'node:path'
import { entryIsDirectory } from './fs.mjs'
import { runPackageScript } from './exec.mjs'

export function defaultClassifyChange(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.scss') return 'scss'
    if (ext === '.ts') return 'ts'
    if (ext === '.astro') return 'astro'
    return null
}

async function listDirsRecursive(baseDir) {
    const dirs = [baseDir]
    const stack = [baseDir]
    while (stack.length) {
        const dir = stack.pop()
        try {
            for await (const entry of Deno.readDir(dir)) {
                if (!entryIsDirectory(entry)) continue
                if (entry.name.startsWith('.')) continue
                const child = path.join(dir, entry.name)
                dirs.push(child)
                stack.push(child)
            }
        } catch {
            continue
        }
    }
    return dirs
}

export async function ensureDirWatchers(baseDir, onEvent) {
    const watchers = new Map()

    const watchDir = (dir, recursive) => {
        if (watchers.has(dir)) return
        try {
            const watcher = Deno.watchFs(dir, { recursive })
            watchers.set(dir, watcher)

            const consume = (async () => {
                for await (const event of watcher) {
                    const fullPath = event.paths[0]
                    if (!fullPath) continue
                    onEvent(event.kind, fullPath)
                }
            })()

            consume.catch(() => {})
        } catch {
            // ignore
        }
    }

    try {
        watchDir(baseDir, true)
        return { mode: 'recursive', watchers }
    } catch {
        const dirs = await listDirsRecursive(baseDir)
        for (const d of dirs) watchDir(d, false)
        return { mode: 'multi-dir', watchers }
    }
}

export async function startSourceWatcher({
    rootDir = Deno.cwd(),
    sourceDir = 'source',
    debounceMs = 200,
    classifyChange = defaultClassifyChange,
    buildTaskPlan,
    packageManager = 'npm',
    runTask = async (taskName) => runPackageScript(taskName, { cwd: rootDir, packageManager, prefix: taskName }),
    log = (...m) => console.log(...m),
    logFileEvents = true,
    shouldIgnoreEvent,
} = {}) {
    if (typeof buildTaskPlan !== 'function') {
        throw new Error('startSourceWatcher requires buildTaskPlan(changeTypes) => task[]')
    }

    const sourceAbs = path.resolve(rootDir, sourceDir)
    await Deno.stat(sourceAbs)

    let pendingTypes = new Set()
    const changedFiles = new Map([['scss', new Set()], ['ts', new Set()], ['astro', new Set()]])
    let debounceTimer = null
    let running = false
    let rerunRequested = false
    let currentRunningTypes = new Set()

    const scheduleRunFor = (type, filePath) => {
        pendingTypes.add(type)
        if (filePath) {
            const rel = path.relative(rootDir, filePath)
            if (changedFiles.get(type)) changedFiles.get(type).add(rel)
        }

        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(async () => {
            if (running) {
                rerunRequested = true
                return
            }
            const typesToProcess = new Set(pendingTypes)
            pendingTypes.clear()
            await runTasks(typesToProcess)
            if (rerunRequested) {
                rerunRequested = false
                const more = new Set(pendingTypes)
                pendingTypes.clear()
                if (more.size > 0) await runTasks(more)
            }
        }, debounceMs)
    }

    const runTasks = async (changeTypes) => {
        const taskPlan = buildTaskPlan(changeTypes)
        if (!taskPlan || taskPlan.length === 0) return

        running = true
        currentRunningTypes = new Set(changeTypes)

        const typeList = Array.from(changeTypes).join(', ')
        const details = Array.from(changeTypes).map((t) => {
            const s = changedFiles.get(t) ? Array.from(changedFiles.get(t)) : []
            return `${t}: ${s.slice(0, 5).join(', ')}${s.length > 5 ? ' …' : ''}`
        }).join(' | ')

        log(`\n[watch] Changes detected in: ${typeList}`)
        if (details.trim()) log(`[watch] Files: ${details}`)
        log(`[watch] Running: ${taskPlan.join(' -> ')}`)

        for (const task of taskPlan) {
            log(`[watch] npm run ${task}`)
            try {
                await runTask(task)
            } catch (error) {
                log(`[watch] Task failed: ${task} — ${error?.message ?? error}`)
            }
        }

        log('[watch] Done. Waiting for changes...')
        for (const s of changedFiles.values()) s.clear()
        currentRunningTypes.clear()
        running = false
    }

    const onEvent = (event, fullPath) => {
        const type = classifyChange(fullPath)
        if (!type) return

        if (typeof shouldIgnoreEvent === 'function') {
            if (shouldIgnoreEvent({ event, fullPath, type, running, currentRunningTypes })) return
        }

        if (logFileEvents) log(`[watch] ${event}: ${path.relative(rootDir, fullPath)}`)
        scheduleRunFor(type, fullPath)
    }

    const { mode, watchers } = await ensureDirWatchers(sourceAbs, onEvent)
    log(`[watch] Ready. Watching for changes in ${sourceDir} (${mode})...`)

    const close = () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        for (const w of watchers.values()) {
            try { w.close() } catch {}
        }
    }

    return { close }
}

