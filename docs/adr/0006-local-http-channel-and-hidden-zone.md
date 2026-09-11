# 页面通道用本地 HTTP 路由，禁用落位用同级隐藏区

两处技术选型在评审中比较了全部候选，最终选择：(1) 页面通过宿主自注册的本地 HTTP 路由
`/dsh-skills/*` 取数与变更，而不是新定义一个 Typert Remote 命名空间；(2) 禁用把技能移入技能根的
**同级隐藏区** `~/.dsh/.skill-disabled/`，而不是根内的 `.disabled/`。

## Status

accepted

## Considered Options

**通道**

- **Typert Remote**：类型化、走既有网关，但正规产物由 `@deepseek-ai/dsh-typert-generator`
  生成，而生成器不在 dsh 安装副本内；第三方需手写 TYPERT/TYPERT_REMOTE 清单并通过 registry
  的严格校验，客户端还要处理 `$mount` 时序。收益是类型，代价是长期脆弱性。
- **本地 HTTP 路由（选定）**：与环境里成熟的第三方「插件市场」同构；零代码生成、零第一方改动、
  离线可用，安全面自持（同源校验 + 4 KiB body 上限 + 变更锁）。代价是 JSON 契约需自管。

**禁用落位**

- **根内 `<root>/.disabled/`**：少一层目录，但有一个真实陷阱——`<root>/.disabled/SKILL.md`
  会被提供方当成一个技能（发现逻辑只看直接子项里的这一条路径）；且每次发现都要多一次
  `resolve`+`stat`，创建/删除该目录还会产生一次无意义的 watcher 失效。
- **同级隐藏区（选定）**：完全在扫描根之外，零 provider 交互、零陷阱、零噪音；与既有的
  `~/.dsh/.skill-backups` 对称，同卷原子 rename。

## Consequences

- 路由前缀固定为 `/dsh-skills`；`webServer.register` 对重复 `(kind,path)` 直接抛错，前缀即命名空间。
- 安装**不**经 HTTP 暴露：页面只管理已安装技能，新增仍走 `/skill install` 命令。
- 隐藏区路径必须落账（`state`/`diskName`/`disabled.from|to`），且 `doctor` 能据账找到实物；
  同时 `install` 的同名冲突检查必须**同时扫描 live 根与隐藏区**，否则会对已禁用技能装出第二份副本。
- 跨卷（`EXDEV`）被拒绝而非静默降级为 copy+rm：隐藏区必须与技能根同卷。
