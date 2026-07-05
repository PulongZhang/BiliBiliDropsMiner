"""生成签名层/任务层真值参考向量。

用 stdlib importlib 按文件加载项目的纯模块（wbi / live_trace / live /
models / task_parsing / tasks / rewards），绕过 bilibili_drops_miner/__init__.py
的 GUI 依赖链，零第三方包、不动全局环境。输出 test/fixtures/vectors.json 供 JS 侧逐字节对拍。
"""
from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]  # extension/scripts -> repo root

# 需要加载的纯子模块（文件名 → 短键）
PURE_MODULES = {
    "live_trace": "live_trace",
    "wbi": "wbi",
    "live": "live",
    "models": "models",
    "task_parsing": "task_parsing",
    "tasks": "tasks",
    "rewards": "rewards",
}


def _load_pure_modules() -> dict:
    """预置空包对象到 sys.modules，跳过 __init__.py，再按文件导入纯子模块。"""
    for pkg in ("bilibili_drops_miner", "bilibili_drops_miner.client_parts"):
        mod = types.ModuleType(pkg)
        mod.__path__ = [str(REPO_ROOT / pkg.replace(".", "/"))]
        mod.__package__ = pkg
        sys.modules[pkg] = mod
    mods = {}
    for key, name in PURE_MODULES.items():
        mods[key] = importlib.import_module(f"bilibili_drops_miner.client_parts.{name}")
    return mods


def task_checkpoint_to_dict(cp) -> dict:
    return {
        "sid": cp.sid,
        "alias": cp.alias,
        "status": cp.status,
        "curValue": cp.cur_value,
        "limitValue": cp.limit_value,
        "awardName": cp.award_name,
        "awardCount": cp.award_count,
        "isCompleted": cp.is_completed,
    }


def task_progress_to_dict(t) -> dict:
    return {
        "taskId": t.task_id,
        "taskName": t.task_name,
        "status": t.status,
        "curValue": t.cur_value,
        "limitValue": t.limit_value,
        "checkPoints": [task_checkpoint_to_dict(c) for c in t.check_points],
        "taskType": t.task_type,
        "statisticType": t.statistic_type,
        "periodType": t.period_type,
        "awardType": t.award_type,
        "canEdit": t.can_edit,
        "isNeedPolling": t.is_need_polling,
        "isCompleted": t.is_completed,
    }


def mission_reward_info_to_dict(info) -> dict:
    return {
        "taskId": info.task_id,
        "taskName": info.task_name,
        "status": info.status,
        "message": info.message,
        "actId": info.act_id,
        "actName": info.act_name,
        "rewardName": info.reward_name,
        "isClaimable": info.is_claimable,
        "isClaimed": info.is_claimed,
    }


def claim_result_to_dict(r) -> dict:
    return {
        "taskId": r.task_id,
        "taskName": r.task_name,
        "rewardName": r.reward_name,
        "status": r.status,
        "message": r.message,
        "success": r.success,
        "skipped": r.skipped,
        "code": r.code,
    }


