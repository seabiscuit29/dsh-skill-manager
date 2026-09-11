# 统一技能根到 ~/.dsh/skills 并迁移 ~/.agents/skills

存量 7 个技能分散于 `~/.dsh/skills`（5）与 `~/.agents/skills`（2），双根导致无统一视图与记账口径。决定以 `~/.dsh/skills`（user-dsh，rank 400）为唯一用户技能根，将 `~/.agents/skills` 下的两个技能一次性迁移入根；放弃 `~/.agents` 兼容是刻意的——单一事实源比保留提供方的兼容扫描点更值钱。

## Status

accepted

## Considered Options

- 保留双根并存：尊重 `dsh-skill-filesystem` 的兼容设计，但管理、记账、`list` 对照都要处理两个根，复杂度翻倍。
- 统一到 `~/.agents/skills`：与外部 agent 生态约定一致，但与 dshHome 脱钩（DSH_HOME 重定向时行为分裂）。
- 统一到 `~/.dsh/skills`（选定）：与 dshHome 一致、rank 语义清晰。

## Consequences

- 迁移是一次性 rename（同盘），先备份再执行；提供方 watcher 对根删除/重建可观察，目录不中断。
- 已依赖 `~/.agents/skills` 路径的外部工作流（若有）需改用新路径。
