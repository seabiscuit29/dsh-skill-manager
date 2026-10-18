# dsh-skill-manager

DSH 已安装技能的管理器：**查询（含本地搜索）、启用/禁用、卸载**。
安装与升级仍走 `/skill install` 命令；本插件的页面**不做互联网检索、不做市场、不做在线安装**。

A local manager for skills already installed in a DeepSeek Harness deployment:
list & search, enable/disable and remove — from the `/skill` command group and
from **设置 → 技能**. It deliberately does not search the internet for skills.

## 功能 / What it does

| 能力 | 命令 | 页面 |
|---|---|---|
| 清单 + 本地搜索 | `/skill list` · `/skill search <text>` | 顶部搜索框（按名称/描述过滤） |
| 禁用 / 启用 | `/skill disable <name>` · `/skill enable <name>` | 每张卡片的「已启用/已禁用 + 动作按钮」 |
| 卸载（保留备份） | `/skill remove <name> [--purge]` | 卡片上的「删除」+ 二次确认 |
| 收编未入账技能 | `/skill adopt <name> [--source <spec>]` | 未入账卡片的「收编」 |
| 迁移其他根的技能 | `/skill migrate [<name>] [--dry-run]` | 其他根只读卡片的「迁移」（迁入受管根后即可禁用/卸载） |
| 本地完整性校验 | `/skill verify [<name>]` | — |
| 诊断 | `/skill doctor` | —（技能根/隐藏区/清单/未入账/缺失/其他根 + **接线状态** + **客户端契约自检**） |
| 安装（命令侧） | `/skill install <spec> [--force]` | 页面**不提供**安装入口 |
| 更新 | 暂不支持（近期范围外） | — |

## 它长什么样 / What the page looks like

![设置 → 技能：同一技能的启用/禁用两态对照、列表其余状态、控件注解与徽标图例](docs/images/skills-page.png)

页面沿用 DSH 设置面板的「技能」席位。三条交互规则：

- **状态用文字描述**：绿点＝已启用、灰点＝已禁用——它只说明"现在是什么状态"，不是控件；
- **按钮描述动作**：已启用→「禁用」，已禁用→「启用」；另有「删除」（内联二次确认）、「收编」（未入账行）、「迁移」（其他根只读行）；
- **禁用是可逆的**：文件不改写，只做一次同卷改名，路径可在展开详情里看到。

