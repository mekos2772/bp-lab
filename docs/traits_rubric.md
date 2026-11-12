# 战术标签打分规则（traits rubric）

目标：把「英雄在阵容里能提供什么」标成 10 维离散等级，供 BP LAB 的结构分析、阶段倾向曲线使用。
**这不是统计结果，不接受"感觉很强"，每条判断必须能指到具体技能。**

## 输出格式

```json
{
  "champions": {
    "ahri": {
      "name": "阿狸",
      "default": {
        "engage":    {"level": "WEAK",   "reviewStatus": "DRAFT", "source": "ddragon+llm", "evidence": ["魅惑 E 需命中，非硬开团"]},
        "...": {}
      },
      "roles": {}
    }
  }
}
```

- 10 个 key 必须齐全：`engage, peel, frontline, poke, waveclear, dps, burst, splitpush, dive, scaling`
- `level ∈ {WEAK, MEDIUM, STRONG}`；不确定写 `UNREVIEWED`（但本批目标是全覆盖，尽量不写）
- `reviewStatus` 一律 `DRAFT`；`source` 一律 `ddragon+llm`
- `evidence` 1–2 条，≤30 字，必须点出技能名/机制（不许写"很强""战士"这种空话）

## 通用原则

1. **只算该英雄自己能稳定提供的能力**，不算"如果队友配合/如果装备成型"。
2. **对队友有效才算团队能力**：自我治疗、自我格挡不计入 `peel`。
3. **有硬控 ≠ 能开团**：`engage` 看"能不能主动、可靠地把团开起来"（距离/命中条件/风险）。
4. **STRONG 有配额**：单英雄 STRONG ≤ 3 个；全 10 维中等是合法的，"六边形战士"不是。
5. 远程（`attackrange > 500`）且没有 Tank 标签的英雄，`frontline` 不得为 STRONG。
6. 新英雄/机制不确定 → 该维 `UNREVIEWED` + evidence 写"机制未核对"。

## 十维判定

| 维度 | STRONG | MEDIUM | WEAK |
|---|---|---|---|
| engage 开团 | 有硬控（击飞/眩晕/压制/嘲讽/**禁锢/沉默/恐惧/魅惑**）且可主动、远距离或高命中率释放 | 需要条件（先命中减速、需近身、需队友先手） | 无硬控，只有位移/减速/自己进场 |
| peel 保护 | 有给**队友**的护盾/治疗/位移救援/硬控反手，且稳定 | 有条件（需命中、范围小、CD 长） | 只有自我增益/自我回复 |
| frontline 前排 | 坦克标签或明确减伤/护盾 + 高基础耐久，能吸收第一波 | 半肉战士，能顶但不持久 | 脆皮/远程，几乎不能承伤 |
| poke 消耗 | 远程（>500）且战前可稳定输出（长手技能/高频） | 中距离或有条件消耗 | 无远程消耗手段 |
| waveclear 清线 | 大范围 AoE，短 CD，能独立清一波兵 | 需要装备/等级，或范围小 | 清线极慢（纯单体/无 AoE） |
| dps 持续输出 | 有射程或持续输出机制，能打满整场团战 | 有输出窗口但受站位/技能限制 | 只有一套爆发，打完就空 |
| burst 爆发 | 短窗口（2–3 秒）内可打出致命单体伤害 | 需要连招/装备/命中条件 | 无爆发，伤害平滑 |
| splitpush 分推 | 1v1 强 + 清线快 + 有脱离手段 | 能带但怕抓/推塔慢 | 不能独立带线 |
| dive 机动/进场 | 有稳定位移直达后排，且能脱身 | 位移短/需条件 | 无位移或只能原地 |
| scaling 成长 | 强依赖等级/装备，后期质变（明确的时间点） | 平稳成长 | 前期英雄，后期相对下滑 |

## 硬案例（必须一致）

- 杰斯：poke = STRONG（远程形态 E 加速 Q）
- 菲奥娜：peel = WEAK（W/回复只作用于自身）
- 悠米：peel = STRONG，frontline = WEAK
- 赛恩：splitpush = STRONG（死后被动继续推塔）
- 索拉卡/娜美：peel ≥ MEDIUM，frontline = WEAK
- 莫甘娜 Q（禁锢）、韦鲁斯 R（禁锢）、婕拉 E（禁锢）**算硬控**，engage 按命中条件给 MEDIUM；减速/位移不算硬控
- 亚索风墙：peel 写清"只挡飞行物、位置固定"

## 自检清单（提交前）

- [ ] 29 个 key 全部出现，10 维齐全
- [ ] 每英雄 STRONG ≤ 3
- [ ] 远程非坦克 frontline ≤ MEDIUM
- [ ] 每条 evidence 都有技能名
- [ ] 没有把"自我回复"写成 peel
- [ ] JSON 合法（`python3 -c "import json;json.load(open(...))"`）
