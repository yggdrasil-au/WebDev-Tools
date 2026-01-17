import process from 'node:process';

export function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const UNITS = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${UNITS[i]}`;
}

const CHECKPOINTS = [0, 20, 40, 60, 80, 100];

export class ProgressBar {
    constructor(label, total, options = {}) {
        this.label = label; // e.g. "[Batch 1/8]"
        this.total = total;
        this.current = 0;
        this.width = options.width || 20;
        this.renderType = options.renderType || 'bar'; // 'bar' | 'log'
        this.startTime = Date.now();
        this.lastLogPercent = -1;
    }

    update(current) {
        this.current = Math.min(current, this.total);
        if (this.renderType === 'bar') {
            this.renderBar();
        } else {
            this.renderLog();
        }
    }

    renderBar() {
        if (!process.stdout.isTTY) return;
        
        const pct = this.current / this.total;
        const percentStr = Math.round(pct * 100).toString().padStart(3);
        
        const filled = Math.round(this.width * pct);
        const empty = this.width - filled;
        const bar = '█'.repeat(filled) + '-'.repeat(empty);
        
        const sizeStr = `${formatSize(this.current)}/${formatSize(this.total)}`;
        
        // \r to overwrite line
        process.stdout.write(`\r${this.label} ${bar} ${percentStr}% | ${sizeStr}`);
        
        if (this.current >= this.total) {
            process.stdout.write('\n');
        }
    }

    renderLog() {
        const pct = (this.current / this.total) * 100;
        // Check if we crossed a checkpoint
        const checkpoint = CHECKPOINTS.find(cp => pct >= cp && this.lastLogPercent < cp);
        
        if (checkpoint !== undefined) {
             this.lastLogPercent = checkpoint;
             // Don't log 0% repeatedly if starting neither
             if (checkpoint === 0 && this.current > 0) return;
             
             console.log(`${this.label} Uploading... ${Math.round(pct)}% (${formatSize(this.current)})`);
        }
    }
    
    finish() {
        this.update(this.total);
    }
}