def build_vectors(mods: dict) -> dict:
    live_trace = mods["live_trace"]
    wbi = mods["wbi"]
    live = mods["live"]
    task_parsing = mods["task_parsing"]
    tasks = mods["tasks"]
    rewards = mods["rewards"]
    utils = importlib.import_module("bilibili_drops_miner.utils")
    vectors: dict = {}

    # --- compact_json：独立验证 JSON 紧凑序列化（字段顺序 / 中文 / 数字 / 转义）---
    # 注：签名 payload 实际只用「非整数索引」的字符串键，避免 JS 数组索引键重排问题。
    vectors["compact_json"] = [
        {"input": {"platform": "web", "parent_id": 2, "area_id": 21, "seq_id": 1,
                   "room_id": 999, "buvid": "AUTO123", "uuid": "u-x", "ets": 1000,
                   "time": 60, "ts": 1700000000000},
         "expected": live_trace.compact_json(
             {"platform": "web", "parent_id": 2, "area_id": 21, "seq_id": 1,
              "room_id": 999, "buvid": "AUTO123", "uuid": "u-x", "ets": 1000,
              "time": 60, "ts": 1700000000000})},
        {"input": {"b": 1, "a": "中文", "c": [1, 2, {"z": 0, "y": True}], "n": None},
         "expected": live_trace.compact_json(
             {"b": 1, "a": "中文", "c": [1, 2, {"z": 0, "y": True}], "n": None})},
        {"input": [2, 21, 0, 999],
         "expected": live_trace.compact_json([2, 21, 0, 999])},
        {"input": ["AUTO7654321098765432", "11111111-2222-3333-4444-555555555555"],
         "expected": live_trace.compact_json(
             ["AUTO7654321098765432", "11111111-2222-3333-4444-555555555555"])},
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
    for img, sub in [
        ("7cd93e4b9c0b7f6a8d2e5c1f4a6b8c0d", "e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6"),
        ("a1b2c3d4e5f60718293a4b5c6d7e8f90", "0f9e8d7c6b5a49382715061423222100"),
        ("deadbeefdeadbeefdeadbeefdeadbeef", "cafebabecafebabecafebabecafebabe"),
    ]:
        try:
            mk = wbi.get_mixin_key(img, sub)
            vectors["mixin_key"].append(
                {"img_key": img, "sub_key": sub, "expected": mk})
        except Exception as exc:
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
    models = mods["models"]
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

    # --- 直播间信息解析（对应 live.parse_live_room_info）---
    room_info_payloads = [
        {"code": 0, "data": {"room_info": {
            "room_id": 22743115, "uid": 65537,
            "parent_area_id": 2, "area_id": 21, "live_status": 1}}},
        {"code": 0, "data": {"room_info": {
            "room_id": 22743115, "uid": 65537,
            "parent_area_id": 2, "area_id": 21, "live_status": 0}}},
        {"code": 0, "data": {"room_info": {
            "room_id": 999, "uid": 888,
            "parent_area_id": 10, "area_id": 100, "live_status": 1,
            "extra_field": "ignored"}}},
    ]
    vectors["room_info"] = []
    for p in room_info_payloads:
        info = live.parse_live_room_info(p, room_id=p["data"]["room_info"]["room_id"])
        vectors["room_info"].append({
            "payload": p,
            "expected": {
                "roomId": info.room_id, "ruid": info.ruid,
                "parentAreaId": info.parent_area_id, "areaId": info.area_id,
                "liveStatus": info.live_status,
            },
        })

    # --- nav 响应里 WBI key 的解析（对应 wbi.parse_wbi_keys_from_nav）---
    nav_payloads = [
        {"code": 0, "data": {"wbi_img": {
            "img_url": "https://i0.hdslb.com/bfs/wbi/7cd93e4b9c0b7f6a8d2e5c1f4a6b8c0d.png",
            "sub_url": "https://i0.hdslb.com/bfs/wbi/e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6.png"}}},
        {"code": 0, "data": {"wbi_img": {
            "img_url": "https://i0.hdslb.com/bfs/wbi/abcdef.png",
            "sub_url": "https://i0.hdslb.com/bfs/wbi/0123456789.webp"}}},
    ]
    vectors["wbi_keys"] = []
    for p in nav_payloads:
        img_key_p, sub_key_p = wbi.parse_wbi_keys_from_nav(p)
        vectors["wbi_keys"].append({
            "payload": p,
            "expected": {"imgKey": img_key_p, "subKey": sub_key_p},
        })

    # =====================================================================
    # 任务层：task_parsing / tasks / rewards
    # =====================================================================

    # --- task_parsing：叶子解析器 ---
    vectors["task_parsing"] = {}

    vectors["task_parsing"]["coerce_task_number"] = [
        {"input": None, "expected": 0},
        {"input": "", "expected": 0},
        {"input": "   ", "expected": 0},
        {"input": "3", "expected": 3},
        {"input": 3, "expected": 3},
        {"input": "3.5", "expected": 3.5},
        {"input": 3.0, "expected": 3},
        {"input": 4.2, "expected": 4.2},
        {"input": "abc", "expected": 0},
        {"input": "  12  ", "expected": 12},
        {"input": "12.9abc", "expected": 0},
        {"input": True, "expected": 0},  # bool 非 int/float/str → 0
    ]
    for c in vectors["task_parsing"]["coerce_task_number"]:
        c["expected"] = task_parsing.coerce_task_number(c["input"])

    vectors["task_parsing"]["coerce_task_int"] = [
        {"input": None, "expected": 0},
        {"input": "3.9", "expected": 3},
        {"input": 5.0, "expected": 5},
        {"input": "x", "expected": 0},
        {"input": "7", "expected": 7},
    ]
    for c in vectors["task_parsing"]["coerce_task_int"]:
        c["expected"] = task_parsing.coerce_task_int(c["input"])

    vectors["task_parsing"]["first_present_value"] = [
        {"mapping": {"a": 1, "b": "", "c": None}, "keys": ["a", "b", "c"],
         "expected": 1},
        {"mapping": {"a": None, "b": "x", "c": 2}, "keys": ["a", "b", "c"],
         "expected": "x"},
        {"mapping": {"a": 0}, "keys": ["a", "b"], "expected": 0},  # 0 是 present
        {"mapping": {}, "keys": ["a", "b"], "expected": None},
        {"mapping": "not a dict", "keys": ["a"], "expected": None},
        {"mapping": {"a": ""}, "keys": ["a"], "expected": None},  # 空串视作 absent
    ]
    for c in vectors["task_parsing"]["first_present_value"]:
        c["expected"] = task_parsing.first_present_value(
            c["mapping"], tuple(c["keys"]))

    # extract_task_indicator_values：watch_time 优先，否则取 limit 最大者
    vectors["task_parsing"]["extract_task_indicator_values"] = [
        # 空输入 → (0,0)
        {"indicators": None, "expected": [0, 0]},
        {"indicators": [], "expected": [0, 0]},
        # 单个 watch_time
        {"indicators": [{"type": "watch_time", "cur_value": 30, "limit": 60}],
         "expected": [30, 60]},
        # watch_time vs 非观看（limit 更大也不抢）
        {"indicators": [
            {"type": "other", "cur_value": 100, "limit": 999},
            {"type": "live_watch", "cur_value": 30, "limit": 60}],
         "expected": [30, 60]},
        # 多个 watch_time：limit 最大者胜（>= 比较，后写覆盖）
        {"indicators": [
            {"indicator_type": "watch", "cur": 10, "total": 30},
            {"indicator_id": "duration", "current": 40, "max": 60}],
         "expected": [40, 60]},
        # 无 watch_type：取 limit 最大
        {"indicators": [
            {"type": "sign", "cur_value": 1, "limit": 1},
            {"type": "share", "cur_value": 2, "limit": 5}],
         "expected": [2, 5]},
        # dict 形（单个）
        {"indicators": {"type": "watch_time", "cur_value": 5, "limit": 10},
         "expected": [5, 10]},
    ]
    for c in vectors["task_parsing"]["extract_task_indicator_values"]:
        cur, limit = task_parsing.extract_task_indicator_values(c["indicators"])
        c["expected"] = [cur, limit]

    # extract_checkpoint_progress_values：优先 list/indicators/indicator 子键
    vectors["task_parsing"]["extract_checkpoint_progress_values"] = [
        # 直接 cur/limit
        {"checkpoint": {"cur_value": 3, "limit": 9}, "expected": [3, 9]},
        # 走 list → indicators
        {"checkpoint": {"list": [
            {"type": "watch_time", "cur_value": 20, "limit": 40}]},
         "expected": [20, 40]},
        # indicators 子键
        {"checkpoint": {"indicators":
            {"type": "duration", "cur": 7, "total": 14}},
         "expected": [7, 14]},
        # 空对象
        {"checkpoint": {}, "expected": [0, 0]},
    ]
    for c in vectors["task_parsing"]["extract_checkpoint_progress_values"]:
        cur, limit = task_parsing.extract_checkpoint_progress_values(c["checkpoint"])
        c["expected"] = [cur, limit]

    # normalize_checkpoint_candidates：list / dict-with-nested-key / bare dict
    vectors["task_parsing"]["normalize_checkpoint_candidates"] = [
        {"values": [{"a": 1}, {"b": 2}], "expected": [{"a": 1}, {"b": 2}]},
        {"values": [{"check_points": [{"x": 1}]}],
         "expected": [{"x": 1}]},
        {"values": {"items": [{"y": 1}]}, "expected": [{"y": 1}]},
        {"values": {"bare": 1}, "expected": [{"bare": 1}]},  # 裸 dict 包一层
        {"values": None, "expected": []},
        {"values": "str", "expected": []},
    ]
    for c in vectors["task_parsing"]["normalize_checkpoint_candidates"]:
        c["expected"] = task_parsing.normalize_checkpoint_candidates(c["values"])

    # --- tasks.parse_task_progress_payload：totalv2 响应 → TaskProgress[] ---
    totalv2_payloads = [
        # data 是 dict，list 在 data.list；含 indicators（watch_time）+ check_points
        {"payload": {"code": 0, "data": {"list": [
            {"task_id": "t1", "task_name": "观看 60 分钟",
             "task_status": 0,
             "indicators": [
                 {"type": "watch_time", "cur_value": 30, "limit": 60}],
             "check_points": [
                 {"sid": "cp1", "alias": "30min", "status": 3,
                  "list": [{"type": "watch_time", "cur_value": 30, "limit": 30}],
                  "award_name": "辣条", "count": 1},
                 {"sid": "cp2", "alias": "60min", "status": 0,
                  "cur_value": 30, "limit": 60,
                  "award_name": "电池", "count": 2}],
             "task_type": 1, "is_need_polling": 1}]}}, "note": "watch_time + cps"},
        # cur>=limit → is_completed true
        {"payload": {"code": 0, "data": [
            {"task_id": "t2", "task_name": "已完成任务",
             "task_status": 0,
             "indicators": [{"type": "watch_time", "cur_value": 60, "limit": 60}]}]},
         "note": "completed by cur>=limit"},
        # 无 indicators，回退 limit/cur_value + 终态 status 6 → is_completed
        {"payload": {"code": 0, "data": {"list": [
            {"id": "t3", "name": "已领取", "task_status": 6, "limit": 100, "cur_value": 50}]}},
         "note": "status 6 → claimed/completed"},
        # accumulative_check_points 兜底
        {"payload": {"code": 0, "data": {"list": [
            {"task_id": "t4", "task_name": "累积",
             "accumulative_check_points": [
                 {"sid": "a1", "cur_value": 5, "limit": 10, "status": 0}]}]}},
         "note": "accumulative fallback"},
        # code != 0 → parse 抛错（在 tasks 测试里验）
        {"payload": {"code": -101, "message": "未登录"}, "note": "error code"},
    ]
    vectors["tasks"] = []
    for case in totalv2_payloads:
        p = case["payload"]
        if p.get("code") != 0:
            vectors["tasks"].append({"payload": p, "error": True,
                                     "note": case["note"]})
            continue
        progresses = tasks.parse_task_progress_payload(p)
        vectors["tasks"].append({
            "payload": p,
            "expected": [task_progress_to_dict(t) for t in progresses],
            "note": case["note"],
        })

    # --- rewards：mission/info 解析 + 领奖结果构造 ---
    vectors["rewards"] = {}

    # parse_mission_reward_info
    mission_info_payloads = [
        {"payload": {"code": 0, "data": {
            "task_id": "t1", "task_name": "观看", "status": 0, "message": "",
            "act_id": "act1", "act_name": "活动",
            "reward_info": {"award_name": "辣条"}}}, "normalized_id": "t1",
         "note": "claimable status 0"},
        {"payload": {"code": 0, "data": {
            "task_id": "t1", "task_name": "观看", "status": 6, "message": "已领取",
            "act_id": "act1", "act_name": "活动", "reward_info": {}}},
         "normalized_id": "t1", "note": "claimed status 6"},
        {"payload": {"code": 0, "data": {
            "status": 2, "message": "不可领"}},  # 缺字段，回退 normalized_id
         "normalized_id": "t9", "note": "missing fields fallback"},
        {"payload": {"code": -1, "message": "失败"}, "normalized_id": "t1",
         "note": "error code"},
    ]
    vectors["rewards"]["parse_mission_reward_info"] = []
    for case in mission_info_payloads:
        p = case["payload"]
        if p.get("code") != 0:
            vectors["rewards"]["parse_mission_reward_info"].append(
                {"payload": p, "normalized_id": case["normalized_id"],
                 "error": True, "note": case["note"]})
            continue
        info = rewards.parse_mission_reward_info(
            p, normalized_id=case["normalized_id"])
        vectors["rewards"]["parse_mission_reward_info"].append({
            "payload": p, "normalized_id": case["normalized_id"],
            "expected": mission_reward_info_to_dict(info),
            "note": case["note"],
        })

    # skipped_reward_claim_result：claimed → skipped success；not claimable → skipped fail；claimable → null
    vectors["rewards"]["skipped_reward_claim_result"] = []
    for status, note in [(6, "claimed"), (0, "claimable→null"), (2, "not claimable")]:
        info = rewards.MissionRewardInfo(
            task_id="t1", task_name="n", status=status, message="",
            act_id="a", act_name="an", reward_name="r")
        skipped = rewards.skipped_reward_claim_result(info)
        vectors["rewards"]["skipped_reward_claim_result"].append({
            "status": status, "note": note,
            "expected": claim_result_to_dict(skipped) if skipped is not None else None,
        })

    # reward_claim_result_from_payload：code 0 success / code!=0 fail
    base_info = rewards.MissionRewardInfo(
        task_id="t1", task_name="n", status=0, message="", act_id="a",
        act_name="an", reward_name="r")
    vectors["rewards"]["reward_claim_result_from_payload"] = [
        {"info": mission_reward_info_to_dict(base_info),
         "payload": {"code": 0, "message": ""},
         "expected": claim_result_to_dict(
             rewards.reward_claim_result_from_payload(base_info, {"code": 0, "message": ""})),
         "note": "success, empty msg → 领取成功"},
        {"info": mission_reward_info_to_dict(base_info),
         "payload": {"code": 0, "message": "0"},
         "expected": claim_result_to_dict(
             rewards.reward_claim_result_from_payload(base_info, {"code": 0, "message": "0"})),
         "note": "success, msg '0' → 领取成功"},
        {"info": mission_reward_info_to_dict(base_info),
         "payload": {"code": -702, "message": "频率限制"},
         "expected": claim_result_to_dict(rewards.reward_claim_result_from_payload(
             base_info, {"code": -702, "message": "频率限制"})),
         "note": "fail"},
    ]

    # build_reward_receive_body
    vectors["rewards"]["build_reward_receive_body"] = {
        "info": mission_reward_info_to_dict(base_info),
        "csrf": "bilijct123",
        "expected": rewards.build_reward_receive_body(base_info, csrf="bilijct123"),
    }

    # failed_reward_claim_result
    exc = RuntimeError("network down")
    vectors["rewards"]["failed_reward_claim_result"] = {
        "task_id": "tErr",
        "expected": claim_result_to_dict(
            rewards.failed_reward_claim_result("tErr", exc)),
    }

    # --- __initialState 任务 ID 提取（对应 utils._extract_task_ids_from_task_group
    #     遍历 EraTasklistPc）。扩展用 chrome.scripting world:MAIN 直接读页面对象。 ---
    def _all_task_ids(state):
        ids = []
        seen = set()
        groups = state.get("EraTasklistPc")
        if not isinstance(groups, list):
            return []
        for g in groups:
            if not isinstance(g, dict):
                continue
            ids.extend(utils._extract_task_ids_from_task_group(g, seen))
        return ids

    state_samples = [
        {"name": "empty", "state": {}},
        {"name": "single group", "state": {"EraTasklistPc": [
            {"tasklist": [{"taskId": "111"}, {"taskId": "222"}]}]}},
        {"name": "multi groups dedup", "state": {"EraTasklistPc": [
            {"tasklist": [{"taskId": "a"}, {"taskId": "b"}]},
            {"tasklist": [{"taskId": "b"}, {"taskId": "c"}]},  # b 重复
            {"tasklist": [{"taskId": ""}, {"name": "x"}]},    # 空 / 无 taskId
        ]}},
        {"name": "tasklist missing/non-array", "state": {"EraTasklistPc": [
            {"other": 1},
            {"tasklist": "notarray"},
            {"tasklist": [{"taskId": "z"}]},
        ]}},
        {"name": "EraTasklistPc not array", "state": {"EraTasklistPc": {"x": 1}}},
        {"name": "taskId numeric", "state": {"EraTasklistPc": [
            {"tasklist": [{"taskId": 12345}, {"taskId": 67890}]}]}},
    ]
    vectors["initial_state"] = []
    for s in state_samples:
        vectors["initial_state"].append({
            "name": s["name"],
            "state": s["state"],
            "expected": _all_task_ids(s["state"]),
        })

    return vectors


def main() -> None:
    mods = _load_pure_modules()
    vectors = build_vectors(mods)
    out_dir = Path(__file__).resolve().parent.parent / "test" / "fixtures"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "vectors.json"
    out_path.write_text(json.dumps(vectors, ensure_ascii=False, indent=2),
                        encoding="utf-8")
    counts = {k: (len(v) if isinstance(v, (list, str)) else
                  len(v) if hasattr(v, "keys") else v)
              for k, v in vectors.items()}
    print(f"vectors -> {out_path}")
    print(f"counts: {counts}")


if __name__ == "__main__":
    main()
