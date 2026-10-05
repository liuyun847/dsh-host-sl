/**
 * 实时跟踪器：事件驱动、防抖落盘、以及"恢复流程跑完前不许移除加载来的条目"这条时序保护。
 *
 * 最后一条是这一版最容易踩的坑：跟踪器的事件监听在 apply 时就注册好了，而恢复流程要等
 * bootDelayMs（默认 4s）才跑。一个"上次崩溃时在跑、这次启动被浏览器标签页重新订阅成 idle"
 * 的会话，如果被跟踪器判成"无活"而移除，那次交接就静默丢了。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACTIVE_FILENAME,
  KIND_ROOT,
  KIND_SUBAGENT,
  TABLE_VERSION,
  createTracker,
  enumerateActiveSessions,
  resolveConfig,
  serializeTable,
} from '../lib/index.js'
import { makeCtx, makeScratch, readLog, waitUntil } from './helpers.mjs'

function makeAgent(sessionId, { status = 'idle', origin, parentSession, cwd = 'C:\\work' } = {}) {
  const header = { id: sessionId, cwd }
  if (origin !== undefined) header.origin = origin
  if (parentSession !== undefined) header.parentSession = parentSession
  return { status, session: { id: sessionId, header } }
}

/** 造一个 tracker 环境：agents 表 + 可选的活动回答 + 临时目录。 */
function makeEnv({ agents = [], activityFor = () => [], extraServices = {}, config = {} } = {}) {
  const scratch = makeScratch()
  const resolved = resolveConfig({ storageDir: scratch.dir, debounceMs: 0, sweepMs: 60000, ...config })
  const services = {
    agents: {
      list: () => agents.map((entry) => entry.agent),
      roots: () => agents.filter((entry) => entry.kind === KIND_ROOT).map((entry) => entry.agent),
      get: (id) => agents.find((entry) => entry.sessionId === id)?.agent,
    },
    workspace: {},
    ...extraServices,
  }
  const handle = makeCtx(services, {
    waterfall: async (event, payload, fallback) => (event === 'workspace/session-activity'
      ? activityFor(payload?.sessionId)
      : fallback()),
  })
  const logs = []
  const tracker = createTracker(handle.ctx, resolved, (message) => logs.push(message), () => false)
  return {
    scratch,
    resolved,
    handle,
    logs,
    tracker,
    agents,
    /** 按会话 id 走一遍"事件驱动"的那条重算路径。 */
    async refresh(sessionId) {
      const live = enumerateActiveSessions(handle.ctx)
      const item = live.items.find((entry) => entry.sessionId === sessionId)
      if (item === undefined) throw new Error(`会话 ${sessionId} 不在 live 表里（测试夹具问题）`)
      return await tracker.refresh(item.sessionId, item.agent, item.kind, item.parentSessionId, item.session, live)
    },
    cleanup() {
      tracker.dispose()
      scratch.cleanup()
    },
  }
}

test('load：新鲜表加载进内存（顶层/子代理分开计数）', () => {
  const env = makeEnv()
  try {
    writeFileSync(env.resolved.activeFile, serializeTable([
      { sessionId: 'session-root', kind: KIND_ROOT, why: ['turn'], updatedAt: Date.now() },
      { sessionId: 'session-child', kind: KIND_SUBAGENT, parentSessionId: 'session-root', why: ['subagent'], updatedAt: Date.now() },
    ], Date.now()))

    const loaded = env.tracker.load()
    assert.equal(loaded.kind, 'fresh')
    assert.equal(loaded.count, 2)
    assert.deepEqual(env.tracker.snapshot().map((item) => item.sessionId), ['session-root', 'session-child'])
    assert.ok(env.logs.some((line) => line.includes('2 条待唤醒（顶层 1 / 子代理 1')))
  } finally {
    env.cleanup()
  }
})

