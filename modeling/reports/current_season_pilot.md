# 当前赛季 MCP 小样本 Pilot

> 数据：OP.GG MCP 当前赛季（2026-11-11），通过英雄排行榜 top 玩家拉取最近单排对局，再拉完整 game detail。
>
> **这不是上线模型，也不是完整韩服大师+样本。**

## 数据样本

- 136 场对局
- 1,360 条 participant 记录
- 1,309 条 ban 记录
- 10 个英雄-分路排行榜 × 前 2 名玩家
- 全部 `quality_status=PASS`
- 全部 `patch_public=26.22`
- 来源：OP.GG MCP（当前赛季，KR，Solo Ranked 420）

**偏差：** 只覆盖少数英雄排行榜的高分玩家，且玩家之间对局会重叠；不能代表韩服大师+ 全体。样本蓝方胜率约 41.9%，明显偏离 50%，进一步说明这不是随机对局样本，不能把 pilot 指标当作总体胜率。

## Pilot 结果（随机 split 81 / 27 / 28）

| 模型 | LogLoss | Brier | AUC | ECE |
|---|---:|---:|---:|---:|
| M0 50% | 0.6931 | 0.2500 | 0.500 | 0.143 |
| M1 常数 | 0.6634 | 0.2352 | 0.500 | 0.075 |
| M2 hero-role | 0.6593 | 0.2332 | 0.583 | 0.080 |
| M3 hero+pair | 0.6596 | 0.2333 | 0.628 | 0.078 |

**解读：**
- M2/M3 在这个小样本上略有提升，但 28 场测试集太小，不可据此宣称有效。
- M3 的 AUC 更高但 LogLoss 没改善，说明排序和概率质量不是一回事。
- 只能视为真实数据管线的端到端 smoke test；正式模型需要 Riot Match-V5 覆盖全部 KR Master+ 的逐局数据。

## 文件

- `data/bp_lab_current_season.sqlite`：136 场 SQLite 样本
- `modeling/reports/current_season_pilot.json`：模型指标
