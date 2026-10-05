/**
 * 活动判据：宿主活动（`workspace/session-activity`）与自建判据的**并集** + goal。
 *
 * 这里是 v0.7.0 的判据核心：表里该不该有某个会话，全看这一层的回答。
 * 三条最容易写错的地方各有用例钉住：
 *   ① 宿主活动的提供方是**逐个可选**的，"少一类"与"那一类没有活"同形 ⇒ 必须与自建判据取并集；
 *   ② `goal` 不在宿主的 `SessionActivityKindMap` 里，必须单独查；
 *   ③ 判不了的时候一律往"有活"倒（宁可多唤醒一次，也不丢掉在飞的活）。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  ACTIVITY_EVENT,
  KIND_ROOT,
  KIND_SUBAGENT,
  enumerateActiveSessions,
  hasActiveArmedGoal,
  probeSessionWork,
  querySessionActivity,
  runningJobCount,
} from '../lib/index.js'
import { makeCtx } from './helpers.mjs'

function makeAgent(sessionId, { status = 'idle', origin, parentSession, cwd = 'C:\\work' } = {}) {
  const header = { id: sessionId, cwd }
  if (origin !== undefined) header.origin = origin
  if (parentSession !== undefined) header.parentSession = parentSession
  const session = { id: sessionId, header }
  return { status, session, followups: [], followup(message) { this.followups.push(message) } }
}

/** 造一个 ctx：agents 表 + 可选的活动回答（不传 waterfall 就模拟"宿主活动查询不可用"）。 */
function makeActivityCtx({ agents = [], activityFor = () => [], extraServices = {}, withWaterfall = true } = {}) {
  const services = {
    agents: {
      list: () => agents.map((entry) => entry.agent),
      roots: () => agents.filter((entry) => entry.kind === KIND_ROOT).map((entry) => entry.agent),
      get: (id) => agents.find((entry) => entry.sessionId === id)?.agent,
    },
    ...extraServices,
  }
  const handle = makeCtx(services, withWaterfall
    ? {
        waterfall: async (event, payload, fallback) => {
          if (event !== ACTIVITY_EVENT) return fallback()
          return activityFor(payload?.sessionId)
        },
      }
    : {})
  return { ...handle, services, agents }
}

test('querySessionActivity：waterfall 返回活动 ⇒ ok:true + items 原样带回', async () => {
  const { ctx } = makeActivityCtx({ activityFor: () => [{ kind: 'turn' }] })
  const result = await querySessionActivity(ctx, 'session-a')
  assert.equal(result.ok, true)
  assert.deepEqual(result.items, [{ kind: 'turn' }])
})

test('querySessionActivity：返回空数组也是 ok:true（"这一路没人报活"是合法答案）', async () => {
  const { ctx } = makeActivityCtx({ activityFor: () => [] })
  const result = await querySessionActivity(ctx, 'session-a')
  assert.equal(result.ok, true)
  assert.deepEqual(result.items, [])
})

test('querySessionActivity：waterfall 不可用 / 抛错 / 形态不符 ⇒ ok:false（且绝不表示"没有活"）', async () => {
  const noWaterfall = makeActivityCtx({ withWaterfall: false })
  const missing = await querySessionActivity(noWaterfall.ctx, 's')
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /waterfall 不可用/)

  const throwing = makeActivityCtx({})
  throwing.ctx.waterfall = async () => { throw new Error('宿主炸了（测试造的）') }
  const thrown = await querySessionActivity(throwing.ctx, 's')
  assert.equal(thrown.ok, false)
  assert.match(thrown.reason, /抛错/)

  const bad = makeActivityCtx({ activityFor: () => 'not-an-array' })
  const malformed = await querySessionActivity(bad.ctx, 's')
  assert.equal(malformed.ok, false)
  assert.match(malformed.reason, /形态不符/)
})

test('probeSessionWork：宿主活动翻译成 why，顺序固定、去重（含 schedule）', async () => {
  const agent = makeAgent('session-root')
  const agents = [{ sessionId: 'session-root', agent, kind: KIND_ROOT }]
  const { ctx } = makeActivityCtx({
    agents,
    activityFor: () => [
      { kind: 'job', items: [{ id: 'bash-3', label: 'pwsh -Command …' }] },
      { kind: 'turn' },
      { kind: 'job', items: [{ id: 'bash-4' }] },
      { kind: 'schedule', items: [{ id: 'sch-1' }] },
    ],
  })
  const probed = await probeSessionWork(ctx, () => {}, 'session-root', agent, enumerateActiveSessions(ctx))
  assert.equal(probed.active, true)
  assert.deepEqual(probed.why, ['turn', 'job', 'schedule'], '按 ACTIVE_WHY_ORDER 排、同类只记一次')
  assert.equal(probed.goal, false)
  assert.equal(probed.activity.length, 4, '原始活动项原样带进工作表（断点信息）')
})

