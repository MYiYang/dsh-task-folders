/**
 * 删除一条会话的**落盘部分**（纯 fs，不依赖 ctx，可单测）。
 *
 * DSH 自己没有「物理删除会话」这个动作：原生只给归档（`workspaceRegistry.archiveSession`，
 * 从侧栏消失、日志保留）。所以「删除」只能由插件把文件收走，一条会话在磁盘上有三处痕迹：
 *
 *   1. DSH 会话日志   <home>/sessions/<转义后的cwd>/<会话>/
 *   2. 插件的按天副本  <tasksRoot>/<YYYY-MM-DD>/<会话>/
 *   3. 投影缓存        <home>/storages/session_projcache/sessions/<会话>.json
 *
 * `<转义后的cwd>` 这层的拼法属于 DSH 内部约定（`--C-Users-…--`，非 ASCII 走 `~XXXX`），
 * 插件不去复刻它：`sessions/` 下只有「按工作目录分组」这一层，直接扫一遍、看哪个分组里
 * 有同名的会话目录即可，换个 DSH 版本也不会认错。
 *
 * 默认是**移进回收站**而不是 `rm`：删错了还能照着 `manifest.json` 搬回去。
 * 回收站 `<home>/task-folders/trash/<时间戳>-<会话>/`，超过 30 天的条目会被顺手清掉
 * （`pruneTrash`，启动与每次删除时各跑一次）。写 `<config.trash: false>` 才真的删。
 */
import fs from 'node:fs'
import path from 'node:path'
import { isInside, safeSegment } from './paths.js'

/** 回收站目录（相对 DSH home）。 */
const TRASH_RELATIVE = path.join('task-folders', 'trash')

/** 会话日志所在的父目录（相对 DSH home）。 */
const SESSIONS_RELATIVE = 'sessions'

/** 会话投影缓存目录（相对 DSH home）。 */
const PROJ_CACHE_RELATIVE = path.join('storages', 'session_projcache', 'sessions')

/** 回收站默认保留多久（毫秒）。 */
export const DEFAULT_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 两位补零。
 * @param {number} value - 0-99。
 * @returns {string} 两位字符串。
 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 回收站条目名用的时间戳：本地时区 `YYYYMMDD-HHmmss`（和按天文件夹一样不用 UTC）。
 * @param {number} time - epoch 毫秒。
 * @returns {string} 形如 `20261027-204501`。
 */
export function trashStamp(time) {
  const date = new Date(typeof time === 'number' && Number.isFinite(time) ? time : Date.now())
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  )
}

/**
 * 回收站根目录。
 * @param {string} home - DSH home。
 * @returns {string} 绝对路径。
 */
export function trashRoot(home) {
  return path.join(path.resolve(home), TRASH_RELATIVE)
}

/**
 * 列一个目录下的子目录名；读不了就是空（删除路径不该因为目录不存在而抛）。
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
 * 找一个会话的 DSH 日志目录（`<home>/sessions/<分组>/<会话>`）。
 * 分组名是转义过的 cwd，插件不复刻那套转义，直接扫一层。
 * @param {string} home - DSH home。
 * @param {string} sessionId - 会话 id。
 * @returns {string[]} 命中的目录（正常只有一条，同 id 多分组时全给出来）。
 */
export function sessionArtifactDirs(home, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return []
  const sessionsRoot = path.join(path.resolve(home), SESSIONS_RELATIVE)
  const found = []
  for (const group of childDirs(sessionsRoot)) {
    const candidate = path.join(sessionsRoot, group, sessionId)
    try {
      if (fs.statSync(candidate).isDirectory()) found.push(candidate)
    } catch {
      /* 没有就是没有 */
    }
  }
  return found
}

/**
 * 一个会话的投影缓存文件（不是目录；不存在是常态）。
 * @param {string} home - DSH home。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 绝对路径。
 */
export function projectionCacheFile(home, sessionId) {
  return path.join(path.resolve(home), PROJ_CACHE_RELATIVE, `${sessionId}.json`)
}

