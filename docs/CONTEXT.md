# dsh-skill-manager

把 Skill 的安装方法固化到 DeepSeek Harness：一个 profile 层插件，提供 `/skill` 命令组（install / list / update / remove / verify / doctor / adopt），以「Git 源 + 记 commit + 原子落位 + 清单记账」的方式管理 `~/.dsh/skills` 技能根。

## Language

**技能（Skill）**：
一套可复用的任务说明：磁盘上为 `SKILL.md`（bundle）或 `<name>.md`（平铺），被 DSH 的 skill 提供方发现后进入模型目录。
_Avoid_: 插件、命令、Prompt 模板

**技能根（Skill Root）**：
skill 提供方扫描的文件系统根目录；本项目管理的根为 `~/.dsh/skills`（user-dsh，rank 400）。
_Avoid_: 技能文件夹、skills 目录

**技能包（Skill Bundle）**：
技能根下以 `<name>/` 目录形态存在的一个技能（含 `SKILL.md` 及可选 references/scripts/assets）。
_Avoid_: 技能目录、skill 文件夹

**技能目录（Catalog）**：
模型与用户可见的「name + description」技能清单，由 `ctx.skills` 合并各提供方后生成，随 watcher 失效自动重发。
_Avoid_: 技能列表、技能菜单（与文件系统的"目录"刻意区分）

**清单（Manifest）**：
`~/.dsh/skills/.manifest.json`，记录每个技能的来源描述、commit、文件 sha256 与安装时间，是 verify / update 的依据。
_Avoid_: 索引、注册表、账本

**来源描述（Source Spec）**：
安装命令接受的技能来源字符串，形如 `github:owner/repo#ref/path`、git URL + `#ref/path` 或本地路径。
_Avoid_: 地址、链接、仓库

**原子落位（Atomic Placement）**：
在技能根之外 staging、校验通过后以单次 rename 进入技能根的操作序列，保证 watcher 与目录永远看不到半成品。
_Avoid_: 直接拷贝、就位

**备份区（Backup Area）**：
`~/.dsh/.skill-backups/<name>-<ts>/`，remove 与 update 被替换版本的存放处；位于 dshHome 下、技能根外，对提供方不可见。
_Avoid_: 回收站、归档目录

**收编（Adopt）**：
把技能根中已存在但不在清单里的技能登记进清单，记录其来源（可为 `local`），使其进入被管理状态。
_Avoid_: 导入、注册、迁移（迁移特指跨根移动）
