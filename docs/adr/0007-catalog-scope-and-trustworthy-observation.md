# 目录可见性查询必须带 scope，且不完整观察不得出结论

行级「目录可见 / 目录不可见」标记在真实环境里全线误报（内置技能也被标成 `not-in-catalog`），
根因是查询方式而不是技能状态：

- `ctx.skills.list()` / `snapshot()` **不带 `scope` 时只读 global 层**。注册表的实现是
  `layers = [this.layers.global, ...this.layers.chainLayers(options.scope)]`，而
  `dsh-skill-filesystem` 的贡献落在 **scope 链**里，因此宿主上下文中的无 scope 查询
  返回空集——一个「权威地说什么都没有」的空集；
- `list()` 还会丢掉完整度：`list()` 就是 `(await snapshot()).skills`，把
  `complete`（本次发现是否完整、是否撞上并发修订）丢掉了。

于是「本行不在目录里」这个结论，被一个既不完整、又答非所问的观察支撑，从而对**每一行**成立。

## Status

accepted（v0.1.6 实现）

## Considered Options

- **继续用 `list()`，直接删掉该标记**：最省事，但丢掉一个真实能力——判断某个已启用技能
  是否真的会被模型看到（例如 `model-invocable:false`、符号链接、非法 frontmatter）。
- **无 scope 查询 + 启发式修补**：例如「空结果就当作查询不可用」。能挡住这次的症状，却
  把「部署里确实一个技能都没有」和「查询答错了对象」混为一谈，而且不解决部分发现。
- **带 scope 的 `snapshot()` + 可信性判定（选定）**：按 dsh-tool-skill 自己的调用方式
  `snapshot({ scope: agent, cwd: agent.session.header.cwd, signal })` 取「这个 agent 实际看到的目录」，
  并用 `complete` 决定这份观察够不够格支撑行级结论。
- **页面上也按 agent 查询（选定）**：页面自己没有 agent，且无 scope 查询恒为空，所以页面的
  catalog 旁证改为「每个存活 agent 的视图 ∪ global 层」去重合并（`observeDeploymentCatalog()`）。

## Consequences

- 判定规则集中在一处（`lib/core/catalog.js`）：**查询失败、`complete !== true`、返回 0 条而磁盘
  确有技能**，三者都视为不可信 → 不出行级标记，只打一行说明（`catalogNote()`），报告文本由
  `lib/core/report.js` 渲染。四种不可信形态与两种可信形态共 20 项断言守护。
- 取消（`signal.aborted`）不是对目录的判决：abort 会继续抛出，不会被当成「查询失败」缓存下来。
- 可信标记只在「这个 agent 的视图」意义上成立：同一台机器上不同会话的 cwd 不同，项目根技能
  可能只对其中一部分可见——这正是页面用并集、命令用自身 scope 的原因。
- `doctor` 的 catalog 行从 `ok` 升级为 `<N> entries, complete|INCOMPLETE`：空集不再伪装成健康。
- 上游若改回「无 scope 即全局视图」，此 ADR 的前提失效：`catalogUsable()` 会因 `count === 0 && rowCount > 0`
  继续拒绝出标记（保守方向），但「目录可见」标记会整体消失，需要重新校准。
