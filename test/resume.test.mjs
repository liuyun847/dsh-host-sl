/**
 * 恢复流程：计划排序、两道闸门、逐条判定、以及 runResume 的端到端语义。
 *
 * 与 v0.6.0 最大的差别：表里**只有"有活的会话"**，所以没有"空闲条目分流"那一层；
 * 唤醒成功后条目**从表里移除**（这就是"不重复唤醒"的机制）。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  KIND_ROOT,
  KIND_SUBAGENT,
  buildResumePlan,
  buildResumeText,
  buildSubagentResumeText,
  decideResume,
  decideSubagentResume,
  evaluateGate,
  resolveConfig,
  runResume,
} from '../lib/index.js'
import { makeCtx } from './helpers.mjs'

/**
 * 冷恢复注入的**固定首句**（逐字钉死：半角逗号、`sl` 小写、无空格）。
 *
 * 这里刻意写成字面量而不是拼 `INJECT_HEADING`：这条文案是用户可见的约定，
 * 改标题常量同样应该让用例转红。
 */
const FIXED_FIRST_LINE = '【sl 交接续跑】sl已接续会话,继续'

function entry(overrides = {}) {
  return {
    sessionId: 'session-root',
    kind: KIND_ROOT,
    parentSessionId: '',
    title: '',
    cwd: 'C:\\work',
    why: ['turn'],
    goal: false,
    activity: [{ kind: 'turn' }],
    since: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/** 只实现 runResume 用到的那几个方法（聚焦被测逻辑，不牵扯真实跟踪器）。 */
function fakeTracker(items) {
  const map = new Map(items.map((item) => [item.sessionId, item]))
  return {
    removed: [],
    snapshot: () => [...map.values()],
    remove(sessionId) {
      this.removed.push(sessionId)
      return map.delete(sessionId)
    },
    flush: () => true,
    refreshAll: async () => ({}),
    markResumeDone: () => {},
    dispose: () => {},
  }
}

function makeAgent(sessionId, { status = 'idle', origin, parentSession, pendingTurn = [] } = {}) {
  const header = { id: sessionId, cwd: 'C:\\work' }
  if (origin !== undefined) header.origin = origin
  if (parentSession !== undefined) header.parentSession = parentSession
  const followups = []
  const steers = []
  return {
    status,
    session: { id: sessionId, header },
    // 宿主 inbox 的 next-turn 队列（`nextTurn` 是 getter）—— 插队判据要读它；默认空 = 允许插队
    inbox: { nextTurn: pendingTurn },
    followups,
    steers,
    followup(message) { followups.push(message) },
    steer(message) { steers.push(message) },
  }
}

test('buildResumePlan：先顶层、后子代理，组内保序，上限只截断队列', () => {
  const items = [
    entry({ sessionId: 'sub-1', kind: KIND_SUBAGENT, parentSessionId: 'root-2' }),
    entry({ sessionId: 'root-1' }),
    entry({ sessionId: 'sub-2', kind: KIND_SUBAGENT, parentSessionId: 'root-1' }),
    entry({ sessionId: 'root-2' }),
  ]
  const plan = buildResumePlan(items, 0)
  assert.deepEqual(plan.queue.map((item) => item.sessionId), ['root-1', 'root-2', 'sub-1', 'sub-2'],
    '顺序是硬约束：冷恢复子代理要求父 agent 已经活着')
  assert.deepEqual(plan.roots.map((item) => item.sessionId), ['root-1', 'root-2'])
  assert.deepEqual(plan.subagents.map((item) => item.sessionId), ['sub-1', 'sub-2'])
  assert.deepEqual(plan.deferred, [])

  const limited = buildResumePlan(items, 3)
  assert.deepEqual(limited.queue.map((item) => item.sessionId), ['root-1', 'root-2', 'sub-1'])
  assert.deepEqual(limited.deferred.map((item) => item.sessionId), ['sub-2'], '超上限的留在表里等下次启动')

  const bad = buildResumePlan(items, -5)
  assert.equal(bad.queue.length, 4, '非法上限 = 不限')
})

test('evaluateGate：闸门② 热加载（进程已跑很久）⇒ 让位', () => {
  const gate = evaluateGate({ uptimeMs: 10 * 60 * 1000, bootGraceMs: 5 * 60 * 1000, rootSessions: [] })
  assert.equal(gate.kind, 'yield')
  assert.match(gate.reason, /热加载/)
})

test('evaluateGate：闸门① 别的顶层会话**正在跑一轮** ⇒ 让位；活着但空闲不让位', () => {
  const busy = evaluateGate({
    uptimeMs: 1000,
    rootSessions: [{ id: 'session-other', running: true }, { id: 'session-idle', running: false }],
  })
  assert.equal(busy.kind, 'yield')
  assert.match(busy.reason, /session-other/)
  assert.doesNotMatch(busy.reason, /session-idle/, '空闲的其它会话不是让位理由')

  const idle = evaluateGate({ uptimeMs: 1000, rootSessions: [{ id: 'session-idle', running: false }] })
  assert.equal(idle, undefined)
})

test('evaluateGate：本批要唤醒的会话自己被唤醒成 running ⇒ **不算**"别的会话"', () => {
  const gate = evaluateGate({
    uptimeMs: 1000,
    rootSessions: [{ id: 'session-target', running: true }],
    excludedIds: new Set(['session-target']),
  })
  assert.equal(gate, undefined, '排除名单生效：否则重启插件刚注入的那一轮会让整批让位')
})

test('decideResume：列表不可用 ⇒ 照常唤醒；不在列表里 ⇒ 让位；空会话 ⇒ 不可恢复', () => {
  assert.equal(decideResume({ item: entry(), items: undefined }).kind, 'resume')

  const absent = decideResume({ item: entry({ sessionId: 'session-x' }), items: [{ sessionId: 'session-y' }] })
  assert.equal(absent.kind, 'yield', '不在列表里多半是宿主刚启动、列表没装载完 —— 判死会消费掉唯一的待办')

  const blank = decideResume({ item: entry({ sessionId: 'session-x' }), items: [{ sessionId: 'session-x', blank: true }] })
  assert.equal(blank.kind, 'unresumable')

  const normal = decideResume({ item: entry({ sessionId: 'session-x' }), items: [{ sessionId: 'session-x' }] })
  assert.equal(normal.kind, 'resume')

  const running = decideResume({ item: entry({ sessionId: 'session-x' }), items: [{ sessionId: 'session-x', running: true }] })
  assert.equal(running.kind, 'resume', '目标会话自己在跑不拦（followup 只排进下一轮）')

  const cold = decideResume({
    item: entry({ sessionId: 'session-x' }),
    items: [{ sessionId: 'session-x', agentAvailable: true }],
    requireColdAgent: true,
  })
  assert.equal(cold.kind, 'yield', 'requireColdAgent 是唯一剩下的目标侧让位理由')
})

test('buildResumeText：固定首句 + 继续指引 + 断点信息（会话历史里看不到的那些）', () => {
  const text = buildResumeText(entry({
    activity: [
      { kind: 'turn' },
      { kind: 'job', items: [{ id: 'bash-3', label: 'pwsh -Command 下载' }] },
      { kind: 'subagent', items: [{ id: 'session-child', label: '补测试' }] },
      { kind: 'schedule', items: [{ id: 'sch-1' }] },
    ],
    goal: true,
  }))
  assert.equal(text.split('\n')[0], FIXED_FIRST_LINE, '首行必须是逐字固定文案（含半角逗号）')
  assert.match(text, /完整对话历史已经回来了/)
  assert.match(text, /先确认现状（文件、产物、作业输出）/, '继续指引仍在')
  assert.match(text, /不要照抄重启前的结论/)
  assert.match(text, /重启时你名下还有这些在飞的活/, '在飞清单的小节标题仍在')
  assert.match(text, /后台作业 bash-3：pwsh -Command 下载/)
  assert.match(text, /子代理 session-child：补测试/)
  assert.match(text, /定时任务 sch-1/)
  assert.match(text, /自动续轮的目标（goal）还挂着/)
  assert.match(text, /接续结果会另发一条消息告诉你/, 'v0.7.2：有子代理时必须预告"结果稍后单独通知"')
  assert.doesNotMatch(text, /它自己正跑着一轮/, 'turn 不列进"你看不到的活"（那是它自己的状态）')
  assert.doesNotMatch(text, /你上一轮被打断/, '旧首句已删除，正文里不得残留')

  const truncated = buildResumeText(entry({ activity: [{ kind: 'job', items: [{ id: 'x', label: 'y'.repeat(500) }] }] }), { maxChars: 200 })
  assert.ok(truncated.length <= 200)
  assert.match(truncated, /已截断/)
})

test('buildResumeText：没有子代理时不预告（别让父会话白等一条通知）', () => {
  const noSubagent = buildResumeText(entry({ activity: [{ kind: 'job', items: [{ id: 'bash-3', label: '下载' }] }] }))
  assert.doesNotMatch(noSubagent, /接续结果会另发一条消息告诉你/)

  const bare = buildResumeText(entry({ activity: [{ kind: 'turn' }] }))
  assert.doesNotMatch(bare, /接续结果会另发一条消息告诉你/)

  const withSubagent = buildResumeText(entry({ activity: [{ kind: KIND_SUBAGENT, items: [] }] }))
  assert.match(withSubagent, /子代理：还有在跑的（宿主没给细节）/, '没有细节时也要列出来')
  assert.match(withSubagent, /接续结果会另发一条消息告诉你/, '没有细节同样算"有子代理"')
})

test('decideSubagentResume：空会话 ⇒ 不可恢复；不在列表 ⇒ 让位；列表不可用 ⇒ 照常试', () => {
  const sub = entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' })
  assert.equal(decideSubagentResume({ item: sub, items: undefined }).kind, 'resume', '列表不可用 ⇒ 跳过列表判定')
  assert.equal(decideSubagentResume({ item: sub, items: 'x' }).kind, 'unresumable', '形态不符 ⇒ 不可恢复')
  assert.equal(decideSubagentResume({ item: sub, items: [{ sessionId: 'session-other' }] }).kind, 'yield',
    '不在列表里 ⇒ 让位（与顶层同口径：判死会消费掉唯一的待办）')
  assert.equal(decideSubagentResume({ item: sub, items: [{ sessionId: 'session-child', blank: true }] }).kind, 'unresumable')
  assert.equal(decideSubagentResume({ item: sub, items: [{ sessionId: 'session-child' }] }).kind, 'resume')
  assert.equal(decideSubagentResume({
    item: sub,
    items: [{ sessionId: 'session-child', agentAvailable: true }],
    requireColdAgent: true,
  }).kind, 'resume', 'requireColdAgent 有意不适用于子代理（live + running 是它的常态）')
})

test('buildResumeText：hasSubagentEntries 覆盖清单判据（预告与通知必须同源）', () => {
  const bare = entry({ activity: [{ kind: 'turn' }] })
  assert.doesNotMatch(buildResumeText(bare), /接续结果会另发一条消息告诉你/)
  assert.match(buildResumeText(bare, { hasSubagentEntries: true }), /接续结果会另发一条消息告诉你/,
    '清单里没列子代理、但工作表里有它的条目 ⇒ 照样预告（否则"有通知没预告"）')

  const listed = entry({ activity: [{ kind: KIND_SUBAGENT, items: [{ id: 'session-child', label: '补测试' }] }] })
  assert.match(buildResumeText(listed), /接续结果会另发一条消息告诉你/, '不传参数时退回清单推断')
  assert.doesNotMatch(buildResumeText(listed, { hasSubagentEntries: false }), /接续结果会另发一条消息告诉你/,
    '清单里有、但工作表里没有 ⇒ 不预告（否则"有预告没通知"）')
})

test('buildSubagentResumeText：固定首句 + 父会话 id + 先汇报状态（点名 send_message）', () => {
  const text = buildSubagentResumeText(entry({ kind: KIND_SUBAGENT, parentSessionId: 'session-parent' }))
  assert.equal(text.split('\n')[0], FIXED_FIRST_LINE, '子代理版首行与顶层逐字相同')
  assert.match(text, /你是子代理，这是重启后的接续，不是父代理新派活/, '必须说清"不是父代理新派的活"')
  assert.match(text, /session-parent/, '必须写明挂在哪个父会话名下')
  assert.match(text, /把当前状态汇报给/, '汇报要求仍在')
  assert.match(text, /做到哪一步、哪些结论已经有了、有没有留下半成品文件/)
  assert.match(text, /不要照抄重启前的结论/)
  assert.doesNotMatch(text, /dsh 重启把你上一轮打断了/, '旧首句已删除')

  // v0.7.5：汇报必须**点名工具**（光说"汇报"的话子代理会写在正文里，而父会话看不到）
  assert.match(text, /用 `send_message` 工具把当前状态汇报给/, '汇报要指定走 send_message')
  assert.match(text, /你在这边的正文输出它看不到/, '要说清为什么必须发过去（正文父会话看不到）')
  assert.match(text, /发完再继续未完成的部分/, '"先汇报、后继续"的顺序不变')

  const noParent = buildSubagentResumeText(entry({ kind: KIND_SUBAGENT, parentSessionId: '' }))
  assert.equal(noParent.split('\n')[0], FIXED_FIRST_LINE, '没有父会话 id 时首句不变')
  assert.doesNotMatch(noParent, /你挂在父会话/)
  assert.match(noParent, /把当前状态汇报给父会话（/, '没有父会话 id 时退成不带 id 的说法（句子仍然通顺）')
  assert.doesNotMatch(noParent, /undefined/, '缺父会话 id 不能把 undefined 渲染进正文')
})

test('注入固定首句：顶层与子代理逐字相同（半角逗号），旧文案零残留', () => {
  const root = buildResumeText(entry())
  const sub = buildSubagentResumeText(entry({ kind: KIND_SUBAGENT, parentSessionId: 'session-parent' }))
  assert.equal(root.split('\n')[0], FIXED_FIRST_LINE)
  assert.equal(sub.split('\n')[0], FIXED_FIRST_LINE, '两个版本共用同一句固定文案')
  assert.ok(root.includes('sl已接续会话,继续'), '逗号必须是半角')
  assert.doesNotMatch(root, /sl已接续会话，继续/, '不能写成中文全角逗号')
  assert.doesNotMatch(root, /你上一轮被打断/, '旧首句在顶层正文里零残留')
  assert.doesNotMatch(sub, /dsh 重启把你上一轮打断了/, '旧首句在子代理正文里零残留')
})

// ── runResume 端到端 ────────────────────────────────────────────────────────────

/** 造一个跑 runResume 的完整环境。 */
function makeResumeEnv({ items, agents = [], services = {}, config = {} } = {}) {
  const resolved = resolveConfig({ storageDir: 'C:\\fake', debounceMs: 0, ...config })
  const tracker = fakeTracker(items)
  const serviceTable = {
    agents: {
      list: () => agents.map((a) => a.agent),
      roots: () => agents.filter((a) => a.kind === KIND_ROOT).map((a) => a.agent),
      get: (id) => agents.find((a) => a.sessionId === id)?.agent,
    },
    sessions: { flush: async () => {}, get: () => undefined },
    sessionController: {
      list: async () => ({ items: agents.map((a) => ({ sessionId: a.sessionId })) }),
      resolveAgent: async (sessionId) => {
        const found = agents.find((a) => a.sessionId === sessionId)
        return found === undefined ? { error: new Error('not found') } : { agent: found.agent }
      },
    },
    ...services,
  }
  const handle = makeCtx(serviceTable, {
    waterfall: async (event, payload, fallback) => (event === 'workspace/session-activity' ? [] : fallback()),
  })
  const logs = []
  return { resolved, tracker, handle, logs, agents, log: (m) => logs.push(m) }
}

test('runResume：空表 ⇒ 什么都不做', async () => {
  const env = makeResumeEnv({ items: [] })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.kind, 'idle')
  assert.match(env.logs.join('\n'), /工作表里没有待唤醒的会话/)
})

test('runResume：唤醒顶层会话（followup + flush）并从表里移除', async () => {
  const agent = makeAgent('session-root')
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-root' })],
    agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }],
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.kind, 'resume')
  assert.equal(result.woken, 1)
  assert.equal(agent.followups.length, 1, '注入了一条触发消息')
  assert.equal(agent.followups[0].content[0].text.split('\n')[0], FIXED_FIRST_LINE, '注入消息首行就是固定文案')
  assert.deepEqual(env.tracker.snapshot(), [], '唤醒成功 ⇒ 从表里移除')
  assert.deepEqual(env.tracker.removed, ['session-root'])
})

