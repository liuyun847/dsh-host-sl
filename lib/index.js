/**
 * dsh-host-sl v0.7.4
 *
 * **实时活跃工作表 + 冷恢复唤醒**：不再需要人敲命令、不再渲染交接记录、不再写待续标记 ——
 * 插件实时维护一张「谁有没做完的事」的小表（`active-sessions.json`），dsh 崩溃或重启后
 * 按它把会话逐个**冷恢复**唤醒，注入的正文以**固定首句** `sl已接续会话,继续` 开头，
 * 后面再附上断点信息（在跑的子代理 / 未结算作业）。
 *
 * v0.7.2：**子代理接续结果会回报给父会话**（成功也报）。子代理能不能唤回来，只有在
 * "父会话已经活着"之后才试得出来（见设计点 11），所以结果没法并进那条续跑注入里 ——
 * 续跑注入里只加一句**预告**，真正的结果在子代理全部试完后按父会话**汇总一条通知**。
 * v0.7.3：那条通知**改成插队**（用户 2026-10-03：「第二条注入太慢了」）—— 父会话正在跑一轮时
 * 走 `agent.steer()`（宿主的 next-step 通道，正常情况下**同一轮内**就被模型看到），空闲才退回
 * `followup`（见 {@link pickOutcomeDelivery}）；同时按子代理评审（2026-10-03）的结论修掉四处：
 * **先冷唤醒父会话再试子代理**（否则 ❌ 通知自相矛盾）、通知按 **agent 对象** flush（原先按 id
 * 查 live store，刚冷恢复的父必然查不到 ⇒ 通知可能永久丢）、子代理侧补 **blank / 让位判定**
 * （原先 `⏸` 与"不再重试"两态在生产里不可达）、flush 文案与 `flushedFailures` 统计。
 * v0.7.4：第二轮复核（2026-10-03）又挑出两条 P2，都在这一版修掉 ——
 *   ① **阶段 1.5 不再裸唤醒"自己有条目"的父会话**：那种父会话该走 `wakeRoot`（带判定、带续跑
 *      注入、成功即移除）。裸唤醒会让**让位**的父会话只收到一条结果通知，而 `markResumeDone`
 *      之后跟踪器发现它没活就删掉条目 ⇒ **那条续跑注入永久丢失**；空会话父会话还会被"凭空
 *      造出非空会话"（见 {@link rootEntryIds} 处的注释）。
 *   ② **`steer` 之前先看 next-turn 是否清空**：`claim()` 先交 next-step、后交 1 条 next-turn，
 *      所以队列里还压着续跑注入（或用户消息 / goal 续轮）时插队会让结果跑到续跑指令**前面**
 *      ⇒ 退回 `followup` 保顺序（见 {@link pickOutcomeDelivery}）。
 *   另修：续跑注入里那句预告改成与通知**同源**（看工作表里的子代理条目，而不是 activity 清单）、
 *   两处引错的宿主行号、"同轮可见"不再说成"一定"（Stop/abort 与非 abort 错误两个例外）。
 *
 * ── 与 v0.6.0 的根本差别（用户 2026-09-29 的要求：「实时而且能复跑」）──────────────
 * v0.6.0 是**快照式**的：人敲 `/sl` 或重启插件在杀进程前调 `saveAll`，那一刻把每个活跃会话
 * 渲染成一份 2~4 KB 的 Markdown 摘要，写进 `pending.json`；下次启动读标记、把摘要注入回去。
 * 它的三个固有缺口：
 *   · **保存时机是离散的** —— 崩溃/断电/被硬杀时没有任何人来得及保存（`/sl` 是唯一兜底，
 *     所以它必须由人记得敲）；
 *   · **摘要是有损的** —— 记录只有最近 5 条用户目标 / 3 条进展 / 6 条工具调用；
 *   · **快照会过期** —— 「保存后、重启前」这段时间新起的工作不在里面。
 *
 * v0.7.0 把这三条一起解掉，靠的是**认清宿主已经提供了什么**（本机源码逐条核实，见下）：
 *
 *   ① **会话内容宿主已经实时落盘**（`dsh-session-persistence-jsonl` + checkpoint 策略）。
 *      插件的"保存"是重复劳动 —— 真正缺的只有"谁有没做完的事"这一张表。
 *   ② **冷恢复会把完整历史读回来**：`sessionController.resolveAgent(id)` →
 *      `resumeObserved` → `ctx.agents.resume({resumeSessionId})` → `agentLoop.resumeWith` →
 *      `handle.read(0, undefined)` 冷读整份日志 → 重建 Agent
 *      （`dsh-api-session-controller/lib/index.js:399-411`、`dsh-agent-loop/lib/index.js:1912-1955`）。
 *      所以唤醒时**不需要注入摘要** —— 模型看到的是自己完整的对话历史。
 *   ③ **宿主还会自动修「崩溃孤儿轮」**：冷恢复时 `interruptedTurnClosers(persisted)` 给
 *      日志尾部那个未闭合的 turn 补 `turn/end{reason:{kind:'interrupted'}}`
 *      （`dsh-agent-loop/lib/index.js:1947-1951`、`dsh-session/lib/types/repair.js:187`）。
 *      这就是"复跑"的宿主原生支持。
 *   ④ **宿主有统一的「会话活动」查询接口**：`ctx.waterfall('workspace/session-activity',
 *      {sessionId}, () => [])` 返回 `SessionActivity[]`（`{kind, items?}`），空数组 = 没有在飞的活。
 *      已注册的四类活动：`turn`（Agent 注册表）、`job`（作业注册表）、`subagent`（子代理运行时）、
 *      `schedule`（定时任务插件）—— 见 `dsh-workspace/lib/types/types.d.ts` 的
 *      `SessionActivityKindMap` 注释与各包的 `install*ArchiveAdmission`。宿主自己就用它判断
 *      "这个会话能不能归档"（`dsh-workspace/lib/index.js:529`）。**它返回的 items 就是断点信息**
 *      （哪个作业、哪个子代理）。⚠ 它的提供方是逐个可选的，所以本插件把它与自建判据**取并集**
 *      （见设计点 8），不拿它当唯一答案。
 *
 * ── 于是本版只做三件事 ─────────────────────────────────────────────────────────────
 *   1. **实时维护活跃工作表**（事件驱动，不轮询业务状态）：
 *        · `ctx.on('agent/status', …)`        —— 会话/子代理起停（turn 与 subagent 两类活动）
 *        · `ctx.on('goal/activation-changed')` —— armed goal 起停（goal 不在宿主活动体系里，单独查）
 *        · `jobs.events.subscribe(...)`       —— 后台作业起停（作业注册表自己的事件流）
 *        · 周期兜底 sweep（默认 30s）          —— 防漏事件（宿主事件面变动、订阅失败等）
 *      写盘防抖（默认 300ms 合并），原子写 `active-sessions.json`。
 *   2. **启动时冷恢复唤醒**：读表 → 两道闸门 → **先顶层、后子代理**逐条
 *      `resolveAgent`/`subagents.prompt` → 注入**固定首句 `sl已接续会话,继续` + 断点信息**
 *      （不再注入摘要）→ 唤醒成功后把条目从表里移除（失败留着，下次启动重试）→
 *      **子代理全部试完后，按父会话汇总一条「子代理接续结果」通知**（成功/失败/未尝试都列，
 *      见 {@link buildSubagentOutcomeNotice}）。
 *   3. **对外只保留 cordis 服务 `slHandoff`**：`saveAll()`（= 强制重算并落盘）与
 *      `pendingSummary()`（= 工作表摘要）**同名同形兼容**本机 `dsh-host-restart`，
 *      那个包因此零改动。
 *
 * ── 被删掉的东西（连同它们的机制）────────────────────────────────────────────────
 *   · `/sl` 命令（v0.4.1 起它等于 `saveAll`；自动化之后不再需要人敲）；
 *   · Markdown 摘要渲染（`renderHandoffDoc` / `summarizeMessages` / 各节上限…）——
 *     历史由宿主冷恢复提供，摘要只剩"有损复述"这一个作用；
 *   · `pending.json` 全套（结构版本 / 新鲜度 / 按会话取并集 / 归档原因）——
 *     被工作表取代：表是实时的，"陈旧"只可能是"上次崩溃很久以前"；
 *   · 「记录文件」`handoff-*.md`（每次一份、从不删）—— 用户明确要求"只保留最近一份、
 *     唤醒后就清理"，而唯一那份"最近状态"就是工作表本身。
 *
 * ── 关键设计点 ────────────────────────────────────────────────────────────────────
 *  1. **apply 绝不抛回 loader** —— 插件加载失败会让**整个 dsh 起不来**（2026-09-17 事故）。
 *  2. **`timer` 必须进 inject** —— `ctx.timeout` 是 timer 服务的 mixin，未声明就访问会抛错。
 *  3. **注入后必须 `await sessions.flush()`** —— 不 flush，进程再挂一次时注入的消息可能没落盘。
 *  4. **两道闸门缺一不可** —— 只看"有没有表"会把**热加载**误当成宿主启动；只看 `roots()`
 *     会在宿主刚起来（roots 为空）时永远不触发。
 *  5. **`resolveAgent` 不抛异常**，返回 `{agent}` 或 `{error}`，两条分支都要处理。
 *  6. **闸门① 的判据是「正在跑一轮」而不是「存在」** —— 浏览器标签页订阅会把空闲会话
 *     promote 成 live agent；按"存在"判会让核心功能在用户开着两个以上标签页时永远不触发。
 *  7. **跟踪器不删「不在 live 表里」的条目** —— 那些是上次崩溃留下的待办，属于恢复流程的
 *     输入；跟踪器只负责把**当前 live** 的会话状态刷新进去（否则启动瞬间就会把表清空）。
 *  8. **宿主活动与自建判据取并集，不是"主路径 + 回退"** —— `workspace/session-activity` 的
 *     提供方是**逐个可选**的（`dsh-agent` / `dsh-jobs` / `dsh-subagent` / `dsh-schedule` 各注册
 *     一类），而"少一类"与"那一类没有活"在返回值上同形（`ctx.waterfall` 无人应答时返回默认值
 *     `[]`）。所以自建判据（`agent.status` / 血缘子代理 / 未结算作业）**始终**参与，谁在场谁出力。
 *     ⚠ 曾按"探测 `ctx.get('workspace')` 判断体系在不在场"实现过，**那是错的**：那个服务的真名是
 *     `workspaceRegistry`，而且它只是这个 waterfall 的**发起方**，与"有没有人应答"无关。
 *  9. **唤醒成功才移除条目** —— 失败（父会话没起来 / 服务缺席 / 投递抛错）留着下次启动重试，
 *     否则那次唤醒失败就等于永久丢掉一个在飞的活。
 *  10. **`goal` 不在宿主活动体系里** —— `SessionActivityKindMap` 只有 turn/job/subagent/schedule。
 *      armed goal 由 `goal-round-driver` 在会话空闲时自动续轮，重启打断它 = 断了一条在飞的链，
 *      所以本插件单独用 `goals.get(agent)` 判它（读法照抄 `dsh-host-goal-subagent-gate`）。
 *  11. **子代理接续结果只能"事后"报，且成功也要报**（v0.7.2，用户 2026-10-03 的要求）——
 *      冷恢复子代理要求父 agent 此刻是 live 的，而父 agent 正是靠那条续跑注入才起来，
 *      所以**续跑注入发出时子代理一个都还没试过**（结果此刻不存在）。两个后果：
 *        · 续跑注入里只能放一句**预告**（{@link SUBAGENT_RESULT_PROMISE}）；
 *        · 真正的结果在子代理全部试完后，按父会话**汇总一条通知**
 *          （{@link buildSubagentOutcomeNotice}）—— 不逐条发，免得 N 个子代理刷 N 条消息。
 *      为什么成功也报：父会话原先只能"等子代理自己汇报"，而它可能不汇报（继续干活去了）；
 *      明确告诉它"已经唤回，接下来会自己向你汇报"才能让它别干等、也别重复派活。
 *      ⚠ 旧版只报失败（`SUBAGENT_FAILURE_HEADING` / `buildSubagentFailureNotice`），v0.7.2 已删除。
 *  12. **"事后"不等于"等下一轮"**（v0.7.3）—— 投递方式必须按父会话当时的状态选：
 *      在跑 ⇒ `steer`（next-step，同轮可见）；空闲 ⇒ `followup`（next-turn，下一轮第一条）。
 *      宿主 `claim()` 每轮只从 next-turn 取 **1 条**，所以两条 followup 天然是两轮 —— 这正是
 *      "第二条太慢"的根因；细节与源码行号见 {@link pickOutcomeDelivery}。
 *  13. **要试子代理，先确保它的父会话 live**（v0.7.3）—— 子代理条目可以独立于父条目存在，
 *      而"通知"和"投递"走的是同一个唤醒语义：先判"父不是 live"、再靠通知把父唤醒，那条 ❌
 *      通知就自相矛盾。所以阶段 1.5 先把这类父会话冷唤醒（评审 2026-10-03 实测复现）。
 *
 * ── 改动须知（两条踩过的坑，别再踩）──────────────────────────────────────────────
 *  · **清理要用 `ctx.effect(() => 返回清理函数)`，不是 `ctx.on('dispose', …)`**：本机 cordis
 *    在 fiber 卸载时发的是 `internal/plugin`，没有 `dispose` 这个事件（已 grep 核实）。
 *  · **`sessionController` 不进 inject**：它在 apply 时可能还没挂载，属于「注入时机」的可选依赖，
 *    用 `ctx.get()` + 轮询等待即可；进 inject 会让插件一直不 apply。
 *
 * ── 为什么一个宿主包都不 import（本机实测，2026-09-28）────────────────────────────
 * 本包按 PLAN §4 以 **`link:`** 装进 profile（工作区源码即运行副本）。`link:` 在 Windows 上是
 * Junction，而 Node 的 ESM 解析**按 realpath** 走 ⇒ 模块的真实路径留在工作区，
 * `@deepseek-ai/dsh-llm` 会从工作区逐级上找 `node_modules`，找不到就 ERR_MODULE_NOT_FOUND。
 * 而插件 import 失败发生在 apply 之前 ⇒ **连 fail-soft 的机会都没有**，dsh 直接起不来。
 * 所以本包只用 `node:*` 与相对路径；注入用的 user 消息自己造（形状与 `createUserMessage`
 * 逐字段一致，见 {@link buildUserMessage}，`test/message-shape.test.mjs` 拿真实工厂钉住它）。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'sl-handoff'

/**
 * 依赖服务。
 *
 * ⚠ `timer` 必须声明：`ctx.timeout` 是 timer 服务的 mixin，而 cordis 对**未声明注入的服务
 *   属性访问一律抛错**（2026-09-17 事故：漏声明 ⇒ apply 抛错 ⇒ 插件树加载失败 ⇒ dsh 起不来）。
 *
 * `sessions`（注入后 flush 落盘）与 `agents`（枚举 live agent）是硬依赖。
 *
 * **`commands` v0.7.0 起不再声明**：`/sl` 命令已删除，本插件不再注册任何命令。
 * `events` 相关能力（`ctx.on` / `ctx.waterfall`）**不需要声明** —— 它们是 cordis 内置能力，
 * 宿主自己的插件（`dsh-goal-round-driver` 的 `inject = ["agents","goals","sessions"]`、
 * `dsh-schedule` 的 `static inject = [...]`）同样用 `ctx.on` / `ctx.waterfall` 而不声明它。
 *
 * `sessionController` / `subagents` / `jobs` / `goals` / `workspace` **故意不声明**：
 * 它们是可选依赖（缺席只影响对应那条路径），用 `ctx.get()` 探测（见 {@link optionalService}）。
 */
