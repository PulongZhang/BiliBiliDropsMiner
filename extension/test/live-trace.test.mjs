import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compactJson,
  buildX25knSignature,
  buildEnterParams,
  parseEnterPayload,
  buildHeartbeatParams,
  applyHeartbeatPayload,
} from "../lib/live-trace.js";
import { loadVectors } from "./helpers.mjs";

const vectors = loadVectors();

test("compactJson matches Python json.dumps(separators=(',',':'))", () => {
  for (const v of vectors.compact_json) {
    assert.equal(compactJson(v.input), v.expected, JSON.stringify(v.input));
  }
});

test("buildX25knSignature matches Python across all rule shapes", async () => {
  for (const v of vectors.x25kn_signature) {
    const p = v.params;
    const sig = await buildX25knSignature({
      liveBuvid: p.live_buvid,
      liveUuid: p.live_uuid,
      parentAreaId: p.parent_area_id,
      areaId: p.area_id,
      seqId: p.seq_id,
      roomId: p.room_id,
      ets: p.ets,
      duration: p.duration,
      tsMs: p.ts_ms,
      secretKey: p.secret_key,
      secretRule: p.secret_rule,
    });
    assert.equal(
      sig,
      v.expected,
      `secret_rule=${JSON.stringify(p.secret_rule)}`,
    );
  }
});

// ---- live-trace 进出 / 心跳 参数与解析 ----

const lt = vectors.live_trace;
const room = {
  roomId: lt.room.room_id,
  ruid: lt.room.ruid,
  parentAreaId: lt.room.parent_area_id,
  areaId: lt.room.area_id,
  liveStatus: lt.room.live_status,
};

test("buildEnterParams matches Python (id/device compactJson + 字段顺序)", () => {
  const params = buildEnterParams(room, {
    liveBuvid: lt.enter_common.live_buvid,
    liveUuid: lt.enter_common.live_uuid,
    userAgent: lt.enter_common.user_agent,
    csrf: lt.enter_common.csrf,
    tsMs: lt.enter_common.ts_ms,
  });
  assert.deepEqual(params, lt.enter_params);
});

test("parseEnterPayload extracts session (secret/rule/ets/interval)", () => {
  const session = parseEnterPayload(lt.enter_payload, room);
  assert.deepEqual(session, lt.session_after_enter);
});

test("parseEnterPayload throws when secret_key/secret_rule missing", () => {
  assert.throws(() =>
    parseEnterPayload(
      { code: 0, data: { timestamp: 1, heartbeat_interval: 60 } },
      room,
    ),
  );
});

test("parseEnterPayload throws when ets <= 0", () => {
  assert.throws(() =>
    parseEnterPayload(
      {
        code: 0,
        data: { timestamp: 0, heartbeat_interval: 60, secret_key: "k", secret_rule: [2] },
      },
      room,
    ),
  );
});

test("buildHeartbeatParams matches Python (s/id/ets/benchmark/trackid …)", () => {
  const session = parseEnterPayload(lt.enter_payload, room);
  const hb = buildHeartbeatParams(session, {
    liveBuvid: lt.enter_common.live_buvid,
    liveUuid: lt.enter_common.live_uuid,
    userAgent: lt.enter_common.user_agent,
    csrf: lt.enter_common.csrf,
    signature: lt.hb_params.s,
    nextSeq: lt.hb_signature_input.next_seq,
    duration: lt.hb_signature_input.duration,
    tsMs: lt.hb_signature_input.ts_ms,
  });
  assert.deepEqual(hb, lt.hb_params);
});

test("applyHeartbeatPayload updates seq/ets/secret (incl. rotate)", () => {
  const session = parseEnterPayload(lt.enter_payload, room);
  applyHeartbeatPayload(session, lt.hb_payload, 1);
  assert.deepEqual(
    {
      seqId: session.seqId,
      ets: session.ets,
      heartbeatInterval: session.heartbeatInterval,
      secretKey: session.secretKey,
      secretRule: session.secretRule,
    },
    lt.session_after_hb,
  );
});
