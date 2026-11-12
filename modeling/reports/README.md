# Modeling Reports

| 文件 | 状态 | 含义 |
|---|---|---|
| `opgg_mcp_descriptive.json` | ✅ 真实 MCP 数据 | 254 个英雄-分路条目、1,833 个去重双人组合的原始描述统计 + Wilson 95% CI |
| `opgg_mcp_descriptive.md` | ✅ 真实 MCP 数据 | 上表的可读摘要 |
| `synthetic_smoke.json` | ⚠️ 合成数据 | 只用于验证 feature/model/metrics 代码能跑，**不是真实 BP 模型结果** |
| `current_season_pilot.md/.json` | ⚠️ 当前赛季小样本 | 136 场 OP.GG MCP 当前赛季样本；随机 split；只能验证真实数据管线 |
| `current_season_descriptive.json/.md` | ⚠️ 当前赛季小样本 | 136 场 match-level 描述统计（有选择偏差） |
| `current_season_bootstrap.json/.md` | ⚠️ 当前赛季小样本 | 10 个随机 split 的稳健性检查；无稳定信号 |
| `composite_index.md` | ❌ 已弃用 | 胜率榜 + 时间形状的复合指数；v2.2 明令禁止，仅作历史记录 |
| `real_baseline.json` | ⏳ 待生成 | 需要 Riot Match-V5 真实数据 + `train_real.py` |

## 当前最重要的数字

- 英雄-分路：254 条；样本中位数约 11,238 场；全部 ≥500 场（MCP 默认区域聚合）
- 去重双人组合：1,833 条；中位数约 261 场；≥50 场 1,715 条；≥500 场 517 条
- 旧网页时长曲线：40+ 分钟桶相对 50% 偏差 >5pp 的有 172 条；0% / 100% 桶分别 9 / 3 个

## 警告

- OP.GG MCP **没有 region 参数**：不能把它当作韩服 KR 专属数据。
- OP.GG MCP **没有游戏时长桶**：时长曲线仍来自旧网页快照。
- MCP `summary.winRate` 是汇总值，wins 为按 n 近似还原；不是逐局复算。
- `pair_features.csv` 是原始双人胜率，不是扣主效应后的协同残差。
- 任何真实 BP 模型训练必须使用 Riot Match-V5 逐局数据；当前还没有。
