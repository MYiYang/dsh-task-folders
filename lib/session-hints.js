/**
 * 「指令会话」的标题提示（v0.12）。
 *
 * DSH 的标题服务只认 `user/message` 且 `source.kind === 'user'` 的第一条提示词。用**指令**
 * 开的会话（`/goal …`、`/permission …` 这类 `command/run`）没有这样一条消息，于是
 * `sessions.list` 快照里永远没有持久标题，`displayTitle` 退回成 cwd 的目录名——侧栏里
 * 看到的就是**项目名**，而不是人刚敲的那句指令。
 *
 * 插件不去改 DSH 的会话标题（那是 DSH 自己的事实），只记一份**展示用**的提示，按优先级：
 *
 *   持久标题（`projectionValues.title`） > 指令文本提示 > 「未命名」
 *
 * 提示从事件流里取：
 *   - `goal/change` 的 `goal.objective`（最干净的那份文本）；
 *   - `command/run` 里 `name === 'goal'` 的 `args`（同一句话的另一种到达方式）。
 *
 * 落盘到 `<home>/task-folders/session-hints.json`，重启后还在：
 *
 *   {"version":1,"hints":[{"id":"session-…","title":"日志输出如下…","at":1794…}]}
 *
 * 三条底线（与 project-archive 同款）：
 *   1. **只影响侧栏怎么画**：不写会话日志、不改 DSH 的标题；
 *   2. **坏文件不炸**：读不出 / 不是 JSON / 结构不对，一律当没有提示；
 *   3. **写不进去也不炸**：临时文件 + rename，失败只记 warn。
 *
 * 纯逻辑（只依赖 fs / path），可脱离 ctx 单测。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 文件格式版本。 */
const FORMAT_VERSION = 1

/** 默认最多记多少条提示（超出按时间丢最老的；侧栏只画得到一小撮会话）。 */
const DEFAULT_LIMIT = 500

/** 标题提示的最大长度（按码点；再长侧栏也展示不完）。 */
const MAX_TITLE = 80

/** 常见「不是标题」的指令名：参数是配置值，不适合拿来当标题。 */
const CHORE_COMMANDS = new Set(['permission', 'model', 'balance', 'pet', 'approve', 'sandbox'])

/**
 * 把一段指令文本压成一行可用的标题提示。
 *
 * 只取第一行（`/goal` 后面经常跟一大段日志 / 多行说明），折叠空白、去掉包裹的反引号，
 * 过长截断加省略号；空文本返回空串（调用方据此当成「没有提示」）。
 * @param {unknown} value - 原始文本。
 * @returns {string} 标题提示。
 */
export function cleanTitleHint(value) {
  if (typeof value !== 'string') return ''
  const firstLine = value.split(/\r?\n/u).find((line) => line.trim() !== '') ?? ''
  const collapsed = firstLine.replace(/\s+/gu, ' ').trim().replace(/^`+|`+$/gu, '').trim()
  if (collapsed === '') return ''
  const points = Array.from(collapsed)
  if (points.length <= MAX_TITLE) return collapsed
  return `${points.slice(0, MAX_TITLE - 1).join('')}…`
}

/**
 * 从一条会话事件里取「标题提示」（没有就是 undefined）。
 * @param {unknown} event - 会话事件。
 * @returns {string|undefined} 标题提示。
 */
export function titleHintOfEvent(event) {
  try {
    if (event === null || typeof event !== 'object') return undefined
    if (event.type === 'goal/change') {
      const objective = event.data?.goal?.objective
      const hint = cleanTitleHint(objective)
      return hint === '' ? undefined : hint
    }
    if (event.type === 'command/run') {
      const name = event.data?.name
      if (typeof name !== 'string' || CHORE_COMMANDS.has(name)) return undefined
      const hint = cleanTitleHint(event.data?.args)
      return hint === '' ? undefined : hint
    }
  } catch {
    /* 事件形状不认识就当没有提示 */
  }
  return undefined
}

/**
 * 建一个「指令会话标题提示」存储。
 * @param {object} input - 依赖。
 * @param {string} input.file - JSON 文件绝对路径。
 * @param {number} [input.limit] - 最多保留多少条。
 * @param {() => number} [input.now] - 时钟（测试用）。
 * @param {{warn?: Function, info?: Function}} [input.logger] - 日志。
 * @returns {object} 存储 API。
 */
