import { test } from "node:test";
import assert from "node:assert/strict";

import { compactJson, buildX25knSignature } from "../lib/live-trace.js";
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
