# 双半区标准插件：合并且仅以一个包交付

原先拆成两个插件：`@deepseek-ai/dsh-client-ui-settings-skills`（只读技能页，客户端半区）与
`@deepseek-ai/dsh-skill-manager`（命令与文件系统逻辑，宿主半区）。两者数据同源、生命周期同步、
却要各自经历一次 profile 挂载与一次 dsh 升级适配。现合并为一个包 `dsh-skill-manager`：
宿主半区（`/skill` 命令 + 本地路由 + 图标自愈）与客户端半区（设置 → 技能 页面）同包交付。

## Status

accepted（取代 ADR-0001 之后关于「node-only，无 client 半区」的评估结论 D1.2）

## Considered Options

- **保持两个包**：职责清晰，但同一功能要有两次挂载、两份升级适配，且「设置页只读 + 命令可写」
  的双轨体验本身就是割裂的。
- **只做客户端半区**（页面直接操作文件系统）：浏览器无法访问文件系统，必须新增宿主能力，
  反而更复杂。
- **单包双半区（选定）**：官方支持形态（同一个 `dsh` 对象里同时声明 `bundle` 与 `client`），
  客户端半区无需单独 insert —— 由 `dsh-client-modules` 扫描宿主 Loader entries 自动发现。

## Consequences

- 交付物是一个包，安装即 `dsh plugin --profile web add <spec>`，自动进 `dsh.profile.bundles`。
- 页面与命令共用 `lib/core/*` 唯一实现，两个入口不可能出现状态分歧。
- 包名必须脱离 `@deepseek-ai` 域：bundle 解析「安装副本优先」，同名会被官方包静默顶掉。
- 客户端半区成为长期维护面：每次 dsh 升级都可能触碰客户端契约，因此客户端只依赖基座模块
  与自有 HTTP 契约（见 ADR-0006）。