test('runResume：先顶层、后子代理（顺序硬约束）', async () => {
  const root = makeAgent('session-root')
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const prompts = []
  const env = makeResumeEnv({
    items: [
      entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' }),
      entry({ sessionId: 'session-root' }),
    ],
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    services: {
      subagents: {
        prompt: async (request) => { prompts.push(request) },
      },
    },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 2)
  assert.equal(prompts.length, 1, '子代理后投递')
  assert.equal(prompts[0].parentSessionId, 'session-root')
  assert.equal(prompts[0].childSessionId, 'session-child')
  assert.equal(prompts[0].mode, 'continuable')
  assert.equal(prompts[0].delivery, 'queue')
  assert.match(prompts[0].content[0].text, /不是父代理新派活/)
  assert.equal(root.followups.length, 2, '顶层先被唤醒（续跑注入），子代理试完后补一条结果通知')
  assert.equal(root.followups[0].content[0].text.split('\n')[0], FIXED_FIRST_LINE, '第一条是续跑指令')
  assert.match(root.followups[1].content[0].text, /^【sl 交接】子代理接续结果/, '第二条是接续结果（v0.7.2：成功也报）')
  assert.match(root.followups[1].content[0].text, /✅ `session-child`：已唤回/)
  assert.deepEqual(env.tracker.snapshot(), [])
})

test('runResume：父会话正在跑 ⇒ 结果通知 steer 插队（不再等下一轮）', async () => {
  // 父会话在 queue 里（本批要唤醒它）⇒ 它不在闸门①的"别的会话"里；被唤醒后它就在跑这一轮，
  // 于是阶段 3 的通知走 steer —— 这正是"第二条注入太慢"要修的那个真实场景。
  const root = makeAgent('session-root', { status: 'running' })
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const env = makeResumeEnv({
    items: [
      entry({ sessionId: 'session-root' }),
      entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' }),
    ],
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    services: { subagents: { prompt: async () => {} } },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 2)
  assert.equal(root.followups.length, 1, '续跑注入仍走 followup（排队，不打断当前轮）')
  assert.match(root.followups[0].content[0].text, /^【sl 交接续跑】/)
  assert.equal(root.steers.length, 1, '结果通知走 steer（next-step，同轮可见）')
  assert.match(root.steers[0].content[0].text, /^【sl 交接】子代理接续结果/)
  assert.match(env.logs.join('\n'), /steer 插队，同轮可见/)
})

test('runResume：父会话自己有条目且让位 ⇒ 不裸唤醒它（否则那条续跑注入会永久丢）', async () => {
  // 评审 2026-10-03 的 P2 回归：阶段 1.5 曾无条件冷唤醒"不在 parentAgents 里"的父会话。
  // 父自己那条让位（不在会话列表里）时，阶段 1 不注入、1.5 却把它唤醒 ⇒ 它只收到一条结果通知；
  // markResumeDone 一开闸，跟踪器发现它没活就删掉条目 ⇒ 续跑注入永久丢失。
  const root = makeAgent('session-root')
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const env = makeResumeEnv({
    items: [
      entry({ sessionId: 'session-root' }),
      entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' }),
    ],
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    services: { subagents: { prompt: async () => { throw new Error('父没 live，投不出去') } } },
  })
  const originalGet = env.handle.ctx.get
  env.handle.ctx.get = (name) => (name === 'sessionController'
    ? {
        list: async () => ({ items: [] }),   // 两条都不在列表里 ⇒ 都让位
        resolveAgent: async (id) => ({ agent: id === 'session-root' ? root : child }),
      }
    : originalGet(name))
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 0)
  assert.deepEqual(env.tracker.snapshot().map((item) => item.sessionId).sort(), ['session-child', 'session-root'],
    '两条都留表（下次启动再判）')
  assert.match(env.logs.join('\n'), /自己在工作表里有条目/)
  assert.doesNotMatch(env.logs.join('\n'), /先冷唤醒（子代理这样才投得出去）/,
    '阶段 1.5 不碰"自己有条目"的父会话')
  assert.equal(root.followups.length, 1, '父会话只收到那条 ⏸ 结果通知（通知走唤醒语义，是既有设计）')
  assert.match(root.followups[0].content[0].text, /⏸ `session-child`：本次没尝试/)
})

test('runResume：父会话在跑但 next-turn 还有消息 ⇒ 通知退回 followup（保顺序）', async () => {
  // 评审 2026-10-03 的 P2：claim() 先交 next-step、后交 1 条 next-turn（宿主 :104-105），
  // 所以队列里还压着消息时插队会让结果通知跑到续跑指令前面。
  const root = makeAgent('session-root', { status: 'running', pendingTurn: [{ id: 'pending-1' }] })
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const env = makeResumeEnv({
    items: [
      entry({ sessionId: 'session-root' }),
      entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' }),
    ],
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    services: { subagents: { prompt: async () => {} } },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 2)
  assert.equal(root.steers.length, 0, 'next-turn 里还压着消息 ⇒ 不插队')
  assert.equal(root.followups.length, 2, '续跑注入 + 结果通知都排队')
  assert.match(env.logs.join('\n'), /followup 排队，下一轮可见/)
})

test('runResume：清单里没列子代理、但表里有它的条目 ⇒ 续跑注入照样带预告', async () => {
  const root = makeAgent('session-root')
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const env = makeResumeEnv({
    items: [
      entry({ sessionId: 'session-root', activity: [{ kind: 'turn' }] }),   // 清单里只有 turn
      entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' }),
    ],
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    services: { subagents: { prompt: async () => {} } },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 2)
  const injected = root.followups[0].content[0].text
  assert.match(injected, /^【sl 交接续跑】/)
  assert.match(injected, /接续结果会另发一条消息告诉你/, '预告看的是工作表里的子代理条目（与通知同源）')
  assert.match(root.followups[1].content[0].text, /^【sl 交接】子代理接续结果/, '通知也确实发了')
})

test('runResume：子代理的父会话不在 live 表 ⇒ 先冷唤醒它再试子代理（P1 回归）', async () => {
  // 评审 2026-10-03 实测复现：v0.7.2 先判"父不是 live"⇒ 子代理失败 ⇒ 通知又把父冷唤醒，
  // 于是父收到的 ❌ 通知里写着"原因：父会话 X 此刻不是 live agent"——而它正是被这条通知叫醒的。
  const root = makeAgent('session-root')
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const live = new Map()
  const prompts = []
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' })],
    services: {
      agents: { list: () => [...live.values()], roots: () => [], get: (id) => live.get(id) },
      sessionController: {
        list: async () => ({ items: [{ sessionId: 'session-child' }, { sessionId: 'session-root' }] }),
        resolveAgent: async (id) => {
          if (id === 'session-root') { live.set(id, root); return { agent: root } }
          if (id === 'session-child') { live.set(id, child); return { agent: child } }
          return { error: new Error('not found') }
        },
      },
      subagents: { prompt: async (request) => { prompts.push(request) } },
    },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 1, '父先被冷唤醒 ⇒ 子代理真的投出去了（v0.7.2 这里必然失败）')
  assert.equal(prompts.length, 1)
  assert.match(env.logs.join('\n'), /先冷唤醒（子代理这样才投得出去）/)
  assert.equal(root.followups.length, 1, '父不在本批顶层条目里 ⇒ 只收到结果通知')
  const text = root.followups[0].content[0].text
  assert.match(text, /✅ `session-child`：已唤回/)
  assert.doesNotMatch(text, /不是 live agent/, '通知里不该再出现"父不是 live"这种自相矛盾的原因')
})

test('runResume：子代理是空会话 ⇒ 不可恢复 ⇒ 从表里移除（不再每轮重试）', async () => {
  const root = makeAgent('session-root')
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' })],
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    services: { subagents: { prompt: async () => { throw new Error('空会话不该被投消息（凭空造会话）') } } },
  })
  const originalGet = env.handle.ctx.get
  env.handle.ctx.get = (name) => (name === 'sessionController'
    ? {
        list: async () => ({ items: [{ sessionId: 'session-child', blank: true }, { sessionId: 'session-root' }] }),
        resolveAgent: async (id) => ({ agent: id === 'session-root' ? root : child }),
      }
    : originalGet(name))
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.unresumable, 1)
  assert.deepEqual(env.tracker.snapshot(), [], '不可恢复 ⇒ 移除，不留着每轮重试')
  assert.match(env.logs.join('\n'), /不可恢复/)
  const text = root.followups[0].content[0].text
  assert.match(text, /❌ `session-child`：没能唤回/)
  assert.match(text, /不会再自动重试/, '父会话有权知道"这条不会再试了"')
})

