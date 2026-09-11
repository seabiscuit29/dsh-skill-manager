# 以 profile 层插件（而非上游贡献/独立 CLI）固化 Skill 安装

DSH 通过 npx 分发只读拷贝且无上游仓库提交权限，而上游贡献在升级时即被覆盖、不可迭代。因此将 Skill 安装管理固化为 profile 层插件 `@deepseek-ai/dsh-skill-manager`，经 `cordis.patch.yml` 挂载，随 profile 持久、dsh 升级零影响；独立 CLI 因脱离 DSH 的 `ctx.commands`/`ctx.skills` 语境（命令面板派发、目录热更新）而不采用。

## Status

accepted

## Considered Options

- 上游贡献 `dsh skill` 命令：最彻底但无权限、不可迭代，列为远期方向。
- 独立 CLI 脚本（`dsh-skill.cmd`）：可独立运行但无法复用命令面板、无法对照 `ctx.skills` 目录，用户仍需记住第二种入口。
- profile 层插件：复用已验证的挂载三件套（pnpm file: 依赖 + patch insert + 幂等脚本），命令进入 Web slash 面板，与现有 `dsh-client-ui-settings-skills` 同构。
