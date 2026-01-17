import SftpClient from 'ssh2-sftp-client';
import { withRetry } from '../utils/retry.mjs';

export class RobustSftpClient {
    constructor() {
        this.client = new SftpClient();
        this.config = null;
        this.listeners = [];
    }

    async connect(config) {
        this.config = config;
        const enhancedConfig = {
            ...config,
            readyTimeout: 60000,
            keepaliveInterval: 10000, // 10s ping
            keepaliveCountMax: 10
        };
        
        await withRetry(async () => {
             try {
                // If the client is already connected, this might throw or do nothing
                await this.client.connect(enhancedConfig);
             } catch(e) {
                 if (e.message && e.message.includes('Already connected')) return;
                 // Re-instantiate on failure to ensure clean state
                 try { await this.client.end(); } catch {}
                 this.client = new SftpClient();
                 this._reattachListeners(); // Re-attach listeners to new client
                 throw e;
             }
        }, { name: 'SSH Connect' });
    }

    async end() {
        try {
            await this.client.end();
            this.config = null;
        } catch {}
    }

    async _exec(method, ...args) {
        return withRetry(async () => {
             try {
                 return await this.client[method](...args);
             } catch (err) {
                 const msg = err.message || '';
                 // Detect connection loss
                 if (/ECONNRESET|ETIMEDOUT|No connection|Socket closed|Broken pipe|Not connected|Failure/i.test(msg)) {
                     console.warn(`[deploy] Connection lost during ${method}. Reconnecting...`);
                     
                     // Force close and create new
                     try { await this.client.end(); } catch {}
                     this.client = new SftpClient(); 
                     this._reattachListeners();

                     // Reconnect
                     if (this.config) {
                        try {
                            const enhancedConfig = {
                                ...this.config,
                                readyTimeout: 60000,
                                keepaliveInterval: 10000,
                                keepaliveCountMax: 10
                            };
                            await this.client.connect(enhancedConfig);
                        } catch (connErr) {
                            console.warn('[deploy] Reconnection failed:', connErr.message);
                            // We throw the ORIGINAL error (or connErr) so main retry loop waits and tries this lambda again
                            // Throwing connErr might be better so retry logic sees "connection failed"
                            throw connErr;
                        }
                     }
                     
                     // Throw original error to trigger outer retry loop (which will call _exec lambda again)
                     throw err; 
                 }
                 throw err;
             }
        }, { name: `SFTP ${method}` });
    }
    
    on(event, listener) {
        this.listeners.push({ event, listener });
        this.client.on(event, listener);
    }
    
    removeListener(event, listener) {
        this.listeners = this.listeners.filter(l => l.event !== event || l.listener !== listener);
        this.client.removeListener(event, listener);
    }
    
    _reattachListeners() {
        // Clear listeners on new client first to avoid duplicates if any
        this.client.removeAllListeners();
        for (const { event, listener } of this.listeners) {
            this.client.on(event, listener);
        }
    }

    async exists(path) { return this._exec('exists', path); }
    async mkdir(path, recursive) { return this._exec('mkdir', path, recursive); }
    async rmdir(path, recursive) { return this._exec('rmdir', path, recursive); }
    async rename(src, dst) { return this._exec('rename', src, dst); }
    async list(path) { return this._exec('list', path); }
    async put(src, dst, options) { return this._exec('put', src, dst, options); }
    async uploadDir(src, dst) { return this._exec('uploadDir', src, dst); }
}
