# 安装与迁移：从两个旧插件切换到新插件

本文是**移交清单**：由你执行换插件，顺序不能颠倒。

## 前提状态

当前 `web` profile 装着两个旧插件，且都靠 `cordis.patch.yml` **手写 insert** 挂载：

| 旧插件 | 依赖写法 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-settings-skills` | `file:D:/DSH/dsh-client-ui-settings-skills` | 只读技能页（已并入新包，将退役） |
| `@deepseek-ai/dsh-skill-manager` | `file:D:/DSH/dsh-skill-manager` | M1 命令探针（**该路径现在指向新项目**，包名已改为 `dsh-skill-manager`） |

> ⚠️ 两个插件与新包都注册 `settings.section id=skills`，且旧手写 insert 的 id 与新包包内 patch 的 id
> 相同（`dsh-skill-manager`）。**同时存在会导致重复 entry id / 重复 slot，cordis 拒绝启动或页面异常。**

## 换装步骤（脚本版，推荐）

一条命令完成「备份 → 卸旧 → 清 patch → 装新 → 预检」的安全序列：

```powershell
# 先看它要做什么（不改任何文件）
powershell -ExecutionPolicy Bypass -File D:\DSH\dsh-skill-manager\tools\swap-profile.ps1 -DryRun

# 真正执行
powershell -ExecutionPolicy Bypass -File D:\DSH\dsh-skill-manager\tools\swap-profile.ps1
```

脚本在**顺序**上做了防呆（顺序错了会 brick）：备份 profile 两文件 → 卸载两个旧插件 →
删除 `cordis.patch.yml` 里两条旧 insert → 安装新插件 → 跑预检；预检不通过会打印回滚命令并
拒绝继续，**此时还没重启，profile 可以安全回滚**。

## 换装步骤（手工版，等价）

```powershell
# 0) 备份
$p = "$env:USERPROFILE\.dsh\profiles\web"
Copy-Item "$p\package.json"      "D:\DSH\backups\profile-package.json.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item "$p\cordis.patch.yml"  "D:\DSH\backups\profile-patch.yml.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"

# 1) 卸载两个旧插件
dsh plugin --profile web remove @deepseek-ai/dsh-client-ui-settings-skills
dsh plugin --profile web remove @deepseek-ai/dsh-skill-manager

# 2) 删除 profile patch 里两条旧 insert（mcp-feishu / dsh-client-ui-skin 保留）

# 3) 安装新插件
dsh plugin --profile web add file:D:/DSH/dsh-skill-manager

# 4) 预检——通过后才重启
node D:\DSH\dsh-skill-manager\tools\preflight.mjs --profile web
```

## 预检工具：为什么它比 `--dump-config` 更关键

`dsh --profile web --dump-config` 只**渲染合成后的 patch 层**，从不解析入口模块，因此看不见
「入口指向已卸载的包」「入口文件不存在」「同一 id 被追加两次」这三类**能合成但起不来**的故障。
`tools/preflight.mjs` 专门覆盖它们，并已用负向测试证明能抓到：

| 场景 | 预检输出 |
|---|---|
| 旧手写 insert 未删（+ 新包包内 patch） | `FAIL duplicate appended entry id "dsh-skill-manager" … two entries with one id cannot mount` |
| insert 指向已卸载的包 | `FAIL entry mounts "…" but package "…" does not resolve from the profile or the installation` |
| 入口文件缺失（brick 场景） | `FAIL … resolves to <dir> but its entry file is missing — this bricks the boot` |
| **换装后正常状态** | `PASS: 0 error(s), 0 warning(s) — Safe to restart dsh web.` |

它还顺带核对：`dsh.bundle.patch` 是否声明且文件存在、`dsh.client.platform` 是否为 `web`、
客户端产物是否为 lazy-CJS 工厂包且 `id` 与包名一致、客户端 require 是否都在基座白名单内、
宿主入口能否真的 import 出 `apply`/`inject`、两个旧插件是否已退净、全树追加 entry id 是否唯一。

> 预检是**只读**的：不改任何文件。真实 profile 上现在会报 2 个预期 FAIL（两个旧包尚未卸载），
> 换装后应变为 PASS。

## 换装后核验（约 1 分钟）

**安装侧**
- [ ] `profiles\web\package.json` 的 `dsh.profile.bundles` 里出现 `dsh-skill-manager`
- [ ] 安装命令 stderr **没有** `declares no dsh.bundle` 警告
- [ ] `profiles\web\node_modules\dsh-skill-manager\lib\client.js` 存在（客户端产物已随包写入）
- [ ] 设置 → 插件 → **Plugin list** 能看到 `dsh-skill-manager`

**页面侧（设置 → 技能）**
- [ ] 页面正常渲染：标题 + 说明 + **搜索框** + 卡片列表（不再是「暂时无法读取」）
- [ ] 能看到全部技能：受管根 5 个 + `~/.agents/skills` 的 2 个 coze 技能（标记**其他根**、只读）
- [ ] 搜索框输入 `grill` → 只剩 grilling / grill-me / grill-with-docs
- [ ] 拨动某技能开关 → 提示成功；卡片变「已禁用」；`~/.dsh/.skill-disabled/<name>/` 出现该技能
- [ ] 下一轮对话的技能目录里不再出现该技能；再拨回来 → 恢复
- [ ] 点「删除」→ 出现「确认删除？」→ 确认 → `~/.dsh/.skill-backups/<name>-<时间戳>/` 出现备份
- [ ] 未入账技能卡片上有「收编」按钮，点击后来源显示为 local

**命令侧（对话框输入）**
- [ ] `/skill list` 列出全部（其他根的行标注只读）
- [ ] `/skill doctor` 报告 skill root / hidden zone / manifest / untracked / other roots
- [ ] `/skill search grill` 过滤正常
- [ ] `/skill install <本地路径>` 或 `/skill install github:owner/repo#ref/path` 安装成功，且下一轮目录可见
- [ ] `/skill disable <name>` / `/skill enable <name>` 与页面开关效果一致
- [ ] `/skill update` 返回「暂不支持（近期范围外）」

## 回滚

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\web"
Copy-Item "D:\DSH\backups\profile-package.json.bak-<stamp>" "$p\package.json" -Force
Copy-Item "D:\DSH\backups\profile-patch.yml.bak-<stamp>"     "$p\cordis.patch.yml" -Force
dsh plugin --profile web install      # 按还原后的依赖重装（旧插件快照仍在 node_modules）
# 重启 dsh web
```

## 已知边界（换装后仍然成立）

- 只管理 `~/.dsh/skills`（受管根）；`~/.agents/skills` 与项目根的技能**只读展示**，
  要纳入管理需迁移（见 `M2-PLAN.md`，尚未执行）。
- 禁用/卸载的生效时点是**下一轮对话**（watcher 异步），不是即时。
- 跨卷移动会被拒绝；隐藏区与受管根必须同卷（默认都在 `~/.dsh` 下）。
- 更新与 `verify --remote` 属远期；账本已记录 source/ref 以便将来生长。
