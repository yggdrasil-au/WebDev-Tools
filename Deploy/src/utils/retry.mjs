const DEFAULT_RETRIES = 10;
const BASE_DELAY = 2000;

export async function withRetry(fn, options = {}) {
    const retries = options.retries ?? DEFAULT_RETRIES;
    const initialDelay = options.delay ?? BASE_DELAY;
    const name = options.name || 'Operation';
    
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (error) {
            attempt++;
            if (attempt > retries) throw error;
            
            // Loose match for connection issues
            const isConnectionError = /ECONNRESET|ETIMEDOUT|Connection lost|Socket closed|Broken pipe|Not connected|Failure/i.test(error.message);
            
            // Also retry on "Failure" which matches the generic "Failure" from sftp that we saw in logs: "Failed: put: Re-thrown: _put: write ECONNRESET"

            const delay = initialDelay * Math.pow(1.5, attempt - 1); // Exponential backoff
            console.warn(`[deploy] ${name} failed (Attempt ${attempt}/${retries}): ${error.message}. Retrying in ${(delay/1000).toFixed(1)}s...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}
