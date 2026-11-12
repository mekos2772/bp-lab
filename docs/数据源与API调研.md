# BP LAB 数据源与 API 调研

> 调研时间：2026-11-11 · 目标：确认 OP.GG、Riot、第三方数据源是否有可用 API，以及各自能提供什么数据。

## 实测结果（2026-11-11）

已用 OP.GG MCP 的 `lol_get_champion_analysis` 抓取 **171 个英雄 / 254 个英雄-分路条目，0 失败**，生成：

- `data/opgg_mcp.json` / `data/opgg_mcp.js`：英雄统计、Counter、双人协同、版本趋势
- `data/bp_backend_features.json`：后端全量特征
- `data/champion_role_features.csv` / `pair_features.csv` / `counter_features.csv`：后端 CSV

## 结论先行

| 数据源 | 官方 API | 适合拿什么 | 主要限制 | 建议 |
|---|---|---|---|---|
| **Riot Games API** | ✅ 官方 | Match-V5 对局、League-V4 段位名单、Summoner-V4、Data Dragon | 需要注册/key；限速；生产 key 需申请；需遵守 Riot 产品政策 | **长期最优，做比赛级训练数据** |
| **OP.GG MCP Server** | ✅ 官方 MCP 服务 | 英雄胜率/Pick/Ban、分路梯队、Counter、双人协同、版本趋势、出装/符文 | 无 `region` 参数；无游戏时长桶；非 REST JSON；无公开 SLA/商业授权说明 | **原型首选，替代网页抓取** |
| **OP.GG 网页** | ❌ 无公开 REST API | 英雄趋势、时长曲线、协同页 | ToU 禁止 scraping/data mining；帮助中心说明与 ToU 有冲突 | 不再作为长期数据源 |
| **U.GG / Lolalytics / LeagueOfGraphs** | ❌ 无公开官方 API | 页面展示的统计、梯队、时长曲线 | 只有非官方 scraper；ToS 与稳定性风险 | 仅做页面参考/人工核对 |
| **Oracle's Elixir** | ⚠️ 公开 CSV | 职业比赛完整数据、pick/ban、结果、时长 | 非商业使用；职业赛 domain；数据源可能中断 | 职业赛分析首选公开数据 |
| **Leaguepedia** | ✅ MediaWiki/Cargo API | 职业赛英雄 BP、选手、赛事、赛程 | 社区维护；字段/覆盖需校验 | 职业 BP 补充 |
| **Data Dragon / CommunityDragon** | ✅ 静态资源 | 英雄、技能、图标、属性、版本 | 无对局统计；更新有延迟 | 资产/标签基础 |

---

## 1. OP.GG MCP Server（重要发现）

OP.GG 官方组织提供了一个 MCP Server：

- GitHub：https://github.com/opgginc/opgg-mcp
- Endpoint：`https://mcp-api.op.gg/mcp`
- 协议：Streamable HTTP MCP（不是普通 REST JSON API）
- 实测：`initialize` 和 `tools/list` 可访问；`lol_get_champion_analysis` 可在 `tier=master_plus` 下返回数据（无显式 auth header）

### 可用工具（LoL）

| 工具 | 能提供 |
|---|---|
| `lol_get_champion_analysis` | 英雄胜率/Pick/Ban/场次/梯队/排名、伤害类型、Counter（含场次和胜率）、双人协同（含 play/win_rate/score）、版本趋势、出装/符文/技能 |
| `lol_get_champion_synergies` | 指定英雄 + 自己位置 + 队友位置的双人协同 |
| `lol_get_lane_matchup_guide` | 指定英雄 vs 对手英雄的分路对局建议（偏文本） |
| `lol_list_lane_meta_champions` | 各分路英雄梯队、胜率、Pick/Ban、KDA、rank |
| `lol_list_champions` | 英雄列表/ID/名称/发布日期 |
| `lol_list_champion_details` | 技能、提示、背景、基础属性 |
| `lol_get_summoner_game_detail` | 单场对局详情（含 bans、10 名玩家、出装） |
| `lol_list_summoner_matches` | 玩家最近对局列表 |
| `lol_list_champion_leaderboard` | 英雄的高分玩家榜 |

### 实测示例

请求（AHRI / mid / master_plus / zh_CN）返回的结构包括：

```text
data.summary.average_stats: play, win_rate, pick_rate, ban_rate, kda, tier, rank
data.damage_type: AP
data.strong_counters[]: champion_name, play, my_win_rate, counter_win_rate
data.weak_counters[]: champion_name, play, my_win_rate, counter_win_rate
data.synergies: top / jungle / adc / support
```

**优点：**
- 官方组织维护，避免自己爬 OP.GG 页面。
- 直接给 Counter、协同、版本趋势、伤害类型，比我们当前只抓“时长曲线 + 协同”更完整。
- 支持 `lang=zh_CN` 中文英雄名。

**限制：**
- 参数里**没有 `region`**（至少 `lol_get_champion_analysis` / `lol_list_lane_meta_champions` 没有），无法确认是否支持“韩服 KR 专属”；可能是全球/默认区域聚合。
- **没有游戏时长桶**（`game_length` / 25-30 / 40+ 这类字段不在 schema 里），无法直接替代我们当前的时长曲线。
- 返回值是 MCP content text（类似 Python dataclass repr），不是标准 REST JSON；需要 MCP 客户端或解析层。
- 目前没有公开的 SLA、rate limit、商业使用授权说明；README 是 MIT（代码），不等于数据授权。
- OP.GG Help Center 说“不会向第三方提供数据”，但官方 MCP 又公开提供数据，两个口径存在张力；生产前应向 OP.GG 书面确认。

