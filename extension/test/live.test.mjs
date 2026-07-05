import { test } from "node:test";
import assert from "node:assert/strict";

import { parseLiveRoomInfo } from "../lib/live.js";
import { loadVectors } from "./helpers.mjs";

const vectors = loadVectors();

test("parseLiveRoomInfo matches Python for live / not-live / extra-fields", () => {
  for (const v of vectors.room_info) {
    const roomId = v.payload.data.room_info.room_id;
    const info = parseLiveRoomInfo(v.payload, roomId);
    assert.deepEqual(info, v.expected);
  }
});

test("parseLiveRoomInfo throws on non-zero code", () => {
  assert.throws(() =>
    parseLiveRoomInfo({ code: -400, message: "bad room" }, 123),
  );
});

test("parseLiveRoomInfo throws on missing partition info", () => {
  assert.throws(() =>
    parseLiveRoomInfo(
      { code: 0, data: { room_info: { room_id: 1, uid: 2, parent_area_id: 0, area_id: 0 } } },
      1,
    ),
  );
});