export const inject = ['timer', 'sessions', 'agents']

/** 版本号：与 package.json 的 version 保持一致（日志里回显，便于确认"新版本已生效"）。 */
export const VERSION = '0.7.4'

/**
 * 对外服务名：把「确保工作表最新 / 读工作表摘要」暴露给同进程的其它宿主插件。
 *
 * 消费者（本机 `dsh-host-restart`）**不要**把它写进 `inject` —— 那样本插件不在时消费者
 * 整个不 apply；用 `ctx.get(SERVICE_NAME)` 可选读取 + fail-soft。
 */
export const SERVICE_NAME = 'slHandoff'

/** 活跃工作表文件名（唯一的状态文件；被消费后删除，不留归档）。 */
export const ACTIVE_FILENAME = 'active-sessions.json'
/** 流程日志文件名（落在 storageDir 里，回滚时随目录一起删）。 */
export const LOG_FILENAME = 'sl-handoff.log'
/** 工作表结构版本（与 v0.6.0 的 `pending.json` 是**两种不同的文件**，互不读取）。 */
export const TABLE_VERSION = 1

/** 注入消息的开头标记（供人一眼认出这是本插件的注入）。 */
export const INJECT_HEADING = '【sl 交接续跑】'
/**
 * 「子代理接续结果」通知的标题（v0.7.2 起：**成功也报**，不再只报失败）。
 *
 * ⚠ 它**故意不带** {@link INJECT_HEADING} 前缀：这条消息不是"续跑指令"，而是给父会话看的
 *   一条**通知**；带前缀会让它在下一次被当成"本插件自己的注入"而失去辨识度。
 */
export const SUBAGENT_OUTCOME_HEADING = '【sl 交接】子代理接续结果'

/**
 * 续跑注入里那句**预告**：告诉父会话"名下的子代理还没试、结果会另发一条消息"。
 *
 * 为什么必须有它：子代理要等父会话先活着才试得起来（见文件头设计点 11），所以这条注入发出时
 * 结果还不存在。不预告的话，父会话会以为清单里的子代理**已经在跑**，于是干等或重复派活。
 *
 * ⚠ 文案**不依赖"上面这些"**（v0.7.4）：预告的判据是"工作表里有没有它的子代理条目"
 * （与通知同源），而清单来自 activity —— 两者不一致时清单里可能压根没列子代理。
 */
export const SUBAGENT_RESULT_PROMISE =
  '（你名下的子代理要等你这轮起来之后才逐个尝试唤回 —— 宿主要求父会话先活着；接续结果会另发一条消息告诉你。）'

/** 结果通知里最多**逐条列出**多少个子代理（超出的折叠成一行，免得正文无界）。 */
export const SUBAGENT_OUTCOME_MAX_LINES = 8

/** 工作表条目的类型：恢复侧据此决定走哪条投递路径。 */
export const KIND_ROOT = 'root'
export const KIND_SUBAGENT = 'subagent'

/** 可选读取的服务名（用 `ctx.get()` 而不是 `ctx.<服务>`，见 {@link optionalService}）。 */
export const AGENTS_SERVICE = 'agents'
export const SUBAGENTS_SERVICE = 'subagents'
export const JOBS_SERVICE = 'jobs'
export const GOALS_SERVICE = 'goals'
/**
 * 宿主的活动查询事件名（waterfall，`(payload, next)`）。
 *
 * ⚠ **不要去探测"宿主活动体系在不在场"**（比如 `ctx.get('workspaceRegistry')`）：那是错的思路，
 * 两个理由 —— ① 这个 waterfall 是**本插件主动发起**的，应答者是各活动的提供方
 * （`dsh-agent` / `dsh-jobs` / `dsh-subagent` / `dsh-schedule`），与"工作区注册表在不在"无关；
 * ② 提供方是**逐个可选**的（某个包没装载就少一类），没有单一服务能代表"全都应答"。
 * 所以本插件改成**并集**：宿主活动 ∪ 自建判据（见 {@link probeSessionWork}），
 * 谁在场谁出力，缺了谁也不会漏判。
 */
export const ACTIVITY_EVENT = 'workspace/session-activity'

/**
 * 工作表里 `why` 的取值与**固定顺序**（排障用：一眼看出这条会话因为什么被判成"有活"）。
 *
 * 前三项与宿主的 `SessionActivityKindMap` 同名（`turn` / `job` / `subagent`），
 * 另加 `schedule`（宿主活动体系里有，本插件原样透传）与 `goal`（本插件单独查，见设计点 10）。
 */
export const ACTIVE_WHY_ORDER = ['turn', 'subagent', 'job', 'schedule', 'goal']

/** 「未结算的后台作业」的两个状态（与 `dsh-host-restart` 的 `runningJobCount` 逐字同口径）。 */
export const JOB_ACTIVE_STATUSES = ['running', 'stopping']

/** 写盘防抖：状态变化后合并这么久再落盘（崩溃最多丢这个窗口内的翻转）。 */
export const DEFAULT_DEBOUNCE_MS = 300
/** 周期兜底重算间隔：防漏事件（作业/定时任务的事件面变动、订阅失败等）。 */
export const DEFAULT_SWEEP_MS = 30000
/** 表里条目的陈旧上限：超过这个年龄的条目丢弃（默认 24 小时，防"几周前的表"被消费）。 */
export const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000
/** apply 后等多久再动手：避开宿主启动风暴，等会话持久化/查询栈就位。 */
export const DEFAULT_BOOT_DELAY_MS = 4000
/** 等 sessionController 出现的上限。 */
export const DEFAULT_CONTROLLER_WAIT_MS = 30000
/** 闸门②阈值：进程已运行超过这个时长 ⇒ 判定为**插件热加载**而不是宿主启动。 */
export const DEFAULT_BOOT_GRACE_MS = 5 * 60 * 1000
/**
 * 注入正文的总长度上限。
 *
 * 与 v0.6.0 的 6000 不同：那时注入的是**整份摘要**，现在注入的只有固定首句
 * `sl已接续会话,继续` + 断点信息（几个作业/子代理的名字），2000 字符绰绰有余；
 * 超长时截断并提示模型自己看历史。
 */
export const DEFAULT_RESUME_TEXT_MAX_CHARS = 2000
/** 一次启动最多唤醒多少条（0 = **不限**，默认）。 */
export const DEFAULT_RESUME_MAX_SESSIONS = 0

/**
 * 读一个**可选**服务（用 `ctx.get()`，不用 `ctx.<服务>` 属性访问）。
 *
 * 两条理由：
 *   · 属性访问在 cordis 里要求服务声明在 `inject` 里，否则**抛错**（2026-09-17 事故）；
 *   · 而这些服务本插件**故意不进 inject**：缺席时对应路径降级即可，不该让整个插件不 apply。
 * `ctx.get()` 自己也可能抛（代理/getter），所以这里一并收成 `undefined`。
 */
function optionalService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** 整数范围校验：非整数/越界都抛，避免把坏配置带进运行流程。 */
function assertIntegerInRange(field, value, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`sl-handoff: ${field} 必须是 ${min}~${max} 的整数，收到 ${JSON.stringify(value)}`)
  }
  return value
}

/** 校验并规范化配置；非法配置直接抛错（由 apply 的外层 try/catch 接住并降级）。 */
export function resolveConfig(config) {
  const cfg = config ?? {}
  const home = typeof cfg.home === 'string' && cfg.home.length > 0
    ? cfg.home
    : (process.env.DSH_HOME || join(homedir(), '.dsh'))
  const storageDir = typeof cfg.storageDir === 'string' && cfg.storageDir.length > 0
    ? cfg.storageDir
    : join(home, 'storages', 'sl-handoff')
  const logFile = typeof cfg.logFile === 'string' && cfg.logFile.length > 0
    ? cfg.logFile
    : join(storageDir, LOG_FILENAME)
  const requireColdAgent = cfg.requireColdAgent ?? false
  if (typeof requireColdAgent !== 'boolean') {
    throw new TypeError(`sl-handoff: requireColdAgent 必须是布尔值,收到 ${typeof requireColdAgent}`)
  }
  return {
    home,
    storageDir,
    activeFile: typeof cfg.activeFile === 'string' && cfg.activeFile.length > 0
      ? cfg.activeFile
      : join(storageDir, ACTIVE_FILENAME),
    logFile,
    staleMs: assertIntegerInRange('staleMs', cfg.staleMs ?? DEFAULT_STALE_MS, 60 * 1000, 30 * 24 * 60 * 60 * 1000),
    debounceMs: assertIntegerInRange('debounceMs', cfg.debounceMs ?? DEFAULT_DEBOUNCE_MS, 0, 60 * 1000),
    sweepMs: assertIntegerInRange('sweepMs', cfg.sweepMs ?? DEFAULT_SWEEP_MS, 1000, 60 * 60 * 1000),
    bootDelayMs: assertIntegerInRange('bootDelayMs', cfg.bootDelayMs ?? DEFAULT_BOOT_DELAY_MS, 0, 10 * 60 * 1000),
    controllerWaitMs: assertIntegerInRange('controllerWaitMs', cfg.controllerWaitMs ?? DEFAULT_CONTROLLER_WAIT_MS, 0, 5 * 60 * 1000),
    bootGraceMs: assertIntegerInRange('bootGraceMs', cfg.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS, 0, 24 * 60 * 60 * 1000),
    resumeTextMaxChars: assertIntegerInRange('resumeTextMaxChars', cfg.resumeTextMaxChars ?? DEFAULT_RESUME_TEXT_MAX_CHARS, 200, 100000),
    // 0 = 不限（默认）。上限只影响"一次启动唤醒多少条"，超出的条目留在表里等下次启动。
    resumeMaxSessions: assertIntegerInRange('resumeMaxSessions', cfg.resumeMaxSessions ?? DEFAULT_RESUME_MAX_SESSIONS, 0, 10000),
    requireColdAgent,
  }
}

/**
 * 兜底日志路径。apply 抛错时 config 可能还没解析成功，只能用环境变量或默认值 ——
 * `DSH_SL_LOG_FILE` 主要给测试隔离用（生产不必设）。
 */
export function fallbackLogFile() {
  const fromEnv = process.env.DSH_SL_LOG_FILE
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'sl-handoff', LOG_FILENAME)
}

/** 错误文本：RemoteError 也只是一条 message。 */
export function errText(error) {
  if (error === undefined || error === null) return '未知错误'
  if (typeof error === 'string') return error
  return error.message ?? String(error)
}

function delay(ms) {
  return new Promise((res) => { setTimeout(res, ms) })
}

/** ISO 时间戳 + 来源标签，追加一行日志；日志写不进去就退到 stdout（宿主 stdout 由看门狗收走）。 */
function appendLog(logFile, source, message) {
  const line = `${new Date().toISOString()}  [${source}] ${message}\n`
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    appendFileSync(logFile, line)
  } catch {
    try { process.stdout.write(`[sl-handoff] ${message}\n`) } catch { /* 忽略 */ }
  }
}

/**
 * 原子写：先写 `.tmp-` 再 rename（同目录 rename 在同一卷上是原子的）。
 *
 * 工作表是崩溃后唯一的输入，绝不能出现"写了一半"的文件 —— 那会让恢复流程读到坏 JSON。
 * 写失败时清掉临时文件，绝不留下 `.tmp-` 残骸（那会让下一次写也失败）。
 */
function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, text)
    renameSync(tmp, file)
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* 可能根本没建成 */ }
    return false
  }
}