test('load：没有文件 / 坏 JSON / 陈旧表都不加载（且旧文件保留不动）', () => {
  const missing = makeEnv()
  try {
    assert.equal(missing.tracker.load().kind, 'absent')
    assert.deepEqual(missing.tracker.snapshot(), [])
  } finally {
    missing.cleanup()
  }

  const broken = makeEnv()
  try {
    writeFileSync(broken.resolved.activeFile, '{ 坏 JSON')
    assert.equal(broken.tracker.load().kind, 'unreadable')
    assert.ok(existsSync(broken.resolved.activeFile), '读不出也不删旧文件（留着排障）')
  } finally {
    broken.cleanup()
  }

  const stale = makeEnv()
  try {
    writeFileSync(stale.resolved.activeFile, serializeTable([
      { sessionId: 'session-old', kind: KIND_ROOT, why: ['turn'], updatedAt: Date.now() - 48 * 3600 * 1000 },
    ], Date.now() - 48 * 3600 * 1000))
    assert.equal(stale.tracker.load().kind, 'stale')
    assert.deepEqual(stale.tracker.snapshot(), [], '陈旧表不消费（几周前的活唤醒它没有意义）')
    assert.ok(existsSync(stale.resolved.activeFile))
  } finally {
    stale.cleanup()
  }
})

test('refresh：有活 ⇒ 写入工作表并落盘（含 why / activity / title / cwd）', async () => {
  const agent = makeAgent('session-root', { status: 'running' })
  const env = makeEnv({
    agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }],
    activityFor: () => [{ kind: 'turn' }, { kind: 'job', items: [{ id: 'bash-3', label: 'pwsh …' }] }],
    extraServices: { sessionTitle: { get: () => ({ title: '写测试' }) } },
  })
  try {
    const entry = await env.refresh('session-root')
    assert.equal(entry.sessionId, 'session-root')
    assert.deepEqual(entry.why, ['turn', 'job'])
    assert.equal(entry.title, '写测试')
    assert.equal(entry.cwd, 'C:\\work')
    assert.deepEqual(entry.activity, [{ kind: 'turn' }, { kind: 'job', items: [{ id: 'bash-3', label: 'pwsh …' }] }])

    assert.ok(existsSync(env.resolved.activeFile), 'debounceMs=0 ⇒ 立即落盘')
    const written = JSON.parse(readLog(env.resolved.activeFile))
    assert.equal(written.version, TABLE_VERSION)
    assert.equal(written.items.length, 1)
    assert.deepEqual(written.items[0].why, ['turn', 'job'])
    assert.ok(env.logs.some((line) => line.includes('有在飞的活（turn+job）')))
  } finally {
    env.cleanup()
  }
})

test('refresh：无活 ⇒ 从工作表移除（恢复流程跑完之后）', async () => {
  const agent = makeAgent('session-root', { status: 'idle' })
  const env = makeEnv({ agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }], activityFor: () => [] })
  try {
    await env.refresh('session-root')
    assert.deepEqual(env.tracker.snapshot(), [], '没有活动 ⇒ 不写入')
    assert.ok(!existsSync(env.resolved.activeFile), '表空 ⇒ 文件不存在')

    // 先让它有活，再让它没活 —— 第二次应当移除
    env.handle.ctx.waterfall = async (event, payload, fallback) => (event === 'workspace/session-activity' ? [{ kind: 'turn' }] : fallback())
    await env.refresh('session-root')
    assert.equal(env.tracker.snapshot().length, 1)

    env.handle.ctx.waterfall = async (event, payload, fallback) => (event === 'workspace/session-activity' ? [] : fallback())
    env.tracker.markResumeDone()
    await env.refresh('session-root')
    assert.deepEqual(env.tracker.snapshot(), [], '恢复跑完后，无活就该移除')
    assert.ok(env.logs.some((line) => line.includes('已无在飞的活 ⇒ 从工作表移除')))
    assert.ok(!existsSync(env.resolved.activeFile))
  } finally {
    env.cleanup()
  }
})