test('probeSessionWork：**并集** —— 宿主说没活、自建判据发现作业在跑 ⇒ 必须有活', async () => {
  const agent = makeAgent('session-root', { status: 'idle' })
  const agents = [{ sessionId: 'session-root', agent, kind: KIND_ROOT }]
  const jobs = { list: () => [{ id: 'bash-1', owner: 'session-root', status: 'running' }] }
  const { ctx } = makeActivityCtx({ agents, activityFor: () => [], extraServices: { jobs } })
  const probed = await probeSessionWork(ctx, () => {}, 'session-root', agent, enumerateActiveSessions(ctx))
  assert.equal(probed.active, true, '宿主活动只覆盖"提供方在场"的那几类 —— 少了 job 那一类不能当成"没有作业"')
  assert.deepEqual(probed.why, ['job'])
})

test('probeSessionWork：宿主活动查询不可用 ⇒ 只靠自建判据（不抛、不漏）', async () => {
  const agent = makeAgent('session-root', { status: 'running' })
  const agents = [{ sessionId: 'session-root', agent, kind: KIND_ROOT }]
  const handle = makeActivityCtx({ agents, withWaterfall: false })
  const logs = []
  const probed = await probeSessionWork(handle.ctx, (m) => logs.push(m), 'session-root', agent, enumerateActiveSessions(handle.ctx))
  assert.equal(probed.active, true)
  assert.deepEqual(probed.why, ['turn'], '自建判据把"自己在跑"记成 turn（与宿主活动同名）')
  assert.ok(logs.some((line) => line.includes('宿主活动查询不可用')), '降级要留一行日志')
})

test('probeSessionWork：两路都没活 ⇒ 无活（空表条目的来源）', async () => {
  const agent = makeAgent('session-root')
  const agents = [{ sessionId: 'session-root', agent, kind: KIND_ROOT }]
  const { ctx } = makeActivityCtx({ agents, activityFor: () => [] })
  const probed = await probeSessionWork(ctx, () => {}, 'session-root', agent, enumerateActiveSessions(ctx))
  assert.equal(probed.active, false)
  assert.deepEqual(probed.why, [])
})

test('probeSessionWork（自建判据）：名下子代理在跑（任意深度）也算有活', async () => {
  const root = makeAgent('session-root')
  const child = makeAgent('session-child', { status: 'running', origin: 'subagent', parentSession: 'session-root' })
  const grand = makeAgent('session-grand', { status: 'running', origin: 'subagent', parentSession: 'session-child' })
  const agents = [
    { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
    { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    { sessionId: 'session-grand', agent: grand, kind: KIND_SUBAGENT, parentSessionId: 'session-child' },
  ]
  const handle = makeActivityCtx({ agents, activityFor: () => [] })
  const probed = await probeSessionWork(handle.ctx, () => {}, 'session-root', root, enumerateActiveSessions(handle.ctx))
  assert.equal(probed.active, true)
  assert.deepEqual(probed.why, ['subagent'])
})

test('probeSessionWork：goal 单独查（宿主活动体系里没有 goal 这一类）', async () => {
  const agent = makeAgent('session-root')
  const agents = [{ sessionId: 'session-root', agent, kind: KIND_ROOT }]
  const goals = { get: (a) => (a === agent ? { phase: 'active', activation: 'armed' } : undefined) }
  const { ctx } = makeActivityCtx({ agents, activityFor: () => [], extraServices: { goals } })
  const probed = await probeSessionWork(ctx, () => {}, 'session-root', agent, enumerateActiveSessions(ctx))
  assert.equal(probed.active, true, 'armed goal 由 driver 自动续轮，重启打断它就是断了一条在飞的链')
  assert.deepEqual(probed.why, ['goal'])
  assert.equal(probed.goal, true)
})

test('probeSessionWork：agents 表不可用 ⇒ 保守按"有活"处理（宁可多唤醒一次）', async () => {
  const { ctx } = makeActivityCtx({})
  const logs = []
  const probed = await probeSessionWork(ctx, (m) => logs.push(m), 'session-root', undefined, {
    available: false,
    reason: 'agents 服务没有 list()',
    items: [],
  })
  assert.equal(probed.active, true)
  assert.equal(probed.undecidable, 'agents 服务没有 list()')
  assert.ok(logs.some((line) => line.includes('按"有活"处理')))
})

test('probeSessionWork：单条判据失败不该把整次判定变成"有活"', async () => {
  const agent = makeAgent('session-root')
  const handle = makeActivityCtx({ agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }] })
  handle.ctx.waterfall = async () => { throw new Error('boom') }
  const probed = await probeSessionWork(handle.ctx, () => {}, 'session-root', agent, enumerateActiveSessions(handle.ctx))
  assert.equal(probed.active, false, '宿主活动抛错只降级到自建判据；会话确实空闲 ⇒ 无活')
})

