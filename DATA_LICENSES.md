# 数据来源与许可

本仓库包含/使用以下公开数据。再分发时请保留出处与许可说明。

| 数据 | 来源 | 许可 | 用途 |
|---|---|---|---|
| 英雄/技能/属性 | Riot Data Dragon 16.22.1 | Riot 官方条款 | 标签、图标 |
| 职业对局（阵容/胜负/时长） | GPTilt `gptilt/lol-esports-matches` | CC BY-SA 3.0 | 真实 BP 回测、胜率校验 |
| 职业逐局 10/15 分钟差值 | ChainCC Open Dataset | CC BY 4.0 | 对线强度、阶段校准 |
| 真实 BP 顺序 | LoL-Draft (`DeusExMachina1993/LoL-Draft`) | CC BY-SA 4.0 | 真实顺序回测 |
| 英雄-分路胜率/选取率 | OP.GG（MCP 快照） | OP.GG 服务条款 | 版本胜率展示（口径未确认） |
| 赛程/结果 | lolesports.com 同源接口、OP.GG MCP | 各站条款 | 首页实时比赛 |

`data/raw/` 与 `*.sqlite` 不入库，可用 `scripts/fetch_public_datasets.sh` 与各 build 脚本重建。

## 免责声明

本项目不输出预测胜率；所有统计结论都附带样本量、口径与限制。英雄标签中
`SPOT_CHECKED` 条目由 DDragon 技能文本 + 规则生成，非逐个英雄人工复核。
