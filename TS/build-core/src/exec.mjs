const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

const isWin = Deno.build.os === 'windows'

function resolveBin(name) {
    if (!isWin) return name
    if (name === 'npm') return 'npm.cmd'
    if (name === 'pnpm') return 'pnpm.cmd'
    if (name === 'yarn') return 'yarn.cmd'
    return name
}

function prefixStream(stream, prefix, write) {
    if (!stream) return

    const reader = stream.getReader()
    return (async () => {
        let buffered = ''

        try {
            while (true) {
                const { value, done } = await reader.read()
                if (done) break

                buffered += textDecoder.decode(value, { stream: true })
                const lines = buffered.split(/\r?\n/)
                buffered = lines.pop() ?? ''

                for (const line of lines) {
                    await write(textEncoder.encode(`${prefix}${line}\n`))
                }
            }

            buffered += textDecoder.decode()
            if (buffered.length > 0) {
                await write(textEncoder.encode(`${prefix}${buffered}`))
            }
        } finally {
            reader.releaseLock()
        }
    })()
}

export function runCommand(command, {
    cwd = Deno.cwd(),
    env,
    shell = true,
    prefix,
    stdio = ['ignore', 'pipe', 'pipe'],
} = {}) {
    return new Promise((resolve, reject) => {
        const p = prefix ? `[${prefix}] ` : ''

        try {
            const programSpec = shell
                ? (isWin
                    ? { program: 'cmd', args: ['/d', '/s', '/c', command] }
                    : { program: 'sh', args: ['-c', command] })
                : { program: command, args: [] }

            const child = new Deno.Command(programSpec.program, {
                args: programSpec.args,
                cwd,
                env: env ? { ...Deno.env.toObject(), ...env } : Deno.env.toObject(),
                stdin: stdio[0] === 'inherit' ? 'inherit' : 'null',
                stdout: p || stdio[1] === 'pipe' ? 'piped' : 'inherit',
                stderr: p || stdio[2] === 'pipe' ? 'piped' : 'inherit',
            }).spawn()

            const statusPromise = child.status
            const streamPromise = p
                ? Promise.all([
                    prefixStream(child.stdout, p, (bytes) => Deno.stdout.write(bytes)),
                    prefixStream(child.stderr, p, (bytes) => Deno.stderr.write(bytes)),
                ])
                : Promise.resolve()

            Promise.all([statusPromise, streamPromise])
                .then(([status]) => {
                    if (status.success) resolve()
                    else reject(new Error(`Command failed (code ${status.code}): ${command}`))
                })
                .catch(reject)
        } catch (error) {
            reject(error)
        }
    })
}

export function runPackageScript(scriptName, {
    cwd = Deno.cwd(),
    packageManager = 'npm',
    env,
    prefix = scriptName,
} = {}) {
    const pm = resolveBin(packageManager)
    return runCommand(`${pm} run ${scriptName}`, { cwd, env, prefix })
}

