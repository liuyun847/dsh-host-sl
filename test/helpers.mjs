/**
 * 测试公共件。
 *
 * 三条纪律：
 *  1. **一切落盘都在临时目录里** —— storageDir / 日志都指过去，`DSH_SL_LOG_FILE` 也设上，
 *     保证连 apply 的兜底日志都落不到真实的 `~\.dsh\storages\sl-handoff\`；
 *  2. 假 ctx 带 cordis 语义 —— 访问未在 `inject` 里声明的"服务属性"会抛错，
 *     `ctx.get()` 才是安全读取（照 dsh-host-restart 的事故回归用例）；`ctx.provide()` 按真
 *     cordis 的语义实现：服务登记在当前 fiber 上、`ctx.get()` 立刻可读、fiber 卸载即注销
 *     （真实现见 cordis/lib/index.js:800-824 与 _getImpl 的 strict 判据）；
 *  3. 宿主包从 **dsh 安装树**解析（`createRequire` 锚到 dsh 的 package.json），
 *     插件目录里没有 `node_modules` —— 本包运行时一个宿主包都不 import，这里只为
 *     "拿真实的宿主工厂当判据"（见 test/message-shape.test.mjs）。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { inject } from '../lib/index.js'

/**
 * dsh 安装树的锚点：默认按 npm 全局前缀推导（Windows = `%APPDATA%\npm`），换机器不用改代码；
 * 也可用 `DSH_INSTALL_PACKAGE_JSON` 显式指定。
 */
const NPM_GLOBAL_ROOT = process.env.APPDATA
  ? join(process.env.APPDATA, 'npm')
  : join(homedir(), 'AppData', 'Roaming', 'npm')
