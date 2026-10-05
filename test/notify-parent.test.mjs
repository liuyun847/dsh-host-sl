/**
 * 「子代理接续结果 ⇒ 通知它的父会话」这条知情权通道。
 *
 * 它要解决的问题没变：重启会硬杀在飞的子代理，父会话**一无所知** —— 它既看不到"那个子代理
 * 已经没了"，也看不到"它当时的结论可能没上报"。
 *
 * v0.7.2 起这条通道**成功也报**（用户 2026-10-03 的要求）：父会话原先只能干等子代理自己汇报，
 * 而它可能不汇报（继续干活去了）—— 明确告诉它"已经唤回、接下来会自己向你汇报"，
 * 它才能既不干等、也不重复派活。
 *
 * 通知是**按父会话汇总的一条**（不是每个子代理一条），并且只在那一批子代理全部试完之后发。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  SUBAGENT_OUTCOME_HEADING,
  buildSubagentOutcomeNotice,
  notifySubagentOutcomesToParent,
  pickOutcomeDelivery,
  subagentOutcomeOf,
} from '../lib/index.js'
import { makeCtx } from './helpers.mjs'

function fakeController(resolve) {
  return {
    calls: [],
    async resolveAgent(sessionId) {
      this.calls.push(sessionId)
      return resolve(sessionId)
    },
  }
}

function makeParent(sessionId, {
  withFollowup = true, withSteer = true, throws = false, status = 'idle', pendingTurn = [],
} = {}) {
  const followups = []
  const steers = []
  const agent = {
    session: { id: sessionId, header: { id: sessionId } },
    status,
    // 宿主的 inbox 是公开属性（`ReactLoopInbox` 实例，`nextTurn` 是 getter）—— 插队判据要读它
    inbox: { nextTurn: pendingTurn },
  }
  if (withFollowup) {
    agent.followup = (message) => {
      if (throws) throw new Error('followup 炸了（测试造的）')
      followups.push(message)
    }
  }
  if (withSteer) {
    agent.steer = (message) => {
      if (throws) throw new Error('steer 炸了（测试造的）')
      steers.push(message)
    }
  }
  return { agent, followups, steers }
}

const item = { sessionId: 'session-child', parentSessionId: 'session-parent', kind: 'subagent', why: ['subagent'] }
const results = [
  { sessionId: 'child-ok', status: 'resumed', reason: '' },
  { sessionId: 'child-bad', status: 'failed', reason: '投递给子代理失败：subagent/not-resumable' },
]

test('pickOutcomeDelivery：在跑且 next-turn 已清空 ⇒ steer 插队；其余一律 followup 排队', () => {
  assert.equal(pickOutcomeDelivery({ status: 'running', steer: () => {}, inbox: { nextTurn: [] } }), 'steer')
  assert.equal(pickOutcomeDelivery({ status: 'running', steer: () => {}, inbox: { nextTurn: [{}] } }), 'followup',
    'next-turn 里还压着消息（续跑注入 / 用户消息 / goal 续轮）⇒ 插队会让结果跑到续跑指令前面')
  assert.equal(pickOutcomeDelivery({ status: 'running', steer: () => {} }), 'followup',
    '读不到 inbox（宿主形态变动）⇒ 顺序正确优先于插队这个优化')
  assert.equal(pickOutcomeDelivery({ status: 'running', steer: () => {}, inbox: {} }), 'followup')
  assert.equal(pickOutcomeDelivery({ status: 'running', inbox: { nextTurn: [] } }), 'followup', '宿主没给 steer 就退回排队')
  assert.equal(pickOutcomeDelivery({ status: 'idle', steer: () => {}, inbox: { nextTurn: [] } }), 'followup',
    '空闲时插队会和还没被取走的续跑注入抢同一步，顺序会颠倒')
  assert.equal(pickOutcomeDelivery({
    status: 'running',
    steer: () => {},
    get inbox() { throw new Error('projection 未注册（测试造的）') },
  }), 'followup', 'inbox getter 抛错也不能抛出去')
  assert.equal(pickOutcomeDelivery(undefined), 'followup', '拿不到 agent 也不能抛')
})

test('subagentOutcomeOf：四种结果各归各的状态，优先级确定', () => {
  assert.equal(subagentOutcomeOf(item, { ok: true, message: '已投递' }).status, 'resumed')
  assert.equal(subagentOutcomeOf(item, { ok: false, message: '父会话不是 live agent' }).status, 'failed')
  assert.equal(subagentOutcomeOf(item, { ok: false, unresumable: true, message: '空会话' }).status, 'unresumable')
  assert.equal(subagentOutcomeOf(item, { ok: false, yield: true, message: '不在列表里' }).status, 'skipped')
  assert.equal(subagentOutcomeOf(item, { ok: true, unresumable: true, yield: true }).status, 'resumed',
    'ok 是最高优先级（真投出去了就是投出去了）')
  assert.equal(subagentOutcomeOf(item, { ok: false, unresumable: true, yield: true }).status, 'unresumable',
    '两个标记同时出现时按"不可恢复"算（更悲观的一侧）')
  assert.equal(subagentOutcomeOf(item, { ok: false, message: '第一行\n第二行' }).reason, '第一行 第二行',
    '原因折叠成单行（多行原因不会把正文撑坏）')
  assert.equal(subagentOutcomeOf(undefined, undefined).status, 'failed', '没给结果也不能抛')
  assert.equal(subagentOutcomeOf(undefined, undefined).sessionId, '')
})

test('buildSubagentOutcomeNotice：成功与失败都逐条列出，标题是常量', () => {
  const text = buildSubagentOutcomeNotice({ parentSessionId: 'session-parent', results: [
    ...results,
    { sessionId: 'child-skip', status: 'skipped', reason: '目标会话不在会话列表里' },
  ] })
  assert.match(text, new RegExp(`^${SUBAGENT_OUTCOME_HEADING}`), '标题是常量，渲染与用例共用同一个字符串')
  assert.match(text, /session-parent/)
  assert.match(text, /✅ `child-ok`：已唤回/)
  assert.match(text, /它接下来会自己向你汇报当前状态/, '成功行要告诉父会话"接下来会发生什么"')
  assert.match(text, /❌ `child-bad`：没能唤回/)
  assert.match(text, /subagent\/not-resumable/)
  assert.match(text, /⏸ `child-skip`：本次没尝试/)
  assert.match(text, /没有上报给你/)
  assert.match(text, /别把它们当成已经完成/)
  assert.match(text, /send_message/)
  assert.doesNotMatch(text, /^【sl 交接续跑】/m, '它是一条通知，不是续跑指令（不能带续跑前缀）')
})

test('buildSubagentOutcomeNotice：可重试与不再重试要说清（父会话据此决定等不等）', () => {
  const text = buildSubagentOutcomeNotice({ parentSessionId: 'p', results: [
    { sessionId: 'child-retry', status: 'failed', reason: '父会话不是 live agent' },
    { sessionId: 'child-dead', status: 'unresumable', reason: '目标会话是空会话（没有任何消息）' },
  ] })
  assert.match(text, /条目留在工作表里，本插件下次启动会再试一次/)
  assert.match(text, /它没有可续的状态，本插件不会再自动重试；要它继续只能你手动派活/,
    '"不再重试"与尾部建议里的 send_message 不能互相打架，要一起说清')
})

test('buildSubagentOutcomeNotice：全部成功 ⇒ 不出现"没能唤回"那一段（别吓人）', () => {
  const text = buildSubagentOutcomeNotice({ parentSessionId: 'p', results: [{ sessionId: 'child-ok', status: 'resumed' }] })
  assert.doesNotMatch(text, /没能唤回的那些/)
  assert.doesNotMatch(text, /下一步建议/)
  assert.match(text, /若迟迟没动静，用 `send_message` 问一下/, '"已唤回"只承诺投递，不承诺它一定会开口')
  assert.match(text, /它挂在你（父会话 `p`）名下/, '单条用"它"')
})

test('buildSubagentOutcomeNotice：缺字段不编造、不抛、条目有上限', () => {
  assert.equal(typeof buildSubagentOutcomeNotice(), 'string', '无参调用也不能抛')
  const empty = buildSubagentOutcomeNotice({})
  assert.doesNotMatch(empty, /undefined/)
  assert.match(empty, new RegExp(`^${SUBAGENT_OUTCOME_HEADING}`))

  const many = buildSubagentOutcomeNotice({
    parentSessionId: 'p',
    results: Array.from({ length: 11 }, (_, index) => ({ sessionId: `child-${index}`, status: 'resumed' })),
  })
  assert.match(many, /还有 3 个子代理没列出/, '逐条列出的上限是 8 条，其余折叠')
  assert.match(many, /它们都挂在你（父会话 `p`）名下/, '多条用"它们都"')

  const ragged = buildSubagentOutcomeNotice({ results: [{}, null, 'x', { sessionId: 'child-ok', status: 'resumed' }] })
  assert.match(ragged, /（宿主没给原因）/)
  assert.match(ragged, /child-ok/)
  assert.doesNotMatch(ragged, /undefined/)
})

test('notifySubagentOutcomesToParent：成功 ⇒ 父会话收到**一条**汇总 user 消息（并 flush）', async () => {
  const parent = makeParent('session-parent')
  const controller = fakeController(() => ({ agent: parent.agent }))
  const logs = []
  const flushes = []
  const { ctx } = makeCtx({ sessions: { flush: async (session) => { flushes.push(session.id) }, get: (id) => ({ id }) } })

  const ok = await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', results, controller)
  assert.equal(ok, true)
  assert.deepEqual(controller.calls, ['session-parent'])
  assert.equal(parent.followups.length, 1, '两个子代理也只发一条（按父会话汇总）')
  assert.equal(parent.followups[0].role, 'user')
  assert.match(parent.followups[0].content[0].text, new RegExp(SUBAGENT_OUTCOME_HEADING))
  assert.match(parent.followups[0].content[0].text, /child-ok/)
  assert.match(parent.followups[0].content[0].text, /child-bad/)
  assert.deepEqual(flushes, ['session-parent'], '投出去之后顺手 flush（按 agent 对象，不查 live store）')
  assert.ok(logs.some((line) => line.includes('子代理接续结果已通知 父会话 session-parent')))
  assert.ok(logs.some((line) => line.includes('followup 排队，下一轮可见')), '父会话空闲 ⇒ 排队（顺序确定）')
})

test('notifySubagentOutcomesToParent：父会话正在跑 ⇒ steer 插队（同轮可见，不再等下一轮）', async () => {
  const parent = makeParent('session-parent', { status: 'running' })
  const controller = fakeController(() => ({ agent: parent.agent }))
  const logs = []
  const { ctx } = makeCtx({ sessions: { flush: async () => {} } })
  const ok = await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', results, controller)
  assert.equal(ok, true)
  assert.equal(parent.steers.length, 1, '插队：进宿主的 next-step 通道')
  assert.equal(parent.followups.length, 0, '不再排进下一轮（用户 2026-10-03：第二条太慢了）')
  assert.equal(parent.steers[0].role, 'user')
  assert.match(parent.steers[0].content[0].text, new RegExp(SUBAGENT_OUTCOME_HEADING))
  assert.ok(logs.some((line) => line.includes('steer 插队，同轮可见')))
})

test('notifySubagentOutcomesToParent：按 agent 对象 flush（刚冷恢复的父查不到 live store）', async () => {
  // 评审 2026-10-03 的 P2 回归：v0.7.2 走 flushLiveSession（先 sessions.get 查 live store），
  // 而刚冷恢复的父会话还没落库 ⇒ 稳定跳过 flush ⇒ 通知再遇一次崩溃就永久丢。
  const parent = makeParent('session-parent', { status: 'running' })
  const controller = fakeController(() => ({ agent: parent.agent }))
  const logs = []
  const flushes = []
  let getCalls = 0
  const { ctx } = makeCtx({ sessions: {
    flush: async (session) => { flushes.push(session.id) },
    get: () => { getCalls += 1; return undefined },
  } })
  const ok = await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', results, controller)
  assert.equal(ok, true)
  assert.deepEqual(flushes, ['session-parent'], '手上有 agent 就直接 flush')
  assert.equal(getCalls, 0, '不该再去查 live store')
})

test('notifySubagentOutcomesToParent：没有父会话 id / 结果为空 ⇒ 不猜收件人，只写日志', async () => {
  const controller = fakeController(() => ({ agent: makeParent('x').agent }))
  const logs = []
  const { ctx } = makeCtx({})
  assert.equal(await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), '', results, controller), false)
  assert.equal(await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', [], controller), false)
  assert.deepEqual(controller.calls, [], '没有收件人就不该去唤醒任何人')
  assert.ok(logs.some((line) => line.includes('没有可通知的人')))
  assert.ok(logs.some((line) => line.includes('没有子代理接续结果')))
})

test('notifySubagentOutcomesToParent：controller 缺席 / 没有 resolveAgent ⇒ false，不抛', async () => {
  const logs = []
  const { ctx } = makeCtx({})
  assert.equal(await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', results, undefined), false)
  assert.equal(await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', results, {}), false)
  assert.ok(logs.some((line) => line.includes('sessionController 服务不可用')))
})

test('notifySubagentOutcomesToParent：resolveAgent 返回 error / 抛错 ⇒ false（下次启动补发）', async () => {
  const logs = []
  const { ctx } = makeCtx({})

  const errored = fakeController(() => ({ error: new Error('会话已删除') }))
  assert.equal(await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', results, errored), false)
  assert.ok(logs.some((line) => line.includes('返回不可恢复')))

  const throwing = fakeController(() => { throw new Error('resolveAgent 炸了') })
  assert.equal(await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', results, throwing), false)
  assert.ok(logs.some((line) => line.includes('resolveAgent 抛错')))
})

test('notifySubagentOutcomesToParent：agent 没有 followup / followup 抛错 ⇒ false，不抛', async () => {
  const logs = []
  const { ctx } = makeCtx({})

  const noFollowup = makeParent('session-parent', { withFollowup: false })
  const controllerA = fakeController(() => ({ agent: noFollowup.agent }))
  assert.equal(await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', results, controllerA), false)
  assert.ok(logs.some((line) => line.includes('没有 followup()')))

  const throwing = makeParent('session-parent', { throws: true })
  const controllerB = fakeController(() => ({ agent: throwing.agent }))
  assert.equal(await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', results, controllerB), false)
  assert.ok(logs.some((line) => line.includes('followup 抛错')))
})

test('notifySubagentOutcomesToParent：steer 抛错 ⇒ false，不抛（插队路径也要 fail-soft）', async () => {
  const parent = makeParent('session-parent', { status: 'running', throws: true })
  const controller = fakeController(() => ({ agent: parent.agent }))
  const logs = []
  const { ctx } = makeCtx({ sessions: { flush: async () => {} } })
  assert.equal(await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', results, controller), false)
  assert.ok(logs.some((line) => line.includes('steer 抛错')))
})

test('notifySubagentOutcomesToParent：唤醒语义 —— 父会话即使不在 live 表里也叫得醒', async () => {
  // resolveAgent 的语义就是"必要时从持久化里冷唤醒"：这里模拟一个"只躺在持久化里"的父会话
  const revived = makeParent('session-parent')
  let liveTable = new Map()
  const controller = {
    async resolveAgent(sessionId) {
      // 冷唤醒：唤醒后它才出现在 live 表里
      liveTable.set(sessionId, revived.agent)
      return { agent: revived.agent }
    },
  }
  const logs = []
  const { ctx } = makeCtx({})
  const ok = await notifySubagentOutcomesToParent(ctx, (m) => logs.push(m), 'session-parent', results, controller)
  assert.equal(ok, true)
  assert.equal(liveTable.has('session-parent'), true, '父会话被冷唤醒')
  assert.equal(revived.followups.length, 1)
})