**适合 BP LAB：**
- 用来替换当前 `data/synergies.js` 的网页抓取
- 用来补 Counter、伤害类型、版本趋势、分路梯队
- 不适合单独作为“比赛级训练数据”或“时长曲线”来源

---

## 2. Riot Games 官方 API

入口：https://developer.riotgames.com/apis/
LoL 文档：https://developer.riotgames.com/docs/lol

### 关键接口

| API | 用途 |
|---|---|
| `match-v5` | 根据 matchId 拉取对局详情、timeline；比赛结果、10 名玩家、英雄、位置、时长、事件 |
| `league-v4` / `league-exp-v4` | 按 tier/division 拉取召唤师名单（用于定位韩服 Master+ 玩家） |
| `summoner-v4` | Riot ID → PUUID |
| `champion-mastery-v4` | 玩家英雄熟练度 |
| `spectator-v5` | 进行中的比赛（实时预测可用） |
| `tournament-v5` | 自定义赛事/ tournament draft 流程 |
| Data Dragon | 英雄/装备/符文/图标静态数据 |

### 适合 BP LAB 的采集链路

```text
1. League-EXP-V4 / League-V4 获取 KR Master+ 玩家名单
2. Summoner-V4 获取 PUUID
3. Match-V5 按 PUUID 拉 match IDs
4. Match-V5 拉每场 detail / timeline
5. 去重、解析 patch、角色、胜负、时长
6. 生成比赛级事实表 + 特征
```

### 限制

- 需要 Riot 开发者账号和 API key；生产产品需要申请 production key。
- 有 rate limit（官方文档会更新，需按当前 portal 为准）。
- 不能从普通 `match-v5` 赛后数据可靠还原 **完整 pick/ban 顺序**；职业 BP 顺序需要 tournament/draft log 或赛事数据。
- `pregame_rank` 不在 Match-V5 里，需要单独做 rank snapshot。
- 产品需遵守 Riot 的 General Policies / Game Specific Policies；不能替代玩家做决定式推荐（UI 应输出候选 + 理由 + 不确定性，而不是“必须选 X”）。

---

## 3. OP.GG 网页抓取

- 现有 BP LAB 数据来源：`op.gg/zh-cn/lol/champions/...`（KR / 大师+ / Patch 16.22）
- 可拿到：英雄时长曲线（5 桶）、双人协同、Counter 页、英雄榜
- 问题：
  - OP.GG Terms of Use（https://op.gg/lol/policies/agreement）明确禁止 scraping/data mining
  - 帮助中心（2025-12-31）却说“一般不禁止 crawling”，与 ToU 冲突；更新日期更晚的 ToU 法律地位更高
  - 页面结构、class 名、字段随时可能变化；无法作为长期数据合同
- 建议：**保留现有数据作为 prototype 快照，但生产版本迁移到 OP.GG MCP 或 Riot API；如继续使用网页抓取，需 OP.GG 书面许可。**

---

## 4. U.GG / Lolalytics / LeagueOfGraphs

- 没有发现官方公开 API 文档。
- Lolalytics 只有社区 scraper：https://github.com/CodeFatherG/lolalytics-api（非官方）
- 这些站点通常有 Cloudflare/ToS 限制，不适合做数据底座。
- 可用于人工交叉验证；不建议自动抓取。

---

## 5. Oracle's Elixir / Leaguepedia（职业赛）

### Oracle's Elixir

- 地址：https://lol.timsevenhuysen.com/matchdata/
- 提供职业比赛 CSV（含队伍、选手、英雄、结果、时长等）
- FAQ 明确为非商业使用；商业产品需单独确认
- 适合职业 BP / 赛事分析；不适合韩服大师+排位

### Leaguepedia

- API 文档：https://lol.fandom.com/wiki/Help:Leaguepedia_API
- 使用 MediaWiki/Cargo API 查询职业赛事、BP、选手、赛程
- 社区维护，字段/覆盖需校验

---

## 6. 推荐的数据架构

### 原型/短期

```text
OP.GG MCP Server
  ├─ 英雄基础统计 / 分路梯队
  ├─ Counter
  ├─ 双人协同
  ├─ 版本趋势
  └─ 伤害类型

+ 当前已抓取的 OP.GG 时长曲线（仅作为临时快照）

+ Data Dragon / CommunityDragon
  └─ 图标、技能、属性、标签
```

### 生产/长期

```text
Riot Match-V5（主）
  ├─ 比赛级事实表
  ├─ timeline
  └─ 自行计算时长桶、对位、组合、选手熟练度

Leaguepedia / Oracle's Elixir（职业赛）
  └─ 职业 BP / 赛事数据

OP.GG MCP（辅助）
  └─ 快速查询、页面展示、交叉验证
```

---

## 7. 下一步建议

1. **先接 OP.GG MCP**：把当前网页抓取的协同数据替换为官方 MCP；同时补 Counter / 伤害类型 / 分路梯队。
2. **保留时长曲线为临时数据层**：MCP 没有时长桶；在 Riot API 数据链路建立前，继续使用当前快照，并明确来源/更新时间。
3. **建 Riot Match-V5 最小仓库**：这是唯一能支撑真正训练/回测的路线。
4. **不要长期依赖网页 scraping**：OP.GG ToU 风险 + 页面结构风险。
5. **生产前确认授权**：OP.GG MCP 的公开 endpoint 是否有商业使用许可、rate limit、SLA；Riot production key 的产品政策。
