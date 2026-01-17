import { Client } from 'ssh2';
import readline from 'node:readline';
import process from 'node:process';
import { withRetry } from '../utils/retry.mjs';

/**
 * Run one or more commands over SSH.
 * @param {{host:string, port?:number, username:string, privateKey:Buffer|string, passphrase?:string, password?:string}} conn
 * @param {string[]} commands
 * @param {{stopOnError?: boolean, verbose?: boolean}} [options]
 */
export async function runCommandsOverSSH(conn, commands, options = {}) {
    const { stopOnError = true, verbose = true } = options;
    if (!Array.isArray(commands) || commands.length === 0) return;

    // Reuse passphrase wrapper
    let cachedPassphrase = conn.passphrase;

    for (const cmd of commands) {
        try {
            await withRetry(async () => {
                return execOne(cmd);
            }, { name: 'SSH Command' });
        } catch (error) {
            if (verbose) console.error('[ssh] Error:', error.message || error);
            if (stopOnError) throw error;
        }
    }

    async function execOne(cmd) {
        return connectAndExec(cmd, cachedPassphrase).catch(async (err) => {
            if (isPassphraseError(err) && process.stdin.isTTY) {
                cachedPassphrase = await promptHidden('SSH key passphrase: ');
                return connectAndExec(cmd, cachedPassphrase);
            }
            throw err;
        });
    }

    function connectAndExec(cmd, pass) {
        return new Promise((resolve, reject) => {
            const c = new Client();
            c.on('ready', () => {
                c.exec(cmd, { pty: true }, (err, stream) => {
                    if (err) { c.end(); return reject(err); }
                    if (verbose) console.log(`[ssh] $ ${cmd}`);
                    stream.on('close', (code, signal) => {
                        c.end();
                        if (code === 0) resolve({ code, signal });
                        else reject(new Error(`Command failed (code=${code}): ${cmd}`));
                    }).on('data', (data) => {
                        if (verbose) process.stdout.write(String(data));
                    }).stderr.on('data', (data) => {
                        if (verbose) process.stderr.write(String(data));
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
                keepaliveInterval: 10000,
                keepaliveCountMax: 10,
                readyTimeout: 60000
            });
        });
    }
}

function isPassphraseError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return /passphrase|encrypted|decrypt|bad auth|pem_read_bio/.test(msg);
}

function promptHidden(question = 'SSH key passphrase: ') {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY) return resolve('');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl._writeToOutput = function (s) { if (!this.muted) this.output.write(s); };
        rl.muted = true;
        rl.question(question, (ans) => {
            rl.close();
            process.stdout.write('\n');
            resolve(ans);
        });
    });
}