test('refresh：**恢复流程跑完前**，从磁盘加载的条目只刷新不移除（时序保护）', async () => {
  const agent = makeAgent('session-root', { status: 'idle' })
  const env = makeEnv({ agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }], activityFor: () => [] })
  try {
    writeFileSync(env.resolved.activeFile, serializeTable([
      { sessionId: 'session-root', kind: KIND_ROOT, why: ['turn'], updatedAt: Date.now() },
    ], Date.now()))
    env.tracker.load()
    assert.equal(env.tracker.snapshot().length, 1)

    // 场景：上次崩溃时它在跑，这次启动被标签页重新订阅成 idle —— 跟踪器此刻判它"无活"
    await env.refresh('session-root')
    assert.equal(env.tracker.snapshot().length, 1,
      '恢复流程还没读表，这条必须留着 —— 否则那次交接静默丢失')

    // 恢复流程跑完后，同样的判定就该移除它（它确实没活了）
    env.tracker.markResumeDone()
    await env.refresh('session-root')
    assert.deepEqual(env.tracker.snapshot(), [])
  } finally {
    env.cleanup()
  }
})

test('事件驱动：agent/status 触发重算（含子代理），dispose 后不再触发', async () => {
  const root = makeAgent('session-root', { status: 'idle' })
  const child = makeAgent('session-child', { status: 'running', origin: 'subagent', parentSession: 'session-root' })
  const env = makeEnv({
    agents: [
      { sessionId: 'session-root', agent: root, kind: KIND_ROOT },
      { sessionId: 'session-child', agent: child, kind: KIND_SUBAGENT, parentSessionId: 'session-root' },
    ],
    activityFor: (sessionId) => (sessionId === 'session-root' ? [{ kind: 'subagent', items: [{ id: 'session-child' }] }] : []),
  })
  try {
    env.handle.fire('agent/status', { agent: root, status: 'idle' })
    await waitUntil(() => env.tracker.snapshot().length === 1, { label: 'agent/status 触发重算' })
    assert.deepEqual(env.tracker.snapshot()[0].why, ['subagent'])
    assert.ok(env.logs.some((line) => line.includes('会话状态监听 已注册')))

    // 撤销订阅后，同一个事件不该再产生任何影响
    env.tracker.dispose()
    const before = env.tracker.snapshot().length
    env.handle.fire('agent/status', { agent: child, status: 'running' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(env.tracker.snapshot().length, before)
  } finally {
    env.cleanup()
  }
})

test('remove：唤醒成功后清理并立即落盘（不留防抖窗口）', async () => {
  const agent = makeAgent('session-root', { status: 'running' })
  const env = makeEnv({
    agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }],
    activityFor: () => [{ kind: 'turn' }],
  })
  try {
    await env.refresh('session-root')
    assert.equal(env.tracker.snapshot().length, 1)
    assert.ok(existsSync(env.resolved.activeFile))

    assert.equal(env.tracker.remove('session-root'), true)
    assert.deepEqual(env.tracker.snapshot(), [])
    assert.ok(!existsSync(env.resolved.activeFile), '移除后立即落盘 ⇒ 表空 ⇒ 文件被删')

    assert.equal(env.tracker.remove('session-root'), false, '重复移除返回 false，不抛')
  } finally {
    env.cleanup()
  }
})

test('summary：形状与 v0.6.0 的 pendingSummary 一致（消费者零改动）', async () => {
  const agent = makeAgent('session-root', { status: 'running' })
  const env = makeEnv({ agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }], activityFor: () => [{ kind: 'turn' }] })
  try {
    assert.deepEqual(env.tracker.summary(), { exists: false, reason: env.tracker.summary().reason, items: [] })
    assert.match(env.tracker.summary().reason, /没有待唤醒的会话/)

    await env.refresh('session-root')
    const summary = env.tracker.summary()
    assert.equal(summary.exists, true)
    assert.equal(summary.items.length, 1)
    assert.deepEqual(summary.items[0], {
      sessionId: 'session-root',
      kind: KIND_ROOT,
      done: false,
      active: true,
      wake: true,
    })
  } finally {
    env.cleanup()
  }
})

