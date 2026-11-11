/**
 * 会话「最后活动时间」索引（v0.12）。
 *
 * 为什么不能直接用 DSH 的 `updatedAt`：它被定义成
 * `Math.max(header.createdAt, metadata.lastPromptAt ?? 0)`，而 `lastPromptAt` **只**在
 * `user/message` 且 `source.kind === 'user'` 时更新（dsh-api-session-controller 的
 * `list.js`）。用「指令」（`/goal`、`/permission` 这类 `command/run`）开的会话一条这样
 * 的消息都没有：
 *
 *   - 没有 `user/message` → 标题服务不生成持久标题（`session/title` 缺席）；
 *   - 没有 `lastPromptAt` → `updatedAt` 永远停在**创建时刻**。
 *
 * 于是侧栏要么把它画在很久以前的位置、要么把创建日期当成「最近一次说话」。而用户刚在
 * 这条会话里跑完几轮，明明是最新的。
 *
 * 这里另算一份真正的「最后活动时间」，三个来源取最大：
 *   1. **活会话的事件流**（{@link createActivityIndex} 的 `note`）：`event.time`，进程内即时；
 *   2. **DSH 会话日志的 mtime**：`<home>/sessions/<转义 cwd>/<会话>/session.v4.jsonl.zstd`，
 *      进程重启后也认得出（会话目录名就是会话 id，不用复刻 cwd 的转义规则）；
 *   3. 插件自己的按天副本 `session.json.updatedAt`（任务区会话；调用方自己并进来）。
 *
 * 磁盘索引按 `ttlMs` 缓存：全量扫一遍这台机器 360+ 条会话约 40ms，8 秒轮询一次没必要
 * 每次都扫；活会话的时间由 `note` 即时补上，所以缓存不会让「刚跑完」的那条迟到。
 *
 * 纯逻辑（只依赖 fs / path），可脱离 ctx 单测。
 */
import fs from 'node:fs'
import path from 'node:path'

/** DSH 会话日志可能的文件名（压缩 / 未压缩都认）。 */
const LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl']

/** 默认磁盘索引缓存时长（毫秒）。 */
const DEFAULT_TTL_MS = 30_000

/**
 * 列一个目录下的子目录名；读不了就是空。
 * @param {string} dir - 目录绝对路径。
 * @returns {string[]} 子目录名。
 */
function childDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 一个会话目录的「最后活动时间」：优先日志文件 mtime（内容变化才会动），
 * 没有日志文件时退回目录 mtime。
 * @param {string} dir - 会话目录绝对路径。
 * @returns {number} epoch 毫秒；拿不到是 0。
 */
function dirActivity(dir) {
  let newest = 0
  for (const name of LOG_NAMES) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs)
    } catch {
      /* 这个文件名不存在，试下一个 */
    }
  }
  if (newest > 0) return newest
  try {
    return fs.statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 建一个「最后活动时间」索引。
 * @param {object} input - 依赖。
 * @param {string} input.home - DSH home（会话日志在 `<home>/sessions` 下）。
 * @param {number} [input.ttlMs] - 磁盘索引缓存时长，默认 30 秒。
 * @param {() => number} [input.now] - 时钟（测试用）。
 * @param {{warn?: Function}} [input.logger] - 日志。
 * @returns {object} 索引 API。
 */
export function createActivityIndex(input) {
  const home = path.resolve(input.home)
  const sessionsRoot = path.join(home, 'sessions')
  const ttlMs = Number.isFinite(input.ttlMs) && input.ttlMs >= 0 ? Number(input.ttlMs) : DEFAULT_TTL_MS
  const now = typeof input.now === 'function' ? input.now : Date.now
  const logger = input.logger

  /** 活会话事件流里看到的时间（会话 id → epoch 毫秒）。 */
  const notes = new Map()
  /** 磁盘索引（会话 id → 日志 mtime）。 */
  let disk = new Map()
  /** 磁盘索引是什么时候扫的（`-Infinity` = 还没扫过）。 */
  let scannedAt = Number.NEGATIVE_INFINITY

  /**
   * 全量扫一遍 `<home>/sessions/<分组>/<会话>/`。
   * @returns {Map<string, number>} 会话 id → 最后活动时间。
   */
  function scan() {
    const found = new Map()
    for (const group of childDirs(sessionsRoot)) {
      const groupDir = path.join(sessionsRoot, group)
      for (const sessionId of childDirs(groupDir)) {
        const time = dirActivity(path.join(groupDir, sessionId))
        if (time <= 0) continue
        const previous = found.get(sessionId)
        if (previous === undefined || time > previous) found.set(sessionId, time)
      }
    }
    return found
  }

  /**
   * 需要时刷新磁盘索引。
   * @param {boolean} [force] - 无视缓存强制重扫。
   * @returns {Map<string, number>} 磁盘索引。
   */
  function refresh(force = false) {
    const stamp = now()
    if (force || stamp - scannedAt >= ttlMs) {
      try {
        disk = scan()
        scannedAt = stamp
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger?.warn?.(`dsh-task-folders: 扫会话日志时间失败：${message}`)
        scannedAt = stamp
      }
    }
    return disk
  }

  /**
   * 记下一条活会话刚刚发生了事件。
   * @param {unknown} sessionId - 会话 id。
   * @param {unknown} time - 事件时间（epoch 毫秒）；不是数字时用当前时间。
   * @returns {void}
   */
  function note(sessionId, time) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const stamp = typeof time === 'number' && Number.isFinite(time) ? time : now()
    const previous = notes.get(sessionId)
    if (previous === undefined || stamp > previous) notes.set(sessionId, stamp)
  }

  /**
   * 一条会话的最后活动时间（磁盘索引 + 活会话事件取最大）。
   * @param {string} sessionId - 会话 id。
   * @returns {number} epoch 毫秒；拿不到是 0。
   */
  function get(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return 0
    const fromDisk = refresh().get(sessionId) ?? 0
    const fromNotes = notes.get(sessionId) ?? 0
    return Math.max(fromDisk, fromNotes)
  }

  /**
   * 所有已知会话的最后活动时间（快照，调用方随便改）。
   * @returns {Map<string, number>} 会话 id → epoch 毫秒。
   */
  function snapshot() {
    const merged = new Map(refresh())
    for (const [id, time] of notes) {
      const previous = merged.get(id) ?? 0
      if (time > previous) merged.set(id, time)
    }
    return merged
  }

  /**
   * 忘掉一条会话（删除会话时用）：活会话时间与磁盘索引一起摘掉，
   * 否则删掉的 id 还会在缓存里挂着，直到下次重扫。
   * @param {string} sessionId - 会话 id。
   * @returns {void}
   */
  function forget(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    notes.delete(sessionId)
    if (disk.has(sessionId)) {
      const next = new Map(disk)
      next.delete(sessionId)
      disk = next
    }
  }

  return {
    /** 会话日志根目录（自检用）。 */
    root: sessionsRoot,
    /** 索引缓存时长（自检用）。 */
    ttlMs,
    note,
    get,
    snapshot,
    refresh,
    forget,
  }
}