/** 读文本文件；不存在/读不出都返回 undefined（调用方据此区分"没有"与"读不到"）。 */
function readTextFile(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** 会话 id 的短前缀（日志里用它认人；剥掉 `session-` 前缀再取 8 位字母数字）。 */
export function sessionPrefix(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId : ''
  const tail = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  const cleaned = tail.replace(/[^A-Za-z0-9]/g, '')
  const fallback = raw.replace(/[^A-Za-z0-9]/g, '')
  return (cleaned.length > 0 ? cleaned : fallback).slice(0, 8) || 'unknown'
}

/** 折叠空白成单行并截断（日志与正文里每一条都只占一行，长度可预测）。 */
export function oneLine(text, maxChars) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, Math.max(0, maxChars - 1))}…`
}

// ────────────────────────────────────────────────────────────────────────────────
// 血缘：谁是顶层、谁挂在谁名下
// ────────────────────────────────────────────────────────────────────────────────

/** 取 live agent 的会话 id（拿不到返回 undefined）。 */
function agentSessionId(agent) {
  const id = agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** 这条 live agent 是不是"子代理会话"（判据与 dsh-subagent 的 `runningDescendants` 同口径）。 */
export function isSubagentAgent(agent) {
  return agent?.session?.header?.origin === 'subagent'
}

/**
 * 沿**持久血缘**（`session.header.parentSession`）上溯到顶，返回最高层的会话 id。
 *
 * 思路照本机 `dsh-host-restart` 的 `lineageTopId`：链上出现 `ownerId` 就返回它本身，
 * 调用方据此判断"这是它的后代"。父会话已不在 live 表里时用持久 id 收尾（宁多认一层血缘）；
 * 血缘损坏成环则用已知最高层收尾，不会无限走。
 */
export function lineageTopId(agent, byId, ownerId) {
  const visited = new Set()
  let current = agent
  let top = agentSessionId(agent)
  while (top !== undefined && top !== ownerId) {
    const parentId = current?.session?.header?.parentSession
    if (typeof parentId !== 'string' || parentId.length === 0) return top
    if (visited.has(parentId)) return top
    visited.add(parentId)
    top = parentId
    current = byId.get(parentId)
  }
  return top
}

/**
 * 枚举 `ctx.agents.list()` 里的每一个 live agent（顶层 + 子代理）。
 *
 * `agents.list()` 是**唯一含子代理的入口**（`roots()` 按 `owner === undefined` 过滤，
 * 子代理天然不在里面）—— `dsh-agent/lib/index.js:612` / `:621`。
 *
 * @returns {{available:true, items:Array<{session, agent, sessionId, kind, parentSessionId}>}
 *   | {available:false, reason:string, items:Array}}
 */
export function enumerateActiveSessions(ctx) {
  const agents = optionalService(ctx, AGENTS_SERVICE)
  if (agents === null || typeof agents !== 'object' || typeof agents.list !== 'function') {
    return { available: false, reason: 'agents 服务没有 list()（枚举不到 live agent）', items: [] }
  }
  let live
  try {
    live = agents.list()
  } catch (error) {
    return { available: false, reason: `枚举 live agent 抛错（${errText(error)}）`, items: [] }
  }
  if (!Array.isArray(live)) return { available: false, reason: `agents.list() 返回的不是数组（${typeof live}）`, items: [] }
  const items = []
  for (const agent of live) {
    const session = agent?.session
    const sessionId = agentSessionId(agent)
    if (sessionId === undefined) continue
    const kind = isSubagentAgent(agent) ? KIND_SUBAGENT : KIND_ROOT
    const parentSessionId = typeof session?.header?.parentSession === 'string' ? session.header.parentSession : ''
    // 子代理必须有父会话 id 才唤得回来（投递要靠它）；没有就跳过它，别拖垮整批
    if (kind === KIND_SUBAGENT && parentSessionId.length === 0) continue
    items.push({ session, agent, sessionId, kind, parentSessionId })
  }
  return { available: true, items }
}

/** 会话标题（可选服务 `sessionTitle`，拿不到留空 —— 绝不编造）。 */
export function sessionTitleOf(ctx, session) {
  try {
    const service = optionalService(ctx, 'sessionTitle')
    if (service === null || typeof service !== 'object' || typeof service.get !== 'function') return ''
    const view = service.get(session)
    const title = view?.title
    return typeof title === 'string' ? title : ''
  } catch {
    return ''
  }
}

/** 会话工作目录（`header.cwd`；拿不到留空）。 */
function sessionCwdOf(session) {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

// ────────────────────────────────────────────────────────────────────────────────
// 活动查询：这个会话有没有在飞的活
// ────────────────────────────────────────────────────────────────────────────────

/**
 * 问宿主：「这个会话此刻有没有在飞的活」。
 *
 * 走 `ctx.waterfall(ACTIVITY_EVENT, {sessionId}, () => [])` —— 与宿主归档判定**逐字同一条调用**
 * （`dsh-workspace/lib/index.js:529`）。各活动提供方（`dsh-agent` 的 turn、`dsh-jobs` 的 job、
 * `dsh-subagent` 的 subagent、`dsh-schedule` 的 schedule）在 waterfall 上追加自己那一类，返回形如：
 *   `[{kind:'turn'}, {kind:'job', items:[{id:'bash-3', label:'…'}]}, {kind:'subagent', items:[…]}]`
 * 空数组 = 没有在飞的活。
 *
 * ⚠ **返回 `[]` 不能单独当成"没有活"**：某个提供方没装载时就少一类，而"少一类"与"那一类没有活"
 *   在返回值上同形。所以调用方（{@link probeSessionWork}）把它与自建判据**取并集**，不拿它当唯一答案。
 *
 * @returns {Promise<{ok:true, items:Array}|{ok:false, reason:string, items:Array}>}
 *   `ok:false` 只表示"这次查询没拿到可用答案"（抛错 / 形态不符 / cordis 不支持），**不**表示"没有活"。
 */
export async function querySessionActivity(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') {
    return { ok: false, reason: 'ctx.waterfall 不可用（cordis 版本不符）', items: [] }
  }
  let result
  try {
    result = await ctx.waterfall(ACTIVITY_EVENT, { sessionId }, () => Promise.resolve([]))
  } catch (error) {
    return { ok: false, reason: `活动查询抛错（${errText(error)}）`, items: [] }
  }
  if (!Array.isArray(result)) {
    return { ok: false, reason: `活动查询返回形态不符（${typeof result}）`, items: [] }
  }
  return { ok: true, items: result }
}

/**
 * 该 owner 会话名下**未结算**的后台作业数（`running` / `stopping`）。
 *
 * 形状照抄本机 `dsh-host-restart` 的 `runningJobCount`：`jobs.list(ownerId)` 会把"无主作业"
 * 一并返回，所以必须再按 `job.owner` 精确筛一遍，否则会把别的会话的作业算到这条头上。
 *
 * fail-soft：服务缺失 / 形态不符 / 枚举抛错一律当作 **0**（这条判据不该让整次判定变成"无法判定"）。
 * 保守方向与其余判据相反，但它只在**回退路径**上用（宿主活动体系在场时由宿主回答这一类），
 * 且其余判据任一命中就足以判"有活"。
 */
export function runningJobCount(ctx, ownerId) {
  const jobs = optionalService(ctx, JOBS_SERVICE)
  if (jobs === null || typeof jobs !== 'object' || typeof jobs.list !== 'function') return 0
  let views
  try {
    views = jobs.list(ownerId)
  } catch {
    return 0
  }
  if (!Array.isArray(views)) return 0
  return views.filter((job) => job?.owner === ownerId && JOB_ACTIVE_STATUSES.includes(job.status)).length
}

/**
 * 这个 live agent 名下有没有**活跃 goal**（`phase === 'active'` 且 `activation === 'armed'`）。
 *
 * 读法照抄本机 `dsh-host-goal-subagent-gate`（已跑通并验收过的那个插件）：
 * `ctx.get('goals').get(agent)` —— **参数是 exact live agent 对象，不是会话 id**
 * （`dsh-goal/lib/index.js:611-614` 的 `get(agent)` 先 `assertLive(agent)`，传 id 会抛
 * `GOAL_AGENT_NOT_LIVE`）。
 *
 * 为什么"活跃 goal"算有活：armed 的 goal 由 driver 自动续轮（`goal-round-driver` 在会话空闲时
 * 起下一轮），重启把它打断 = 那条自动续轮链断了 —— 与"在跑一轮"是同一类在飞的活。
 * 它**不在**宿主的 `SessionActivityKindMap` 里（那里只有 turn/job/subagent/schedule），
 * 所以本插件单独查（设计点 10）。
 *
 * fail-soft：服务缺席 / 形态不符 / `get()` 抛错 / 返回形态不符 ⇒ **false** + 一行日志。
 */
export function hasActiveArmedGoal(ctx, log, agent, sessionId) {
  if (agent === null || typeof agent !== 'object') return false
  const goals = optionalService(ctx, GOALS_SERVICE)
  if (goals === null || typeof goals !== 'object' || typeof goals.get !== 'function') {
    log?.(`goals 服务不可用（没有 get()），会话 ${sessionId} 的"活跃 goal"这条判据本次不参与`)
    return false
  }
  let goal
  try {
    goal = goals.get(agent)
  } catch (error) {
    log?.(`读会话 ${sessionId} 的 goal 失败（${errText(error)}），"活跃 goal"这条判据本次不参与`)
    return false
  }
  if (goal === null || typeof goal !== 'object') return false
  return goal.phase === 'active' && goal.activation === 'armed'
}

/**
 * 自建判据：自己在本轮运行（turn）/ 名下子代理在跑（subagent）/ 未结算作业（job）。
 *
 * 这三条与 v0.6.0 的判据 ①②③ 同源。它们**始终**参与判定（与宿主活动取**并集**，不是"回退"）：
 *   · 宿主活动的提供方是逐个可选的（某个包没装载就少一类），而自建判据只依赖 `agents` / `jobs`
 *     两个服务，覆盖面稳定；
 *   · 代价是每次状态变化多跑一次 O(live) 扫描 + 一次 `jobs.list()` —— 会话数与作业数天然有界
 *     （受 `maxActiveSubagents` 与用户开着的标签页数限制），这个成本换"绝不漏判"是划算的。
 * `goal` 不在这里：它无论走哪条路都是本插件单独查的（宿主活动体系里没有这一类）。
 */
function fallbackActivity(ctx, log, sessionId, agent, live) {
  const why = []
  if (agent?.status === 'running') why.push('turn')
  const items = Array.isArray(live?.items) ? live.items : []
  const byId = new Map()
  for (const entry of items) {
    if (entry !== null && typeof entry === 'object' && typeof entry.sessionId === 'string') {
      byId.set(entry.sessionId, entry.agent)
    }
  }
  for (const entry of items) {
    if (entry?.agent?.status !== 'running') continue
    if (entry.sessionId === sessionId) continue
    if (entry.kind !== KIND_SUBAGENT) continue
    if (lineageTopId(entry.agent, byId, sessionId) !== sessionId) continue
    why.push('subagent')
    break
  }
  if (runningJobCount(ctx, sessionId) > 0) why.push('job')
  return why
}

/**
 * 判定一条会话**此刻有没有在飞的活** —— 工作表条目的唯一来源。
 *
 * 判据是**两路的并集**（谁在场谁出力，缺了谁也不会漏判）：
 *   ① **宿主活动**（`workspace/session-activity`）：turn / job / subagent / schedule 四类，
 *      口径与宿主归档判定同源，还白捡 `schedule` 这一类；
 *   ② **自建判据**（{@link fallbackActivity}）：turn / subagent / job，只依赖 `agents` 与 `jobs`；
 *   ③ **`goal`** 单独查（宿主活动体系里没有这一类）。
 * 为什么不是"主路径 + 回退"：宿主活动的提供方是**逐个可选**的（`dsh-agent` / `dsh-jobs` /
 * `dsh-subagent` / `dsh-schedule` 各注册一类），而"少一类"与"那一类没有活"在返回值上同形 ——
 * 拿它当唯一答案就会漏判。
 *
 * ── fail-soft（保守方向一律是"按有活处理"）────────────────────────────────────────
 *   · `agents` 服务拿不到 / 形态不符 ⇒ 判不了 ⇒ `active: true` + 一行日志；
 *   · 宿主活动查询失败 ⇒ 只靠自建判据（**不**当成"没有活"）；
 *   · 整体抛错 ⇒ `active: true` + 一行日志（绝不让判定失败变成"少唤醒一个会话"）。
 *
 * @param live {@link enumerateActiveSessions} 的返回值（**同一次 `agents.list()` 的快照**）。
 * @returns {Promise<{active:boolean, why:string[], activity:Array, goal:boolean, undecidable?:string}>}
 */
export async function probeSessionWork(ctx, log, sessionId, agent, live) {
  try {
    const why = []
    let activityItems = []
    let undecidable
    if (live === null || typeof live !== 'object' || live.available !== true) {
      // 枚举不到 live 表 ⇒ 连"这个会话还在不在"都判不了 ⇒ 保守按有活处理（宁可多唤醒一次）
      undecidable = typeof live?.reason === 'string' && live.reason.length > 0 ? live.reason : 'agents 服务不可用'
      log?.(`无法判定会话 ${sessionId} 有没有在飞的活（${undecidable}）⇒ 按"有活"处理（宁可多唤醒一次，也不丢掉在飞的活）`)
      why.push('turn')
    } else {
      // ① 宿主活动（多一类 schedule；提供方缺席时会少类，所以不单独采信）
      const queried = await querySessionActivity(ctx, sessionId)
      if (queried.ok) {
        activityItems = queried.items
        for (const entry of queried.items) {
          const kind = entry !== null && typeof entry === 'object' && typeof entry.kind === 'string' ? entry.kind : undefined
          if (kind !== undefined && !why.includes(kind)) why.push(kind)
        }
      } else {
        log?.(`会话 ${sessionId} 的宿主活动查询不可用（${queried.reason}）⇒ 只靠自建判据`)
      }
      // ② 自建判据**始终**跑（并集，不是回退）：覆盖"某个活动提供方没装载"时缺失的那一类
      for (const kind of fallbackActivity(ctx, log, sessionId, agent, live)) {
        if (!why.includes(kind)) why.push(kind)
      }
    }
    const goal = hasActiveArmedGoal(ctx, log, agent, sessionId)
    if (goal) why.push('goal')
    return {
      active: why.length > 0,
      why: ACTIVE_WHY_ORDER.filter((kind) => why.includes(kind)),
      activity: activityItems,
      goal,
      undecidable,
    }
  } catch (error) {
    log?.(`判定会话 ${sessionId} 有没有在飞的活时抛错（${errText(error)}）⇒ 按"有活"处理`)
    return { active: true, why: [], activity: [], goal: false, undecidable: `判定抛错：${errText(error)}` }
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// 活跃工作表：读写与形状
// ────────────────────────────────────────────────────────────────────────────────

/**
 * 把工作表规范化成「条目列表」。
 *
 * 形状（v1）：
 * ```json
 * { "version": 1, "updatedAt": 1759048200000,
 *   "items": [ { "sessionId": "session-…", "kind": "root", "parentSessionId": "",
 *                "title": "…", "cwd": "…", "why": ["turn"], "goal": false,
 *                "activity": [{"kind":"turn"}], "since": 1759048100000, "updatedAt": 1759048200000 } ] }
 * ```
 *
 * 与 v0.6.0 的 `pending.json` 的两处关键差别：
 *   · **表里只有"此刻有活"的会话**（空闲会话不在表里 ⇒ 崩溃后不唤醒它，延续 v0.5.1 的口径）；
 *   · **没有 `done` / `notified` / `active` 这些位** —— "在表里"本身就等于"有活且待唤醒"，
 *     唤醒成功即移除条目，不需要第二个位来表达同一件事。
 *
 * @returns {{updatedAt:number, items:Array}|undefined} `undefined` = 结构损坏（缺字段/类型不对/空列表）。
 */
export function normalizeTable(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const updatedAt = raw.updatedAt
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  if (!Array.isArray(raw.items)) return undefined
  const items = []
  for (const item of raw.items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    if (typeof item.sessionId !== 'string' || item.sessionId.length === 0) continue
    items.push({
      sessionId: item.sessionId,
      kind: item.kind === KIND_SUBAGENT ? KIND_SUBAGENT : KIND_ROOT,
      parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : '',
      title: typeof item.title === 'string' ? item.title : '',
      cwd: typeof item.cwd === 'string' ? item.cwd : '',
      why: Array.isArray(item.why) ? item.why.filter((kind) => typeof kind === 'string') : [],
      goal: item.goal === true,
      activity: Array.isArray(item.activity) ? item.activity : [],
      since: typeof item.since === 'number' && Number.isFinite(item.since) ? item.since : updatedAt,
      updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : updatedAt,
    })
  }
  // 空列表是**合法**状态（表存在但没人在跑）—— 与"结构损坏"区分开
  return { updatedAt, items }
}

/**
 * 判定一份工作表该不该被消费。
 *
 * 与 v0.6.0 的三态判定同形，但语义更简单：表是**实时**的，所以
 *   · `fresh`   —— 表里的条目还值得唤醒（按 `updatedAt` 算年龄）；
 *   · `stale`   —— 表太旧（默认 24h）：多半是"崩溃很久之后才重启"，唤醒它没有意义；
 *   · `invalid` —— 结构损坏或时间戳在未来（时钟异常/手工编辑）。
 */
export function classifyTable(raw, now, staleMs) {
  const normalized = normalizeTable(raw)
  if (normalized === undefined) return 'invalid'
  if (normalized.updatedAt - now > 60 * 1000) return 'invalid'
  if (now - normalized.updatedAt > staleMs) return 'stale'
  return 'fresh'
}

/** 读工作表文件：`{kind:'absent'|'parsed'|'unreadable', raw?, reason?}`（三种情形必须可区分）。 */
export function readTableFile(file) {
  const text = readTextFile(file)
  if (text === undefined) return { kind: 'absent' }
  try {
    return { kind: 'parsed', raw: JSON.parse(text) }
  } catch (error) {
    return { kind: 'unreadable', reason: `JSON 解析失败（${errText(error)}）` }
  }
}

/** 把条目列表序列化成工作表文本（写入用；`updatedAt` 由调用方给）。 */
export function serializeTable(items, updatedAt) {
  return `${JSON.stringify({ version: TABLE_VERSION, updatedAt, items }, null, 2)}\n`
}

/** 摘要：工作表条目的只读投影（服务方法 `pendingSummary()` 用）。 */
export function summarizeTable(raw) {
  const normalized = normalizeTable(raw)
  if (normalized === undefined) return undefined
  return normalized.items.map((item) => ({
    sessionId: item.sessionId,
    kind: item.kind,
    // 表里的条目一律"待唤醒"：`done` 恒 false（新结构没有这个位），`active` 恒 true
    done: false,
    active: true,
    wake: true,
  }))
}

// ────────────────────────────────────────────────────────────────────────────────
// 实时跟踪器：事件驱动维护工作表
// ────────────────────────────────────────────────────────────────────────────────

/**
 * 建一个跟踪器：把「谁有在飞的活」实时维护成一张表，并落盘。
 *
 * ── 事件源（三条 + 一条兜底）────────────────────────────────────────────────────
 *   · `ctx.on('agent/status', ({agent, status}))`  —— 会话与子代理的起停。宿主在 status
 *     **变化**时才 emit（`dsh-agent-loop/lib/index.js:794-799` 的 `setPhase`），所以它天然是
 *     "翻转驱动"而不是"每步都响"，可以直接当触发器。
 *   · `ctx.on('goal/activation-changed', ({sessionId}))` —— armed goal 起停
 *     （`dsh-goal/lib/index.js:798`）。
 *   · `jobs.events.subscribe({owners:'all'}, listener)` —— 后台作业的注册/停止/结算
 *     （`dsh-jobs-local/lib/index.js:408-410` 的 `get events()`）。**这是服务自己的事件流，
 *     不是 cordis 事件**，所以要单独订阅并处理它的失败。
 *   · **周期 sweep**（默认 30s）—— 兜底：事件面变动、订阅失败、或某类活动本就没有事件时，
 *     靠它把状态追平。它是"实时"的保险丝，不是主路径。
 *
 * ── 两条关键语义 ────────────────────────────────────────────────────────────────
 *   ① **只刷新 live 表里存在的会话；不删不在 live 表里的条目**（设计点 7）。
 *      启动瞬间 live 表是空的，若按"不在表里就删"处理，会把上次崩溃留下的待办**在恢复流程
 *      读它之前**全部清掉。
 *   ② **写盘防抖**（默认 300ms 合并）：状态翻转可能很密集（一轮里 running→idle→running），
 *      每次都落盘既无必要也会放大 IO。防抖窗口内崩溃最多丢这 300ms 的翻转 —— 代价写在这里。
 *
 * @returns 跟踪器对象：`{refresh, refreshAll, flush, snapshot, summary, load, dispose}`。
 */
export function createTracker(ctx, resolved, log, isDisposed) {
  /** sessionId → 条目（内存态是权威，磁盘是它的持久化副本）。 */
  const entries = new Map()
  let lastUpdatedAt = Date.now()
  let debounceTimer
  let sweepTimer
  let disposed = false
  /** 正在重算的会话（防重入：同一会话的事件可能连发） */
  const inFlight = new Set()
  /**
   * 本次启动**从磁盘加载**的会话 id。
   *
   * ⚠ 它们与"本次运行中新增的条目"必须区别对待：恢复流程（apply 后 4s）才是消费它们的唯一
   *   地方，而跟踪器的事件监听在那之前就已经注册好了。若不加区分，一个"上次崩溃时在跑、
   *   这次启动被浏览器标签页重新订阅成 idle"的会话会在恢复流程读表**之前**被 sweep/事件
   *   判成"无活"而移除 ⇒ 那次交接静默丢失。所以：恢复流程跑完之前，这些条目只刷新不移除。
   */
  const loadedIds = new Set()
  /** 恢复流程是否已经跑完（跑完之后，加载来的条目也按正常语义增删）。 */
  let resumeDone = false

  /** 从磁盘加载上次留下的条目（只加载，不清理）。 */
  function load() {
    const read = readTableFile(resolved.activeFile)
    if (read.kind === 'absent') {
      log('启动时没有活跃工作表（首次运行或上次正常退出），从空表开始')
      return { kind: 'absent' }
    }
    if (read.kind === 'unreadable') {
      log(`活跃工作表读不出（${read.reason}），按空表开始（旧文件保留不动）`)
      return { kind: 'unreadable', reason: read.reason }
    }
    const verdict = classifyTable(read.raw, Date.now(), resolved.staleMs)
    if (verdict !== 'fresh') {
      log(`活跃工作表判定为 ${verdict}，不消费（旧文件保留不动）`)
      return { kind: verdict }
    }
    const normalized = normalizeTable(read.raw)
    for (const item of normalized.items) {
      entries.set(item.sessionId, item)
      loadedIds.add(item.sessionId)
    }
    lastUpdatedAt = normalized.updatedAt
    log(`活跃工作表已加载：${normalized.items.length} 条待唤醒（顶层 ${normalized.items.filter((i) => i.kind === KIND_ROOT).length}`
      + ` / 子代理 ${normalized.items.filter((i) => i.kind === KIND_SUBAGENT).length}，表龄 ${Math.round((Date.now() - normalized.updatedAt) / 1000)}s）`)
    return { kind: 'fresh', count: normalized.items.length }
  }

  /** 立即落盘（原子写）；表空时**删除文件**（"没有文件"就是"没有待办"）。 */
  function flush() {
    if (disposed) return false
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
    const items = [...entries.values()]
    if (items.length === 0) {
      try {
        unlinkSync(resolved.activeFile)
      } catch { /* 本来就没有 */ }
      return true
    }
    const updatedAt = Date.now()
    const ok = writeFileAtomic(resolved.activeFile, serializeTable(items, updatedAt))
    if (ok) {
      lastUpdatedAt = updatedAt
    } else {
      log(`活跃工作表写盘失败（${resolved.activeFile}）—— 内存态仍然正确，下次状态变化会再试`)
    }
    return ok
  }

  /** 防抖落盘：状态变化后合并 debounceMs 再写。 */
  function schedule() {
    if (disposed) return
    if (resolved.debounceMs === 0) {
      flush()
      return
    }
    if (debounceTimer !== undefined) return
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      flush()
    }, resolved.debounceMs)
    // 不阻止进程退出（这是一个后台维护任务）
    debounceTimer.unref?.()
  }

  /** 写入/更新一条条目（`since` 只在首次插入时记，后续刷新保持原值）。 */
  function upsert(sessionId, entry) {
    const previous = entries.get(sessionId)
    entries.set(sessionId, {
      ...entry,
      since: previous?.since ?? entry.updatedAt,
    })
  }

  /**
   * 重算**一个会话**的条目（它的 agent 必须此刻是 live 的）。
   * 有活 ⇒ 写入/更新；无活 ⇒ 移除。返回条目或 undefined（= 无活）。
   */
  async function refresh(sessionId, agent, kind, parentSessionId, session, live) {
    if (disposed || isDisposed?.() === true) return undefined
    if (inFlight.has(sessionId)) return entries.get(sessionId)
    inFlight.add(sessionId)
    try {
      const probed = await probeSessionWork(ctx, log, sessionId, agent, live)
      if (!probed.active) {
        // 恢复流程跑完之前，**从磁盘加载**的条目只刷新不移除（见 loadedIds 的注释）：
        // 它们代表"上次崩溃时还有活"，那一刻的状态只有恢复流程有资格消费。
        if (loadedIds.has(sessionId) && !resumeDone) return entries.get(sessionId)
        if (entries.delete(sessionId)) {
          log(`会话 ${sessionId} 已无在飞的活 ⇒ 从工作表移除`)
          schedule()
        }
        return undefined
      }
      const now = Date.now()
      const entry = {
        sessionId,
        kind: kind ?? (isSubagentAgent(agent) ? KIND_SUBAGENT : KIND_ROOT),
        parentSessionId: parentSessionId ?? (typeof session?.header?.parentSession === 'string' ? session.header.parentSession : ''),
        title: sessionTitleOf(ctx, session),
        cwd: sessionCwdOf(session),
        why: probed.why,
        goal: probed.goal === true,
        activity: probed.activity,
        updatedAt: now,
      }
      const previous = entries.get(sessionId)
      upsert(sessionId, entry)
      // 只在"新出现 / 判据组合变了"时写一行日志，避免每次心跳都刷屏
      if (previous === undefined || previous.why.join(',') !== entry.why.join(',')) {
        log(`会话 ${sessionId} 有在飞的活（${entry.why.join('+') || '未知'}${probed.undecidable !== undefined ? `，判据不可靠：${probed.undecidable}` : ''}）⇒ 写入工作表`)
      }
      schedule()
      return entry
    } finally {
      inFlight.delete(sessionId)
    }
  }

  /**
   * 重算**所有 live 会话**（周期 sweep 与 `saveAll` 用它）。
   *
   * ⚠ 不碰"不在 live 表里"的条目（设计点 7）：那些是上次崩溃留下的待办，属于恢复流程的输入。
   */
  async function refreshAll() {
    if (disposed || isDisposed?.() === true) return { scanned: 0, active: 0 }
    const live = enumerateActiveSessions(ctx)
    if (!live.available) {
      log(`周期重算跳过：${live.reason}`)
      return { scanned: 0, active: 0 }
    }
    for (const item of live.items) {
      if (disposed || isDisposed?.() === true) break
      await refresh(item.sessionId, item.agent, item.kind, item.parentSessionId, item.session, live)
    }
    return { scanned: live.items.length, active: entries.size }
  }

  /** 按 agent 对象重算（事件回调用：它手里只有 agent，需要自己算出血缘归属）。 */
  async function refreshForAgent(agent) {
    const sessionId = agentSessionId(agent)
    if (sessionId === undefined) return
    const live = enumerateActiveSessions(ctx)
    const item = live.available ? live.items.find((entry) => entry.sessionId === sessionId) : undefined
    await refresh(sessionId, agent, item?.kind, item?.parentSessionId, agent.session, live)
  }

  // ── 事件注册（任何一条失败都只降级 + 日志，绝不影响其它路径）──────────────────
  const disposers = []
  const on = (event, handler, label) => {
    try {
      if (typeof ctx.on !== 'function') {
        log(`${label} 注册失败：ctx.on 不可用（cordis 版本不符）—— 该事件源不参与实时更新`)
        return
      }
      const dispose = ctx.on(event, handler)
      disposers.push(dispose)
      log(`${label} 已注册（事件 ${event}）`)
    } catch (error) {
      log(`${label} 注册失败（${errText(error)}）—— 该事件源不参与实时更新`)
    }
  }
  on('agent/status', ({ agent }) => {
    // 事件分发是同步的，而重算是异步的（要 await waterfall）⇒ fire-and-forget，
    // 但要把 rejection 收干净，否则会变成 unhandledRejection 打到宿主。
    void refreshForAgent(agent).catch((error) => log(`agent/status 触发的重算失败：${errText(error)}`))
  }, '会话状态监听')
  on('goal/activation-changed', ({ sessionId }) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const live = enumerateActiveSessions(ctx)
    const item = live.available ? live.items.find((entry) => entry.sessionId === sessionId) : undefined
    if (item === undefined) return
    void refresh(sessionId, item.agent, item.kind, item.parentSessionId, item.session, live)
      .catch((error) => log(`goal 事件触发的重算失败：${errText(error)}`))
  }, 'goal 状态监听')

  // 后台作业：走作业注册表自己的事件流（不是 cordis 事件），订阅失败只降级
  try {
    const jobs = optionalService(ctx, JOBS_SERVICE)
    if (jobs !== null && typeof jobs === 'object' && jobs.events !== undefined
      && typeof jobs.events?.subscribe === 'function') {
      const dispose = jobs.events.subscribe({ owners: 'all' }, (event) => {
        const owner = event?.job?.owner ?? event?.owner
        if (typeof owner !== 'string' || owner.length === 0) return
        const live = enumerateActiveSessions(ctx)
        const item = live.available ? live.items.find((entry) => entry.sessionId === owner) : undefined
        if (item === undefined) return
        void refresh(owner, item.agent, item.kind, item.parentSessionId, item.session, live)
          .catch((error) => log(`作业事件触发的重算失败：${errText(error)}`))
      })
      disposers.push(dispose)
      log('作业事件订阅已注册（jobs.events.subscribe({owners:"all"})）')
    } else {
      log('作业事件订阅不可用（jobs 服务缺席或没有 events.subscribe）—— 作业变化靠周期兜底')
    }
  } catch (error) {
    log(`作业事件订阅失败（${errText(error)}）—— 作业变化靠周期兜底`)
  }

  // ── 周期兜底 ─────────────────────────────────────────────────────────────────
  if (resolved.sweepMs > 0) {
    sweepTimer = setInterval(() => {
      void refreshAll().catch((error) => log(`周期重算失败：${errText(error)}`))
    }, resolved.sweepMs)
    sweepTimer.unref?.()
  }

  return {
    load,
    refresh,
    refreshAll,
    refreshForAgent,
    flush,
    /** 恢复流程跑完（此后"从磁盘加载的条目"也按正常语义增删）。 */
    markResumeDone: () => { resumeDone = true },
    /** 只读快照（恢复流程与摘要用）。 */
    snapshot: () => [...entries.values()],
    /** 服务方法 `pendingSummary()` 用的摘要。 */
    summary: () => ({
      exists: entries.size > 0,
      ...entries.size > 0 ? {} : { reason: `工作表里没有待唤醒的会话（${resolved.activeFile}）` },
      items: [...entries.values()].map((item) => ({
        sessionId: item.sessionId,
        kind: item.kind,
        done: false,
        active: true,
        wake: true,
      })),
    }),
    /** 唤醒成功后移除条目（并立即落盘 —— 这是"唤醒后清理"的落点）。 */
    remove: (sessionId) => {
      if (entries.delete(sessionId)) {
        flush()
        return true
      }
      return false
    },
    /** 上次写盘时间（排障用）。 */
    lastUpdatedAt: () => lastUpdatedAt,
    dispose: () => {
      disposed = true
      if (debounceTimer !== undefined) clearTimeout(debounceTimer)
      if (sweepTimer !== undefined) clearInterval(sweepTimer)
      debounceTimer = undefined
      sweepTimer = undefined
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* 已回收 */ }
      }
      disposers.length = 0
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// 注入正文：固定首句 + 继续指引 + 断点信息
// ────────────────────────────────────────────────────────────────────────────────

/**
 * 造一条 user 消息（注入用）。
 *
 * 为什么不 import `@deepseek-ai/dsh-llm` 的 `createUserMessage`：见文件头「为什么一个宿主包
 * 都不 import」—— `link:` 装机下裸 import 宿主包会 ERR_MODULE_NOT_FOUND。
 * 这里造的形状与宿主工厂**逐字段一致**：宿主侧就是
 * `deepFreeze(structuredClone({...input, role:'user', id: brandString(randomUUID())}))`，
 * 而 `brandString` 运行时是恒等函数。
 * `test/message-shape.test.mjs` 用**真实的** createUserMessage 当判据钉住这个形状。
 */
export function buildUserMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: String(text) })]),
    source: Object.freeze({ kind: 'user' }),
  })
}

/** 把活动项渲染成一行（作业：`bash-3：pwsh -Command …`；子代理：`session-xxx：补测试`）。 */
function renderActivityItem(entry) {
  const id = typeof entry?.id === 'string' ? entry.id : ''
  const label = typeof entry?.label === 'string' ? oneLine(entry.label, 120) : ''
  if (id.length === 0 && label.length === 0) return ''
  if (id.length === 0) return label
  if (label.length === 0) return id
  return `${id}：${label}`
}

/** 活动类别 → 给人看的中文名。 */
const ACTIVITY_LABEL = Object.freeze({
  turn: '它自己正跑着一轮',
  subagent: '子代理',
  job: '后台作业',
  schedule: '定时任务',
  goal: '自动续轮的目标（goal）',
})

/**
 * 组装**顶层会话**的注入正文：固定首句 + 继续指引 + 断点信息（超长截断）。
 *
 * 与 v0.6.0 的 `buildResumeText` 的根本差别：那时注入的是**整份摘要**（2~4 KB），
 * 现在注入的只有固定首句 `sl已接续会话,继续`、一句继续指引，以及那几个会话历史里
 * **看不到**的东西（在跑的子代理/作业）。
 * 历史本身由宿主冷恢复读回来，不需要复述 —— 这是"复跑"而不是"读摘要重来"。
 *
 * v0.7.2 起：清单里**有子代理**时，末尾补一句 {@link SUBAGENT_RESULT_PROMISE} 预告
 * —— 子代理此刻还没被尝试唤回（父会话得先活着），结果稍后单独通知。
 *
 * `options.hasSubagentEntries`（布尔，可选）：**工作表里这个父会话名下有没有子代理条目** ——
 * 有就以它为准决定要不要发预告（预告与通知同源，见下）。不传时退回"看 activity 清单"。
 */
export function buildResumeText(entry, options = {}) {
  const maxChars = Number.isSafeInteger(options.maxChars) ? options.maxChars : DEFAULT_RESUME_TEXT_MAX_CHARS
  const lines = [
    `${INJECT_HEADING}sl已接续会话,继续`,
    '',
    '你的完整对话历史已经回来了 —— 先确认现状（文件、产物、作业输出），再决定从哪一步继续；'
    + '不要照抄重启前的结论，重启后可能已有新进展。',
  ]
  const activity = Array.isArray(entry?.activity) ? entry.activity : []
  const details = []
  let hasSubagent = false
  for (const group of activity) {
    const kind = typeof group?.kind === 'string' ? group.kind : ''
    if (kind === 'turn') continue
    if (kind === KIND_SUBAGENT) hasSubagent = true
    const label = ACTIVITY_LABEL[kind] ?? kind
    const items = Array.isArray(group?.items) ? group.items.map(renderActivityItem).filter((line) => line.length > 0) : []
    if (items.length === 0) {
      details.push(`- ${label}：还有在跑的（宿主没给细节）`)
      continue
    }
    for (const item of items) details.push(`- ${label} ${item}`)
  }
  if (entry?.goal === true) details.push('- 自动续轮的目标（goal）还挂着：它本该继续自动往下跑')
  if (details.length > 0) {
    lines.push('', '重启时你名下还有这些在飞的活（会话历史里看不到，所以在这里告诉你）：', ...details)
  }
  // 预告必须与"结果通知"**同源**（评审 2026-10-03 的 P3）：通知由工作表中的子代理条目触发
  // （runResume 阶段 3），而上面的清单只来自宿主 waterfall 的 activity —— 提供方缺席时会出现
  // "没预告却发了通知"，父条目滞后一个 sweep 时会出现"有预告却没人发"。所以调用方给了
  // `hasSubagentEntries` 就以它为准；独立调用（测试、别的调用方）时退回清单推断。
  // ⚠ 它**不放在** details 分支里：清单可能压根没列子代理（activity 缺那一类），而通知照发。
  const promise = options.hasSubagentEntries === undefined
    ? hasSubagent
    : options.hasSubagentEntries === true
  if (promise) lines.push(SUBAGENT_RESULT_PROMISE)
  const text = lines.join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 60))}\n…（正文超长已截断，请用 read 工具确认现场后继续）`
}

