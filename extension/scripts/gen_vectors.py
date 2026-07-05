"""生成签名层真值参考向量。

用 stdlib importlib 按文件加载项目的纯模块（wbi / live_trace），
绕过 bilibili_drops_miner/__init__.py 的 GUI 依赖链，
零第三方包、不动全局环境。输出 tests/fixtures/vectors.json 供 JS 侧逐字节对拍。
"""
from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]  # extension/scripts -> repo root


def _load_pure_modules():
    """预置空包对象到 sys.modules，跳过 __init__.py，再按文件导入纯子模块。"""
    for pkg in ("bilibili_drops_miner", "bilibili_drops_miner.client_parts"):
        mod = types.ModuleType(pkg)
        mod.__path__ = [str(REPO_ROOT / pkg.replace(".", "/"))]
        mod.__package__ = pkg
        sys.modules[pkg] = mod
    live_trace = importlib.import_module("bilibili_drops_miner.client_parts.live_trace")
    wbi = importlib.import_module("bilibili_drops_miner.client_parts.wbi")
    return live_trace, wbi


def build_vectors(live_trace, wbi) -> dict:
    vectors: dict = {}

    # --- compact_json：独立验证 JSON 紧凑序列化（字段顺序 / 中文 / 数字 / 转义）---
    # 注：签名 payload 实际只用「非整数索引」的字符串键，避免 JS 数组索引键重排问题。
    vectors["compact_json"] = [
        # build_x25kn_signature 的 payload 形状
        {"input": {"platform": "web", "parent_id": 2, "area_id": 21, "seq_id": 1,
                   "room_id": 999, "buvid": "AUTO123", "uuid": "u-x", "ets": 1000,
                   "time": 60, "ts": 1700000000000},
         "expected": live_trace.compact_json(
             {"platform": "web", "parent_id": 2, "area_id": 21, "seq_id": 1,
              "room_id": 999, "buvid": "AUTO123", "uuid": "u-x", "ets": 1000,
              "time": 60, "ts": 1700000000000})},
        # 中文 / 布尔 / null / 嵌套（测插入顺序与 unicode）
        {"input": {"b": 1, "a": "中文", "c": [1, 2, {"z": 0, "y": True}], "n": None},
         "expected": live_trace.compact_json(
             {"b": 1, "a": "中文", "c": [1, 2, {"z": 0, "y": True}], "n": None})},
        # enter/heartbeat 的 id / device 实际形状（平铺数组）
        {"input": [2, 21, 0, 999],
         "expected": live_trace.compact_json([2, 21, 0, 999])},
        {"input": ["AUTO7654321098765432", "11111111-2222-3333-4444-555555555555"],
         "expected": live_trace.compact_json(
             ["AUTO7654321098765432", "11111111-2222-3333-4444-555555555555"])},
        # enter 参数对象：含预序列化的 id/device 字符串（测引号转义）
        {"input": {"id": "[2,21,0,999]", "device": '["buvid","uuid"]',
                   "ruid": 123456, "ts": 1700000000000, "is_patch": 0,
                   "heart_beat": "[]", "ua": "Mozilla/5.0 (Win64) Chrome/122",
                   "web_location": "444.8", "csrf": "abc123"},
         "expected": live_trace.compact_json(
             {"id": "[2,21,0,999]", "device": '["buvid","uuid"]',
              "ruid": 123456, "ts": 1700000000000, "is_patch": 0,
              "heart_beat": "[]", "ua": "Mozilla/5.0 (Win64) Chrome/122",
              "web_location": "444.8", "csrf": "abc123"})},
    ]

    # --- hmac_by_rule：6 种摘要 + 多轮嵌套，逐字节对拍 ---
    hmac_data = "the quick brown fox 算签名".encode("utf-8")
    hmac_key = "Y2MaPx7e9*Wq4L1d"
    vectors["hmac"] = []
    for rule in (0, 1, 2, 3, 4, 5):
        digest = live_trace.hmac_by_rule(hmac_data, hmac_key, rule).hex()
        vectors["hmac"].append(
            {"data_hex": hmac_data.hex(), "key": hmac_key, "rule": rule,
             "expected_hex": digest})
    for multi in ([2, 0], [0, 1, 2], [5, 5, 5], [3, 4]):
        current = hmac_data
        for r in multi:
            current = live_trace.hmac_by_rule(current, hmac_key, r)
        vectors["hmac"].append(
            {"data_hex": hmac_data.hex(), "key": hmac_key, "rule": list(multi),
             "expected_hex": current.hex(), "multiround": True})

    # --- build_x25kn_signature：完整签名管线（compact JSON + HMAC 迭代）---
    base_sig_kwargs = dict(
        live_buvid="AUTO7654321098765432",
        live_uuid="11111111-2222-3333-4444-555555555555",
        parent_area_id=2, area_id=21, seq_id=7, room_id=22743115,
        ets=1719740000, duration=60, ts_ms=1719740060000,
        secret_key="0xd4M3Ks9_pL2nQvR8wYb1",
    )
    vectors["x25kn_signature"] = []
    for rule in ([2], [0], [1], [3], [4], [5], [2, 0], [0, 1, 2]):
        kwargs = dict(base_sig_kwargs, secret_rule=list(rule))
        sig = live_trace.build_x25kn_signature(**kwargs)
        vectors["x25kn_signature"].append(
            {"params": kwargs, "expected": sig})

    # --- get_mixin_key：WBI mixin key 推导（含 ENC_TAB 打乱）---
    vectors["mixin_key"] = []
    # ENC_TAB 最大索引 63，img+sub 拼接需 >= 64 字符，故两 key 各 32 字符
    for img, sub in [
        ("7cd93e4b9c0b7f6a8d2e5c1f4a6b8c0d", "e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6"),
        ("a1b2c3d4e5f60718293a4b5c6d7e8f90", "0f9e8d7c6b5a49382715061423222100"),
        ("deadbeefdeadbeefdeadbeefdeadbeef", "cafebabecafebabecafebabecafebabe"),
    ]:
        try:
            mk = wbi.get_mixin_key(img, sub)
            vectors["mixin_key"].append(
                {"img_key": img, "sub_key": sub, "expected": mk})
        except Exception as exc:  # 越界等：记录为 error 用例
            vectors["mixin_key"].append(
                {"img_key": img, "sub_key": sub, "error": str(exc)})

    # --- encode_query + sign_wbi_params：WBI 签名（含特殊字符过滤/转义）---
    img_key = "7cd93e4b9c0b7f6a8d2e5c1f4a6b8c0d"
    sub_key = "e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6"
    vectors["wbi"] = []
    for params, wts in [
        ({"foo": "bar", "baz": 42}, 1719740000),
        ({"name": "张三", "q": "a b/c!d(e)f*g'h", "n": 0}, 1700000000),
        ({"web_location": "1430654", "w_rid": "", "wts": 0}, 1),
    ]:
        signed = wbi.sign_wbi_params(params, img_key=img_key, sub_key=sub_key,
                                     timestamp=wts)
        sorted_with_wts = dict(sorted({**params, "wts": wts}.items(),
                                      key=lambda kv: kv[0]))
        vectors["wbi"].append({
            "params": params, "img_key": img_key, "sub_key": sub_key, "wts": wts,
            "expected_w_rid": signed["w_rid"],
            "expected_query": wbi.encode_query(sorted_with_wts),
            "expected_mixin_key": wbi.get_mixin_key(img_key, sub_key),
        })

    # --- live-trace 进出/心跳 参数构造与 payload 解析 ---
    models = importlib.import_module("bilibili_drops_miner.client_parts.models")
    LiveRoomInfo = models.LiveRoomInfo
    room = LiveRoomInfo(room_id=22743115, ruid=65537, parent_area_id=2,
                        area_id=21, live_status=1)
    enter_common = dict(live_buvid="AUTO7654321098765432",
                        live_uuid="11111111-2222-3333-4444-555555555555",
                        user_agent="Mozilla/5.0 (Win64) Chrome/122",
                        csrf="a1b2c3d4e5f6", ts_ms=1719740060000)
    enter_params = live_trace.build_live_trace_enter_params(
        room, **enter_common)

    enter_payload = {
        "code": 0,
        "data": {
            "timestamp": 1719740000,
            "heartbeat_interval": 60,
            "secret_key": "0xd4M3Ks9_pL2nQvR8wYb1",
            "secret_rule": [0, 1, 2],
        },
    }
    session = live_trace.live_trace_session_from_enter_payload(
        enter_payload, room=room)

    session_for_hb = live_trace.live_trace_session_from_enter_payload(
        enter_payload, room=room)
    hb_params = live_trace.build_live_trace_heartbeat_params(
        session_for_hb, **{k: v for k, v in enter_common.items() if k != "ts_ms"},
        signature="sigplaceholder", next_seq=1, duration=60,
        ts_ms=1719740120000)

    hb_payload = {
        "code": 0,
        "data": {
            "timestamp": 1719740060,
            "heartbeat_interval": 60,
            "secret_key": "nextKey9876",
            "secret_rule": [2],
        },
    }
    session_after = live_trace.live_trace_session_from_enter_payload(
        {**enter_payload}, room=room)
    live_trace.apply_live_trace_heartbeat_payload(
        session_after, hb_payload, next_seq=1)

    vectors["live_trace"] = {
        "room": {"room_id": room.room_id, "ruid": room.ruid,
                 "parent_area_id": room.parent_area_id, "area_id": room.area_id,
                 "live_status": room.live_status},
        "enter_common": enter_common,
        "enter_params": enter_params,
        "enter_payload": enter_payload,
        "session_after_enter": {
            "roomId": session.room_id, "ruid": session.ruid,
            "parentAreaId": session.parent_area_id, "areaId": session.area_id,
            "seqId": session.seq_id, "ets": session.ets,
            "heartbeatInterval": session.heartbeat_interval,
            "secretKey": session.secret_key,
            "secretRule": list(session.secret_rule),
        },
        "hb_signature_input": {
            "next_seq": 1, "duration": 60, "ts_ms": 1719740120000,
        },
        "hb_params": hb_params,
        "hb_payload": hb_payload,
        "session_after_hb": {
            "seqId": session_after.seq_id, "ets": session_after.ets,
            "heartbeatInterval": session_after.heartbeat_interval,
            "secretKey": session_after.secret_key,
            "secretRule": list(session_after.secret_rule),
        },
    }

    return vectors


def main() -> None:
    live_trace, wbi = _load_pure_modules()
    vectors = build_vectors(live_trace, wbi)
    out_dir = Path(__file__).resolve().parent.parent / "test" / "fixtures"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "vectors.json"
    out_path.write_text(json.dumps(vectors, ensure_ascii=False, indent=2),
                        encoding="utf-8")
    counts = {k: len(v) for k, v in vectors.items()}
    print(f"vectors -> {out_path}")
    print(f"counts: {counts}")


if __name__ == "__main__":
    main()
