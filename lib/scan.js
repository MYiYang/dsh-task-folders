/**
 * 扫描任务根目录下的按天会话存档。
 *
 * 没有索引文件：`<tasksRoot>/<YYYY-MM-DD>/<会话>/session.json` 本身就是唯一事实，
 * 目录被手删、被拷来拷去都读得回来，也不会出现「索引说有、磁盘上没有」的鬼账。
 *
 * 两种布局都认：
 *   - v0.3 及以后：`<root>/<YYYY-MM-DD>/<会话>/`
 *   - v0.2 的遗留任务容器：`<root>/<容器>/<YYYY-MM-DD>/<会话>/`（容器名不是日期的那种目录）
 * 同一会话只出现一次：新布局优先，旧布局只补新布局里没有的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { SESSION_FILE, SESSION_LOG_FILE, isDayKey } from './paths.js'

/**
 * 读一个小 JSON 文件；坏文件当没有。
 * @param {string} file - 绝对路径。
 * @returns {any} 解析结果或 undefined。
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 取文件字节数（拿不到就 0）。
 * @param {string} file - 绝对路径。
 * @returns {number} 字节数。
 */
function sizeOf(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * 列一个目录下的子目录名；读不了就是空。
 * @param {string} dir - 目录绝对路径。
 * @returns {string[]} 子目录名数组。
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
 * 扫一个「按天文件夹」里的会话。
 * @param {string} dayPath - 按天文件夹绝对路径。
 * @param {string} day - `YYYY-MM-DD`。
 * @param {Set<string>} liveIds - 当前存活会话 id。
 * @returns {object[]} 会话条目数组。
 */
function scanDay(dayPath, day, liveIds) {
  const sessions = []
  for (const name of childDirs(dayPath)) {
    const dir = path.join(dayPath, name)
    const meta = readJson(path.join(dir, SESSION_FILE))
    const id = typeof meta?.sessionId === 'string' && meta.sessionId !== '' ? meta.sessionId : name
    sessions.push({
      id,
      title: typeof meta?.title === 'string' ? meta.title : '',
      day,
      dir: `${day}/${name}`,
      path: dir,
      createdAt: typeof meta?.createdAt === 'number' ? meta.createdAt : 0,
      updatedAt: typeof meta?.updatedAt === 'number' ? meta.updatedAt : 0,
      lastSeq: typeof meta?.lastSeq === 'number' ? meta.lastSeq : -1,
      bytes: sizeOf(path.join(dir, SESSION_LOG_FILE)),
      live: liveIds.has(id),
    })
  }
  sessions.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
  return sessions
}

/**
 * 扫描任务根目录：新布局（`<root>/<天>/<会话>/`）+ 旧任务容器（`<root>/<容器>/<天>/<会话>/`）。
 * @param {string} root - 任务根目录绝对路径。
 * @param {{liveIds?: Set<string>}} [options] - 当前存活会话 id。
 * @returns {{days: object[], dayCount: number, sessionCount: number, byId: Map<string, object>}}
 *   归档结构（天与天按日期倒序，`byId` 按会话 id 索引，新布局优先）。
 */
export function scanSessionsRoot(root, options = {}) {
  const liveIds = options.liveIds instanceof Set ? options.liveIds : new Set()
  /** @type {Map<string, object>} 会话 id → 条目（新布局优先，旧布局只补缺） */
  const byId = new Map()

  // 先旧布局（容器），后新布局（按天文件夹）：同 id 后者覆盖前者。
  for (const name of childDirs(root)) {
    if (isDayKey(name)) continue
    for (const day of childDirs(path.join(root, name))) {
      if (!isDayKey(day)) continue
      for (const session of scanDay(path.join(root, name, day), day, liveIds)) {
        if (!byId.has(session.id)) byId.set(session.id, session)
      }
    }
  }
  for (const day of childDirs(root)) {
    if (!isDayKey(day)) continue
    for (const session of scanDay(path.join(root, day), day, liveIds)) {
      byId.set(session.id, session)
    }
  }

  const days = new Map()
  for (const session of byId.values()) {
    if (!days.has(session.day)) days.set(session.day, [])
    days.get(session.day).push(session)
  }
  const ordered = [...days.entries()]
    .sort((left, right) => (left[0] < right[0] ? 1 : left[0] > right[0] ? -1 : 0))
    .map(([day, sessions]) => ({
      day,
      sessions: sessions.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0)),
    }))
  return {
    days: ordered,
    dayCount: ordered.length,
    sessionCount: byId.size,
    byId,
  }
}
