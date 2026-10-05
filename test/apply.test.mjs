/**
 * 插件装载面：静态自检 + apply 的 fail-soft 骨架 + 卸载回收。
 *
 * 静态自检那几条都是踩出来的（每一条都对应一次真实事故或一次真实的"功能白做"）：
 *   · 漏声明 `timer` ⇒ apply 抛错 ⇒ **整个 dsh 起不来**（2026-09-17）；
 *   · 裸 import 宿主包 ⇒ `link:` 装机下 ERR_MODULE_NOT_FOUND ⇒ 同样起不来；
 *   · 服务写进 `inject` ⇒ 本插件缺席时消费者整个不 apply。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACTIVE_FILENAME,
  SERVICE_NAME,
  VERSION,
  apply,
  inject,
} from '../lib/index.js'
import { CONTEXT_BUILTINS, FALLBACK_LOG_FILE, SERVICE_MIXINS, makeCtx, makeScratch, readLog } from './helpers.mjs'

const SOURCE = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
/**
 * 剥掉注释后的**代码**。
 *
 * "零残留"那几条检查必须只看代码：注释里会提到被删掉的旧机制（"`pending.json` 被工作表取代"
 * 这类历史说明是给人读的），拿全文去匹配会把有价值的说明也判成残留。
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('静态自检：inject 覆盖每一个被访问的服务属性', () => {
  const declared = new Set(inject)
  const accessed = new Map()
  for (const match of CODE.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    const name = match[1]
    if (CONTEXT_BUILTINS.has(name)) continue
    const service = SERVICE_MIXINS[name] ?? name
    accessed.set(service, name)
  }
  for (const [service, property] of accessed) {
    assert.ok(declared.has(service), `ctx.${property} 被访问，但 inject 里没有声明 "${service}"`)
  }
  assert.ok(declared.has('timer'), 'ctx.timeout 是 timer 的 mixin，漏声明会让 apply 抛错')
  assert.ok(declared.has('sessions'), 'flush 是硬依赖')
  assert.ok(declared.has('agents'), '枚举 live agent 是硬依赖')
})

test('静态自检：v0.7.0 的删除项零残留（命令 / 摘要 / pending.json / 记录文件）', () => {
  assert.doesNotMatch(CODE, /commands\.register/, '/sl 命令必须删干净')
  assert.doesNotMatch(CODE, /COMMAND_NAME/, '命令名常量不该还在')
  assert.ok(!inject.includes('commands'), 'commands 依赖随命令一起删')
  assert.doesNotMatch(CODE, /pending\.json/, 'pending.json 机制已被工作表取代')
  assert.doesNotMatch(CODE, /PENDING_FILENAME|PENDING_VERSION|normalizePending|classifyPending|mergePendingItems/,
    '旧标记机制的函数名不该残留')
  assert.doesNotMatch(CODE, /renderHandoffDoc|summarizeMessages|handoffFileName|archiveFileName/,
    'Markdown 摘要渲染必须删干净')
  assert.doesNotMatch(CODE, /tools\.register|sl_save|TOOL_NAME/, '模型工具入口自 v0.3.0 起就不存在')
  assert.match(CODE, /active-sessions/, '新机制（活跃工作表）必须真的在')
})

test('静态自检：v0.7.2 的删除项零残留（"只报失败"的那条通知）', () => {
  assert.doesNotMatch(CODE, /SUBAGENT_FAILURE_HEADING|buildSubagentFailureNotice|notifySubagentFailureToParent/,
    '旧的"只报失败"通知已被"成功也报的汇总结果"取代，代码里不该残留')
  assert.match(CODE, /SUBAGENT_OUTCOME_HEADING/, '新的接续结果通知必须在')
  assert.match(CODE, /notifySubagentOutcomesToParent/, '按父会话汇总发送的入口必须在')
})

test('静态自检：v0.7.3 的关键机制在位（steer 插队 / 子代理侧判定 / 父会话先 live）', () => {
  assert.match(CODE, /pickOutcomeDelivery/, '插队选路必须在（followup 排队 ⇒ steer 插队）')
  assert.match(CODE, /'steer'/, '真的用宿主 next-step 通道，不是只写在注释里')
  assert.match(CODE, /decideSubagentResume/, '子代理侧的 blank / 让位判定必须在')
  assert.match(CODE, /parentAgents/, '阶段 1.5 的"父会话先 live"记录必须在')
  assert.match(CODE, /plan\.deferred/, '超上限的子代理要补一条 ⏸ 说明（别让预告变空头支票）')
})

test('静态自检：服务由 ctx.provide 提供，且**不**写进 inject', () => {
  assert.match(SOURCE, /ctx\.provide\(SERVICE_NAME/)
  assert.ok(!inject.includes(SERVICE_NAME), '写进 inject 就等于"本插件缺席时消费者整个不 apply"')
  assert.ok(!inject.includes('sessionController'), '它在 apply 时可能还没挂载，必须用 ctx.get() 可选读取')
})

test('静态自检：零宿主 import（link: 装机下裸 import 会让 dsh 起不来）', () => {
  assert.doesNotMatch(CODE, /from\s+['"]@deepseek-ai\//)
  assert.doesNotMatch(CODE, /require\(['"]@deepseek-ai\//)
  const imports = [...CODE.matchAll(/^import .*from '([^']+)'/gm)].map((match) => match[1])
  assert.ok(imports.length > 0)
  for (const specifier of imports) {
    assert.ok(specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
      `只允许 node:* 与相对路径，收到 ${specifier}`)
  }
})

test('静态自检：VERSION 与 package.json 一致', () => {
  assert.equal(VERSION, PACKAGE.version)
  assert.equal(VERSION, '0.7.4')
})

test('apply：配置非法时**绝不抛回 loader**，只降级并写兜底日志', () => {
  const scratch = makeScratch()
  try {
    const { ctx } = makeCtx({ agents: { list: () => [] }, sessions: {} })
    assert.doesNotThrow(() => apply(ctx, { debounceMs: -1 }), 'apply 抛错会让整个 dsh 起不来')
    const log = readLog(FALLBACK_LOG_FILE)
    assert.match(log, /apply 抛错，插件已降级/)
    assert.match(log, /debounceMs/)
  } finally {
    scratch.cleanup()
  }
})

test('apply：正常装载 ⇒ 提供服务 + 登记启动恢复定时器 + 写 apply 日志', () => {
  const scratch = makeScratch()
  try {
    const agents = { list: () => [], roots: () => [] }
    const handle = makeCtx({ agents, sessions: { flush: async () => {}, get: () => undefined } })
    apply(handle.ctx, { storageDir: scratch.dir, debounceMs: 0 })

    assert.ok(handle.provided.has(SERVICE_NAME), '服务已登记在当前 fiber 上')
    assert.equal(handle.scheduled.length, 1, '启动恢复被登记成一个定时任务')
    const log = readLog(join(scratch.dir, 'sl-handoff.log'))
    assert.match(log, new RegExp(`apply: v${VERSION.replace(/\./g, '\\.')}`))
    assert.match(log, /工作表=/)
    assert.match(log, new RegExp(`${SERVICE_NAME} 服务已提供`))
    assert.match(log, /会话状态监听 已注册/)
    assert.ok(existsSync(join(scratch.dir, 'sl-handoff.log')))
    handle.dispose()
  } finally {
    scratch.cleanup()
  }
})

test('apply：同名服务已被别的 fiber 提供 ⇒ 只降级，不影响唤醒逻辑', () => {
  const scratch = makeScratch()
  try {
    const handle = makeCtx(
      { agents: { list: () => [], roots: () => [] }, sessions: {} },
      { preProvided: { [SERVICE_NAME]: { saveAll: () => ({}) } } },
    )
    assert.doesNotThrow(() => apply(handle.ctx, { storageDir: scratch.dir, debounceMs: 0 }))
    const log = readLog(join(scratch.dir, 'sl-handoff.log'))
    assert.match(log, /服务提供失败/)
    assert.equal(handle.scheduled.length, 1, '服务失败不影响启动恢复定时器')
    handle.dispose()
  } finally {
    scratch.cleanup()
  }
})

test('apply：ctx.timeout 不可用 ⇒ 回退全局 setTimeout（不拖垮宿主）', () => {
  const scratch = makeScratch()
  try {
    const handle = makeCtx(
      { agents: { list: () => [], roots: () => [] }, sessions: {} },
      { noTimeout: true },
    )
    assert.doesNotThrow(() => apply(handle.ctx, { storageDir: scratch.dir, debounceMs: 0 }))
    const log = readLog(join(scratch.dir, 'sl-handoff.log'))
    assert.match(log, /ctx\.timeout 不可用/)
    handle.dispose()
  } finally {
    scratch.cleanup()
  }
})

test('apply：卸载时回收服务、事件订阅与定时器（并落盘内存态）', () => {
  const scratch = makeScratch()
  try {
    const handle = makeCtx({ agents: { list: () => [], roots: () => [] }, sessions: {} })
    apply(handle.ctx, { storageDir: scratch.dir, debounceMs: 0 })
    assert.ok(handle.provided.has(SERVICE_NAME))

    handle.dispose()
    assert.ok(!handle.provided.has(SERVICE_NAME), '服务随 fiber 卸载自动注销')
    const log = readLog(join(scratch.dir, 'sl-handoff.log'))
    assert.match(log, /dispose：已回收服务、事件订阅与定时器/)
  } finally {
    scratch.cleanup()
  }
})

test('apply：启动恢复真的会跑（定时器触发 ⇒ 读表 ⇒ 空表就跳过）', async () => {
  const scratch = makeScratch()
  try {
    const handle = makeCtx({ agents: { list: () => [], roots: () => [] }, sessions: {} })
    apply(handle.ctx, { storageDir: scratch.dir, debounceMs: 0, bootDelayMs: 0 })
    handle.runBoot()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const log = readLog(join(scratch.dir, 'sl-handoff.log'))
    assert.match(log, /启动时没有活跃工作表|工作表里没有待唤醒的会话/)
    handle.dispose()
  } finally {
    scratch.cleanup()
  }
})

test('apply：表里有条目但 sessionController 缺席 ⇒ 表保留（不丢待办）', async () => {
  const scratch = makeScratch()
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(scratch.dir, ACTIVE_FILENAME), JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      items: [{ sessionId: 'session-a', kind: 'root', why: ['turn'], updatedAt: Date.now() }],
    }))

    const handle = makeCtx({ agents: { list: () => [], roots: () => [] }, sessions: {} })
    apply(handle.ctx, { storageDir: scratch.dir, debounceMs: 0, bootDelayMs: 0, controllerWaitMs: 0 })
    handle.runBoot()
    await new Promise((resolve) => setTimeout(resolve, 40))

    const log = readLog(join(scratch.dir, 'sl-handoff.log'))
    assert.match(log, /1 条待唤醒/)
    assert.match(log, /sessionController 在 0ms 内不可用，本次不唤醒（表保留）/)
    assert.ok(existsSync(join(scratch.dir, ACTIVE_FILENAME)), '表必须还在')
    handle.dispose()
  } finally {
    scratch.cleanup()
  }
})
