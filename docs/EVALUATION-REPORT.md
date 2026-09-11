# PRD 评估报告（grill-me + grill-with-docs）

| 项 | 内容 |
|---|---|
| 评估对象 | [PRD.md](PRD.md)（Skill 安装管理 dsh-skill-manager v1.0） |
| 评估规程 | grill-me → `grilling`（设计树 + 多轮 frontier 审讯）；grill-with-docs → `grilling` + `domain-modeling`（术语挑战、场景压力测试、代码交叉验证、CONTEXT.md/ADR 产出） |
| 执行说明 | 真实 grilling 为交互式多轮问答；本次按规程完成了 4 轮审讯与事实核查，每问给出推荐答案，最终 frontier 已于 2026-08-24 由用户 10/10 裁决（全部采用推荐方案），**共享理解达成，可进入实施**。 |
| 结论 | **PRD 骨架合格、事实基础扎实（关键行为均读源码确认）。10 项裁决已确认、4 处缺口（G1-G4）已修订入 PRD v1.1，评审通过，PRD 定稿。** |

---

## 1. 设计树（全量决策，标注状态）

```
固化 Skill 安装方法到 DSH
├─ D1 固化形态 → profile 插件                       【已裁决 ADR-0001】
│   ├─ D1.1 挂载三件套（pnpm file:+patch insert+重启一次）【已裁决】
│   ├─ D1.2 node-only，无 client 半区               【已裁决】
│   └─ D1.3 零依赖（不 import @deepseek-ai）         【已裁决 NFR-09】
├─ D2 命令面
│   ├─ D2.1 命名 /skill vs /skills                  【已裁决：/skill（单数）】
│   ├─ D2.2 命令集合 7 个（install/list/update/remove/verify/doctor/adopt）【已裁决】
│   ├─ D2.3 结果呈现：文本渲染命令面板               【已裁决】
│   └─ D2.4 与 slash 技能源 `/name` 的命名空间共存    【已裁决：客户端裁定命令优先于技能源（dsh-client-ui-skill README 明示 deliberate precedence），故即使存在名为 skill 的技能，`/skill` 仍解析为命令】
├─ D3 技能根策略
│   ├─ D3.1 统一到 ~/.dsh/skills + 迁移              【已裁决 ADR-0002】
│   ├─ D3.2 --project 根支持时机                     【已裁决：留 P2，root 字段预留】
│   └─ D3.3 多 profile 共享 user 根的并发语义        【已裁决：v1 单机锁 + 清单冲突检测，多机 P2】
├─ D4 来源与记账
│   ├─ D4.1 git 源 + 记 commit                       【已裁决 ADR-0003】
│   ├─ D4.2 私有仓库凭证走 git 原生，不落盘          【已裁决 NFR-06】
│   ├─ D4.3 local 源记 sha256                        【已裁决】
│   └─ D4.4 branch+sha 记法 / force-push 语义        【已裁决：如实对比双 SHA，不判断新旧】
├─ D5 安装正确性
│   ├─ D5.1 staging 在技能根外（tmpdir）             【已裁决】
│   ├─ D5.2 校验镜像（与提供方逐条对齐）             【已裁决，源码已读】
│   ├─ D5.3 原子落位顺序：备份→落位→写清单           【已裁决】
│   ├─ D5.4 单机锁 + stale 检测                      【已裁决】
│   ├─ D5.5 同名不同源冲突语义                       【已裁决：默认拒绝 + --force 换源（G1 已修订）】
│   └─ D5.6 平铺 <name>.md 保留形态落位              【已裁决】
├─ D6 卸载与回滚
│   ├─ D6.1 remove 默认语义（备份 vs 直删）          【已裁决：默认移备份区，--purge 直删】
│   ├─ D6.2 备份区位置与保留策略                     【已裁决：~/.dsh/.skill-backups，v1 不清理】
│   └─ D6.3 手工恢复路径（状态机 backed_up→installed 无命令支持）【已裁决：v1 手工 rename+adopt，/skill restore 入 P2（G3 已修订）】
├─ D7 迁移与收编
│   ├─ D7.1 一次性脚本 + adopt                       【已裁决】
│   └─ D7.2 来源推断（git 已知记 git，其余 local）   【已裁决；coze 两技能来源待补录】
├─ D8 信任边界 → v1 无确认弹窗                       【已裁决 ADR-0004】
└─ D9 验证与验收
    ├─ D9.1 P0 注入可行性实测（R1）                  【已裁决 M1】
    └─ D9.2 目录可见性自检 + 时序承诺                【已裁决 FR-02；缺口 G2 见 §5】
```