/**
 * 组装**子代理**的注入正文。
 *
 * 与顶层那条分开写，因为子代理有两件它不知道的事：① 进程换了一个（它不是被父代理新派活的）；
 * ② 它应该**先汇报状态**再继续（父代理在等它的结论）。
 * 首句与顶层**逐字相同**（固定文案 `sl已接续会话,继续`），紧跟着补一句极简说明，
 * 免得它把这次接续误当成"父代理新派的活"。
 */
export function buildSubagentResumeText(entry, options = {}) {
  const maxChars = Number.isSafeInteger(options.maxChars) ? options.maxChars : DEFAULT_RESUME_TEXT_MAX_CHARS
  const parentSessionId = typeof entry?.parentSessionId === 'string' ? entry.parentSessionId : ''
  const lines = [
    `${INJECT_HEADING}sl已接续会话,继续`,
    '（你是子代理，这是重启后的接续，不是父代理新派活）',
    '',
    parentSessionId.length > 0 ? `你挂在父会话 \`${parentSessionId}\` 名下。` : undefined,
    '你的完整对话历史已经回来了。请**先汇报当前状态**（做到哪一步、哪些结论已经有了、有没有留下半成品文件），'
    + '再继续未完成的部分；不要照抄重启前的结论，重启后可能已有新进展。',
  ].filter((line) => line !== undefined)
  const text = lines.join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 60))}\n…（正文超长已截断）`
}

/**
 * 把一次子代理唤醒的结果折成**结果条目**（纯函数；渲染与用例共用同一套状态词）。
 *
 * 四个状态（{@link buildSubagentOutcomeNotice} 按它分支渲染）：
 *   · `resumed`     —— `ok:true`：已投递给宿主并冷恢复；
 *   · `unresumable` —— 明确不可恢复（空会话等）：条目已从表里移除，**不会再试**；
 *   · `skipped`     —— 本次让位（目标不在会话列表里 / `requireColdAgent`）：条目留着，下次启动再试；
 *   · `failed`      —— 其余失败（父会话不 live / 服务缺席 / 投递抛错）：条目留着，下次启动再试。
 */
export function subagentOutcomeOf(item, outcome = {}) {
  const sessionId = typeof item?.sessionId === 'string' ? item.sessionId : ''
  let status = 'failed'
  if (outcome?.ok === true) status = 'resumed'
  else if (outcome?.unresumable === true) status = 'unresumable'
  else if (outcome?.yield === true) status = 'skipped'
  return { sessionId, status, reason: oneLine(outcome?.message, 240) }
}

/** 结果状态 → 标记与中文（渲染与用例共用，改这里等于改所有断言）。 */
const OUTCOME_MARK = Object.freeze({ resumed: '✅', failed: '❌', unresumable: '❌', skipped: '⏸' })
const OUTCOME_WORD = Object.freeze({ resumed: '已唤回', failed: '没能唤回', unresumable: '没能唤回', skipped: '本次没尝试' })

/** 结果条目 → 给人看的一行（`- ✅ ` + 反引号包住的会话 id + `：已唤回 —— …`）。 */
function renderSubagentOutcome(result) {
  const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : ''
  const status = typeof result?.status === 'string' ? result.status : 'failed'
  const reason = oneLine(result?.reason, 240)
  const why = reason.length > 0 ? reason : '（宿主没给原因）'
  const head = `- ${OUTCOME_MARK[status] ?? '❔'} \`${sessionId}\`：${OUTCOME_WORD[status] ?? status}`
  // 「已唤回」只承诺"触发已投递"（delivery=queue），**不**承诺它一定会开口汇报 ——
  // 所以补一句兜底（评审 2026-10-03：把预测写成事实会让父会话干等）。
  if (status === 'resumed') {
    return `${head} —— 它接下来会自己向你汇报当前状态（若迟迟没动静，用 \`send_message\` 问一下）`
  }
  // 不再重试 ≠ 你不能手动续：两句话要一起说清，否则和尾部"下一步建议"里的 send_message 打架。
  if (status === 'unresumable') {
    return `${head} —— 原因：${why}（它没有可续的状态，本插件不会再自动重试；要它继续只能你手动派活）`
  }
  if (status === 'skipped') return `${head} —— ${why}（条目留在工作表里，本插件下次启动会再试一次）`
  return `${head} —— 原因：${why}（条目留在工作表里，本插件下次启动会再试一次）`
}

