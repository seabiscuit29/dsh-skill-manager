# M2 详细实施计划：核心安装链路（manifest / fetch / validate / install + install / list / remove）

| 项 | 内容 |
|---|---|
| 关联文档 | [PRD.md](PRD.md)（v1.1，§3 P0 范围 / §8 设计 / §9 验收）、[CONTEXT.md](../CONTEXT.md)、ADR-0001/0003/0004 |
| 基线 | M1 已完成：inject commands+skills ✓、slash 派发 ✓、/skill doctor·list 最小版在线 |
| 退出标准 | PRD §9 的 **A1、A2、A3、A4、A10、A13**（M2 里程碑退出标准）+ A11 降级不回归 |

---

## 1. 范围（做什么、不做什么）

**做**：`lib/` 下新增 5 个纯模块（source / fetch / validate / manifest / install）、`scan` 从 index.js 抽出、`/skill install` `/skill remove` 完整实现、`/skill list` 升级为「清单 + 磁盘 + 目录」对照视图。

**不做（留给 M3）**：`update` / `verify` / `adopt` / 迁移、`--remote`、`--all` 的 update 语义、存量 7 技能迁移。

**不做（P2/非目标）**：`--project`、zip/HTTP 源、确认机制、多机同步、client UI。

---

## 2. 模块设计（接口 + 要点）

### 2.1 `lib/source.js` —— 来源描述解析（约 80 行）

```js
parseSourceSpec(spec) → { ok:true, spec:{ kind:'github'|'git-url'|'local', url?, ref?, path?, raw } }
                      | { ok:false, error: '…' }
```

| 输入形态 | 解析规则 |
|---|---|
| `github:<owner>/<repo>#<ref>[/path…]` | ref 缺省 `main`；path 为空 = 仓库根为技能 |
| `<git-url>#<ref>[/path…]`（https/ssh/git@） | fragment 仅本插件解析，**clone 前剥离**；ref 缺省 `main` |
| `<local-path>`（盘符 / `./` `../` / `~/` / 相对路径） | `existsSync` 校验；直接拷贝 |

- 错误：空 spec、语法无法识别、本地路径不存在 → `ok:false` 带可执行文案；
- `#` 切分只取第一个；`/` 路径部分其余照抄。

### 2.2 `lib/fetch.js` —— 获取（约 90 行）

```js
fetchSkillSource(spec, { tmpDir }) → { ok:true, stagingDir, commitSha?, cloneTemp? }
                                  | { ok:false, error }
```

- **git 源**：`git clone --depth 1 --branch <ref> <url> <tmpDir>/src-<rand>`；spawn `execFileSync` 封装；
  - env 注入 `GIT_TERMINAL_PROMPT=0`（NFR-06 防凭证交互挂起）；`timeout: 60_000`（NFR-07）；
  - 失败按 stderr 关键字区分：`403/404`（上游不存在）、`Authentication`（凭证）、`not found`/`Remote branch`（ref 不存在）→ 分别给指引文案；
  - commit：`git -C <dir> rev-parse HEAD` → `commitSha`（前 12 位 + 完整值存清单，展示用短值）；
  - `spec.path` 存在 → `stagingDir = <clone>/<path>`，并校验目录存在（不存在 → 明确报错「库内路径不存在」）；
- **本地源**：`fs.cpSync(src, tmpDir/stage-<rand>, { recursive: true })`；无 commitSha；
- 谁创建谁清理：所有 staging 均在 `os.tmpdir()/dsh-sm-<rand>/` 下，失败路径由 install 层 rm 清理。

### 2.3 `lib/validate.js` —— 镜像校验（约 120 行，规则与 §8.4 逐条对齐）

```js
validateSkill(stagingDir) → { ok:true, name, form:'bundle'|'flat', description, whenToUse? }
                          | { ok:false, errors:[{ rule, message }] }
```

