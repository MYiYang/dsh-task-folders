/**
 * Host half of `dsh-task-folders`（任务 / Task Folders）。
 *
 * 产品模型（v0.4）：**「任务」= 任务区自己名下的一个默认工作区**。
 *
 * v0.3 曾经把「任务」定义成「无工作区的会话」（DSH 的「未分组」），结果撞上 DSH
 * 对话框的硬门槛：空白会话的工作区芯片来自「它属于哪个工作区」，谁都 不归属时芯片
 * 缺席，输入框直接变成「选择工作区」（`inert = hero && chipTitle === undefined`）。
 * 无主会话永远发不出第一句话——这就是「任务里的会话需要文件夹才能说话」。
 *
 * 所以 v0.4 反过来做：把 `<tasksRoot>`（默认 `$DSH_HOME/tasks`）登记成一个真实工作区，
 * 老的任务容器（`<root>/default`、`<root>/1-tedb612` 之类）一并认领，老的会话挂进
 * 成员表。它们在**侧栏里被过滤掉**、统一画成「任务 + 按天」，但在 DSH 眼里就是普通
 * 工作区——会话有主、芯片在场、输入框可用，建会话走 `connectWorkspace` 这条原生路。
 *
 * 聊天记录同时按天归档成 DSH 默认格式（`session.v4.jsonl.zstd`，多帧 zstd JSONL）：
 *
 *   <tasksRoot>/<YYYY-MM-DD>/<会话>/session.v4.jsonl.zstd
 *
 * 这个文件只做「接线」：
 *   - 纯逻辑在 `lib/`（paths / sessions / scan / archive / project-archive / state），可脱离 ctx 单测；
 *   - 事件监听负责把任务区会话的事件流写进它的按天存档；
 *   - 一条 POST 路由族供客户端面板读状态、定位文件夹、归档 / 恢复项目。
 *
 * v0.5 起再补三样内置侧栏原有、接管后丢掉的能力（细节见 README）：
 *   - **会话归档**走 DSH 原生 `uiWorkspace.archiveSession`（原生没有物理删除，从侧栏
 *     消失就叫归档），`state` 因此把归档会话单列一份 `archivedDayGroups`，不再直接丢掉；
 *   - **项目归档**是插件自己的清单（`<home>/task-folders/projects.json`）：只影响侧栏
 *     怎么画，工作区登记、目录、会话日志一个字节都不动；
 *   - **搜索**由客户端调 `sessions.search()` 做全文，Host 不参与。
 *
 * v0.6 补上 DSH 自己**没有**的那一样：**物理删除会话**（`deleteSession`）。原生只给归档，
 * 所以删除由本插件收走一条会话在磁盘上的三处痕迹（DSH 日志、按天副本、投影缓存），
 * 默认移进 `<home>/task-folders/trash/`（`trash: false` 才真删），同时把会话从归档集合与
 * 工作区成员表里摘掉。正在干活的会话一律拒绝删除——那等于把这一轮工作丢掉。
 *
 * 反面原则：**任何 IO 失败都不得影响会话本身**。写不出存档只记 warn。
 * @module dsh-task-folders
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSessionArchive } from './lib/archive.js'
import { dayKey, isInside, sessionDir } from './lib/paths.js'
import { createProjectArchive } from './lib/project-archive.js'
import { scanSessionsRoot } from './lib/scan.js'
import { describeRemoval, pruneTrash, removeSessionFiles, trashRoot } from './lib/session-files.js'
import { createSessionIndex } from './lib/sessions.js'
import { buildState } from './lib/state.js'

/** 路由族前缀；方法名就是前缀之后的那一段。 */
const API_PREFIX = '/task-folders/api'
/** 请求体上限：面板只发短 JSON（标题、id），1MB 已经非常宽松。 */
const MAX_BODY_BYTES = 1024 * 1024
/** 所有 JSON 应答的头。 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** 带 HTTP 语义的失败。 */
class TaskFoldersError extends Error {
  /**
   * @param {string} code - 机器可读的错误码。
   * @param {string} message - 给人看的原因。
   * @param {number} status - HTTP 状态码。
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'TaskFoldersError'
    this.code = code
    this.status = status
  }
}

/**
 * 写一个 JSON 应答。
 * @param {import('node:http').ServerResponse} res - 应答对象。
 * @param {number} status - 状态码。
 * @param {unknown} value - JSON 值。
 */
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * 写一个失败应答。
 * @param {import('node:http').ServerResponse} res - 应答对象。
 * @param {number} status - 状态码。
 * @param {string} code - 错误码。
 * @param {string} message - 原因。
 */
function writeFailure(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/**
 * 读取并校验请求体。空体视为 `{}`。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Record<string, unknown>>} 解析后的对象。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new TaskFoldersError('bad-request', '请求体过大', 413)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new TaskFoldersError('bad-request', '请求体不是合法 JSON', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TaskFoldersError('bad-request', '请求体必须是 JSON 对象', 400)
  }
  return parsed
}

/**
 * 在资源管理器里定位一个目录（失败不报错）。
 * @param {string} target - 目录绝对路径。
 * @returns {boolean} 是否已发起打开动作。
 */
function revealDirectory(target) {
  try {
    const platform = process.platform
    const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [target], { detached: true, stdio: 'ignore' })
    if (typeof child.unref === 'function') child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * 解析 DSH home：显式配置 → `$DSH_HOME` → `~/.dsh`（与平台自己的优先级一致）。
 * @param {Record<string, unknown>} config - Loader 行配置。
 * @returns {string} 绝对路径。
 */
function resolveHome(config) {
  if (typeof config.home === 'string' && config.home.trim() !== '') return path.resolve(config.home.trim())
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 必需的 Host 服务：浏览器路由 + 部署可信校验。 */
export const inject = ['webServer', 'connection']

/**
 * 挂载任务文件夹插件。
 * @param {object} ctx - Host 插件上下文。
 * @param {Record<string, unknown>} [config] - Loader 行的配置。
 */
export function apply(ctx, config = {}) {
  const home = resolveHome(config)
  const tasksRoot =
    typeof config.tasksRoot === 'string' && config.tasksRoot.trim() !== ''
      ? path.resolve(tasksRootValue(config.tasksRoot, home))
      : path.join(home, 'tasks')

  // 先把根目录建出来再 realpath：工作区注册表存的是 realpath，两边必须同一套拼写，
  // 否则「有没有工作区」的判定在软链/大小写差异的机器上会认错。
  let resolvedRoot = tasksRoot
  try {
    fs.mkdirSync(tasksRoot, { recursive: true })
    resolvedRoot = fs.realpathSync(tasksRoot)
  } catch {
    resolvedRoot = tasksRoot
  }

  /**
   * 工作区注册表：反复 `ctx.get`（服务可能晚于本插件就绪），拿不到就退化成只读。
   * @returns {object|undefined} 工作区注册表。
   */
  const registry = () => ctx.get('workspaceRegistry')

  const tasks = createSessionIndex({
    tasksRoot: resolvedRoot,
    // 适配层：注册表缺席时 list 空、没有工作区路径可比对，而不是启动期就炸。
    workspaces: {
      list: () => {
        const target = registry()
        return target !== undefined && typeof target.list === 'function' ? target.list() : []
      },
    },
  })

  const archive = createSessionArchive({
    logger: ctx.logger,
    flushDelayMs: Number.isFinite(config.flushDelayMs) ? Number(config.flushDelayMs) : 300,
    flushBatchSize: Number.isFinite(config.flushBatchSize) ? Number(config.flushBatchSize) : 64,
    recoverFromLog: config.recoverFromLog !== false,
  })

  // 「已归档项目」：DSH 只给会话提供归档，工作区只有「删除登记」，所以项目归档
  // 只能由本插件记在 `<home>/task-folders/projects.json`——只影响侧栏怎么画，
  // 工作区登记、目录、会话日志一个字节都不动。
  const projects = createProjectArchive({
    file: path.join(home, 'task-folders', 'projects.json'),
    logger: ctx.logger,
  })

  /**
   * 已接入的会话 → 存档位置。只有任务区的会话会进这张表。
   * @type {Map<string, {day: string, dir: string, handle: object}>}
   */
  const bindings = new Map()

  /**
   * 当前注册的工作区实体清单（注册表缺席时为空）。
   * @returns {object[]} 工作区实体数组。
   */
  function registryList() {
    const target = registry()
    if (target === undefined || typeof target.list !== 'function') return []
    try {
      const list = target.list()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  /**
   * 当前存活（有 Agent 的）会话 id 集合。
   * @returns {Set<string>} 会话 id 集合。
   */
  function liveSessionIds() {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.list !== 'function') return new Set()
    try {
      return new Set(sessions.list().map((session) => String(session.id)))
    } catch {
      return new Set()
    }
  }

  /**
   * 全局归档（隐藏）的会话 id 集合。
   * @returns {Set<string>} 会话 id 集合。
   */
  function archivedSessionIds() {
    const target = registry()
    const ids = target?.archivedSessionIds
    return Array.isArray(ids) ? new Set(ids.map(String)) : new Set()
  }

  /**
   * 这条会话现在是不是正在干活（跑着一轮 / 等确认）。
   *
   * 问的是 DSH 自己的 `workspace/session-activity` 瀑布——归档会话时 DSH 也用它拦人，
   * 插件这边只是复用同一个判据，不另立一套「忙不忙」。老版本 DSH 没有这个事件，
   * 瀑布回落到默认的空数组，也就是「不拦」。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<string>} 活动说明（`running`、`approval` …）；空串表示空闲。
   */
  async function sessionActivity(sessionId) {
    if (typeof ctx.waterfall !== 'function') return ''
    try {
      const reported = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
      if (!Array.isArray(reported) || reported.length === 0) return ''
      return reported
        .map((entry) => (typeof entry?.kind === 'string' && entry.kind !== '' ? entry.kind : 'busy'))
        .join('、')
    } catch {
      // 事件不存在 / 某个监听器抛错：宁可放行让人自己决定，也不把删除功能锁死。
      return ''
    }
  }

  /**
   * 一条会话在任务根目录下的按天副本目录（新旧两种布局都认，读磁盘现算）。
   * @param {string} sessionId - 会话 id。
   * @returns {string[]} 目录绝对路径（没有就是空）。
   */
  function archiveDirsOf(sessionId) {
    try {
      const entry = scanSessionsRoot(tasks.root).byId.get(String(sessionId))
      return typeof entry?.path === 'string' && entry.path !== '' ? [entry.path] : []
    } catch {
      return []
    }
  }

  /**
   * 把一条已经删掉的会话从 DSH 的登记面里摘干净：归档集合 + 各工作区成员表。
   *
   * 这两处都只是 id 列表，留着指向空文件的 id，侧栏会画出一条点不开的幽灵行，
   * 工作区行尾的会话计数也会虚高。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<{unarchived: boolean, detached: number}>} 摘掉了什么。
   */
  async function forgetSession(sessionId) {
    const registryService = registry()
    const wasArchived = archivedSessionIds().has(String(sessionId))
    let unarchived = false
    if (wasArchived && registryService !== undefined && typeof registryService.unarchiveSession === 'function') {
      try {
        await registryService.unarchiveSession(sessionId)
        unarchived = true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`dsh-task-folders: 删除会话时取消归档失败（${sessionId}）：${message}`)
      }
    }
    let detached = 0
    for (const entity of registryList()) {
      const ids = Array.isArray(entity?.sessionIds) ? entity.sessionIds.map(String) : []
      if (!ids.includes(String(sessionId))) continue
      if (typeof entity.detachSession !== 'function') continue
      try {
        await entity.detachSession(String(sessionId))
        detached += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`dsh-task-folders: 删除会话时摘成员失败（${sessionId}）：${message}`)
      }
    }
    return { unarchived, detached }
  }

  /** 任务默认工作区（唯一一份）的 id；注册表没就绪时为空。 */
  let taskWorkspaceId = ''

  /** 已经清掉的重复任务区登记（路径键），避免每轮状态读取都去删。 */
  const prunedTaskAreas = new Set()

  /** 已经挂进任务区成员表的会话 id（attachSession 是持久写，只做一次）。 */
  const attachedIds = new Set()

  /** ensureTaskWorkspace 的串行队列（启动重试 + 面板轮询可能同时进来）。 */
  let ensureQueue = Promise.resolve()

  /**
   * 路径比较键：realpath 优先，Windows 下忽略大小写（与 DSH 的成员判定同口径）。
   * @param {string} target - 目录路径。
   * @returns {string} 比较键。
   */
  function pathKeyOf(target) {
    let resolved = target
    try {
      resolved = fs.realpathSync(target)
    } catch {
      resolved = path.resolve(target)
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  /**
   * 任务区工作区的显示名——它会出现在 DSH 的工作区芯片上（新任务会话头顶那枚）。
   * @returns {string} 显示名。
   */
  function taskTitle() {
    return typeof config.taskTitle === 'string' && config.taskTitle.trim() !== '' ? config.taskTitle.trim() : '任务'
  }

  /**
   * 确保「任务」工作区**有且只有一份**：任务根目录那一份。
   *
   * 为什么必须有一份：DSH 的对话框对空白会话有硬门槛——没有工作区就没有工作区芯片，
   * 输入框直接变成「选择工作区」（conversation：`inert = hero && chipTitle === undefined`），
   * 无主会话永远发不出第一句话。
   *
   * 为什么只能有一份：DSH 判定成员是「会话 header 里写死的 cwd 经 realpath 后与工作区
   * path 逐字相等」，cwd 不可改，所以一个目录一份登记。v0.2 把任务散在 `<root>/default`、
   * `<root>/1-tedb612` 这些子目录里，v0.4 一开始把它们也认领了，结果别人看到三行「任务」。
   * 现在反过来：只留根目录那一份，任务根目录树里的其它登记一律摘掉（目录与日志不动），
   * 它们名下**一条消息都没有的空壳会话**顺手归档，不再在侧栏里当哑巴行。
   * @param {object[]} [records] - 会话记录（用来把 cwd 就在任务根的既有会话挂进成员表）。
   * @returns {Promise<void>}
   */
  async function ensureTaskWorkspace(records = []) {
    // 串行化：启动重试与面板轮询可能同时进来，重复 create 会多登记一份。
    ensureQueue = ensureQueue.then(
      () => ensureTaskWorkspaceNow(records),
      () => ensureTaskWorkspaceNow(records),
    )
    return ensureQueue
  }

  /** 上一段的实际动作（由 {@link ensureTaskWorkspace} 串行调度）。 */
  async function ensureTaskWorkspaceNow(records = []) {
    let root
    try {
      root = tasks.ensureRoot()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-task-folders: 建任务根目录失败：${message}`)
      return
    }
    const rootEntity = await ensureWorkspaceFor(root, taskTitle())
    if (rootEntity === undefined) return
    if (typeof rootEntity.id === 'string') taskWorkspaceId = rootEntity.id
    await pruneTaskAreas(rootEntity)
    await attachSessions(rootEntity, rootSessionIds(records))
  }

  /**
   * 摘掉任务根目录树里除根目录之外的登记（v0.2 的 default / 1-tedb612 之类）。
   * 只摘登记：目录、会话日志一个字节都不动；空壳会话顺手归档，免得侧栏留着哑巴行。
   * @param {object} rootEntity - 任务根目录那份工作区。
   * @returns {Promise<void>}
   */
  async function pruneTaskAreas(rootEntity) {
    const registryService = registry()
    if (registryService === undefined || typeof registryService.delete !== 'function') return
    for (const entity of registryList()) {
      if (entity === undefined || typeof entity.path !== 'string' || entity.path === '') continue
      if (String(entity.id) === String(rootEntity.id)) continue
      if (!tasks.isTaskPath(entity.path)) continue
      const key = pathKeyOf(entity.path)
      if (prunedTaskAreas.has(key)) continue
      const ids = Array.isArray(entity.sessionIds) ? entity.sessionIds.map(String) : []
      for (const id of ids) await archiveIfEmpty(id)
      try {
        await registryService.delete(String(entity.id))
        prunedTaskAreas.add(key)
        ctx.logger?.info?.(
          `dsh-task-folders: 摘掉多余的任务区登记「${entity.title ?? entity.path}」（只留任务根那一份，目录与日志保留）`,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`dsh-task-folders: 摘任务区登记失败（${entity.id}）：${message}`)
      }
    }
  }

  /**
   * 一条会话如果**一句人话都没说过**，就归档它（从侧栏隐藏，日志保留）。
   * 只碰那些要跟着登记一起消失的空壳会话。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<boolean>} 是否归档了。
   */
  async function archiveIfEmpty(sessionId) {
    const registryService = registry()
    if (registryService === undefined || typeof registryService.archiveSession !== 'function') return false
    const empty = await isEmptySession(sessionId)
    if (empty !== true) return false
    try {
      await registryService.archiveSession(sessionId)
      ctx.logger?.info?.(`dsh-task-folders: 归档空会话 ${sessionId}（旧任务容器里的空壳，日志保留）`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-task-folders: 归档空会话失败（${sessionId}）：${message}`)
      return false
    }
  }

  /**
   * 一条会话是不是空壳（没有 `user/message`）。读不出日志时给 undefined（保守：不归档）。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<boolean|undefined>} 空壳 / 有内容 / 不知道。
   */
  async function isEmptySession(sessionId) {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined || typeof persistence.open !== 'function') return undefined
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
      const result = await handle.read()
      const events = Array.isArray(result?.events) ? result.events : []
      return !events.some((event) => event?.type === 'user/message')
    } catch {
      return undefined
    } finally {
      try {
        await handle?.close?.()
      } catch {
        /* 关不上无所谓 */
      }
    }
  }

  /**
   * 按路径找已登记的工作区（注册表缺席时 undefined）。
   * @param {string} target - 目录路径。
   * @returns {object|undefined} 工作区实体。
   */
  function workspaceByPath(target) {
    const wanted = pathKeyOf(target)
    for (const entity of registryList()) {
      if (typeof entity?.path !== 'string' || entity.path === '') continue
      if (pathKeyOf(entity.path) === wanted) return entity
    }
    return undefined
  }

  /**
   * 确保一个目录被登记成工作区（幂等：已有就原样返回）。
   * @param {string} target - 目录绝对路径。
   * @param {string} title - 新建时的显示名。
   * @returns {Promise<object|undefined>} 工作区实体。
   */
  async function ensureWorkspaceFor(target, title) {
    const known = workspaceByPath(target)
    if (known !== undefined) return known
    const registryService = registry()
    if (registryService === undefined || typeof registryService.create !== 'function') return undefined
    try {
      const entity = await registryService.create(target, title)
      if (entity === undefined || entity === null) return undefined
      ctx.logger?.info?.(`dsh-task-folders: 登记任务工作区「${title}」→ ${target}`)
      return entity
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-task-folders: 登记任务工作区失败（${target}）：${message}`)
      return undefined
    }
  }

  /**
   * cwd 就在任务根目录的会话 id（历史上建在根上的那些，要挂进成员表）。
   * @param {object[]} records - 会话记录。
   * @returns {string[]} 会话 id。
   */
  function rootSessionIds(records) {
    const rootKey = pathKeyOf(tasks.root)
    const ids = []
    for (const record of Array.isArray(records) ? records : []) {
      if (typeof record?.id !== 'string') continue
      if (typeof record.cwd !== 'string' || record.cwd === '') continue
      if (pathKeyOf(record.cwd) !== rootKey) continue
      ids.push(record.id)
    }
    return ids
  }

  /**
   * 把会话挂进工作区的成员表。DSH 只认这张表（`Workspace` 实体的 sessionIds），
   * 而新建工作区不会自动回填历史会话，所以老任务会话要一条条 attach 一次。
   * @param {object|undefined} entity - 工作区实体。
   * @param {string[]} ids - 会话 id。
   * @returns {Promise<void>}
   */
  async function attachSessions(entity, ids) {
    if (entity === undefined || typeof entity.attachSession !== 'function' || ids.length === 0) return
    const known = new Set(Array.isArray(entity.sessionIds) ? entity.sessionIds.map(String) : [])
    for (const id of ids) {
      if (attachedIds.has(id) || known.has(String(id))) {
        attachedIds.add(id)
        continue
      }
      try {
        await entity.attachSession(String(id))
        attachedIds.add(id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.debug?.(`dsh-task-folders: 老会话挂进任务区失败（${id}）：${message}`)
        attachedIds.add(id)
      }
    }
  }

  /**
   * 把一条任务区会话接到它的按天存档，并补写已经发生的事件。
   * @param {object} session - 活着的会话。
   * @returns {{dir: string, day: string, catchUp: number}|undefined} 结果。
   */
  function attachSession(session) {
    if (session === undefined || typeof session.id !== 'string') return undefined
    if (bindings.has(session.id)) return undefined
    const header = typeof session.header === 'object' && session.header !== null ? session.header : {}
    // 按「会话创建那天」归档：隔几天再打开旧会话，仍回到它自己的日期文件夹。
    const day = dayKey(typeof header.createdAt === 'number' ? header.createdAt : Date.now())
    const dir = sessionDir(tasks.root, day, session.id)
    const handle = archive.open({ dir, header, day, workspace: typeof header.cwd === 'string' ? header.cwd : tasks.root })
    bindings.set(session.id, { day, dir, handle })

    let catchUp = 0
    if (typeof session.snapshotEvents === 'function') {
      try {
        const events = session.snapshotEvents(handle.nextSeq)
        // 先补标题：会话可能早就聊过几轮才被接上，元数据要一步到位。
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
            archive.setTitle(handle, event.data.title)
            break
          }
        }
        catchUp = archive.append(handle, events)
        archive.flush(handle)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`dsh-task-folders: 补写历史事件失败（${session.id}）：${message}`)
      }
    }
    return { dir, day, catchUp }
  }

  /**
   * 会话被创建（含恢复）时：只要它落在任务区就自动归档，不需要用户点任何东西。
   * @param {object} session - 新建/恢复的会话。
   */
  function handleSessionCreated(session) {
    if (session === undefined || typeof session.id !== 'string') return
    if (bindings.has(session.id)) return
    if (!tasks.isTaskHeader(session.header)) return
    try {
      const result = attachSession(session)
      if (result !== undefined) ctx.logger?.debug?.(`dsh-task-folders: 归档会话 ${session.id} → ${result.dir}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-task-folders: 归档会话失败（${session.id}）：${message}`)
    }
  }

  /**
   * 会话追加事件时写入存档；还没接上但已经落在任务区的会话顺手补接。
   * @param {object} session - 会话。
   * @param {object} event - 会话事件。
   */
  function handleSessionEvent(session, event) {
    if (session === undefined || event === undefined) return
    let binding = bindings.get(session.id)
    if (binding === undefined) {
      // 会话可能是建好后被挪进任务区（或工作区被删）：补接一次。
      if (!tasks.isTaskHeader(session.header)) return
      try {
        const attached = attachSession(session)
        if (attached === undefined) return
        binding = bindings.get(session.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`dsh-task-folders: 补接会话失败（${session.id}）：${message}`)
        return
      }
    }
    if (binding === undefined) return
    try {
      archive.append(binding.handle, [event])
      if (event.type === 'session/title' && typeof event.data?.title === 'string') {
        archive.setTitle(binding.handle, event.data.title)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-task-folders: 写会话事件失败（${session.id}）：${message}`)
    }
  }

  /**
   * 客户端异常 / 首屏摘要的接收端：写到 `<home>/task-folders/` 下，最多保留 20 个文件。
   * 页面的 fetch 走的是可信通道，外部打不进来（路由本身有部署可信校验）。
   * @param {unknown} payload - 客户端回传的 JSON。
   * @returns {{file: string}} 写入的文件名。
   */
  function writeNote(payload) {
    const dir = path.join(home, 'task-folders')
    fs.mkdirSync(dir, { recursive: true })
    const text = `${JSON.stringify(payload, null, 2)}\n`
    const name = `note-${Date.now()}-${process.pid}.json`
    fs.writeFileSync(path.join(dir, name), text.slice(0, 256 * 1024), 'utf8')
    try {
      const files = fs
        .readdirSync(dir)
        .filter((entry) => entry.startsWith('note-'))
        .map((entry) => ({ entry, time: fs.statSync(path.join(dir, entry)).mtimeMs }))
        .sort((left, right) => right.time - left.time)
      for (const extra of files.slice(20)) fs.rmSync(path.join(dir, extra.entry), { force: true })
    } catch {
      /* 清理失败无所谓 */
    }
    return { file: name }
  }

  /**
   * 全部会话记录（含冷会话）：`sessionQuery` 优先，拿不到就只用活会话。
   * @returns {Promise<object[]>} `{id, createdAt, cwd, origin, live}` 数组。
   */
  async function gatherRecords() {
    const records = []
    const seen = new Set()
    const query = ctx.get('sessionQuery')
    if (query !== undefined && typeof query.listSessions === 'function') {
      try {
        for (const record of await query.listSessions()) {
          const header = record?.header
          if (header === undefined || typeof header.id !== 'string') continue
          seen.add(header.id)
          records.push({
            id: header.id,
            createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
            cwd: typeof header.cwd === 'string' ? header.cwd : '',
            origin: header.origin,
            live: record.live === true,
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`dsh-task-folders: 列举全部会话失败（${message}），退回活会话`)
      }
    }
    const sessions = ctx.get('sessions')
    if (sessions !== undefined && typeof sessions.list === 'function') {
      try {
        for (const session of sessions.list()) {
          const id = String(session?.id ?? '')
          if (id === '' || seen.has(id)) continue
          seen.add(id)
          const header = session.header ?? {}
          records.push({
            id,
            createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
            cwd: typeof header.cwd === 'string' ? header.cwd : '',
            origin: header.origin,
            live: true,
          })
        }
      } catch {
        /* 活会话也列不出来就算了：面板会显示空态 */
      }
    }
    return records
  }

  /**
   * 面板的一次读写操作。
   * @type {Record<string, (payload: Record<string, unknown>) => unknown | Promise<unknown>>}
   */
  const operations = {
    /** 面板首屏：任务区会话（按天分组）+ 普通工作区 + 任务默认工作区 id。 */
    async state() {
      const records = await gatherRecords()
      await ensureTaskWorkspace(records)
      const value = buildState({
        root: tasks.root,
        taskWorkspaceId,
        records,
        workspaces: registryList(),
        liveIds: liveSessionIds(),
        archivedIds: archivedSessionIds(),
        archivedWorkspaces: new Set(projects.list()),
        canCreate: typeof registry()?.create === 'function',
      })
      // 诊断开关：打开后客户端会把它看到的第一屏摘要回传一次（见 client.js reportFirstState）。
      value.debug = config.debug === true
      return value
    },

    /** 客户端异常回传 / 首屏摘要（只写本地文件，见 writeNote）。 */
    async note(payload) {
      return writeNote(payload)
    },

    /**
     * 「任务」里点 ＋ 时走这里：确保任务区（含它那份工作区登记）就绪，把工作区 id
     * 交给客户端，客户端随即 `uiWorkspace.connectWorkspace(id)` —— DSH 原生建会话，
     * 会话当天就落到 `<tasksRoot>/<YYYY-MM-DD>/<会话>/`。
     */
    async newTaskSession() {
      const dir = tasks.ensureRoot()
      await ensureTaskWorkspace([])
      return { cwd: dir, workspaceId: taskWorkspaceId, exists: true }
    },

    /**
     * 归档 / 恢复一个「项目」（普通工作区）。
     *
     * DSH 原生只给**会话**归档，工作区只有「删除登记」——那是把项目从列表里抹掉、
     * 会话落回「未分组」，不可逆也不好看。所以项目归档由本插件自己记一份清单，
     * 只影响侧栏怎么画：工作区登记、目录、名下会话日志一个字节都不动，恢复即原样。
     */
    async archiveProject(payload) {
      const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : ''
      if (workspaceId === '') throw new TaskFoldersError('bad-request', '缺少 workspaceId', 400)
      const archived = payload.archived !== false
      const result = projects.set(workspaceId, archived)
      if (projects.includes(workspaceId) !== archived) {
        // 写盘失败时 project-archive 已把内存回滚，这里直接认账：别让侧栏以为归档成功。
        throw new TaskFoldersError('archive-failed', '项目归档没写成，检查 DSH home 的写权限', 500)
      }
      return { archived: result.archived, changed: result.changed === true }
    },

    /**
     * 删除一条会话（v0.6）。
     *
     * DSH 原生没有物理删除，只有归档；所以这里由插件自己收走一条会话在磁盘上的痕迹：
     *
     *   - DSH 会话日志  `<home>/sessions/<转义cwd>/<会话>/`
     *   - 插件按天副本  `<tasksRoot>/<YYYY-MM-DD>/<会话>/`
     *   - 投影缓存      `<home>/storages/session_projcache/sessions/<会话>.json`
     *
     * 默认**移进回收站**（`<home>/task-folders/trash/`，带一份写明原路径的 `manifest.json`），
     * `config.trash === false` 时才真的 `rm`。搬完再把 id 从归档集合与工作区成员表里摘掉。
     *
     * 只有一条拒绝条件：会话正在干活（`workspace/session-activity` 有报告）。正在跑的会话
     * 日志被搬走，等于把这一轮工作丢掉——宁可不做，让用户先停。
     */
    async deleteSession(payload) {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (sessionId === '') throw new TaskFoldersError('bad-request', '缺少 sessionId', 400)
      // 会话 id 要参与拼路径：长度与字符先过一道，别让怪 id 把删除变成路径穿越。
      if (sessionId.length > 200) throw new TaskFoldersError('bad-request', 'sessionId 过长', 400)
      if (/^\.+$/.test(sessionId)) throw new TaskFoldersError('bad-request', 'sessionId 不能是 . 或 ..', 400)
      if (/[<>:"/\\|?*\u0000-\u001f]/.test(sessionId)) {
        throw new TaskFoldersError('bad-request', 'sessionId 含有路径字符', 400)
      }

      const activity = await sessionActivity(sessionId)
      if (activity !== '') {
        throw new TaskFoldersError('session-active', `这会话还在干活（${activity}），先停下来再删除`, 409)
      }

      // 先收掉插件自己的写入句柄：`close()` 会 flush 一次，放在搬目录之后就等于把刚删的
      // 文件夹又写回来一个小 `session.json`。
      const binding = bindings.get(sessionId)
      const archiveDirs = new Set(archiveDirsOf(sessionId))
      if (binding !== undefined) {
        archiveDirs.add(binding.dir)
        try {
          archive.close(binding.handle)
        } catch {
          /* 关不上也继续：下面按目录搬 */
        }
        bindings.delete(sessionId)
      }

      let report
      try {
        report = removeSessionFiles({
          home,
          sessionId,
          archiveDirs: [...archiveDirs],
          archiveRoot: tasks.root,
          trash: config.trash !== false,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new TaskFoldersError('delete-failed', `删除失败：${message}`, 500)
      }

      // 会话日志是「这条会话还在不在」的权威那份：它没搬走就等于没删（lib 里已经整单放弃），
      // Windows 上最常见的成因就是 DSH 还开着这条会话、日志被攥着（rename 报 EPERM）。
      if (report.skipped.some((entry) => entry.kind === 'session')) {
        const codes = [...new Set(report.skipped.filter((entry) => entry.kind === 'session').map((entry) => entry.reason))]
        ctx.logger?.warn?.(`dsh-task-folders: 删除会话 ${sessionId} 时搬不动会话日志（${codes.join('、')}）`)
        throw new TaskFoldersError(
          'session-locked',
          '会话日志没能搬走（通常是 DSH 还开着这会话）：换个会话，或重启 DSH 之后再删',
          409,
        )
      }

      if (report.deleted !== true && report.skipped.length > 0) {
        const codes = new Set(report.skipped.map((entry) => entry.reason))
        const locked = ['EBUSY', 'EPERM', 'EACCES'].some((code) => codes.has(code))
        throw new TaskFoldersError(
          locked ? 'session-locked' : 'delete-failed',
          locked
            ? '这会话的日志正被 DSH 占用（页面上还开着它），换个会话或重启 DSH 再删'
            : `磁盘上这几处没搬走：${[...codes].join('、')}`,
          locked ? 409 : 500,
        )
      }

      const forgotten = await forgetSession(sessionId)
      const summary = describeRemoval(report)
      ctx.logger?.info?.(`dsh-task-folders: 删除会话 ${sessionId} —— ${summary}`)
      if (report.skipped.length > 0) {
        ctx.logger?.warn?.(
          `dsh-task-folders: 删除会话 ${sessionId} 时有 ${report.skipped.length} 处没搬走：${report.skipped
            .map((entry) => `${entry.path}（${entry.reason}）`)
            .join('；')}`,
        )
      }
      return {
        sessionId,
        deleted: report.deleted,
        missing: report.missing,
        trashDir: report.trashDir,
        removed: report.removed,
        skipped: report.skipped,
        forgotten,
      }
    },

    /** 在资源管理器里打开任务根目录 / 某天 / 某个会话的文件夹。 */
    async openFolder(payload) {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
      const day = typeof payload.day === 'string' ? payload.day : undefined
      let target = tasks.root
      if (day !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
        target = path.join(tasks.root, day)
        if (sessionId !== undefined) target = path.join(target, sessionId.replace(/[<>:"/\\|?*]/g, '_'))
      }
      // 护栏：只允许打开任务根目录之内的路径。
      if (!isInside(tasks.root, target) && path.resolve(tasks.root) !== path.resolve(target)) {
        throw new TaskFoldersError('forbidden', '目标不在任务根目录内', 403)
      }
      if (!fs.existsSync(target)) throw new TaskFoldersError('not-found', `路径不存在：${target}`, 404)
      if (!revealDirectory(target)) throw new TaskFoldersError('open-failed', '无法打开文件夹', 500)
      return { path: target, opened: true }
    },

    /** 自检：面板与调试都用得到。 */
    async describe() {
      const records = await gatherRecords()
      await ensureTaskWorkspace(records)
      const value = buildState({
        root: tasks.root,
        taskWorkspaceId,
        records,
        workspaces: registryList(),
        liveIds: liveSessionIds(),
        archivedIds: archivedSessionIds(),
        archivedWorkspaces: new Set(projects.list()),
        canCreate: typeof registry()?.create === 'function',
      })
      return {
        tasksRoot: tasks.root,
        taskWorkspaceId,
        canCreateWorkspace: value.canCreate,
        dayGroups: value.dayGroups.map((group) => ({ day: group.day, sessions: group.sessions.length })),
        archivedDayGroups: value.archivedDayGroups.map((group) => ({
          day: group.day,
          sessions: group.sessions.length,
        })),
        archivedProjects: projects.list(),
        projectArchiveFile: projects.file,
        trashRoot: trashRoot(home),
        trashMode: config.trash !== false,
        workspaces: value.workspaces.map((workspace) => ({ id: workspace.id, title: workspace.title, path: workspace.path })),
        taskAreas: registryList()
          .filter((entity) => typeof entity?.path === 'string' && tasks.isTaskPath(entity.path))
          .map((entity) => ({ id: String(entity.id), title: entity.title, path: entity.path, sessions: entity.sessionIds?.length ?? 0 })),
        bindings: [...bindings.values()].map((binding) => ({ dir: binding.dir, day: binding.day })),
        layout: '<tasksRoot>/<YYYY-MM-DD>/<会话>/session.v4.jsonl.zstd',
      }
    },
  }

  // ---- 事件接线（全部走 ctx.effect，插件卸载即回收） ----
  ctx.effect(
    () =>
      ctx.on('session/created', (session) => {
        try {
          handleSessionCreated(session)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`dsh-task-folders: session/created 处理失败：${message}`)
        }
      }),
    'dsh-task-folders: session/created',
  )

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          handleSessionEvent(session, event)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`dsh-task-folders: session/event 处理失败：${message}`)
        }
      }),
    'dsh-task-folders: session/event',
  )

  ctx.effect(
    () =>
      ctx.on('api-session/added', (summary) => {
        try {
          const sessionId = summary?.sessionId ?? summary?.id
          const title = summary?.title
          if (typeof sessionId !== 'string' || typeof title !== 'string' || title.trim() === '') return
          const binding = bindings.get(sessionId)
          if (binding !== undefined) archive.setTitle(binding.handle, title)
        } catch {
          /* 标题只是元数据 */
        }
      }),
    'dsh-task-folders: api-session/added',
  )

  // 插件卸载 / 进程退出前把缓冲区落盘。
  ctx.effect(
    () => () => {
      try {
        archive.closeAll()
      } catch {
        /* 卸载路径不抛 */
      }
    },
    'dsh-task-folders: flush on dispose',
  )

  // 回收站保留 30 天：开机顺手清一遍过期的（每次删除也会清一次）。
  ctx.effect(
    () => {
      try {
        const result = pruneTrash({ home })
        if (result.removed.length > 0) {
          ctx.logger?.info?.(`dsh-task-folders: 清理回收站 ${result.removed.length} 项（超过 30 天的删除记录）`)
        }
      } catch {
        /* 回收站清理失败不影响任何东西 */
      }
      return () => {}
    },
    'dsh-task-folders: trash retention',
  )

  // v0.4：把任务根目录登记成「任务」工作区（= 任务默认工作区）。
  // 注册表（含它自己的一次性历史引导）可能晚于本插件就绪：就绪前每 250ms 重试，
  // 拿到 id 就收手；面板每次 state 也会顺手 ensure 一次，所以错过这里也不影响。
  ctx.effect(
    () => {
      let attempts = 0
      let timer
      const kick = () => {
        void ensureTaskWorkspace([]).then(
          () => {
            if (taskWorkspaceId !== '' || attempts >= 40) return
            attempts += 1
            timer = setTimeout(kick, 250)
            if (typeof timer.unref === 'function') timer.unref()
          },
          () => {
            /* 注册表没就绪：面板轮询时会再试 */
          },
        )
      }
      kick()
      return () => {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
    'dsh-task-folders: task workspace',
  )

  /** 路由可信校验（与 dsh-usage-panel 同一套）。 */
  const admits = (req) => {
    try {
      return ctx.connection.requestRejection(req) === undefined
    } catch {
      return false
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (!admits(req)) {
            writeFailure(res, 403, 'forbidden', 'forbidden')
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          if (!pathname.startsWith(`${API_PREFIX}/`)) {
            writeFailure(res, 404, 'not-found', 'unknown endpoint')
            return
          }
          const method = pathname.slice(API_PREFIX.length + 1)
          if (method.includes('/') || !Object.hasOwn(operations, method)) {
            writeFailure(res, 404, 'not-found', `unknown method "${method}"`)
            return
          }
          if (req.method !== 'POST') {
            writeFailure(res, 405, 'method-not-allowed', 'POST required')
            return
          }
          try {
            const payload = await readJsonBody(req)
            const value = await operations[method](payload)
            writeJson(res, 200, { ok: true, value })
          } catch (error) {
            if (error instanceof TaskFoldersError) {
              writeFailure(res, error.status, error.code, error.message)
              return
            }
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger?.warn?.(`dsh-task-folders: ${method} 失败：${message}`)
            writeFailure(res, 500, 'internal', message)
          }
        },
      }),
    'dsh-task-folders: /task-folders/api routes',
  )
}

/**
 * 把配置里的 tasksRoot 解析成绝对路径；支持 `~` 前缀。
 * @param {string} value - 配置值。
 * @param {string} home - DSH home。
 * @returns {string} 绝对路径。
 */
function tasksRootValue(value, home) {
  const trimmed = value.trim()
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return path.join(home, trimmed.slice(2))
  return trimmed
}