export function createSessionHints(input) {
  const file = path.resolve(input.file)
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? Math.floor(Number(input.limit)) : DEFAULT_LIMIT
  const now = typeof input.now === 'function' ? input.now : Date.now
  const logger = input.logger

  /** 会话 id → `{title, at}`（第一次读盘后填上）。 */
  let cache

  /**
   * 读盘；任何异常都退化成空表。
   * @returns {Map<string, {title: string, at: number}>} 提示表。
   */
  function readDisk() {
    const table = new Map()
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`dsh-task-folders: 读会话标题提示失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return table
    }
    try {
      const parsed = JSON.parse(text)
      for (const row of Array.isArray(parsed?.hints) ? parsed.hints : []) {
        const id = typeof row?.id === 'string' ? row.id.trim() : ''
        const title = cleanTitleHint(row?.title)
        if (id === '' || title === '') continue
        const at = typeof row?.at === 'number' && Number.isFinite(row.at) ? row.at : 0
        table.set(id, { title, at })
      }
    } catch {
      logger?.warn?.('dsh-task-folders: 会话标题提示文件不是合法 JSON，按空表处理')
    }
    return table
  }

  /**
   * 当前提示表（第一次调用读盘，之后走内存）。
   * @returns {Map<string, {title: string, at: number}>} 提示表。
   */
  function table() {
    if (cache === undefined) cache = readDisk()
    return cache
  }

  /**
   * 写盘：临时文件 + rename，避免半截 JSON。
   * @param {Map<string, {title: string, at: number}>} values - 提示表。
   * @returns {boolean} 是否写成功。
   */
  function writeDisk(values) {
    const rows = [...values.entries()]
      .map(([id, entry]) => ({ id, title: entry.title, at: entry.at }))
      .sort((left, right) => right.at - left.at)
      .slice(0, limit)
    const body = `${JSON.stringify({ version: FORMAT_VERSION, hints: rows }, null, 2)}\n`
    const temporary = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(temporary, body, 'utf8')
      fs.renameSync(temporary, file)
      return true
    } catch (error) {
      logger?.warn?.(`dsh-task-folders: 写会话标题提示失败：${error instanceof Error ? error.message : String(error)}`)
      try {
        fs.rmSync(temporary, { force: true })
      } catch {
        /* 临时文件清不掉无所谓 */
      }
      return false
    }
  }

  return {
    /** 落盘文件路径（自检用）。 */
    file,

    /**
     * 一条会话的标题提示。
     * @param {unknown} sessionId - 会话 id。
     * @returns {string} 提示；没有就是空串。
     */
    get(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return ''
      return table().get(sessionId)?.title ?? ''
    },

    /**
     * 记一条提示（幂等：同标题不重复写盘）。
     * @param {unknown} sessionId - 会话 id。
     * @param {unknown} title - 标题提示。
     * @returns {boolean} 是否真的发生了变化。
     */
    set(sessionId, title) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') return false
      const cleaned = cleanTitleHint(title)
      if (cleaned === '') return false
      const id = sessionId.trim()
      const current = table()
      const previous = current.get(id)
      const at = now()
      if (previous !== undefined && previous.title === cleaned) {
        previous.at = at
        return false
      }
      current.set(id, { title: cleaned, at })
      // 超出上限就丢最老的（按 at 排序后的尾巴）。
      if (current.size > limit) {
        const ordered = [...current.entries()].sort((left, right) => right[1].at - left[1].at)
        cache = new Map(ordered.slice(0, limit))
      }
      writeDisk(cache)
      return true
    },

    /**
     * 忘掉一条会话的提示（DSH 生成真标题 / 删除会话时用）。
     * @param {unknown} sessionId - 会话 id。
     * @returns {boolean} 是否真的删掉了。
     */
    forget(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      const current = table()
      if (!current.delete(sessionId)) return false
      writeDisk(current)
      return true
    },

    /**
     * 全部提示（侧栏状态用）。
     * @returns {Record<string, string>} 会话 id → 标题提示。
     */
    snapshot() {
      const result = {}
      for (const [id, entry] of table()) result[id] = entry.title
      return result
    },
  }
}
