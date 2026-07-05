// TaskMonitor（M5 part 5）：周期轮询任务进度并自动领取已完成奖励。
//
// 与 Python x25kn_worker._task_monitor_loop 的差异：Python 仅记录进度 + 完成通知
// （领奖是 GUI 手动按钮）；扩展端按用户要求新增「完成即领」自动化——
// 当任务转为已完成且服务端未标记已领（status≠6）时，自动 getMissionRewardInfo +
// receiveMissionReward，成功后记入 claimedIds 避免重复领取。
//
// 调度：自调度 setTimeout（成功→intervalMs，查询失败→reconnectDelayMs），
// 与心跳引擎的 250ms 主循环解耦，慢查询/限频重试不阻塞心跳。

/**
 * 选出本轮应尝试领取的任务：已完成 && 服务端未标记已领(status≠6) && 本地未领。
 */
export function selectClaimableTasks(progresses, alreadyClaimed) {
  const claimed = new Set(alreadyClaimed);
  const out = [];
  for (const t of progresses) {
    if (claimed.has(t.taskId)) continue;
    if (t.status === 6) continue; // 服务端已领
    if (t.isCompleted) out.push(t.taskId);
  }
  return out;
}

/** 任务进度快照：taskId → {curValue, limitValue, status}，用于变更比对。 */
export function buildProgressSnapshot(progresses) {
  const snap = {};
  for (const t of progresses) {
    snap[t.taskId] = {
      curValue: t.curValue,
      limitValue: t.limitValue,
      status: t.status,
    };
  }
  return snap;
}

export class TaskMonitor {
  constructor({
    client,
    taskIds,
    csrf,
    intervalMs = 30000,
    reconnectDelayMs = 10000,
    log = () => {},
    onProgress = null,
    onClaim = null,
  }) {
    this.client = client;
    this.taskIds = taskIds;
    this.csrf = csrf;
    this.intervalMs = intervalMs;
    this.reconnectDelayMs = reconnectDelayMs;
    this.log = log;
    this.onProgress = onProgress;
    this.onClaim = onClaim;

    this.stopped = true;
    this.snapshot = {}; // taskId → {curValue, limitValue, status}
    this.claimedIds = []; // 本地已成功领取 / 服务端已领 的 taskId
    this.lastError = null;
    this.timer = null;
  }

  start() {
    this.stopped = false;
    this._schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  _schedule(delay) {
    if (this.stopped) return;
    this.timer = setTimeout(() => this._tick(), delay);
  }

  async _tick() {
    if (this.stopped) return;
    const delay = await this._runOnce();
    this._schedule(delay);
  }

  /** 一个监控周期：查询 → 比对 → 自动领取。返回下一次调度的延迟。 */
  async _runOnce() {
    let progresses;
    try {
      progresses = await this.client.getTaskProgress(this.taskIds, {
        csrf: this.csrf,
      });
    } catch (err) {
      this.lastError = err;
      this.log("warn", `任务监控查询失败: ${err.message}`);
      return this.reconnectDelayMs;
    }
    this.lastError = null;
    this._applyProgress(progresses);
    await this._claimCompleted(progresses);
    return this.intervalMs;
  }

  _applyProgress(progresses) {
    const snap = buildProgressSnapshot(progresses);
    for (const t of progresses) {
      const cur = snap[t.taskId];
      const prev = this.snapshot[t.taskId];
      const changed =
        !prev ||
        prev.curValue !== cur.curValue ||
        prev.limitValue !== cur.limitValue ||
        prev.status !== cur.status;
      if (changed) {
        this.log(
          "info",
          `任务进度: ${t.taskName || t.taskId} ${cur.curValue}/${cur.limitValue}`,
        );
        this.onProgress?.({
          taskId: t.taskId,
          taskName: t.taskName,
          ...cur,
        });
      }
    }
    this.snapshot = snap;
  }

  async _claimCompleted(progresses) {
    const ids = selectClaimableTasks(progresses, this.claimedIds);
    for (const id of ids) {
      try {
        const info = await this.client.getMissionRewardInfo(id);
        const result = await this.client.receiveMissionReward(info, {
          csrf: this.csrf,
        });
        this.onClaim?.(result);
        if (result.success) {
          this.claimedIds.push(id);
          this.log("info", `已领取: ${info.taskName || id} (${result.message})`);
        } else if (info.isClaimed) {
          // 服务端显示已领 → 本地标记，避免反复尝试
          this.claimedIds.push(id);
        }
      } catch (err) {
        this.log("warn", `领取 ${id} 失败: ${err.message}`);
      }
    }
  }
}
