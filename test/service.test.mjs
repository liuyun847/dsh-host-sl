/**
 * 对外服务 `slHandoff`：**同名同形兼容**本机 `dsh-host-restart`。
 *
 * 那个包在杀进程前调 `saveAll({all:true, note, noteSessionId, session})`，然后这样用返回值：
 *   `result.items.filter(item => item.ok === true && typeof item.file === 'string').map(item => item.file)`
 *   `if (result.ok === true) { ... }` / 失败时读 `result.message`
 * （`~\.dsh\profiles\web\plugins\dsh-host-restart\lib\index.js:938-951`）。
 * 所以"items 里必须有 file、ok 必须是布尔、message 必须在失败时给裸原因"这三条是硬契约。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { KIND_ROOT, KIND_SUBAGENT, SERVICE_NAME, createHandoffService, resolveConfig } from '../lib/index.js'
import { makeCtx } from './helpers.mjs'

function fakeTracker({ items = [], flushResult = true, throwOnFlush = false, throwOnSummary = false } = {}) {
  let list = [...items]
  return {
    flushed: 0,
    refreshed: 0,
    snapshot: () => list,
    flush() {
      this.flushed += 1
      if (throwOnFlush) throw new Error('写盘炸了（测试造的）')
      return flushResult
    },
    async refreshAll() { this.refreshed += 1 },
    summary() {
      if (throwOnSummary) throw new Error('摘要炸了（测试造的）')
      return {
        exists: list.length > 0,
        ...list.length > 0 ? {} : { reason: '工作表里没有待唤醒的会话' },
        items: list.map((item) => ({ sessionId: item.sessionId, kind: item.kind, done: false, active: true, wake: true })),
      }
    },
    markResumeDone: () => {},
    dispose: () => {},
  }
}

function makeService(tracker, config = {}) {
  const resolved = resolveConfig({ storageDir: 'C:\\fake', ...config })
  const logs = []
  const { ctx } = makeCtx({})
  return { service: createHandoffService(ctx, resolved, (m) => logs.push(m), tracker), resolved, logs }
}

test('saveAll：形状与 v0.6.0 兼容 —— ok 是布尔、items[].file 给路径、message 可展示', async () => {
  const tracker = fakeTracker({
    items: [
      { sessionId: 'session-a', kind: KIND_ROOT, parentSessionId: '', cwd: 'C:\\w', title: 'A', why: ['turn'] },
      { sessionId: 'session-b', kind: KIND_SUBAGENT, parentSessionId: 'session-a', cwd: 'C:\\w', title: 'B', why: ['subagent'] },
    ],
  })
  const { service, resolved } = makeService(tracker)
  const result = service.saveAll({ all: true, note: '继续做 X', noteSessionId: 'session-a' })

  assert.equal(result.ok, true)
  assert.equal(result.saved, 2)
  assert.equal(result.failed, 0)
  assert.equal(typeof result.createdAt, 'number')
  assert.equal(result.activeFile, resolved.activeFile)
  assert.equal(result.items.length, 2)
  assert.ok(result.items.every((item) => item.ok === true && item.file === resolved.activeFile),
    '每个条目都要带 file —— 消费者靠它拼"存到哪了"的文案')
  assert.match(result.message, /活跃工作表已提交：2 个会话/)

  // 复现消费者的取路径方式
  const files = result.items.filter((item) => item?.ok === true && typeof item.file === 'string' && item.file.length > 0).map((item) => item.file)
  assert.deepEqual(files, [resolved.activeFile, resolved.activeFile])
  assert.equal(tracker.flushed >= 1, true, 'saveAll 必须落盘（重启前的最后一次一致性提交）')
})

test('saveAll：忽略 note / noteSessionId / session 参数（v0.7.0 不再写"下一步说明"）', async () => {
  const tracker = fakeTracker({ items: [{ sessionId: 'session-a', kind: KIND_ROOT, why: ['turn'] }] })
  const { service } = makeService(tracker)
  for (const args of [[], [undefined], [{ all: true, note: 'x', noteSessionId: 'session-a', session: { id: 'session-a' } }], ['裸说明']]) {
    const result = service.saveAll(...args)
    assert.equal(result.ok, true, `参数 ${JSON.stringify(args)} 下也必须成功`)
  }
  assert.equal(tracker.refreshed >= 4, true, '每次调用都触发一次异步重算')
})

test('saveAll：写盘失败 ⇒ ok:false + 可读原因（消费者据此写自己的语境）', () => {
  const tracker = fakeTracker({ items: [{ sessionId: 'session-a', kind: KIND_ROOT, why: ['turn'] }], flushResult: false })
  const { service, resolved } = makeService(tracker)
  const result = service.saveAll()
  assert.equal(result.ok, false)
  assert.match(result.message, /写盘失败/)
  assert.match(result.message, new RegExp(resolved.activeFile.replace(/\\/g, '\\\\')))
})

test('saveAll：内部抛错也**从不抛**（折成 ok:false + 原因）', () => {
  const tracker = fakeTracker({ throwOnFlush: true })
  const { service, logs } = makeService(tracker)
  const result = service.saveAll()
  assert.equal(result.ok, false)
  assert.match(result.message, /写盘炸了/)
  assert.ok(logs.some((line) => line.includes('saveAll 抛错')))
})

test('pendingSummary：五字段形状与 v0.6.0 逐字段一致（消费者零改动）', () => {
  const tracker = fakeTracker({ items: [{ sessionId: 'session-a', kind: KIND_ROOT, why: ['turn'] }] })
  const { service } = makeService(tracker)
  const summary = service.pendingSummary()
  assert.equal(summary.exists, true)
  assert.deepEqual(summary.items, [{ sessionId: 'session-a', kind: KIND_ROOT, done: false, active: true, wake: true }])
})

test('pendingSummary：空表 ⇒ exists:false + 原因；内部抛错也从不抛', () => {
  const empty = makeService(fakeTracker())
  const summary = empty.service.pendingSummary()
  assert.equal(summary.exists, false)
  assert.equal(summary.items.length, 0)
  assert.equal(typeof summary.reason, 'string')

  const throwing = makeService(fakeTracker({ throwOnSummary: true }))
  const fallback = throwing.service.pendingSummary()
  assert.equal(fallback.exists, false)
  assert.match(fallback.reason, /读工作表摘要失败/)
})

test('服务对象是冻结的，且提供名字就是 slHandoff', () => {
  const { service } = makeService(fakeTracker())
  assert.ok(Object.isFrozen(service))
  assert.equal(SERVICE_NAME, 'slHandoff')
  assert.equal(typeof service.saveAll, 'function')
  assert.equal(typeof service.pendingSummary, 'function')
  assert.equal(service.save, undefined, 'v0.6.0 的 save() 已删除（新模型下"保存谁"由活动状态决定）')
})

test('服务可以真的被 ctx.provide 登记并读回（cordis 语义）', () => {
  const { ctx, provided } = makeCtx({})
  const tracker = fakeTracker()
  const resolved = resolveConfig({ storageDir: 'C:\\fake' })
  ctx.provide(SERVICE_NAME, createHandoffService(ctx, resolved, () => {}, tracker))
  assert.ok(provided.has(SERVICE_NAME))
  assert.equal(typeof ctx.get(SERVICE_NAME).saveAll, 'function')
})
