# 计划评审与需求对齐（v2）

| 项 | 内容 |
|---|---|
| 文档版本 | v2.0（对齐「管理页面 + 标准插件交付」新需求） |
| 关联文档 | [PRD.md](PRD.md)（v1.1，待升 v2.0）、[M2-PLAN.md](M2-PLAN.md)、[EVALUATION-REPORT.md](EVALUATION-REPORT.md)、ADR-0001~0004 |
| 调查依据 | 三路只读调查（市场页范式 / 标准插件交付形态 / 禁用机制）+ 本文作者的源码复核 |
| 状态 | **待用户裁决 §8 的 6 项决策**，裁决后升 PRD v2.0 并开工 |

---

## 0. 结论摘要

1. **旧计划的三条明文条款被新需求推翻**：PRD §1.4「不做 client 半区管理 UI」、评估报告 D1.2「node-only」、M2-PLAN「client UI 不做」——需以新 ADR 取代。
2. **管理页面的实现范式已在生态中验证**：profile 里的第三方插件 `dshmarket`（v1.38.1，「插件市场」页）用「独立 `settings.section` + 宿主自注册 HTTP 路由 + primitives 组件 + Modal 二次确认」实现清单/禁用/卸载，**零代码生成、零第一方改动**。我们照此实现，且可复用已有两块资产（现有只读 Skill 页 UI + M2 宿主核心模块）。
3. **「禁用」有代码级可行的实现，且隐藏区应放在技能根之外**：提供方只发现技能根的**直接子项**（`discoverRoot` 单层 readdir），把技能移入**同级隐藏区** `<dshHome>/.skill-disabled/`（与既有 `.skill-backups` 对称、同卷原子、完全在扫描根之外）即从目录消失且不删文件；反向移动即启用。watcher 靠「源/目标路径」的热事件（`unlinkDir`/`addDir <root>/<name>`）失效，**下一轮对话起生效**（chokidar `atomic` 延迟 100 ms + readdir 1 s 节流，不存在「即时生效」）。
4. **「标准插件」的唯一判据是 `package.json` 声明 `dsh.bundle.patch`**：声明后 `dsh plugin --profile web add <spec>` 会自动写 `dsh.profile.bundles` 并自挂载，**零手写 patch**；宿主+客户端双半区同包是官方一等公民。
5. **最终交付物 = 一个包**：`dsh-skill-manager`（改名脱离 `@deepseek-ai` 域），含宿主半区（命令 + 核心模块 + HTTP 路由）与客户端半区（管理页面），旧只读页插件并入后退役。
6. **定位收敛（2026-09-11 用户澄清）**：本插件是**本地已安装技能的管理器**，不做互联网技能检索/市场/索引（SkillHub 类站点已存在）；页面只做**查询（含本地搜索）、禁用、卸载**三件事。**更新（update）近期不做**，但因清单已记录 source/ref，未来可直接生长。因此凡是需要联网的功能（`update`、`verify --remote`、远程索引）一律移出近期范围。

---

## 1. 需求变化与影响面

| 新需求 | 影响 |
|---|---|
| **R1 管理页面**（类插件市场）：查看清单 / 禁用 / 卸载 | 新增客户端半区 + 宿主 HTTP 路由；新增 FR、验收项、里程碑 M4 |
| **R2 M2 底层命令必须保留** | 保留原 FR-01~FR-12 全部；页面与命令**共用同一套宿主模块**（一套校验/落位/记账/锁，两个入口） |
| **R3 最终是可交付的 DSH 标准插件** | 交付形态从「profile 本地包 + PowerShell 脚本」升级为「npm/git 可安装 + 自动挂载的标准插件」；新增里程碑 M2a、M5 与交付检查清单 |
| **R4 定位收敛：本地管理器，非市场**（2026-09-11 澄清） | 页面**不做**互联网检索/索引/市场浏览；只管理**已安装**技能：查询（含本地搜索过滤）/禁用/卸载。`update` 与 `verify --remote` **移出近期范围**（清单仍记 source/ref，为将来生长留口）。**待确认**：`/skill install <git-url>` 命令是否保留（我的理解：保留，它是 M2 底层命令，只是页面不给安装入口） |

### 1.1 定位澄清（2026-09-11，用户原话要点）

