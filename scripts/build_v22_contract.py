#!/usr/bin/env python3
"""BP LAB v2.2 合约构建器。

输入（只读）：
  data/opgg_mcp.json            OP.GG 官方 MCP 快照（英雄-分路统计 / counter / synergy / patch trend）
  data/champions.json           旧网页快照（含 5 段最终比赛时长条件胜率、图标、positions）
  data/champion_traits_v2.json  人工审核的战术标签（可缺失，缺失时全部记为未审核）
  data/bp_rules.json            BP LAB 自有规则（维度、缺口规则、体系相克、候选分层）

输出：
  data/bp_contract.json / .js  前端使用的合并合约（带来源、口径确认状态、样本量说明）
  data/bp_lab_v22.sqlite        最小数据合同：source_snapshot / champion_traits / bp_analysis_cache

原则（对应 v2.2 §4 §5）：
  * 不创建 matches / participants / rank_snapshots 等逐局大表。
  * confirmed_cohort 只写响应能确认的内容，MCP 未返回地区/段位就留空。
  * 没有样本量就写 null，不从胜率或排名反推。
  * 时长桶的 0% / 100% / |rate-average| > 5 一律打 LOW_SAMPLE_SUSPECT，不参与任何排序。
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

TZ = timezone(timedelta(hours=8))
NOW = datetime.now(TZ).replace(microsecond=0)

CONTRACT_VERSION = "v2.2"
RULE_VERSION = "v2.2.0"
DIMENSIONS = [
    "engage", "peel", "frontline", "poke", "waveclear",
    "dps", "burst", "splitpush", "dive", "scaling",
]
LEVELS = ["WEAK", "MEDIUM", "STRONG", "UNREVIEWED"]
LEGACY_OUTLIER_PP = 5.0


def load(name, optional=False):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        if optional:
            print(f"WARN: 可选输入缺失 {path}，对应标签将全部记为未审核", file=sys.stderr)
            return None
        raise SystemExit(f"缺少必需输入文件: {path}")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def sha256_json(obj) -> str:
    raw = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def iso(dt: datetime) -> str:
    return dt.isoformat()


def flag_bucket(bucket: dict) -> dict:
    """标注时长桶的可信度。

    v2.2 §5.6：没有样本量就不生成置信区间。
    v2.2 §1.2/§8：0%、100%、±5pp 这类异常值不能被当成"极强/极弱"结论。
    """
    rate = bucket.get("rate")
    avg = bucket.get("average")
    out = {
        "key": bucket.get("key"),
        "label": bucket.get("label"),
        "rate": rate,
        "average": avg,
        "rank": bucket.get("rank"),
        "sampleN": None,
        "flag": "OK",
        "note": "",
    }
    try:
        rate_f = float(rate)
        avg_f = float(avg if avg is not None else 50.0)
    except (TypeError, ValueError):
        out["flag"] = "MISSING"
        out["note"] = "该时长桶没有返回数值"
        return out
    if rate_f <= 0.0 or rate_f >= 100.0:
        out["flag"] = "LOW_SAMPLE_SUSPECT"
        out["note"] = "0%/100% 极可能是样本量极小造成，不作为强度结论"
    elif abs(rate_f - avg_f) > LEGACY_OUTLIER_PP:
        out["flag"] = "LOW_SAMPLE_SUSPECT"
        out["note"] = f"与该英雄自身均值相差 {rate_f - avg_f:+.1f} pp，超过 ±{LEGACY_OUTLIER_PP:g}pp 阈值"
    return out


def build_sources(mcp: dict, legacy: dict) -> dict:
    mcp_meta = mcp.get("meta") or {}
    legacy_meta = legacy.get("meta") or {}
    return {
        "OPGG_MCP": {
            "label": "OP.GG 官方 MCP",
            "endpoint": "https://mcp-api.op.gg/mcp",
            "toolName": "lol_get_champion_analysis",
            "requestedCohort": {"tier": mcp_meta.get("tier"), "region": "未指定"},
            "confirmedCohort": None,
            "cohortNote": mcp_meta.get(
                "region", "MCP 响应未包含可确认的地区/段位口径"
            ),
            "retrievedAt": mcp_meta.get("fetchedAt"),
            "fieldSemanticsStatus": "UNVERIFIED",
            "sampleN": None,
            "sampleNNote": "play 字段是分路统计的对局场次，定义未在响应中说明",
            "usageReviewStatus": "PENDING",
            "asOf": iso(NOW),
        },
        "OPGG_WEB_LEGACY": {
            "label": "OP.GG 网页快照（历史时长曲线）",
            "toolName": "op.gg champion trend（网页）",
            "requestedCohort": {
                "region": legacy_meta.get("region"),
                "tier": legacy_meta.get("tier"),
                "patch": legacy_meta.get("patch"),
            },
            "confirmedCohort": {
                "region": legacy_meta.get("region"),
                "tier": legacy_meta.get("tier"),
                "patch": legacy_meta.get("patch"),
            },
            "cohortNote": "网页快照自述口径，未在本次复核中重新验证",
            "retrievedAt": legacy_meta.get("fetchedAt"),
            "fieldSemanticsStatus": "LEGACY_AGGREGATE",
            "sampleN": None,
            "sampleNNote": "每个时长桶的样本量未获取",
            "usageReviewStatus": "PENDING",
            "asOf": iso(NOW),
        },
    }


def traits_source():
    return "champion_traits_v3.json" if os.path.exists(os.path.join(DATA, "champion_traits_v3.json")) else "champion_traits_v2.json"


def normalize_traits(traits_doc, champion_keys):
    """把 champion_traits_v2.json 压成 {champ: {default:{dim:entry}, roles:{role:{dim:entry}}}}。"""
    out = {}
    champs = (traits_doc or {}).get("champions") or {}
    for key in champion_keys:
        entry = champs.get(key) or {}
        default = entry.get("default") or {}
        roles = entry.get("roles") or {}
        cleaned = {
            "name": entry.get("name"),
            "default": {d: sanitize_trait(default.get(d)) for d in DIMENSIONS},
            "roles": {},
        }
        for role, overrides in roles.items():
            cleaned["roles"][role] = {
                d: sanitize_trait(overrides.get(d)) for d in DIMENSIONS if d in overrides
            }
        out[key] = cleaned
    return out


def sanitize_trait(entry):
    """未知 → UNREVIEWED。禁止把缺失标签当成中性值。"""
    if not isinstance(entry, dict):
        return {"level": "UNREVIEWED", "reviewStatus": "REVIEW_REQUIRED", "evidence": []}
    level = entry.get("level")
    if level not in LEVELS:
        level = "UNREVIEWED"
    status = entry.get("reviewStatus") or ("REVIEWED" if level != "UNREVIEWED" else "REVIEW_REQUIRED")
    evidence = entry.get("evidence")
    if not isinstance(evidence, list):
        evidence = []
    evidence = [str(x)[:120] for x in evidence][:3]
    source = entry.get("source") if isinstance(entry.get("source"), str) else None
    out = {"level": level, "reviewStatus": status, "evidence": evidence}
    if source:
        out["source"] = source
    return out


def merge_champions(mcp: dict, legacy: dict, traits: dict) -> dict:
    mcp_champs = mcp.get("champions") or {}
    legacy_by_key = {}
    for champ in (legacy.get("champions") or []):
        legacy_by_key[champ.get("key")] = champ

    keys = sorted(set(mcp_champs) | set(legacy_by_key))
    out = {}
    for key in keys:
        legacy_champ = legacy_by_key.get(key) or {}
        mcp_roles = mcp_champs.get(key) or {}

        positions = legacy_champ.get("positions") or sorted(mcp_roles)
        ddragon = legacy_champ.get("ddragonId") or ""
        name = legacy_champ.get("name") or key
        title = legacy_champ.get("title") or ""
        icon = legacy_champ.get("icon") or (f"assets/champions/{ddragon}.png" if ddragon else "")
        tags = legacy_champ.get("tags") or []

        roles = {}
        for role in positions:
            source_entry = mcp_roles.get(role) or {}
            summary = source_entry.get("summary") or {}
            curve = ((legacy_champ.get("curves") or {}).get(role)) or None
            role_out = {
                "meta": {
                    "winRate": summary.get("winRate"),
                    "pickRate": summary.get("pickRate"),
                    "banRate": summary.get("banRate"),
                    "kda": summary.get("kda"),
                    "tier": summary.get("tier"),
                    "rank": summary.get("rank"),
                    "play": summary.get("play"),
                    "source": "OPGG_MCP" if summary else None,
                    "cohortConfirmed": False if summary else None,
                    "retrievedAt": (mcp.get("meta") or {}).get("fetchedAt"),
                },
                "damageType": source_entry.get("damageType"),
                "patchTrends": source_entry.get("trends") or [],
                "trend": None,
                "counters": source_entry.get("counters") or [],
                "synergies": source_entry.get("synergies") or [],
            }
            if curve:
                role_out["trend"] = {
                    "source": "OPGG_WEB_LEGACY",
                    "semantics": "FINAL_GAME_DURATION_CONDITIONAL_WIN_RATE",
                    "confirmedCohort": {
                        "region": (legacy.get("meta") or {}).get("region"),
                        "tier": (legacy.get("meta") or {}).get("tier"),
                        "patch": (legacy.get("meta") or {}).get("patch"),
                    },
                    "sampleN": None,
                    "buckets": [flag_bucket(b) for b in curve],
                }
            roles[role] = role_out

        out[key] = {
            "key": key,
            "ddragonId": ddragon,
            "name": name,
            "title": title,
            "icon": icon,
            "tags": tags,
            "positions": positions,
            "roles": roles,
            "traits": traits.get(key) or {
                "name": None,
                "default": {d: sanitize_trait(None) for d in DIMENSIONS},
                "roles": {},
            },
        }
    return out


def build_contract(mcp, legacy, traits_doc, rules) -> dict:
    traits = normalize_traits(traits_doc, sorted({*(mcp.get("champions") or {}), *[
        c.get("key") for c in (legacy.get("champions") or [])
    ]}))
    champions = merge_champions(mcp, legacy, traits)

    reviewed = 0
    unreviewed = 0
    for champ in champions.values():
        for entry in champ["traits"]["default"].values():
            if entry["reviewStatus"] == "REVIEWED":
                reviewed += 1
            elif entry["level"] == "UNREVIEWED":
                unreviewed += 1

    return {
        "meta": {
            "schema": "bp_contract",
            "contract": CONTRACT_VERSION,
            "ruleVersion": RULE_VERSION,
            "generatedAt": iso(NOW),
            "patch": {
                "label": (legacy.get("meta") or {}).get("patch") or "16.22",
                "ddragon": (legacy.get("meta") or {}).get("version"),
                "officialPatch": "26.22",
                "officialPatchNote": "官方补丁号与 Data Dragon 版本号不同，两者不可混用",
            },
            "championCount": len(champions),
            "roleEntryCount": sum(len(c["roles"]) for c in champions.values()),
            "trendEntryCount": sum(
                1 for c in champions.values() for r in c["roles"].values() if r.get("trend")
            ),
            "traitLabelCount": reviewed + unreviewed,
            "traitReviewedCount": reviewed,
            "traitUnreviewedCount": unreviewed,
            "note": "合约由 scripts/build_v22_contract.py 生成，不要手改。",
        },
        "sources": build_sources(mcp, legacy),
        "dimensions": rules.get("dimensions") or [],
        "levelLabels": rules.get("levelLabels") or {},
        "champions": champions,
    }


def write_outputs(contract, rules):
    json_path = os.path.join(DATA, "bp_contract.json")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(contract, fh, ensure_ascii=False, separators=(",", ":"))
    js_path = os.path.join(DATA, "bp_contract.js")
    with open(js_path, "w", encoding="utf-8") as fh:
        fh.write("window.BP_CONTRACT = ")
        json.dump(contract, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")

    rules_js = os.path.join(DATA, "bp_rules.js")
    with open(rules_js, "w", encoding="utf-8") as fh:
        fh.write("window.BP_RULES = ")
        json.dump(rules, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")
    return json_path, js_path, rules_js


def write_sqlite(mcp, legacy, traits_doc, contract, rules):
    path = os.path.join(DATA, "bp_lab_v22.sqlite")
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE source_snapshot (
          snapshot_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          request_params TEXT,
          requested_cohort TEXT,
          confirmed_cohort TEXT,
          retrieved_at TEXT,
          payload_hash TEXT NOT NULL,
          field_semantics_status TEXT NOT NULL,
          sample_n INTEGER,
          usage_review_status TEXT NOT NULL,
          payload TEXT
        );

        CREATE TABLE champion_traits (
          champion_key TEXT NOT NULL,
          role TEXT NOT NULL,
          patch TEXT NOT NULL,
          dimension TEXT NOT NULL,
          level TEXT NOT NULL,
          evidence TEXT,
          review_status TEXT NOT NULL,
          source TEXT NOT NULL,
          PRIMARY KEY (champion_key, role, patch, dimension)
        );

        CREATE TABLE bp_analysis_cache (
          draft_state_hash TEXT NOT NULL,
          rule_version TEXT NOT NULL,
          snapshot_ids TEXT,
          gaps TEXT,
          conflicts TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (draft_state_hash, rule_version)
        );
        """
    )

    mcp_meta = mcp.get("meta") or {}
    legacy_meta = legacy.get("meta") or {}

    snapshots = [
        {
            "snapshot_id": "snap-opgg-mcp-champion-analysis",
            "provider": "OPGG_MCP",
            "tool_name": "lol_get_champion_analysis",
            "request_params": {"lang": "zh_CN", "tier": mcp_meta.get("tier")},
            "requested_cohort": {"tier": mcp_meta.get("tier"), "region": "未指定"},
            "confirmed_cohort": None,
            "retrieved_at": mcp_meta.get("fetchedAt"),
            "payload": mcp.get("champions") or {},
            "field_semantics_status": "UNVERIFIED",
            "sample_n": None,
            "usage_review_status": "PENDING",
        },
        {
            "snapshot_id": "snap-opgg-web-legacy-trend",
            "provider": "OPGG_WEB_LEGACY",
            "tool_name": "champion_trend_final_game_duration",
            "request_params": {"region": legacy_meta.get("region"), "tier": legacy_meta.get("tier")},
            "requested_cohort": {"region": legacy_meta.get("region"), "tier": legacy_meta.get("tier")},
            "confirmed_cohort": {
                "region": legacy_meta.get("region"),
                "tier": legacy_meta.get("tier"),
                "patch": legacy_meta.get("patch"),
            },
            "retrieved_at": legacy_meta.get("fetchedAt"),
            "payload": legacy.get("champions") or [],
            "field_semantics_status": "LEGACY_AGGREGATE",
            "sample_n": None,
            "usage_review_status": "PENDING",
        },
    ]
    for snap in snapshots:
        con.execute(
            """INSERT INTO source_snapshot VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                snap["snapshot_id"],
                snap["provider"],
                snap["tool_name"],
                json.dumps(snap["request_params"], ensure_ascii=False),
                json.dumps(snap["requested_cohort"], ensure_ascii=False),
                json.dumps(snap["confirmed_cohort"], ensure_ascii=False) if snap["confirmed_cohort"] else None,
                snap["retrieved_at"],
                sha256_json(snap["payload"]),
                snap["field_semantics_status"],
                snap["sample_n"],
                snap["usage_review_status"],
                None,  # payload 存文件即可，DB 里只留哈希，避免重复存储
            ),
        )

    patch = (contract.get("meta") or {}).get("patch", {}).get("label", "16.22")
    rows = 0
    for key, champ in (contract.get("champions") or {}).items():
        for dim, entry in (champ["traits"]["default"] or {}).items():
            con.execute(
                "INSERT OR REPLACE INTO champion_traits VALUES (?,?,?,?,?,?,?,?)",
                (
                    key, "*", patch, dim, entry["level"],
                    json.dumps(entry.get("evidence") or [], ensure_ascii=False),
                    entry["reviewStatus"], traits_source(),
                ),
            )
            rows += 1
        for role, overrides in (champ["traits"]["roles"] or {}).items():
            for dim, entry in overrides.items():
                con.execute(
                    "INSERT OR REPLACE INTO champion_traits VALUES (?,?,?,?,?,?,?,?)",
                    (
                        key, role, patch, dim, entry["level"],
                        json.dumps(entry.get("evidence") or [], ensure_ascii=False),
                        entry["reviewStatus"], traits_source(),
                    ),
                )
                rows += 1

    con.commit()
    con.close()
    return path, rows


def main():
    mcp = load("opgg_mcp.json")
    legacy = load("champions.json")
    rules = load("bp_rules.json")
    traits_doc = load(traits_source(), optional=True)

    contract = build_contract(mcp, legacy, traits_doc, rules)
    paths = write_outputs(contract, rules)
    db_path, trait_rows = write_sqlite(mcp, legacy, traits_doc, contract, rules)

    meta = contract["meta"]
    print(f"contract      : {paths[0]}")
    print(f"contract js   : {paths[1]}")
    print(f"rules js      : {paths[2]}")
    print(f"sqlite        : {db_path}")
    print(f"champions     : {meta['championCount']}")
    print(f"role entries  : {meta['roleEntryCount']}")
    print(f"legacy trends : {meta['trendEntryCount']}")
    print(f"trait rows    : {trait_rows} (reviewed {meta['traitReviewedCount']} / unreviewed {meta['traitUnreviewedCount']})")
    if meta["traitReviewedCount"] == 0:
        print("WARN: 没有任何已审核标签，阵容结构分析会全部显示未审核", file=sys.stderr)


if __name__ == "__main__":
    main()