test('runResume：子代理不在会话列表里 ⇒ 让位（条目留表，下次再判）', async () => {
  const root = makeAgent('session-root')
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' })],
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    services: { subagents: { prompt: async () => { throw new Error('不在列表里不该投递') } } },
  })
  const originalGet = env.handle.ctx.get
  env.handle.ctx.get = (name) => (name === 'sessionController'
    ? {
        list: async () => ({ items: [{ sessionId: 'session-root' }] }),
        resolveAgent: async (id) => ({ agent: id === 'session-root' ? root : child }),
      }
    : originalGet(name))
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.yielded, 1)
  assert.deepEqual(env.tracker.snapshot().map((item) => item.sessionId), ['session-child'], '让位 ⇒ 留在表里')
  assert.match(root.followups[0].content[0].text, /⏸ `session-child`：本次没尝试/)
})

test('runResume：子代理被上限截断 ⇒ 给父会话补一条 ⏸ 说明（别让预告变空头支票）', async () => {
  const root = makeAgent('session-root')
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const env = makeResumeEnv({
    items: [
      entry({ sessionId: 'session-root' }),
      entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' }),
    ],
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    config: { resumeMaxSessions: 1 },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 1)
  assert.equal(result.deferred, 1)
  const text = root.followups[root.followups.length - 1].content[0].text
  assert.match(text, /^【sl 交接】子代理接续结果/)
  assert.match(text, /⏸ `session-child`：本次没尝试/)
  assert.match(text, /超出本次唤醒上限/)
})

test('runResume：子代理没唤回来 ⇒ 条目留在表里 + 结果回报给父会话', async () => {
  const root = makeAgent('session-root')
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' })],
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    services: {
      subagents: { prompt: async () => { throw new Error('subagent/not-resumable（测试造的）') } },
    },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 0)
  assert.equal(result.failed, 1)
  assert.deepEqual(env.tracker.snapshot().map((item) => item.sessionId), ['session-child'], '失败 ⇒ 留在表里重试')
  assert.equal(root.followups.length, 1, '父会话收到一条汇总通知（它自己不在唤醒队列里，所以只有这一条）')
  const text = root.followups[0].content[0].text
  assert.match(text, /^【sl 交接】子代理接续结果/)
  assert.match(text, /❌ `session-child`：没能唤回/)
  assert.match(text, /subagent\/not-resumable/)
  assert.match(text, /没有上报给你/)
  assert.match(env.logs.join('\n'), /子代理接续结果已通知 父会话 session-root/)
})