/**
 * 「子代理接续结果」的通知正文（v0.7.2 起：**成功也报**，取代 v0.5.0 那条只报失败的）。
 *
 * 读者是**父会话**，它要的是"判断与决策"：哪个回来了、哪个没有、还要不要等 ——
 * 所以逐条列出（上限 {@link SUBAGENT_OUTCOME_MAX_LINES} 条，超出的折叠成一行），
 * 并且**按父会话汇总成一条**，不是每个子代理刷一条消息。
 *
 * `logFile`（可选）给的是插件流程日志的绝对路径 —— 折叠掉的那几条的原因只在日志里，
 * 不给路径的话父会话读不到（评审 2026-10-03）。
 */
export function buildSubagentOutcomeNotice(input = {}) {
  const parentSessionId = typeof input?.parentSessionId === 'string' ? input.parentSessionId : ''
  const logFile = typeof input?.logFile === 'string' ? input.logFile : ''
  const results = Array.isArray(input?.results)
    ? input.results.filter((result) => result !== null && typeof result === 'object')
    : []
  const lines = [`${SUBAGENT_OUTCOME_HEADING}（dsh 重启后自动唤回）`]
  if (results.length > 0) {
    if (parentSessionId.length > 0) {
      lines.push('', results.length === 1
        ? `它挂在你（父会话 \`${parentSessionId}\`）名下。`
        : `它们都挂在你（父会话 \`${parentSessionId}\`）名下。`)
    }
    lines.push('')
    const shown = results.slice(0, SUBAGENT_OUTCOME_MAX_LINES)
    for (const result of shown) lines.push(renderSubagentOutcome(result))
    if (results.length > shown.length) {
      const where = logFile.length > 0 ? `原因见日志 \`${logFile}\`` : '原因见插件日志'
      lines.push(`- …还有 ${results.length - shown.length} 个子代理没列出（${where}）`)
    }
  }
  const broken = results.filter((result) => result.status === 'failed' || result.status === 'unresumable')
  if (broken.length > 0) {
    lines.push(
      '',
      '没能唤回的那些：它们很可能已被重启打断，当时的结论可能**没有上报给你** —— 别把它们当成已经完成，也别当成还在跑。',
      '',
      '下一步建议（挑一条）：',
      '- 用 `send_message` 手动把它续起来（它的 id 就是上面那个），让它汇报到哪一步、再继续；',
      '- 或者先确认现状（半成品文件、有没有改坏东西）后自己接手。',
    )
  }
  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────────────────────────
// 恢复：读表 → 闸门 → 先顶层后子代理 → 唤醒 → 成功即移除
// ────────────────────────────────────────────────────────────────────────────────

/**
 * 把条目排成**本次启动的唤醒队列**：先顶层会话、后子代理（硬约束）。
 *
 * 为什么是硬约束：冷恢复一个子代理要求它的**父 agent 此刻是 live 的** ——
 * `subagents.prompt` 先 `agents.get(parentSessionId)`，抛 `subagent/parent-unavailable`；
 * 再走到 `authorizeLineage(parent, childId, parentSession)`，判据是
 * `ctx.agents.get(parent.id) === parent`（**exact live parent**）且
 * `parentSession === parent.id`（`dsh-subagent/lib/index.js:3010-3037`、`:945-959`）。
 * 顶层会话没恢复之前，它的子代理条目注定失败 ⇒ 顺序不能并行、不能倒过来。
 */
export function buildResumePlan(items, max) {
  const list = Array.isArray(items) ? items : []
  const roots = list.filter((item) => item?.kind !== KIND_SUBAGENT)
  const subagents = list.filter((item) => item?.kind === KIND_SUBAGENT)
  const ordered = [...roots, ...subagents]
  const limit = Number.isSafeInteger(max) && max > 0 ? max : 0
  return {
    roots,
    subagents,
    queue: limit > 0 ? ordered.slice(0, limit) : ordered,
    deferred: limit > 0 ? ordered.slice(limit) : [],
  }
}

/** 当前活着的顶层会话，每条 `{id, running}`（闸门① 的输入）。 */
function rootSessions(ctx) {
  const agents = optionalService(ctx, AGENTS_SERVICE)
  if (agents === null || typeof agents !== 'object' || typeof agents.roots !== 'function') return []
  try {
    const roots = agents.roots()
    if (!Array.isArray(roots)) return []
    return roots.map((agent) => ({
      id: agentSessionId(agent) ?? '',
      running: agent?.status === 'running',
    }))
  } catch {
    return []
  }
}

/**
 * **整批共用的那道闸门**：与目标会话无关的两条判据，一批条目只判一次。
 *
 *   闸门② `uptimeMs > bootGraceMs` ⇒ 这是插件热加载，不是宿主启动 ⇒ 让位（表保留）；
 *   闸门① `roots()` 里有**别的**顶层会话**正在跑一轮** ⇒ 让位（表保留）。
 *
 * 闸门① 的两处限定都必要（v0.2.0/v0.2.1 踩出来的）：
 *   · 「别的」—— 本批要唤醒的会话自己被标签页订阅成 live agent 是正常现象，算进来会让
 *     "重启后自动续上"永远不触发；
 *   · 「正在跑一轮」—— `roots()` 返回的是**活着**的顶层 agent，不是**正在跑**的。
 * 目标会话**自己**在跑一轮**不构成让位理由**：`followup` 的语义是「排进下一轮、不打断当前轮」
 * （`dsh-agent-loop/lib/index.js:806-808` 的 `send(msg,'next-turn',true)`，加上 `:103-111` 的
 * `claim()` 每轮只取 1 条 next-turn）。⚠ 评审 2026-10-03 订正：原注释引的 `:855-858` 是
 * `wakeDriver` 的挂起分支、`:1020` 落在 `turn()` 的错误处理里，都不支持这个结论。
 */
export function evaluateGate(input) {
  const uptimeMs = Number.isFinite(input?.uptimeMs) ? input.uptimeMs : 0
  const bootGraceMs = Number.isFinite(input?.bootGraceMs) ? input.bootGraceMs : DEFAULT_BOOT_GRACE_MS
  const roots = Array.isArray(input?.rootSessions) ? input.rootSessions : []
  const excluded = input?.excludedIds instanceof Set ? input.excludedIds : new Set()

  if (uptimeMs > bootGraceMs) {
    return {
      kind: 'yield',
      reason: `宿主进程已运行 ${Math.round(uptimeMs / 1000)}s（阈值 ${Math.round(bootGraceMs / 1000)}s），判定为插件热加载而非宿主启动`,
    }
  }
  const othersRunning = roots.filter((entry) => entry !== null && typeof entry === 'object'
    && typeof entry.id === 'string' && entry.id.length > 0
    && !excluded.has(entry.id)
    && entry.running === true)
  if (othersRunning.length > 0) {
    const shown = othersRunning.slice(0, 3).map((entry) => entry.id)
    const more = othersRunning.length > shown.length ? ` 等 ${othersRunning.length} 个` : ''
    return {
      kind: 'yield',
      reason: `还有 ${othersRunning.length} 个其它顶层会话正在跑一轮（${shown.join('、')}${more}），让位不唤醒`,
    }
  }
  return undefined
}

/**
 * **逐条**的恢复判定（顶层条目）：会话还在不在 / 是不是空会话 / `requireColdAgent`。
 *
 * 与 v0.6.0 的 `decideResume` 同口径（那三条判据与记录格式无关，原样保留）：
 *   · 不在列表里 ⇒ **让位**（宿主刚启动时列表可能还没装载完，判死会把唯一那份待办消费掉）；
 *   · 空会话 ⇒ **不可恢复**（注入一条消息会把空会话变成非空会话，等于凭空造一个会话）；
 *   · `requireColdAgent` ⇒ 唯一剩下的目标侧让位理由（默认关闭）。
 * 目标会话**自己在跑**不拦（理由见 {@link evaluateGate}）。
 */
export function decideResume(input) {
  const item = input?.item ?? {}
  const items = input?.items
  const sessionId = typeof item.sessionId === 'string' ? item.sessionId : ''
  if (items === undefined) {
    return { kind: 'resume', reason: '会话列表不可用，跳过列表判定，直接尝试唤醒' }
  }
  if (!Array.isArray(items)) {
    return { kind: 'unresumable', reason: `会话列表形态不符（${typeof items}）` }
  }
  const target = items.find((entry) => entry !== null && typeof entry === 'object' && entry.sessionId === sessionId)
  if (target === undefined) {
    return { kind: 'yield', reason: '目标会话不在会话列表里（可能宿主刚启动、列表未装载完，也可能是已删除）—— 保留条目，下次启动再判' }
  }
  if (target.blank === true) {
    return { kind: 'unresumable', reason: '目标会话是空会话（没有任何消息），唤醒没有意义' }
  }
  if (input?.requireColdAgent === true && target.agentAvailable === true) {
    return { kind: 'yield', reason: '目标会话已有活 agent（requireColdAgent=true），让位' }
  }
  return {
    kind: 'resume',
    reason: target.running === true
      ? '目标会话正在跑一轮，但 followup 只把触发排进下一轮（不打断当前轮），照常唤醒'
      : '目标会话空闲，可唤醒',
  }
}

/**
 * **子代理条目**的目标侧判定（v0.7.3 新增，与顶层 {@link decideResume} 同口径的两条）。
 *
 * 为什么必须补（评审 2026-10-03 指出）：`yield` / `unresumable` 在 v0.7.2 里**只有顶层**会返回，
 * 于是子代理侧这两个态在生产里永远不可达 ——
 *   · 空会话子代理会被**真投一条消息**进去，把空会话变成非空会话（顶层明确要避免的
 *     "凭空造一个会话"）；
 *   · 永久失败（已删除 / 不可恢复）的子代理条目会每次启动重试一遍、每次给父会话刷一条 ❌，
 *     直到表 24h 陈旧被整体丢弃 —— 通知里那句"下次启动会再试一次"于是成了空头支票。
 *
 * `requireColdAgent` **有意不适用于子代理**：子代理条目能进表本身就意味着它当时在跑
 * （"live 且 running"是常态），拿"已有活 agent 就让位"去判它只会永远让位。
 */
export function decideSubagentResume(input = {}) {
  const item = input?.item ?? {}
  const items = input?.items
  const sessionId = typeof item.sessionId === 'string' ? item.sessionId : ''
  if (items === undefined) {
    return { kind: 'resume', reason: '会话列表不可用，跳过列表判定，直接尝试唤醒' }
  }
  if (!Array.isArray(items)) {
    return { kind: 'unresumable', reason: `会话列表形态不符（${typeof items}）` }
  }
  const target = items.find((entry) => entry !== null && typeof entry === 'object' && entry.sessionId === sessionId)
  if (target === undefined) {
    return { kind: 'yield', reason: '目标会话不在会话列表里（可能宿主刚启动、列表未装载完，也可能是已删除）—— 保留条目，下次启动再判' }
  }
  if (target.blank === true) {
    return { kind: 'unresumable', reason: '目标会话是空会话（没有任何消息），唤醒没有意义' }
  }
  return {
    kind: 'resume',
    reason: target.running === true
      ? '目标会话正在跑一轮，触发消息排进它的下一轮（delivery=queue，不打断当前轮）'
      : '目标会话空闲，可唤醒',
  }
}

/** 等一个服务出现（每 500ms 轮询；等不到返回 undefined，调用方保留工作表）。 */
async function waitForService(ctx, serviceName, timeoutMs, isDisposed) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const service = optionalService(ctx, serviceName)
    if (service !== undefined && service !== null) return service
    if (isDisposed?.() === true) return undefined
    if (Date.now() >= deadline) return undefined
    await delay(500)
  }
}