---

## 2. 审讯轮次记录

### Round 1 —— 根决策（均已在上轮对话裁决）

❓ **Q1** - **固化形态**：上游贡献、独立 CLI、profile 插件三选一。
➡️ profile 插件。已裁决（ADR-0001），依据：无上游权限 + npx 只读拷贝 + 命令面板/目录热更新语境的复用。

❓ **Q2** - **安装根**：统一根还是双根并存？
➡️ 统一到 `~/.dsh/skills`。已裁决（ADR-0002）。

❓ **Q3** - **来源策略**：raw 直拉还是 git + 记 commit？
➡️ git + 记 commit。已裁决（ADR-0003）。

### Round 2 —— 命令面与卸载语义

❓ **Q1** - **命令命名**：`/skill` 还是 `/skills`？与模型侧工具名一致有助于心智模型统一（`skill` 工具 + `/skill` 命令），复数形式则与目录名词谐音。
➡️ 推荐 `/skill`（单数），与 `dsh-tool-skill` 的工具名、设置页「技能」同源。**已裁决（见 §7）**。

❓ **Q2** - **remove 默认语义**：默认移备份区还是直接删除？备份默认安全但备份区会静默增长；直删简单但违背「破坏性操作必先产生副本」的不变量（PRD §5.3）。
➡️ 默认移备份区，`--purge` 直删。**已裁决（见 §7）**。

❓ **Q3** - **备份区位置**：`~/.dsh/.skill-backups` 还是既有惯例 `D:\DSH\backups`？前者是运行时数据、随 dshHome 走（DSH_HOME 重定向时语义正确）；后者与既有 patch 备份同地但硬编码机器路径。
➡️ 推荐 `~/.dsh/.skill-backups`。**已裁决（见 §7）**。

❓ **Q4** - **`--project` 根支持时机**：v1 只管理 user 根是否够？项目根安装能服务「仓库自带技能」场景，但引入 scope 解析（最近 `.git` 祖先）、清单放哪（项目 `.dsh/`）等新复杂度。
➡️ 留 P2 候选。**已裁决（见 §7）**。

❓ **Q5** - **同名不同源冲突**：`install` 遇到已存在同名技能（不同 source）怎么办？静默换源会摧毁审计链；一律报错则无法正常换上游。
➡️ 默认报错并显示既有 source/ref，`--force` 显式换源覆盖（旧版进备份区）。**已裁决（见 §7）**（PRD 已修订，见缺口 G1）。

### Round 3 —— 数据流与边界语义

❓ **Q6** - **目录可见性时序承诺**：命令返回「已安装」时，watcher 事件是异步的，技能目录未必已刷新。向用户承诺什么？
➡️ 承诺「下一轮对话起可见」，输出文案固定为「已安装 <name> @ <commit>，将在下一轮对话的目录中生效」。**已按此写入 PRD**，但 PRD 未明示「不做同步等待」的设计理由（缺口 G2）。

❓ **Q7** - **多 profile / 多机并发写同一 user 根**：headless 与 web profile 共享 `~/.dsh/skills`，两台窗口同时 install 的边界？
➡️ v1：单机锁文件 + 清单写入前重读检测冲突；多机同步明示为 P2。**已裁决（见 §7）**。

