# BP LAB v2.1 Modeling Scaffold

> ⚠️ **v2.2 已改变产品路线**：现行产品按《BP LAB v2.2》只用 OP.GG 官方聚合统计 + 人工审核标签 + 规则，
> **不需要**逐局比赛仓库或训练好的概率模型。本目录保留为可选的研究/未来路线，不是 MVP 前置。
> 产品实现见根目录 `engine.js`、`data/bp_rules.json`、`docs/BP_LAB_v2.2_实施说明.md`。

> 按 `BP_LAB_v2.1_数据分析与建模规范` 建立的可运行建模底座。
>
> **当前状态：数据/模型管线已搭好；真实比赛数据尚未接入。**
> 没有 Riot Match-V5 数据时，不能训练或宣称真实 BP 预测。

## 已实现

| 模块 | 文件 | 说明 |
|---|---|---|
| SQLite schema | `modeling/schema.sql` | matches / participants / bans / trait labels / rank snapshots |
| SQLite loader | `modeling/src/load_db.py` | 从标准 schema 读取每局 10 人记录 |
| 特征矩阵 | `modeling/src/features.py` | M2 hero-role、M3 same-team pair 的差分编码 |
| 模型 | `modeling/src/model.py` | Numpy 实现的 L2 正则 logistic regression |
| 指标 | `modeling/src/metrics.py` | LogLoss / Brier / AUC / ECE / Wilson CI |
| Riot 数据采集 | `modeling/src/riot_ingest.py` | Match-V5 → SQLite 最小采集骨架（需 `RIOT_API_KEY`） |
| 真实基线训练 | `modeling/src/train_real.py` | 时间前向 M0–M3 baseline |
| 合成烟雾测试 | `modeling/src/synthetic.py`, `run_smoke.py` | 只验证代码能跑，不是英雄数据 |
| 描述统计 | `modeling/src/descriptive.py` | OP.GG MCP 数据 + Wilson CI |

## 运行

```bash
# 1. 生成 OP.GG MCP 描述统计（使用现有 data/opgg_mcp.json）
python3 modeling/src/descriptive.py

# 2. 合成数据烟雾测试（不是真实模型结果）
python3 modeling/src/run_smoke.py

# 3. 有 Riot API key 时采集真实数据
RIOT_API_KEY=... python3 modeling/src/riot_ingest.py --out data/bp_lab.sqlite --pages 2 --matches-per-player 10

# 4. 当前赛季小样本（不需要 Riot key，通过 OP.GG MCP 采集）
python3 scripts/fetch_opgg_mcp_matches.py --db data/bp_lab_current_season.sqlite --players 2 --matches-per-player 10

# 5. 当前赛季 pilot 训练（仅验证真实数据管线，不是上线模型）
python3 modeling/src/train_pilot.py --db data/bp_lab_current_season.sqlite --out modeling/reports/current_season_pilot.json

# 5b. 多随机 split 稳健性（仅管线检查）
python3 modeling/src/bootstrap_pilot.py --db data/bp_lab_current_season.sqlite --out modeling/reports/current_season_bootstrap.json --seeds 10

# 6. 有 Riot Match-V5 全量数据后训练正式 baseline
python3 modeling/src/train_real.py --db data/bp_lab.sqlite --out modeling/reports/real_baseline.json
```

## 真实训练前必须完成

1. 申请 Riot API production/personal key；只采符合规范的队列（例如 420）。
2. 按 `schema.sql` 建库。
3. 从 League-V4/League-EXP-V4 获取 KR Master+ 玩家，经 Summoner-V4 转 PUUID，再拉 Match-V5 的 match detail/timeline。
4. 全局按 `game_id` 去重，记录 `quality_status`、patch mapping、角色质量。
5. 只使用 `prediction_time` 之前可见的聚合特征，执行 forward-only 回测。

## 当前真实样本（2026-11-11，当前赛季）

- `data/bp_lab_current_season.sqlite`：**136 场** Solo Ranked 对局，1,360 participants，1,309 bans
- 来源：OP.GG MCP 当前赛季英雄排行榜 top 玩家 → 最近对局 → `lol_get_summoner_game_detail`
- 只覆盖少数英雄/分路的高分玩家，存在明显选择偏差；不能代表韩服 Master+ 全体
- `modeling/reports/current_season_pilot.md` 中有 pilot 指标，仅用于验证真实数据管线

## 当前不能做的事

- 不能把 `data/opgg_mcp.json` 的汇总胜率当作训练标签。
- 不能把 `pair_features.csv` 的原始双人胜率当作“协同效应”。
- 不能把 `champion_traits.json` 的启发式标签直接当作已审核体系标签。
- 不能用合成 smoke test 的指标声称模型有效。

## 输出

- `modeling/reports/opgg_mcp_descriptive.json` / `.md`：真实 MCP 描述统计（带 Wilson CI / 样本量）
- `modeling/reports/synthetic_smoke.json`：合成管线烟雾测试（仅验证代码）
- 真实训练后生成 `modeling/reports/real_baseline.json`
