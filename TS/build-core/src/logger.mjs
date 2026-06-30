export function defaultLogger(verbose) {
    return {
        log: (...m) => console.log('[assets]', ...m),
        warn: (...m) => console.warn('[assets]', ...m),
        vlog: (...m) => { if (verbose) console.log('[assets]', ...m) },
    }
}