test('runResume：子代理唤回成功 ⇒ 也回报给父会话（v0.7.2：成功也报）', async () => {
  const root = makeAgent('session-root')
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' })],
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    services: { subagents: { prompt: async () => {} } },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 1)
  assert.deepEqual(env.tracker.snapshot(), [], '成功 ⇒ 条目从表里移除')
  assert.equal(root.followups.length, 1)
  const text = root.followups[0].content[0].text
  assert.match(text, /✅ `session-child`：已唤回/)
  assert.match(text, /它接下来会自己向你汇报当前状态/)
  assert.doesNotMatch(text, /没能唤回/)
  assert.doesNotMatch(text, /下一步建议/, '全成功时不出现"下一步建议"那一段')
})

test('runResume：同一父会话的多个子代理 ⇒ 只发一条汇总通知', async () => {
  const root = makeAgent('session-root')
  const childOk = makeAgent('session-child-ok', { origin: 'subagent', parentSession: 'session-root' })
  const childBad = makeAgent('session-child-bad', { origin: 'subagent', parentSession: 'session-root' })
  const env = makeResumeEnv({
    items: [
      entry({ sessionId: 'session-child-ok', kind: KIND_SUBAGENT, parentSessionId: 'session-root' }),
      entry({ sessionId: 'session-child-bad', kind: KIND_SUBAGENT, parentSessionId: 'session-root' }),
    ],
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child-ok', agent: childOk, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
      { sessionId: 'session-child-bad', agent: childBad, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    services: {
      subagents: {
        prompt: async (request) => {
          if (request.childSessionId === 'session-child-bad') throw new Error('投递失败（测试造的）')
        },
      },
    },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 1)
  assert.equal(result.failed, 1)
  assert.equal(root.followups.length, 1, '两个子代理也只发一条（按父会话汇总）')
  const text = root.followups[0].content[0].text
  assert.match(text, /✅ `session-child-ok`：已唤回/)
  assert.match(text, /❌ `session-child-bad`：没能唤回/)
  assert.match(text, /它们都挂在你（父会话 `session-root`）名下/)
})

test('runResume：子代理条目没有 parentSessionId ⇒ 只写日志，不猜收件人', async () => {
  const child = makeAgent('session-child', { origin: 'subagent' })
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: '' })],
    agents: [{ sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' }],
    services: { subagents: { prompt: async () => {} } },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.failed, 1, '条目没有父会话 id ⇒ 投递不了（wakeSubagent 的第一道判定）')
  assert.match(env.logs.join('\n'), /没有 parentSessionId ⇒ 接续结果没有可通知的父会话/)
})