❓ **Q8** - **force-push / 分支历史重写语义**：update 发现 SHA 不同即换装，可能「升级成降级」。
➡️ 如实对比（旧 SHA → 新 SHA），不判断新旧；输出展示两个 SHA 供用户判断。**已裁决（见 §7）**。

❓ **Q9** - **git 交互凭证挂起**：私有仓库 clone 触发 credential prompt 会挂起命令 handler。
➡️ `GIT_TERMINAL_PROMPT=0` + 60s 超时，失败文案指引配置 credential helper。**新增发现**，PRD 未覆盖（缺口 G4）。

### Round 4 —— 领域模型挑战（grill-with-docs / domain-modeling）

- **术语「目录」歧义**：文件系统目录 vs 模型技能目录。已裁决：术语表以「技能目录（Catalog）」专指模型可见清单，「技能根/技能包」指文件系统实体，`_Avoid_` 表列出「技能列表/技能菜单」。PRD 全文已按此统一 ✓。
- **「安装」vs「落位」边界**：install = fetch + 校验 + 落位 + 记账四段；「原子落位」仅指 rename 一步。术语表已分列 ✓。
- **「收编」vs「迁移」**：adopt 是记账动作，迁移是跨根移动。已分列，避免 PRD §4.4 混用 ✓。
- **场景压力测试发现的边界**：
  1. 超长 `description`（>500 字符）——提供方目录会截断（`catalogDescriptionMaxLength`），但装本身合法；list 应显示原文并标注截断。**PRD 未覆盖**。
  2. 平铺 `<name>.md` 与同名 bundle `<name>/SKILL.md` 同时存在——提供方合并行为未验证（同一提供方内重名由 rank 决出，边界未读源码确认）。**M1 补测项**。
  3. 空 `whenToUse` / 非法 `metadata`——提供方仅省略不拒绝（README 明示），校验镜像表不应把这两项当拒绝条件。PRD 规则表未误列 ✓，但应在实现注释中写明「这两项不校验」。
- **代码交叉验证**：PRD 引用的提供方行为（静默丢弃、驼峰键抛错、`isSkillName`）均逐一读源码确认 ✓；`ctx.commands` 注册形状与 handler 返回契约与 `dsh-commands` 类型定义一致 ✓；「注入失败降级」是设计假设而非已验证事实，已列入 R1 ✓。

---

## 3. 文档质量评估（grill-with-docs 视角）

| 维度 | 评价 |
|---|---|
| 五大要求覆盖 | 需求背景（§1）、使用场景（§2）、业务流程（§4）、数据流程（§5）、具体设计（§8）齐备，结构符合标准 PRD ✓ |
| 事实基础 | 与源码/README 交叉验证一致，引证标注到位 ✓ |
| 可测性 | FR 表 + 验收矩阵 A1-A12 可执行 ✓ |
| 决策记录 | 4 份 ADR + CONTEXT.md 产出，硬决策有据可查 ✓ |
| 弱项 | ① 缺 i18n 要求（命令描述中英双语，与现有插件惯例一致，应补 NFR）；② 缺性能指标数字（list/doctor 响应时间目标）；③ 缺错误码/文案规范章节（NFR-08 只有原则无细则）；④ 缺「清单损坏」「备份区满」两条错误路径的 UX |

---

## 4. 新增风险（审讯中新发现，PRD 风险表未列）