> 「我并不需要在这个管理功能里检索互联网上的 Skill，只需要能够搜索到当前 dsh 安装的 Skill……这个插件的目的就是管理 dsh 已安装的 Skill，查询、禁用、卸载，未来可能需要支持更新，但近期不需要。」

**必须区分两件事，避免后续误解**：

| 维度 | 定位 |
|---|---|
| **UI 形态** | **参照**插件市场页的交互与视觉（列表/卡片/开关/二次确认/Motion），因为那是用户已熟悉的范式 |
| **功能范围** | **仅本地已安装技能**——无互联网检索、无市场目录、无在线安装入口、无 SkillHub 类聚合 |
| 功能清单 | 查询（列表 + 本地搜索/过滤）、禁用/启用、卸载；（更新=远期） |
| 明确非目标 | 互联网技能检索与索引、市场/商店页、在线评分或推荐、远程 Skill 目录同步、`update`、`verify --remote` |

**这一收敛同时降低了三处风险**：无需处理网络失败与代理（本机直连 GitHub 本就被重置）、无需维护远程索引契约、页面的数据面完全落在本地文件系统与清单（离线可用）。

### 1.2 架构结论：两个插件合并为一个包（2026-09-11 用户确认）

> 「你可以理解为把当前这个页面的插件和 skill manage 的插件合并了。」

| 来源 | 并入后的归属 |
|---|---|
| `@deepseek-ai/dsh-client-ui-settings-skills`（现有只读页面） | 其**客户端半区**（页面 UI、CSS、双语文案）迁入新包；其**宿主半区**的 navIcon 自愈补丁（`ensureNavIconPatch()`）一并迁入新包 node 半区；原包随后退役 |
| `@deepseek-ai/dsh-skill-manager`（命令 + 核心） | 作为新包的宿主半区主体，新增本地路由与（可选）页面所需接口 |

**合并后的包结构**（单包双半区，取代原先两个独立插件）：

```
dsh-skill-manager/
├── package.json          # dsh.bundle.patch + dsh.client{platform:"web"}  ← 双半区
├── cordis.patch.yml      # 包内自挂载（install 后自动 insert，零手写 patch）
├── lib/
│   ├── index.js          # 宿主：命令注册 + 路由挂载 + navIcon 自愈（自旧包迁入）
│   ├── core/             # 唯一实现：校验/获取/原子落位/备份/清单/禁用
│   ├── http.js           # /dsh-skills/* 本地路由
│   └── client.js         # 客户端：现有页面 UI + 搜索/启用禁用/删除控件
└── docs/ + README
```

**页面视觉与交互不变**：仍是当前「设置 → 技能」的样子（标题 + 说明 + 卡片 + 徽标 + 展开），只新增四类控件（搜索框、启用/禁用开关、删除按钮、二次确认弹窗）。

---

## 2. 关键调查结论（含证据）

### 2.1 市场页范式（`dshmarket` v1.38.1 实证）

| 维度 | 做法（证据） |
|---|---|
| UI 座位 | 独立 `settings.section`，`id:'market'`、`order:40`，内部自绘 5 个 tab（`dshmarket/src/client/index.ts:105-125`） |
| 传输 | **不用 Typert RPC**：宿主 `ctx.inject(['webServer','loader'])` + `host.webServer.register({kind:'exact',path,handler})`，共 33 条路由；客户端 `fetch(api('/dsh-market/...'))`（`src/routes.ts`） |
| 安全面 | `sameOrigin()` 同源校验 + `readJsonBody` 4 KiB 上限 + `sendJson` + `withMutationLock`（`src/http.ts` 全文 41 行） |
| 禁用落点 | `state.json` 持久化 + `hotUnmount`/`setEntryDisabled` + profile `cordis.patch.yml` 的 `disabled` 行（`routes.ts:392-418`） |
| 卸载落点 | `runPlugin(profile, ['remove', name])` + 清理 patch 行（`routes.ts:2930-3063`） |
| UI 组件 | 复用 primitives（`Button/Pill/Input/Modal/Toast/Menu/DisclosureRow/Tooltip/StateDot`）+ 自有 CSS Module；令牌 `var(--dsw-alias-*, 回退)`；**刻意镜像宿主 PluginCard 排版**（`SettingsCard.tsx:19-33` 注释） |
| 二次确认 | 卸载用 `Modal` 两步确认（`MarketSection.tsx:4309-4322`） |