/**
 * 组装一条会话要处理的目标清单。每个目标都带 `root`：真正的删除动作会再校验一次
 * 「还在这个 root 里面」，防止调用方塞进来的路径把别处的数据带走。
 * @param {object} input - 入参。
 * @param {string} input.home - DSH home。
 * @param {string} input.sessionId - 会话 id。
 * @param {string[]} [input.archiveDirs] - 插件按天副本目录（调用方从扫描结果里给）。
 * @param {string} [input.archiveRoot] - 任务根目录（按天副本的合法范围）。
 * @returns {{kind: string, path: string, root: string}[]} 目标清单（只含真实存在的）。
 */
export function sessionDeleteTargets(input) {
  const home = path.resolve(input.home)
  const sessionId = String(input.sessionId ?? '')
  const targets = []
  const seen = new Set()
  /**
   * 去重后收一个目标。
   * @param {string} kind - 目标种类（session / archive / projection）。
   * @param {string} target - 绝对路径。
   * @param {string} root - 该目标的合法范围。
   */
  const push = (kind, target, root) => {
    const resolved = path.resolve(target)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) return
    seen.add(key)
    targets.push({ kind, path: resolved, root: path.resolve(root) })
  }

  for (const dir of sessionArtifactDirs(home, sessionId)) {
    push('session', dir, path.join(home, SESSIONS_RELATIVE))
  }
  const archiveRoot = typeof input.archiveRoot === 'string' ? path.resolve(input.archiveRoot) : ''
  for (const dir of Array.isArray(input.archiveDirs) ? input.archiveDirs : []) {
    if (typeof dir !== 'string' || dir === '') continue
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    push('archive', dir, archiveRoot === '' ? path.dirname(path.resolve(dir)) : archiveRoot)
  }
  const cache = projectionCacheFile(home, sessionId)
  try {
    if (fs.statSync(cache).isFile()) push('projection', cache, path.join(home, PROJ_CACHE_RELATIVE))
  } catch {
    /* 没缓存很正常 */
  }
  return targets
}

/**
 * 把一个目标搬进回收站；跨盘（EXDEV）时退化成「复制 + 删除」。
 * @param {string} from - 原路径。
 * @param {string} to - 新路径。
 * @returns {'moved'|'copied'} 搬法。
 */
function movePath(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
    return 'moved'
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    fs.cpSync(from, to, { recursive: true, force: true })
    fs.rmSync(from, { recursive: true, force: true })
    return 'copied'
  }
}

/**
 * 目标处理顺序：DSH 会话日志（权威）→ 插件按天副本 → 投影缓存（可再生）。
 * @param {string} kind - 目标种类。
 * @returns {number} 排序权重。
 */
function rank(kind) {
  if (kind === 'session') return 0
  if (kind === 'archive') return 1
  return 2
}

/**
 * 一个空的按天文件夹顺手收掉（非空或删不掉都不管）。
 * @param {string} dir - 按天文件夹。
 */
function dropEmptyDir(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    /* 目录非空 / 不存在 / 被占用：都不是错误 */
  }
}

/**
 * 删除一条会话在磁盘上的痕迹。
 *
 * 顺序讲究：先搬文件，调用方再去改注册表。反过来的话，文件搬失败时会留下
 * 「登记里已经没有、磁盘上还在」的半截状态。
 * @param {object} input - 入参。
 * @param {string} input.home - DSH home。
 * @param {string} input.sessionId - 会话 id。
 * @param {string[]} [input.archiveDirs] - 插件按天副本目录。
 * @param {string} [input.archiveRoot] - 任务根目录。
 * @param {boolean} [input.trash] - true（默认）= 移进回收站；false = 直接删。
 * @param {number} [input.now] - 时钟（测试用）。
 * @param {boolean} [input.prune] - 是否顺手清过期回收站条目，默认 true。
 * @returns {{deleted: boolean, missing: boolean, trashDir: string|null, trashed: object[], removed: object[], skipped: object[]}}
 *   报告。
 */