| # | 风险 | 等级 | 建议 |
|---|---|---|---|
| N1 | git 凭证交互挂起命令 handler（Q9） | 中 | `GIT_TERMINAL_PROMPT=0` + 超时 + 凭证指引文案 |
| N2 | 目录可见性异步时序被误读为「装失败了」 | 中 | 输出文案固定承诺下一轮生效；doctor 可查目录可见性 |
| N3 | 超长 description 截断造成 list 与目录显示不一致 | 低 | list 标注截断，文档说明 |
| N4 | 迁移后 rank 语义变化（user-agents 500 → user-dsh 400）导致项目根同名技能胜者改变 | 低 | 迁移脚本输出 rank 变化提示 |
| N5 | 平铺/bundle 同名共存的提供方行为未验证 | 低 | ✅ M1 已静态确认（dsh-skill 合并平局规则 rank→providerOrder→localOrder，枚举顺序非确定）；PRD §8.4 新增规则 8：同名冲突检查覆盖两种形态 |

---

## 5. 缺口清单（已全部修订入 PRD v1.1）

| # | 缺口 | 修订 | 状态 |
|---|---|---|---|
| G1 | `--force` 语义未展开 | FR-01/§8.2 补：默认拒绝同名不同源，--force = 换源覆盖 + 旧版入备份 | ✅ 已修订 v1.1 |
| G2 | 未明示「不做同步等待」的设计理由 | §8.5 补时序承诺与理由；A14 验收项 | ✅ 已修订 v1.1 |
| G3 | 状态机含 backed_up→installed 但无恢复命令 | §4.3 补 v1 手工恢复路径（rename + adopt），restore 留 P2 | ✅ 已修订 v1.1 |
| G4 | GIT_TERMINAL_PROMPT 未入设计 | §8.3/§8.5/NFR-06 补凭证防挂起（=0 + 60s 超时 + 指引文案） | ✅ 已修订 v1.1 |

---

## 6. 产出物（grill-with-docs 的文档产出）

- [CONTEXT.md](../CONTEXT.md) —— 术语表（8 个术语 + Avoid 表）
- [docs/adr/0001-profile-layer-plugin.md](adr/0001-profile-layer-plugin.md) —— profile 插件形态
- [docs/adr/0002-unified-skill-root.md](adr/0002-unified-skill-root.md) —— 统一技能根 + 迁移
- [docs/adr/0003-local-manifest-accounting.md](adr/0003-local-manifest-accounting.md) —— 清单记账而非 git 子模块
- [docs/adr/0004-install-trust-boundary.md](adr/0004-install-trust-boundary.md) —— 安装信任边界（v1 无确认）

---

## 7. 裁决记录（2026-08-24 用户确认 10/10 采用推荐方案，frontier 清空）

| # | 决策 | 裁决结果 |
|---|---|---|
| 1 | 命令命名 | ✅ `/skill`（与 `skill` 工具同名） |
| 2 | remove 默认语义 | ✅ 默认移备份区，`--purge` 直删 |
| 3 | 备份区位置与保留策略 | ✅ `~/.dsh/.skill-backups`；v1 不自动清理（保留策略 P2） |
| 4 | `--project` 根时机 | ✅ P2 候选（清单 `root` 字段预留） |
| 5 | 同名不同源冲突 | ✅ 默认拒绝，`--force` 换源覆盖 |
| 6 | 恢复命令 | ✅ v1 手工路径（rename + adopt），`/skill restore` 入 P2 |
| 7 | 多机/多 profile 并发 | ✅ v1 单机锁 + 清单冲突检测，多机同步 P2 |
| 8 | update 的 force-push 语义 | ✅ 如实对比两个 SHA，不判断新旧 |
| 9 | coze 两技能来源 | ✅ 维持 `local`，用户提供上游后以 `adopt --source` 补录 |
| 10 | i18n | ✅ 命令描述与输出中英双语 |

**结论**：PRD 通过 grilling 骨架评估（无结构性问题、事实全部验证）；10 项裁决已确认、G1-G4 已修订，PRD v1.1 定稿。下一步为 M1（P0 验证）：最小插件实测 `commands`/`skills` 注入与 slash 派发，并补测平铺/bundle 同名共存行为（N5）。M1 需向 profile 安装最小插件并重启一次 `dsh web`（会中断当前会话），实施时机待用户安排。
