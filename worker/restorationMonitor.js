// worker/restorationMonitor.js

class RestorationMonitor {
    constructor() {
        this.stats = {
            startTime: null,
            endTime: null,
            totalSessions: 0,
            restored: 0,
            failed: 0,
            skipped: 0,
            batches: 0,
            currentBatch: 0
        };
        this.listeners = [];
    }

    start(totalSessions) {
        this.stats.startTime = Date.now();
        this.stats.totalSessions = totalSessions;
        this.emit('start', this.stats);
        console.log(`📊 Restoration started: ${totalSessions} sessions to restore`);
    }

    updateBatch(batchNumber, batchSize) {
        this.stats.currentBatch = batchNumber;
        this.stats.batches++;
        this.emit('batch', { batchNumber, batchSize });
    }

    recordResult(result) {
        if (result === 'restored') this.stats.restored++;
        else if (result === 'failed') this.stats.failed++;
        else if (result === 'skipped') this.stats.skipped++;
        
        this.emit('progress', this.getProgress());
    }

    complete() {
        this.stats.endTime = Date.now();
        const duration = this.getDuration();
        console.log(`✅ Restoration complete in ${duration}s: ${this.stats.restored} restored, ${this.stats.failed} failed, ${this.stats.skipped} skipped`);
        this.emit('complete', this.stats);
    }

    getProgress() {
        const total = this.stats.restored + this.stats.failed + this.stats.skipped;
        const percentage = this.stats.totalSessions > 0 
            ? Math.round((total / this.stats.totalSessions) * 100) 
            : 0;
        
        return {
            total,
            percentage,
            restored: this.stats.restored,
            failed: this.stats.failed,
            skipped: this.stats.skipped,
            remaining: this.stats.totalSessions - total
        };
    }

    getDuration() {
        if (!this.stats.startTime) return 0;
        const end = this.stats.endTime || Date.now();
        return ((end - this.stats.startTime) / 1000).toFixed(2);
    }

    on(event, callback) {
        this.listeners.push({ event, callback });
    }

    emit(event, data) {
        this.listeners
            .filter(l => l.event === event)
            .forEach(l => l.callback(data));
    }

    getStats() {
        return {
            ...this.stats,
            duration: this.getDuration(),
            progress: this.getProgress()
        };
    }
}

module.exports = RestorationMonitor;
