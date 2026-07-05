// SessionManager（M3）：用单一 setInterval 周期驱动 N 个 BiliSession。
//
// 为什么不用 N 个独立定时器：100 会话 × 独立 timer 会产生不可控的并发与抖动；
// 集中调度可在 250ms 的 tick 内顺序遍历，由每个会话的 nextDueAt/_busy 自行决定是否动作。
//
// 错峰（stagger）：start 时按 index*staggerMs 推后 nextDueAt，让 100 路首次 enter
// 在 0..99s 内均匀铺开（默认 1s 间隔），避免瞬时洪泛；之后心跳因 60s 周期自然保持错峰。

export class SessionManager {
  constructor({ sessions, now = Date.now, staggerMs = 1000 }) {
    this.sessions = sessions; // BiliSession[]
    this.now = now;
    this.staggerMs = staggerMs;
    this.started = false;
    this._busy = false;
  }

  start() {
    const base = this.now();
    for (let i = 0; i < this.sessions.length; i++) {
      const s = this.sessions[i];
      s.start();
      s.nextDueAt = base + i * this.staggerMs;
    }
    this.started = true;
  }

  /** 顺序驱动所有会话的一次 tick；重入保护避免 250ms tick 在慢请求上叠加。 */
  async tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      for (const s of this.sessions) {
        await s.tick();
      }
    } finally {
      this._busy = false;
    }
  }

  stop() {
    for (const s of this.sessions) s.stop();
    this.started = false;
  }

  /** 聚合状态：running/waiting/idle 计数 + 累计心跳 + 最近错误清单。 */
  status() {
    let running = 0;
    let waiting = 0;
    let idle = 0;
    let heartbeats = 0;
    const errors = [];
    for (const s of this.sessions) {
      if (s.stopped) continue;
      if (s.state === "running") running++;
      else if (s.state === "waiting") waiting++;
      else idle++;
      heartbeats += s.heartbeatCount || 0;
      if (s.lastError) {
        errors.push({ id: s.id, error: String(s.lastError.message || s.lastError) });
      }
    }
    return { total: this.sessions.length, running, waiting, idle, heartbeats, errors };
  }
}