**Typert Remote 也开放**（备选路径）：`dsh-typert-loader` 已随 `dsh-base` 挂载，导出 `./typert` 的包会被自动注册；客户端可在 `apply()` 里 `ctx.remote.$mount(TYPERT_REMOTE)`（`dsh-api-remotes/lib/client.js:9640-9667`）。**代价**：正规产物由 `@deepseek-ai/dsh-typert-generator` 生成，而生成器**不在安装副本内**，需手写 TYPERT/TYPERT_REMOTE 清单并通过 registry 严格校验 → 列为远期备选。

### 2.2 标准插件交付要求（官方机制）

- **唯一判据**：`package.json` 的 `dsh.bundle.patch`（`dsh/lib/plugin-*.js:25-33`）。声明 → `dsh plugin add` 自动写入 `dsh.profile.bundles` 并挂载；未声明 → 只装成普通依赖 + stderr 警告（**我们当前正是此状态**）。
- **安装通道**：`dsh plugin --profile <name> <pnpm args…>`，纯 pnpm 转发器（支持 `file:`/`link:`/git/tarball，**不要求上架 npm**）；不写 `cordis.patch.yml`。
- **双半区同包**：一个 `dsh` 对象同时写 `bundle` + `client`；客户端半区**无需单独 insert**，由 `dsh-client-modules` 扫描宿主 Loader entries 自动发现并注入 `window.__DSH_BOOT__`。
- **硬约束**：`dsh.client.platform` 必须 `"web"`；必须 `exports["./client"]`；**客户端 bundle 必须预先构建**（缺失会导致整个 web 激活失败）；主入口文件必须真实存在；客户端 bundle 只能 require 基座 9 项（react/react-dom/cordis/client-store/ui-slots/ui-primitives/ui-dockkit 等）或 `dsh.client.external` 中声明的包。
- **✅ 我们已有合规模板**：`dsh-client-ui-settings-skills/lib/client.js` 第 1-9 行逐字就是官方要求的 `window.__ModuleLoader__.load({ id, factory })` 形态 —— 官方构建预设未随 npm 发布这一「最大工程化风险」在我们这里已不存在。
- **⚠️ 包名风险**：bundle 解析**安装副本优先**，若官方将来发布同名 `@deepseek-ai/dsh-skill-manager`，会静默顶掉本地实现 → 必须改名脱离该域。
- **⚠️ 重复 id 风险**：包内 `cordis.patch.yml` 与 profile 手写 insert 同时存在 → 重复 entry id，cordis 拒绝启动 → 迁移顺序必须固化（见 §7）。

### 2.3 禁用机制（源码复核，本文作者亲验）

提供方 `discoverRoot`（`dsh-skill-filesystem/lib/index.js:581-614`）逐字：

```js
const entries = await listSkillRootEntries(root, ctx);          // 只列根的直接子项
for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (root.skipSystem && entry.name === ".system") continue;  // 仅 .system 被特判跳过
    const locator = entry.type === "directory" ? { path: join(entry.path, "SKILL.md"), ... }
        : entry.type === "file" && entry.name.endsWith(".md") ? { path: entry.path, ... }
        : void 0;
    if (locator === void 0) continue;
    const parsed = await parseSkillFile(locator.path, ...);
    if (parsed === void 0) continue;                            // 路径缺失/非法 → 静默跳过
```

**判定表（路径 × 发现 / 监听）**：

| 路径 | 被发现有 | watcher | 依据 |
|---|---|---|---|
| `<root>/<name>/SKILL.md` | ✅ bundle | ✅ 相关（段长 2 + `SKILL.md`） | FS:586-588 / FS:550 |
| `<root>/<name>.md` | ✅ flat | ✅ 相关（段长 1 + `.md`） | FS:589-592 / FS:548 |
| `<root>/.disabled`（目录） | ❌（除非其下直接有 `SKILL.md`） | ⚠️ `addDir`/`unlinkDir` 会造成一次无害失效 | FS:586-588 / FS:547 |
| `<root>/.disabled/SKILL.md` | ⚠️ **会**被当成 bundle | ✅ 相关 | FS:586-588 / FS:550 |
| `<root>/.disabled/<name>/SKILL.md` | ❌ 三段不枚举 | ❌ 三段不匹配且 chokidar depth 1 不上报 | FS:583 / FS:550 / CHH:542-543 |
| `<root>/.manifest.json` | ❌ 非目录非 `.md` | ❌ 不相关 ⇒ **写清单不触发目录重发**（ADR-0003 得证） | FS:589-593 / FS:548 |

