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

## Amendment（v0.1.8）：上界放到整个 0.x，代价用运行时自报补

v0.1.7 选的 `<0.3.0-0` 在实践中暴露了它的真实代价：dsh 走 rc 通道、minor 发布频繁，而闸门
不满足时的表现是**静默整包跳过**——插件在升级后直接消失，且它自己的任何自检都不会运行到。
"每个 minor 都强制重新验证"听上去严谨，实际结果是**每次升级都要有人先踩一次坑**。

改判据：

- peer 范围放宽为 `>=0.1.5-rc.1 <1.0.0-0`（`dsh-commands` / `dsh-skill` / `dsh-host-webserver`
  三条同改）。用 dsh 自己的 `evaluatePluginCompatibility` 实测的边界：0.1.5-rc.1 / 0.2.0-rc.2 /
  0.2.0 / 0.3.0-rc.1 / 0.3.0 / 0.9.9 全部**装载**，`1.0.0-rc.1` 起**跳过**——1.0 是真正的稳定性
  边界，届时重新验证。
- 新增 `lib/core/runtime.js`：定位运行中的 dsh（从 `process.argv[1]`、本插件模块位置、
  profile 共享安装三处向上找 `node_modules/@deepseek-ai/dsh/package.json`），
  按 **minor 线**判定是否已验证（`0.2.5` 与已验证的 `0.2.0-rc.2` 同线 → verified）。
  依赖为零：不 import 任何 `@deepseek-ai` 包。
- 自报出现在三处：`doctor` 恒打一行 `dsh runtime: … — verified|UNVERIFIED`；
  `list`/`search` 仅在未验证时**置顶**一行告警（正常运行保持安静）；`/list` 路由把
  `runtime` 放进载荷，页面在未验证时显示告警横幅（中英双语）。
- 找不到运行时（`argv` 与 profile 都不指向安装）报 `unknown` 而**不告警**：
  无法归因就不要吓人。

**取舍记录**：这条改判把"失败模式"从「静默消失」换成「带着未验证的假设运行」。后者对本插件
是可接受的，因为它的写操作全部可逆（备份区 + 同级隐藏区 + 账本，且在写之前做镜像校验），
而前者完全没有信号。真正的护栏仍是：预检里的闸门复算、`_verify/compat-gate-authoritative.mjs`、
以及 `doctor` 的 UNVERIFIED 行。
