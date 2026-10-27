/**
 * 会话存档写入器：把一条会话的聊天记录写成 **DSH 默认格式**。
 *
 * 格式与 `$DSH_HOME/sessions/<工作区>/<会话>/session.v4.jsonl.zstd` 完全一致：
 *
 *   - 第一帧：一行头部 `{"type":"session","version":4,"id":…,"cwd":…}`
 *   - 之后每帧：一批事件行 `{"type":"user/message","seq":N,"time":…,"data":{…}}`
 *   - 整个文件是**多帧 zstd 的拼接**，所以可以一直 append，不必重写历史。
 *
 * 选择这个格式（而不是自造的 Markdown）是因为：它是 DSH 自己的会话存档格式，
 * 任何已经会读 DSH 会话日志的工具（例如 dsh-usage-panel 的扫描器）都能直接读它；
 * 反过来，我们自己恢复 `lastSeq` 也只需解一遍自己的文件。
 *
 * 所有失败都只记日志：写不出存档不该影响会话本身。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { SESSION_FILE, SESSION_FORMAT, SESSION_LOG_FILE } from './paths.js'

/** zstd 帧魔数 `28 b5 2f fd`。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 超过这个体积就不做「从日志恢复 lastSeq」，改信 session.json（避免开机解大文件）。 */
const RECOVER_SIZE_LIMIT = 64 * 1024 * 1024

/**
 * 把可能由多个 zstd 帧拼接而成的缓冲区解开。
 * `zlib.zstdDecompressSync()` 只解第一帧，所以按魔数切分逐帧解。
 * @param {Buffer} buffer - 文件内容。
 * @returns {string} 解码后的 UTF-8 文本（失败帧被跳过）。
 */
export function inflateFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return ''
  const offsets = []
  let cursor = buffer.indexOf(ZSTD_MAGIC, 0)
  while (cursor !== -1) {
    offsets.push(cursor)
    cursor = buffer.indexOf(ZSTD_MAGIC, cursor + ZSTD_MAGIC.length)
  }
  if (offsets.length === 0) {
    try {
      return zlib.zstdDecompressSync(buffer).toString('utf8')
    } catch {
      return ''
    }
  }
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      /* 假魔数或残帧：跳过 */
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * 把若干行压成一帧。
 * @param {string[]} lines - 要写入的行（不含换行符）。
 * @returns {Buffer} zstd 帧。
 */
export function frameOf(lines) {
  const text = `${lines.join('\n')}\n`
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
}

/**
 * 解析一个 JSONL 文件内容里的最大 `seq`。
 * @param {string} text - 解码后的 JSONL 文本。
 * @returns {number} 最大 seq；没有任何事件行时 -1（表示「还什么都没写」）。
 */
function maxSeqOf(text) {
  let max = -1
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('{"type":"session"')) continue
    try {
      const record = JSON.parse(line)
      if (typeof record?.seq === 'number' && record.seq > max) max = record.seq
    } catch {
      /* 残缺行：忽略 */
    }
  }
  return max
}

/**
 * 建一个会话存档写入器。
 * @param {object} [options] - 依赖注入（测试用）。
 * @param {object} [options.logger] - DSH 的 ctx.logger。
 * @param {() => number} [options.now] - 时钟。
 * @param {number} [options.flushDelayMs] - 攒批时间窗，默认 300ms。
 * @param {number} [options.flushBatchSize] - 攒到多少行立刻落盘，默认 64。
 * @param {boolean} [options.recoverFromLog] - 是否从日志恢复 lastSeq，默认 true。
 * @returns {object} 写入器 API。
 */