test('runResume：父会话不是 live agent ⇒ 子代理失败并留在表里', async () => {
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' })],
    agents: [{ sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' }],
    services: { subagents: { prompt: async () => {} } },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.failed, 1)
  assert.match(env.logs.join('\n'), /父会话 session-root 此刻不是 live agent/)
  assert.equal(env.tracker.snapshot().length, 1)
  assert.match(env.logs.join('\n'), /的父会话 session-root 唤不醒/, '阶段 1.5 先试过冷唤醒（失败才轮到子代理失败）')
  assert.match(env.logs.join('\n'), /1 条子代理接续结果发不出去/, '连父会话都唤不醒时，通知也只能降级成日志')
})

test('runResume：子代理 flush 的两条分支文案与实际返回值一致', async () => {
  // 评审 2026-10-03 的 P2 回归：v0.7.2 这两句写反了（true 说成"不在 live store"、false 说成"已 flush"）。
  const mk = (sessions) => {
    const root = makeAgent('session-root')
    const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
    return makeResumeEnv({
      items: [entry({ sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root' })],
      agents: [
        { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
        { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
      ],
      services: { subagents: { prompt: async () => {} }, sessions },
    })
  }

  // ① 子代理会话此刻不在 live store 里 ⇒ flushLiveSession 返回 true（"无需落盘"不是失败）
  const needless = mk({ flush: async () => {}, get: () => undefined })
  const a = await runResume(needless.handle.ctx, needless.resolved, needless.log, () => false, needless.tracker)
  assert.equal(a.woken, 1)
  assert.match(needless.logs.join('\n'), /落盘已确认或无需落盘/)
  assert.doesNotMatch(needless.logs.join('\n'), /flush 没成功/, '不能把"无需落盘"说成失败')

  // ② 查 live store 抛错 ⇒ 返回 false（保守方向）⇒ 文案说"可能没落盘"，并计入 flushedFailures
  const broken = mk({ flush: async () => {}, get: () => { throw new Error('live store 炸了（测试造的）') } })
  const b = await runResume(broken.handle.ctx, broken.resolved, broken.log, () => false, broken.tracker)
  assert.equal(b.woken, 1, 'flush 失败不改"已唤醒"这个事实')
  assert.match(broken.logs.join('\n'), /这条注入可能没落盘/)
  assert.match(broken.logs.join('\n'), /flush 失败 1 条/, '这两条原先返回 true，会漏出 flushedFailures 统计')
})

test('runResume：整批让位（热加载）⇒ 表一个字节都不动', async () => {
  const agent = makeAgent('session-root')
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-root' })],
    agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }],
    config: { bootGraceMs: 0 },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.kind, 'yield')
  assert.equal(agent.followups.length, 0, '让位时不注入')
  assert.deepEqual(env.tracker.snapshot().map((item) => item.sessionId), ['session-root'], '条目原样保留')
  assert.deepEqual(env.tracker.removed, [])
  assert.match(env.logs.join('\n'), /表保留，下次启动再判/)
})

test('runResume：别的顶层会话正在跑一轮 ⇒ 让位', async () => {
  const busy = makeAgent('session-other', { status: 'running' })
  const agent = makeAgent('session-root')
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-root' })],
    agents: [
      { sessionId: 'session-other', agent: busy, kind: KIND_ROOT },
      { sessionId: 'session-root', agent, kind: KIND_ROOT },
    ],
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.kind, 'yield')
  assert.equal(agent.followups.length, 0)
  assert.match(result.reason, /session-other/)
})

test('runResume：sessionController 等不到 ⇒ 表保留', async () => {
  const agent = makeAgent('session-root')
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-root' })],
    agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }],
    config: { controllerWaitMs: 0 },
  })
  // 把 controller 拿掉（ctx.get 返回 undefined）
  const originalGet = env.handle.ctx.get
  env.handle.ctx.get = (name) => (name === 'sessionController' ? undefined : originalGet(name))
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.kind, 'yield')
  assert.match(env.logs.join('\n'), /不可用，本次不唤醒（表保留）/)
  assert.equal(env.tracker.snapshot().length, 1)
})