export const DSH_PACKAGE_JSON = process.env.DSH_INSTALL_PACKAGE_JSON
  ?? join(NPM_GLOBAL_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

/**
 * 兜底日志与兜底 home 的**安全网**（模块加载即生效，每个测试文件都 import 本文件）。
 *
 * `apply` 在**配置解析失败**时只能用 `fallbackLogFile()`，它读 `DSH_SL_LOG_FILE` 或
 * `DSH_HOME`；漏了这一步，一条"配置非法"的用例就会把日志写进真实的
 * `~\.dsh\storages\sl-handoff\`（2026-09-28 本包自测时真的踩到过）。这里把两个环境变量
 * 都指到临时目录，任何测试路径都不可能落到真实目录。
 */
const fallbackScratch = mkdtempSync(join(tmpdir(), 'dsh-sl-fallback-'))
/** 配置解析失败时 apply 会写的那份日志（测试断言它，而不是真实目录）。 */
export const FALLBACK_LOG_FILE = join(fallbackScratch, 'sl-handoff.log')
process.env.DSH_SL_LOG_FILE = FALLBACK_LOG_FILE
process.env.DSH_HOME = fallbackScratch
process.on('exit', () => {
  try { rmSync(fallbackScratch, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

const anchor = createRequire(DSH_PACKAGE_JSON)

/** 按 dsh 安装树的解析规则加载一个宿主包（拿到的是宿主自己那份模块实例）。 */
export async function loadDshModule(specifier) {
  if (!existsSync(DSH_PACKAGE_JSON)) {
    throw new Error(`找不到 dsh 安装锚点 ${DSH_PACKAGE_JSON}（可用 DSH_INSTALL_PACKAGE_JSON 覆盖）`)
  }
  return await import(pathToFileURL(anchor.resolve(specifier)).href)
}

/** 所有还在的临时目录（进程退出时兜底清理，防"定时任务晚于 cleanup 触发"这类残留）。 */
const liveScratches = new Set()

/** 造一个临时目录；`cleanup()` 由调用方在收尾时执行（进程退出还有一层兜底）。 */
export function makeScratch(prefix = 'dsh-sl-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  liveScratches.add(dir)
  return {
    dir,
    cleanup: () => {
      liveScratches.delete(dir)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 已删除 */ }
    },
  }
}

// 兜底清理：任何测试忘了 cleanup、或清理后又写回来的临时目录，进程退出时一并删掉。
process.on('exit', () => {
  for (const dir of liveScratches) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
  liveScratches.clear()
})

/** cordis Context 自身提供、不需要 inject 声明的成员。 */
export const CONTEXT_BUILTINS = new Set([
  'get', 'set', 'provide', 'effect', 'on', 'off', 'emit', 'parallel', 'waterfall', 'bail', 'serial',
  'start', 'stop', 'scope', 'root', 'fiber', 'logger', 'inject', 'mixin', 'reflect', 'registry',
  'isolate', 'extend', 'plugin', 'accept',
])

/** ctx 上由服务 mixin 提供的属性 → 该属性要求声明的服务名（timer 服务的 mixin）。 */
export const SERVICE_MIXINS = {
  timeout: 'timer',
  interval: 'timer',
  throttle: 'timer',
  debounce: 'timer',
}

/**
 * 造一个带 cordis 语义的假 ctx：
 *   · 服务属性**只有声明在 `inject` 里才可访问** —— 未声明就访问会抛错（2026-09-17 事故的机制），
 *     `ctx.get()` 是安全的可选读取；
 *   · `ctx.provide(name, value)` 按真 cordis 的语义：登记在当前 fiber 上（这里就是"进 cleanups"），
 *     `ctx.get(name)` 立刻读得到，fiber 卸载（`dispose()`）后读不到；同名重复 provide 抛错
 *     （真实现抛 `service "x" has been registered at <fiber>`，见 cordis/lib/index.js:813）；
 *   · `ctx.timeout` 是 `timer` 服务的 mixin，随 `timer` 一起开关。
 * @param services 可解析的服务表（缺谁就等于该服务不可用）。
 * @param options.noTimeout true 时连 `ctx.timeout` 也不提供 —— 用来复现"timer 缺失"路径。
 * @param options.immediateTimer true 时 `ctx.timeout` 立刻执行回调（不等真实时钟）。
 * @param options.preProvided 提前"已被别的 fiber 提供"的服务表 —— 复现 provide 撞名的降级路径。
 */
export function makeCtx(services = {}, options = {}) {
  const declared = new Set(options.declaredServices ?? inject)
  const handlers = new Map()
  const scheduled = []
  const cleanups = []
  const provided = new Map(Object.entries(options.preProvided ?? {}))
  const base = {
    get: (name) => (provided.has(name) ? provided.get(name) : services[name]),
    // cordis 的 provide：服务随当前 fiber 的卸载自动注销（真实现就是 fiber.effect）
    provide: (name, value) => {
      if (provided.has(name)) throw new Error(`service "${name}" has been registered at <other fiber>`)
      provided.set(name, value)
      const dispose = () => { provided.delete(name) }
      cleanups.push(dispose)
      return dispose
    },
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      // 真 cordis 的 ctx.on 返回 disposer（卸载监听）；这里照做，好让"dispose 后不再收到事件"可测
      return () => {
        const current = handlers.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    // cordis 的清理机制：回调的返回值（清理函数）登记进当前 fiber，卸载时执行。
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') cleanups.push(disposer)
      return () => {}
    },
  }
  if (options.noTimeout !== true) {
    base.timeout = (fn, ms) => {
      scheduled.push({ fn, ms })
      if (options.immediateTimer === true) {
        const timer = setTimeout(fn, 0)
        return () => clearTimeout(timer)
      }
      return () => { /* 取消：测试里由 runBoot 显式触发 */ }
    }
  }
  /**
   * 宿主「会话活动」查询（waterfall）。
   *
   * **默认不提供** —— 那正是"workspace 服务缺席/无监听者"的回退路径（插件必须据此改走自建判据）。
   * 传 `options.waterfall` 才装上，签名与真 cordis 一致：`(event, payload, fallback)`。
   */
  if (options.waterfall !== undefined) base.waterfall = options.waterfall
  const ctx = new Proxy(base, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
      if (typeof prop === 'string' && prop in services) {
        if (declared.has(prop) || declared.has(SERVICE_MIXINS[prop])) return services[prop]
        throw new Error(`cannot access ctx.${prop} without an inject declaration`)
      }
      return undefined
    },
  })
  return {
    ctx,
    /** 已登记的定时任务（apply 的启动恢复就是其中一个）。 */
    scheduled,
    /** 本 fiber 已 provide 的服务表（卸载后应当为空）。 */
    provided,
    /** 触发第 index 个定时任务（默认第一个）。 */
    runBoot(index = 0) { scheduled[index]?.fn() },
    /** 触发某个生命周期事件的全部处理器（可带 payload，与真 cordis 的 emit 一致）。 */
    fire(event, ...args) { for (const handler of handlers.get(event) ?? []) handler(...args) },
    /** 模拟 cordis 的 fiber 卸载：跑 ctx.effect 登记的清理函数（真宿主由 cordis 自己跑）。 */
    dispose() { for (const cleanup of cleanups.splice(0)) cleanup() },
  }
}

/** 轮询等待：`predicate` 返回真即返回，超时抛错（消息里带 label，便于定位是哪一步没等到）。 */
export async function waitUntil(predicate, { timeoutMs = 4000, intervalMs = 10, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** 读日志文本（不存在返回空串）。 */
export function readLog(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 造一个记录用法的假 sessionController（`list`/`resolveAgent` 都按传入行为走）。 */
export function fakeController({ items, resolve, listThrows = false } = {}) {
  const calls = { list: 0, resolve: [] }
  return {
    calls,
    async list() {
      calls.list += 1
      if (listThrows) throw new Error('列表读取失败（测试造的）')
      return { items: items ?? [] }
    },
    async resolveAgent(sessionId) {
      calls.resolve.push(sessionId)
      return resolve === undefined ? { error: new Error('未配置 resolve 行为') } : resolve(sessionId)
    },
  }
}

/** 造一个记录 followup 的假 agent。 */
export function fakeAgent(sessionId, { status = 'idle', session } = {}) {
  const followups = []
  return {
    followups,
    status,
    session: session ?? { id: sessionId, header: { id: sessionId, cwd: 'C:\\work' } },
    followup(message) { followups.push(message) },
  }
}