**六条关键结论**：

| # | 结论 |
|---|---|
| 1 | **发现只有一层**：`readdir` 单目录列举 + 目录子项只拼其直接 `SKILL.md`；任何三段路径（含 `<root>/.disabled/<name>/SKILL.md`）永不被枚举 |
| 2 | **目录名与 frontmatter `name` 从不比较**（FS:581-595 / REG:259-262）→ 不会有 kebab-case 目录名警告；**但也意味着清单必须同时记 `diskName` 与 `name`，否则可能移错目录** |
| 3 | **watcher 相关性只看路径段数与事件类型**（FS:541-557）：禁用时 `unlinkDir <root>/<name>`（段长 1）相关；启用时 `addDir <root>/<name>` + `add <root>/<name>/SKILL.md` 相关 → 移动即可热生效 |
| 4 | **⚠️ 唯一陷阱**：`<root>/.disabled/SKILL.md` 会被发现成 bundle（且 depth 1 监听范围内）→ 隐藏区内**正下方绝不可放 `SKILL.md`**；放在**根之外**则可彻底规避此陷阱 |
| 5 | **时延与合并**：chokidar `atomic:true` 使 `unlink` 延迟 100 ms，目录 readdir 1 s 节流 → 「即时生效」不成立；**快速禁用→启用（<1 s）可能被合并**，最终态由下一次 `pre-step` 的 snapshot 决定 ⇒ 管理端必须**串行化操作 + 落位后软自检**，文案沿用 A14「下一轮对话起生效」 |
| 6 | **注册表无 enable/disable/remove 语义**（只有 register/list/snapshot/get）⇒ 禁用只能由我们用文件系统原语实现，无法借用宿主 API |

**Windows 与跨卷**（照抄 `@deepseek-ai/dsh-atomic-write` 的既有策略）：

- 目录 rename 可能撞 `EACCES/EBUSY/EPERM`（杀软/编辑器持有句柄）→ 采用 20→200 ms 指数退避 ×8 次重试（AW:16-43）；
- **禁止跨卷**：`EXDEV` 直接拒绝，不静默降级 copy+rm（否则可能留半成品）；隐藏区与技能根必须同卷 → `<dshHome>/.skill-disabled` 满足；
- 测试缝 `DSH_SKILL_MANAGER_SKILLS_ROOT` 覆盖根时，隐藏区应取 `dirname(root)/.skill-disabled` 而非固定 dshHome。

**多根/同名遮蔽**：`~/.agents/skills`（rank 500）等同名技能会遮蔽或并存 ⇒ 禁用后必须**按「根 + 磁盘名」记账**，并复核「可见集合里是否还有该 name、source 是否符合预期」。

**清单增补字段**（在 PRD §5.1 基础上）：`state: "enabled"|"disabled"`、`form: "bundle"|"flat"`、`diskName`、`disabled: { at, zone, from, to, catalogSource, contentHash, phase: "moving"|"committed" }`、`disabledHistory[]`。`phase` 用于崩溃恢复：live 存在且隐藏区无 → 回滚为 enabled；反之 → 完成禁用。

**结论**：禁用 = 移入**同级隐藏区** `<dshHome>/.skill-disabled/<name>/`（bundle）或 `<dshHome>/.skill-disabled/<name>.md`（flat）——零 provider 交互、零陷阱、零 watcher 噪音，且与 M2 既有 `.skill-backups` 设计对称。**注意**：M2 计划的 install 同名冲突检查只扫 live 根，**必须同步扫描隐藏区**，否则会对已禁用技能静默产生第二份副本。

---

## 3. 旧计划逐条 Review