test('runResume：空会话 ⇒ 不可恢复 ⇒ 从表里移除（它没有可续的状态）', async () => {
  const agent = makeAgent('session-root')
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-root' })],
    agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }],
  })
  const originalGet = env.handle.ctx.get
  env.handle.ctx.get = (name) => (name === 'sessionController'
    ? {
        list: async () => ({ items: [{ sessionId: 'session-root', blank: true }] }),
        resolveAgent: async () => ({ agent }),
      }
    : originalGet(name))
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.unresumable, 1)
  assert.equal(agent.followups.length, 0)
  assert.deepEqual(env.tracker.snapshot(), [], '不可恢复的条目不该每次启动都重试一遍')
  assert.match(env.logs.join('\n'), /不可恢复/)
})

test('runResume：resolveAgent 失败 ⇒ 条目留在表里（下次启动重试）', async () => {
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-root' })],
    agents: [{ sessionId: 'session-root', agent: makeAgent('session-root'), kind: KIND_ROOT }],
  })
  const originalGet = env.handle.ctx.get
  env.handle.ctx.get = (name) => (name === 'sessionController'
    ? { list: async () => ({ items: [{ sessionId: 'session-root' }] }), resolveAgent: async () => ({ error: new Error('会话已删除') }) }
    : originalGet(name))
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.failed, 1)
  assert.equal(env.tracker.snapshot().length, 1)
  assert.match(env.logs.join('\n'), /留在工作表里，下次启动重试/)
})

