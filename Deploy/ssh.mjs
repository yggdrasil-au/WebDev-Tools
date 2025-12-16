import { Client } from 'ssh2';
import readline from 'node:readline';

/**
 * Run one or more commands over SSH, streaming output.
 * @param {{host:string, port?:number, username:string, privateKey:Buffer|string, passphrase?:string, password?:string}} conn
 * @param {string[]} commands
 * @param {{stopOnError?: boolean}} [options]
 */
export async function runCommandsOverSSH(conn, commands, options = {}) {
    const { stopOnError = true } = options;
    if (!Array.isArray(commands) || commands.length === 0) return;

    // Helper: detect passphrase-related errors
    const isPassphraseError = (err) => {
        const msg = String(err?.message || err || '').toLowerCase();
        return /passphrase|encrypted|decrypt|bad auth|pem_read_bio/.test(msg);
    };

    // Helper: prompt hidden input
    const promptHidden = (question = 'SSH key passphrase: ') => new Promise((resolve) => {
        if (!process.stdin.isTTY) resolve(''); // non-interactive; return empty
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl._writeToOutput = function _writeToOutput(stringToWrite) {
            // suppress echo while entering passphrase
            if (!this.stdoutMuted) this.output.write(stringToWrite);
        };
        rl.stdoutMuted = true;
        rl.question(question, (answer) => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
    });

    let cachedPassphrase = conn.passphrase; // re-use once prompted

    async function execOne(cmd) {
        const connectAndExec = (pass) => new Promise((resolve, reject) => {
            const c = new Client();
            c.on('ready', () => {
                c.exec(cmd, { pty: true }, (err, stream) => {
                    if (err) { c.end(); return reject(err); }
                    console.log(`[ssh] $ ${cmd}`);
                    stream.on('close', (code, signal) => {
                        c.end();
                        if (code === 0) resolve({ code, signal });
                        else reject(Object.assign(new Error(`Command failed (code=${code}): ${cmd}`), { code, signal }));
                    }).on('data', (data) => {
                        process.stdout.write(String(data));
                    }).stderr.on('data', (data) => {
                        process.stderr.write(String(data));
                    });
                });
            }).on('error', (err) => {
                c.end();
                reject(err);
            }).connect({
                host: conn.host,
                port: conn.port ?? 22,
                username: conn.username,
                privateKey: conn.privateKey,
                passphrase: pass,
                password: conn.password,
                tryKeyboard: false,
            });
        });

        try {
            return await connectAndExec(cachedPassphrase);
        } catch (err) {
            if (isPassphraseError(err) && process.stdin.isTTY) {
                // Prompt once and retry
                cachedPassphrase = await promptHidden('SSH key passphrase: ');
                return await connectAndExec(cachedPassphrase);
            }
            throw err;
        }
    }

    for (const cmd of commands) {
        try {
            await execOne(cmd);
        } catch (error) {
            console.error('[ssh] Error:', error.message || error);
            if (stopOnError) throw error;
        }
    }
}
