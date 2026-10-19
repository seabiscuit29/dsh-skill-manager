# Windows 全功能测试报告 — dsh-skill-manager v0.1.12 × dsh 0.2.1-rc.2

日期：2026-10-19（Asia/Shanghai），首次验证 2026-10-18
平台：Windows（`D:\` NTFS，大小写不敏感；本机默认无"创建符号链接"权限，需开发者模式/提权）
运行时：dsh **0.2.1-rc.2**（`D:\npm-cache\_npx\50d2c97abf8f4186`），本机 Node v24.19.0；CI 另跑 node 20/22
被测版本：**v0.1.12**（含远端 macOS/APFS 与跨平台大小写修复 + 本轮修复）

## 一、结论

- **功能面：全部通过。** 五套离线测试 **327 项断言全绿**（`npm test`），覆盖命令面 10 个子命令、
  HTTP 面 7 条路由、跨进程锁、客户端 bundle。
- **兼容性：通过。** 预检调用 dsh 自己的 `evaluatePluginCompatibility` 复算：**0.2.1-rc.2 满足 peer 范围**
  （`>=0.1.5-rc.1 <1.0.0-0`）；插件在 0.2.1 下实际加载并服务页面（活体 `/dsh-skills/list` → 200，13 行）。
- **活体：23/23。** 重启后实测通过（2026-10-19 09:43，运行中 dsh 0.2.1-rc.2 + 插件 0.1.12）：
  探针技能 install → 禁用 → 启用 → verify → **purge 删除**全程正常，且跑完在受管根、隐藏区、
  备份区**三处零残留**（`tools/live-check.mjs` 现在用 `purge: true` 并断言备份不残留）。
- **CI：6/6 job 绿**（ubuntu/macos/windows × node 20/22）。

## 二、方法与覆盖面

| 套件 | 断言 | 覆盖 |
|---|---|---|
| `tests/smoke.mjs` | 155–160 | 核心链路：来源解析、校验镜像、清单、adopt/verify、禁用/启用、install/remove、迁移、catalog 可信性、符号链接语义、frontmatter 镜像、图标两代自愈、`~` 展开、运行时自报、迁移判定 |
| `tests/client-bundle.mjs` | 32 | 客户端 bundle 真实执行：注册格式、`module/exports` 前置声明、require 白名单、控件语义、动作可用性 |
| `tests/command-plane.mjs`（新） | 76 | **真实 `/skill` handler**：list / search / disable / enable / remove / adopt / verify / doctor / install / migrate + `--force` / `--dry-run` / `--source`；含引号路径、非 ASCII 路径的运行时分支 |
| `tests/http-routes.mjs`（新） | 50 | **真实 7 条路由**：200/400/403/405、同源校验、4 KiB 上限、坏 JSON、`migratable`/`migrateReason`/`runtime` 契约、disposer |
| `tests/concurrency.mjs`（新） | 14 | **真实子进程**：跨进程锁 fail-fast、陈旧锁自愈、连续子进程与账本一致 |
| `tools/preflight.mjs` | — | 包契约 + 合成树 + 兼容性闸门复算 + 快照一致性 |
| `tools/live-check.mjs`（新） | 23 | 对**运行中的部署**做可逆活体验收 |

> 断言数随"能否创建符号链接"浮动 5 项：受限进程（本机默认）跑 **327**，能创建符号链接的
> 令牌跑 **332**（`macOS: relative symlinks survive a staged install` 那一段会真正执行，且
> 实测在 Windows 上也能通过——`cpSync` 的 `verbatimSymlinks` 行为是跨平台的）。

## 三、Windows 专项结果

| 关注点 | 结果 |
|---|---|
| 同卷 rename（禁用/启用） | ✅ 隐藏区与技能根同卷，`rename` 成功（smoke + command-plane + 活体） |
| 备份先于破坏性操作 | ✅ remove / `--force` 覆盖都留下备份副本（smoke + 活体）；探针走 `purge` 时**不留**备份 |
| CRLF frontmatter | ✅ 安装后 description 完整、校验通过（command-plane） |
| 路径含空格 | ✅ **引号支持**（v0.1.11）：`/skill install "C:\...\incoming dir\pkg"` 成功；不加引号则明确报错、不会误装 |
| 路径含非 ASCII（Node 24） | ✅ 安装成功（本机 Node 24 实测） |
| 路径含非 ASCII（Node 22） | ✅ **拒绝而不崩溃**（见下） |
| 大小写不敏感（`.MD` vs `.md`） | ✅ 按磁盘真实拼写移动/记账（smoke；`this filesystem is case-insensitive`） |
| 符号链接 | ✅ 无权限时相关用例 `skip` 而非崩；活链语义由 smoke 覆盖 |
| 跨进程并发 | ✅ 第二个进程被 fail-fast 拒绝（`another skill operation is in progress`）且磁盘未变；陈旧锁（pid 已死）自动恢复 |
| 4 KiB body 上限 / 同源 | ✅ 超限 400、外来 Origin 403（http-routes + 活体） |
| 中文 JSON / 编码 | ✅ 页面载荷与命令输出中文正常 |
| **非 ASCII 路径（Node 22）** | ⚠️→✅ 上游缺陷：Node **22.23.3** 上 `fs.cpSync` 复制含非 ASCII 字符的路径会**原生 abort**（`0xC0000005`；Node 20/24 正常）。已在 `copyTree` 前置**拒绝**该组合（清晰错误、零写入），命令面测试按运行时分别断言「成功 / 拒绝」 |

## 四、本轮发现并修复的问题

1. **`/skill install` 不支持带空格的路径**（真 bug，Windows 用户目录常见）：`parseArgs` 按空白切分，
   路径被截断后报"无 SKILL.md"。→ 新增 `tokenizeInput()`（支持 `"..."`/`'...'`，反斜杠不作转义），
   USAGE 增加引号提示，测试覆盖"带引号成功 / 不带引号明确失败"。
2. **catalog-only 幻影行**：provider 报告了位于受管根内的条目时，会以"其他根（只读）"出现且无法操作。
   → 受管根内的 catalog-only 条目不再渲染（本根以扫描为准）。
3. **`/migrate` 路由不查 catalog**：bundled 技能不是受管根里的行，导致拒绝原因退化成
   `由 another root 提供`（活体当时 21/22 的那 1 项失败就是它）。→ 路由改用与 `/list` 相同的
   `readCatalog()` 构造行；`unmigratableReason` 缺行时改为"未知来源 unknown root"。
4. **上游 macOS 用例在 Windows 崩套件**：`macOS: relative symlinks survive a staged install` 无保护调用
   `symlinkSync` → EPERM 中断全部断言。→ 先探测能力，不支持则 `skip`（保留 macOS/Linux 覆盖）。
5. **测试基础设施**：新增命令面/HTTP/并发三套测试 + CI 三步 + `npm test` 脚本 + `tools/live-check.mjs`。
6. **CI 上 Windows/node22 的 `exit 127`**（查日志 → 本机用 Node 22 复现 → 二分定位）：
   `install variants` 段用带中文的父目录做 fixture，而 Node **22.23.3** 在 Windows 上对含非 ASCII
   字符的路径做**最普通的 `cpSync`** 就会原生 abort（`0xC0000005`；Node 20/24 均正常）。这不是本插件
   的代码缺陷，但会把 dsh 宿主一起带走。→ `lib/core/fsutil.js` 的 `copyTree` 在复制前判定
   「win32 + Node 22 + 任一路径含非 ASCII」并**拒绝**（给出原因、不写盘）；命令面测试在 Node 24 上
   断言成功、在 Node 22 上断言「拒绝且未落盘」。README「已知限制」与 PRD R13 同步记录。
7. **活体探针会留下备份**（工具自身瑕疵）：`live-check` 的 remove 默认保留备份，每跑一次就往
   `.skill-backups` 堆一个探针副本。→ 改为 `purge: true` 并新增断言「purged probe leaves no
   backup behind」；历史遗留的 3 个探针备份已核对账本无引用后清除。

## 五、验证矩阵（最终）

| 项 | 命令 | 结果 |
|---|---|---|
| 离线全套 | `npm test` | **327 / 327**（160 + 32 + 76 + 50 + 14；符号链接可用时 332） |
| Node 22 专项 | `npx node@22 tests/command-plane.mjs` | **76 / 76**（走"拒绝"分支，进程存活） |
| 预检 | `node tools/preflight.mjs` | **PASS 0 error**；闸门按 dsh 自己的实现复算；快照 = 源码（21 文件） |
| 活体 | `node tools/live-check.mjs` | **23 / 23**，三处零残留 |
| CI | GitHub Actions | **6 / 6 job success**（ubuntu/macos/windows × node 20/22） |

## 六、过程教训（记录以免重犯）

- **不要用 PowerShell 的 `Set-Content` 改写源码**：PS 5.1 把无 BOM 的 UTF-8 当 ANSI 读，
  回写会把中文写成乱码（本轮 `lib/http.js` 中招，已 `git checkout` 恢复并复检；
  工作区 `AGENTS.md` 第 2/4 条早已禁止此做法）。反向测试应改用编辑器或 `git stash`/`git checkout`。
- **`node -e` 内联脚本在 PS 5.1 会被吞引号**：同样禁止，JS 一律写临时文件或用编辑器改。
- **断言要盯住"来源"而不是"名字"**：`/bundled/` 会命中技能名 `bundled-demo`，从而掩盖
  "来源退化成 another root" 的真实缺陷；已改为断言 `由 bundled 提供`。
- **"静默 abort"要用同步探针取证**：`console.log` 在 abort 的进程里会丢缓冲，
  `fs.writeSync(1, …)` 才能留下崩溃前最后一行——这是定位 CI `exit 127` 的关键工具。
