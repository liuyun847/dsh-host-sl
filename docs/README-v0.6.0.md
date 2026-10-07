# dsh-host-sl

> **历史归档（v0.6.0）**：本文描述的是 v0.6.0 的「`/sl` 命令 + Markdown 交接记录 + `pending.json`」那套机制，
> 其中的 `/sl`（及服务侧 `save` / `saveAll`）自 **v0.7.0 起已整体删除**，现行机制见仓库根 [README.md](../README.md)；
> 文中引用的 [PLAN.md](../dsh-sl-handoff/PLAN.md) 与 [CONTRACT.md](../dsh-sl-handoff/CONTRACT.md) 是**仓库外文件**（在 GitHub 上点不开）。

DSH 宿主插件：**会话任务状态跨进程保存与恢复**。

结束工作时把会话渲染成交接记录落盘（人敲 `/sl`，或宿主插件调 cordis 服务 `slHandoff` 的
`save` / `saveAll` / `pendingSummary`），下次 dsh 宿主启动时本插件自动判定并把记录**注入回每一个「有活」的会话、起新一轮** ——
重启不再需要靠「拦截」来避免丢失在飞工作，**子代理也在恢复范围里**（v0.4.0 起）；
**保存那一刻空闲的会话不注入**（v0.5.1：只留记录文件，不无端唤醒它）；
**写标记时按会话 id 与已有新鲜标记取并集**（v0.6.0：先敲 `/sl` 存下的条目不会被后来的保存抹掉）。

- 实施依据：[PLAN.md](../dsh-sl-handoff/PLAN.md)（任务书）、[CONTRACT.md](../dsh-sl-handoff/CONTRACT.md)（第三方插件的源码级接口契约，**本插件不装它**，只借用其中「写启动恢复要用的宿主原语」一节）
- 状态：**已以 `link:` 装进 web profile**（工作区这份是唯一源）；代码在 **v0.6.0**，离线自测 206 用例全绿；
  **v0.5.0 / v0.5.1 / v0.6.0 都已在运行中的宿主里生效**（2026-09-29 01:51 与 01:55 两次启动实测，
  真机验收记录见文末「验收记录：2026-09-29（v0.6.0）」）
