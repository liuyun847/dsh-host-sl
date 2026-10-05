/**
 * 活跃工作表：形状、新鲜度、读写、摘要、配置。
 *
 * 这是 v0.7.0 唯一的状态文件 —— 崩溃后恢复流程的全部输入都来自它，所以"坏形状怎么处理"
 * 与"哪些状态合法"必须钉死。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACTIVE_FILENAME,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_STALE_MS,
  DEFAULT_SWEEP_MS,
  KIND_ROOT,
  KIND_SUBAGENT,
  TABLE_VERSION,
  classifyTable,
  normalizeTable,
  oneLine,
  readTableFile,
  resolveConfig,
  serializeTable,
  sessionPrefix,
  summarizeTable,
} from '../lib/index.js'
import { makeScratch } from './helpers.mjs'

function makeEntry(overrides = {}) {
  return {
    sessionId: 'session-aaaa1111-1111-1111-1111-111111111111',
    kind: KIND_ROOT,
    parentSessionId: '',
    title: '测试会话',
    cwd: 'C:\\work',
    why: ['turn'],
    goal: false,
    activity: [{ kind: 'turn' }],
    since: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

test('normalizeTable：合法表原样读入，可选字段缺了就补默认', () => {
  const raw = { version: TABLE_VERSION, updatedAt: 5000, items: [{ sessionId: 'session-x' }] }
  const table = normalizeTable(raw)
  assert.ok(table)
  assert.equal(table.updatedAt, 5000)
  assert.equal(table.items.length, 1)
  const [item] = table.items
  assert.equal(item.sessionId, 'session-x')
  assert.equal(item.kind, KIND_ROOT, 'kind 缺失按顶层处理（安全侧：绝不当成子代理）')
  assert.equal(item.parentSessionId, '')
  assert.equal(item.title, '')
  assert.equal(item.cwd, '')
  assert.deepEqual(item.why, [])
  assert.equal(item.goal, false)
  assert.deepEqual(item.activity, [])
  assert.equal(item.since, 5000, 'since 缺失时退到表的 updatedAt')
  assert.equal(item.updatedAt, 5000)
})

test('normalizeTable：空 items 是**合法**状态（表存在但没人在跑）', () => {
  const table = normalizeTable({ version: TABLE_VERSION, updatedAt: 1, items: [] })
  assert.ok(table, '空表不能被当成坏形状 —— 那会让"没人有活"变成"读不出"')
  assert.deepEqual(table.items, [])
})

test('normalizeTable：坏形状一律 undefined（缺 updatedAt / items 非数组 / 顶层不是对象）', () => {
  assert.equal(normalizeTable(null), undefined)
  assert.equal(normalizeTable([]), undefined)
  assert.equal(normalizeTable('x'), undefined)
  assert.equal(normalizeTable({ items: [] }), undefined, '缺 updatedAt')
  assert.equal(normalizeTable({ updatedAt: 1 }), undefined, '缺 items')
  assert.equal(normalizeTable({ updatedAt: 1, items: 'x' }), undefined)
  assert.equal(normalizeTable({ updatedAt: Number.NaN, items: [] }), undefined)
})

test('normalizeTable：坏条目被跳过，好条目照常读入（一条坏不该拖垮整表）', () => {
  const table = normalizeTable({
    updatedAt: 7,
    items: [null, 'x', { sessionId: '' }, { sessionId: 'session-ok' }, { file: 'x' }],
  })
  assert.ok(table)
  assert.deepEqual(table.items.map((item) => item.sessionId), ['session-ok'])
})

test('classifyTable：fresh / stale / invalid 三分支（含时间戳在未来）', () => {
  const now = 1_000_000
  const fresh = { updatedAt: now - 1000, items: [{ sessionId: 's' }] }
  assert.equal(classifyTable(fresh, now, DEFAULT_STALE_MS), 'fresh')
  assert.equal(classifyTable({ ...fresh, updatedAt: now - DEFAULT_STALE_MS - 1 }, now, DEFAULT_STALE_MS), 'stale')
  assert.equal(classifyTable({ updatedAt: now + 5 * 60 * 1000, items: [{ sessionId: 's' }] }, now, DEFAULT_STALE_MS), 'invalid',
    '时间戳明显在未来 ⇒ 损坏（时钟异常/手工编辑），不能当成"永不过期"')
  assert.equal(classifyTable({ updatedAt: now, items: [] }, now, DEFAULT_STALE_MS), 'fresh',
    '空表也是 fresh（它会被消费成"没有待唤醒的会话"）')
  assert.equal(classifyTable({ nope: true }, now, DEFAULT_STALE_MS), 'invalid')
})

test('serializeTable 与 readTableFile：落盘 → 读回 → 归一化，逐字段一致', () => {
  const scratch = makeScratch()
  try {
    const file = join(scratch.dir, ACTIVE_FILENAME)
    const entry = makeEntry({ kind: KIND_SUBAGENT, parentSessionId: 'session-parent', why: ['subagent', 'job'] })
    const text = serializeTable([entry], 9999)
    writeFileSync(file, text)

    const read = readTableFile(file)
    assert.equal(read.kind, 'parsed')
    const table = normalizeTable(read.raw)
    assert.equal(table.updatedAt, 9999)
    assert.deepEqual(table.items, [entry], '往返之后逐字段一致')
    assert.equal(JSON.parse(text).version, TABLE_VERSION)
  } finally {
    scratch.cleanup()
  }
})

test('readTableFile：不存在 ⇒ absent；坏 JSON ⇒ unreadable（两种情形必须可区分）', () => {
  const scratch = makeScratch()
  try {
    const missing = join(scratch.dir, 'nope.json')
    assert.equal(readTableFile(missing).kind, 'absent')

    const broken = join(scratch.dir, 'broken.json')
    writeFileSync(broken, '{ 这不是 JSON')
    const read = readTableFile(broken)
    assert.equal(read.kind, 'unreadable')
    assert.match(read.reason, /JSON 解析失败/)
  } finally {
    scratch.cleanup()
  }
})

test('summarizeTable：五字段投影 —— 表里的条目一律"待唤醒"', () => {
  const summary = summarizeTable({
    updatedAt: 1,
    items: [makeEntry({ kind: KIND_SUBAGENT, parentSessionId: 'session-p' })],
  })
  assert.equal(summary.length, 1)
  assert.deepEqual(summary[0], {
    sessionId: 'session-aaaa1111-1111-1111-1111-111111111111',
    kind: KIND_SUBAGENT,
    done: false,
    active: true,
    wake: true,
  }, '形状与 v0.6.0 的 pendingSummary 逐字段一致（消费者零改动）')
  assert.equal(summarizeTable({ nope: 1 }), undefined)
})

test('resolveConfig：默认值（工作表路径、防抖、兜底间隔、新鲜度）', () => {
  const resolved = resolveConfig({ home: 'C:\\fake-home' })
  assert.equal(resolved.storageDir, join('C:\\fake-home', 'storages', 'sl-handoff'))
  assert.equal(resolved.activeFile, join(resolved.storageDir, ACTIVE_FILENAME))
  assert.equal(resolved.logFile, join(resolved.storageDir, 'sl-handoff.log'))
  assert.equal(resolved.debounceMs, DEFAULT_DEBOUNCE_MS)
  assert.equal(resolved.sweepMs, DEFAULT_SWEEP_MS)
  assert.equal(resolved.staleMs, DEFAULT_STALE_MS)
  assert.equal(resolved.resumeMaxSessions, 0, '默认不限')
  assert.equal(resolved.requireColdAgent, false)
})

test('resolveConfig：自定义路径与数值生效；非法值 fail loud', () => {
  const resolved = resolveConfig({
    storageDir: 'C:\\tmp\\sl',
    activeFile: 'C:\\tmp\\sl\\custom.json',
    debounceMs: 0,
    sweepMs: 5000,
    resumeMaxSessions: 3,
    requireColdAgent: true,
  })
  assert.equal(resolved.activeFile, 'C:\\tmp\\sl\\custom.json')
  assert.equal(resolved.debounceMs, 0)
  assert.equal(resolved.sweepMs, 5000)
  assert.equal(resolved.resumeMaxSessions, 3)
  assert.equal(resolved.requireColdAgent, true)

  assert.throws(() => resolveConfig({ debounceMs: -1 }), /debounceMs/)
  assert.throws(() => resolveConfig({ sweepMs: 10 }), /sweepMs/, '兜底间隔有下限（1s）')
  assert.throws(() => resolveConfig({ staleMs: 1 }), /staleMs/)
  assert.throws(() => resolveConfig({ requireColdAgent: 'yes' }), /requireColdAgent/)
  assert.throws(() => resolveConfig({ resumeTextMaxChars: 1 }), /resumeTextMaxChars/)
})

test('sessionPrefix / oneLine：剥掉 session- 前缀、折叠空白并截断', () => {
  assert.equal(sessionPrefix('session-aaaa1111-2222'), 'aaaa1111')
  assert.equal(sessionPrefix('rawid12345678'), 'rawid123')
  assert.equal(sessionPrefix(''), 'unknown')
  assert.equal(oneLine('  a\n\n b  ', 100), 'a b')
  assert.equal(oneLine('x'.repeat(50), 10).length, 10)
  assert.ok(oneLine('x'.repeat(50), 10).endsWith('…'))
})

test('readFileSync 能读到刚序列化的文本（防"序列化不是字符串"这类低级错）', () => {
  const scratch = makeScratch()
  try {
    const file = join(scratch.dir, 'round-trip.json')
    writeFileSync(file, serializeTable([], 1))
    assert.match(readFileSync(file, 'utf8'), /"items": \[\]/)
  } finally {
    scratch.cleanup()
  }
})
