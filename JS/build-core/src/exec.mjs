import { spawn } from 'node:child_process'

const isWin = process.platform === 'win32'

function resolveBin(name) {
    if (!isWin) return name
    if (name === 'npm') return 'npm.cmd'
    if (name === 'pnpm') return 'pnpm.cmd'
    if (name === 'yarn') return 'yarn.cmd'
    return name
}

function prefixStream(stream, prefix, write) {
    if (!stream) return
    stream.setEncoding('utf8')
    stream.on('data', (data) => {
        const text = String(data).replace(/\r?\n/g, `\n${prefix}`)
        write(prefix + text)
    })
}

export function runCommand(command, {
    cwd = process.cwd(),
    env,
    shell = true,
    prefix,
    stdio = ['ignore', 'pipe', 'pipe'],
} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, {
            cwd,
            env: env ? { ...process.env, ...env } : process.env,
            shell,
            stdio,
        })

        const p = prefix ? `[${prefix}] ` : ''
        if (p) {
            prefixStream(child.stdout, p, (s) => process.stdout.write(s))
            prefixStream(child.stderr, p, (s) => process.stderr.write(s))
        }

        child.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`Command failed (code ${code}): ${command}`))
        })
        child.on('error', reject)
    })
}

export function runPackageScript(scriptName, {
    cwd = process.cwd(),
    packageManager = 'npm',
    env,
    prefix = scriptName,
} = {}) {
    const pm = resolveBin(packageManager)
    return runCommand(`${pm} run ${scriptName}`, { cwd, env, prefix })
}