/** 读会话列表（fail-soft：读不到返回 undefined，调用方跳过列表判定）。 */
async function listSessions(controller, log) {
  if (controller === null || typeof controller !== 'object' || typeof controller.list !== 'function') {
    log('sessionController 没有 list()，跳过列表判定')
    return undefined
  }
  try {
    const result = await controller.list({})
    if (result === null || typeof result !== 'object' || !Array.isArray(result.items)) {
      log(`会话列表形态不符（${typeof result?.items}），跳过列表判定`)
      return undefined
    }
    return result.items
  } catch (error) {
    log(`读会话列表失败（跳过列表判定）：${errText(error)}`)
    return undefined
  }
}

/**
 * 解析出可用 agent —— `sessionController.resolveAgent(id)` 的**唤醒语义**包装。
 *
 * 它**不抛异常**，返回 `{agent}` 或 `{error}`，两条分支都要处理；`resolveAgent` 内部会把
 * `ApiSessionNotFound` 等转成 `{error}`。会话不在本进程里活着时，这一步就是**冷恢复**
 * （重建 Agent + 读回完整历史 + 补 interrupted closer）。
 */
async function resolveAgentFor(controller, sessionId) {
  if (controller === null || typeof controller !== 'object' || typeof controller.resolveAgent !== 'function') {
    return { ok: false, message: 'sessionController 服务不可用（没有 resolveAgent()）' }
  }
  let found
  try {
    found = await controller.resolveAgent(sessionId)
  } catch (error) {
    return { ok: false, message: `resolveAgent 抛错：${errText(error)}` }
  }
  if (found === undefined || found === null || found.agent === undefined || found.error !== undefined) {
    return { ok: false, message: `resolveAgent 返回不可恢复：${errText(found?.error)}` }
  }
  return { ok: true, agent: found.agent }
}

/** 落盘检查点（fail-soft：拿不到 sessions 服务或它抛错都只写一行日志）。 */
async function flushSession(ctx, session, log) {
  try {
    const sessions = ctx.sessions
    if (sessions === null || typeof sessions !== 'object' || typeof sessions.flush !== 'function') {
      log('sessions 服务不可用，跳过 flush（注入已在内存里，重启可能丢这一条）')
      return false
    }
    await sessions.flush(session)
    return true
  } catch (error) {
    log(`flush 失败（注入已在内存里，重启可能丢这一条）：${errText(error)}`)
    return false
  }
}

/**
 * 按**会话 id** 落盘检查点，但只在它**此刻是 live 会话**时才做。
 *
 * 为什么不能直接 flush：`sessions.flush(session)` 只对 live session 生效
 * （`liveEntryFor`，"detached/prepared objects reject"），而子代理是**冷恢复**的 ——
 * 投递那一刻它的会话通常还不在 live store 里。无条件 flush 会稳定报一个"预期内的失败"。
 * 所以先 `get(id)` 探一下：live ⇒ 正常 flush；不 live ⇒ 返回 true（"无需 flush"不是失败）。
 *
 * 返回值语义 = **"落盘这件事不需要做，或者做成了"**；`false` 一律是"没做成"（保守方向）：
 * 服务读不到 / `get()` 抛错时**也返回 false**（评审 2026-10-03 指出：这两条原先返回 true，
 * 会把"其实没落盘"漏出 `flushedFailures` 统计）。
 */
async function flushLiveSession(ctx, sessionId, log) {
  let sessions
  try {
    sessions = ctx.sessions
  } catch (error) {
    log(`sessions 服务读不到（${errText(error)}）⇒ 这条注入可能没落盘`)
    return false
  }
  if (sessions === null || typeof sessions !== 'object' || typeof sessions.flush !== 'function') {
    log('sessions 服务不可用，跳过 flush（注入已在内存里，重启可能丢这一条）')
    return false
  }
  let live
  try {
    live = typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  } catch (error) {
    log(`查会话 ${sessionId} 是否 live 抛错（${errText(error)}）⇒ 这条注入可能没落盘`)
    return false
  }
  if (live === undefined) {
    log(`会话 ${sessionId} 此刻不在 live store 里（冷恢复尚未落库），跳过 flush`)
    return true
  }
  return await flushSession(ctx, live, log)
}

/** 唤醒一条**顶层会话**：列表判定 → resolveAgent（冷恢复）→ followup → flush。 */
async function wakeRoot(ctx, resolved, log, controller, listItems, item, options = {}) {
  const decision = decideResume({ item, items: listItems, requireColdAgent: resolved.requireColdAgent })
  if (decision.kind === 'yield') return { ok: false, yield: true, message: `让位（保留条目，下次启动再判）：${decision.reason}` }
  if (decision.kind === 'unresumable') return { ok: false, unresumable: true, message: `不可恢复：${decision.reason}` }

  const resolvedAgent = await resolveAgentFor(controller, item.sessionId)
  if (!resolvedAgent.ok) return { ok: false, message: resolvedAgent.message }
  const agent = resolvedAgent.agent
  if (agent.status === 'running') {
    log(`目标会话 ${item.sessionId} 正在跑一轮，触发消息将排进它的下一轮（followup 不打断当前轮）`)
  }
  const text = buildResumeText(item, {
    maxChars: resolved.resumeTextMaxChars,
    hasSubagentEntries: options.hasSubagentEntries,
  })
  try {
    agent.followup(buildUserMessage(text))
  } catch (error) {
    return { ok: false, message: `followup 注入失败：${errText(error)}` }
  }
  // 注入后必须 flush（否则进程再挂一次时这条消息可能没落盘）—— 而且**先 flush 再移除条目**
  const flushed = await flushSession(ctx, agent.session, log)
  return {
    ok: true,
    agent,
    flushed,
    message: flushed
      ? '冷恢复 + followup 已入队并 flush 落盘（新一轮由本进程驱动）'
      : '冷恢复 + followup 已入队但 flush 未成功（这条注入可能没落盘）',
  }
}

/**
 * 唤醒一条**子代理**：父 agent 活着 → `subagents.prompt(...)` → 宿主**冷恢复**它。
 *
 * 走 `subagents.prompt` 而不是别的（本机 dsh 源码核实）：它是"宿主冷恢复一个子代理"的公开入口
 * —— `deliverToChild` → `deliverFollowup` 发现 `activations.get(childId) === undefined` ⇒
 * `coldResume(parent, childId, content, options)`（重建 Agent + 投递首条消息）。
 * `send_message` 走的是同一个投递内核，但它要求一个 exact live **sender**；冷恢复场景没有
 * sender，所以只能用 `prompt`（`mode:'continuable'` 是 payload 校验的硬要求）。
 *
 * `delivery:'queue'` 是有意的：触发消息该作为**独立的一轮**被处理，不插进子代理当前正在跑的
 * 那一步（与顶层 `followup` 的 `next-turn` 语义一致）。
 *
 * v0.7.3 起先跑 {@link decideSubagentResume}（与顶层同口径的"不在列表 ⇒ 让位 / 空会话 ⇒
 * 不可恢复"两条）。评审 2026-10-03 指出：缺了它，子代理侧的 `yield` / `unresumable` 永远
 * 不可达 —— 空会话会被**真投一条消息**进去（顶层明确要避免的"凭空造一个会话"），
 * 永久失败的条目会每次启动重试一遍、每次给父会话刷一条 ❌，直到表 24h 陈旧被整体丢弃。
 */
async function wakeSubagent(ctx, resolved, log, item, listItems) {
  const parentSessionId = typeof item.parentSessionId === 'string' ? item.parentSessionId : ''
  if (parentSessionId.length === 0) {
    return { ok: false, message: '条目没有 parentSessionId（直接父会话 id），无法投递' }
  }
  const decision = decideSubagentResume({ item, items: listItems })
  if (decision.kind === 'yield') return { ok: false, yield: true, message: `让位（保留条目，下次启动再判）：${decision.reason}` }
  if (decision.kind === 'unresumable') return { ok: false, unresumable: true, message: `不可恢复：${decision.reason}` }
  const agents = optionalService(ctx, AGENTS_SERVICE)
  if (agents === null || typeof agents !== 'object' || typeof agents.get !== 'function') {
    return { ok: false, message: 'agents 服务没有 get()，判不了父会话是否活着' }
  }
  let parent
  try {
    parent = agents.get(parentSessionId)
  } catch (error) {
    return { ok: false, message: `查父会话 ${parentSessionId} 抛错：${errText(error)}` }
  }
  if (parent === undefined || parent === null) {
    return { ok: false, message: `父会话 ${parentSessionId} 此刻不是 live agent（冷恢复子代理要求 exact live parent）` }
  }
  const subagents = optionalService(ctx, SUBAGENTS_SERVICE)
  if (subagents === null || typeof subagents !== 'object' || typeof subagents.prompt !== 'function') {
    return { ok: false, message: 'subagents 服务不可用（没有 prompt()），投递不了子代理' }
  }
  const text = buildSubagentResumeText(item, { maxChars: resolved.resumeTextMaxChars })
  const controller = new AbortController()
  try {
    await subagents.prompt({
      requestId: randomUUID(),
      parentSessionId,
      childSessionId: item.sessionId,
      mode: 'continuable',
      delivery: 'queue',
      content: [{ type: 'text', text }],
    }, controller.signal)
  } catch (error) {
    return { ok: false, message: `投递给子代理失败：${errText(error)}` }
  }
  const flushed = await flushLiveSession(ctx, item.sessionId, log)
  return {
    ok: true,
    flushed,
    // ⚠ 这两句原先写反了（评审 2026-10-03 实测到同一轮两行日志自相矛盾）：flushLiveSession 的
    //   true 是"无需落盘或已落盘"，false 才是"没落盘"。现在按返回值本身说话，不再猜会话状态。
    message: flushed
      ? '已投递给宿主并冷恢复（delivery=queue；落盘已确认或无需落盘）'
      : '已投递给宿主并冷恢复（delivery=queue；但 flush 没成功，这条注入可能没落盘）',
  }
}

