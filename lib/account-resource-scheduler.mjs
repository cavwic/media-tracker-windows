// Local account-stage leases share the service's browser/maintenance lock set.
// A blocked account reserves only its own session, never another platform.
export class AccountResourceScheduler {
  constructor(activeKeys, { onChange = () => {} } = {}) {
    this.activeKeys = activeKeys;
    this.onChange = onChange;
    this.pending = [];
    this.active = new Set();
    this.closed = false;
  }

  acquire({ keys, labels = {}, owner, signal, onWaiting = () => {} }) {
    if (this.closed || signal?.aborted) return Promise.reject(new DOMException("同步已取消。", "AbortError"));
    return new Promise((resolve, reject) => {
      const task = { keys: [...new Set(keys)], labels, owner, signal, onWaiting, resolve, reject };
      task.abort = () => {
        const index = this.pending.indexOf(task);
        if (index < 0) return; // Active work owns disposal and releases its lease.
        this.pending.splice(index, 1);
        signal?.removeEventListener("abort", task.abort);
        reject(new DOMException("同步已取消。", "AbortError"));
        this.drain();
      };
      signal?.addEventListener("abort", task.abort, { once: true });
      this.pending.push(task);
      this.drain();
    });
  }

  drain() {
    if (this.closed) return;
    const reserved = new Map();
    for (const task of [...this.pending]) {
      const waiting = [];
      for (const key of task.keys) {
        if (!this.activeKeys.has(key) && !reserved.has(key)) continue;
        const activeOwner = [...this.active].find(candidate => candidate.keys.includes(key));
        const earlierOwner = reserved.get(key);
        const platform = task.labels[key] || "关联账号";
        const personName = activeOwner?.owner?.personName || earlierOwner?.owner?.personName || "";
        const reason = this.activeKeys.has(key) ? "busy" : "earlier-job";
        if (!waiting.some(item => item.platform === platform && item.personName === personName && item.reason === reason)) {
          waiting.push({ platform, ...(personName ? { personName } : {}), reason });
        }
      }
      if (waiting.length) {
        task.onWaiting(waiting);
        for (const key of task.keys) if (!reserved.has(key)) reserved.set(key, task);
        continue;
      }
      this.pending.splice(this.pending.indexOf(task), 1);
      task.signal?.removeEventListener("abort", task.abort);
      if (task.signal?.aborted) {
        task.reject(new DOMException("同步已取消。", "AbortError"));
        continue;
      }
      for (const key of task.keys) this.activeKeys.add(key);
      this.active.add(task);
      task.onWaiting([]);
      let released = false;
      task.resolve(() => {
        if (released) return;
        released = true;
        this.active.delete(task);
        for (const key of task.keys) this.activeKeys.delete(key);
        this.drain();
        this.onChange();
      });
    }
    this.onChange();
  }

  close() {
    this.closed = true;
    for (const task of this.pending.splice(0)) {
      task.signal?.removeEventListener("abort", task.abort);
      task.reject(new DOMException("同步已取消。", "AbortError"));
    }
    // Active keys are never force-released: adapters must finish/dispose first.
    this.onChange();
  }
}
