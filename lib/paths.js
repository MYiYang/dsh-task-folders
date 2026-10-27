/**
 * 纯路径与日期工具（不依赖 ctx，可单测）。
 *
 * 模型（v0.3）：**「任务」不是一个工作区**，而是「无工作区的会话」的集合。
 * 这些会话的聊天记录按**创建那天**归档到任务根目录下：
 *
 *   <tasksRoot>/                          ← 任务根（默认 $DSH_HOME/tasks，也是新任务会话的工作目录）
 *   ├── .gitignore                        ← 只忽略下面的按天文件夹
 *   ├── 2026-10-27/                       ← 按天文件夹（会话创建当天，本地时区）
 *   │   └── session-1681…/                ← 一个会话一个文件夹
 *   │       ├── session.json              ← 会话元数据（标题、seq 进度…）
 *   │       └── session.v4.jsonl.zstd     ← 会话 + 聊天记录（DSH 默认格式）
 *   └── default/2026-10-26/session-…      ← v0.2 的遗留任务容器（照样扫得出来，不搬走）
 *
 * `tasksRoot` 默认 `$DSH_HOME/tasks`——像 zcode 的 `.zcode/workspace/`，是应用自己的地盘。
 */
import path from 'node:path'

/** 会话元数据文件名（每个会话文件夹一份）。 */
export const SESSION_FILE = 'session.json'

/** 会话日志文件名：与 DSH 自己的会话存档同名同格式（多帧 zstd JSONL）。 */
export const SESSION_LOG_FILE = 'session.v4.jsonl.zstd'

/** 会话存档格式版本（写进 session.json，便于以后迁移）。 */
export const SESSION_FORMAT = 'dsh-task-folders/session@3'

/** 按天文件夹名的匹配式。 */
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Windows 文件名禁用字符 + 控制字符。 */
const RESERVED = /[<>:"/\\|?*\u0000-\u001f]/g
/** Windows 保留设备名，作为纯文件名会创建失败。 */
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 两位补零。
 * @param {number} value - 0-99。
 * @returns {string} 两位字符串。
 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 把 epoch 毫秒换算成**本地时区**的日历日，作为按天文件夹名。
 * 刻意不用 `toISOString()`：那是 UTC，跨时区会落到前一天/后一天。
 * @param {number} time - epoch 毫秒。
 * @returns {string} `YYYY-MM-DD`。
 */
export function dayKey(time) {
  const date = new Date(typeof time === 'number' && Number.isFinite(time) ? time : Date.now())
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 判断一个字符串是否是按天文件夹名。
 * @param {unknown} value - 待检查的值。
 * @returns {boolean} 是否形如 `YYYY-MM-DD`。
 */
export function isDayKey(value) {
  return typeof value === 'string' && DAY_PATTERN.test(value)
}

/**
 * 把任意标题压成一段 Windows/Unix 都能用的目录名片段。
 * 保留中文（「重构登录」这类名字是可读性的一半），只清理非法字符。
 * @param {unknown} text - 原始标题。
 * @param {number} [maxLength] - 最多保留多少字符（按码点，不按字节）。
 * @returns {string} 可安全用作单层目录名的片段，永不为空。
 */
export function safeSegment(text, maxLength = 40) {
  const raw = typeof text === 'string' ? text : ''
  const cleaned = raw
    .replace(RESERVED, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  const sliced = Array.from(cleaned).slice(0, Math.max(1, maxLength)).join('').trim()
  const candidate = sliced.replace(/ /g, '-')
  if (candidate === '' || candidate === '.' || candidate === '..') return 'task'
  return DEVICE_NAME.test(candidate) ? `${candidate}-task` : candidate
}

/**
 * 一个按天文件夹的绝对路径。
 * @param {string} root - 任务根目录。
 * @param {string} day - `YYYY-MM-DD`。
 * @returns {string} 绝对路径。
 */
export function dayDir(root, day) {
  return path.join(root, day)
}

/**
 * 一个会话文件夹的绝对路径。
 * @param {string} root - 任务根目录。
 * @param {string} day - `YYYY-MM-DD`。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 绝对路径。
 */
export function sessionDir(root, day, sessionId) {
  return path.join(dayDir(root, day), safeSegment(sessionId, 96))
}

/**
 * 会话文件夹相对任务根目录的路径（面板与日志里显示用）。
 * @param {string} day - `YYYY-MM-DD`。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 形如 `2026-10-26/session-1857…`。
 */
export function sessionRelative(day, sessionId) {
  return `${day}/${safeSegment(sessionId, 96)}`
}

/**
 * 判断 child 是否严格位于 parent 之下（删除/归档前的护栏）。
 * @param {string} parent - 父目录绝对路径。
 * @param {string} child - 待检查的绝对路径。
 * @returns {boolean} 是否在 parent 内部。
 */
export function isInside(parent, child) {
  const base = path.resolve(parent)
  const target = path.resolve(child)
  if (base === target) return false
  const relative = path.relative(base, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * 任务根目录里的 `.gitignore` 内容：只忽略按天文件夹，用户自己的文件照常跟踪。
 * @returns {string} 文件内容。
 */
export function archiveGitignore() {
  return [
    '# dsh-task-folders：会话存档按天归档在 <YYYY-MM-DD>/ 里，默认不进版本库。',
    '# 想把这些聊天记录也纳入 git，删掉本文件即可。',
    '20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]/',
    '',
  ].join('\n')
}