- **形态判定**：`isDirectory(stagingDir)` 且含 `SKILL.md` → bundle；`isFile` 且 `.md` → flat；否则 error（rule 7 不递归枚举嵌套）；
- **frontmatter 最小解析**：`^---\n ... \n---` 块（其余正文忽略）；仅解析本插件关心的标量键：`name`、`description`、`whenToUse`、`disable-model-invocation`、`user-invocable`、`metadata`（存在性）；引号剥离、YAML 布尔字面量（`true/false/yes/no/on/off/1/0` 大小写不敏感）；
- **规则执行表**（全部命中任一即拒绝）：

| rule | 检查 | 错误文案要点 |
|---|---|---|
| 1 | `name` 匹配 kebab-case 文法（等价于 `@deepseek-ai/dsh-skill` 的 `isSkillName`：`^[a-z0-9]+(-[a-z0-9]+)*$`，实现后补一条对标测试验证等价） | 合法文法示例 + 当前值 |
| 2 | `description` 存在且 trim 非空 | — |
| 3 | 出现驼峰调用键（`disableModelInvocation` / `modelInvocable` / `userInvocable`） | 提示 canonical `disable-model-invocation` / `user-invocable` |
| 4 | 两个调用键的值非合法布尔 | 列出合法值集合 |
| 5 | bundle 时 `name` 与目录名不一致 | 允许，落位目录名 = frontmatter name（仅记录到输出） |
| 6 | flat 单文件 | 保留 `<name>.md` 形态落位（不包目录） |
| — | `whenToUse` / `metadata` 类型错误 | **不校验**（提供方仅省略，README 明示），跳过 |
| — | 文件编码非 UTF-8 | error「文件不是合法 UTF-8」 |

### 2.4 `lib/manifest.js` —— 清单（约 100 行）

```js
loadManifest(file) → { version:1, skills:{} }            // 文件不存在 → 空；JSON 损坏 → 抛错
saveManifest(file, manifest)                              // 原子：tmp + rename
hashFiles(root, { base }) → { 'rel/path': sha256 }        // 相对路径为键；排除 .git 与常见废物（.DS_Store）
manifestPath() → join(dshHome(), 'skills', '.manifest.json')
```

- 清单结构按 PRD §5.1（`root:"user"` 恒值、`files` sha256 映射、`installedAt/updatedAt` ISO）；
- 保存策略：**锁内 load → 修改 → save**（见 2.5 锁），写入前不重读校验 version（单机锁保证串行；多机留 P2）；
- `hashFiles`：递归小文件（限制单文件 > 8MB 跳过并记录，防误挂大文件；技能包实际很小）。

### 2.5 `lib/install.js` —— 安装/卸载与锁（约 180 行）

```js
installSkill(spec, { root, manifestFile, force }) → { ok, type:'installed'|'skipped', name, form, commitSha?, message }
removeSkill(name, { root, manifestFile, force, purge }) → { ok, message, backupPath? }
withSkillLock(fn)   // 锁：os.tmpdir()/dsh-skill-manager.lock（{pid,ts}）
```

**安装流水线**（对应 PRD §4.1）：

```
1 withSkillLock（失败 → 「另一技能安装正在进行中，请稍后重试」）
2 fetch → staging（失败 → 清理 → error）
3 validate（失败 → 清理 staging → error（含违规明细））
4 同名冲突检查（磁盘扫 root）：
   ── 存在 bundle/<name>/ 或 flat/<name>.md：
      ├─ 清单命中且同 source+同 ref 且文件 hash 与清单一致 → SKIP（幂等，FR-12）
      ├─ 非 force → error：展示既有 source/ref（未入账显示 untracked）
      └─ force → 旧版 rename → <dshHome>/.skill-backups/<name>-<ts>/
5 落位：staging → root/<name>      （flat → root/<name>.md）
   EXDEV（跨盘）→ 降级 fs.cpSync + rm staging
6 写清单：{ source: spec.raw, ref: commitSha ?? null, root:'user', files: hashFiles(...), installedAt, updatedAt }
7 释放锁 → 输出「已安装 <name> @ <sha12>，将于下一轮对话起生效」（G2 时序承诺文案）
```

