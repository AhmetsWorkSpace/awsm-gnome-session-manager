export class TargetBarrier {
    constructor(records) {
        this.states = new Map(records.map(record => [record, 'PENDING']));
        this.closed = false;
        this.promise = new Promise(resolve => { this._resolve = resolve; });
        if (!this.states.size) this.close();
    }

    settle(record, status) {
        if (this.closed || this.states.get(record) !== 'PENDING' ||
            !['PLACED', 'FAILED', 'TIMED_OUT'].includes(status)) return false;
        this.states.set(record, status);
        if (![...this.states.values()].includes('PENDING')) this.close();
        return true;
    }

    close() {
        if (this.closed) return;
        for (const [record, status] of this.states)
            if (status === 'PENDING') this.states.set(record, 'TIMED_OUT');
        this.closed = true;
        this._resolve(this.states);
    }
}