export function createSessionArchive(options = {}) {
  const logger = options.logger
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const flushDelayMs = Number.isFinite(options.flushDelayMs) ? Math.max(0, options.flushDelayMs) : 300
  const flushBatchSize = Number.isFinite(options.flushBatchSize) ? Math.max(1, options.flushBatchSize) : 64
  const recoverFromLog = options.recoverFromLog !== false

  /** @type {Map<string, object>} 目录 → 打开的句柄 */
  const handles = new Map()

  /**
   * 会话元数据路径。
   * @param {string} dir - 会话文件夹。
   * @returns {string} 绝对路径。
   */
  const metaPathOf = (dir) => path.join(dir, SESSION_FILE)

  /**
   * 会话日志路径。
   * @param {string} dir - 会话文件夹。
   * @returns {string} 绝对路径。
   */
  const logPathOf = (dir) => path.join(dir, SESSION_LOG_FILE)

  /**
   * 读会话元数据；坏文件当没有。
   * @param {string} dir - 会话文件夹。
   * @returns {object|undefined} 元数据。
   */
  function readMeta(dir) {
    try {
      const text = fs.readFileSync(metaPathOf(dir), 'utf8')
      const parsed = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 写会话元数据（原子写）。
   * @param {string} dir - 会话文件夹。
   * @param {object} meta - 元数据。
   */
  function writeMeta(dir, meta) {
    fs.mkdirSync(dir, { recursive: true })
    const target = metaPathOf(dir)
    const temporary = `${target}.tmp-${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, target)
  }

  /**
   * 从日志里恢复最大 seq（崩溃后 session.json 可能落后于日志）。
   * @param {string} dir - 会话文件夹。
   * @returns {number|undefined} 恢复到的 seq（没写过事件时 -1）；读不了时 undefined。
   */
  function recoverLastSeq(dir) {
    if (!recoverFromLog) return undefined
    const log = logPathOf(dir)
    try {
      const stat = fs.statSync(log)
      if (stat.size === 0 || stat.size > RECOVER_SIZE_LIMIT) return undefined
      return maxSeqOf(inflateFrames(fs.readFileSync(log)))
    } catch {
      return undefined
    }
  }

  /**
   * 打开（或复用）一个会话文件夹的写入器。
   * @param {object} input - 打开参数。
   * @param {string} input.dir - 会话文件夹绝对路径。
   * @param {object} input.header - 会话头（DSH 的 SessionHeader 或等价对象）。
   * @param {object} [input.task] - 任务信息 `{id, title}`，写进 session.json。
   * @param {string} [input.workspace] - 工作区绝对路径。
   * @param {string} [input.day] - `YYYY-MM-DD`。
   * @param {string} [input.title] - 会话标题。
   * @param {number} [input.startSeq] - 已写到的 seq（-1 表示还没写过）；省略则从日志/元数据恢复。
   * @returns {object} 句柄。
   */
  function open(input) {
    const dir = path.resolve(input.dir)
    const existing = handles.get(dir)
    if (existing !== undefined) {
      if (input.title !== undefined && input.title !== '') existing.meta.title = input.title
      return existing
    }
    fs.mkdirSync(dir, { recursive: true })
    const log = logPathOf(dir)
    const previous = readMeta(dir)
    const recovered = input.startSeq === undefined ? recoverLastSeq(dir) : undefined
    const knownLast = typeof previous?.lastSeq === 'number' ? previous.lastSeq : -1
    // lastSeq 是「已经写进日志的最后一条 seq」；-1 表示一条都还没写。
    const lastSeq = Number.isFinite(input.startSeq) ? Number(input.startSeq) : Math.max(knownLast, recovered ?? -1)
    const header = input.header ?? {}
    const meta = {
      format: SESSION_FORMAT,
      sessionId: String(header.id ?? path.basename(dir)),
      title: typeof input.title === 'string' && input.title !== '' ? input.title : typeof previous?.title === 'string' ? previous.title : '',
      cwd: typeof header.cwd === 'string' ? header.cwd : typeof previous?.cwd === 'string' ? previous.cwd : undefined,
      task: input.task ?? previous?.task,
      workspace: input.workspace ?? previous?.workspace,
      day: input.day ?? previous?.day,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : (previous?.createdAt ?? now()),
      updatedAt: now(),
      lastSeq,
      log: SESSION_LOG_FILE,
    }
    const fresh = !fs.existsSync(log) || fs.statSync(log).size === 0
    if (fresh) {
      // 第一帧就是 DSH 的会话头：`type` 前置，其余字段与 SessionHeader 一致。
      const headerLine = JSON.stringify({ type: 'session', ...header })
      fs.writeFileSync(log, frameOf([headerLine]))
    }
    writeMeta(dir, meta)
    const handle = {
      dir,
      log,
      meta,
      header,
      nextSeq: lastSeq + 1,
      pending: [],
      timer: undefined,
      closed: false,
    }
    handles.set(dir, handle)
    return handle
  }

  /**
   * 用真实会话头纠正「打开时还没有会话对象」写下的占位头。
   * 只在一条事件都还没写过时允许（头部是第一帧，写进事件后就不能回头改了）。
   * @param {object} handle - 句柄。
   * @param {object} header - 真实会话头。
   * @returns {'locked'|'rewritten'|'same'} 结果。
   */
  function setHeader(handle, header) {
    if (handle.closed) return 'locked'
    if (handle.meta.lastSeq > -1 || handle.pending.length > 0) return 'locked'
    const before = JSON.stringify({ type: 'session', ...(handle.header ?? {}) })
    const after = JSON.stringify({ type: 'session', ...(header ?? {}) })
    if (before === after) return 'same'
    try {
      fs.writeFileSync(handle.log, frameOf([after]))
      handle.header = header
      handle.meta.createdAt = typeof header.createdAt === 'number' ? header.createdAt : handle.meta.createdAt
      handle.meta.cwd = typeof header.cwd === 'string' ? header.cwd : handle.meta.cwd
      handle.meta.sessionId = String(header.id ?? handle.meta.sessionId)
      handle.meta.updatedAt = now()
      writeMeta(handle.dir, handle.meta)
      return 'rewritten'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`dsh-task-folders: 纠正会话头失败（${handle.dir}）：${message}`)
      return 'locked'
    }
  }

  /**
   * 把事件对象序列化成日志行；无法序列化的事件跳过。
   * @param {unknown} event - SessionEvent。
   * @returns {string|undefined} 一行 JSON。
   */
  function lineOf(event) {
    try {
      return JSON.stringify(event)
    } catch {
      return undefined
    }
  }

  /**
   * 落盘窗口到期时把缓冲区写成一帧。
   * @param {object} handle - 句柄。
   */
  function flush(handle) {
    if (handle.timer !== undefined) {
      clearTimeout(handle.timer)
      handle.timer = undefined
    }
    if (handle.pending.length === 0) return
    const lines = handle.pending
    handle.pending = []
    try {
      fs.appendFileSync(handle.log, frameOf(lines))
      handle.meta.lastSeq = Math.max(handle.meta.lastSeq, handle.nextSeq - 1)
      handle.meta.updatedAt = now()
      writeMeta(handle.dir, handle.meta)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`dsh-task-folders: 写会话存档失败（${handle.dir}）：${message}`)
    }
  }

  /**
   * 安排一次延迟落盘。
   * @param {object} handle - 句柄。
   */
  function schedule(handle) {
    if (handle.timer !== undefined) return
    const timer = setTimeout(() => {
      handle.timer = undefined
      flush(handle)
    }, flushDelayMs)
    if (typeof timer.unref === 'function') timer.unref()
    handle.timer = timer
  }

  /**
   * 追加一批事件。按 seq 去重：句柄已经写过的 seq 会被忽略。
   * @param {object} handle - 句柄。
   * @param {readonly object[]} events - 事件数组。
   * @returns {number} 实际排入缓冲的事件数。
   */
  function append(handle, events) {
    if (handle.closed || !Array.isArray(events) || events.length === 0) return 0
    let queued = 0
    for (const event of events) {
      const seq = typeof event?.seq === 'number' ? event.seq : undefined
      // 逐条推进 nextSeq：日志里永远是单调递增的 seq，乱序/重复投递都不会写第二遍。
      if (seq !== undefined && seq < handle.nextSeq) continue
      const line = lineOf(event)
      if (line === undefined) {
        if (seq !== undefined) handle.nextSeq = seq + 1
        continue
      }
      handle.pending.push(line)
      queued += 1
      if (seq !== undefined) handle.nextSeq = seq + 1
    }
    if (queued > 0) {
      if (handle.pending.length >= flushBatchSize) flush(handle)
      else schedule(handle)
    }
    return queued
  }

  /**
   * 记录/更新会话标题。标题先落元数据，日志里的 `session/title` 事件随后自然到达。
   * @param {object} handle - 句柄。
   * @param {string} title - 新标题。
   */
  function setTitle(handle, title) {
    if (typeof title !== 'string' || title.trim() === '') return
    if (handle.meta.title === title) return
    handle.meta.title = title.trim()
    handle.meta.updatedAt = now()
    try {
      writeMeta(handle.dir, handle.meta)
    } catch {
      /* 标题写不进去不影响日志 */
    }
  }

  /**
   * 关闭一个句柄（先落盘）。
   * @param {object} handle - 句柄。
   */
  function close(handle) {
    if (handle.closed) return
    flush(handle)
    handle.closed = true
    handles.delete(handle.dir)
  }

  /**
   * 关闭全部句柄（插件卸载 / 进程退出时调用）。
   */
  function closeAll() {
    for (const handle of [...handles.values()]) close(handle)
  }

  return { open, append, flush, setTitle, setHeader, close, closeAll, readMeta, writeMeta, logPathOf, metaPathOf, handles }
}