/**
 * 选投递方式：**正在跑一轮**的父会话用 `steer` 插队，其余退回 `followup` 排队。
 *
 * 宿主语义（`dsh-agent-loop/lib/index.js` 0.2.0-rc.2 逐行核实）：
 *   · `followup(msg)` = `send(msg, 'next-turn', true)`（:806-808）—— 排进**下一轮**；
 *     而 `claim()` 每一步只从 next-turn 取走 **1 条**（:103-111），所以第二条 followup
 *     必然等到下一轮 —— 这就是 v0.7.2 里"结果通知太慢"的根因；
 *   · `steer(msg)` = `send(msg, 'next-step', true)`（:809-811）—— 插进**当前轮**的下一步；
 *     `claim()` 每一步取走**全部** next-step（:104），且 turn 循环在 next-step 非空时不结束该轮
 *     （:998-1006）⇒ 正常情况下这条消息**同一轮内**就被模型看到。
 *
 * ⚠ **"同轮可见"有三个例外**（评审 2026-10-03 指出，别把它说成"一定"）：
 *   ① **next-turn 里还压着没被取走的消息** ⇒ 不许插队：`claim()` 先交 next-step、后交那 1 条
 *      next-turn（:104-105），插队会让结果通知跑到续跑指令**前面**。判据是公开 getter
 *      `inbox.nextTurn`（:80-82）为空 —— 这就是本函数比"看 status"多出来的那一步；
 *   ② 该轮被 **Stop / abort** ⇒ `send()` 把 steer 静默降级成 next-turn（:800-802）：仍然会投，
 *      但退回"下一轮第一条"；
 *   ③ 该轮以**非 abort 错误**结束（模型报错）⇒ 已入队的 next-step 没人取（:856 不置
 *      `wakeRequested`、:898 不补投），要等下一次外部唤醒。这一条对 followup 同样成立。
 *
 * 空闲时**也不能**用 steer：那时没有"当前轮"可插，它只能自己开一轮，而 `claim()` 在第一步是
 * **先取 next-step、后取 1 条 next-turn**（:104-105）⇒ 会和还没被取走的续跑注入抢同一步，
 * 顺序颠倒（结果通知跑到续跑指令前面）。`followup` 的顺序是确定的。
 */
export function pickOutcomeDelivery(agent) {
  if (agent?.status !== 'running' || typeof agent.steer !== 'function') return 'followup'
  // 队列里还压着没被取走的 next-turn（续跑注入 / 用户消息 / goal 续轮）⇒ 退回排队保顺序。
  // 读不到 inbox（宿主形态变动、projection 未注册）时也退回 —— 顺序正确优先于"插队"这个优化。
  let pendingTurn
  try {
    pendingTurn = agent.inbox?.nextTurn
  } catch {
    return 'followup'
  }
  if (!Array.isArray(pendingTurn)) return 'followup'
  return pendingTurn.length === 0 ? 'steer' : 'followup'
}

/**
 * 把「子代理接续结果」汇总通知投给**父会话**（v0.7.2：成功也报，按父会话只发一条）。
 *
 * 通道是 `sessionController.resolveAgent(父 id)` —— **唤醒语义**：父会话即使已经"死了"
 * （不在 live 表里、只躺在持久化里）也会被冷唤醒后收到通知（用户 2026-09-28 拍板：
 * 宁可多起一轮，也不漏通知）。代价是诚实的：真起一轮、消耗 token。
 *
 * 投递方式由 {@link pickOutcomeDelivery} 决定（v0.7.3 起）：父会话正在跑一轮就 **steer 插队**
 * —— 同一轮内就能看到（用户 2026-10-03 的要求："第二条注入太慢了，改成插队"）；空闲才排队。
 *
 * 落盘按**对象** flush（与 `wakeRoot` 同口径）：手上已经有 `resolvedParent.agent`。
 * v0.7.2 走的是"按 id 查 live store 再 flush"，而刚冷恢复的父会话往往还没落库 ⇒ 稳定跳过
 * flush（评审 2026-10-03 实测），通知再遇一次崩溃就永久丢。
 *
 * fail-soft：父会话 id 为空 / 结果为空 / controller 缺席 / `resolveAgent` 返回 `{error}` /
 * 抛错 / agent 没有可用的投递方法 / 投递抛错 ⇒ 只写一行日志、返回 false，**绝不抛**。
 */
export async function notifySubagentOutcomesToParent(ctx, log, parentSessionId, results, controller, options = {}) {
  const list = Array.isArray(results) ? results.filter((result) => result !== null && typeof result === 'object') : []
  if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) {
    log(`有 ${list.length} 条子代理接续结果，但没有父会话 id ⇒ 没有可通知的人（只写日志）`)
    return false
  }
  const who = `父会话 ${parentSessionId}`
  if (list.length === 0) {
    log(`${who} 名下没有子代理接续结果，不发通知`)
    return false
  }
  const resumed = list.filter((result) => result.status === 'resumed').length
  const resolvedParent = await resolveAgentFor(controller, parentSessionId)
  if (!resolvedParent.ok) {
    log(`${who} 的 ${list.length} 条子代理接续结果发不出去（${resolvedParent.message}）—— 只写日志`)
    return false
  }
  const parent = resolvedParent.agent
  const delivery = pickOutcomeDelivery(parent)
  if (typeof parent[delivery] !== 'function') {
    log(`${who} 的 ${list.length} 条子代理接续结果发不出去（拿到的 agent 没有 ${delivery}()）`)
    return false
  }
  const text = buildSubagentOutcomeNotice({ parentSessionId, results: list, logFile: options.logFile })
  try {
    parent[delivery](buildUserMessage(text))
  } catch (error) {
    log(`${who} 的 ${list.length} 条子代理接续结果发不出去（${delivery} 抛错：${errText(error)}）`)
    return false
  }
  const flushed = await flushSession(ctx, parent.session, log)
  log(`子代理接续结果已通知 ${who}（${delivery === 'steer' ? 'steer 插队，同轮可见' : 'followup 排队，下一轮可见'}；`
    + `已唤回 ${resumed} / 共 ${list.length} 条；落盘=${flushed ? 'ok' : '未确认'}）`)
  return true
}

/**
 * 启动时的恢复流程：读工作表 → 闸门 → **先顶层、后子代理**逐条唤醒 → 成功即移除条目。
 *
 * ── 语义（与 v0.6.0 的差别都在"表里只有有活的会话"这一条上）──────────────────────
 *   · **唤醒成功 ⇒ 条目从表里移除**（这是"不重复唤醒"的机制；失败留着下次启动重试）；
 *   · **整批让位**（热加载 / 别的会话在跑 / controller 等不到）⇒ **表一个字节都不动**；
 *   · **失败**（父会话没起来、投递抛错）⇒ 条目留着 + 子代理的结果照样回报给父会话；
 *   · **不可恢复**（空会话）⇒ 从表里移除并写日志（它没有可续的状态，留着只会每次重试）；
 *   · **子代理的结果按父会话汇总一条通知**（v0.7.2：成功/失败/未尝试都报）——
 *     只有在这一批子代理**全部试完之后**才发（结果此刻才齐），父会话 id 为空的条目跳过；
 *     插件中途被卸载（提前 return）时这一批不发（进程都要走了，投递没有意义）。
 *
 * ── 阶段（v0.7.3 拆成四段，顺序是硬约束）────────────────────────────────────────
 *   1. **顶层会话**：判定 → `resolveAgent`（冷恢复）→ `followup` 注入续跑指令 → flush；
 *   1.5 **自己没有顶层条目的父会话先冷唤醒**（{@link rootEntryIds}）：否则子代理注定失败，
 *      而那条 ❌ 通知又走唤醒语义（先判死、后唤醒 ⇒ 通知自相矛盾，评审 2026-10-03 实测复现）。
 *      自己有条目的父会话**不在这里**处理 —— 裸唤醒会让让位的那条丢掉续跑注入（评审 P2）；
 *   2. **子代理条目**：`decideSubagentResume` → 父 agent 活着 → `subagents.prompt`；
 *   2.5 被 `resumeMaxSessions` 截断、本次没试的子代理：只在父会话本次已醒着时补一条 ⏸ 说明；
 *   3. **汇总回报**：按父会话一条通知，投递方式由 {@link pickOutcomeDelivery} 决定
 *      （父会话在跑且 next-turn 已清空 ⇒ `steer` 插队，同轮可见；其余 ⇒ `followup` 排队）。
 * 全程 fail-soft：任何一条失败只写日志，不影响其它条目。
 */