| 旧条款 | 处置 | 说明 |
|---|---|---|
| PRD §1.4「不做 client 半区管理 UI」 | **删除/反转** | 新需求 R1 要求页面 |
| PRD §1.4「不保证项目根写入管理（`--project` P2）」 | 保留 | 与本次需求无关 |
| 评估报告 D1.2「node-only，无 client 半区」 | **被取代** | 新增 ADR-0005 记录反转与理由 |
| PRD §3 P2 列表中的「client UI」 | **提升** | 进入 v2 主干（M4） |
| PRD §8.7「设置页保持只读，职责互补」 | **改写** | 改为：**两个插件合并为一个包**，页面由只读升级为管理页，与 `/skill` 命令共用同一宿主模块（见 §1.2） |
| 现有只读页插件 `@deepseek-ai/dsh-client-ui-settings-skills` | **合并后退役** | 客户端半区与 navIcon 自愈逻辑迁入新包；原包的依赖行、patch 行、快照目录一并移除（迁移步骤见 §7） |
| PRD §1.3 目标 G1~G5 | 保留 + 扩充 | 新增 G6「提供类插件市场的管理页面」、G7「以标准插件形态交付」 |
| FR-01~FR-05、FR-07、FR-09~FR-12（install/list/remove/镜像校验/原子落位/记账/卸载/doctor/adopt/迁移/幂等并发） | **保留** | R2 明确要求 |
| FR-06（update） | **降级为远期** | 用户 2026-09-11：「未来可能需要支持更新，但近期不需要」；清单继续记 source/ref，未来直接生长 |
| FR-08（verify） | **保留本地校验，`--remote` 降级为远期** | 本地 sha256 完整性检查属管理范畴；联网对照上游不是近期需求 |
| FR 表 | **新增 FR-13~FR-17** | 见 §4.3 |
| NFR-01~NFR-10 | 保留 + 新增 | 新增 NFR-11 页面安全面、NFR-12 命令/页面一致性、NFR-13 页面可访问性 |
| 里程碑 M1（已完成）/M2 | 保留 | M2 范围不变（核心命令） |
| 里程碑 M3/M4 | **重排** | 见 §5 |
| ADR-0001（profile 层插件形态） | 部分修订 | 挂载方式从「patch insert」升级为「bundle 自动挂载」（ADR-0001 增补或新 ADR-0006） |
| ADR-0002/0003/0004（统一根/记账/信任边界） | 保留 | 与本次需求一致；ADR-0004 的信任边界需补充「页面动作的确认机制」 |
| M2-PLAN | 主体保留，两点修订 | ①新增 disable/enable 到 core；②挂载与安装脚本改为标准插件通道（M2a） |
| `apply-skill-manager-patch.ps1` | **将被淘汰** | 由 `dsh plugin add` 取代；保留为本地开发兜底 |

---

## 4. 目标架构

### 4.1 交付形态：一个包、两个半区

```
dsh-skill-manager/                        # 单一可交付插件（改名为 dsh-skill-manager，脱离 @deepseek-ai）
├── package.json                          # dsh.bundle + dsh.client（双半区）
├── cordis.patch.yml                      # 包内自挂载（install 后自动 insert 自己）
├── lib/
│   ├── index.js                          # 宿主半区入口（cordis 插件）
│   ├── core/                             # ★ 命令与页面共用的唯一实现
│   │   ├── source.js  fetch.js  validate.js  manifest.js  install.js  scan.js
│   │   └── state.js                      # 新增：disable/enable（.disabled/ 落位）
│   ├── http.js                           # 新增：/dsh-skills/* 路由（sameOrigin + body 上限 + 锁）
│   └── client.js                         # 客户端半区（管理页面，lazy-CJS 工厂包）
├── docs/                                 # PRD / ADR / 评估报告 / M2-PLAN / 本对齐文档
└── README.md (+ README.zh.md)
```

### 4.2 两条入口、一套实现

```
/skill install|list|update|remove|verify|doctor|adopt|disable|enable   ← 命令平面（模型/人）
                    ↘                                    ↙
                      core/*（校验 / 原子落位 / 备份 / 清单 / 锁）
                    ↗                                    ↖
管理页面（设置 → 技能） ── fetch ──> /dsh-skills/list|set-enabled|uninstall|status   ← HTTP（浏览器）
```