**卸载流水线**（PRD §4.3）：清单存在 → rename 到备份区 + 删条目；未入账 → 需 `--force`；`--purge` 连备份一起删；缺失时提示 adopt/手工恢复路径（G3 文案）。

**并发**：锁内容 `{pid, ts}`；pid 存活且 ts 距今 < 10 分钟 → busy；pid 不存在或 ts 过期 → 抢占（stale 检测，10 分钟阈值）。

### 2.6 `lib/scan.js` —— 扫描与视图（约 70 行）

```js
scanSkillRoot(root) → { bundles:[], flat:[] }           // 从 index.js 抽出（M1 逻辑搬迁）
buildListView({ manifest, scan, catalogNames? }) → rows[]
```

- `list` 视图行：`<name> | 状态(已入账/未入账) | 形态(bundle/flat) | 来源/ref | 目录可见性`；
- 目录可见性：`ctx.skills.list()` 可用时加入（失败静默置 `n/a`，A11 降级不报错）；
- 超长 description 标注截断（N3 评审发现）：manifest 无 description（清单不含），list 仅对磁盘 SKILL.md 读取 description 做长度 > 500 标注（可选实现，标注 `(truncated)`）。

### 2.7 `lib/index.js` —— 接线（改动）

- 子命令分发（install / list / remove / doctor 实装；update / verify / adopt → 里程碑占位文案）；
- 参数解析：`rawInput.trim()` 分词；旗标 `--force` `--purge` `--all`；`#` 不拆（source spec 内嵌）；
- 命令处理器统一 `try/catch` → `{kind:'error', text}`；成功 → `{kind:'success', text}`；`recordInput:true`（沿用 M1）；
- 超时包裹：`Promise.race(60s)`（NFR-07）；
- 目录可见性**软自检**（G2）：install 成功后 fire-and-forget 一次 `ctx.skills.list()`，若返回可见集合缺失该 name → 在成功文案追加提示行「如目录未显示，请等待下一轮对话（watcher 异步）」；**不阻塞、不回滚**；
- 文案：中英双语并行输出（延续 M1 风格，NFR-10）。

---

## 3. 测试缝（新增，仅测试/调试）

- env `DSH_SKILL_MANAGER_SKILLS_ROOT`：覆盖技能根（默认 `~/.dsh/skills`）；
- env `DSH_SKILL_MANAGER_MANIFEST_FILE`：覆盖清单路径（默认 `roo/.manifest.json`）；
- 理由：M2 自动化回归在**临时根**跑全流程（不污染真实技能根与真实清单）；真实根的目录可见性（A4）仍手工按 A1 验证一次。两处 env 未设置时行为与默认完全一致，不影响生产。

---

## 4. 测试计划

### 4.1 单元测试（node 直跑，无需宿主）

| 模块 | 用例 |
|---|---|
| source | 5+：github 完整形态 / github 缺 ref / git-url+fragment / 本地绝对路径 / 本地不存在 / 空串 / `#` 与 `/` 混合 |
| validate | 8+：合法 bundle / 合法 flat / 缺 description / 驼峰键 / 非布尔值 / 非法 name / 无 frontmatter / UTF-8 非法 |
| manifest | 4：空文件→空清单 / save→load 回环 / 损坏 JSON 抛错 / hashFiles 相对路径键与 .git 排除 |
| install（临时根） | 6+：本地源安装成功 / 幂等 SKIP / 同名冲突（默认拒 / --force 覆盖入备份） / EXDEV 模拟（跨盘 cpSync 分支走本地目录逻辑） / 锁 busy / 锁 stale 抢占 |

