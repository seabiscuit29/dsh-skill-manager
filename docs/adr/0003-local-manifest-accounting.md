# 用本地清单（.manifest.json）+ git commit 记账，而非 git 子模块或零记账

技能需要回答「装了什么、哪来、哪个 commit、能否升级」，但技能根本身不能成为 git 仓库——提供方只支持一级发现，`.git` 目录与嵌套树会干扰发现语义，且多个上游仓库无法共存于单一根。因此用 `~/.dsh/skills/.manifest.json`（对提供方不可见）记录来源描述、commit、逐文件 sha256 与时间戳；更新语义 = 对比记录的 branch HEAD，有变化才原子换装。

## Status

accepted

## Considered Options

- git 子模块挂载技能上游：更新=git pull，但多仓库共存于技能根、嵌套 `.git`、Windows junction 均与提供方发现模型冲突。
- 零记账（现状）：不可升级、不可校验、不可审计——正是本需求的痛点。
- 本地清单 + git commit（选定）：轻量、与提供方零耦合、verify/update 有据可依；代价是 manifest 与磁盘事实可能漂移，由 verify/doctor 检测。