- **命令平面**：结果文本渲染在命令面板，不进模型历史（沿用 M1 已验证的形态）。
- **HTTP 平面**：`ctx.inject(['webServer'], …)` 嵌套注入（**保证无 webServer 的 profile 仍能加载命令半区**），路由前缀 `/dsh-skills/`（避免与 `/dsh-market/` 冲突；`webServer.register` 对重复 `(kind,path)` 直接 throw）。
- **一致性保证**：页面动作与 `/skill` 命令走**同一函数**，因而共享校验、备份、清单与并发锁；页面不重复实现任何业务规则。

### 4.3 新增功能需求

| ID | 需求 | 验收标准（摘要） |
|---|---|---|
| FR-13 | 管理页面清单视图（**沿用现有页面设计**） | 在现有「设置 → 技能」页面的视觉与结构上扩展（标题 + 说明 + 卡片列表 + 徽标 + 展开），**新增顶部本地搜索框**；卡片展示名称/描述/形态/来源/状态（已入账、未入账、已禁用）。**注意数据源**：清单不得只用 `remote.skills`——它按调用策略过滤（`user-invocable:false` 与已禁用技能都看不到），故清单以「本地扫描 + 清单」为权威源 |
| FR-14 | 页面启用/禁用控件 | 每张卡片新增「禁用/启用」开关：禁用 = 移入同级隐藏区（文件保留、可逆）；启用 = 移回技能根；**下一轮对话起生效**；操作经锁串行化并做落位后软自检 |
| FR-15 | 页面删除控件 | 每张卡片新增「删除」按钮 + 二次确认弹窗 → 移入备份区（`.skill-backups`）+ 删清单条目；可选「彻底删除」为独立确认项 |
| FR-16 | 命令/页面一致性 | 同一技能经命令或页面操作后，结果状态完全一致（同一 core 实现）；并发操作被同一把锁串行化 |
| FR-17 | 操作反馈 | 每个动作有进行中/成功/失败态与可执行错误文案；失败不改变已装内容；完成后面板刷新 |

### 4.4 新增非功能需求

| ID | 要求 |
|---|---|
| NFR-11 | 页面安全面：全部写操作 `sameOrigin()` 校验 + 请求体 ≤4 KiB + 变更锁；路由路径唯一命名空间 |
| NFR-12 | 双入口一致性：页面与命令不得各自实现业务规则（单一实现原则，评审时检查） |
| NFR-13 | 页面可用性：中英双语（NFR-10 延伸）、键盘可达、深浅色令牌自适应、加载/空/错误三态齐全 |

---

## 5. 里程碑重排

| 里程碑 | 内容 | 退出标准 |
|---|---|---|
| ~~M1~~ | ~~P0 验证~~ | ✅ 已完成（2026-08-26） |
| **M2a 插件标准化** | 改包名、`dsh.bundle.patch`、包内 `cordis.patch.yml`、双半区声明、`dsh plugin add` 安装、清理旧手写 insert | 插件以标准形态安装并可启动；设置 → 插件 → Plugin list 可见；无重复 id 报错 |
| **M2b 核心命令** | source/fetch/validate/manifest/install + `install`/`list`/`remove`（原 M2 范围） | 原 A1-A4、A10、A13 通过 |
| **M3 管理命令** | `disable`/`enable`（`core/state.js`）+ `verify`（本地）+ `doctor` + `adopt` + 存量迁移（`update` 与 `--remote` 已移出近期范围） | 禁用/启用双向用例 + 本地 verify/doctor + 存量技能全部入账 |
| **M4 管理页面** | **沿用现有「设置 → 技能」页面**（同一 `settings.section id=skills, order=16`）→ 新增本地搜索框 + 每卡片的启用/禁用开关与删除按钮 + 二次确认；后端接 `/dsh-skills/*` 路由 | FR-13~FR-17 全部通过；B1-B6 验收 |
| **M5 交付** | 端到端验收、双语文档、PRD v2.0 定稿、发布说明、旧插件退役 | 交付检查清单（§6）全绿；`dsh plugin add` 一键安装在新机器可复现 |

> 说明：**M2a 前置**的理由是——后续所有开发都应在「用户实际安装的最终形态」上验证，避免 M4/M5 阶段返工。

---

## 6. 标准插件交付检查清单