（单元测试脚本放 `D:\DSH\dsh-skill-manager\tests\`，纯 node --test 或自写断言；零依赖。）

### 4.2 集成回归（临时根 + 真实网络）

- 网络路径：`install github:mattpocock/skills#main/skills/engineering/domain-modeling`（临时根，与真实根无关）；
- 验证：落位结构 / 清单条目（source/ref/files/updatedAt）/ 重复安装 SKIP；
- 注意：本机 git 走代理直连（此前 `git clone` 可用；若失败排查 git 代理配置）。

### 4.3 手工验收（真实根，用户执行 `/skill` 或我在宿主侧用命令面板触发）

| 验收 | 操作 | 预期 |
|---|---|---|
| A1 首装 | 干净临时根（自动化） | 面板报 commit + 清单完整（自动化已覆盖）；真实根 A1 用 A3 覆盖式验证代替 |
| A2 校验拒绝 | 用含驼峰键的 fixture 源 install | 拒绝 + 指明违规；技能根无残留（临时根自动化） |
| A3 覆盖 | `install gh:…/grilling`（同源不同 ref，--force） | 旧版入备份区；新版生效；updatedAt 更新 |
| A4 热生效 | 安装后刷新下一轮对话目录 | grilling 出现在技能目录，全程无重启 |
| A10 并发 | 两个会话同时 install | 一个执行、一个报「另一安装进行中」 |
| A13 同名冲突 | 已装 grilling 后用另一来源 install | 默认报错展示既有 source/ref；--force 换源后旧版在备份区 |
| A14 时序承诺 | install 成功后立即 list | 输出「下一轮对话起生效」提示，不阻塞 |

### 4.4 回归项

- `/skill doctor` 输出仍正常（M1 在线功能不回归）；
- `reuseSession` 等 feishu-bot 功能不受影响（独立项目，无交集）。

---

## 5. 实施节奏（子里程碑）

| 子里程碑 | 内容 | 验证方式 |
|---|---|---|
| M2a | source.js + fetch.js + validate.js + 单元测试 | node 单测全绿（含 `isSkillName` 对标用例） |
| M2b | manifest.js + install.js（含锁）+ 临时根集成（本地源 + github 源） | 集成脚本输出通过 |
| M2c | scan.js 抽出 + list 升级 + remove + index.js 接线 | node --check + 逻辑单测 |
| M2d | 重跑安装脚本同步 profile 快照 → 用户重启 dsh web → 手工验收 A3/A4/A10/A13/A14 | 验收记录 + 截图/日志 |

每步均：`node --check` 全部改动文件 → 单测 → 通过后进入下一步；M2d 之前不碰真实技能根。

---

## 6. 风险与依赖

| # | 风险 | 缓解 |
|---|---|---|
| 1 | git clone 网络（代理/TUN） | 集成前先跑一次真实 clone 试探；失败则检查 git 代理配置 |
| 2 | 真实根已有 7 技能（无 M2 的 adopt） | A1 自动化用临时根；真实根 A3 用 `--force` 覆盖 grilling；A13 用另一来源触发 |
| 3 | 锁文件在 os.tmpdir 可能被清理 | stale 检测 10 分钟 + pid 存活判断；清理后自动重建 |
| 4 | 与 M3 边界（update/adopt 占位） | manifest 结构按 §5.1 一次到位，M3 只加读取逻辑 |
| 5 | `isSkillName` 对标 | M2a 单测固定用例与提供方行为对照（M1 已实证 vaild 文法：grilling/grill-me/domain-modeling…） |
| 6 | 命令面板无 locale 上下文 | 双语静态文案（M1 已验证可行），不做真正 i18n 切换 |

---

## 7. 交付物

- `lib/source.js` `lib/fetch.js` `lib/validate.js` `lib/manifest.js` `lib/install.js` `lib/scan.js`（新增）+ `lib/index.js`（升级）
- `tests/` 单元与集成脚本
- 实施记录：每子里程碑的测试输出 + M2d 验收证据（PRD §9 更新 M2 = 已完成）
