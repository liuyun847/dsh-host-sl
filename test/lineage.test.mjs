/**
 * 血缘判定：谁是顶层、谁挂在谁名下。
 *
 * 它是"判据②（名下子代理在跑）"与"恢复顺序硬约束（先顶层后子代理）"共用的那一层 ——
 * 判错一头会把别人的子代理算到自己头上，判错另一头会让子代理永远唤不回来。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isSubagentAgent, lineageTopId, sessionTitleOf } from '../lib/index.js'
import { makeCtx } from './helpers.mjs'

function makeAgent(sessionId, { origin, parentSession, status = 'idle' } = {}) {
  const header = { id: sessionId }
  if (origin !== undefined) header.origin = origin
  if (parentSession !== undefined) header.parentSession = parentSession
  return { status, session: { id: sessionId, header } }
}

test('lineageTopId：直接子代理 ⇒ 上溯到父', () => {
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const byId = new Map([['session-root', makeAgent('session-root')], ['session-child', child]])
  assert.equal(lineageTopId(child, byId, 'session-root'), 'session-root')
})

test('lineageTopId：任意深度（孙代理）也算', () => {
  const grand = makeAgent('session-grand', { origin: 'subagent', parentSession: 'session-child' })
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-root' })
  const byId = new Map([
    ['session-root', makeAgent('session-root')],
    ['session-child', child],
    ['session-grand', grand],
  ])
  assert.equal(lineageTopId(grand, byId, 'session-root'), 'session-root')
  assert.equal(lineageTopId(grand, byId, 'session-child'), 'session-child', '对中间层也算它的后代')
})

test('lineageTopId：别人的子代理不算（上溯到顶是别人）', () => {
  const other = makeAgent('session-other-child', { origin: 'subagent', parentSession: 'session-other' })
  const byId = new Map([['session-other', makeAgent('session-other')], ['session-other-child', other]])
  assert.equal(lineageTopId(other, byId, 'session-root'), 'session-other')
  assert.notEqual(lineageTopId(other, byId, 'session-root'), 'session-root')
})

test('lineageTopId：父不在 live 表里 ⇒ 用持久 id 收尾（宁多认一层血缘）', () => {
  const child = makeAgent('session-child', { origin: 'subagent', parentSession: 'session-gone' })
  assert.equal(lineageTopId(child, new Map(), 'session-root'), 'session-gone')
})

test('lineageTopId：没有 parentSession 的会话 ⇒ 它就是自己的顶', () => {
  const root = makeAgent('session-root')
  assert.equal(lineageTopId(root, new Map(), 'session-other'), 'session-root')
})

test('lineageTopId：血缘损坏成环 ⇒ 不死循环，用已知最高层收尾', () => {
  const a = makeAgent('session-a', { origin: 'subagent', parentSession: 'session-b' })
  const b = makeAgent('session-b', { origin: 'subagent', parentSession: 'session-a' })
  const byId = new Map([['session-a', a], ['session-b', b]])
  const top = lineageTopId(a, byId, 'session-root')
  assert.ok(typeof top === 'string' && top.length > 0, '必须返回一个确定的 id，不能挂死')
})

test('isSubagentAgent：只认 header.origin === "subagent"（fork 会话不算）', () => {
  assert.equal(isSubagentAgent(makeAgent('s', { origin: 'subagent' })), true)
  assert.equal(isSubagentAgent(makeAgent('s')), false)
  assert.equal(isSubagentAgent(makeAgent('s', { parentSession: 'session-root' })), false,
    'fork 会话共享 parentSession 但没有 origin —— 它是独立对话，不算子代理')
  assert.equal(isSubagentAgent(undefined), false)
  assert.equal(isSubagentAgent({}), false)
})

test('sessionTitleOf：拿到标题 / 服务缺席 / 抛错都 fail-soft（拿不到留空，绝不编造）', () => {
  const session = { id: 'session-a', header: {} }
  const withTitle = makeCtx({ sessionTitle: { get: () => ({ title: '写测试' }) } })
  assert.equal(sessionTitleOf(withTitle.ctx, session), '写测试')

  const empty = makeCtx({ sessionTitle: { get: () => undefined } })
  assert.equal(sessionTitleOf(empty.ctx, session), '')

  const missing = makeCtx({})
  assert.equal(sessionTitleOf(missing.ctx, session), '')

  const throwing = makeCtx({ sessionTitle: { get: () => { throw new Error('标题炸了') } } })
  assert.equal(sessionTitleOf(throwing.ctx, session), '')

  const badShape = makeCtx({ sessionTitle: { get: () => ({ title: 123 }) } })
  assert.equal(sessionTitleOf(badShape.ctx, session), '')
})