> 图中虚线圆圈编号为**文档注解**，不是界面元素；图片由 `tools/render-ui-mock.ps1` 用插件的真实样式表生成，
> 可随 UI 改动一键重出（见 [开发](#开发--development)）。示例数据全部为虚构 `demo-*`。

## 架构一览 / How it fits together

```mermaid
flowchart TB
  subgraph ENTRIES["两个入口，共用同一套实现"]
    direction LR
    CMD["/skill 命令<br/>list · search · disable · enable · remove<br/>adopt · migrate · verify · doctor · install"]
    PAGE["设置 → 技能 页面<br/>搜索 · 状态/动作按钮 · 删除 · 收编 · 迁移"]
  end
  CORE["lib/core/*<br/>镜像校验 · 原子落位 · 备份 · 清单 · 单机锁"]
  subgraph HOME["~/.dsh"]
    ROOT["skills/<br/>受管技能根"]
    ZONE[".skill-disabled/<br/>禁用区 · 同卷 rename"]
    BAK[".skill-backups/<br/>卸载备份"]
    MAN[".manifest.json<br/>source · ref · sha256 · state"]
  end
  CATALOG["模型技能目录"]
  CMD --> CORE
  PAGE -- "HTTP /dsh-skills/*<br/>同源 + 4 KiB + 锁" --> CORE
  CORE --> ROOT
  CORE -- "disable" --> ZONE
  CORE -- "remove" --> BAK
  CORE -. "记账" .-> MAN
  ROOT -- "watcher 热更新<br/>下一轮对话生效" --> CATALOG
```

命令平面与页面**调用同一批 `lib/core/*` 函数**，因此两个入口不可能出现状态分歧；页面走的是本插件自注册在
宿主 webServer 上的 `/dsh-skills/*` 本地路由（同源校验 + 4 KiB 请求体上限 + 与命令共用的一把锁）。

## 安装 / Install

插件自带 `dsh.bundle.patch`，走官方通道即可自动挂载（无需手写 profile patch）：

```bash
# Windows
dsh plugin --profile web add file:D:/DSH/dsh-skill-manager

# macOS / Linux
dsh plugin --profile web add file:$HOME/dev/dsh-skill-manager

# 或从 git（两种系统都一样）
dsh plugin --profile web add git+https://github.com/<owner>/dsh-skill-manager.git
```

安装后 `dsh.profile.bundles` 会自动包含本包；**重启一次 `dsh web`** 生效。
若 profile 的 `cordis.patch.yml` 里存在同 id（`dsh-skill-manager`）的手写 insert，
必须先删除，否则重复 entry id 会导致 cordis 拒绝启动。

> ⚠️ **务必用 `file:` 或 `git+https://` 这两个 spec 安装，不要写裸包名。**
> npm 上 `dsh-skill-manager` 这个名字属于**第三方**（maintainer `gohana`，2026-08-13 起，v0.1.0–0.1.3），
> 裸名 `dsh plugin --profile web add dsh-skill-manager` 会装到别人的包。
> 如果本插件将来要发布到 npm，需要一个**未被占用的名字**（例如带 scope 的 `@<你的账号>/dsh-skill-manager`）。

## macOS / Linux

核心与平台无关（纯 Node ESM、零运行时依赖），工具链两套等价实现，CI 在
`ubuntu-latest` / `macos-latest` / `windows-latest` 上跑**同一批测试**：

| 用途 | macOS / Linux | Windows |
|---|---|---|
| 换装（备份→卸旧→清 patch→装新→预检） | `bash tools/swap-profile.sh`（先加 `--dry-run`） | `powershell -ExecutionPolicy Bypass -File tools\swap-profile.ps1` |
| 改代码后重快照 | `bash tools/resync-profile.sh` | `powershell -ExecutionPolicy Bypass -File tools\resync-profile.ps1` |
| 重出 README 设计图 | `bash tools/render-ui-mock.sh` | `powershell -ExecutionPolicy Bypass -File tools\render-ui-mock.ps1` |
| 重启 dsh web | 在其终端 `Ctrl+C` 后重新启动 | 同左（`start-dsh-web.ps1` 只是 Windows 便捷脚本） |

路径对照：受管根 `~/.dsh/skills`、禁用区 `~/.dsh/.skill-disabled`、备份区 `~/.dsh/.skill-backups`、
其他根 `~/.agents/skills`（可用 `/skill migrate` 迁入）；staging 走 `os.tmpdir()`（macOS 上即 `$TMPDIR`）。
前置条件：Node ≥ 20、`git`（安装/迁移用）；`pnpm` 由 `dsh plugin` 转发调用。

**macOS / Linux 上的符号链接**：提供方**跟随**符号链接——它按 `stat` 语义给孩子分类
（`dsh-skill-filesystem` 的 `nodeEntryKind` 对链接取 `stat`），所以
「把开发仓库 symlink 进 `~/.dsh/skills`」是**有效**的，链接会被正常发布。
唯一不会被发布的是**断链**（目标不存在，或目标不是技能）：列表里标为**符号链接（断链）**、
`doctor` 单列出来，因为那时提供方看到的是 `other` 类型。
链接本身也计入账本（记为 `symlink:<target>`），所以删掉或改指一个链接，`verify` 会报告出来；
禁用/卸载移动的是链接，不是它的目标。

## 禁用是怎么实现的 / How disabling works

技能提供方只发现技能根的**直接子项**。禁用即把技能从
`~/.dsh/skills/<name>/` 移到**同级隐藏区** `~/.dsh/.skill-disabled/<name>/`
（与 `.skill-backups` 对称、同卷原子 rename）：目录里立刻不再出现该技能，
文件原样保留，启用就是移回来。任何内容都不会被改写，因此禁用后的文件与安装时逐字节一致。

watcher 是异步的（chokidar `atomic` 延迟 100 ms、目录 readdir 1 s 节流），
所以两个入口都承诺「**下一轮对话起生效**」，不会假装即时生效。

```mermaid
stateDiagram-v2
  [*] --> enabled: install / adopt / migrate
  enabled --> disabled: disable（移入隐藏区）
  disabled --> enabled: enable（移回技能根）
  enabled --> removed: remove（移入备份区）
  disabled --> removed: remove
  removed --> enabled: 手工恢复（备份 rename 回根 + adopt）
  note right of disabled
    文件不改写、可一键启用
  end note
```

## 数据来源 / Where the data comes from

- `~/.dsh/skills/.manifest.json` —— 账本：来源、commit、逐文件 sha256、启用状态。
  它是 `<root>/<name>/SKILL.md` 与 `<name>.md` 之外的第三种形态，提供方看不见它，
  写账本也不会触发目录重发。
- `~/.dsh/skills` —— 实际文件（权威）。
- `ctx.skills` —— 仅作为「模型目录是否可见」的旁证。

页面**不**使用 `remote.skills` 作为清单权威源：那条 RPC 按调用策略过滤，看不到已禁用、
仅模型可调用或未入账的技能——而这些正是管理器要管理的行。它只用来补齐**其他根**的技能
（如 `~/.agents/skills`），这些行标记「其他根」并保持**只读**，以保持与模型所见一致的查看体验。

换装步骤与验收清单见 [`docs/INSTALL-MIGRATION.md`](docs/INSTALL-MIGRATION.md)。
开发与交付的完整检测流程（三个真实事故复盘 + 七阶段可勾选清单 + 症状对照表）见工作区指引
**`D:\DSH\PLUGIN-DEV-CHECKLIST.md`**；本仓库的 `tests/` 与 `tools/` 就是该指引的参考实现。

## 结构 / Layout

```
dsh-skill-manager/
├── package.json          dsh.bundle.patch + dsh.client{platform:"web"}（双半区）
├── cordis.patch.yml      包内自挂载
├── lib/
│   ├── index.js          宿主：/skill 命令组 + 路由挂载 + 接线记录 + 图标自愈
│   ├── http.js           /dsh-skills/* 本地路由（同源校验 + 4 KiB body 上限）
│   ├── navicon.js        设置页「技能」图标自愈补丁
│   ├── selfcheck.js      客户端契约自检（doctor 消费）
│   ├── client.js         浏览器半区：设置 → 技能 页面
│   └── core/             唯一实现（命令与页面共用）
│       ├── paths.js  fsutil.js  lock.js  manifest.js
│       ├── source.js  validate.js  scan.js
│       ├── install.js    安装 / 卸载 / 校验
│       ├── migrate.js    其他根 → 受管根的迁移
│       └── state.js      启用 / 禁用 / 收编
├── tests/
│   ├── smoke.mjs         离线冒烟（临时技能根，不碰真实部署）
│   └── client-bundle.mjs 客户端 bundle 真实执行测试（含控件语义回归）
├── tools/
│   ├── preflight.mjs     重启前预检：重复 id / 入口可解析 / 入口存在 / BOM / 客户端契约 / 快照新鲜度
│   ├── profile-patch-clean.mjs 清理 profile 里指向已退役插件的 insert（两套安装脚本共用）
│   ├── ui-mock/          README 设计图的标记与样式抽取（mock.html + extract-css.mjs）
│   ├── render-ui-mock.ps1 / .sh   用真实样式表重出 docs/images/skills-page.png
│   ├── resync-profile.ps1 / .sh   改代码后重快照（remove + add + 预检）
│   └── swap-profile.ps1 / .sh     一键换装（备份→卸旧→清 patch→装新→预检），支持 dry run
├── .github/workflows/ci.yml  ubuntu / macos / windows × node 20/22 跑同一批测试
└── docs/                 PRD、评估报告、对齐方案、ADR、术语表、换装文档、设计图
```

## 开发 / Development

```bash
# 语法检查（macOS/Linux 与 Windows 通用，CI 亦如此）
find lib tests tools -type f \( -name '*.js' -o -name '*.mjs' \) -exec node --check {} \;

# 五套离线测试；`npm test` 一次跑完（共 327 项断言，CI 在三个 OS × node 20/22 上跑）
npm test
node tests/smoke.mjs               # 核心链路冒烟（155 项）
node tests/client-bundle.mjs       # 客户端 bundle 真实执行（32 项，含控件语义与动作可用性）
node tests/command-plane.mjs       # 命令面：真实 /skill handler 跑全部子命令与旗标（76 项）
node tests/http-routes.mjs         # HTTP 面：7 条路由 + 同源/方法/4 KiB 上限/错误映射（50 项）
node tests/concurrency.mjs         # 跨进程锁与陈旧锁恢复（14 项）

# 部署后验收（重启 dsh web 之后）：对运行中的实例做一次可逆的活体检查
node tools/live-check.mjs                              # 默认 http://127.0.0.1:3080
node tools/live-check.mjs --url http://127.0.0.1:3099  # 指到别的实例

# 改过代码 → 重快照进 profile（会自动跑预检）
bash tools/resync-profile.sh                       # macOS / Linux
powershell -File tools\resync-profile.ps1          # Windows

# UI 有改动 → 重出 README 里的设计图（用真实样式表渲染）
bash tools/render-ui-mock.sh                       # macOS / Linux
powershell -File tools\render-ui-mock.ps1          # Windows
```

离线测试通过环境变量把整套路径指向临时目录，因此**永远不会**动到真实技能根：
`DSH_SKILL_MANAGER_SKILLS_ROOT`、`DSH_SKILL_MANAGER_MANIFEST_FILE`、
`DSH_SKILL_MANAGER_HIDDEN_DIR`、`DSH_SKILL_MANAGER_BACKUPS_DIR`、
`DSH_SKILL_MANAGER_STAGING_DIR`、`DSH_SKILL_MANAGER_FOREIGN_ROOTS`。

`tools/live-check.mjs` 是个例外，它有意打真实部署：只创建一个 `zz-live-check-*` 探针技能
（install → 禁用/启用 → verify → remove），其余行只读，`finally` 里兜底清理。

改完代码后重新快照到 profile 再重启（`pnpm` 对 `file:` 依赖只看路径，必须重装）：

```powershell
dsh plugin --profile web add file:D:/DSH/dsh-skill-manager   # 版本号变更后才会重快照
```

## 兼容性 / Compatibility

- 已验证版本线：dsh **0.1.5-rc.1** 与 **0.2.0-rc.2**；`peerDependencies` 声明为
  `>=0.1.5-rc.1 <1.0.0-0`（整个 0.x 线）。**为什么不收紧上界**：闸门不满足时会**静默整包跳过**，
  而 dsh 走 rc 通道、minor 发布频繁——收紧到某个 minor 等于每次升级都让插件凭空消失一次。
  放宽的代价用**运行时自报**补上：`/skill doctor` 与 `/skill list`（以及页面）会打印
  `dsh runtime: <版本> — verified | UNVERIFIED`；未验证版本线上列表顶部直接出现告警行。
  可验证范围按 **minor 线**判定：`0.2.5` 与已验证的 `0.2.0-rc.2` 同线 → verified；
  `0.3.0-rc.1` → UNVERIFIED（加载但明说没验证过）；`1.0.0` 起需重新验证。
- **dsh 0.2.0 起有一道兼容性闸门**：profile 里每个 bundle 的 `@deepseek-ai/dsh*`
  peer 范围必须满足运行时版本，`peerDependenciesMeta.optional` **不豁免**；不满足时
  整个 bundle 被静默跳过——插件不挂载，且它自己的 `doctor` 永远不会运行到。范围写窄
  （例如钉死某个 rc）就会触发。`tools/preflight.mjs` 现在会调用 dsh 自己的实现复算
  这条闸门，重启前就能拦下。
- **闸门必须对着「正在运行的那个 dsh」复算**（0.1.9 修）：`~/.dsh/profiles/node_modules`
  是 0.2 之前的共享安装，里面每个包都是指向某个旧 npx 缓存的**符号链接**，因此它会一直
  解析成功，把真正的运行时挡住——在 macOS 桌面包上，preflight 曾拿缓存的 `0.1.0-rc.7`
  去算闸门，于是对健康的 0.2.0-rc.2 部署报 `SKIPS this bundle`。现在候选会全部收集后
  取**最好**的一个（真实安装优先于共享安装，再看版本高低、是否带 `dsh-app-boot`），并且
  能读**打进 `app.asar` 的**运行时；`--dsh-root` / `$DSH_INSTALL_ROOT` 仍可强制指定。
- **运行时自报同理**：`/skill doctor` 之前会报缓存里的 `0.1.0-rc.7`，而进程实际跑的是
  `0.2.0-rc.2`。现在会读 `app.asar` 里的真身，也支持 pnpm 的嵌套 store 布局
  （`node_modules/<版本>/node_modules/…`）；`DSH_RUNTIME_VERSION` 可整体覆盖。
- 客户端半区只 require 基座模块（`react`、`react/jsx-runtime`，可选
  `@deepseek-ai/dsh-client-ui-primitives`），不依赖任何业务命名空间——把
  dsh 升级导致的客户端契约漂移风险压到最低（0.1.5 升级曾使旧页面的
  `connection.api.*` 访问器失效）。
- 宿主半区不 import 任何 `@deepseek-ai` 包，只使用 `ctx.commands` / `ctx.skills` /
  可选 `ctx.webServer`。`webServer` 用嵌套注入，因此 `headless` / `tui` profile
  下插件仍可加载，只是没有页面路由。
- 图标类自带降级：`lib/navicon.js` 与页面 chevron 都只把图标当装饰，名字对不上时
  退回文字字形/默认齿轮，不影响功能。

## 已知限制 / Known limits

- 只管理用户根 `~/.dsh/skills`（rank 400）；项目根与 `~/.agents/skills` 的技能不在
  管理范围（后者计划迁移，见 `docs/M2-PLAN.md`）。
- 更新（`/skill update`）与 `verify --remote` 属远期；账本已记录 source/ref 以便将来生长。
- 跨卷移动被拒绝（隐藏区与技能根必须同卷），以免留下半成品。
- **跨卷安装（staging → 技能根）**：staging 在 `os.tmpdir()`，macOS 上可能位于与 `$HOME`
  不同的卷。那里不能用「拒绝」了事，所以退化为 copy：先复制到目标**同级**的隐藏名
  （`.incoming-<pid>-<时间戳>`，提供方看不见），再同卷 rename 就位，失败则清掉副本。
  这样不会把半个技能留在受管根里，也不会覆盖掉活着的旧版本。
- **Node 22 + Windows + 非 ASCII 路径**：上游 `fs.cpSync` 在该组合下**原生 abort 进程**
  （`0xC0000005`，Node 20/24 正常）。安装/覆盖/迁移都要复制文件树，因此本插件会在复制前
  **拒绝**这对路径并给出原因，而不是让 dsh 宿主任由它崩掉。用 Node 20/24，或让技能路径保持
  ASCII。`tests/command-plane.mjs` 在两种运行时下分别断言「成功」与「拒绝且不写盘」。

## macOS 兼容性修正 / macOS fixes

本插件的核心是平台无关的纯 Node ESM，但下面这些点是**在 macOS 上真会出错**的，已修并加了回归测试
（`tests/smoke.mjs` 的 "macOS:" 分组）：

| 症状 | 原因 | 修法 |
|---|---|---|
| 安装后技能里的**相对符号链接变成指向 `/var/folders/...` 的绝对链接**，随即全部断链 | `cpSync` 默认会重写相对链接为绝对路径，而 staging 目录马上被删 | `copyTree` 传 `verbatimSymlinks: true`（并保留时间戳） |
| 删掉技能里的符号链接，`verify` 仍报 clean | 符号链接既非 file 也非 directory，哈希时被**静默丢弃** | 记为 `symlink:<target>`；目录链接不再跟随（也顺带免了走出技能树的遍历） |
| Finder 锁定的文件 / `chmod 500` 目录让删除和清理抛 `ENOTEMPTY`，且 `force: true` 压不住 | 瞬时错误集只有 Windows 的 `EACCES`/`EBUSY`/`EPERM` | 加入 `ENOTEMPTY`/`ENOTSUP`，`removePath` 用 `maxRetries`/`retryDelay` |
| `.MD` 文件被记录成 `.md`，禁用时移动的文件名与账本对不上 | APFS 大小写不敏感但不保留大小写，代码却把小写名**重新拼**出来 | 名字一律取自磁盘上的真实条目（`basename` + 大小写不敏感匹配） |
| 账本里 `Alpha`，查 `alpha` 说「未入账」 | JSON 对象键是精确匹配，文件系统不是 | 账本查找大小写不敏感 |
| 崩过一次后所有操作报「another skill operation is in progress」 | macOS 快速复用 pid，`kill(pid, 0)` 分不清原主与接任者 | 锁记录进程**启动时间**并在不匹配时视为过期（`ps` 不可用时退化为只看存活） |
| 同一秒内两次删除卸载，前一个备份消失 | 时间戳只有秒级精度，POSIX rename 能覆盖**空目录** | 备份名探测冲突并加后缀 |
| 页面能打开但每个按钮都 403 `untrusted origin` | `Origin` 与 `Host` 逐字节比较，`localhost` / `127.0.0.1` / `[::1]` 混用即失配 | 归一化 loopback、IPv6 与大小写后再比较 |

CI 在 `ubuntu-latest` / `macos-latest` / `windows-latest` 上跑同一批测试；上面这一组是**平台相关**的，
在 Linux 上大部分会静默通过，所以它们单独成组、按症状命名，便于回看。
