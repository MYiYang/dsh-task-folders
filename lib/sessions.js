/**
 * 「任务」的判定逻辑（v0.4）：**任务区是一个真实的默认工作区**。
 *
 * v0.3 曾把「任务」定义成「无工作区的会话」——结果发现 DSH 的对话框有一条硬规则：
 * 空白会话（还没发过第一句）的工作区芯片来自「它属于哪个工作区」，谁都 不属于时
 * 芯片缺席，输入框直接变成「选择工作区」按钮（conversation 里 `inert = hero &&
 * chipTitle === undefined`）。也就是说无主会话永远发不出第一句话，只能去挑一个
 * 文件夹——那正是用户看到的「任务里的会话需要文件夹才能说话」。
 *
 * 所以任务区必须是一个**登记过的目录**：任务根目录自己就是一个工作区，老的
 * `<root>/<容器>`（v0.2 的 default / 1-tedb612）也认成任务区。它们在侧栏里被
 * 过滤掉、统一渲染成「任务」，但在 DSH 眼里它们就是普普通通的工作区——会话因此
 * 有主、芯片在场、输入框可用。
 *
 * 这里只放纯判定（不依赖 ctx，可单测）：
 *   - 哪些目录算「任务的地盘」（迁移 / 护栏用）；
 *   - 一条会话是不是「任务区的会话」；
 *   - 任务根目录的落盘准备（建目录 + .gitignore）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { archiveGitignore, isInside } from './paths.js'

/**
 * 建一个「任务」会话索引。
 * @param {object} input - 依赖。
 * @param {string} input.tasksRoot - 任务根目录绝对路径。
 * @param {object} [input.workspaces] - `ctx.get('workspaceRegistry')`（缺席时只读、不迁移）。
 * @returns {object} 索引 API。
 */
export function createSessionIndex(input) {
  const root = path.resolve(input.tasksRoot)
  const rootKey = process.platform === 'win32' ? root.toLowerCase() : root
  const workspaces = input.workspaces
  /** 路径 → 比较键的记忆表：工作区路径几乎不变，避免每次判定都 realpath。 */
  const keyMemo = new Map()

  /**
   * 一个目录路径的比较键（realpath 优先，Windows 下小写）。
   * @param {string} target - 目录路径。
   * @returns {string} 比较键。
   */
  function keyOf(target) {
    let key = keyMemo.get(target)
    if (key === undefined) {
      let resolved = target
      try {
        resolved = fs.realpathSync(target)
      } catch {
        resolved = path.resolve(target)
      }
      key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      keyMemo.set(target, key)
    }
    return key
  }

  /**
   * 工作区实体清单（注册表不可用时为空）。
   * @returns {object[]} 实体数组。
   */
  function entities() {
    if (workspaces === undefined || typeof workspaces.list !== 'function') return []
    try {
      const list = workspaces.list()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  /**
   * 已登记工作区的路径键集合（用于判定一条会话有没有工作区）。
   * 每次现算：工作区增减必须立刻反映到归档判定上（realpath 有记忆表兜底）。
   * @returns {Set<string>} 路径键集合。
   */
  function workspacePathKeys() {
    const keys = new Set()
    for (const entity of entities()) {
      if (typeof entity?.path !== 'string' || entity.path === '') continue
      keys.add(keyOf(entity.path))
    }
    return keys
  }

  /**
   * 判断一个目录是否属于「任务」区域（等于根目录本身也算）。
   * @param {unknown} target - 目录路径。
   * @returns {boolean} 是否是任务目录。
   */
  function isTaskPath(target) {
    if (typeof target !== 'string' || target.trim() === '') return false
    const resolved = path.resolve(target)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (key === rootKey) return true
    return isInside(root, resolved)
  }

  /**
   * 一条会话是不是「任务」的：落在任务区之内的算，谁都不归属的也算（v0.3 遗留），
   * 子代理不算。任务区 = 任务根目录及其子目录（老的 default / 1-tedb612 因为也在这
   * 棵树里，自动归队）。
   * @param {object} [header] - 会话头（`{id, cwd, origin, …}`）。
   * @returns {boolean} 是否收进「任务」。
   */
  function isTaskHeader(header) {
    if (header === undefined || header === null) return false
    if (header.origin === 'subagent') return false
    const cwd = header.cwd
    if (typeof cwd !== 'string' || cwd.trim() === '') return true
    if (isTaskPath(cwd)) return true
    return !workspacePathKeys().has(keyOf(cwd))
  }

  /**
   * 确保任务根目录存在，并补上 `.gitignore`（已存在则不覆盖）。
   * @returns {string} 任务根目录绝对路径。
   */
  function ensureRoot() {
    fs.mkdirSync(root, { recursive: true })
    try {
      const ignore = path.join(root, '.gitignore')
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, archiveGitignore(), 'utf8')
    } catch {
      /* 只是 git 干净度，写不了不影响任务 */
    }
    return root
  }

  return { root, isTaskPath, workspacePathKeys, isTaskHeader, ensureRoot }
}