- 与 PLAN 的偏差共 5 条，都写在下面「[与 PLAN / CONTRACT 的偏差](#与-plan--contract-的偏差)」一节，**先看那一节再验收**
- 交付前的对抗性审查修掉了 8 项缺陷/缺口（注入后的归档顺序、读历史失败被当成空会话、目标会话不在列表时判死、同秒覆盖、卡片不显示 note、三处文档不一致、两条前提说明、新增「保存时在跑的子代理」一节）
- v0.2.0 修掉一处**会让功能白做**的判据缺陷：闸门① 原来按「顶层会话**存在**」让位，而宿主启动后浏览器会把各标签页的空闲会话重新订阅成 live agent ⇒ 用户开着两个及以上标签页时「重启后自动续上」永远不触发。现在只按「**正在跑一轮**」（`agent.status === 'running'`）让位，见「偏差 1」
- v0.2.1 修掉一处**会让核心功能永远不触发**的时序冲突：本机 `dsh-host-restart` 也在 apply 后 4s 醒来、对**同一个会话**先注入「已重启」，目标会话随即进入 `running`；旧版「目标会话在跑 ⇒ 让位」据此让位、标记保留 ⇒ 每次重启都被挡掉。`followup` 的语义经源码核实是「**排进下一轮、不打断当前轮**」，所以那两条让位判据已删除，见「[为什么「目标会话在跑」不再让位](#为什么目标会话在跑不再让位v021源码级核实)」
- v0.2.2 修掉一处**记录内容质量**缺陷：`## 用户目标` 那一节原来会把宿主注入的系统消息一起收进来（实测 5 条里 4 条是噪音），现在只收**真人消息**（结构性判据 `source.kind === 'user'`），见「[「用户目标」只收真人消息](#用户目标只收真人消息v022源码级核实)」
- **v0.3.0 换入口、换标记结构**（用户 2026-09-28 的要求）：① **模型工具入口删除**，保存能力改为 cordis 服务 `slHandoff`（供 `dsh-host-restart` 这类"要杀进程"的宿主插件在动手前顺手存一份）；② 服务与标记结构**支持一组会话**（列表结构）。见「[偏差 5](#偏差-5v030模型工具入口删除改为-cordis-服务slhandoff)」
- **v0.4.0 把保存与恢复都扩到「所有会话」**（用户 2026-09-28 的要求）：① 服务新增 `saveAll`，枚举**所有活着的 agent**（顶层 + 子代理）各存一份记录；② `runResume` **恢复全部条目**，顺序硬约束「**先顶层、后子代理**」（冷恢复子代理要求父 agent 已活着）；③ 新增配置 `resumeMaxSessions`（默认 `0` = 不限）。v0.3.0 的「偏差 6（只恢复第一条）」**随之作废**，见「[偏差 6（v0.4.0，作废 v0.3.0 的那一条）](#偏差-6v040多会话恢复已实现v030-的只恢复第一条作废)」与「[多会话的保存与恢复](#多会话的保存与恢复v040)」
- **v0.4.1 把 `/sl` 也改成「存所有活跃会话」**（用户 2026-09-28 的要求；v0.4.0 只改了服务面，`/sl` 当时仍只存本会话 —— 这是补上漏掉的那一处入口）：`/sl [说明]` 现在枚举所有活跃会话各存一份，`说明` **只写进当前会话那一份**（`noteSessionId` = 敲命令的那个会话）；枚举不到 live agent 表时 fail-soft 退回"只存当前会话"，并在**文案与日志里如实说明这是退回**。成功文案同时写清**存了几个会话**与各自的记录路径（会话多时只列前 3 条 + 「…等 N 个」）。见「[偏差 7](#偏差-7v041sl-命令也覆盖所有活跃会话)」
- **v0.5.0 补上「子代理没唤回来时通知它的父会话」**（用户 2026-09-28 的要求）：恢复流程里子代理条目失败（可重试失败 / 明确不可恢复）时，给它的**直接父会话**投一条 `【sl 交接】子代理未能唤回` 的用户消息（写明哪个子代理、为什么没唤回、记录文件在哪、别把它当成已完成、下一步怎么办）。通道是 `sessionController.resolveAgent(父 id)` —— **唤醒语义：父会话即使已经"死了"（不在 live 表里、只躺在持久化里）也会被冷唤醒后收到通知**（用户拍板"宁可多起一轮也不漏通知"；代价是真起一轮、消耗 token）。成功后在标记条目上写 `notified: true` ⇒ **每条只通知一次**。见「[子代理唤不回来时通知父会话](#子代理唤不回来时通知父会话v050)」；**边界：「通知」≠「救回来」**，见「[已知限制](#已知限制)」里的「恢复 ≠ 无损」
- **v0.5.1 修掉「空闲会话被无端唤醒」**（用户 2026-09-28 报的 bug）：2026-09-28 23:05 那次重启，4 个顶层会话各存了一份交接，重启后**4 条全被 `followup` 唤醒** —— 而其中 3 个会话保存那一刻是**空闲**的（日志原话：`会话检测: 顶层会话 4 个(本轮运行 1 个), 其它有活在跑 0 个`），它们各白跑了一整轮（3~4 次工具调用）。根因是保存侧不区分「有活在跑」与「只是开着」：`agents.list()` 里**活着**的 agent 包含被浏览器标签页订阅的空闲会话（偏差 1）。现在 ① **保存侧**给每条标记记一个 `active` 位（判据四条：自己在本轮运行 / 名下子代理在跑 / 名下有未结算作业 / 有 `active+armed` 的 goal）；② **恢复侧**按它分流：`active:false` ⇒ **一个字节都不注入**（只留记录文件），且**跳过算"已处理"**（照旧归档，不留在 pending 里重试）；旧标记缺 `active` ⇒ 照旧唤醒。见「[空闲会话不注入](#空闲会话不注入v051)」
- **v0.6.0 修掉一处「会把存档抹掉」的写入语义**（用户 2026-09-29 的原话：*敲了 `/sl` 之后走重启工具重启，
  不该把 `/sl` 存档里那些（此刻已关掉的）会话条目丢掉*）：`/sl` 与"重启前保存"写的是**同一个**
  `pending.json`，而写入是覆盖语义 ⇒ 先敲 `/sl`（存档里有若干会话），之后重启工具又存一次时，那些
  "此刻已不是 live agent"（标签页已关 / 已被回收）的条目会从标记里消失（记录文件还在磁盘上，但不会被恢复）。
  现在写标记前先看磁盘上那份旧标记：**新鲜**（`classifyPending` 判 `fresh`）就按会话 id **取并集**
  （同一 `sessionId` 用新条目、只有旧标记有的原样保留、`done:true` 的不合并、`createdAt` 按本次算）；
  陈旧 / 读不出 / 形态不符 ⇒ 不合并、照旧覆盖并写一行日志。另外服务新增只读方法 **`pendingSummary()`**
  （供 `dsh-host-restart` v0.4.2 判断"这次重启的续跑消息该由谁注入"，两边合并成一次注入、一轮）。
  见「[为什么合并](#为什么合并v060)」与「[命令与服务契约](#命令与服务契约)」

---

## 它做什么（结论）

| 入口 | 谁用 | 行为 |
| --- | --- | --- |
| `/sl [说明]` | 人 | 把**所有活跃会话**各渲染成交接记录落盘（每个会话一份，含**保存时在跑的子代理**一节），写下「待续」标记；`说明` 作为**当前会话**那份记录里的「下一步」（其余留空）。v0.4.1 起与服务面 `saveAll` 同一条路 |
| cordis 服务 `slHandoff.save(sessions, note?)` | 宿主插件 | 同上；`sessions` 可以是**一个会话对象或一组会话**（逐个保存，一次调用只写一份列表标记） |
| cordis 服务 `slHandoff.saveAll(options?, note?)` | 宿主插件 | **所有活跃会话**各存一份（顶层 + 子代理），`note` 只写进 `options.noteSessionId` 那一份；同时判定每条会话**保存那一刻有没有在飞的活**（v0.5.1，`active` 位）。`dsh-host-restart` 在杀进程前调它 |
| cordis 服务 `slHandoff.pendingSummary()` | 宿主插件 | **待续标记的只读摘要**（v0.6.0）：`{exists, reason?, items:[{sessionId, kind, done, active, wake}]}`。只读、不写盘、从不抛。`dsh-host-restart` v0.4.2 用它决定"这次重启的续跑消息该由谁注入"（有人接手 ⇒ 它不注入，于是整轮只注入一条消息） |
| 宿主启动 | 自动 | 有新鲜标记、没有**别的**顶层会话**正在跑一轮** ⇒ **逐条**恢复标记里的会话：**先顶层**（`resolveAgent` + `followup`），**再子代理**（`subagents.prompt` → 宿主冷恢复）。一条失败只写日志，不影响其它条目。**空闲会话（`active:false`）一个字节都不注入**（v0.5.1，只留记录文件、算"已处理"）。**子代理没唤回来 ⇒ 先唤醒它的直接父会话、再投递通知**（v0.5.0，每条只通知一次） |

不做的事（v1 明确划掉，防范围蔓延）：不碰 `dsh-host-restart` 的实现、不读会话文件（不碰 zstd 全量解码，
只用内存里的消息）、不做 Web UI。

## 两条路径

```
保存（/sl 命令，或宿主插件经 slHandoff 服务）
  /sl ⇒ 枚举 ctx.agents.list() 里所有 live agent（v0.4.1 起；枚举不到 ⇒ 退回只存本会话）
  服务面 ⇒ 调用方指定的会话（save）/ 同样枚举全部（saveAll）
    → readMessages(session.deriveMessages())           # 内存里的模型可见历史，不读会话文件
                                                       # 读不出 ⇒ 拒绝保存（不覆盖 pending.json）
    → subagentsOf(ctx, session)                        # 血缘归属本会话且 running 的子代理
    → renderHandoffDoc(...)                            # 纯函数：给定输入 → 确定的 Markdown
                                                       # 「用户目标」只收真人消息（source.kind==='user'，v0.2.2）
    → 原子写 <storageDir>\handoff-<时间戳+毫秒>-<会话前8位>.md   # 每个会话一份
    → 判定每条会话**保存那一刻有没有在飞的活**（v0.5.1，判据四条）
                                                       # 空闲会话的记录文件照旧写（用户唯一能看到的痕迹）
    → 原子写 <storageDir>\pending.json（**v0.6.0 起：先与那份新鲜旧标记按会话 id 取并集**）
                                                       # v2 列表结构（一次调用只写一份）：
                                                       # {version:2,createdAt,items:[{sessionId,file,cwd,title,note,
                                                       #   kind:'root'|'subagent',parentSessionId,done,notified,
                                                       #   active,activeWhy}]}
                                                       # 陈旧/读不出/形态不符 ⇒ 不合并、照旧覆盖 + 一行日志
                                                       # 一个都没成功 ⇒ 不写（上一份交接原样保留）

恢复（宿主启动，apply 后延迟 4s）
  apply（同步）
    → 注册 /sl 与 ctx.provide('slHandoff', …) → ctx.timeout(runResume, 4000)
  runResume
    → 读 pending.json           不存在 ⇒ 什么都不做
    → normalizePending           v2 列表 / v1 单会话结构都读得进来（v1 当"1 条"，升级不丢旧交接）
    → classifyPending           invalid/stale ⇒ 改名归档 pending.<原因>-<时间戳>.json 后返回
    → 按 active 分流（v0.5.1）  active:false ⇒ **空闲条目**：不排队、不注入，收尾时算"已处理"
                                active 缺失（旧标记）⇒ 按"有活"处理，日志里明说
    → buildResumePlan           顶层条目排在子代理**之前**（硬约束）；resumeMaxSessions>0 时只排前 N 条
                                （空闲条目**不占**这个上限）
    → 闸门② process.uptime() > 5min ⇒ 判定为插件热加载，**标记保留**、不注入
    → waitForService('sessionController', 30s)   每 500ms 轮询；等不到 ⇒ **标记保留**、不注入
    → sessionController.list({}) → {items}        读不到 ⇒ 跳过列表判定（fail-soft）
    → 闸门① agents.roots() 里有**别的**顶层会话**正在跑一轮** ⇒ 让位，**标记保留**
                                                 （活着但空闲的其它会话、以及**本批的所有条目**都不算
                                                  —— 含 v0.5.1 的空闲条目，它们也是本批条目）
    → 列表形态不符 ⇒ unresumable（归档）
    → 逐条恢复（顺序 = 队列顺序）：
        空闲  active:false（v0.5.1）⇒ **一个字节都不注入**（不 followup、不投递子代理、不 flush、
              不通知父会话），只写一行日志（记录文件照旧在磁盘上），并**算"已处理"**：
              收尾时和注入成功的一样从标记里移除/随整份归档 ⇒ 归档为 done，绝不留 pending 重试
        顶层  decideResume（在不在列表里 / 空会话 / requireColdAgent）
              → 记录路径必须落在 storageDir 里（防穿越）⇒ 读记录正文
              → sessionController.resolveAgent(sessionId)   {agent} 或 {error}，两条都处理
              → agent.followup(用户消息)                    注入 = 引导语 + 记录正文（有长度上限）
                                                           followup = 排进下一轮，不打断当前轮
              → await sessions.flush(agent.session)         落盘检查点（设计点 3）
        子代理 父 agent 活着？（agents.get(parentSessionId)，**exact live parent**）
              ↑ 这一步是**投递子代理**的前置条件（宿主冷恢复要求 exact live parent），
                与下面的"通知"是两回事：通知那条路用 resolveAgent，父会话死了也能叫醒
              → ctx.get('subagents').prompt({parentSessionId, childSessionId, mode:'continuable',
                  delivery:'queue', content, requestId}, signal)   ← 宿主**冷恢复**它（设计点 17）
              → flush 只在子代理会话已是 live 时做（设计点 19）
              → 这一条**没唤回来**（投递失败 / 明确不可恢复）⇒ **通知它的直接父会话**（v0.5.0）：
                  sessionController.resolveAgent(parentSessionId)  ← **唤醒语义**：父会话死了也叫醒它
                    → agent.followup(【sl 交接】子代理未能唤回 …)
                  通知成功 ⇒ 在标记条目上写 notified:true（下次启动不再重复通知）
                  唤醒/投递失败 ⇒ 只写一行日志，不抛、不置位、不改任何判定（下次启动补发）
      逐条 fail-soft：某条失败只写日志、留在标记里，循环继续
    → 标记收尾：**已注入的条目从标记里移除**（这是"不重复注入"的机制）
        一条不剩 ⇒ 归档：done / done-noflush / done-partial（**空闲跳过的条目同样被移除** ——
                    v0.5.1：跳过 = 已处理，不留在 pending 里反复重试）
        还有剩下 ⇒ 写回 pending.json（失败/超上限的条目留给下次启动）
        写回也失败 ⇒ 整份归档为 done-partial（归档证据里带 done 位与 state，空闲条目写 state:'idle'），
                     绝不保留会重复注入的标记
```

两道闸门缺一不可：只看「有没有标记」会把**热加载**误当成宿主启动；只看 `roots()` 会在宿主刚起来
（roots 为空）时永远不触发。

闸门① 的判据是「**正在跑一轮**」（`agent.status === 'running'`），**不是**「存在」——
宿主启动后浏览器会把各标签页的会话重新订阅成 live agent（空闲也算 live），按「存在」判会让
「重启后自动续上」在用户开着两个及以上标签页时永远不触发（v0.2.0 修的就是这一条，见「偏差 1」）。

闸门① 只管**别的**会话。目标会话**自己**在跑一轮**不构成让位理由**（v0.2.1）—— 宿主刚启动时它的
`running` 只可能来自「重启插件刚注入的『已重启』那一轮」或「用户 4 秒内手速极快地发了条消息」，
两种情况都不该把交接记录拦下：`followup` 只是把记录**排进下一轮**，不打断当前轮。
见「[为什么「目标会话在跑」不再让位](#为什么目标会话在跑不再让位v021源码级核实)」。

## 多会话的保存与恢复（v0.4.0）

用户 2026-09-28 的要求：**`/sl` 与重启前的自动保存要覆盖所有活跃会话，重启后所有会话与子代理都自动唤回**。

| 项 | 口径 |
| --- | --- |
| 谁算"活跃" | `ctx.agents.list()` 里的每一个 live agent（顶层 + 子代理）。浏览器标签页订阅一个会话会把它 promote 成 live agent，所以**用户开着的标签页对应的会话都在里面**；从没被订阅过的会话不在（它此刻没有在飞的状态可交接） |
| 保存入口 | `slHandoff.saveAll({note, noteSessionId, session?}, note?)`；`note` 只写进 `noteSessionId` 那一份（其余留空 —— 重启前那句"下一步"是**发起重启那个会话**的话） |
| `/sl` 呢 | **`/sl` 也存所有活跃会话**（v0.4.1 起 —— v0.4.0 只有服务面覆盖全部，人敲的入口当时仍只存本会话，这是补上的那一处）：枚举同一张 live agent 表各存一份，`说明` **只写进当前会话那一份**（`noteSessionId` = 敲命令的那个会话），其余留空。两条入口（人敲的 `/sl` 与宿主插件调的 `saveAll`）走的是**同一个函数**，只是"谁给 `note`"不同 |
| 枚举不到时 | **fail-soft 退回"只存调用方那一个"**（`options.session`），并在日志与文案里如实说明。绝不因为枚举不到就一个都不存 |
| 每条记什么 | `sessionId` / `file` / `cwd` / `title` / `note` + **`kind`**（`root` \| `subagent`）+ 子代理的 **`parentSessionId`**（`session.header.parentSession`）+ `done`（见下）+ **`active` / `activeWhy`**（v0.5.1：保存那一刻有没有在飞的活，见「[空闲会话不注入](#空闲会话不注入v051)」） |
| 恢复顺序 | **先顶层、后子代理**（硬约束，见下）。组内保持标记里的原顺序（= 保存时的 `agents.list()` 顺序） |
| 恢复条数 | 默认**全部**；`resumeMaxSessions > 0` 时只恢复前 N 条，其余**留在标记里**（不是丢弃）并写一行日志，下次启动继续。**空闲条目不吃这个上限**（v0.5.1：上限是"叫醒几个"的预算） |
| 单条失败 | 只写一行日志、**留在标记里**，循环继续。永久性失败（会话被删、子代理不可冷恢复）会在每次启动重试一次，直到标记陈旧（`staleMs` 默认 24h）被归档 —— 这是刻意的取舍：失败大多是"这次启动还不行"，判死会把用户唯一那份交接消费掉。**子代理**条目还会**先唤醒它的直接父会话、再投递通知**（v0.5.0，每条只通知一次） |
| 空闲会话（v0.5.1） | `active:false` ⇒ **一个字节都不注入**（不 followup、不投递子代理、不通知父会话），只留记录文件与一行日志；**跳过 = 已处理**（照旧从标记里移除/随整份归档为 `done`，不留在 pending 里重试） |
| 整批让位 | 闸门② 热加载 / 闸门① 别的会话在跑 / `sessionController` 等不到 ⇒ **标记一个字节都不动**（连"移除成功条目"都不做），下次启动整批再判 |

### 为什么顺序是硬约束：冷恢复子代理要求「父 agent 已经活着」

子代理不是"另开一个会话"，它是**挂在某个父会话下的一段可继续的工作**。宿主的子代理服务在投递前会
校验授权链（源码位置与逐行引文见 `lib/index.js` 的 `injectIntoSubagent` 注释）：

- `subagents.prompt(request, signal)`（`@deepseek-ai/dsh-subagent/lib/index.js:3010-3037`）先做
  `const parent = this.ctx.get("agents")?.get(parentSessionId); if (parent === void 0) throw new RemoteError("subagent/parent-unavailable", …)`
  ⇒ **父会话必须此刻是 live agent**；
- 一路走到 `ContinuableActivationRegistry.authorizeLineage(parent, childId, parentSession)`（同文件 `:956-959`）：
  ```js
  if (this.ctx.agents.get(parent.id) !== parent) throw new SubagentError(
    `subagent "${childId}" delivery requires the exact live parent agent`, "UNAUTHORIZED");
  if (parentSession !== parent.id) throw new SubagentError(
    `subagent "${childId}" belongs to another parent session`, "UNAUTHORIZED");
  ```
  ⇒ 子代理的 `header.parentSession` 必须**逐字等于**父的 id ⇒ 记录里的 `parentSessionId` 必须是
  **直接父**，不能写祖先（写祖先会走到 "belongs to another parent session"）。

所以：**顶层会话没恢复之前，它的子代理条目注定失败** —— 顺序不能并行、不能倒过来。
代价是一批里若有 N 个顶层会话，子代理要等它们全部走完（每条几毫秒）才开始投递。

### 「部分成功」的归档语义与「重复注入」如何避免

**不重复注入靠的是"成功的条目从标记里移除"**，不是靠标记里的 `done` 位：

| 本次结果 | `pending.json` | 归档文件 | 会不会重复注入 |
| --- | --- | --- | --- |
| 全部注入成功（或**全部是空闲跳过**，v0.5.1） | 整份归档 | `pending.done-*.json`（全部 flush 成功）或 `pending.done-noflush-*.json`（有 flush 失败） | 不会（标记没了） |
| 部分成功（其余失败或超上限） | **写回**：只留未注入的那些，`createdAt` 保持原值 | 无归档（标记还在用） | 不会（已注入的与被跳过的都被移除了） |
| 一条都没成功、全是让位 | **原样不动** | 无 | 不会（本次什么都没注入） |
| 一条都没成功、全是明确不可恢复（空会话等） | 整份归档 | `pending.unresumable-*.json` | 不会 |
| 部分成功但**写回标记失败** | 整份归档（**不保留**） | `pending.done-partial-*.json`（写回也失败时另存 `.done.json` 旁证） | 不会（整份归档后不再被读到）——**宁可放弃重试，也不重复插话** |

`done` 位只在**写回失败**那条路上才有意义：那一刻磁盘上的标记还停在"什么都没做过"的旧内容上，
不写 `done` 的话下次启动会把已经注入过的条目**再插一遍**。所以归档证据里带上
`done` 与 `state`（`injected` / `failed` / `unresumable` / **`idle`**（v0.5.1：空闲跳过，不是失败）），
一眼能看出"哪些做过、哪些没轮到"。

## 子代理唤不回来时通知父会话（v0.5.0）

**要解决的问题**：重启会把在飞的子代理硬杀掉，而恢复流程没把它叫起来时，旧版**只往插件日志里写一行**
（`恢复条目失败（留在标记里，下次启动重试）：子代理 … —— 原因`）—— 父会话**一无所知**：它既看不到
"那个子代理已经没了"，也看不到"它当时的结论可能没上报"，只会以为它**还在跑**或者**已经干完了**。

**做法**：`runResume` 里，**子代理**条目没唤回来时（可重试失败与明确不可恢复两类都算），给它的
**直接父会话**投一条用户消息 —— 走的是与顶层恢复**同一条原语**：`sessionController.resolveAgent(父 id)`
拿父 agent → `agent.followup(消息)`（排进父会话的下一轮，不打断它当前那一轮）。

`resolveAgent` 是**唤醒语义**（"解析出可用 agent，必要时把会话从持久化里冷唤醒"），所以父会话
**即使已经"死了"也会被叫醒后收到通知** —— 这是用户 2026-09-28 拍板的口径：**宁可多起一轮，也不漏通知**。
父会话通常已经被顶层那一轮恢复过（顺序是先顶层、后子代理），那时 `resolveAgent` 只是取回一个已经
在跑的 agent，**不会重复唤醒**。

> ⚠ **代价（诚实写下来）**：唤醒一个死会话 = **真的起一轮**（重建 Agent + 投递消息 + 模型开始跑），
> 会**消耗 token**。这是为了"一定送到"付的价：一个"父会话自己也没恢复成功"的场景，旧做法是
> 只写日志（父会话永远不知情），新做法是把父会话叫起来告它一声。想省 token 就把通知这条路关掉 ——
> 本版没有开关，需要的话得改代码（`notifySubagentFailureToParent` 的调用点）。

通知正文（`buildSubagentFailureNotice`，纯函数；标题常量 `SUBAGENT_FAILURE_HEADING` 渲染与用例共用）：

```text
【sl 交接】子代理未能唤回（dsh 重启后自动唤回时没能把它叫起来）

- 子代理：`session-cccc3333-3333-3333-3333-333333333333`
- 它挂在你（父会话 `session-aaaa1111-1111-1111-1111-111111111111`）名下
- 没唤回的原因：投递给子代理失败：宿主返回 subagent/not-resumable
- 它的交接记录：`%USERPROFILE%\.dsh\storages\sl-handoff\handoff-20260928163000123-cccc3333.md`

这条子代理很可能已被重启打断，它当时的结论可能**没有上报给你** —— 别把它当成已经完成，也别当成还在跑。
本插件会在下次 dsh 启动时再试一次；在那之前它不会有任何动静。

下一步建议（挑一条）：
- 用 `send_message` 手动把它续起来（它的 id 就是上面那个），让它汇报到哪一步、再继续；
- 或者先用 read 工具读上面那份记录，确认现状（半成品文件、有没有改坏东西）后自己接手。
```

| 项 | 口径 |
| --- | --- |
| 通知谁 | 只有**子代理**条目。顶层条目失败**不通知**（它没有父），保持旧口径只写日志 |
| 什么时候通知 | 该条目**失败刚确定**时逐条发（不是整批跑完再发）：循环里有 `isDisposed()` 早退与 await 挂起的可能，攒到收尾会让"已经确定的失败"一条都发不出去。顺序仍是先顶层后子代理 |
| 通知通道 | `sessionController.resolveAgent(parentSessionId)`（**唤醒语义**，与顶层恢复同一条原语、同一套判错形状）→ `agent.followup(用户消息)`。父会话活着时是幂等的取回；死了就把它叫起来 |
| 唤醒/投递失败时 | `sessionController` 服务缺席或没有 `resolveAgent` / `resolveAgent` 返回 `{error}`（含不可恢复）/ `resolveAgent` 抛错 / 拿到的 agent 没有 `followup()` / `followup` 抛错 ⇒ **只写一行日志**，不抛、不影响其它条目、不改本次恢复结果与归档语义。**不置位** ⇒ 下次启动还能补发。这种情形下**这一轮父会话确实不知情** |
| 每条只通知一次 | 通知**真的投出去**之后，在该标记条目上写 `notified: true`（随条目写回 `pending.json`，也随条目进 `done-partial` 的归档证据）。下次启动看到 `notified: true` 就只写一行日志、不再通知 |
| 通知 ≠ 恢复成功 | 条目**该留在标记里就留着**（下次启动照旧重试）、**该归档就归档** —— `notified` 只回答"父会话知不知情"，不改变任何恢复/归档判定 |
| 通知 ≠ 无损 | 通知只是"父会话知道了"。子代理**没有**被救回来，它的那一步工具调用仍然丢了（见「已知限制」的「恢复 ≠ 无损」） |

`notified` 与 `done` 是**两个不相干的位**：`done` = "这条注入成功过"，`notified` = "这条失败时通知过父会话"。
所以一条 `notified:true` 的条目照旧留在标记里、照旧在下次启动重试（这正是"防刷屏"与"不放弃重试"并存的方式）。

## 空闲会话不注入（v0.5.1）

**要解决的问题**（用户 2026-09-28 报的 bug）：2026-09-28 23:05 那次重启，`dsh-host-sl` 把 4 个顶层会话
各存了一份交接，重启后**4 条全被 `followup` 唤醒** —— 但其中 **3 个会话在保存那一刻是空闲的**
（同一份日志原话：`会话检测: 顶层会话 4 个(本轮运行 1 个), 其它有活在跑 0 个`），它们各被无端唤醒、
各白跑了一整轮（3~4 次工具调用）。

根因有两条，缺一不可：

- **保存侧不区分「有活在跑」与「只是开着」**：`saveAll` 枚举的是 `ctx.agents.list()` 里**活着的** agent，
  而"活着"≠"在跑" —— 浏览器标签页订阅一个会话就把它 promote 成 live agent（见「偏差 1」），
  用户开着的标签页对应的会话全在里面；
- **恢复侧只有一种原语**：`followup` = 入队 **且** 驱动新一轮，没有"只入队不唤醒"或"什么都不做"的分支。

用户拍板的语义（本版实现的就是这两条）：

1. **空闲会话 ⇒ 完全不注入**（不排队、不唤醒），只在磁盘上留记录文件（用户想续可以自己 `read`）；
   该条目按"已处理"归档，**不能永远挂在 pending 里重试**。
2. **有活跃 goal（`phase === 'active'` 且 `activation === 'armed'`）但当前空闲的会话 ⇒ 算「有活」**，照旧唤醒。

### 判据四条（保存那一刻有没有在飞的活）

与 `dsh-host-restart` 的会话检测（`detectRunningSessions`）**同源** —— 那边回答"重启会打断谁"，
这边回答"重启后该不该把它叫回来"，所以判据必须是同一套，否则两边会给出矛盾的结论。

| `activeWhy` | 判据 | 实现口径 |
| --- | --- | --- |
| `session` | 会话**自己在本轮运行** | `agent.status === 'running'`（"等审批/等回答"也是 running） |
| `subagent` | 名下还有**正在跑的子代理** | live 表里 `header.origin === 'subagent'`、`status === 'running'`、且沿 `session.header.parentSession` 上溯到顶**等于本会话**（任意深度；与 `subagentsOf` 用同一个 `lineageTopId`） |
| `job` | 名下还有**未结算的后台作业** | `ctx.get('jobs').list(ownerId)` 里 `job.owner` **精确等于**该会话、且状态 ∈ {`running`,`stopping`}（形状照抄 `dsh-host-restart` 的 `runningJobCount`：`list()` 会把无主作业一并返回，不筛就张冠李戴） |
| `goal` | 有**活跃 goal** | `ctx.get('goals').get(agent)` 的 `phase === 'active'` 且 `activation === 'armed'`（读法照抄 `dsh-host-goal-subagent-gate`；参数必须是**exact live agent 对象**，传会话 id 会被 `assertLive` 拒） |

四条**任一命中即 `active: true`**，`activeWhy` 按 `session` / `subagent` / `job` / `goal` 的固定顺序
记下命中的那几条（排障用：一眼看出这条会话是因为什么被判成"有活"的）。四条全不命中 ⇒ `active: false`。

### fail-soft（三条，宁多唤醒一次，也不丢掉在飞的活）

| 情形 | 结论 |
| --- | --- |
| `agents` 服务拿不到 / 形态不符 / **目标会话不在 live 表里** | **无法判定 ⇒ `active: true`** + 一行日志。理由：枚举不到时保存侧本来就走"只存调用方那一个"的退路，那条退路上的会话更不该被当成空闲 |
| `jobs` / `goals` 缺席或抛错 | **只影响对应那一条判据**，其余判据照常（各自写一行日志说明这条判据本次不参与） |
| 判定整体抛错 | **`active: true`** + 一行日志（绝不让判定失败变成"少唤醒一个会话"） |

`jobs` 那条判据本身还有一层 fail-soft：服务缺失/抛错当作"0 个作业"（与 `dsh-host-restart` 同口径）。
它的保守方向与其余三条相反，但 ①②④ 任一命中就足以判"有活"，所以不改变结论。

### 分流语义（恢复侧）

| 条目状态 | 恢复侧行为 |
| --- | --- |
| `active: true` | 照旧：顶层 `resolveAgent` + `followup`，子代理走 `subagents.prompt` 冷恢复 |
| `active: false` | **一个字节都不注入**：不 `followup`、不投递子代理、不 flush、**不通知父会话**；只写一行日志 `空闲会话 <id> 未注入（保存时无在飞的活），记录文件在 <路径>` |
| `active` 缺失（v0.5.0 及更早写的标记） | **按"有活"处理、照旧唤醒**，并写一行日志 `标记缺 active 字段（旧版），按"有活"处理` —— "没判过"绝不能当成"空闲"（那会静默丢掉在飞的活） |

**跳过 = 已处理**（用户明确要求的那一条）：`active:false` 的条目与"注入成功"的条目走**同一条收尾路径** ——
从 `pending.json` 里移除，一条不剩时随整份标记归档为 `done`，**不会留在 pending 里反复重试**。
两处配套细节：

- **空闲条目不吃 `resumeMaxSessions` 上限**：那个上限是"这次叫醒几个会话"的预算，"不叫醒"不该消耗它，
  否则空闲条目会把真正有活的条目挤到下次启动；
- **空闲条目也算"本批目标"**（闸门① 的排除名单把 `plan.queue` 与空闲条目一起算）：它们同样是这一批的
  条目，只是按设计不注入。不这么算的话，一个空闲会话在重启后那 4 秒里被用户敲了一下（变成 `running`）
  就会让**整批**让位 —— 真正有活的条目被推迟到下次启动，而那个空闲会话自己根本不需要注入；
- **写回失败时的归档证据**（`done-partial`）里，空闲条目写 `state: 'idle'`（不是 `failed`）——
  免得事后把它们误读成"没轮到"。

汇总日志多了一类计数（**排障第二现场**）：

```text
本次恢复结束：注入成功 1 条 / 跳过 3 条（空闲，不注入） / 失败 0 条（其中让位 0 条、明确不可恢复 0 条） / 超上限留下 0 条（flush 失败 0 条）⇒ 归档为 done
```

### 记录文件照旧写

空闲会话**也写记录文件**（这是用户唯一能看到的痕迹）：保存侧的判定发生在记录写完之后，
判定结果只影响待续标记里的 `active` 位与恢复侧的分流，不影响"存了谁"。
`/sl` 与 `saveAll` 的成功文案里照旧列出全部记录路径（会话多时折成 `- …等 N 个`），
日志里另有一行回显这次有几个是空闲的：`其中 N 个会话保存这一刻没有在飞的活（active=false）⇒ 重启后不唤醒它们，只留记录文件`。

## 为什么合并（v0.6.0）

**用户的原话**（2026-09-29 拍板）：

> 敲了 `/sl` 之后走重启工具重启，不该把 `/sl` 存档里那些（此刻已关掉的）会话条目丢掉。

**怎么丢的**：`/sl` 与"重启前保存"（`dsh-host-sl` 的 `saveAll`，由 `dsh-host-restart` 在杀进程前调用）
写的是**同一个** `pending.json`，而写入是**覆盖**语义。于是这条时间线会丢条目：

```text
用户敲 /sl                     →  pending.json = [A, B, C]   （三个会话，各有一份记录文件）
（中间 B 的标签页被关掉）        →  B 从 live 表里消失，但记录文件与标记条目都还在
用户调 restart_dsh 重启         →  重启前 saveAll 只枚举到 A、C
                                →  覆盖写 pending.json = [A, C]   ← B 的条目没了
新进程启动                      →  只恢复 A、C；B 的记录文件还躺在磁盘上，但**永远不会被注入**
```

**现在的语义**：写标记之前先看磁盘上那份旧标记 —— 判为**新鲜**（`classifyPending` 判 `fresh`，
即"它本来就会被恢复流程消费"）就按会话 id **取并集**：

| 情形 | 结果 |
| --- | --- |
| 两边都有同一 `sessionId` | **用新条目**（新记录文件、新的 `active` 判定、新的 note） |
| 只有旧标记有 | **保留旧条目原样**（`file` / `kind` / `parentSessionId` / `active` / `activeWhy` / `notified` 一个字段都不动 —— 漏一个就等于把那个持久位抹掉） |
| 只有新的 | 用新条目（追加在保留的旧条目之后） |
| 旧标记里 `done === true` | **不合并**（它已经注入过，合并回来只会被再注入一次） |

- **`createdAt` 按本次保存算**（新鲜度按本次）—— 合并出来的标记是"这次保存的标记"，不是"上次那份"。
- **顺序**：保留的旧条目按旧顺序在前，本次新增的追加在后；同一 `sessionId` 被新条目顶替时保持旧位置
  （顺序只影响 `resumeMaxSessions` 截断谁，稳定比"看起来更新"更重要）。
- **日志**（每次保存都写一行，排障第一现场）：
  `与已有新鲜标记合并：本次新增 2 条、保留 1 条（其中 1 条此刻已不在 live 表里）`
  —— 括号里那句正是这次要修的场景（"已不在 live 表里"= 标签页已关/已被回收，枚举不到它，
  但它照样会被恢复）。枚举不到 live 表时写 `（live 表读不到，"其中多少条已不在 live 表里"没统计）`。

**失败语义（fail-soft，绝不抛）**：陈旧标记 / 读不出 / 形态不符 ⇒ **不合并**，照旧覆盖写入，
并写一行日志说明为什么（`未与已有标记合并（旧标记判定为 stale）…` / `（JSON 解析失败…）` /
`（旧标记形态不符…）`）；**没有旧标记**是正常路径，写一行 `（没有旧标记）` 后直接写入。
"一个都没成功时一个字节都不写标记"这条铁律不变（合并不碰它）。

**已知边界（如实写下来）**：

- 合并的判据是"旧标记**新鲜**"，与恢复侧同一把尺子（同一个 `classifyPending`）—— 陈旧的那份本来就要
  被归档，把它并进来只会让一条几周前的交接被重新注入；
- 保留的旧条目是**经 `normalizePending` 读入**的形状 ⇒ 缺失的可选位会补默认值
  （`done:false` / `notified:false` / `kind:'root'` / 空 `cwd`·`title`·`note`），语义不变；
  `active` / `activeWhy` 的"未知"照旧保持未知（不凭空写成 `true`）；
- 并集只按 `sessionId` 去重，**不看记录文件内容**：同一会话被保存两次时，旧记录文件仍在磁盘上
  （只是不再被标记引用），这是有意的 —— 记录文件是审计线索，从不删。

## 落盘位置与文件格式

**位置**：`<DSH_HOME>\storages\sl-handoff\`（本机 = `%USERPROFILE%\.dsh\storages\sl-handoff\`）。
**不写用户工作区**（第三方插件写 `<cwd>\.dsh-handoff\`，本插件不学）。

| 文件 | 内容 | 生命周期 |
| --- | --- | --- |
| `handoff-<yyyyMMddHHmmss><毫秒3位>-<会话前8位>.md` | 交接记录正文（Markdown） | 每次保存新增一份，**不删**（审计线索，也是注入内容的来源） |
| `pending.json` | 唯一的「待续」标记 | 每次保存写入（**v0.6.0 起先与磁盘上那份新鲜旧标记按会话 id 取并集**，见「[为什么合并](#为什么合并v060)」）；恢复时**已注入的条目被移除**（剩下的写回）；一条不剩或判定陈旧时改名为 `pending.<原因>-<时间戳>.json` |
| `pending.<原因>-<时间戳>.json` | 归档 | 原因取值：`done`（全部注入成功且已落盘）/ `done-noflush`（注入成功但 flush 失败，**消息可能没落盘**）/ `done-partial`（部分注入成功、写回标记又失败）/ `stale` / `invalid` / `unresumable` / `failed` |
| `pending.<原因>-<时间戳>.json.done.json` | 归档证据的**旁证**（只在"写回标记失败、连归档内容也写不进去"时出现） | 里面是整批条目的终态（`done` + `state`） |
| `sl-handoff.log` | 流程日志（宿主 logger 只进内存 buffer、不落盘，所以这里单独落一份） | 追加 |

文件名里的时间戳**精确到毫秒**：精确到秒时，同一会话在同一秒里敲两次 `/sl` 会算出同一个文件名，
后一次把前一次**直接覆盖**（两份交接只剩一份，而且没有任何迹象）。毫秒段长度固定 3 位，
数字字典序仍等于时间序，所以按名字排序就是时间顺序。

**`pending.json` 格式（v0.3.0 起是 v2 的列表结构；v0.4.0 加三个可选字段，v0.5.0 加一个，v0.5.1 再加两个，
v0.6.0 只改**写入**语义、形状一个字节都没变）**：

```json
{
  "version": 2,
  "createdAt": 1759048200000,
  "items": [
    {
      "sessionId": "session-aaaa1111-2222-3333-4444-555555555555",
      "file": "%USERPROFILE%\.dsh\\storages\\sl-handoff\\handoff-20260928163000000-aaaa1111.md",
      "cwd": "<工作区>",
      "title": "实现 dsh-host-sl 插件",
      "note": "继续把 README 写完",
      "kind": "root",
      "parentSessionId": "",
      "done": false,
      "notified": false,
      "active": true,
      "activeWhy": ["session"]
    },
    {
      "sessionId": "session-cccc3333-3333-3333-3333-333333333333",
      "file": "%USERPROFILE%\.dsh\\storages\\sl-handoff\\handoff-20260928163000123-cccc3333.md",
      "cwd": "<工作区>",
      "title": "",
      "note": "",
      "kind": "subagent",
      "parentSessionId": "session-aaaa1111-2222-3333-4444-555555555555",
      "done": false,
      "notified": true,
      "active": false,
      "activeWhy": []
    }
  ]
}
```

- **为什么是列表**：`/sl` 与"重启前保存"的方向是**覆盖所有活跃会话**（用户 2026-09-28 的要求；
  v0.4.1 起 `/sl` 也真的这么做了 —— v0.4.0 时只有服务面覆盖全部）。
  一次调用只写**一份**标记，条目 = 这次保存成功的那些会话；单会话就是"列表长度为 1"，
  行为与 v0.2.x 完全一致。**v0.4.0 起恢复侧消费全部条目**（先顶层、后子代理，见「多会话的保存与恢复」）。
- **六个可选字段（v0.4.0 三个 + v0.5.0 一个 + v0.5.1 两个）**：
  - `kind`：`'root'` | `'subagent'`，恢复侧据此选投递路径。**缺失或形态不符一律按 `root`** ——
    v0.3.0 写的标记没有这个字段（它当时只存顶层会话），拿不准时绝不当成子代理
    （那会让一个真实顶层会话走进子代理投递路径、必然失败）；
  - `parentSessionId`：子代理的**直接父**会话 id（`session.header.parentSession`），投递时必需。
    必须是直接父 —— 宿主的 `authorizeLineage` 会校验 `parentSession === parent.id`，写祖先会被拒；
  - `done`：这条是否**已经注入成功过**。只在"写回标记失败"那条兜底路上才会被读到（见上表），
    正常情况下成功的条目是**直接从标记里移除**的。
  - `notified`（v0.5.0）：这条**没唤回来时是否已经通知过它的父会话**（防刷屏，见
    「[子代理唤不回来时通知父会话](#子代理唤不回来时通知父会话v050)」）。缺失按 `false`；
    只有"通知真的投出去了"才为真（投递前会先 `resolveAgent` **唤醒**父会话），通知失败不置位
    （下次启动可以再试）。它与 `done` 无关：`notified:true` 的条目**照样**留在标记里重试、
    照样按原语义归档。
  - `active`（v0.5.1）：这条会话在**保存那一刻有没有在飞的活**（判据四条见
    「[空闲会话不注入](#空闲会话不注入v051)」）。**只认布尔值**：`false` ⇒ 恢复侧一个字节都不注入；
    `true` ⇒ 照旧唤醒；**缺失/形态不符 ⇒ 保持"未知"**（`normalizePending` 不补默认值），
    由 `runResume` 按"有活"处理并写一行日志 —— v0.5.0 及更早写的标记没有这个字段，
    绝不能把"没判过"当成"空闲"（那会静默丢掉在飞的活）。保持未知还让**写回标记时不会凭空添上**
    `active:true`（旧条目原样保留，不会伪装成"判过"）。
  - `activeWhy`（v0.5.1）：命中哪几条判据（取值 `session` / `subagent` / `job` / `goal`，固定顺序），
    纯排障用。只有在真的判过（`active` 是布尔）时才写出。
- **版本号没有跟着涨（仍是 `version: 2`）**：0.4.0 / 0.5.0 / 0.5.1 加的都是**可选字段**，v2 的列表形状没变。
  旧版读新标记只会忽略不认识的字段（最坏后果：一次重复注入 / 一次重复通知，**不是数据损坏**）；
  换版本号反而会让旧版把整份标记判成 `invalid` 归档掉 —— 那才是真丢数据。
- **v1 兼容**：≤0.2.2 写下的单会话标记（`{version:1, sessionId, file, createdAt, …}`）仍然读得进来
  —— `normalizePending` 把它当成"1 条"（新字段一律补默认：`kind:'root'` / `notified:false`；
  `active` / `activeWhy` 例外，见上）。
  不这么做的话，升级后第一次启动会把上一份**还能用**的交接判成 `invalid` 直接归档掉（升级丢数据）。
- **一个都没成功就不写**：读不出会话历史等失败情形下**一个字节都不动**，上一份标记原样保留
  （设计点 12，单会话时就是"拒绝保存"）；部分成功时标记里只放成功的那些。

**记录正文格式**：固定章节的 Markdown，无 front-matter、无 JSON。机器解析只该依赖 `pending.json`，
正文是给人（和下一个模型）读的：

```markdown
# 会话交接记录

- 会话 id：`session-…`
- 标题：…
- 工作目录：`…`
- 保存时间：2026-09-28T08:30:00.000Z（UTC）
- 历史消息：42 条（用户 12 / 助手 14 / 工具调用 16）

## 下一步

（/sl 的说明，或「（保存时未填写说明 …）」）

## 保存时在跑的子代理

- `session-aaaa1111-…`　标题：补测试　最近用户目标：把 README 的排障表补齐
（没有 ⇒ `（无）`；服务读不到 ⇒ `（无法读取：<原因>）`）

## 用户目标（最近 5 条）      ← 只收真人消息（v0.2.2，见下）
## 最近进展（助手回复，最近 3 条）
## 最近工具调用（最近 6 条）

## 续跑指引
```

时间一律 **ISO(UTC)**：本地时区会让同一份输入在不同机器上渲染出不同文本，测试就钉不住了。
各节都有条数与单行长度上限（`SECTION_LIMITS`），保证记录通常只有 2~4 KB，能整条注入。

### 「保存时在跑的子代理」这一节（新增能力）

动机就是本插件最初要解决的问题：**重启会硬杀在飞的子代理，事后从协调者视角看与「正常完成」
无法区分**。会话消息历史里看不到它们，所以保存时额外记一笔。

| 项 | 口径 |
| --- | --- |
| 收谁 | 血缘归属于**本会话**、且此刻 `status === 'running'` 的子代理（任意深度） |
| 血缘判定① | `agent.session.header.origin === 'subagent'` —— fork 会话共享 `parentSession` 但没有这个 origin，它是独立对话，不算（与 `dsh-subagent` 的 `runningDescendants` 同一口径） |
| 血缘判定② | 沿 `session.header.parentSession` 上溯到顶等于本会话 id（思路照本机 `dsh-host-restart` 的 `lineageTopId`，**只读不改那个包**） |
| 每条写什么 | 会话 id；标题（`sessionTitle` 可选服务，拿不到留空）；最近一条用户消息（它收到的派活指令，读不到写「（读不到）」） |
| 上限 | 最多 8 条（`SECTION_LIMITS.subagents`），超出写「…（还有 N 个未列出）」 |
| 没有子代理 | `（无）` |
| 服务不可用 / 形态不符 | `（无法读取：<原因>）` —— **绝不**把「读不到」渲染成「没有」 |
| 注入引导语 | 会提醒一句：这一节列出的子代理「很可能已被重启打断、结论可能没上报」 |

`agents.list()` 是唯一含子代理的入口（`roots()` 按 `owner === undefined` 过滤，子代理天然不在里面）。
取不到 `agents` 服务、`list()` 形态不符或抛错时 fail-soft：这一节写「（无法读取）」，**整次保存照常成功**
（不能因为一节辅助信息把交接本身弄丢）。

### 「用户目标」只收真人消息（v0.2.2，源码级核实）

**问题（实测现场）**：真实产出的记录 `handoff-20260928105124235-aaaa1111.md` 里，`## 用户目标（最近 5 条）`
有 **4 条不是用户说的话**，全是宿主以"用户消息"身份注入的系统噪音 —— 子代理结算通知、`<system-reminder>`
（AGENTS.md 更新提醒）、时间采样提示、子代理来信。这一节是记录的核心（"重启前你在做什么"），
被噪音占满后下一个进程读到的"用户目标"基本是错的。

**核实方法**：解开本机该会话的会话文件（`~\.dsh\sessions\…\session-aaaa1111-….jsonl.zstd`，只读），
按 `source.kind` 统计 33 条 user 角色消息：

| `source.kind` | 条数 | 生产者（源码位置） | 正文开头 |
| --- | --- | --- | --- |
| `user` | **2** | 真人：Web 侧 `dsh-api-session-controller/lib/index.js:856-860`（`{kind:'user', rpcId, clientTimeZone}`）；本机 `dsh-host-restart/lib/index.js:727-730` 也用它（注入「已重启」） | `@TODO.md` / `已重启。…` |
| `subagent-settled` | 8 | `dsh-subagent/lib/types/continuation-messages.js:98-103` | `Background subagent <id> finished and will do no further work unless you send it more.` |
| `agent-message` | 7 | 同文件 `:8-13` | `Agent <id> sent a message: …` |
| `time-context` | 6 | `dsh-time-context/lib/index.js:102`（`name`）+ `:231-244` | `Time sampled while preparing turn <t>, step <s>: …` |
| `agent-instructions` | 4 | `dsh-agent-instructions/lib/index.js:767-777` | `<system-reminder> Updated instructions from: AGENTS.md …` |
| `goal` | 4 | `dsh-goal-round-driver/lib/index.js:134-142` | `<goal_round> Objective: …` |
| `runtime-context` | 1 | `dsh-agent-loop/lib/index.js:218` | `Current runtime context. This snapshot supersedes …` |
| `skill-catalog` | 1 | `dsh-tool-skill/lib/index.js:256` | `<system-reminder> A skill is a reusable …` |

⇒ **系统注入与真人消息在 `source.kind` 上就能分开**，不需要猜正文（这是判据的第一层，也是唯一一层结构判据）；
唯一例外是 `dsh-host-restart` 那条「已重启」（它自称 `kind:'user'`），只能退到正文形态，见下面第 3 层。

**判据（`isUserAuthoredMessage`，`lib/index.js`）分三层**：

1. `source.kind === 'user'` ⇒ 收。宿主每条 user 角色消息都带 `source`（`MessageBase.source` 是必填），
   其它前端（headless / SDK / ACP）与「父代理派给子代理的任务指令」（`dsh-subagent/lib/types/continuation.js:174`）
   也都是 `{kind:'user'}` —— 它们本来就该收。
2. `source` 缺失 / 形态不符 ⇒ **不收**（拿不准时宁可漏收也不收噪音）：那一节宁可为空（渲染成「（无）」，
   一眼看得见），也不把来源不明的消息冒充成用户目标。代价见「已知限制」。
3. 正文前缀过滤（**只在 kind 分不开时用**，共两条）：`【sl 交接续跑】`（本插件自己的注入，既有行为）
   与 `已重启。`（本机 `dsh-host-restart` 的注入 —— 它的 `source` 与真人消息**逐字同形**，kind 层面无解，
   只能按它那条固定开场白 `DEFAULT_INJECT_TEXT[0]` 过滤；用户补充的说明只追加在后面，所以 `startsWith` 足够）。

**「最近进展」与「最近工具调用」不需要同类过滤**（已核实，不是想当然）：助手角色的消息只有
`createAssistantMessage` 一个生产者，它把 `source.kind` 钉成 `'model'`（`dsh-llm/lib/types/message.js:64-73`），
而 tool-call 块只存在于助手消息里 ⇒ 这两节在结构上不可能混进宿主注入的消息。
实测：同一个会话文件里 55 条 `assistant/message` 全部是 `kind:'model'`。

**修后的实测对照**（同一份会话文件，只读跑一遍新的归纳逻辑）：`## 用户目标` 从 5 条（4 条噪音）
变成 **1 条** —— `@TODO.md`，就是那条真人消息。

## 命令与服务契约

**`/sl [说明]`**（`ctx.commands.register`；v0.4.1 起 = "存所有活跃会话"）

| 项 | 值 |
| --- | --- |
| `name` | `sl` |
| `description` | `保存交接记录（所有活跃会话各存一份），下次 dsh 启动时自动把记录注入回这些会话并续上` |
| `input.hint` | `[下一步说明]` |
| 存谁 | **所有活跃会话**（`ctx.agents.list()` 里的每一个 live agent，顶层 + 子代理各一份记录）。`说明`（`rawInput` trim 后）**只写进当前会话那一份**的「下一步」，其余留空 |
| 成功 | `{kind:'success', text}` —— `text` 就是 `saveAllActiveSessions` 的汇总文案（多行，形状见下面三段实测） |
| 成功（**枚举不到 live agent 表**，fail-soft） | 头一行改成 `交接记录已保存（退回只存当前会话）：`，并多一行 `枚举不到活跃会话表：<原因>。已退回「只存当前会话」这条 fail-soft 路径。` —— **不冒称"所有活跃会话"** |
| 失败 | `{kind:'error', text:'交接未保存：<原因>'}`（**读不出会话历史也走这条**，且不覆盖 `pending.json`；退回路径下这条原因前面还会带上"已退回只存当前会话"那句） |
| 拒绝 | 没有归属会话、**当前会话是子代理会话**（`/sl` 是人敲的顶层入口；枚举到的**其它**子代理照常各存一份） |

成功文案的实际形状（`<storageDir>` 处是绝对路径；这是照代码写出来的，与 `test/multi-session.test.mjs`
G 组的断言一致）：

```text
交接记录已保存（所有活跃会话，共 3 个：顶层 2 / 子代理 1）：
- <storageDir>\handoff-20260928135632572-aaaa1111.md
- <storageDir>\handoff-20260928135632574-cccc3333.md
- <storageDir>\handoff-20260928135632575-bbbb2222.md
待续标记：<storageDir>\pending.json
下次 dsh 宿主启动时，本插件会先把顶层会话、再把子代理逐个注入回这份记录并起新一轮（标记 24 小时内有效）。
```

会话多于 3 个时，第 4 条起折成一行（`MESSAGE_MAX_LISTED = 3`）：

```text
交接记录已保存（所有活跃会话，共 6 个：顶层 3 / 子代理 3）：
- <storageDir>\handoff-…-aaaa1111.md
- <storageDir>\handoff-…-bbbb2222.md
- <storageDir>\handoff-…-eeee5555.md
- …等 3 个（完整清单见待续标记的 items[].file）
待续标记：<storageDir>\pending.json
下次 dsh 宿主启动时，…（标记 24 小时内有效）。
```

枚举不到 live agent 表（fail-soft 退路）时：

```text
交接记录已保存（退回只存当前会话）：
- <storageDir>\handoff-…-aaaa1111.md
待续标记：<storageDir>\pending.json
枚举不到活跃会话表：agents 服务没有 list()（枚举不到 live agent）。已退回「只存当前会话」这条 fail-soft 路径。
下次 dsh 宿主启动时，…（标记 24 小时内有效）。
```

> v0.4.1 的改动（用户 2026-09-28 的要求）：`/sl` 原来走单会话那条路（`saveHandoffBatch`），
> 现在走 `saveAllActiveSessions`（与 `dsh-host-restart` 调的 `saveAll` 同一个函数）——
> 命令与服务不再有"存谁"的差别，只有"谁给 `note`"的差别。两条拒绝口径与失败前缀都没动。
>
> 失败文案的前缀 v0.3.0 起从 `sl 未保存：` 改成中性的 `交接未保存：`，而且**前缀加在命令这一层**
> —— 服务面给消费者的是裸原因（见下表），这样 `dsh-host-restart` 才能写成自己的语境
> （"重启前的会话交接未保存：<原因>（不影响本次重启）"），而不是出现"未保存：未保存"。

**cordis 服务 `slHandoff`**（`ctx.provide`，v0.3.0 取代模型工具；`dsh-host-restart` 的调用面）

| 项 | 值 |
| --- | --- |
| 服务名 | `slHandoff`（导出常量 `SERVICE_NAME`） |
| 方法① | `save(sessions, note?)` —— **同步返回**（内存读取 + 小文件同步写），**从不抛异常**（失败折成 `ok:false` + 可读原因） |
| 方法②（v0.4.0） | `saveAll(options?, note?)` —— 同上，但"存谁"不同：**所有活跃会话**（`ctx.agents.list()` 里的每一个 live agent，顶层 + 子代理各一份记录）。`options = {note?, noteSessionId?, session?, all?}`：`note` 只写进 `noteSessionId` 那一份记录（其余留空）；`session` 是**枚举不到 live agent 表时的退路**（"只存调用方那一个"，文案里会如实说明是退回）。也接受 `saveAll(session, note)` 这种直接传会话的写法。返回面与 `save` 完全相同。**v0.4.1 起 `/sl` 命令就是调它**。**v0.5.1 起**还给每条标记条目判一个 `active` 位（保存那一刻有没有在飞的活）—— 它只落在 `pending.json` 的条目上，**不在返回面里**（返回面的 `items` 形状没变） |
| 方法③（v0.6.0） | **`pendingSummary()`** —— 待续标记的**只读摘要**：`{exists: true, items: [{sessionId, kind, done, active, wake}]}` 或 `{exists: false, reason, items: []}`（没有标记 / 读不出 / 形态不符）。**只读、不写盘、从不抛**（同步返回，调用前后 `pending.json` 一个字节都不变）。条目五个字段的语义：`kind` = `root`/`subagent`；`done` = 是否已注入过；`active` = 保存那一刻有没有在飞的活（**三态**：`true`/`false`/`undefined`，后者是旧版标记"没判过"，恢复侧按"有活"处理）；`wake` = **恢复侧这次会不会唤醒它**（= `done !== true && active !== false`，把上面两个位折成一个布尔）。消费者是本机 `dsh-host-restart` v0.4.2：它据此判断"这次重启的续跑消息该由谁注入"（有人接手就不自己注入，**一次重启只注入一条消息、只跑一轮**；**`active` 不参与那条判断** —— 空闲条目同样会被处理掉并归档） |
| `sessions` | **一个会话对象，或一组会话对象（数组）**。会话对象 = `invocation.agent.session` / `exec.agent.session` 那种（不是 sessionId）—— 保存要读它的 `deriveMessages()`、`header.cwd` 与血缘 |
| `note` | 可选，整批共用，作为每份记录里的「下一步」；非字符串按空处理 |
| 返回 | `{ok, saved, failed, items, message, pendingFile?, createdAt}`：`ok` = **全部成功**；`items` 逐会话结果（成功 `{ok:true, sessionId, file, cwd, title, note, kind, parentSessionId, stats}`、失败 `{ok:false, sessionId, message}`）—— 消费者要展示"存到哪了"就读 `items[].file`（**文案里的路径清单在会话多时会截断成「…等 N 个」，别从 message 里抠路径**）；成功时 `message` 是可直接展示的汇总（写清存了几个会话），失败时是**裸原因** |
| 成功文案（v0.5.1 补充） | 文案形状没变（照旧列出记录路径 + 条数）。**空闲会话也在文案里**（它的记录文件真的写出来了）—— "这次有几个是空闲的"只写进**插件日志**（`其中 N 个会话保存这一刻没有在飞的活（active=false）⇒ 重启后不唤醒它们，只留记录文件`），不进命令/工具结果 |
| 写盘 | 每个会话一份记录文件；**整批只写一份** `pending.json`（v2 列表；**v0.6.0 起写之前先与那份新鲜旧标记取并集**）；**一个都没成功 ⇒ 一个字节都不写标记** |
| 与 `/sl` 的关系 | v0.4.1 起**就是同一条路**：`/sl` 调 `saveAllActiveSessions`（`saveAll` 的实现），差别只有"`note` 给谁"——人敲的给当前会话，`dsh-host-restart` 给发起重启的会话。`save()` 仍是指定会话那条路，语义完全一致：读不出历史就拒绝保存、**指定会话那条路**上子代理一律拒绝（`saveAll` 收子代理 —— 它是"把在飞的工作都记下来"的那条路） |
| **消费者注意** | **不要**把服务名写进 `inject`（inject 是"全有才 apply"的硬门，写进去就等于"本插件没装时消费者整个不 apply"）；用 `ctx.get('slHandoff')` **可选读取** + fail-soft。本机 `dsh-host-restart` 就是这么做的，见它的 README §4 |

服务随**提供它的 fiber** 卸载自动注销（`ctx.provide` 内部就是 `fiber.effect`），所以本插件
不需要额外的清理代码；依据与逐行出处（cordis `lib/index.js:800-824`、`src/fiber.ts:407-408`）
写在 `lib/index.js` 的 `registerService` 注释里。

## 配置项（插件 config，一般不用动；测试靠它隔离）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `home` | `$DSH_HOME` 或 `~\.dsh` | 数据根 |
| `storageDir` | `<home>\storages\sl-handoff` | 落盘目录 |
| `pendingFile` | `<storageDir>\pending.json` | 标记路径 |
| `logFile` | `<storageDir>\sl-handoff.log` | 日志路径（**配置解析失败时**退到 `DSH_SL_LOG_FILE` 环境变量或 `<home>\storages\sl-handoff\sl-handoff.log`） |
| `staleMs` | `86400000`（24h） | 标记新鲜度上限，超时归档不注入 |
| `bootDelayMs` | `4000` | apply 后延迟多久开始恢复（避开启动风暴） |
| `controllerWaitMs` | `30000` | 等 `sessionController` 出现的上限 |
| `bootGraceMs` | `300000`（5min） | 闸门②：进程运行超过它就判定为热加载 |
| `resumeTextMaxChars` | `6000` | 注入消息总长上限，超长截断并指向记录文件 |
| `resumeMaxSessions` | `0`（**不限**） | 一次启动最多恢复多少条标记条目。`0` = 全部恢复（用户要的是"所有会话都唤回"）；`>0` 时只恢复**前 N 条**（顺序 = 先顶层、后子代理），其余**留在标记里**、写一行日志，下次启动继续（标记 24h 内有效）。**v0.5.1 起空闲条目（`active:false`）不占这个上限**（上限是"叫醒几个会话"的预算）。条目数天然有界（受宿主 `maxActiveSubagents` 与用户开着的标签页数限制），所以默认不限是安全的 |
| `requireColdAgent` | `false` | `true` 时额外要求 `agentAvailable === false`（= PLAN §2 的字面口径，见「偏差 1」）。**与默认口径的差别**：默认**完全不看目标会话在不在跑**（v0.2.1 起；在跑也只是把记录排进它的下一轮），`agentAvailable === true` 但空闲的会话照样注入；开了这个开关就**连空闲的 live agent 也让位** —— 本机 Web 场景下标签页一订阅就会 promote，所以开了它等于「重启后自动续上」基本不触发。只在想严格复现 PLAN 字面口径时用。**它也是目标会话侧唯一剩下的让位理由** |

非法值 **fail loud**（抛错）—— 由 `apply` 的外层 try/catch 接住，降级并写日志，不会拖垮宿主。

## 怎么装

### 三处装载入口（缺一不可）

1. **包内** `cordis.patch.yml`：含 `- insert: - id: sl-handoff / name: 'dsh-host-sl'`（行 id `sl-handoff` 是插件页行级开关与 settings 命名空间的寻址键，**勿改**）；
2. **包** `package.json`：`dsh.bundle.patch: ./cordis.patch.yml`，且 `files` 白名单含 `cordis.patch.yml` —— pnpm 的 `file:` 拷贝**只按 `files` 落文件**，漏了整包被静默跳过；
3. **profile** `package.json` 的 `dsh.profile.bundles` 里要有包名 `dsh-host-sl`。

本包**不声明 `peerDependencies`**：它一个宿主包都不 import（理由见下），兼容性闸门因此直接放行
（`dsh-app-boot` 的 `evaluatePluginCompatibility` 对没有该字段的包返回"无问题"）。

### 装机命令（`link:` 装载，工作区源码即运行副本）

```powershell
# 用工作区的 dsh-plugin-manager（推荐）：它会**无论 pnpm 成败都按实际文件状态校正 dsh.profile.bundles**
node <工作区>\dsh-plugin-manager\dshpm.mjs add link:<工作区>\dsh-host-sl --profile web
```

官方命令也能用，但它只在 pnpm 退出码为 0 时才校正 `bundles`（被外部超时杀掉就永久丢失，装了等于没装）：

```powershell
dsh plugin --profile web add link:<工作区>\dsh-host-sl
```

`link:` 是工作区源码直连 profile（`node_modules\dsh-host-sl` 是指向本目录的 Junction）；
用 `file:` 也可，只是多一份运行副本要同步。

**装完要不要重启**：新增插件走 profile `package.json` 变更触发重组合，新模块 URL 无缓存、
理论上无需重启（PLAN §6 的待实测项）；但 `lib/*.js` 按 URL 缓存，**改代码后一律要重启**。

### 回滚

```powershell
node <工作区>\dsh-plugin-manager\dshpm.mjs remove dsh-host-sl --profile web
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\storages\sl-handoff"
```

卸载后没有残留：本插件不改任何 profile 文件、不写用户工作区、不起进程、不留后台任务；
数据全在 `~\.dsh\storages\sl-handoff\` 里，删目录即彻底清干净。
只想临时停用就用插件页那张卡的总开关（写 `dsh.profile.bundles`）。

## 排障

日志：`~\.dsh\storages\sl-handoff\sl-handoff.log`（宿主 logger 只进内存 buffer，所以关键节点都落这一份）。
`[plugin]` 前缀的行按时间顺序读：

> ⚠ **唯一会「无配置也落盘」的路径**：`apply` 里配置解析失败时，`resolved` 还没算出来，兜底日志只能走
> `appendLog(fallbackLogFile(), …)`，即 `DSH_SL_LOG_FILE` 环境变量，或 `<DSH_HOME>\storages\sl-handoff\sl-handoff.log`
> （默认 `~\.dsh\storages\sl-handoff\`）。**它不在用户工作区里**，但确实是"配置坏掉也会在真实数据目录
> 建一个日志文件"的唯一入口（一行 `apply 抛错，插件已降级…`）。测试靠 `test/helpers.mjs` 把这两个环境变量
> 指到临时目录来隔离它。

| 日志行 | 含义 |
| --- | --- |
| `apply: v0.6.0 storageDir=… pending=… 新鲜度=24h 热加载阈值=5min 恢复上限=不限 requireColdAgent=false` | 插件真的进了运行树（**这行不在 ⇒ 包没被加载**）；末尾的开关回显是"新版本已生效"的判据（`恢复上限=不限` 或 `恢复上限=3 条`） |
| `sl 命令已注册` / `slHandoff 服务已提供` | 两个入口就位（缺哪行看紧邻的"注册失败"行） |
| `发现待续标记：共 N 条（顶层 a / 子代理 b），本次恢复 c 条（顺序：先顶层后子代理）…` | 启动时读到了标记，并回显这一批的构成与恢复条数。**v0.5.1 起**若有空闲条目，这行还会带一段 `，另有 M 条空闲会话（保存时无在飞的活）不注入` |
| `恢复上限 resumeMaxSessions=… ：本次只恢复前 N 条…` | 上限生效，其余留在标记里等下次启动（**空闲条目不吃这个上限**，v0.5.1） |
| `恢复判定：<三态> —— <原因>` | 闸门判定结果与理由（**排障第一现场**） |
| `恢复条目成功：顶层/子代理 <id> —— …` | 单条恢复的结果（顶层是 followup+flush，子代理是 `subagents.prompt` 投递） |
| `空闲会话 <id> 未注入（保存时无在飞的活），记录文件在 <路径>` | **v0.5.1**：这条会话在保存那一刻没有在飞的活 ⇒ 按用户口径**一个字节都不注入**（不 followup、不投递子代理、不通知父会话）。记录文件仍在磁盘上，想续就自己 `read` 它。**跳过 = 已处理**：它照旧从标记里移除/随整份归档（归档为 `done`），不会下次启动再来一遍 |
| `顶层/子代理 <id> 标记缺 active 字段（旧版），按"有活"处理` | **v0.5.1**：这份标记是 v0.5.0 及更早写的（那时没有 `active` 判据）⇒ 一律照旧唤醒。"没判过"绝不能当成"空闲"（那会静默丢掉在飞的活） |
| `无法判定会话 <id> 保存时有没有在飞的活（<原因>）⇒ 按"有活"处理（宁可多唤醒一次，也不丢掉在飞的活）` | **v0.5.1** 保存侧的 fail-soft：`agents` 服务拿不到/形态不符，或目标会话不在 live 表里 ⇒ 判不了就按"有活"处理 |
| `判定会话 <id> 保存时有没有在飞的活时抛错（…）⇒ 按"有活"处理` | 同上（判定整体抛错的兜底） |
| `goals 服务不可用（没有 get()），会话 <id> 的"活跃 goal"这条判据本次不参与` / `读会话 <id> 的 goal 失败（…）` | **v0.5.1**：`jobs`/`goals` 缺席或抛错**只影响对应那一条判据**，其余判据照常（`jobs` 那条另有"服务缺失当作 0 个作业"的 fail-soft） |
| `其中 N 个会话保存这一刻没有在飞的活（active=false）⇒ 重启后不唤醒它们，只留记录文件` | **v0.5.1** 保存侧的回显：这次存下来的 N 条里有几个是空闲的（`/sl` 与 `saveAll` 都会写）。看到它就能解释"为什么下次重启只叫醒了几个会话" |
| `与已有新鲜标记合并：本次新增 N 条、保留 M 条（其中 K 条此刻已不在 live 表里）` | **v0.6.0** 保存侧的回显：写标记前与磁盘上那份新鲜旧标记取了并集。`保留 M 条` = **只有旧标记里有**的那些（先敲 `/sl` 存过、这次枚举不到它 —— 标签页已关/已被回收），它们照样会被恢复；`K` 就是其中"此刻已不在 live 表里"的条数（括号里写 `live 表读不到…没统计` 时说明这次枚举不到 live 表） |
| `未与已有标记合并（…）` | **v0.6.0**：这次是直接覆盖写入。括号里是原因：`没有旧标记`（正常，首次保存）/ `旧标记判定为 stale` / `JSON 解析失败（…）` / `旧标记形态不符…`。后三种说明上一份标记**没被合并进来**（陈旧或损坏的那份本来也不该被消费）；若同时发现条目变少，就查这几行 |
| 敲了 `/sl` 又走重启工具，某些会话没被恢复 | ① 先看 `pending.json` 里**还有没有**那些条目（v0.6.0 起会保留，见「[为什么合并](#为什么合并v060)」）；② 再看日志里的 `与已有新鲜标记合并…`；③ 标记里确实没有 ⇒ 那次保存发生在 v0.6.0 之前，或旧标记被判成 stale/损坏（日志里有那一行） |
| `恢复条目失败（留在标记里，下次启动重试）：…` | 单条失败（fail-soft，不影响其它条目） |
| `恢复条目判定为不可恢复：…` | 明确不可恢复（空会话等）；整批都是这种时归档为 `unresumable` |
| `本次恢复结束：注入成功 a 条 / 跳过 b 条（空闲，不注入） / 失败 c 条（其中让位 d 条、明确不可恢复 e 条）… ⇒ 归档为 <原因>` | 一批的收尾汇总（**排障第二现场**）。**v0.5.1 起**多了中间那一段"跳过（空闲，不注入）"—— 跳过算"已处理"，所以它**不影响**归档原因（全跳过时照旧是 `done`） |
| `标记已更新：移除 a 条已处理的（注入 x / 空闲跳过 y），留下 b 条…` | 部分完成 ⇒ 标记写回（已注入的与空闲跳过的条目都被移除，不会重复注入） |
| `写回标记失败 ⇒ 整份归档为 done-partial…` | 写回失败，整份归档（宁可放弃重试，也不重复插话） |
| `标记归档为 done / done-noflush / done-partial` | 归档原因（见「落盘位置与文件格式」表） |
| `有 N 条注入成功但 flush 未成功 ⇒ …会永久丢…` | 注入已入队但没落盘（详见下面的取舍） |
| `待续标记判定为 stale/invalid，已归档不注入` | 标记太旧/损坏 |
| `sessionController 在 …ms 内不可用，本次不注入（标记保留）` | 宿主启动异常或服务没挂上；标记留给下次启动 |
| `读会话列表失败（跳过列表判定）` | fail-soft：列表读不到就跳过列表判定，交给 `resolveAgent` 回答"会话还在不在" |
| `读会话历史失败，本次不保存（pending.json 未改动）：…` | `/sl` 或 `slHandoff.save` / `saveAll` 读不出内存历史 ⇒ **拒绝保存**，上一份标记原样保留 |
| `已保存交接：… 子代理=N 个在跑 类型=顶层` / `…类型=子代理(父=…)` | 保存成功，并回显当时有几个子代理在跑 + 这条是顶层还是子代理（读不到就如实写"读不到"） |
| `枚举到 N 个活跃会话（顶层 a / 子代理 b），逐个保存交接` | `saveAll` / v0.4.1 起的 `/sl` 的枚举结果 |
| `枚举活跃会话失败（…），退回"只存调用方那一个会话"` | `saveAll`（含 `/sl`）的 fail-soft 退路（服务缺席/形态不符/抛错/表为空）；同一句话也会出现在命令结果文案里（头一行 `交接记录已保存（退回只存当前会话）：`） |
| `会话 <id> 此刻不在 live store 里（冷恢复尚未落库），跳过 flush` | 子代理投递成功但会话还没进 live store ⇒ 跳过 flush（**不是失败**，见设计点 19） |
| `父会话 <id> 此刻不是 live agent（冷恢复子代理要求 exact live parent）` | 子代理条目恢复不了 —— 最常见的原因是父会话自己也没恢复成功 |
| `子代理 <id> 没唤回来 ⇒ 已通知父会话 <父id>（先唤醒再投递；这条只通知一次，已写 notified 位）` | v0.5.0：通知**投出去了**（父会话的下一轮会收到 `【sl 交接】子代理未能唤回…`），标记条目上的 `notified` 被置真。`先唤醒再投递` 是固定的措辞：这条通道走 `resolveAgent`，父会话即使是死会话也会被叫起来 |
| `子代理 <id> 没唤回来，通知父会话 <父id> 失败（sessionController 服务不可用（没有 resolveAgent()）／resolveAgent 返回不可恢复：…／resolveAgent 抛错：…）—— 只写日志，下次启动再试` | v0.5.0：**唤醒**这一步就失败了（服务缺席 / 会话被删不可恢复 / 抛错）⇒ 通知没发出去，**`notified` 不置位**，下次启动补发。**这种情形下父会话这一轮确实不知情** |
| `子代理 <id> 没唤回来，通知父会话 <父id> 失败（拿到的 agent 没有 followup()／followup 抛错：…）` | v0.5.0：唤醒成功但投递失败 ⇒ 同上（只写日志、不置位、下次补发） |
| `子代理 <id> 没唤回来，但上次启动已经通知过它的父会话 <父id>（不重复通知）` | v0.5.0 的防刷屏：条目上已有 `notified: true`，本次不再重复通知（**也不再去唤醒父会话**，条目照旧留在标记里重试） |
| `subagents 服务不可用（没有 prompt()），投递不了子代理` | 宿主没挂 `dsh-subagent`（`@deepseek-ai/dsh-base` 的一部分）⇒ 顶层照常恢复，子代理条目留在标记里 |
| `apply 抛错，插件已降级（…）` | 兜底：配置非法等。**apply 绝不把异常抛回 loader**（本机教训：插件加载失败会让整个 dsh 起不来） |

常见现象与处置：

| 现象 | 多半是什么 |
| --- | --- |
| 重启后没注入 | 看 `恢复判定` 那行：`yield` 是让位（热加载阈值 / 别的顶层会话**正在跑一轮** / **目标会话暂时不在列表里** / `requireColdAgent`），`unresumable` 是**空会话或列表形态不符**。让位路径**保留**标记，下次启动还会再判。注意「别的会话只是活着（空闲）」**不是**让位理由（v0.2.0 起），「**目标会话自己在跑**」也**不是**（v0.2.1 起 —— 那多半就是重启插件刚注入的那一轮），「**本批要恢复的那些会话**」同样不算（v0.4.0 起） |
| 重启后只恢复了一部分 | 看 `本次恢复结束` 那行与随后的 `恢复条目失败…`：失败的条目**留在标记里**、下次启动重试；`标记已更新：移除 a 条已处理的…` 说明这一批是部分完成。若日志里是 `恢复上限 resumeMaxSessions=N`，那是配置截断（其余留到下次启动）。**若是"某些会话压根没被唤醒"**：看有没有 `空闲会话 <id> 未注入（保存时无在飞的活）` —— 那是 v0.5.1 的**预期行为**（保存那一刻它没在飞，记录文件在磁盘上，想续就自己 `read` 或在新会话里交代） |
| 想让某个空闲会话也被唤醒 | v0.5.1 的口径是"保存那一刻没有在飞的活就不唤醒"（用户拍板）。要它被唤醒，就在保存之前让它**真的有活**：跑一轮、派一个子代理、挂一个后台作业，或给它起一个 goal（`phase:active` + `armed`）。也可以手工把 `pending.json` 里那条的 `active` 改成 `true`（或删掉这个字段）—— 恢复侧对 `true`/缺失一律按"有活"处理 |
| 子代理没被唤回 | 三条常见原因（日志里各有专行）：① `父会话 … 此刻不是 live agent`（父会话自己没恢复成功，或它在标记里排在子代理之后 —— 不该发生）；② `subagents 服务不可用`（宿主没挂 `dsh-subagent`）；③ `投递给子代理失败：…`（宿主的授权/冷恢复拒绝，原因带在消息里，例如 `subagent/not-resumable` = 那个子代理不是 continuable、没有可恢复的续跑状态）。**失败的条目留在标记里**，修好前提后下次启动会再试（标记 24h 内有效）。**v0.5.0 起它的父会话还会收到一条 `【sl 交接】子代理未能唤回` 通知** —— 通道是 `resolveAgent`（**唤醒语义**），所以父会话即使自己也没恢复成功、已经"死了"，也会被叫起来收这条通知；只有唤醒/投递本身失败时才降级成日志 + 下次启动补发（那种情形这一轮父会话确实不知情） |
| 敲了 `/sl` 但提示「读会话历史失败」 | 会话对象读不出内存历史（`deriveMessages` 缺失/抛错）。这时**没有保存**，上一份标记还在 —— 先查会话是不是异常状态，别以为已经存上了 |
| 敲了 `/sl` 却提示「退回只存当前会话」 | `ctx.agents.list()` 不可用（服务缺席/形态不符/抛错）或 live agent 表为空 ⇒ fail-soft 退路，只存了敲命令的那个会话。日志里有同一句 `枚举活跃会话失败（…），退回"只存调用方那一个会话"`，括号里是具体原因。**这不是"什么都没存"**，只是没覆盖到别的会话 |
| 敲了 `/sl`，文案里只有前几条路径 | 会话多时的正常表现：文案最多列 3 条，其余折成 `- …等 N 个`。完整清单在 `pending.json` 的 `items[].file` 里（服务消费者一直读它） |
| 日志里有 `done-noflush` | 注入成功但 flush 失败：标记不会再次注入（避免重复插话），**而注入的消息可能没落盘** —— 若进程再次崩溃，这条交接只在内存里、会永久丢；记录文件本身仍在磁盘上，必要时手工重发 |
| 日志里有 `done-partial` | 部分条目注入成功、但**写回标记失败**（磁盘满/文件被占）：整份标记被归档，未注入的条目**不会自动重试**。归档文件（或旁边的 `.done.json`）里有 `done`/`state`，据此看哪些没轮到，记录文件都在 `storageDir` 里可人工重发 |
| `/sl` 不在斜杠菜单里 | **先看 `apply:` 行在不在**：不在 ⇒ 包没被加载（检查三处装载入口，尤其是 `dsh.profile.bundles` 里有没有 `dsh-host-sl`）；在 ⇒ 插件已加载但命令注册失败，看紧邻的"`/sl` 命令注册失败"行，多半是 `commands` 服务本身有问题 |
| `dsh-host-restart` 的工具文案说"重启前的会话交接未保存：slHandoff 服务不可用" | 本插件没被加载或 apply 失败（先看 `apply:` 行）；也可能服务被别的 fiber 抢先注册（日志里是 `slHandoff 服务提供失败：service "slHandoff" has been registered at <…>`）。**重启本身照常**，只是少存一份交接 |
| 插件整包加载失败、dsh 起不来 | 本包零宿主依赖、apply 全兜底，理论上不会；真出现就看 dsh 自己的 stderr（`<工具目录>\dsh-watchdog-dsh.log`） |
| 注入的记录是几周前的 | 不该发生：`staleMs` 默认 24h。确认配置没被改大 |

**取舍：flush 失败时为什么不保留标记**（对抗性审查第 1 项的结论）

`runResume` 的顺序是「`followup` → `await flush` → 按 flush 结果归档」，**先 flush 再归档**：

- 若先归档再 flush，flush 抛错时标记已经改名 ⇒ 下次启动不会重试，而这条记录只活在内存里，
  进程再挂一次就**永久丢**，日志里还看不出异常。顺序反过来就没有这个静默窗口。
- 归档原因按 flush 结果区分：成功 `done`，失败 `done-noflush`（归档名里带得下这个信息）。
- 但 flush 失败**仍然要归档**（不保留标记）：注入已经入队，留着标记下次启动会**再插一次同样的交接**，
  用户会看到重复消息。两害相权取其轻 —— 选"可能没落盘"而不是"必然重复注入"，
  代价写进日志（`done-noflush` 那行的后果说明），需要时可手工重发记录文件。
- **v0.4.0 的边界（说清楚）**：这条口径只对**本次全部注入成功**的那一批成立。部分完成时标记是
  **写回**（移除已注入的、留下失败的），此时"flush 失败的那条"也已经从标记里移除了 ⇒
  它同样不会被重复注入。所以 flush 失败在任何一条路径上都不会导致重复插话。

**取舍：为什么"失败的条目留在标记里"而不是立刻归档**

v0.3.0 的单会话路径把"注入失败"直接归档为 `failed`（一次判死）。v0.4.0 改成**留在标记里、下次启动重试**，
理由是失败大多是**暂时性**的：宿主刚启动时 `sessionController.list()` 可能还没装载完
（与「目标会话不在列表里 ⇒ 让位」同源）、子代理的父会话可能这一轮才被唤醒、`subagents` 服务可能晚挂载。
判死会把用户唯一那份交接消费掉，而它下次本可以成功。

代价：**永久性失败**（会话被删、子代理不是 continuable）会在每次启动重试一次，各写一行日志，
直到标记陈旧（`staleMs` 默认 24h）被归档为 `stale`。判断"到底是不是永久失败"要看日志里那条失败原因，
而不是看标记还在不在。

**为什么子代理的 flush 是"有条件跳过"**（v0.4.0，设计点 19）

`sessions.flush()` 的文档明说它只对 live session 生效（`dsh-session` 的 `flush` → `liveEntryFor`，
"detached/prepared objects reject"），而子代理是**冷恢复**的 —— 投递那一刻它的会话通常还不在
live store 里。无条件 flush 会稳定报一个"预期内的失败"，把归档原因污染成 `done-noflush`
（看起来像"可能没落盘"，实际什么都没坏）。所以先 `sessions.get(id)` 探一下：live 就 flush，
不 live 就**跳过并返回"无需 flush"**（日志里有一行说明）。投递本身是持久的
（消息进的是子代理的 inbox + 它自己的会话生命周期负责落盘），与顶层会话的 `followup` 同源。

**前提：闸门② 依赖「每次重启都换新进程」**（对抗性审查第 7 项）

闸门② 的判据是 `process.uptime() > bootGraceMs`（默认 5 分钟）⇒ 判定为**插件热加载**、不注入。
它成立的前提是：**dsh 的每次重启都是一个新进程**（本机是看门狗拉起新进程，pid 每次都变）。
若哪天改成"同一进程里重载插件"来模拟重启，`uptime` 就不会归零，这道闸门会一直把恢复挡在门外
（表现为日志里持续 `yield —— 判定为插件热加载`）。真遇到这种部署，调 `bootGraceMs` 或换判据
（例如用插件自身的加载时间而不是进程 uptime），别把它当成"插件坏了"。

**`blank === true` 为什么算不可恢复**（对抗性审查第 3 项）

`sessionController.list()` 的条目里 `blank: true` = 这个会话**没有任何消息**（空会话）。把它判为
`unresumable`（归档标记）而不是让位，理由是：

- 交接记录的意义是"续上这个会话的任务状态"，而空会话里没有可续的状态；
- 注入一条用户消息**会把空会话变成非空会话**，等于凭空造出一个会话，不是用户要的；
- 这个判定不依赖时序（不像"会话不在列表里"可能是宿主刚启动、列表还没装载完），所以不必留待下次。

代价：如果用户在一个空会话里敲了 `/sl`，标记会被归档消费掉（记录文件还在，可手工读）。
这种情况本身没什么可交接的，可以接受。

## 自测

```powershell
cd <工作区>\dsh-host-sl
node --test "test/*.test.mjs"
```

**206 个用例全绿**（v0.1.0 时是 86 个；v0.2.0 修闸门① 判据时加了 7 条；v0.2.1 删掉两条让位判据时
改了 4 条、加了 2 条；v0.2.2 「用户目标」只收真人消息时**加了 10 条、改了 9 条既有用例的夹具/断言**
（render 5 条 + subagents 4 条，其中只有 `lastUserGoal` 那条动了断言），另把 apply / cordis 两个
`fakeSession()` 工厂的 user 夹具补上宿主必填的 `source`（不影响任何断言）—— 见下面的变异验证；
**v0.3.0 换入口与标记结构时：删掉 5 条工具用例、加 12 条服务/批量/v2 标记用例、改了 8 条既有断言**
（apply 16→22、message-shape 5→2、cordis 4→4、handoff-file 9→11、resume 37→39）；
**v0.4.0 扩到所有会话时：新增一个测试文件（`multi-session.test.mjs`，26 条）、
handoff-file 加 3 条（`kind`/`parentSessionId`/`done` 的读入语义 + `isSubagentItem` + `buildResumePlan`）、
改了 8 条既有断言**（resume 的「多会话只注入第一条」→「每条都注入」、失败条目从"归档"→"留在标记里"、
`normalizePending` 的输出形状、apply 的静态 inject 扫描要认 `ctx.get()` 可选读取）；
**v0.4.1 把 `/sl` 也改成"存所有活跃会话"时：`multi-session.test.mjs` 加 5 条（G 组）、
只改了 1 条既有断言**（`assert.equal(VERSION, '0.4.0')` → `'0.4.1'`，版本号是这次交付要求升的，
用例本身断言的是"lib 的 VERSION 与 package.json 一致"这条契约，语义没变）；
**v0.5.0 加"子代理没唤回来时通知父会话"时：新增一个测试文件（`notify-parent.test.mjs`，22 条）、
`handoff-file.test.mjs` 加 1 条（`notified` 位的读入语义）、改了 5 条既有断言**
（`normalizePending` 两处 `deepEqual` 的条目形状多了 `notified: false`、`multi-session` 的
`assert.equal(VERSION, '0.4.1')` → `'0.5.0'` 与 VERSION 用例里新增的通知标题常量断言、
`multi-session` 与 `subagents` 各一条"父会话 followup 条数"的断言 —— 通知也投给父会话，
所以从 1 条变 2 条）；
**v0.5.1 加"空闲会话不注入"时：新增一个测试文件（`session-activity.test.mjs`，18 条）、
`handoff-file.test.mjs` 改了 2 条既有断言**（`normalizePending` 两处 `deepEqual` 的条目形状多了
`active: undefined` / `activeWhy: undefined` —— 这两个字段**故意不补默认值**，"没判过"是有意义的状态；
另加 `multi-session` 里 `assert.equal(VERSION, '0.5.0')` → `'0.5.1'`），
**v0.6.0 加"写标记时取并集"+`pendingSummary()` 时：新增一个测试文件（`pending-merge.test.mjs`，19 条）、
改了 1 条既有断言**（`multi-session` 的 `assert.equal(VERSION, '0.5.1')` → `'0.6.0'`，版本号是这次交付
要求升的，用例本身断言的是"lib 的 VERSION 与 package.json 一致"这条契约，语义没变），
分**十一**个测试文件（外加公共件 `test/helpers.mjs`；都不联网、不起进程、**不写真实 storages 目录**）：

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `test/handoff-file.test.mjs` | 15 | 文件名与路径生成（时间戳含毫秒 + 会话前缀、**同秒不撞名**）、归档名、配置校验（含 **`resumeMaxSessions`**）、标记新鲜度三分支（**v1 与 v2 两种结构**）、**`normalizePending` 的 v1 兼容 / 坏形状 / `kind`·`parentSessionId`·`done`·`notified`·`active`·`activeWhy` 六个可选字段的读入语义**、**`isSubagentItem` 的两条线索与安全侧**、**`buildResumePlan` 的"先顶层后子代理 + 组内保序 + 上限截断"**、路径穿越防护 |
| `test/render.test.mjs` | 22 | 历史归纳（**只收真人消息：结构性判据 `source.kind` 挡掉 subagent-settled / agent-instructions / time-context / agent-message / goal / skill-catalog / runtime-context / tool-jobs，`source` 缺失时不收也不抛，`已重启。` 前缀过滤**、跳过自己注入的消息、用 `toolCallId` 标失败）、**逐字符比对**的记录渲染、**噪音占满历史时的验收现场复现**、**助手侧不需要过滤（kind 恒为 model）**、注入正文与截断 |
| `test/resume.test.mjs` | 39 | 三态判定（让位/可恢复/不可恢复）15 条（含闸门① 的**活着但空闲 ⇒ 不让位** / **正在跑 ⇒ 让位且点名**、**目标会话自己在跑（live agent 口径 / 列表口径 / 两者同时）⇒ 照常注入**、`requireColdAgent` 仍是目标侧唯一让位理由、roots 条目形态不符）、`runResume` 端到端 24 条（正常注入、归档原因、fail-soft、路径穿越、已卸载、空闲顶层会话照常注入、目标会话自己被标签页唤醒且空闲、**目标会话在跑 ⇒ 照常注入且日志说明排进下一轮**、**v2 列表标记（单条）走同一条注入路径**、**v2 多会话标记 ⇒ 每一条都注入**、**失败的条目留在标记里（不判死）**、**整批让位时标记一个字节都不动**） |
| `test/multi-session.test.mjs` | 31 | **v0.4.0 的两处扩展 + v0.4.1 的 `/sl`**（本文件就是验收标准 2/3/4 的落点）：`enumerateActiveSessions`（顶层+子代理、`kind`/父 id、服务缺失/抛错/非数组/子代理缺父 id 的 fail-soft）、**`slHandoff.saveAll`**（多条标记、`note` 只写指定那份、子代理记录里那一节渲染成「（无）」、**枚举不到 ⇒ 退回只存调用方那一个**、表为空/无调用方 ⇒ 不写标记、从不抛）、**恢复顺序「先顶层后子代理」被投递顺序钉死**（含 `mode:'continuable'` / `delivery:'queue'` / `requestId` / 引导语文案的逐项断言）、子代理失败四条（父不活着 / `subagents` 缺失 / 投递抛错 / 缺父 id）、**子代理会话不在 live store ⇒ 跳过 flush 但算成功**、**上限截断（顶层优先、其余留在标记里且 `done:false`）**、**归档语义四条**（部分成功 ⇒ 移除已注入的并写回、写回失败 ⇒ 整份 `done-partial` + `.done.json` 旁证 + 不留 `.tmp-` 残骸、`done:true` 直接跳过、第二轮不重复注入）、**`kind` 缺失/形态全坏不抛**、**G 组 `/sl`（v0.4.1）**：多会话 + 子代理 ⇒ 标记里多条且 `说明` 只落在当前会话那条、文案写清条数与路径（多时折成「…等 N 个」）、枚举不到 ⇒ 退回只存一个且文案与日志如实说明、一个都没成功 ⇒ 不写标记、两条拒绝口径不变、`buildSubagentResumeText` 与 VERSION/常量一致性 |
| `test/notify-parent.test.mjs` | 22 | **v0.5.0 的通知能力**：正文纯函数 2 条（标题常量 / 子代理 id / 原因原文折叠成单行 / 记录路径 / "没上报给你·别当成已完成" / `send_message` 建议 / 不可恢复措辞 / 缺字段不编造不抛）、端到端**失败 ⇒ 父会话收到一条通知**（正文逐项断言 + 通知是正常的 user 消息）、**投递成功不发通知**、**缺 `parentSessionId` 不猜收件人**（v1/v2 两条）、**已通知过 ⇒ 第二次启动不重复通知且位保持**、**v0.4.x 老标记没有 `notified` 字段 ⇒ 该通知就通知**、**父会话已经"死了"（不在 live 表里）⇒ resolveAgent 把它唤醒后收到通知并置位**、**`resolveAgent` 返回错误 / 抛错 ⇒ 只写日志·不置位·其它条目照常**、**`sessionController` 缺席或形态不符 ⇒ 只写日志·不置位·不抛**、**投递抛错 / 唤醒拿到的 agent 没有 `followup()` ⇒ 只写日志·不置位**、**顶层失败一个通知都不发**（并断言通知路径不会顺手唤醒任何会话）、**父会话不在 live store ⇒ 通知照旧算成功**、**归档语义不受影响**（`notified` 随条目进 `done-partial` 证据） |
| `test/apply.test.mjs` | 22 | **静态自检**（inject 覆盖每个 `ctx.<服务>`（**`ctx.get()` 可选读取要认出来，且 `subagents` 不许进 inject**）、**模型工具入口零残留**（`sl_save` 字面量、`tools.register`、`TOOL_*`、`presentCall` 全不许出现）、**服务由 `ctx.provide` 提供且不进 inject**、零宿主 import）、apply 不抛回 loader、注册失败只降级 + 写日志、**同名服务已被别的 fiber 提供时只降级**、timer 缺失回退、dispose 回收（含服务注销）、`/sl` 的契约（**v0.4.1 起这条路的 `agents` 桩没有 `list()` ⇒ 走的是 fail-soft 退回分支**，正好把退回路径钉住）、**`slHandoff.save` 的契约**（单会话 / **一组会话** / 部分失败 / 全失败不写标记 / note 形态 / 从不抛异常 / 读不出历史时拒绝保存且不动 `pending.json`） |
| `test/message-shape.test.mjs` | 2 | 拿**真实的**宿主工厂当 oracle：`buildUserMessage` vs `createUserMessage`（逐字段 + 冻结 + 可 JSON 化）、id 每次新生成（工具 schema 的手写形状随工具一起删除，不再需要） |
| `test/cordis-integration.test.mjs` | 4 | **真 `Context` + 真 `cordis-plugin-timer`**：`inject` 是真门（服务缺席不 apply、补上后补跑）、`ctx.timeout` 真来自 timer mixin、**`ctx.provide` 是真的**（服务可见 / `fiber.dispose()` 后读不到）、保存→恢复完整闭环（走服务面保存） |
| `test/subagents.test.mjs` | 12 | 「保存时在跑的子代理」：血缘上溯（任意深度、别人的子代理/fork/idle 都不算、成环不失控）、**有 / 无 / 服务不可用**三分支、记录文件真的写了这一节、注入引导语带提醒、读不到细节只留空不炸保存、**`lastUserGoal` 只认真人消息（子代理自己的结算通知/来信不算派活指令）** |
| `test/session-activity.test.mjs` | 18 | **v0.5.1 的「空闲会话不注入」**（用户报的那个 bug 的回归网）：判据四条各自命中/不命中（`session` / `subagent`（含任意深度、别人的不算）/ `job`（只认 `running`·`stopping` 且 owner 精确匹配）/ `goal`（只认 `active`+`armed`））+ 四条同时命中的顺序；**fail-soft 三条**（`agents` 拿不到/目标不在表里 ⇒ `active:true`；`jobs`/`goals` 缺席或抛错只影响对应那条判据；判定整体抛错 ⇒ `active:true`）；**保存侧**落 `active`/`activeWhy` 且**空闲会话的记录文件照旧写**；**恢复侧**`active:false` ⇒ `followup` **零调用**、不 `resolveAgent`、不投递子代理、不通知父会话，但**跳过算已处理**（标记归档为 `done`、不判成 `failed`）、**不占 `resumeMaxSessions` 上限**、写回失败时归档证据里写 `state:'idle'`、**空闲条目也算"本批目标"**（它此刻在跑也不让闸门① 拦下整批）；**旧标记缺 `active` ⇒ 照旧唤醒 + 一行日志**；`normalizePending` 只认布尔、缺失保持"未知"（写回时不会凭空添 `active:true`）；外加一条**端到端**：`saveAll`（1 个在跑 + 2 个空闲）→ 同一份标记走恢复 ⇒ **只唤醒在跑的那一个**（逐字复现 2026-09-28 23:05 那个现场） |
| `test/pending-merge.test.mjs` | 19 | **v0.6.0 的「写标记时按会话 id 取并集」+ 只读服务方法 `pendingSummary()`**：并集规则（两边都有 ⇒ 用新条目并保持旧位置 / 只有旧的 ⇒ 原样保留（含 `active`·`activeWhy`·`notified`）/ 只有新的 ⇒ 追加 / `done:true` 不合并 / 空·坏输入不抛）；**真落盘**的写入路径（先 `/sl` 后重启前 `saveAll` ⇒ B 的条目与记录文件都还在、A 换成新条目、`createdAt` 按本次）；合并日志 `本次新增 N 条、保留 M 条（其中 K 条此刻已不在 live 表里）`；四种"不合并"（陈旧 / JSON 坏 / 形态不符 / 没有旧标记）各自照旧覆盖 + 一行日志 + 绝不抛；**合并不改变原有语义**（保留条目的 `active:false` 仍不唤醒、`active:true` 仍唤醒、`resumeMaxSessions` 上限照旧截断、整份归档照旧、一个都没成功仍一个字节都不写）；`pendingSummary()` 的**形状**（五字段、`active` 三态、`wake` 折算、v1 标记读得进）、**只读**（调用前后文件字节不变、不写临时文件/归档）、**fail-soft**（没有/损坏/形态不符 ⇒ `exists:false` + 原因，从不抛） |

测试隔离靠两件事：落盘目录走 config 注入（`storageDir` 指临时目录），以及 `test/helpers.mjs`
在模块加载时把 `DSH_SL_LOG_FILE` / `DSH_HOME` 也指到临时目录 —— 连"配置解析失败"那条路径的
兜底日志都落不到真实目录（这一条是踩出来的：第一版自测真的把一行日志写进了
`~\.dsh\storages\sl-handoff\sl-handoff.log`，已修）。假 ctx（`makeCtx`）从 v0.3.0 起也实现了
`ctx.provide` 的语义（登记 → `ctx.get` 可读 → 卸载即注销 → 同名重复 provide 抛错），
好让"服务缺席/形态不符/被抢先注册"这些分支在**不起真宿主**的前提下也能测。

**变异验证**（临时改坏 → 用例必须红 → 还原后 SHA256 一致）：

| 变异 | 结果 |
| --- | --- |
| 去掉注入后的 `flush` | 4 条红 |
| 注入正文不再带 `【sl 交接续跑】` 前缀 | 5 条红 |
| 清理改回 `ctx.on('dispose')`（参考实现的写法） | 3 条红 |
| `sessionPrefix` 退回字面 `slice(0,8)` | 2 条红 |
| 陈旧标记不归档直接注入 | 2 条红 |
| 去掉路径穿越防护 | 1 条红 |
| `inject` 里去掉 `timer` | 1 条红 |
| 不再跳过自己注入的消息 | 1 条红 |
| 闸门① 不排除目标会话自己 | 1 条红 |
| 不检查解析后的 `running`（**该判据已于 v0.2.1 删除**，此行留作历史记录） | 1 条红 |
| **（v0.2.1）把「目标会话在跑 ⇒ 让位」加回来**（两处判据全加回：live agent 的 `status`、列表条目的 `running`、`resolveAgent` 后的 `agent.status`） | **6 条红**（三态判定四条：live agent 口径、列表口径、两种来源同时为真的时序现场、`requireColdAgent` 那条的文案被前一条判据截胡；端到端两条：目标会话在跑照常注入、`resolveAgent` 后已在运行照常注入） |
| **（v0.2.0）闸门① 改回「存在即让位」**（`running === true` → 不过滤 `running`） | **4 条红**（三态判定两条：空闲顶层会话不让位、混着空闲与在跑时只点正在跑的；`roots` 条目形态不符；端到端一条：空闲顶层会话照常注入） |
| **（v0.2.2）去掉「用户目标」的结构性判据**（`source.kind === 'user'` → 只看正文前缀，= 旧行为） | **8 条红**（结算通知 / `agent-instructions` / `time-context` / `agent-message`+其它 kind 各一条、`source` 缺失那条、验收现场复现那条、`lastUserGoal` 两条） |
| **（v0.2.2）去掉 `已重启。` 前缀过滤**（`dsh-host-restart` 的注入与真人消息 kind 同形） | **1 条红**（那条专门钉住形态判据的用例） |
| **（v0.3.0）不再提供 `slHandoff` 服务**（`ctx.provide` 整行去掉） | **15 条红**（静态用例 1 条 + 假 ctx 的 apply/契约用例 12 条 + 真 cordis 2 条） |
| **（v0.3.0）批量全失败时也写标记**（`items.length === 0` 的早退短路掉） | **5 条红**（"全失败 ⇒ 一个字节都不写标记"、"读不出历史时拒绝保存且不动 `pending.json`" 等） |
| **（v0.3.0）去掉 v1 标记兼容读入**（`normalizePending` 不再认单会话结构） | **24 条红**（v1 夹具的端到端注入、apply 的启动恢复、`classifyPending` 与 `normalizePending` 用例等 —— 升级丢数据这条真的被钉住了） |
| **（v0.5.1）把空闲分支短路掉**（`runResume` 里 `item.active === false` 改成恒不成立 ⇒ 空闲条目照旧走注入） | **4 条红**（`active:false ⇒ 一个字节都不注入`、`混合（空闲 + 有活）`、`空闲条目被移除、超上限的留下`、`写回失败时归档证据写 state:'idle'`） |
| **（v0.5.1）把判定短路成恒 `active:true`**（`evaluateSessionActivity` 的返回值写死 true） | **6 条红**（判据①②③④ 各自那条、`jobs`/`goals` 缺席那条 fail-soft、`saveAll` 落 `active` 位那条） |

**2026-09-28 对抗性审查修复时补做的变异验证**（对第 1/2/3/8 项各做一次；每次都还原并核对
`lib/index.js` 的 SHA256 与改前一致 —— 当时是 `C32E0BAD…E4DF65`，之后只改过注释与文档，
终版见下方「交付指纹」）：

| 变异 | 结果（红的用例数） |
| --- | --- |
| 第 1 项：归档改回 `followup` 之后立刻 `done`（= flush 前归档） | 2 条红（两条 `done-noflush` 归档名/日志断言） |
| 第 2 项：`readMessages` 失败时退化成"空历史"照常保存 | 1 条红（`pending.json` 被覆盖、却报 success） |
| 第 3 项：目标会话不在列表时改回 `unresumable` | 2 条红（三态判定 + 端到端"标记保留"） |
| 第 8 项：子代理一节不再渲染（`subagentsOf` 恒返回空列表） | 4 条红（列表、记录落盘、注入正文、细节留空） |

**v0.4.0 的变异验证**（五次，每次都是"临时改坏 → 跑全量 → 还原 → 核对 SHA256 与改前一致"；
基线 `5F56112A580646F62041144200CF27A3591374077F8F14FFFDED643FB7D2485A`，还原后逐字节一致）：

| 变异 | 结果 |
| --- | --- |
| **恢复顺序反过来**（`[...roots, ...subagents]` → `[...subagents, ...roots]`） | **3 条红**（投递顺序用例、上限截断用例"顶层优先"、以及另一条依赖顺序的断言） |
| **忽略 `kind`**（`isSubagentItem` 恒 false） | **1 条红**（顺序用例里"子代理必须走 prompt 投递"那半边） |
| **恢复上限失效**（`limit` 恒 0） | **2 条红**（上限截断、以及"超上限条目必须留 `done:false`"） |
| **不再移除已注入条目**（写回分支短路 ⇒ 每次都整份归档） | **8 条红**（部分成功的写回/重复注入、`done-partial` 旁证、上限截断、以及 4 条既有归档断言） |
| **`saveAll` 不写 `kind`/`parentSessionId`** | **1 条红**（标记条目形状） |

**v0.4.1 的变异验证**（三次，每次都是"临时改坏 → 跑全量 → 还原 → 核对 SHA256 与改前一致"；
基线 `BCFF5BFD37A89B3A95866423707D95A75929FEF73B69489DC341DB22CD53B917`，三次还原后都逐字节一致）：

| 变异 | 结果 |
| --- | --- |
| **`/sl` 改回单会话那条路**（`handleSaveAll` → `handleSave`） | **3 条红**（多会话多条标记、文案「共 N 个」与「等 N 个」、退回路径文案与日志 —— 正是这次要钉住的行为） |
| **`noteSessionId` 传空串**（说明落不到任何一份记录） | **4 条红**（新用例的"`说明` 只落在当前会话那条"与退回路径，外加 2 条既有 `/sl` 用例：`说明` 写进「下一步」、命令与服务覆盖同一份标记） |
| **记录路径清单不截断**（`listedFileLines` 全列） | **1 条红**（"列前几个 + 「等 N 个」"那条） |

**v0.5.0 的变异验证**（十次，每次都是"临时改坏 → 跑全量 → 还原 → 核对 SHA256 与改前一致"）。
前六次在"只看 live 表"那一版上做，基线 `979EA226D18DC83A90BAFCF1EB15A6F1E2C07212F5049665045316CB7231C99B`：

| 变异 | 结果 |
| --- | --- |
| **子代理失败不再通知**（`notifySubagentFailureToParent` 那一步短路掉） | **11 条红**（新用例里所有断言"父会话收到通知/位被写回"的那些，外加 1 条既有断言） |
| **去掉"已通知过就不再通知"的闸**（`item.notified === true` 恒 false） | **1 条红**（"第二次启动不重复通知"那条 —— 正是防刷屏要钉住的行为） |
| **通知失败也置位**（"发不出去"那条分支 `return true`） | **1 条红**（"唤醒失败 ⇒ 不置位，下次启动可再试"） |
| **写回时丢掉 `notified` 位**（`notified: notified.has(…) \|\| item.notified === true` → `false`） | **5 条红**（通知成功后位写回、第二次启动的位保持、归档证据、以及两条 v0.4.x 老标记用例） |
| **通知不再带失败原因原文**（`reason: outcome.message` → `''`） | **2 条红**（正文纯函数断言 + 端到端"原因原文照搬"） |
| **通知标题带上续跑前缀**（`【sl 交接】` → `【sl 交接续跑】`） | **2 条红**（标题常量断言 + "不许带续跑前缀"那条 —— 带了的话父会话下次保存交接时这条通知会被当成自己的注入过滤掉） |

**改成"唤醒语义"之后又做四次**（基线 `2AF09A37E3729E8AD5E8617F6ED1D5B9BC0258B3387F8257B82AB06EB7794F79`，
四次还原后都逐字节一致；这一版的终版指纹见下）：

| 变异 | 结果 |
| --- | --- |
| **通知回退成"只看 live 表"**（不再唤醒死会话） | **8 条红**（"父会话已经死了 ⇒ 唤醒后收到通知"那条，以及所有依赖"死父会话也收得到"的断言） |
| **唤醒返回 `{error}` 时也置位**（`return false` → `return true`） | **3 条红**（返回错误 / 抛错 / 服务缺席那三条的"不置位"断言） |
| **唤醒失败把异常抛出去**（`if (!resolvedParent.ok) throw`） | **4 条红**（三条 fail-soft 用例 + 一条"其它条目照常"） |
| **顶层恢复不再走共用的判错层**（`resolveAgentFor` 拿掉、直接 `controller.resolveAgent(…).agent`） | **7 条红**（顶层恢复的 `resolveAgent` 抛错/返回 error 那几条 —— 共用判错层被绕开就退化了） |

**v0.5.1 的变异验证**（两次，都是"临时改坏 → 跑全量 → 还原 → 核对 SHA256 与改前一致"，
基线 `A3060DBF596C858016BF8B5462939BD3B07FCFD63DA1488663ACB60222F9EA6F`）：

| 变异 | 结果 |
| --- | --- |
| **把空闲分支短路掉**（`runResume` 里 `item.active === false` 改成恒不成立 ⇒ 空闲条目照旧注入） | **6 条红**（`active:false ⇒ 一个字节都不注入`、`混合（空闲 + 有活）`、`空闲条目被移除、超上限的留下`、`写回失败时归档证据写 state:'idle'`、`空闲条目也算"本批目标"`、**端到端那条（复现 23:05 现场）**） |
| **把判定短路成恒 `active:true`**（`evaluateSessionActivity` 的返回值写死 true） | **6 条红**（判据①②③④ 各自那条、`jobs`/`goals` 缺席那条 fail-soft、`saveAll` 落 `active` 位那条） |

**v0.6.0 的变异验证**（一次，规矩同上：临时改坏 → 跑全量 → 还原 → 核对 SHA256 与改前一致，
基线 `4EB161D5FB2C3A936AF668134DEEC9475181005F294315337C53D9A5608DF52F`，还原后逐字节一致）：

| 变异 | 结果 |
| --- | --- |
| **永不合并**（`writePendingMarker` 里 `const previous = verdict === 'fresh' ? normalizePending(existing.raw) : undefined` → `const previous = undefined`，= 退回旧的覆盖语义） | **6 条红**（先敲 `/sl` 那条丢存档复现、合并日志、枚举不到 live 表时的并集、以及 3 条"合并后恢复/归档语义不变"） |

**交付指纹**（v0.6.0 终版）：`lib/index.js` SHA256 =
`4EB161D5FB2C3A936AF668134DEEC9475181005F294315337C53D9A5608DF52F`；`node --test "test/*.test.mjs"`
= 206 用例全绿。
（v0.5.1 是 `A3060DBF596C858016BF8B5462939BD3B07FCFD63DA1488663ACB60222F9EA6F` / 187 用例；
v0.4.1 是 `BCFF5BFD37A89B3A95866423707D95A75929FEF73B69489DC341DB22CD53B917` / 146 用例；
v0.4.0 是 `5F56112A580646F62041144200CF27A3591374077F8F14FFFDED643FB7D2485A` / 141 用例；
v0.3.0 是 `CAF63F690C0F0A8503CC63C9851D31AC9E32BD8A0E6633316C7A7040D9E3903F` / 112 用例；
v0.2.2 是 `4906FE53B818749A114D8EB34A20A46133CE17CC99A087239A336FB216599D53` / 105 用例；
v0.2.1 是 `81AE1404BF0A98A903368695F1F89635A9A9F26C5A9DF861FBBBAB71A2F40D1C` / 95 用例；
v0.2.0 是 `6FB235E1ECF635C2AC01DCA678AC542F3CB5A44F974EB0E696069396FD6DA234` / 93 用例；
v0.1.0 是 `EB366D86020FC2CE6D1BBBABA96D887C35EDA68338EB677722BEB6441CAE93F7` / 86 用例。）
v0.2.1 的变异验证：把「目标会话在跑 ⇒ 让位」三条判据全加回 ⇒ **6 条红**；还原后 SHA256 与改前一致。
v0.2.2 的变异验证（两次都还原并核对 SHA256 与改前一致）：去掉结构性判据 ⇒ **8 条红**；
去掉 `已重启。` 形态过滤 ⇒ **1 条红**。
v0.3.0 的变异验证（在 `165441D3…9F332` 那份上做的，三次都还原并核对 SHA256 与改前一致；
之后只改过一处注释措辞（`collectMessages` 的 JSDoc），终版指纹见上）：
不提供 `slHandoff` 服务 ⇒ **15 条红**；全失败也写标记 ⇒ **5 条红**；去掉 v1 标记兼容 ⇒ **24 条红**。
v0.4.0 的变异验证：见上面的表（五次，基线 `5F56112A…2485A`，还原后逐字节一致）。
v0.4.1 的变异验证：见上面的表（三次，基线 `BCFF5BFD…3B917`，还原后逐字节一致）。
v0.5.0 的变异验证：见上面的表（六次，基线 `979EA226…1C99B`，还原后逐字节一致）。
v0.5.1 的变异验证：见上面的表（两次，基线 `A3060DBF…9EA6F`，还原后逐字节一致）。
（顺带修掉一处**测试自身**的健壮性缺陷：`test/cordis-integration.test.mjs` 原来在断言失败时走不到
`fiber.dispose()`，留下的 `bootDelayMs` 定时器会把测试进程吊住 —— 变异验证时真踩到（整轮挂死 5 分钟）。
现在四个用例都用 `mount()` 包装、`finally` 里必定 dispose。）

## 为什么一个宿主包都不 import

本包按 PLAN §4 以 **`link:`** 装进 profile（工作区源码即运行副本，改了立即生效）。`link:` 在 Windows
上是 Junction，而 Node 的 ESM 解析**按 realpath** 走（`--preserve-symlinks` 默认关）⇒ 模块的真实路径
留在工作区，`@deepseek-ai/dsh-llm` 会从工作区逐级上找 `node_modules`，找不到就 `ERR_MODULE_NOT_FOUND`。

2026-09-28 本机 A/B 实测（同一份代码、同一个 `profiles\node_modules\@deepseek-ai\*` 回退目录）：

| 装载形态 | 结果 |
| --- | --- |
| Junction 装（`link:`） | `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm' imported from …\workspace\probe-pkg\lib\index.js` |
| 拷贝装（`file:`） | 成功（解析到 dsh 安装树里的那份） |

而插件 import 失败发生在 `apply` **之前** ⇒ 连 fail-soft 的机会都没有，**dsh 直接起不来**。
所以本包只用 `node:*` 与相对路径，唯一需要宿主工厂的地方自己造，形状由测试对着真实工厂钉住：

**注入用的 user 消息**自己造：宿主侧就是
`deepFreeze(structuredClone({...input, role:'user', id: brandString(randomUUID())}))`，
而 `brandString` 运行时是恒等函数；`test/message-shape.test.mjs` 拿真实的 `createUserMessage` 逐字段比对。

（v0.3.0 起**不再手写工具 schema**：模型工具已删除，改为 `ctx.provide('slHandoff', …)` ——
`ctx.provide` 是 cordis 自己的 API，不需要任何宿主包，那份"手写 JSON Schema 再拿 `defineTool`
当 oracle 钉住"的负担随之消失。）

`test/apply.test.mjs` 有一条静态用例扫描 `lib/index.js`，**出现任何 `@deepseek-ai` 依赖就红**。

## 与 PLAN / CONTRACT 的偏差

逐条列出**本实现与 PLAN.md 字面不一致**的地方，以及和 CONTRACT.md 的核对结果。
（**v0.3.0 新增的两条是偏差 5 与偏差 6，按序号排在最后**，先看偏差 1 的读者别错过它们；
偏差 6 在 v0.4.0 被**改写**了 —— 现在记的是"多会话恢复已实现、v0.3.0 的只恢复第一条作废"；
**偏差 7（v0.4.1）记的是"`/sl` 命令也覆盖所有活跃会话"** —— 它推翻了 v0.4.0 时写下的
"`/sl` 只存本会话"那条口径。）

### 偏差 1（**影响验收，最重要**）：闸门① 的口径 —— 只让位给「**正在跑一轮**的**别的**顶层会话」

- **PLAN §2 原文**：`闸门①：agents.roots() 非空 ⇒ 已有活跃顶层会话在动，让位，不注入`
- **实测依据（代码路径已核实）**：`dsh-api-session-controller/lib/index.js:1521-1529` —— `session.follow`
  （Web 客户端打开会话时建的 `SessionEventStream` 走的就是它）在**订阅一个尚未激活的会话**时
  （`source.source === 'prepared'`）会调 `promote()` → `resolveObservedAgent` →
  **在后台把 agent 激活**（同文件 `promote()` 与 `ApiSessionAgentController.resolveObservedAgent`）。
  ⇒ 只要有客户端订阅了该会话，它就会变成 `agentAvailable: true` 并作为顶层 agent 出现在 `agents.roots()` 里。
- **未实测的部分（如实标注）**：浏览器标签页在 dsh 重启后多久重新订阅当前会话，没有实测数字；
  但这是 Web UI 显示会话的必经路径，插件窗口（apply + 4s）内命中并不意外。
- **按 PLAN 字面执行的后果**：这次启动会被**自己的目标会话**挡掉 ⇒「重启后自动续上」永远不触发，
  整个插件等于没用（`dsh-host-restart` 之所以不受影响，是因为它根本不看 `roots()`，直接 `resolveAgent`）。
- **本实现（v0.2.0 起）**：闸门① 的判据是 `agent.status === 'running'`（**「正在跑一轮」**），
  不是 `roots()` 里有这么一条（**「存在」**）。两条限定缺一不可：
  1. **「别的」**：过滤掉目标会话自己（`id !== pending.sessionId`）—— 它被标签页 promote 是正常现象；
  2. **「正在跑一轮」**：`roots()` 返回的是**活着**的顶层 agent，不是**正在跑**的。宿主启动后
     各标签页重新订阅会把空闲会话也变成 live agent，它们**不构成让位理由**。
- **这条判据的取舍（明确写下）**：**其它顶层会话只是活着（空闲）时不再让位** —— 代价是
  「另一个标签页里有个空闲会话」不再阻止注入；换来的是核心功能在用户开着两个及以上标签页时**仍然可用**。
  目标会话**自己**在跑也不拦（v0.2.1 起，见下一节）；默认口径下目标会话侧**没有任何**让位理由，
  唯一的例外是可选开关 `requireColdAgent`。
  口径与本机 `dsh-host-restart` 的 `detectRunningSessions` 一致（它也是 `agent?.status !== 'running'` 就跳过）。
- **`requireColdAgent: true` 是更严的一档**（保留开关，想严格复现 PLAN 字面口径时用）：默认口径下
  `agentAvailable === true` 但空闲的会话**照样注入**；开了它则**连空闲的 live agent 也让位**
  （额外要求 `agentAvailable === false`）。本机 Web 场景下标签页一订阅就会 promote，所以开它等于
  把「重启后自动续上」基本关掉 —— 差别就在这里。
- **给协调者的建议**：真机验收时如果看到 `恢复判定：yield —— 还有 N 个其它顶层会话正在跑一轮（session-…）`，
  那是**别的**会话真在跑一轮，符合预期（文案会点名是哪个会话）；如果看到 `requireColdAgent` 相关的让位，
  再讨论是否收紧。**看到 `恢复判定：resume —— 目标会话正在跑一轮，但 followup 只把记录排进下一轮…`
  是正确的**（v0.2.1 起）—— 那说明重启插件已经先注入过「已重启」，本插件的记录排在它后面。

### 为什么「目标会话在跑」不再让位（v0.2.1，源码级核实）

**问题（时序冲突，本机推演 + 源码核实）**：两个宿主插件都在 `apply` 后 **4000ms** 醒来、都在等
`sessionController`、都对**同一个会话**调 `resolveAgent`：

```
t=0     新 dsh 进程起来
t≈1~3s  sl-handoff.apply + restart-dsh.apply（各自 ctx.timeout(…, 4000)）
t≈4s    dsh-host-restart.runInjection：waitForService → resolveAgent → followup('已重启…') → 删标记
        ↑ 它不做 list() 查询，路径更短 ⇒ 必然先跑；目标会话立刻进入 running
t≈4s+   sl-handoff.runResume：waitForService → list() → decideResume → resolveAgent → followup(交接记录)
```

旧版一共**三处**判据都在说「目标会话在跑 ⇒ 让位」：`decideResume` 里两个来源（live agent 的
`status`、`list()` 条目的 `running`）+ `runResume` 里 `resolveAgent` 之后的 `agent.status === 'running'`
（"竞态兜底"）⇒ 本插件让位、标记保留；下次重启又是同样的时序 ⇒ **交接记录永远注入不进去**，核心功能失效。

**核实：`followup` 是「排进下一轮、不打断当前轮」**（判据是宿主源码，不是推测）——
`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js`：

```js
// :806-808
followup(input) {
    this.send(input, "next-turn", true);
}
// :800-805
send(message, target, wakeup) {
    const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
    const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
    this.inbox.splice(resolvedTarget, Infinity, 0, [message]);   // ← 追加进 next-turn 队列
    if (wakeup) this.wakeDriver(wakingAfterAbort);
}
// :854-858  已有轮在跑时：直接 return，不 abort、不插队
wakeDriver(wakeAfterAbort = false) {
    if (this.phase.kind !== "idle") {
        if (abortedCancelCause(this.phase.abort.signal)?.kind !== "disposed" && (this.phase.kind === "maintenance" || wakeAfterAbort)) this.phase.wakeRequested = true;
        return;
    }
// :1020 轮末：队列里有东西就再起一轮（配 :889 的 while (await this.turn())）
    if (!this.inbox.hasPending) return false;
// :949 / :105 新轮第一步以 target="next-turn" 调 claim()，把排队的消息取走
    let target = "next-turn";
    …  claim(target, turn) { … if (target === "next-turn") claimed.push(...this.mutate("next-turn", 0, 1, [], false)); … }
```

对照：`steer`（:809-811）与 `inject`（:812-814）走的是 `next-step` —— 那才是「插进当前轮」。

**结论与修法**：既然 `followup` 不打断任何东西，让位就是多余的 —— **三处「目标会话在跑 ⇒ 让位」的判据
全部删除**（`decideResume` 里 live agent 的 `status` 与列表条目的 `running`、`runResume` 里
`agent.status === 'running'` 的让位分支）。宿主刚启动时目标会话的 `running` 只可能来自两种情况，
**都不该把交接记录拦下**：

1. 重启插件 `dsh-host-restart` 刚注入的「已重启」那一轮（必然先发生）；
2. 用户在这 4 秒里手速极快地发了条消息。

记录排进下一轮即可，顺序也是对的（先「已重启」，后交接记录）。**保留的让位/归档判据一个没动**：
闸门② 热加载阈值、闸门① 别的顶层会话正在跑、目标会话不在列表里（让位）、空会话（不可恢复）、
`requireColdAgent`；`sessionController.list()` 的调用也保留（还要用它判「会话是否存在」「是否空会话」）。
日志里仍会把「目标会话在跑」写进 `恢复判定` 那行（`…但 followup 只把记录排进下一轮（不打断当前轮），照常注入`），
排障时能区分「排在别人那一轮后面」与「会话本来空闲」。

### 偏差 2：「会话前 8 位」不是 `sessionId.slice(0, 8)`

- **PLAN §2 原文**：`handoff-<时间戳>-<会话前8位>.md`
- 本机会话 id 形如 `session-<uuid>`，字面取前 8 个字符恒等于常量 `session-`（认不出是谁）。
- **本实现**：先剥掉 `session-` 前缀再取 8 位字母数字（`session-aaaa1111-…` → `aaaa1111`）。
- **v0.4.0 的注意点**：子代理会话 id 也是 `session-<uuid>` 形状（例如 `session-cccc3333-…`），
  所以同一批里顶层与子代理的文件名靠**会话前缀**区分 —— 同毫秒内不同会话也不会撞名
  （文件名还带毫秒段）。

### 偏差 3：注入的是「引导语 + 记录正文（有长度上限）」而不是无上限整篇

- **PLAN §2 原文**：`followup(createUserMessage(交接记录 + 续跑引导语))`
- **本实现**：引导语（含会话 id、保存时间、记录文件绝对路径、「先读记录再继续」）+ 记录正文，
  总长上限 `resumeTextMaxChars`（默认 6000 字符），超长则截断并提示用 `read` 工具读记录文件。
- **理由**：CONTRACT §7.4 提到 preset 的 `tool-result-pruner` 阈值是 8192 字符；注入一条超长用户消息
  会挤占上下文。记录本身由渲染层的分节上限保证通常只有 2~4 KB，所以正常路径下不会被截断。

### 偏差 4：`sessionController` 等不到时**保留**标记，不归档

- 参考实现 `dsh-host-restart` 在等不到 `sessionController` 时把标记归档为 `failed`。
- **本实现**：保留标记（下次启动再判），因为「这次启动慢」不该消耗掉用户唯一的那份交接；
  新鲜度上限（24h）兜底，不会无限期留着。
- 同理归档的只有两种：`unresumable`（空会话 / 列表形态不符）与 `failed`（resolveAgent 报错 / 注入抛错）。
- **2026-09-28 对抗性审查后收紧**：「目标会话不在列表里」从 `unresumable` 改成 `yield`（保留标记）——
  宿主刚启动时列表可能还没装载完，判死会把唯一那份交接消费掉，而下次启动本可以注入成功。
  代价是"会话真的被删了"也会一直留着，由 `staleMs`（24h）兜底。判据见 `decideResume` 的注释。

### 偏差 5（v0.3.0）：模型工具入口删除，改为 cordis 服务 `slHandoff`

- **PLAN §2 原文**：`sl_save({note?}) 工具：同上，供模型调用（模型敲不了斜杠命令）`；
  PLAN §验收 也写着"工具表里出现 `sl_save`"。
- **本实现（v0.3.0，用户 2026-09-28 明确要求）**：**该工具整体删除**（连同它的描述、手写
  JSON Schema、`presentCall` 卡片与全部用例），保存能力改为 **cordis 服务 `slHandoff`**：
  - 源码里**一个 `sl_save` 字面量都不留**（注释也不留），`test/apply.test.mjs` 有静态断言钉住；
  - 服务用 `ctx.provide('slHandoff', { save })` 提供，`inject` 里也移除了 `tools`
    （本插件不再需要 `tools` 服务在场才 apply）；
  - `/sl` 命令**保留**（人敲的入口没动）。
- **为什么**：真正需要"存一份交接"的是**宿主插件** —— `dsh-host-restart` 在杀进程前顺手存一份，
  重启后由本插件注入回来。模型敲不了斜杠命令这个理由已不成立，而"交接"是宿主在重启前做的动作，
  不该由模型随手触发。附带好处：`ctx.provide` 是 cordis 自己的 API（零宿主 import），
  且服务随 fiber 卸载自动注销，比注册工具少一份要自己维护的清理代码。
- **代价**：模型再也不能主动存交接（这是刻意的）。人想存就敲 `/sl`。

### 偏差 6（v0.4.0）：多会话恢复已实现，v0.3.0 的「只恢复第一条」作废

- **v0.3.0 的原样**：`pending.json` 是 v2 **列表**结构，但 `runResume` 只消费 `items[0]`
  （多条时记一行日志说"多会话恢复未实现"）。那是当时**刻意的范围边界**：先把接口与标记结构立起来。
- **v0.4.0（用户 2026-09-28 明确要求）**：这条边界取消 ——
  - **保存**：新增 `slHandoff.saveAll`，枚举**所有活着的 agent**（顶层 + 子代理）各存一份；
  - **恢复**：`runResume` **逐条恢复全部条目**，顺序硬约束「**先顶层、后子代理**」
    （冷恢复子代理要求父 agent 已活着，见「多会话的保存与恢复」）；
  - **上限**：新增 `resumeMaxSessions`（默认 `0` = 不限），>0 时只恢复前 N 条，其余留在标记里。
- **标记结构没换版本号（仍是 v2）**：列表形状没变，只给条目**加了三个可选字段**
  （`kind` / `parentSessionId` / `done`）。旧版读新标记只会忽略它们（最坏情况是一次重复注入，
  不是数据损坏）；新版读旧标记照旧（缺 `kind` 一律按顶层）。
- **单会话行为不变（v0.4.0 时成立，v0.4.1 起只对"注入路径"成立）**：列表长度为 1 时注入路径与
  v0.2.2 逐字一致（端到端用例仍在 `test/resume.test.mjs` 里钉着）；但 `/sl` 的**成功文案**在
  v0.4.1 改了形状（多会话后它必须写清"存了几个"），见偏差 7。
- **PLAN 与验收的关系**：PLAN §2 的字面口径是"只恢复那一个会话"，v0.4.0 是**超出 PLAN** 的扩展
  （用户当面的新要求），不是偏离 —— 列在这里是为了让"为什么代码里有 `saveAll` / `kind`"有据可查。
- **v0.5.1 的边界**：`active:false` 的空闲条目**不注入**（见「[空闲会话不注入](#空闲会话不注入v051)」），
  所以"逐条恢复全部条目"现在的准确说法是"逐条**处理**全部条目（注入，或按设计跳过并归档）"。

### 偏差 7（v0.4.1）：`/sl` 命令也覆盖所有活跃会话

- **v0.4.0 时写下的口径（现已作废）**：`/sl` 只存本会话 —— 当时把"覆盖所有活跃会话"当成**服务面**
  （`saveAll`）的能力，人敲的入口保持"给我这个会话留个交接"的语义（见「多会话的保存与恢复」表）。
- **v0.4.1（用户 2026-09-28 明确要求）**：这条口径取消 —— **`/sl [说明]` 与"重启前保存"完全同路**：
  - 枚举 `ctx.agents.list()` 里每一个 live agent（顶层 + 子代理）**各存一份记录**，一次调用只写一份标记；
  - `说明`（`invocation.rawInput` trim 后）**只写进当前会话那一份**（`noteSessionId` = 敲命令的会话），
    其余会话的记录里「下一步」留空 —— 与 `dsh-host-restart` 把 `noteSessionId` 设成"发起重启的会话"同源：
    替别的会话写"下一步"只会让它们读到自己没说过的话（那句是给模型看的指令）；
  - 枚举不到 live agent 表（服务缺席/形态不符/抛错/表为空）⇒ fail-soft **退回"只存当前会话"**，
    并在**文案与日志里如实说明是退回**（头一行 `交接记录已保存（退回只存当前会话）：` +
    一行 `枚举不到活跃会话表：<原因>。已退回「只存当前会话」这条 fail-soft 路径。`）——
    绝不冒称"所有活跃会话"。
- **两条拒绝口径不变**：没有归属会话、**当前会话是子代理会话**（`/sl` 是人敲的顶层入口；
  枚举到的**其它**子代理照常各存一份）。这两条仍走单会话那条路拿拒绝文案，一个字节都不写盘。
- **成功文案变了形状（唯一一处对既有消费者的可见变化）**：从 v0.2.x 的单会话四行文案
  （`交接记录已保存：<路径>\n待续标记：…\n历史消息 N 条…`）改成"存了几个会话 + 记录路径清单"：
  - 头一行写清条数与构成：`交接记录已保存（所有活跃会话，共 N 个：顶层 a / 子代理 b）：`；
  - 路径**最多列 3 条**（`MESSAGE_MAX_LISTED`），其余折成 `- …等 M 个（完整清单见待续标记的 items[].file）`
    —— 会话数可能到十几个（开着的标签页 + 在跑的子代理），全列会把命令结果刷屏；
  - 机器可读的路径一直在 `items[].file`（服务消费者一直读它，`dsh-host-restart` 也是读它拼自己的文案），
    所以这次改的只是**给人看的**那段文字；`message` 仍是失败时的裸原因（前缀由调用方加）。
- **PLAN 与验收的关系**：PLAN §2 只写了"人敲 `/sl` 存一份"，v0.4.1 是**超出 PLAN** 的扩展
  （用户当面的新要求，与偏差 6 同源）；列在这里是为了让"为什么 `/sl` 会写多条记录"有据可查。

### 与 CONTRACT.md 的核对结果

**逐条相符**（都在本机 `dsh 0.1.7-rc.2` 源码里核对过，不是照抄）：

| CONTRACT §6 的条目 | 核对结果 |
| --- | --- |
| `agents.roots()` = 活的顶层 agent | ✓ `dsh-agent/lib/index.js:621`（`filter((entry) => entry.owner === void 0)`） |
| `sessionController.list({}, signal)` → `{items}`，按 `updatedAt` 降序 | ✓ `list.d.ts:35` + `index.js` 里 `items.sort((l, r) => r.updatedAt - l.updatedAt)`；**不激活任何 agent** |
| `resolveAgent(sessionId)` → `{agent}` 或 `{error}`，不抛异常 | ✓ `ApiSessionAgentController.resolve()` 内部 try/catch 把 `ApiSessionNotFound` 等转成 `{error}` |
| `agent.followup(msg)` 会唤醒新一轮 | ✓ `dsh-agent-loop/lib/index.js:806`（`send(input, 'next-turn', true)`）；**补充（v0.2.1 核到）**：它是「排进 `next-turn` 队列、**不打断当前轮**」（`:803` 追加 + `:855-858` 已有轮在跑时 `wakeDriver` 直接 return + `:1020` 轮末按队列再起一轮），插进当前轮的是 `steer`/`inject`（走 `next-step`，`:809-814`） |
| `sessions.flush(session)` 必须补 | ✓ `SessionStore.flush()`；**补充**：会话不在 live store 里会抛 `session "x" is not live in this store`，所以本插件把它包在 fail-soft 里 |
| `SessionSummary` 字段 | ✓ 逐字段相符（`agentAvailable/sessionId/updatedAt/running/blank/parentSessionId?/origin?/cwd?/projections?`） |
| 现有 storage 域名不冲突 | ✓ 本插件**不注册 storageDomain**（直接写文件），与 `task_board`/`schedule`/`workspace`/`session_projcache` 无交集 |

**CONTRACT 没写、本次新核到的十条**：

1. **`link:` 装机下裸 import 宿主包必失败**（见上一节 A/B 实测）—— 这是本插件零宿主依赖的唯一原因，
   也是任何要装进 profile 的工作区插件都适用的约束。
2. **客户端订阅会激活会话**（`index.js:1521-1529`）—— 直接决定了偏差 1。
3. **`followup` 是「排队」不是「插队」**（`dsh-agent-loop/lib/index.js:800-808` / `:854-858` / `:1020`）——
   直接决定了「目标会话在跑 ⇒ 不让位」（v0.2.1，见上面那一节）。
4. **`ctx.on('dispose', …)` 在本机 cordis 里是死代码** —— cordis 在 fiber 卸载时发的是
   `internal/plugin`（`cordis/lib/index.js:969-970`），**没有 `dispose` 这个事件**；全机
   `@deepseek-ai/dsh-*` 包对 `dispose` 事件名零 emit、零监听（已 grep 核实）。
   参考实现 `dsh-host-restart` 的清理段就是 `ctx.on('dispose', …)` ⇒ **它的工具回收与定时器取消
   从来没跑过**。本插件用 cordis 的原生机制 `ctx.effect(() => 返回清理函数)`，
   并由 `test/cordis-integration.test.mjs` 在真 `Context` 上钉住（变异验证：改回 `ctx.on('dispose')`
   ⇒ 3 条用例红）。
5. **`ctx.sessionTitle`**（`@deepseek-ai/dsh-session-title`，随 `@deepseek-ai/dsh-base` 一起装载）可以拿到
   会话标题：`get(session)` → `{title, messageSeqs, source, eventSeq, updatedAt} | undefined`。
   本插件用 `ctx.get('sessionTitle')` **可选**读取（不进 inject），拿不到就把标题留空，不编造。
   另注：它的 `get()` 内部用了被标为"新调用禁止"的 `session.snapshotEvents()` —— 那是它自己的实现，
   本插件自己不调用任何 deprecated API（历史走 `session.deriveMessages()`）。
6. **`commands.register` 的 `definitionId` 是可选的**（只有需要客户端特化的内置命令才写），
   所以本插件不需要 import `@deepseek-ai/dsh-commands/brand`。
7. **`agents.list()` 是唯一含子代理的入口**（`dsh-agent/lib/index.js:612` 返回全表，
   `roots()` 同文件 `:621` 按 `entry.owner === void 0` 过滤）—— 新增的「保存时在跑的子代理」一节
   只能走 `list()`；血缘判据 `session.header.parentSession` + `header.origin === 'subagent'`
   与 `dsh-subagent/lib/index.js` 的 `runningDescendants` 一致（**只读那个包，不改它**）。
8. **`sessionController.list()` 的条目里没有子代理**（只有顶层会话的 `SessionSummary`），
   所以子代理只能从 live agent 表里找，不能从会话列表里找。
9. **`ctx.provide` 的用法与卸载语义**（v0.3.0 核到，源码级；`cordis/lib/index.js:800-824`，
   TS 源码 `src/reflect.ts:267-305`）：`provide(name, value)` 内部就是
   `this.ctx.fiber.effect(() => {…}, 'ctx.provide("name")')` ⇒ **服务随提供方 fiber 卸载自动注销**
   （清理函数 `delete this.store[key]` + `notify([name])` 唤醒依赖方）；同名服务已存在时抛
   `service "x" has been registered at <fiber>`；`ctx.get(name)` 默认 strict ⇒ 只有提供方 fiber
   ACTIVE 时才返回服务（卸载后立刻读不到，消费者的 fail-soft 分支因此能真实生效）；
   重复调用返回的 disposer 是 no-op（`src/fiber.ts:407-408` 明说 "Calling the disposer twice is a no-op"）。
   本插件据此把服务登记在 apply 的 fiber 上，并用真 `Context` 的用例钉住"卸载后 `ctx.get` 读不到"。
10. **`ctx.get('subagents').prompt(request, signal)` 是"宿主冷恢复一个子代理"的公开入口**
    （v0.4.0 核到，源码级；`dsh-subagent/lib/index.js`）：
    - 服务名来自 `super(ctx, "subagents")`（`:2833-2834`）；
    - 方法签名与校验（`:3010-3037`）：`prompt(request, signal)`，`request` 必填
      `parentSessionId` / `childSessionId` / `mode:'continuable'` / `delivery:'queue'|'steer'`
      （zod schema 在 `:40-45`），`content` 是模型可见的 text 块数组；
    - 冷恢复就发生在投递内核里：`deliverToChild` → `deliverFollowup` 发现
      `activations.get(childId) === undefined` ⇒ `coldResume(parent, childId, content, options)`
      （`:1822-1824`、`:1898-1947`：`sessionQuery.observeSession(childId)` → 折出 descriptor →
      `materialize` 重建 Agent → 投递首条消息）；
    - **授权链要求 exact live 父**（`:1914-1915` → `:956-959`，引文见「多会话的保存与恢复」）；
    - `dsh-tool-subagent-control` 的 `send_message` 走的是同一个内核（`sendMessage` → `deliverToChild`），
      只是它要求一个 exact live **sender agent** 且只能投给"直接父/直接子"；冷恢复场景没有 sender，
      所以本插件用 `prompt`。
    ⚠ **本插件因此不把 `subagents` 写进 `inject`**：它缺席时保存与顶层恢复仍要能用，
    只有"恢复子代理"这一条路需要它（用 `ctx.get()` 可选读取 + fail-soft）。

### 其它实现选择（PLAN 没规定，写下来备查）

- **日志落在数据目录里**（`sl-handoff.log`）而不是 `<工具目录>\`：回滚时一个目录全带走。
- **`/sl` 从子代理会话发起、以及 `slHandoff.save`，都拒绝子代理会话**：`resolveAgent` 对子代理会话
  一律返回 error，存了也续不上（`dsh-host-restart` 对重启也是这个口径）。
  **`/sl` 正常发起时（当前会话是顶层）以及 `saveAll` 都收子代理** —— 它们枚举的是"所有活着的 agent"，
  子代理由 `subagents.prompt` 冷恢复，不走 `resolveAgent`（`/sl` 从子代理会话发起这件事在 Web 里
  本来就做不到：斜杠命令只在顶层会话的输入框里敲）。
- **归档而不是删除标记**：`pending.<原因>-<时间戳>.json` 留证据，便于事后判断"为什么这次没续上"。
- **标记写入：v0.6.0 起是"取并集"而不是"直接覆盖"**：同一份 `pending.json` 由 `/sl` 与重启前保存共用，
  覆盖语义会把用户先敲 `/sl` 存下的、此刻已不在 live 表里的条目抹掉（见「[为什么合并](#为什么合并v060)」）；
  并集只发生在旧标记**新鲜**时，陈旧/损坏一律照旧覆盖。旧记录文件全部留着（审计线索，从不删）。
- **服务名用 `slHandoff`**（不是 `slSave`/`handoff`）：与插件名 `sl-handoff` 同源，一眼能对上；
  仓库里已有的 storage 域名/服务名（`task_board`/`schedule`/`workspace`/`sessionTitle`…）无冲突。
- **`saveAll` 而不是给 `save` 加一个 `{all:true}` 开关**（v0.4.0 的接口取舍）：两条路的**入参形状**
  本来就不同 —— `save` 收"会话对象/数组"，`saveAll` 收"选项 + 一个 fallback 会话"，混成一个方法会让
  `Array.isArray` 之外的形态判断再叠一层。分成两个方法后，消费者（`dsh-host-restart`）读一眼就知道
  自己调的是哪条路；服务对象上两个方法都是同步、都不抛。
- **子代理的注入正文单独写一份**（`buildSubagentResumeText`，不复用顶层的 `buildResumeText`）：
  子代理不知道"进程换了一个"，引导语必须说清"你被 dsh 重启打断了、先汇报当前状态再继续"，
  否则它会把记录当成"父代理刚派来的新任务"直接干下去。

## 已知限制

### 恢复 ≠ 无损（v0.5.0 明确写下来；这条以前挂在 `AGENTS.md` 的「重启前先 list_agents」约定里）

**「被打断却无痕」已经消除**（重启前把所有活跃会话各存一份交接记录、重启后逐条唤回，见「它做什么」），
**但「恢复」不等于「什么都没发生」**。三件事必须说清楚：

1. **冷恢复不是"原地续上"，是"带着记录重起一轮"**：子代理（以及没被标签页订阅的顶层会话）在重启后
   并不存在于新进程里，恢复的做法是宿主 `coldResume` —— **从持久化里折出描述符 → 重建 Agent →
   投递第一条消息**（源码位置与引文见 `lib/index.js` 的 `injectIntoSubagent` 注释）。也就是说：
   **被打断的那一刻正在执行的那一步工具调用会丢**，重新起来的是"读了交接记录之后重新决定要做什么"
   的一个新回合。它可能重做那一步，也可能因为记录里没写清而做了别的事。
2. **可能留下半成品文件**：被打断的那一步如果是"写文件/改代码/发请求"，它可能**写到一半**就没了 ——
   磁盘上留着半截内容、只改了一半的补丁、已经发出去但没等到回应的请求。恢复出来的新回合**不知道**
   这件事（交接记录记的是"当时在做什么"，不是"文件现在是什么状态"）。
3. **所以正确姿势是"先确认现状再继续"**：
   - 被唤回的子代理侧：注入正文里已经要求它**先汇报当前状态**（做到哪一步、哪些结论已经有了），
     并且明说"不要照抄记录里的旧结论 —— 重启后可能已经有新进展，拿不准的地方先核实"；
   - 父会话侧：收到 `【sl 交接】子代理未能唤回` 通知、或读到自己记录里「保存时在跑的子代理」那一节时，
     **不能把它当成"已经干完了"**，也不能当成"还在跑" —— 先用 `read` / `git status` / 文件时间戳
     确认现状，再决定是手动 `send_message` 续它、还是自己接手；
   - 人侧：重启前那一刻正在跑的长任务，重启后值得多看一眼产物，别只看"有没有注入成功"。

换句话说：本插件保证的是**知情权**（有记录、有通知、有日志）与**续跑能力**（记录能注入回去、能再起一轮），
**不保证**被打断的那一步工具调用不丢、也不保证产物是完整的。

### 其它限制

- **只覆盖内存里的消息历史**：不读会话文件、不解 zstd。被压缩掉的旧内容不在记录里 ——
  这个缺口靠 `/sl <说明>` 的说明字段补（PLAN §1 明确接受）。
- **「用户目标」只收真人消息，但仍有几类分不开/收不到**（v0.2.2，判据见「[「用户目标」只收真人消息](#用户目标只收真人消息v022源码级核实)」）：
  - **已排除**（结构性判据 `source.kind`）：子代理结算通知 `subagent-settled`、子代理来信 `agent-message`、
    AGENTS.md 变更提醒 `agent-instructions`、时间采样 `time-context`、目标续轮 `goal`、技能目录 `skill-catalog`、
    运行时快照 `runtime-context`，以及 `tool-jobs` / `repeat-tool-reminder` / `session-reference` /
    `compact-checkpoint` / `schedule` / `skill-invocation` / `user-approval` / `ptc-mode` / `hooks-*` 等宿主注入；
  - **靠正文形态排除**（它们的 `source.kind` 与真人消息**完全一样**，结构上无解）：
    本插件自己的 `【sl 交接续跑】` 注入，以及本机 `dsh-host-restart` 的「已重启。」注入
    （`~\.dsh\profiles\web\plugins\dsh-host-restart\lib\index.js:727-730` 用的就是 `{kind:'user'}`）。
    **代价**：那个包改了开场白，过滤就会失效（不会报错，只是噪音又回来了）；反过来，真人恰好以
    `已重启。` 开头时会被漏收 —— 按「宁可漏收也不收噪音」取此；
  - **`source` 缺失/形态不符 ⇒ 不收**（判据边界）：真实宿主消息不可能缺 `source`，所以这只对坏数据生效；
    万一宿主将来改了消息形状，这一节会**变空**（渲染成「（无）」）而不是塞进噪音 —— 一眼看得见，不会静默出错；
  - **`goal` 轮次里的目标原文不再进这一节**（`<goal_round> Objective: …` 是系统提示，不是用户说的话）：
    长程 goal 会话的「用户目标」可能只剩最初那条真人消息，目标原文要看记录里的「下一步」说明或 `task_board`。
- **一次启动里，标记是"部分消费"的**（v0.4.0）：成功的条目被移除、失败的与超上限的留下，
  所以 `pending.json` 可能在多次启动之间**一直存在**（这是设计，不是 bug）。想知道"到底恢复完了没有"，
  看最后一次启动的 `本次恢复结束` 那行 + 标记里还剩几条；`staleMs`（默认 24h）会把长期恢复不了的
  标记归档为 `stale`，不会无限期留着。
- **永久失败的条目会被反复重试**（v0.4.0 的代价，见「排障」里的取舍）：会话被删、子代理不是
  continuable 这类情形，每次 dsh 启动都会再试一次并写一行日志（最多 24 小时）。
  要立刻停掉就手工删 `pending.json`（记录文件不受影响）。
- **子代理的恢复依赖宿主把 `dsh-subagent` 挂上**：`ctx.get('subagents')` 缺席时顶层照常恢复、
  子代理条目全部留在标记里（日志有专行）。本机 `@deepseek-ai/dsh-base` 会带上它。
- **"活跃"的口径是"本进程里活着的 agent"**：从没被任何客户端订阅过、也没被 promote 的会话
  不在 `agents.list()` 里 ⇒ **`/sl` 与重启前的保存都不会覆盖它**。对本机 Web 场景没影响
  （打开过的会话都会被订阅），但它意味着"所有活跃会话"不等于"磁盘上所有会话文件"。
  真遇到"某个会话没被存"先查这条：它是**从来没被打开过**，还是这次枚举失败了（后者日志里有
  `枚举活跃会话失败（…），退回"只存调用方那一个会话"`）。
- **`/sl` 的成功文案里只列前 3 条记录路径**（v0.4.1）：会话多时其余折成 `- …等 N 个`。
  这不是"没存"——完整清单在 `pending.json` 的 `items[].file` 里，`/sl` 的返回面
  （服务的 `items[].file`）也一直是全的。要看全部路径就读标记文件。
- **恢复只在宿主启动时发生**：插件热加载（进程已跑 > 5min）不会触发，这是闸门②的设计意图。
- **记录文件不自动清理**：`handoff-*.md` 与 `pending.*.json` 会一直累积（每次 `/sl` 一份，体积小）。
  需要清理就手动删旧文件 —— 插件不替你决定删什么。
- **目标会话侧默认没有任何让位理由**（v0.2.1，见「为什么「目标会话在跑」不再让位」）：`running` 与
  `agentAvailable` 默认都不参与判定，目标会话**即使在跑一轮也照常注入**（记录排进它的下一轮）。
  唯一会让位的开关是 `requireColdAgent`。
- **注入的消息排在目标会话当前那一轮之后**（v0.2.1 的代价）：目标会话在跑时，记录不是立刻被处理，
  而是等那一轮结束、作为**下一轮**被取走。若用户在那之前按了「停止」，宿主 `AgentLoop.cancel()` 默认
  `keepInbox: false` 会清空待处理队列（`dsh-agent-loop/lib/index.js:815-821`）⇒ 这条注入可能被丢掉；
  但注入已经入队、条目也已从标记里移除，本插件不会重试。真遇到这种情况，记录文件仍在磁盘上，可手工重发
  （旧行为下这个窗口反而更小 —— 代价是核心功能**永远不触发**，两害相权取此）。
- **子代理的注入是"排进它的下一轮"（`delivery:'queue'`），不是立刻执行**：与顶层会话同源。
  差别是它由宿主**冷恢复**出来（重建 Agent、从持久化里折出 descriptor）—— 那一步失败时
  日志里的原因是宿主给的（例如 `subagent/not-resumable`），本插件只负责转述。
- **子代理一节只覆盖"保存那一刻还活着且在跑"的子代理**：已经被硬杀、或保存时刚跑完还没被清理的，
  都不在里面；重启后的新子代理进程里也不存在（这是记录，不是实时状态）。
  ⚠ 注意区分**两件事**：记录正文里的那一节是"当时在跑的**血缘后代**清单"（信息）；
  v0.4.0 的**恢复**收的是"保存那一刻**活着的所有 agent**"（顶层 + 子代理，各存一份记录）。
  前者是后者的一个子集（都要求 running），但口径不同 —— 别把"记录里没列某个子代理"当成"它不会被恢复"。
- **目标会话长期不在列表里时标记会一直留着**（对抗性审查第 3 项的代价）：改成让位后，只有
  `staleMs`（默认 24h）会把它归档。好处是宿主刚启动、列表还没装载完时不会误吃交接。
- **多会话恢复的注入顺序是"顶层全部 → 子代理全部"，不是"按父分组"**：一个子代理的父会话若
  排在同一批里，父一定先恢复（这正是硬约束要的效果）；但**父会话自己恢复失败**时，它的子代理
  这一轮必然也失败（日志里写"父会话 … 此刻不是 live agent"）—— 两条都留在标记里，下次一起重试。
- **通知走的是"唤醒"通道，所以它会真的把父会话叫起来**（v0.5.0 的语义与代价，用户拍板）：通知用
  `sessionController.resolveAgent(父 id)`，而它是**唤醒语义** —— 父会话即使不在 live 表里（只躺在
  持久化里）也会被**冷唤醒 + 起一轮**后收到通知，代价是**真起一轮、消耗 token**。这是为了"一定送到"
  付的价（旧做法只看 live 表，父会话自己没恢复成功时它永远不知情）。想省 token 就得改代码关掉这条路
  （本版没有开关）。
- **通知仍可能发不出去，而且发不出去时父会话这一轮就是"不知情"的**（v0.5.0 的边界，三类：
  ① **唤醒本身失败**：`sessionController` 缺席或没有 `resolveAgent` / `resolveAgent` 返回 `{error}`
  （会话被删、不可恢复）/ `resolveAgent` 抛错；② **投递失败**：拿到的 agent 没有 `followup()`、
  或 `followup` 抛错；③ **父会话在这一批里排在子代理后面**（不该发生：顺序是先顶层后子代理，
  真出现就是标记被手工改过）。
  这几种情形下通知都只写一行日志、**不置 `notified` 位** ⇒ 下次启动补发。
  换句话说：**"父会话一定会被告知"仍不是绝对保证**，保证是"通知发出去了才置位、发不出去就下次再试"。
  要自查"到底通知没通知"，看日志里那几行（`已通知父会话 …（先唤醒再投递…）` /
  `通知父会话 … 失败（…）—— 只写日志，下次启动再试` / `上次启动已经通知过它的父会话 …（不重复通知）`）。
- **`notified` 只记"通知过"，不记"通知被读过"**：父会话收到的是排进**下一轮**的消息（`followup`），
  它当前那一轮不会被打断。所以从"通知投出去"到"父会话真的看到"之间有一段延迟（取决于它当前那轮多长）。
- **子代理投递没有「明确不可恢复」这条返回**（v0.5.0 写下来备查）：`injectIntoSubagent` 的失败一律是
  可重试的（缺父 id / 记录读不到 / 父不活着 / `subagents` 缺席 / 投递抛错），`unresumable:true` 只由
  顶层那条路（`decideResume` 的空会话判据）产生。所以通知正文里"明确不可恢复"那段措辞目前只有
  纯函数用例覆盖；真出现"宿主的冷恢复明确拒绝"（例如 `subagent/not-resumable`）时，那条会按
  **可重试失败**通知（正文里说的是"下次启动再试一次"）—— 措辞偏乐观，但不会漏通知。

## 真机验收（协调者执行，需用户同意）

1. 按上面「怎么装」以 `link:` 装进 web profile，重启 dsh（`lib/*.js` 按 URL 缓存）。
2. 看 `~\.dsh\storages\sl-handoff\sl-handoff.log` 有没有 `apply: v0.6.0 …` 那一行（含 `恢复上限=不限`）——
   没有就是包没被加载。
3. 斜杠菜单里出现 `/sl`；**工具表里不该再有那个保存工具**（v0.3.0 已删除），
   但 `dsh-host-restart` 的 `restart_dsh` 文案里应出现"重启前已保存会话交接记录：<路径>"。
4. 敲 `/sl 继续做 X` ⇒ 目录里出现 `handoff-*.md` + `pending.json`（记录里应有
   `## 保存时在跑的子代理` 一节；当时若有在跑的子代理，重启前就能在文件里看到它们）。
5. **`/sl` 的多会话验收（v0.4.1 的新增项）**：先开第二个标签页（或在另一个会话里让它有活），
   回到第一个会话敲 `/sl 继续做 X` ⇒
   - 命令返回文案的头一行应是 `交接记录已保存（所有活跃会话，共 N 个：顶层 a / 子代理 b）：`，
     下面列出记录路径（>3 个时折成 `- …等 M 个`）；
   - `pending.json` 里应有**多条** `items`，每条带 `kind`，子代理那条还带 `parentSessionId`；
   - **只有敲命令那个会话的 `note` 是"继续做 X"**，其余条目的 `note` 应为 `""`；
   - 若头一行是 `（退回只存当前会话）`：那是枚举不到 live agent 表，日志里有同一句原因
     （这种情况不算通过，要查为什么枚举不到）。
6. **多会话验收（v0.4.0 的新增项）**：开着两个标签页（或在另一个会话里也让它有活），
   在一个会话里让模型调 `restart_dsh` ⇒
   - `dsh-host-restart` 的返回文案应写"重启前已保存会话交接记录：<路径1>、<路径2>…"（多份）；
   - `pending.json` 里应有**多条** `items`，每条带 `kind`，子代理那条还带 `parentSessionId`；
   - 新进程启动后日志里应看到 `发现待续标记：共 N 条（顶层 a / 子代理 b）…`、
     `恢复条目成功：顶层 …`（全部顶层走完）**之后**才是 `恢复条目成功：子代理 …`；
   - 每个被恢复的会话里都应出现一条 `【sl 交接续跑】…` 用户消息。
7. 重启 dsh ⇒ 新进程应自动注入一条 `【sl 交接续跑】…` 的用户消息并起新一轮；
   日志里应看到 `恢复判定：resume`（目标会话被 `dsh-host-restart` 先唤醒时，reason 会是
   `目标会话正在跑一轮，但 followup 只把记录排进下一轮（不打断当前轮），照常注入` —— **这是正确的**）
   与 `恢复条目成功：顶层 …`，随后 `本次恢复结束：… ⇒ 归档为 done`，
   标记被改名为 `pending.done-*.json`（flush 失败时是 `pending.done-noflush-*.json`，
   部分完成是 `pending.done-partial-*.json`）。
8. **子代理通知的验收（v0.5.0 的新增项，需要人为造一次失败）**：
   - 造一条会失败的子代理条目：`pending.json` 里把某个子代理条目的 `file` 改成不存在的路径
     （或临时把 `parentSessionId` 改成另一个已删会话的 id），`createdAt` 保持新鲜；
   - 重启 dsh ⇒ 日志里应有 `恢复条目失败（留在标记里，下次启动重试）：子代理 <id> —— 记录文件读不到（…）`，
     紧接着 `子代理 <id> 没唤回来 ⇒ 已通知父会话 <父id>（先唤醒再投递；这条只通知一次，已写 notified 位）`；
   - 那个**父会话**里应出现一条用户消息，开头是 `【sl 交接】子代理未能唤回（dsh 重启后自动唤回时没能把它叫起来）`，
     正文含子代理 id、失败原因原文、记录文件路径与 `send_message` 建议；
   - `pending.json` 里那条子代理条目应变成 `notified: true`，且**仍然在标记里**（`done: false`）；
   - 再重启一次 ⇒ 日志里应是 `… 上次启动已经通知过它的父会话 <父id>（不重复通知）`，
     父会话**不该**再收到第二条同样的通知（防刷屏生效）。
9. **"唤醒死会话"的验收（v0.5.0 的关键语义，也是这次要盯的一条）**：
   - 把父会话**关掉/别订阅它**（例如重启后先不打开它那个标签页），让它在 live 表里不存在；
   - 同一条会失败的子代理条目再跑一次（`notified` 先手工改回 `false`，`createdAt` 保持新鲜）；
   - 日志里应**仍是** `已通知父会话 <父id>（先唤醒再投递…）` —— 即 `resolveAgent` 把那个死会话
     **冷唤醒**了（那个会话文件/标签页会被重新激活，它的下一轮会收到通知）。这一条通不过就说明
     唤醒那条路没生效（那是本次改动的核心，要查 `sessionController` 服务在不在、`resolveAgent` 有没有）。
10. **「空闲会话不注入」的验收（v0.5.1 的关键语义，就是这次要修的那个 bug）**：
    - 开两个标签页：一个会话让它**有活**（在跑一轮，或派一个子代理、挂一个后台作业、起一个 goal），
      另一个会话**只是开着**（空闲 —— 浏览器标签页订阅了它，所以它在 `agents.list()` 里）；
    - 让**有活的那个**会话调 `restart_dsh`（或敲 `/sl`）⇒
      - `pending.json` 里应看到 `active: true` / `activeWhy: ["session"]`（或 `subagent`/`job`/`goal`）
        与另一条的 `active: false` / `activeWhy: []`；
      - 日志里应有 `其中 1 个会话保存这一刻没有在飞的活（active=false）⇒ 重启后不唤醒它们，只留记录文件`；
    - 重启 dsh ⇒ 新进程日志里：
      - `发现待续标记：共 2 条（顶层 a / 子代理 b），本次恢复 … ，另有 1 条空闲会话（保存时无在飞的活）不注入`；
      - `空闲会话 <空闲的那个 id> 未注入（保存时无在飞的活），记录文件在 <路径>`；
      - 汇总行是 `本次恢复结束：注入成功 … / 跳过 1 条（空闲，不注入） / …⇒ 归档为 done`；
    - **关键判据：那个空闲会话里不该出现任何 `【sl 交接续跑】…` 消息，它也不该起新一轮**
      （这就是本次要修的行为 —— 旧版会给它插一条消息并烧一整轮）；
    - 标记应被归档为 `pending.done-*.json`（**不是**留在 `pending.json` 里等下次重试）；
    - 空闲会话的记录文件仍在 `~\.dsh\storages\sl-handoff\` 里（想续就自己 `read` 它）。
11. **旧标记兼容的验收（v0.5.1）**：手工把 `pending.json` 里某条的 `active` 字段**删掉**（模拟 v0.5.0
    写的标记），`createdAt` 保持新鲜 ⇒ 重启后日志里应有
    `顶层 <id> 标记缺 active 字段（旧版），按"有活"处理`，且那个会话**照旧收到**交接记录。
12. **标记合并的验收（v0.6.0 的关键语义，就是这次要修的那处丢存档）**：
    - 开**三个**标签页（会话 A / B / C），都让它有活（在跑一轮，或各派一个子代理）；
    - 敲 `/sl 第一次` ⇒ `pending.json` 里应是 3 条，日志里 `未与已有标记合并（没有旧标记）`；
    - **把 B 的标签页关掉**（它随即从 `agents.list()` 里消失；也可以不管它、直接看下一轮的日志）；
    - 在 A 里调 `restart_dsh`（它会先 `saveAll` 再杀进程）⇒ 保存侧日志里应有
      `与已有新鲜标记合并：本次新增 0 条、保留 N 条（其中 N 条此刻已不在 live 表里）`，
      且 `pending.json` 里 **B 的条目仍在**（`file` / `active` / `activeWhy` 与第一次保存时逐字相同），
      `createdAt` 是**本次**保存的时间；
    - 重启后新进程里：B 的条目按它自己的 `active` 判定被唤醒或跳过（与旧行为一致），
      日志里 `发现待续标记：共 3 条…`（**不是 2 条** —— 这就是本次要修的丢条目）；
    - **反面判据**：若 `pending.json` 只剩 A、C 两条，说明合并没生效（查那一行 `与已有标记合并` 有没有出现、
      以及它写的是哪种"没合并"的原因）。
13. 回滚：`dshpm remove dsh-host-sl --profile web` + 删 `~\.dsh\storages\sl-handoff\`。

### 验收记录：2026-09-29 00:04–00:05（v0.5.1，协调者执行，用户在场）

| 步骤 | 结果 | 现场证据（`~\.dsh\storages\sl-handoff\sl-handoff.log`） |
|---|---|---|
| 2 `apply: v0.5.1` | ✅ | `15:59:12.014Z apply: v0.5.1 … 恢复上限=不限`（热启用后装载） |
| 5 `/sl` 覆盖所有活跃会话 | ✅ | 用户敲 `/sl 验收`：`16:04:43.637Z 枚举到 2 个活跃会话（顶层 2 / 子代理 0），逐个保存交接` + 两条 `已保存交接`；`pending.json` 两条分别 `active:true / activeWhy:["session"]` 与 `active:false / activeWhy:[]` |
| 10 空闲会话不注入 | ✅ | 保存侧 `其中 1 个会话保存这一刻没有在飞的活（active=false）⇒ 重启后不唤醒它们`；恢复侧 `发现待续标记：共 2 条…另有 1 条空闲会话（保存时无在飞的活）不注入` → `空闲会话 session-aaaa1111… 未注入（保存时无在飞的活），记录文件在 …` → `本次恢复结束：注入成功 1 条 / 跳过 1 条（空闲，不注入） / 失败 0 条 ⇒ 归档为 done`；那个空闲会话的会话文件停在保存那一刻、**之后一字未写**（没起任何一轮） |
| 10 归档语义 | ✅ | 标记改名为 `pending.done-20260928160541.json`（跳过算已处理，没留在 `pending.json` 里重试） |
| 8 / 9 子代理通知、唤醒死会话 | ⏳ 本次未覆盖 | 当时没有在跑的子代理（`子代理 0 个在跑`），需按步骤 8 人为造一次失败 |
| 11 旧标记兼容 | ⏳ 本次未覆盖 | 离线用例已钉住（`标记缺 active 字段（旧版），按"有活"处理`） |

**部署这次踩到的一个顺序坑（以后照做）**：`lib/*.js` 按 URL 缓存 ⇒ "改完 lib 后的第一次重启"里，
**保存**仍由内存中的旧代码执行，写出的标记没有 `active` 字段，新代码只能按"有活"处理 ⇒
那次重启会把所有空闲会话又唤醒一轮。绕法：先用 profile `cordis.patch.yml` 的**行级开关**
停用 `sl-handoff`（服务缺席 ⇒ `dsh-host-restart` fail-soft 跳过保存，一个字节都不写标记），
重启部署完再打开（新进程里首次装载 = 磁盘上的新代码），随后照常验收。

### 验收记录：2026-09-29（v0.6.0，协调者执行，用户在场）

| 项 | 结果 | 现场证据 |
|---|---|---|
| 新版本已装载 | ✅ | `17:51:46.215Z apply: v0.6.0 …`（01:55 那次启动同样是 v0.6.0） |
| `pendingSummary()` 真被用上 | ✅ | `dsh-restart.log` `17:51:50.683Z …(来源=service,kind=root,active=true)` —— 走的是服务方法，不是退回读文件 |
| 两条注入合并成一次 | ✅ | 会话侧**只收到一条**【sl 交接续跑】（没有单独的「已重启。…」）；同批 `17:51:52.124Z 恢复条目成功：顶层 session-aaaa1111…`；`dsh-restart.log` 有 `交接记录将接手注入，本次不再单独注入「已重启」` 与 `17:52:00.693Z …已接手,兜底注入跳过` |
| 空闲会话仍不唤醒 | ✅ | `17:51:52.100Z 空闲会话 session-aaaa1111… 未注入` + `跳过 1 条（空闲，不注入）` |
| 标记合并：**分支**走到 | ✅ | `17:54:31.724Z 未与已有标记合并（没有旧标记），本次直接写入 2 条` —— v0.6.0 的写入路径；当时那份 17:51 的标记已被消费归档，确实没有旧标记可并 |
| 标记合并：**并集保留** | ⏳ **用户 2026-09-29 决定不真机演** | 以离线为准：`test/pending-merge.test.mjs` 19 条 + 变异验证（改回覆盖语义 ⇒ 6 条红）。真机只验到"分支走到" |
| `/sl` 存档 + **非工具重启** ⇒ 启动自动唤醒 | ✅ | `17:54:31` 用户敲 `/sl`（保存 2 条）→ `17:54:38.979Z dsh 进程退出 code=4294967295`（硬杀，**无重启标记**）→ `17:54:59` 看门狗拉起 → `17:55:07.188Z 恢复条目成功：顶层 session-aaaa1111…`。这一轮**没有 `dsh-host-restart` 参与**（无标记、无「已重启」注入），纯靠这份存档唤醒 |
| **未覆盖** | — | ① 并集保留（上表，用户决定不演）；② 真机"先敲 `/sl`、关掉一个标签页、再走重启工具"的完整时间线没造过；③ v0.5.0 的子代理通知与"唤醒死会话"两条（要人为造失败） |

**同一轮里定下的口径**（用户 2026-09-29 拍板，别再问）：`/sl` 存下"当时空闲"的会话**保持现状** ——
`active:false` ⇒ 下次启动只留记录文件、不唤醒。即 `/sl` 之后能不能被叫回来，取决于**保存那一刻**
该会话有没有在飞的活（17:54 那次被唤回是因为发起会话当时正在跑；16:34 那次它空闲，就不会被唤回）。
