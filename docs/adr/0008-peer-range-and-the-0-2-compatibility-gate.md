# peer 范围要覆盖已验证的运行时，且必须在重启前复算 dsh 的兼容性闸门

dsh **0.2.0** 在应用任何 patch 层之前新增了一道闸门：

```js
const issue = evaluatePluginCompatibility(bundleManifest, exemptions);
if (issue !== void 0 && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue));
```

它逐条检查 bundle 自身 `peerDependencies` 里所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
的**范围是否满足运行时版本**（`semver.satisfies(runtime, range, { includePrerelease: true })`），
并且**完全不看 `peerDependenciesMeta`**——`optional: true` 不豁免任何东西。不满足时该 bundle
被丢进 `skippedBundles`：它**不贡献任何 patch 层**，于是插件根本不挂载。

本插件钉的是 `^0.1.5-rc.1`（`>=0.1.5-rc.1 <0.2.0-0`）。dsh 升到 0.2.0-rc.2 后，闸门判定
不满足，插件静默消失：设置页没有技能分区，`/skill` 不存在，`/dsh-skills/*` 全部 404。
**这一切在插件内部无法自证**——`doctor` 是插件自己的命令，插件没被挂载时它永远不会运行。
同一台机器上还有两个插件同样被跳过（`dshmarket`、`@deepseek-ai/dsh-subagent-codex`），
而没声明任何 `@deepseek-ai/dsh*` peer 的三个插件照常加载。

## Status

accepted（v0.1.7 实现）

## Considered Options

- **继续钉单个 rc（`^0.1.5-rc.1`）**：每次 dsh 升级都要求插件先发新版，否则整包消失；
  rc 阶段尤其致命（`^0.2.0-rc.2` 在 0.3.0 预发布上照样不满足）。
- **`workspace:^` / `workspace:*`**：闸门把它替换成运行时版本，永远通过。但那是给
  与 dsh 同仓发布的插件用的语义，第三方包写它会谎称"与任意版本兼容"。
- **精确版本豁免**（profile 的 `compatibility.json`，`dsh plugin allow-version`）：
  闸门支持，但豁免键含插件版本，任何一次版本号变更都会失效——是逃生门而不是策略。
- **声明已验证区间（选定）**：`>=0.1.5-rc.1 <0.3.0-0`。下界是首个验证过的版本，
  上界是下一个 minor 的预发布起点，因此 0.3.0 的任何预发布都会重新要求验证，
  而 0.1.5 / 0.2.0 全系（含 rc）直接通过。

## Consequences

- 范围是**声明**，不是证明：改范围的那一刻起，"已验证"这件事必须真的做过。本次把
  0.1.5-rc.1 → 0.2.0-rc.2 的整套契约面逐条核对过（宿主 6 项、客户端 6 项、提供方 6 项）。
- `tools/preflight.mjs` 增加第 5 项检查：**调用 dsh 自己的 `evaluatePluginCompatibility`**
  （拿不到时退化为同规则的 semver 复算）对当前安装的 dsh 版本复算一遍，不通过就
  `FAIL` + 退出码 1，直接挡住重启。反向验证：把范围改回 `^0.1.5-rc.1`，预检报
  `BLOCKED: 1 error(s)` 并打印 `dsh plugin allow-version` 的补救方式。
- 预检要能找到 dsh 安装：`--dsh-root` / `$DSH_INSTALL_ROOT` → profile → npx 缓存
  （`<cache>/_npx/*/node_modules/@deepseek-ai/dsh`，取最新）。找不到时只出 `note`，
  不假装通过。
- 两侧一起被这条闸门影响的还有 entry 解析：0.2.0 里包从 npx 安装树解析，预检原先写死
  `installAnchor: null`（0.1.5 时代包在 `~/.dsh/profiles/node_modules`），升级后
  把每个一方 entry 都误报成"解析不到"。锚点现在同样来自上面的发现结果。
- 上游若某天开始尊重 `peerDependenciesMeta.optional`，本 ADR 的"范围即承诺"策略仍然成立，
  只是可以额外把 peer 标成 optional 来降低破坏面——届时重新评估。