**A. 包结构（必须）**
- [ ] `package.json` 声明 `dsh.bundle.patch`
- [ ] 包根有 `cordis.patch.yml`（`- insert: [{id, name}]` 自挂载）
- [ ] `exports` 暴露 `"./cordis.patch.yml"`，`files` 包含它
- [ ] `main`/`exports["."]` 指向的入口真实存在；`files` 含 `lib`（含 `lib/client.js`）
- [ ] 包名不与 `@deepseek-ai` 官方域冲突

**B. 客户端半区**
- [ ] `dsh.client = { platform: "web", inject: […], external: […] }`
- [ ] `exports["./client"]` 存在，产物为 `window.__ModuleLoader__.load({id, factory})` 形态且**已构建**
- [ ] 仅 require 基座 9 项；其余模块登记 `external` 且有 row 提供
- [ ] UI 注册进 `settings.section`（沿用 `id:'skills'`、`order:16`，图标自愈补丁随新包 node 半区迁移）

**C. 依赖与版本**
- [ ] 安装闭包内的服务 → `peerDependencies`（`^0.1.5-rc.1` / cordis `^4.0.2`）；闭包外依赖 → `dependencies`
- [ ] 可选 peer 加 `peerDependenciesMeta.optional`

**D. 安装与迁移**
- [ ] 迁移顺序：先声明 bundle → `dsh plugin add` → **确认 bundles 已含本包** → 再删除 profile `cordis.patch.yml` 的手写 insert → 重启
- [ ] 验收：`dsh plugin --profile web add <spec>` 后 stderr 无 `declares no dsh.bundle` 警告；`profiles/web/package.json` 的 `dsh.profile.bundles` 自动出现本包
- [ ] 验收：重启后 Settings → Plugins → Plugin list 可见本插件 entry；Settings → 技能 页面可用

---

## 7. 迁移方案（含顺序陷阱）

1. **打包**：改名 `dsh-skill-manager`、加 `dsh.bundle.patch` + 包内 `cordis.patch.yml`、保留现有 `lib/index.js` 入口；
2. **安装**：`dsh plugin --profile web add file:D:/DSH/dsh-skill-manager`（本机直连 GitHub 被重置，git 源安装需代理；本地 `file:` 先跑通）；
3. **核验**：确认 `profiles/web/package.json → dsh.profile.bundles` 已含该包，且 profile node_modules 已 materialize；
4. **⚠️ 清理**：删除 profile `cordis.patch.yml` 第 21-23 行的 `dsh-skill-manager` insert（**不删会重复 entry id，cordis 拒绝启动**）；
5. **重启**：`start-dsh-web.ps1`；验证 Plugin list 出现本插件、`/skill doctor` 正常；
6. **旧页退役（M4 之后）**：新页面接管 `settings.section id=skills` 后，移除 `@deepseek-ai/dsh-client-ui-settings-skills` 依赖 + 其 patch 行 + 其快照目录；`ensureNavIconPatch()` 逻辑迁入新包 node 半区；
7. **回滚路径**：任一步失败 → 恢复 patch 行 + 保留旧依赖（迁移脚本输出回滚命令）。

---

## 8. 待裁决决策（6 项）

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| D1 | **页面传输选型** | A 自注册 HTTP 路由（dshmarket 同构，零代码生成）/ B Typert Remote（类型化，但需手写生成物） | **A**，B 留远期 |
| D2 | **「禁用」语义** | ① 移入**同级隐藏区** `<dshHome>/.skill-disabled/`（零 provider 交互、零陷阱、与 `.skill-backups` 对称）② 移入根内 `<root>/.disabled/`（少一层目录，但须硬守卫 `.disabled/SKILL.md` 陷阱）③ frontmatter 软禁用（`disable-model-invocation`，不改文件位置但**修改用户文件**、只关模型面、`/name` 仍可调用）④ ①+③ 组合：禁用=①，「仅手动」=③ | **①**（③/④ 留 P2） |
| D3 | **包名与分发** | ①改名 `dsh-skill-manager` + GitHub 仓库 + `dsh plugin add`（git 需代理）②保持 `@deepseek-ai/` 域 + 本地 `file:` 安装 ③发布到 npm（当前无令牌，需先登录） | **①**，先 `file:` 本地跑通，再推 GitHub；npm 列远期 |
| D4 | **旧只读页处置** | ✅ **已确定**（用户 2026-09-11）：**沿用并改造现有「设置 → 技能」页面**（同一 slot/设计），旧 `dsh-client-ui-settings-skills` 包在新包接管后退役 | 沿用现有页面 |
| D5 | **页面是否含「安装」入口** | ✅ **已确定：不做**（用户 2026-09-11 澄清：不做互联网检索/市场，页面只管理已安装技能） | 确定不做 |
| D6 | **页面显示范围** | ✅ **已确定**：显示**全部已安装技能**（含未入账、其他根、已禁用、仅模型可调用者）——「查询 dsh 已安装的 Skill」的完整语义 | 全部显示 |