export async function runResume(ctx, resolved, log, isDisposed, tracker) {
  const snapshot = tracker.snapshot()
  if (snapshot.length === 0) {
    log('启动时工作表里没有待唤醒的会话，跳过恢复')
    return { kind: 'idle', reason: '空表' }
  }
  const plan = buildResumePlan(snapshot, resolved.resumeMaxSessions)
  log(`发现活跃工作表：共 ${snapshot.length} 条（顶层 ${plan.roots.length} / 子代理 ${plan.subagents.length}），`
    + `本次唤醒 ${plan.queue.length} 条（顺序：先顶层后子代理）`
    + (plan.deferred.length > 0 ? `，${plan.deferred.length} 条超出 resumeMaxSessions=${resolved.resumeMaxSessions} 的上限、留在表里等下次启动` : '')
    + '，等待 sessionController…')

  const controller = await waitForService(ctx, 'sessionController', resolved.controllerWaitMs, isDisposed)
  if (isDisposed?.() === true) return { kind: 'idle', reason: '插件已卸载' }
  if (controller === undefined) {
    // 表一个字节都不动：这次启动可能只是慢，下次启动再判（陈旧上限兜底）
    log(`sessionController 在 ${resolved.controllerWaitMs}ms 内不可用，本次不唤醒（表保留）`)
    return { kind: 'yield', reason: 'sessionController 不可用' }
  }

  const listItems = await listSessions(controller, log)
  // 闸门（整批一次）：热加载 / 别的顶层会话正在跑一轮。
  // 排除名单 = 本批要唤醒的全部会话：它们自己被标签页订阅或在跑一轮都不该让整批让位。
  const excludedIds = new Set(plan.queue.map((item) => item.sessionId))
  const gate = evaluateGate({
    uptimeMs: process.uptime() * 1000,
    bootGraceMs: resolved.bootGraceMs,
    rootSessions: rootSessions(ctx),
    excludedIds,
  })
  if (gate !== undefined) {
    log(`恢复判定：${gate.kind} —— ${gate.reason}（表保留，下次启动再判）`)
    return gate
  }

  const results = []
  /** 子代理接续结果，按**直接父会话**分组攒着（这一批试完再汇总发，见阶段 3）。 */
  const subagentOutcomes = new Map()
  /** 本批已经确保 live 的父会话（顶层唤醒成功 + 阶段 1.5 的前置冷唤醒）。 */
  const parentAgents = new Map()
  let flushedFailures = 0
  let removed = 0

  /** 记一条结果：进 `results`、必要时进子代理结果分组、按语义移除条目 —— 两段循环共用。 */
  const record = (item, outcome) => {
    if (outcome.ok && outcome.flushed === false) flushedFailures += 1
    results.push({
      sessionId: item.sessionId,
      kind: item.kind,
      ok: outcome.ok,
      yield: outcome.yield === true,
      unresumable: outcome.unresumable === true,
      message: outcome.message,
    })
    if (item.kind === KIND_SUBAGENT) {
      // 成功也报（用户 2026-10-03 的要求）：父会话要知道它名下的子代理到底回没回来
      const parentSessionId = typeof item.parentSessionId === 'string' ? item.parentSessionId : ''
      if (parentSessionId.length === 0) {
        log(`子代理 ${item.sessionId} 没有 parentSessionId ⇒ 接续结果没有可通知的父会话（只写日志）`)
      } else {
        const list = subagentOutcomes.get(parentSessionId) ?? []
        list.push(subagentOutcomeOf(item, outcome))
        subagentOutcomes.set(parentSessionId, list)
      }
    }
    const who = item.kind === KIND_SUBAGENT ? '子代理' : '顶层'
    if (outcome.ok) {
      // 唤醒成功 ⇒ 从表里移除（"唤醒后清理"；立即落盘，防止移除后崩溃又把它唤醒一次）
      if (tracker.remove(item.sessionId)) removed += 1
      log(`唤醒成功：${who} ${item.sessionId} —— ${outcome.message}（已从工作表移除）`)
      return
    }
    if (outcome.unresumable === true) {
      // 明确不可恢复：从表里移除（它没有可续的状态，留着只会每次启动重试一遍）
      if (tracker.remove(item.sessionId)) removed += 1
      log(`唤醒判定为不可恢复：${who} ${item.sessionId} —— ${outcome.message}（已从工作表移除）`)
      return
    }
    log(`唤醒失败（留在工作表里，下次启动重试）：${who} ${item.sessionId} —— ${outcome.message}`)
  }

  // ⚠ 两段循环都只遍历 `plan.queue` 的子集（**不是** plan.roots / plan.subagents）：
  //   超上限的条目必须留在 deferred 里，拆循环时别把 resumeMaxSessions 顺手绕过去。
  const queueRoots = plan.queue.filter((item) => item.kind !== KIND_SUBAGENT)
  const queueSubagents = plan.queue.filter((item) => item.kind === KIND_SUBAGENT)

  /**
   * 工作表中**自己有顶层条目**的会话 id（本批要唤醒的 + 超上限留下的）。
   *
   * 阶段 1.5 **绝不**裸冷唤醒这些父会话（评审 2026-10-03 的 P2 —— 唯一会静默丢续跑的一条）：
   * 它们该由阶段 1 的 {@link wakeRoot} 处理，那里有判定、有续跑注入、成功即移除条目。
   * 绕过它去裸唤醒会出两种事故：
   *   · 父条目**让位**（不在会话列表里 / `requireColdAgent`）时：阶段 1 不注入、1.5 却把它唤醒，
   *     它只收到一条结果通知；`markResumeDone` 一开闸，跟踪器发现它没活就把条目删了
   *     ⇒ **那条续跑注入永久丢失**（条目没了，下次启动也不会再试）；
   *   · 父条目**不可恢复**（空会话）时：1.5 照样唤醒 + 阶段 3 投通知 ⇒ 把空会话变成非空会话，
   *     正是本插件明令避免的"凭空造一个会话"。
   */
  const rootEntryIds = new Set(
    [...queueRoots, ...plan.deferred.filter((item) => item.kind !== KIND_SUBAGENT)].map((item) => item.sessionId),
  )
  /**
   * 工作表里"名下有子代理条目"的父会话（含被上限截断的）—— 续跑注入里那句预告的依据。
   *
   * 为什么不用 activity 清单：清单只来自宿主 waterfall（某个提供方缺席就少一类、父条目还可能
   * 滞后一个 sweep），而通知只由**工作表里的子代理条目**触发 ⇒ 两者会打架（评审 2026-10-03 的 P3）。
   */
  const parentsWithSubagentEntry = new Set(
    [...plan.queue, ...plan.deferred]
      .filter((item) => item.kind === KIND_SUBAGENT
        && typeof item.parentSessionId === 'string' && item.parentSessionId.length > 0)
      .map((item) => item.parentSessionId),
  )

  // ── 阶段 1：顶层会话（"先顶层"是硬约束：冷恢复子代理要求父 agent 此刻 live）────────
  for (const item of queueRoots) {
    if (isDisposed?.() === true) {
      log('插件已卸载，停止本次唤醒（剩余条目保留在表里）')
      return { kind: 'idle', reason: '插件已卸载' }
    }
    const outcome = await wakeRoot(ctx, resolved, log, controller, listItems, item, {
      hasSubagentEntries: parentsWithSubagentEntry.has(item.sessionId),
    })
    // 记下这个父会话已经 live —— 它的子代理在阶段 2 才投得出去
    if (outcome.ok && outcome.agent !== undefined) parentAgents.set(item.sessionId, outcome.agent)
    record(item, outcome)
  }

  // ── 阶段 1.5：把"只为子代理而存在"的父会话**先**冷唤醒 ──────────────────────────
  //  为什么必须先做（评审 2026-10-03 实测复现的 P1）：
  //   ① 冷恢复子代理要求父 agent 此刻 live，父没起来时子代理**注定失败**；
  //   ② 那条 ❌ 通知本身走的就是唤醒语义（`resolveAgent`）—— 先判"父不是 live"、后把父唤醒，
  //      通知里那句"原因：父会话 X 此刻不是 live agent"当场自相矛盾，父会按"子代理已死"行动。
  //  代价与通知路径本来就一样（多起一个会话），用户 2026-09-28 已拍板"宁可多起一轮，也不漏通知"。
  //
  //  ⚠ 只处理**自己没有顶层条目**的父会话（{@link rootEntryIds}）：自己有条目的走阶段 1，
  //     裸唤醒会让"让位"的父会话收到一条没头没尾的通知、并把它的续跑注入永久丢掉（评审 P2）。
  const parentFailures = new Map()
  for (const item of queueSubagents) {
    const parentSessionId = typeof item.parentSessionId === 'string' ? item.parentSessionId : ''
    if (parentSessionId.length === 0 || parentAgents.has(parentSessionId) || parentFailures.has(parentSessionId)) continue
    if (rootEntryIds.has(parentSessionId)) {
      log(`子代理 ${item.sessionId} 的父会话 ${parentSessionId} 自己在工作表里有条目`
        + '（本批已判过或超上限）⇒ 不裸唤醒它（裸唤醒会让它只收到通知、丢掉续跑注入）')
      continue
    }
    if (isDisposed?.() === true) break
    const resolvedParent = await resolveAgentFor(controller, parentSessionId)
    if (resolvedParent.ok) {
      parentAgents.set(parentSessionId, resolvedParent.agent)
      log(`子代理 ${item.sessionId} 的父会话 ${parentSessionId} 先冷唤醒（子代理这样才投得出去）`)
    } else {
      parentFailures.set(parentSessionId, resolvedParent.message)
      log(`子代理 ${item.sessionId} 的父会话 ${parentSessionId} 唤不醒（${resolvedParent.message}）—— 该子代理注定失败`)
    }
  }

  // ── 阶段 2：子代理条目 ───────────────────────────────────────────────────────────
  for (const item of queueSubagents) {
    if (isDisposed?.() === true) {
      log('插件已卸载，停止本次唤醒（剩余条目保留在表里）')
      return { kind: 'idle', reason: '插件已卸载' }
    }
    record(item, await wakeSubagent(ctx, resolved, log, item, listItems))
  }

  // ── 阶段 2.5：超上限、本次压根没试的子代理补一条 ⏸ 说明 ──────────────────────────
  //  只在"它的父会话本次已经醒着"时补 —— 不额外唤醒任何会话（否则等于绕过 resumeMaxSessions）。
  //  补这条是因为父的续跑注入里**预告过**"接续结果会另发一条消息告诉你"，而它名下的子代理
  //  恰好全被上限截断时，那条预告就成了空头支票（评审 2026-10-03）。
  for (const item of plan.deferred) {
    if (item.kind !== KIND_SUBAGENT) continue
    const parentSessionId = typeof item.parentSessionId === 'string' ? item.parentSessionId : ''
    if (!parentAgents.has(parentSessionId)) continue
    const list = subagentOutcomes.get(parentSessionId) ?? []
    list.push({
      sessionId: item.sessionId,
      status: 'skipped',
      reason: `超出本次唤醒上限（resumeMaxSessions=${resolved.resumeMaxSessions}），本次没尝试`,
    })
    subagentOutcomes.set(parentSessionId, list)
  }

  // ── 阶段 3：子代理全部试完 ⇒ 按父会话汇总回报（成功/失败/未尝试都列，一条父会话只发一条）──
  for (const [parentSessionId, outcomes] of subagentOutcomes) {
    await notifySubagentOutcomesToParent(ctx, log, parentSessionId, outcomes, controller, { logFile: resolved.logFile })
  }

  const woken = results.filter((result) => result.ok).length
  const failed = results.filter((result) => !result.ok)
  const yielded = failed.filter((result) => result.unresumable !== true && result.yield === true).length
  const unresumableCount = failed.filter((result) => result.unresumable === true).length
  const summary = { woken, failed: failed.length, yielded, unresumable: unresumableCount, deferred: plan.deferred.length, removed }
  log(`本次恢复结束：唤醒成功 ${woken} 条 / 失败 ${failed.length} 条（其中让位 ${yielded} 条、明确不可恢复 ${unresumableCount} 条）`
    + ` / 超上限留下 ${plan.deferred.length} 条（flush 失败 ${flushedFailures} 条）⇒ 工作表剩 ${tracker.snapshot().length} 条`)
  if (flushedFailures > 0) {
    log(`有 ${flushedFailures} 条唤醒成功但 flush 未成功：注入已经入队（不会重复插话），但消息可能没落盘 ——`
      + '若进程再次崩溃，这条触发只在内存里会永久丢；会话历史本身仍在磁盘上，可手动发一条消息续上')
  }
  if (woken === 0 && failed.length > 0 && unresumableCount === 0 && yielded === failed.length) {
    log(`本次 ${failed.length} 条全部让位 ⇒ 工作表原样保留，下次启动再判`)
    return { kind: 'yield', reason: `全部让位：${failed.map((result) => result.message).join('；')}`, ...summary, results }
  }
  return {
    kind: woken > 0 ? 'resume' : (failed.length > 0 ? 'failed' : 'idle'),
    reason: `唤醒 ${woken} 条，失败 ${failed.length} 条，工作表剩 ${tracker.snapshot().length} 条`,
    ...summary,
    results,
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// 对外服务：同名同形兼容 dsh-host-restart
// ────────────────────────────────────────────────────────────────────────────────

/**
 * 交接服务的实现（cordis 服务名 {@link SERVICE_NAME}）。
 *
 * v0.7.0 起语义变了（不再是"保存交接记录"，而是"确保工作表最新"），但**方法名与返回形状
 * 保持不变**，所以本机 `dsh-host-restart` 零改动：
 *
 *   · `saveAll(options?, note?)` —— **强制重算所有 live 会话的活动状态并立即落盘**。
 *     在 v0.6.0 里它是"保存所有活跃会话的交接记录"；现在表本来就是实时的，这一步退化成
 *     "提交一次一致性检查"（幂等、同步返回、从不抛）。`dsh-host-restart` 在杀进程前调它，
 *     语义仍然正确：**它保证表反映的是杀进程那一刻的真实状态**（而不是 300ms 防抖窗口之前的）。
 *     `note` / `noteSessionId` 参数**保留但不使用** —— v0.7.0 不再写"下一步说明"（用户拍板：
 *     说明留空；触发正文由插件生成）。保留形参是为了让消费者的调用点不用改。
 *   · `pendingSummary()` —— 工作表摘要，形状与 v0.6.0 逐字段一致
 *     （`{exists, reason?, items:[{sessionId, kind, done, active, wake}]}`）。表里的条目一律
 *     `done:false / active:true / wake:true`（"在表里"就等于"待唤醒"）。消费者用它判断
 *     "这次重启的续跑消息该由谁注入"——逻辑不变。
 *
 * 消费者**不要**把它写进 `inject`（那样本插件缺席时消费者就不 apply 了），用 `ctx.get()` 可选读取。
 */
export function createHandoffService(ctx, resolved, log, tracker) {
  return Object.freeze({
    /** 强制重算 + 落盘（幂等；**同步返回**、从不抛）。 */
    saveAll() {
      try {
        // 重算本身是异步的（要 await waterfall），但服务面必须同步返回（消费者不 await 也不该被拖住）。
        // 所以这里 fire-and-forget：立刻把已知状态落盘（保证磁盘是最新的），并触发一次异步重算。
        const written = tracker.flush()
        void tracker.refreshAll()
          .then(() => tracker.flush())
          .catch((error) => log(`saveAll 触发的重算失败：${errText(error)}`))
        // `file` 给的是**工作表路径**（v0.7.0 不再有逐会话的记录文件）—— 消费者的用法是
        // `items.filter(ok && item.file).map(item => item.file)` 拼"存到哪了"的文案
        // （本机 `dsh-host-restart/lib/index.js:939-945`），所以每个条目都要带它；
        // 代价是那句文案会把同一个路径列 N 遍（N = 有活的会话数），信息本身是对的。
        const items = tracker.snapshot().map((item) => ({
          ok: true,
          sessionId: item.sessionId,
          kind: item.kind,
          parentSessionId: item.parentSessionId,
          cwd: item.cwd,
          title: item.title,
          why: item.why,
          file: resolved.activeFile,
        }))
        return {
          ok: written,
          saved: items.length,
          failed: 0,
          items,
          createdAt: Date.now(),
          activeFile: resolved.activeFile,
          message: written
            ? `活跃工作表已提交：${items.length} 个会话有在飞的活（${resolved.activeFile}）`
            : `活跃工作表写盘失败（${resolved.activeFile}）—— 内存态仍然正确`,
        }
      } catch (error) {
        log(`saveAll 抛错：${errText(error)}`)
        return { ok: false, saved: 0, failed: 1, items: [], createdAt: Date.now(), message: errText(error) }
      }
    },
    /** v0.6.0 的 `save()`（指定会话保存）**已删除** —— 新模型下"保存谁"由活动状态决定。 */
    pendingSummary() {
      try {
        return tracker.summary()
      } catch (error) {
        return { exists: false, reason: `读工作表摘要失败（${errText(error)}）`, items: [] }
      }
    },
  })
}

function registerService(ctx, resolved, log, tracker) {
  const dispose = ctx.provide(SERVICE_NAME, createHandoffService(ctx, resolved, log, tracker))
  log(`${SERVICE_NAME} 服务已提供（ctx.provide 返回 disposer=${typeof dispose === 'function'}）`)
  return dispose
}

// ────────────────────────────────────────────────────────────────────────────────
// 插件入口
// ────────────────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  // 绝不能把异常抛回 loader：插件加载失败会让**整个 dsh 起不来**（2026-09-17 事故的教训 ——
  // 当时是新 dsh 每次都在打印 token URL 前崩掉，表现为浏览器卡"启动中"）。
  // 任何意外都只降级（服务可能未就位、唤醒可能不执行）并留一行日志。
  try {
    applyInner(ctx, config)
  } catch (error) {
    appendLog(fallbackLogFile(), 'plugin', `apply 抛错，插件已降级（服务可能未注册、唤醒不会执行）：${errText(error)}`)
  }
}

function applyInner(ctx, config) {
  const resolved = resolveConfig(config)
  const log = (message) => {
    appendLog(resolved.logFile, 'plugin', message)
    try { ctx.logger?.info?.(`[sl-handoff] ${message}`) } catch { /* logger 不可用就算了 */ }
  }
  log(`apply: v${VERSION} storageDir=${resolved.storageDir} 工作表=${resolved.activeFile}`
    + ` 防抖=${resolved.debounceMs}ms 兜底重算=${resolved.sweepMs}ms 新鲜度=${Math.round(resolved.staleMs / 3600000)}h`
    + ` 热加载阈值=${Math.round(resolved.bootGraceMs / 60000)}min`
    + ` 唤醒上限=${resolved.resumeMaxSessions === 0 ? '不限' : `${resolved.resumeMaxSessions} 条`}`
    + ` requireColdAgent=${resolved.requireColdAgent}`)

  let disposed = false
  const isDisposed = () => disposed
  const disposers = []

  // ── 1) 实时跟踪器：加载上次留下的表 + 注册事件源（同步注册，避免漏掉启动后的事件）──
  const tracker = createTracker(ctx, resolved, log, isDisposed)
  const loaded = tracker.load()

  // ── 2) 提供保存服务（失败只降级：唤醒逻辑不受影响）──────────────────────────
  try {
    disposers.push(registerService(ctx, resolved, log, tracker))
  } catch (error) {
    log(`${SERVICE_NAME} 服务提供失败（唤醒逻辑不受影响）：${errText(error)}`)
  }

  // ── 3) 启动时消费上一次崩溃留下的表 ─────────────────────────────────────────
  // 延迟 bootDelayMs 再动手：避开宿主启动风暴，等会话持久化/查询与 preset 注册表就位。
  const run = () => {
    runResume(ctx, resolved, log, isDisposed, tracker)
      .catch((error) => {
        log(`恢复流程异常：${errText(error)}`)
      })
      // 无论成功/失败/让位，恢复流程都算"跑过了"：此后加载来的条目按正常语义增删
      .finally(() => tracker.markResumeDone())
  }
  let cancelBoot
  try {
    // timer 已在 inject 中声明；这里仍兜一层 —— 定时器拿不到不该拖垮宿主。
    cancelBoot = ctx.timeout(run, resolved.bootDelayMs)
  } catch (error) {
    log(`ctx.timeout 不可用（${errText(error)}），回退全局 setTimeout`)
    const timer = setTimeout(run, resolved.bootDelayMs)
    cancelBoot = () => clearTimeout(timer)
  }

  // ── 4) 生命周期：插件卸载/热重载时撤销全部副作用 ──────────────────────────────
  // ⚠ 这里**不能**写 `ctx.on('dispose', …)`：本机 cordis 在 fiber 卸载时发的是 `internal/plugin`，
  //   根本没有 `dispose` 这个事件 —— 那样写等于清理代码永不执行（参考实现踩过，本包不学）。
  //   cordis 的清理机制是 `ctx.effect(() => 返回一个清理函数)`：返回值登记进当前 fiber，卸载时执行。
  ctx.effect(() => () => {
    disposed = true
    try { cancelBoot?.() } catch { /* 已触发 */ }
    // 卸载前把内存态落盘：热重载后新实例能接着用（也避免丢掉刚发生的状态变化）
    try { tracker.flush() } catch { /* 尽力而为 */ }
    tracker.dispose()
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* 已回收 */ }
    }
    disposers.length = 0
    log(`dispose：已回收服务、事件订阅与定时器（工作表 ${loaded.kind === 'fresh' ? '已加载' : '未加载'}）`)
  }, 'sl-handoff: cleanup')
}
