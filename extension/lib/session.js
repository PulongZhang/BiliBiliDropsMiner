// 单会话状态机（对应 x25kn_worker._trace_heartbeat_loop 的状态流转）。
// 暴露 tick(now) 供 M3 的 SessionManager 调度器周期性调用；
// 每次 tick 若到点则按当前状态决定 enter 还是 heartbeat，失败转 waiting 等 reconnect 后重进。

const STATE = Object.freeze({
  IDLE: "idle",
  ENTERING: "running-entering", // 内部用；外部观察为 running
  RUNNING: "running",
  WAITING: "waiting",
});

export class BiliSession {
  constructor({
    id,
    client,
    room,
    liveBuvid,
    liveUuid,
    userAgent,
    csrf,
    now = Date.now,
    reconnectDelayMs = 8000,
    log,
  }) {
    this.id = id;
    this.client = client; // { roomEntryAction, liveTraceEnter, liveTraceHeartbeat }
    this.room = room; // 初始仅 { roomId }；enter 后 session 含完整 room 信息
    this.liveBuvid = liveBuvid;
    this.liveUuid = liveUuid;
    this.userAgent = userAgent;
    this.csrf = csrf;
    this.now = now;
    this.reconnectDelayMs = reconnectDelayMs;
    this.log = log || (() => {});

    this.state = "idle";
    this.session = null; // LiveTraceSession
    this.nextDueAt = Infinity;
    this.heartbeatCount = 0;
    this.lastError = null;
    this.stopped = false;
    this._busy = false;
  }

  start() {
    if (this.stopped) return;
    this.nextDueAt = this.now();
  }

  stop() {
    this.stopped = true;
  }

  async tick() {
    if (this.stopped) return;
    if (this.now() < this.nextDueAt) return;
    if (this._busy) return; // 重入保护：单会话动作串行
    this._busy = true;
    try {
      if (this.session == null) {
        await this._doEnter();
      } else {
        await this._doHeartbeat();
      }
    } finally {
      this._busy = false;
    }
  }

  _identity() {
    return {
      liveBuvid: this.liveBuvid,
      liveUuid: this.liveUuid,
      userAgent: this.userAgent,
      csrf: this.csrf,
    };
  }

  async _doEnter() {
    try {
      const id = this._identity();
      await this.client.roomEntryAction(this.room.roomId, id);
      if (this.stopped) return;
      const session = await this.client.liveTraceEnter(this.room.roomId, id);
      if (this.stopped) return;
      this.session = session;
      this.state = "running";
      this.nextDueAt = this.now() + this.session.heartbeatInterval * 1000;
      this.lastError = null;
      this.log("info", `session ${this.id} entered room=${this.room.roomId}`);
    } catch (err) {
      this._onFail(err, "enter");
    }
  }

  async _doHeartbeat() {
    try {
      const session = await this.client.liveTraceHeartbeat(this.session, this._identity());
      if (this.stopped) return;
      this.session = session;
      this.heartbeatCount += 1;
      this.state = "running";
      this.nextDueAt = this.now() + this.session.heartbeatInterval * 1000;
      this.lastError = null;
    } catch (err) {
      this._onFail(err, "heartbeat");
    }
  }

  _onFail(err, action) {
    if (this.stopped) return;
    this.lastError = err;
    this.session = null;
    this.state = "waiting";
    this.nextDueAt = this.now() + this.reconnectDelayMs;
    this.log("warn", `session ${this.id} ${action} 失败: ${err.message}`);
  }
}