export function removeSessionFiles(input) {
  const now = typeof input.now === 'number' ? input.now : Date.now()
  const trashEnabled = input.trash !== false
  // DSH 的会话日志排在最前面：它是「这条会话还在不在」的唯一权威。它搬不动（Windows 上
  // DSH 还开着这条会话时 rename 会 EPERM）就整单放弃，别把别的痕迹先删了留下半截现场。
  const targets = sessionDeleteTargets(input).sort((left, right) => rank(left.kind) - rank(right.kind))
  const trashed = []
  const removed = []
  const skipped = []

  let trashDir = null
  if (trashEnabled && targets.length > 0) {
    const base = path.join(trashRoot(input.home), `${trashStamp(now)}-${safeSegment(input.sessionId, 48)}`)
    let candidate = base
    for (let index = 2; fs.existsSync(candidate) && index < 1000; index += 1) candidate = `${base}-${index}`
    trashDir = candidate
  }

  for (const target of targets) {
    // 护栏二：目标必须**严格**在它自己的 root 里面（等于 root 也不许）。
    if (!isInside(target.root, target.path)) {
      skipped.push({ kind: target.kind, path: target.path, reason: 'outside-root' })
      continue
    }
    try {
      if (trashEnabled) {
        const destination = path.join(trashDir, target.kind, path.basename(target.path))
        movePath(target.path, destination)
        trashed.push({ kind: target.kind, from: target.path, to: destination })
      } else {
        fs.rmSync(target.path, { recursive: true, force: true })
        removed.push({ kind: target.kind, path: target.path })
      }
      if (target.kind === 'archive') dropEmptyDir(path.dirname(target.path))
    } catch (error) {
      skipped.push({
        kind: target.kind,
        path: target.path,
        reason: typeof error?.code === 'string' ? error.code : 'failed',
      })
      if (target.kind === 'session') {
        // 权威那份没搬走 = 这次删除没成：不碰后面那些，报告里留痕让调用方据此报错。
        break
      }
    }
  }

  const changed = trashed.length > 0 || removed.length > 0
  if (trashDir !== null) {
    if (changed) {
      try {
        const manifest = {
          sessionId: String(input.sessionId ?? ''),
          deletedAt: new Date(now).toISOString(),
          targets: trashed.map((entry) => ({ kind: entry.kind, from: entry.from, to: entry.to })),
          note: '移回 from 就是撤销删除（DSH 重启后才会重新看见这条会话）',
        }
        fs.writeFileSync(path.join(trashDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      } catch {
        /* manifest 只是给人看的，写不了不影响删除 */
      }
    } else {
      fs.rmSync(trashDir, { recursive: true, force: true })
      trashDir = null
      // 一次都没搬成时，别在 task-folders 下留一个空的 trash/。
      dropEmptyDir(trashRoot(input.home))
    }
  }

  if (input.prune !== false) {
    try {
      pruneTrash({ home: input.home, now })
    } catch {
      /* 清理失败不影响这次删除 */
    }
  }

  return { deleted: changed, missing: targets.length === 0, trashDir, trashed, removed, skipped }
}

/**
 * 清掉回收站里过期（默认 30 天）的条目。
 * @param {object} input - 入参。
 * @param {string} input.home - DSH home。
 * @param {number} [input.now] - 时钟。
 * @param {number} [input.retentionMs] - 保留多久，默认 30 天。
 * @returns {{kept: number, removed: string[]}} 统计。
 */
export function pruneTrash(input) {
  const now = typeof input.now === 'number' ? input.now : Date.now()
  const retention =
    Number.isFinite(input.retentionMs) && Number(input.retentionMs) > 0
      ? Number(input.retentionMs)
      : DEFAULT_TRASH_RETENTION_MS
  const root = trashRoot(input.home)
  const removed = []
  let kept = 0
  for (const name of childDirs(root)) {
    const entry = path.join(root, name)
    let time = 0
    try {
      time = fs.statSync(entry).mtimeMs
    } catch {
      continue
    }
    if (now - time <= retention) {
      kept += 1
      continue
    }
    try {
      fs.rmSync(entry, { recursive: true, force: true })
      removed.push(entry)
    } catch {
      kept += 1
    }
  }
  return { kept, removed }
}

/**
 * 一份给人看的删除摘要（Host 日志 / `describe` 用）。
 * @param {object} report - {@link removeSessionFiles} 的返回值。
 * @returns {string} 一句话。
 */
export function describeRemoval(report) {
  if (report?.missing === true) return '磁盘上没有这条会话的痕迹'
  const parts = []
  if (report.trashDir !== null && report.trashDir !== undefined) parts.push(`移入回收站 ${report.trashDir}`)
  else parts.push(`永久删除 ${report.removed.length} 处`)
  if (report.skipped.length > 0) parts.push(`跳过 ${report.skipped.length} 处（${report.skipped.map((entry) => entry.reason).join('、')}）`)
  return parts.join('；')
}
