import path from 'node:path'
import { promises as fs } from 'node:fs'
import {
    copyPath,
    emptyDir,
    ensureDir,
    listFilesRelative,
    listTreeRelative,
    pathExists,
    removePath,
    toPosixPath,
} from './fs.mjs'

function defaultLogger(verbose) {
    return {
        log: (...m) => console.log('[assets]', ...m),
        warn: (...m) => console.warn('[assets]', ...m),
        vlog: (...m) => { if (verbose) console.log('[assets]', ...m) },
    }
}

export function createAssetManager({
    rootDir = process.cwd(),
    srcWebRel = 'source/web',
    srcAssetsRel = 'source/assets',
    distRootRel = 'www/dist',
    websiteRel = 'www/website',
    capSyncRel = 'www/capacitorsync',
    icons = null,
    extraPruneTopLevel = [
        'robots.txt',
        'ads.txt',
        'humans.txt',
        'security.txt',
        '.htaccess',
        '.htpasswd',
        'web.config',
        'CNAME',
    ],
    verbose = false,
    dryRun = false,
} = {}) {
    const { log, warn, vlog } = defaultLogger(verbose)

    const abs = {
        root: rootDir,
        srcWeb: path.resolve(rootDir, srcWebRel),
        srcAssets: path.resolve(rootDir, srcAssetsRel),
        distRoot: path.resolve(rootDir, distRootRel),
        distAssets: path.resolve(rootDir, distRootRel, 'assets'),
        website: path.resolve(rootDir, websiteRel),
        capSync: path.resolve(rootDir, capSyncRel),
    }

    async function copyIfExists(from, to, label) {
        if (!(await pathExists(from))) {
            vlog(`${label}: skip (not found)`, from)
            return false
        }
        if (dryRun) log('[dry-run]', `${label}: copy`, from, '->', to)
        else await copyPath(from, to, { overwrite: true, dereference: true })
        return true
    }

    async function prepareDistRoots() {
        if (dryRun) {
            log('[dry-run] ensure', abs.distRoot)
            return
        }
        await ensureDir(abs.distRoot)
    }

    async function prepare() {
        await prepareDistRoots()
        const ok = await copyIfExists(abs.srcAssets, abs.distAssets, 'static')
        if (ok) log('Copied source/assets -> www/dist/assets')

        if (icons?.fromRel && icons?.toRel) {
            const from = path.resolve(rootDir, icons.fromRel)
            const to = path.resolve(rootDir, distRootRel, icons.toRel)
            await prepareDistRoots()
            await copyIfExists(from, to, 'icons')
        }
    }

    async function stageWebOnlyTopLevelIntoDist() {
        if (!(await pathExists(abs.srcWeb))) {
            vlog(`\`${srcWebRel}\` not found; nothing to stage`)
            return { hasContent: false, copied: [] }
        }

        const topLevel = await fs.readdir(abs.srcWeb, { withFileTypes: true })
        const copied = []
        for (const entry of topLevel) {
            if (entry.name === '.gitkeep') continue
            if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) continue
            const from = path.join(abs.srcWeb, entry.name)
            const to = path.join(abs.distRoot, entry.name)
            copied.push(entry.name)
            if (dryRun) log('[dry-run] copy', from, '->', to)
            else await copyPath(from, to, { overwrite: true, dereference: true })
        }
        log(`Staged web-only assets into dist (${copied.length} items)`)
        return { hasContent: copied.length > 0, copied }
    }

    async function removeSitemapsFromCapSync() {
        if (!(await pathExists(abs.capSync))) return 0
        const entries = await fs.readdir(abs.capSync, { withFileTypes: true })
        let removed = 0
        for (const entry of entries) {
            if (!entry.isFile()) continue
            if (!entry.name.startsWith('sitemap') || !entry.name.endsWith('.xml')) continue
            const target = path.join(abs.capSync, entry.name)
            if (dryRun) log('[dry-run] remove', target)
            else await removePath(target)
            removed++
        }
        return removed
    }

    async function pruneFromCapSyncBySrcWeb() {
        const relPaths = await listTreeRelative(abs.srcWeb, { includeDot: true, includeDirs: true, includeFiles: true })
        let removed = 0
        for (const rel of relPaths) {
            if (!rel || rel === '.') continue
            const target = path.join(abs.capSync, rel)
            if (await pathExists(target)) {
                if (dryRun) log('[dry-run] remove', target)
                else await removePath(target)
                removed++
            }
        }
        return removed
    }

    async function pruneExtraFromCapSync() {
        let removed = 0
        for (const rel of extraPruneTopLevel) {
            const target = path.join(abs.capSync, rel)
            if (await pathExists(target)) {
                if (dryRun) log('[dry-run] remove', target)
                else await removePath(target)
                removed++
            }
        }
        removed += await removeSitemapsFromCapSync()

        for (const relDir of ['.well-known', 'experimental']) {
            const target = path.join(abs.capSync, relDir)
            if (await pathExists(target)) {
                if (dryRun) log('[dry-run] remove', target)
                else await removePath(target)
                removed++
            }
        }
        return removed
    }

    async function cleanupProductionFiles(dir) {
        const relFiles = await listFilesRelative(dir, { includeDot: true })
        let removed = 0

        for (const rel of relFiles) {
            const posixRel = toPosixPath(rel)
            const absPath = path.join(dir, rel)

            if (posixRel.endsWith('.map')) {
                if (dryRun) log('[dry-run] remove map', absPath)
                else await removePath(absPath)
                removed++
                continue
            }

            if (posixRel.endsWith('.js') && !posixRel.endsWith('.min.js')) {
                if (dryRun) log('[dry-run] remove non-min js', absPath)
                else await removePath(absPath)
                removed++
                continue
            }

            if (posixRel.startsWith('css/') && posixRel.endsWith('.css')) {
                if (posixRel === 'css/main.min.css') continue
                if (posixRel.startsWith('css/assets/')) continue
                if (dryRun) log('[dry-run] remove css', absPath)
                else await removePath(absPath)
                removed++
            }
        }

        return removed
    }

    async function split({
        cleanupWebsite = false,
        cleanupCapSync = true,
    } = {}) {
        if (!(await pathExists(abs.distRoot))) {
            throw new Error(`Missing build output directory: ${abs.distRoot}`)
        }

        if (dryRun) log('[dry-run] create fresh', abs.website, 'and', abs.capSync)
        else {
            await emptyDir(abs.website)
            await emptyDir(abs.capSync)
        }

        if (dryRun) {
            log('[dry-run] copy dist -> website')
            log('[dry-run] copy dist -> capacitorsync')
        } else {
            await copyPath(abs.distRoot, abs.website, { overwrite: true, dereference: true })
            await copyPath(abs.distRoot, abs.capSync, { overwrite: true, dereference: true })
        }

        let removedCount = 0
        removedCount += await pruneFromCapSyncBySrcWeb()
        removedCount += await pruneExtraFromCapSync()

        let capCleanup = 0
        let webCleanup = 0
        if (cleanupCapSync) capCleanup = await cleanupProductionFiles(abs.capSync)
        if (cleanupWebsite) webCleanup = await cleanupProductionFiles(abs.website)

        if (cleanupWebsite) {
            log(`Split complete. Pruned ${removedCount} items from capacitorsync, ${webCleanup} from website`)
        } else if (cleanupCapSync) {
            log(`Split complete. Pruned ${removedCount} items from capacitorsync (+${capCleanup} production cleanup)`)
        } else {
            log(`Split complete. Pruned ${removedCount} items from capacitorsync (cleanup skipped)`)
        }

        return { removedCount, capCleanup, webCleanup }
    }

    return {
        paths: abs,
        prepare,
        stageWebOnlyTopLevelIntoDist,
        split,
        cleanupProductionFiles,
        log,
        warn,
    }
}