test('runResume：resumeMaxSessions 截断 ⇒ 超出的条目留在表里', async () => {
  const a = makeAgent('session-a')
  const b = makeAgent('session-b')
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-a' }), entry({ sessionId: 'session-b' })],
    agents: [
      { sessionId: 'session-a', agent: a, kind: KIND_ROOT },
      { sessionId: 'session-b', agent: b, kind: KIND_ROOT },
    ],
    config: { resumeMaxSessions: 1 },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 1)
  assert.equal(result.deferred, 1)
  assert.deepEqual(env.tracker.snapshot().map((item) => item.sessionId), ['session-b'])
  assert.match(env.logs.join('\n'), /超出 resumeMaxSessions=1 的上限/)
})

test('runResume：flush 失败不影响"唤醒成功 + 移除条目"', async () => {
  const agent = makeAgent('session-root')
  const env = makeResumeEnv({
    items: [entry({ sessionId: 'session-root' })],
    agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }],
    services: { sessions: { flush: async () => { throw new Error('磁盘满了') }, get: () => undefined } },
  })
  const result = await runResume(env.handle.ctx, env.resolved, env.log, () => false, env.tracker)
  assert.equal(result.woken, 1)
  assert.deepEqual(env.tracker.snapshot(), [], 'flush 失败不改变"已唤醒"这个事实')
  assert.match(env.logs.join('\n'), /flush 未成功/)
})
