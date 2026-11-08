// 任务查询与领奖串行；热更新用 generation 丢弃旧响应，不重启心跳引擎。
import { normalizeTaskIds, resolveRewardTaskIds } from "./tasks.js";
import { failedRewardClaimResult } from "./rewards.js";

function concreteTasks(progresses) {
  return progresses.flatMap((task) => {
    const points = (task.checkPoints || []).filter((point) => String(point.sid || "").trim());
    return points.length
      ? points.map((point) => ({ ...point, taskId: String(point.sid).trim() }))
      : [task];
  });
}

/**
 * 选出本轮应尝试领取的任务：已完成 && 服务端未标记已领(status≠6) && 本地未领。
 */
export function selectClaimableTasks(progresses, alreadyClaimed) {
  const claimed = new Set(alreadyClaimed);
  const out = [];
  for (const t of concreteTasks(progresses)) {
    if (!t.taskId) continue;
    if (claimed.has(t.taskId)) continue;
    if (t.status === 6) continue; // 服务端已领
    if (t.isCompleted) {
      out.push(t.taskId);
      claimed.add(t.taskId);
    }
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
    autoClaimRewards = true,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.client = client;
    this.taskIds = [...new Set(normalizeTaskIds(taskIds))];
    this.csrf = csrf;
    this.intervalMs = intervalMs;
    this.reconnectDelayMs = reconnectDelayMs;
    this.log = log;
    this.onProgress = onProgress;
    this.onClaim = onClaim;
    this.autoClaimRewards = autoClaimRewards;
    this.sleep = sleep;

    this.stopped = true;
    this.snapshot = {}; // taskId → {curValue, limitValue, status}
    this.claimedIds = []; // 本地已成功领取 / 服务端已领 的 taskId
    this.lastError = null;
    this.timer = null;
    this.progresses = [];
    this.claimResults = [];
    this.lastUpdatedAt = null;
    this._generation = 0;
    this._inflight = null;
  }

  start() {
    this.stopped = false;
    this._schedule(0);
  }

  stop() {
    this.stopped = true;
    this._generation++;
    if (this.timer) clearTimeout(this.timer);
  }

  update({ taskIds = this.taskIds, intervalMs = this.intervalMs, autoClaimRewards = this.autoClaimRewards, csrf = this.csrf }) {
    const ids = [...new Set(normalizeTaskIds(taskIds))];
    const changedIds = ids.join(",") !== this.taskIds.join(",");
    if (!changedIds && intervalMs === this.intervalMs && autoClaimRewards === this.autoClaimRewards && csrf === this.csrf) return;
    this._generation++;
    this.taskIds = ids;
    this.intervalMs = intervalMs;
    this.autoClaimRewards = autoClaimRewards;
    this.csrf = csrf;
    if (changedIds) {
      this.progresses = [];
      this.snapshot = {};
      this.lastUpdatedAt = null;
      this.lastError = null;
    }
    this._schedule(0);
  }

  async refresh({ claimAll = false } = {}) {
    const generation = this._generation;
    while (this._inflight) {
      await this._inflight;
      if (generation !== this._generation) return;
    }
    if (generation !== this._generation) return;
    return this._runOnce(claimAll);
  }

  _schedule(delay) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._tick(), delay);
  }

  async _tick() {
    if (this.stopped) return;
    const delay = await this._runOnce();
    this._schedule(delay);
  }

  /** 一个监控周期：查询 → 比对 → 自动领取。返回下一次调度的延迟。 */
  _runOnce(claimAll = false) {
    if (this._inflight) return this._inflight;
    this._inflight = this._poll(claimAll).finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _poll(claimAll) {
    const generation = this._generation;
    if (this.taskIds.length === 0) return this.intervalMs;
    let progresses;
    try {
      progresses = await this.client.getTaskProgress(this.taskIds, {
        csrf: this.csrf,
      });
    } catch (err) {
      if (generation !== this._generation) return 0;
      this.lastError = err;
      this.log("warn", `任务监控查询失败: ${err.message}`);
      return this.reconnectDelayMs;
    }
    if (generation !== this._generation) return 0;
    this.lastError = null;
    this._applyProgress(progresses);
    if (this.autoClaimRewards || claimAll) await this._claimCompleted(progresses, generation, claimAll);
    return generation === this._generation ? this.intervalMs : 0;
  }

  _applyProgress(progresses) {
    this.progresses = progresses;
    this.lastUpdatedAt = Date.now();
    // 每日/周期任务回到未完成状态时，允许下一轮完成后再次领取。
    const claimed = new Set(this.claimedIds);
    for (const task of concreteTasks(progresses)) {
      if (task.status === 6) claimed.add(task.taskId);
      else if (!task.isCompleted) claimed.delete(task.taskId);
    }
    this.claimedIds = [...claimed];
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

  async _claimCompleted(progresses, generation, claimAll) {
    const ids = claimAll
      ? resolveRewardTaskIds(this.taskIds, progresses)
      : selectClaimableTasks(progresses, this.claimedIds);
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      if (generation !== this._generation) return;
      try {
        if (index > 0) await this.sleep(1200);
        if (generation !== this._generation) return;
        const info = await this.client.getMissionRewardInfo(id);
        if (generation !== this._generation) return;
        const result = await this.client.receiveMissionReward(info, {
          csrf: this.csrf,
        });
        if (generation !== this._generation) return;
        this._recordClaim(result);
        if (result.success || info.isClaimed) {
          if (!this.claimedIds.includes(id)) this.claimedIds.push(id);
          this.log("info", `已领取: ${info.taskName || id} (${result.message})`);
        }
      } catch (err) {
        if (generation !== this._generation) return;
        this._recordClaim(failedRewardClaimResult(id, err));
        this.log("warn", `领取 ${id} 失败: ${err.message}`);
      }
    }
  }

  _recordClaim(result) {
    this.claimResults = this.claimResults.filter((item) => item.taskId !== result.taskId);
    this.claimResults.push({ ...result, at: Date.now() });
    this.claimResults = this.claimResults.slice(-100);
    this.onClaim?.(result);
  }
}
