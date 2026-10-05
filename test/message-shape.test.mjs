/**
 * 形状判据：拿**真实的**宿主工厂当 oracle，钉住本包手写的形状。
 *
 * 为什么需要这一层：本包以 `link:` 装进 profile，裸 import 宿主包会 ERR_MODULE_NOT_FOUND
 * （实测见 README），所以注入用的 user 消息是自己造的。自己造的东西会随宿主漂移 ——
 * 这个文件就是那道防线：宿主改了形状，这里立刻红。
 *
 * v0.3.0 起只剩这一处手写形状：模型工具（含手写的 JSON Schema）已删除，改为 cordis 服务
 * `slHandoff` —— 服务不需要任何宿主工厂（`ctx.provide` 是 cordis 自己的 API）。
 *
 * 宿主包从 dsh 安装树解析（createRequire 锚到 dsh 的 package.json），插件目录里没有 node_modules。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildUserMessage } from '../lib/index.js'
import { loadDshModule } from './helpers.mjs'

const { createUserMessage } = await loadDshModule('@deepseek-ai/dsh-llm')

test('buildUserMessage 与真实 createUserMessage 逐字段同形（只差那个随机 id）', () => {
  const text = '【sl 交接续跑】测试正文'
  const ours = buildUserMessage(text)
  const real = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

  assert.deepEqual(Object.keys(ours).sort(), Object.keys(real).sort(), '字段集合必须一致')
  assert.equal(ours.role, real.role)
  assert.equal(ours.source.kind, real.source.kind)
  assert.deepEqual(ours.content, real.content, 'content 块形状必须一致')
  assert.equal(typeof ours.id, 'string')
  assert.equal(typeof real.id, 'string')
  assert.ok(ours.id.length > 0)
  assert.notEqual(ours.id, real.id, 'id 每条都要新生成')

  // 宿主工厂是 deepFreeze(structuredClone(...))：冻结与"可无损 JSON 化"这两条都要对齐
  assert.ok(Object.isFrozen(ours), '必须是冻结对象（宿主工厂的产物是冻结的）')
  assert.ok(Object.isFrozen(ours.content))
  assert.ok(Object.isFrozen(ours.content[0]))
  assert.ok(Object.isFrozen(ours.source))
  assert.deepEqual(JSON.parse(JSON.stringify(ours)), ours, '必须是可无损 JSON 化的普通对象（session.append 的要求）')
})

test('buildUserMessage 每次给新 id，且能带任意长度正文', () => {
  const a = buildUserMessage('x')
  const b = buildUserMessage('x')
  assert.notEqual(a.id, b.id)
  const long = buildUserMessage('y'.repeat(20000))
  assert.equal(long.content[0].text.length, 20000)
})