---

## 9. 风险清单

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 重复 entry id 导致启动失败 | **高** | §7 固化迁移顺序；迁移脚本先核验 bundles 再删 patch 行；保留回滚命令 |
| R2 | 包名与官方同名被静默顶掉 | 中 | 改名为 `dsh-skill-manager`（脱离 `@deepseek-ai`） |
| R3 | 客户端半区再次遭遇 dsh 升级契约漂移（本周已发生一次） | **高** | 只用基座三件套（react/jsx-runtime/primitives）+ 自有 HTTP 契约（不依赖 `remote.*` 业务命名空间）；README 维护兼容矩阵；doctor 增「客户端契约自检」 |
| R4 | HTTP 路由与市场/其他插件路径冲突 | 中 | 统一前缀 `/dsh-skills/`；注册失败即报错并提示 |
| R5 | 禁用/卸载与 watcher 竞态、目录重发时序 | 中 | 沿用 G2 时序承诺（下一轮对话生效）；操作后软自检目录可见性 |
| R6 | 页面误操作（卸载/彻底删除） | 中 | Modal 二次确认；默认移备份区；`--purge` 需显式勾选 |
| R7 | 无 webServer 的 profile（headless/tui）加载失败 | 中 | `webServer` 用**嵌套** `ctx.inject`，缺失时命令半区照常工作 |
| R8 | **已禁用技能被 install 装出第二份副本**（M2 同名冲突检查只扫 live 根） | **高** | install / adopt / doctor 一律**同时扫描隐藏区**；同名检查覆盖 live + hidden 两处；页面同时展示两处状态 |
| R9 | 快速「禁用→启用」（<1 s）被 watcher 事件合并，状态不可预期 | 中 | 管理端用同一把锁**串行化**；落位后软自检；文案承诺「下一轮对话起生效」 |
| R10 | Windows 目录 rename 瞬时错误（杀软/编辑器持有句柄）；跨卷 rename 非原子 | 中 | 20→200 ms 指数退避 ×8 重试（照抄 `dsh-atomic-write` 策略）；`EXDEV` **直接拒绝**不静默降级；隐藏区必须与技能根**同卷** |
| R11 | 同名技能来自其他根（`~/.agents/skills` rank 500 亦被扫描）时，「移走一个」≠ 目录中消失 | 中 | 按「根 + `diskName`」记账；禁用后复核可见集合与 `source`；页面标注多根来源 |

---

## 10. 验收矩阵增补（页面类）

| 场景 | 操作 | 预期 |
|---|---|---|
| B1 清单 | 打开 设置 → 技能 | 列出全部技能，含未入账/已禁用/可更新标记 |
| B2 禁用 | 点「禁用」 | 技能即刻移入 `.disabled/`；下一轮对话起模型目录不再含它；页面状态刷新为已禁用 |
| B3 启用 | 点「启用」 | 移回技能根；下一轮对话起重新可见 |
| B4 卸载 | 点「卸载」→ Modal 确认 | 移入备份区；清单条目删除；页面移除该项；备份区可见副本 |
| B5 一致性 | 先 `/skill install X`，再在页面禁用 X | 页面与 `/skill list` 状态一致；并发操作被锁串行化 |
| B6 降级 | webServer 不可用（headless） | 插件仍加载，`/skill` 命令正常；无报错 |

---

## 11. 下一步

1. 你裁决 §8 的 6 项决策（可一次回复：「D1-A、D2-①、D3-①、D4-①、D5-①、D6-②」）；
2. 我据此升 PRD v2.0（改写 §1.3/§1.4/§3/§6/§7/§8.7/§9/§11）+ 新增 ADR-0005（双半区标准插件，取代 D1.2）与 ADR-0006（页面传输选型）；
3. 然后按 M2a → M2b 开工。