test('runningJobCount：只认 running/stopping，且 owner 必须精确匹配', () => {
  const jobs = {
    list: () => [
      { id: 'bash-1', owner: 'session-root', status: 'running' },
      { id: 'bash-2', owner: 'session-other', status: 'running' },
      { id: 'bash-3', owner: undefined, status: 'running' },
      { id: 'bash-4', owner: 'session-root', status: 'completed' },
      { id: 'bash-5', owner: 'session-root', status: 'stopping' },
    ],
  }
  const { ctx } = makeActivityCtx({ extraServices: { jobs } })
  assert.equal(runningJobCount(ctx, 'session-root'), 2, '无主作业与已结算的都不算')

  const missing = makeActivityCtx({})
  assert.equal(runningJobCount(missing.ctx, 'session-root'), 0)

  const throwing = makeActivityCtx({ extraServices: { jobs: { list: () => { throw new Error('炸了') } } } })
  assert.equal(runningJobCount(throwing.ctx, 'session-root'), 0)
})

test('hasActiveArmedGoal：只认 active + armed；服务缺席/抛错 ⇒ false（只影响这一条判据）', () => {
  const agent = makeAgent('session-root')
  const logs = []

  const withGoal = makeCtx({ goals: { get: () => ({ phase: 'active', activation: 'armed' }) } })
  assert.equal(hasActiveArmedGoal(withGoal.ctx, (m) => logs.push(m), agent, 'session-root'), true)

  const paused = makeCtx({ goals: { get: () => ({ phase: 'paused', activation: 'armed' }) } })
  assert.equal(hasActiveArmedGoal(paused.ctx, () => {}, agent, 'session-root'), false)

  const disarmed = makeCtx({ goals: { get: () => ({ phase: 'active', activation: 'disarmed' }) } })
  assert.equal(hasActiveArmedGoal(disarmed.ctx, () => {}, agent, 'session-root'), false)

  const missing = makeCtx({})
  assert.equal(hasActiveArmedGoal(missing.ctx, (m) => logs.push(m), agent, 'session-root'), false)
  assert.ok(logs.some((line) => line.includes('goals 服务不可用')))

  const throwing = makeCtx({ goals: { get: () => { throw new Error('goal 炸了') } } })
  assert.equal(hasActiveArmedGoal(throwing.ctx, (m) => logs.push(m), agent, 'session-root'), false)
  assert.ok(logs.some((line) => line.includes('读会话 session-root 的 goal 失败')))

  assert.equal(hasActiveArmedGoal(missing.ctx, () => {}, null, 'session-root'), false, 'agent 形态不符 ⇒ false，不抛')
})

test('enumerateActiveSessions：顶层 + 子代理、kind/parentSessionId 正确', () => {
  const root = makeAgent('session-root')
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const orphan = makeAgent('session-orphan', { origin: 'subagent' })
  const { ctx } = makeActivityCtx({
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
      { sessionId: 'session-orphan', agent: orphan, kind: KIND_SUBAGENT, parentSessionId: '' },
    ],
  })
  const live = enumerateActiveSessions(ctx)
  assert.equal(live.available, true)
  assert.deepEqual(live.items.map((entry) => entry.sessionId), ['session-root', 'session-child'],
    '缺 parentSession 的子代理跳过（投递要靠它，留着只会每次失败）')
  assert.equal(live.items[1].kind, KIND_SUBAGENT)
  assert.equal(live.items[1].parentSessionId, 'session-root')
})

test('enumerateActiveSessions：服务缺失 / 抛错 / 形态不符 ⇒ fail-soft', () => {
  const missing = makeCtx({})
  assert.equal(enumerateActiveSessions(missing.ctx).available, false)
  assert.match(enumerateActiveSessions(missing.ctx).reason, /没有 list\(\)/)

  const throwing = makeCtx({ agents: { list: () => { throw new Error('list 炸了') } } })
  assert.equal(enumerateActiveSessions(throwing.ctx).available, false)

  const bad = makeCtx({ agents: { list: () => 'nope' } })
  assert.equal(enumerateActiveSessions(bad.ctx).available, false)
  assert.match(enumerateActiveSessions(bad.ctx).reason, /不是数组/)
})