test('refreshAll：只刷新 live 表里的会话，**不碰**不在表里的条目', async () => {
  const agent = makeAgent('session-live', { status: 'running' })
  const env = makeEnv({ agents: [{ sessionId: 'session-live', agent, kind: KIND_ROOT }], activityFor: () => [{ kind: 'turn' }] })
  try {
    // 表里有一条"上次崩溃留下的、这次没被打开"的会话
    writeFileSync(env.resolved.activeFile, serializeTable([
      { sessionId: 'session-ghost', kind: KIND_ROOT, why: ['turn'], updatedAt: Date.now() },
    ], Date.now()))
    env.tracker.load()

    const result = await env.tracker.refreshAll()
    assert.equal(result.scanned, 1, '只扫了 live 表里那一个')
    assert.deepEqual(env.tracker.snapshot().map((item) => item.sessionId).sort(), ['session-ghost', 'session-live'],
      '"不在 live 表里"的条目必须保留 —— 它是恢复流程的输入')
  } finally {
    env.cleanup()
  }
})

test('作业事件订阅：注册失败只降级（靠周期兜底），不影响其它事件源', () => {
  const env = makeEnv({ extraServices: { jobs: {} } })
  try {
    assert.ok(env.logs.some((line) => line.includes('作业事件订阅不可用')), 'jobs 没有 events ⇒ 如实写日志')
    assert.ok(env.logs.some((line) => line.includes('会话状态监听 已注册')), '其它事件源照常注册')
  } finally {
    env.cleanup()
  }

  const withJobs = makeEnv({ extraServices: { jobs: { events: { subscribe: () => () => {} } } } })
  try {
    assert.ok(withJobs.logs.some((line) => line.includes('作业事件订阅已注册')))
  } finally {
    withJobs.cleanup()
  }
})

test('作业事件：按 owner 触发重算（别人的作业不触发）', async () => {
  const agent = makeAgent('session-root', { status: 'idle' })
  const subscribers = []
  const env = makeEnv({
    agents: [{ sessionId: 'session-root', agent, kind: KIND_ROOT }],
    activityFor: () => [{ kind: 'job', items: [{ id: 'bash-1' }] }],
    extraServices: { jobs: { events: { subscribe: (filter, listener) => { subscribers.push({ filter, listener }); return () => {} } } } },
  })
  try {
    assert.equal(subscribers.length, 1)
    assert.deepEqual(subscribers[0].filter, { owners: 'all' }, '要听全部 owner（否则别人的作业变化会漏）')

    subscribers[0].listener({ type: 'registered', job: { id: 'bash-1', owner: 'session-other' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(env.tracker.snapshot(), [], '别人的作业不触发本会话的重算')

    subscribers[0].listener({ type: 'registered', job: { id: 'bash-2', owner: 'session-root' } })
    await waitUntil(() => env.tracker.snapshot().length === 1, { label: '作业事件触发重算' })
    assert.deepEqual(env.tracker.snapshot()[0].why, ['job'])
  } finally {
    env.cleanup()
  }
})

test('goal 事件：按 sessionId 触发重算', async () => {
  const agent = makeAgent('session-goal', { status: 'idle' })
  const env = makeEnv({
    agents: [{ sessionId: 'session-goal', agent, kind: KIND_ROOT }],
    activityFor: () => [],
    extraServices: { goals: { get: () => ({ phase: 'active', activation: 'armed' }) } },
  })
  try {
    env.handle.fire('goal/activation-changed', { sessionId: 'session-goal' })
    await waitUntil(() => env.tracker.snapshot().length === 1, { label: 'goal 事件触发重算' })
    assert.deepEqual(env.tracker.snapshot()[0].why, ['goal'])

    env.handle.fire('goal/activation-changed', { sessionId: '' })
    env.handle.fire('goal/activation-changed', {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(env.tracker.snapshot().length, 1, '空 sessionId 不该引发任何变化')
  } finally {
    env.cleanup()
  }
})
