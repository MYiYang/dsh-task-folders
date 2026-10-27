/**
 * 任务注册表：任务 = DSH 工作区（目录由插件代建）。
 *
 * 刻意**不另建一份任务清单**：任务就是「登记在 `tasksRoot` 之下的工作区」。
 * 于是三者天然一致——侧栏工作区列表里看到的、DSH 认的会话目录、面板里列的任务；
 * 用户在工作区菜单里改名/删除，任务这边立刻同步，没有任何影子状态需要维护。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { archiveGitignore, isInside, taskFolderName } from './paths.js'

/**
 * 生成一个 6 位十六进制短 id（只用于目录名去重）。
 * @returns {string} 形如 `t6a908b`。
 */
function newShortId() {
  return `t${crypto.randomBytes(3).toString('hex')}`
}

/**
 * 建一个任务注册表。
 * @param {object} input - 依赖。
 * @param {string} input.tasksRoot - 任务根目录绝对路径。
 * @param {object} [input.workspaces] - `ctx.get('workspaceRegistry')`（缺席时只读、不能建）。
 * @param {() => number} [input.now] - 时钟（测试用）。
 * @returns {object} 注册表 API。
 */
export function createTaskRegistry(input) {
  const root = path.resolve(input.tasksRoot)
  const rootKey = process.platform === 'win32' ? root.toLowerCase() : root
  const workspaces = input.workspaces
  const now = typeof input.now === 'function' ? input.now : () => Date.now()

  /**
   * 判断一个目录是否属于「任务」区域（等于根目录本身也算）。
   * Windows 下按大小写不敏感比较：realpath 出来的盘符/目录大小写常与配置不同。
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
   * 把工作区实体收敛成面板/接口用的任务视图（不暴露实体上的方法）。
   * @param {object} entity - 工作区实体。
   * @param {number} [order] - 注册顺序（= 侧栏里的上下顺序）。
   * @returns {object} 任务视图。
   */
  function viewOf(entity, order = 0) {
    const target = path.resolve(String(entity.path))
    return {
      id: String(entity.id),
      title: typeof entity.title === 'string' && entity.title.trim() !== '' ? entity.title.trim() : path.basename(target),
      path: target,
      createdAt: typeof entity.createdAt === 'string' ? Date.parse(entity.createdAt) : now(),
      updatedAt: typeof entity.updatedAt === 'string' ? Date.parse(entity.updatedAt) : now(),
      order,
    }
  }

  /**
   * 列任务：**以磁盘为准**。
   *
   * 先列登记在 tasksRoot 之下的工作区（registered: true），再把 tasksRoot 里
   * 没登记成工作区的目录也列出来（registered: false，id 形如 `local:<目录名>`）——
   * 用户手建、或登记被清掉的任务目录不会因此变成孤儿；点一下就会补登记。
   * @returns {object[]} 任务视图数组（登记的在前，按工作区注册顺序）。
   */
  function list() {
    const registered = entities()
      .filter((entity) => typeof entity?.path === 'string' && isTaskPath(entity.path))
      .map((entity, order) => ({ ...viewOf(entity, order), registered: true }))
    const known = new Set(registered.map((task) => task.path.toLowerCase()))
    const locals = []
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.resolve(path.join(root, entry.name))
      if (known.has(dir.toLowerCase())) continue
      let stat
      try {
        stat = fs.statSync(dir)
      } catch {
        continue
      }
      locals.push({
        id: `local:${entry.name}`,
        title: entry.name,
        path: dir,
        order: registered.length + locals.length,
        createdAt: stat.mtimeMs,
        updatedAt: stat.mtimeMs,
        registered: false,
      })
    }
    locals.sort((left, right) => right.updatedAt - left.updatedAt)
    return [...registered, ...locals]
  }

  /**
   * 按 id 找任务。
   * @param {string} id - 工作区 id。
   * @returns {object|undefined} 任务视图。
   */
  function find(id) {
    if (typeof id !== 'string' || id === '') return undefined
    return list().find((task) => task.id === id)
  }

  /**
   * 按目录找任务（会话归档时用）。
   * @param {string} target - 会话的 cwd。
   * @returns {object|undefined} 任务视图。
   */
  function findByPath(target) {
    if (!isTaskPath(target)) return undefined
    const resolved = path.resolve(target)
    return list().find((task) => task.path.toLowerCase() === resolved.toLowerCase())
  }

  /**
   * 新建任务：建目录 → 登记成 DSH 工作区。**不弹目录选择框**，这是这个功能的意义所在。
   * @param {string} title - 任务标题。
   * @returns {Promise<object>} 任务视图。
   * @throws {Error} 工作区注册表不可用，或目录/注册失败。
   */
  async function create(title) {
    if (workspaces === undefined || typeof workspaces.create !== 'function') {
      throw new Error('当前 DSH 没有 workspaceRegistry.create，无法建任务')
    }
    const cleanTitle = typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, 60) : '新任务'
    const dir = path.join(root, taskFolderName(cleanTitle, newShortId()))
    fs.mkdirSync(dir, { recursive: true })
    try {
      const ignore = path.join(dir, '.gitignore')
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, archiveGitignore(), 'utf8')
    } catch {
      /* 只是 git 干净度，写不了不影响任务 */
    }
    const entity = await workspaces.create(dir, cleanTitle)
    return viewOf(entity)
  }

  /**
   * 改任务名（工作区标题；目录名不动，已有会话路径不失效）。
   * @param {string} id - 工作区 id。
   * @param {string} title - 新标题。
   * @returns {Promise<object|undefined>} 更新后的任务视图。
   */
  async function rename(id, title) {
    const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 60) : ''
    if (cleanTitle === '') return find(id)
    const entity = entities().find((candidate) => String(candidate.id) === String(id) && isTaskPath(candidate.path))
    if (entity === undefined) return undefined
    if (typeof entity.setTitle === 'function') await entity.setTitle(cleanTitle)
    return viewOf(entity)
  }

  /**
   * 把一个「磁盘上有、注册表里没有」的任务目录补登记成工作区。
   * @param {string} id - 任务 id（`local:<目录名>` 或已是登记过的 id）。
   * @returns {Promise<object|undefined>} 登记后的任务视图。
   * @throws {Error} 目录名非法、目录不在 tasksRoot 下、或注册表不可用。
   */
  async function adopt(id) {
    if (typeof id !== 'string' || id === '') return undefined
    if (!id.startsWith('local:')) return find(id)
    const folder = id.slice('local:'.length)
    if (folder === '' || folder === '.' || folder === '..' || folder.includes('/') || folder.includes('\\')) {
      throw new Error('非法的任务目录名')
    }
    const dir = path.resolve(path.join(root, folder))
    if (!isInside(root, dir)) throw new Error('任务目录不在任务根目录内')
    if (!fs.existsSync(dir)) throw new Error('任务目录不存在')
    if (workspaces === undefined || typeof workspaces.create !== 'function') {
      throw new Error('当前 DSH 没有 workspaceRegistry.create，无法补登记')
    }
    const entity = await workspaces.create(dir, path.basename(dir))
    return viewOf(entity)
  }

  /**
   * 删任务：摘掉工作区登记；`removeFiles` 才删目录（且必须真在 tasksRoot 之下）。
   * 未登记的任务（`local:*`）没有登记可摘，只能连目录一起删。
   * @param {string} id - 工作区 id 或 `local:<目录名>`。
   * @param {{removeFiles?: boolean}} [options] - 是否连目录一起删。
   * @returns {Promise<{removed: boolean, filesDeleted: boolean, unregistered?: boolean}>} 结果。
   */
  async function remove(id, options = {}) {
    if (typeof id !== 'string' || id === '') return { removed: false, filesDeleted: false }
    if (id.startsWith('local:')) {
      const folder = id.slice('local:'.length)
      if (folder === '' || folder === '.' || folder === '..' || folder.includes('/') || folder.includes('\\')) {
        return { removed: false, filesDeleted: false, unregistered: true }
      }
      const dir = path.resolve(path.join(root, folder))
      if (!isInside(root, dir)) return { removed: false, filesDeleted: false, unregistered: true }
      if (options.removeFiles !== true) return { removed: false, filesDeleted: false, unregistered: true }
      fs.rmSync(dir, { recursive: true, force: true })
      return { removed: true, filesDeleted: true }
    }
    const entity = entities().find((candidate) => String(candidate.id) === String(id) && isTaskPath(candidate.path))
    if (entity === undefined) return { removed: false, filesDeleted: false }
    let removed = false
    if (typeof workspaces.delete === 'function') {
      try {
        removed = (await workspaces.delete(String(entity.id))) !== false
      } catch {
        removed = false
      }
    }
    if (removed && options.removeFiles === true && isTaskPath(entity.path)) {
      const target = path.resolve(entity.path)
      if (isInside(root, target)) {
        fs.rmSync(target, { recursive: true, force: true })
        return { removed: true, filesDeleted: true }
      }
    }
    return { removed, filesDeleted: false }
  }

  /**
   * 默认任务容器：`<tasksRoot>/default`。
   *
   * 「任务」这一组装的是**会话**，不需要用户给每个任务起名、选目录；所以只需要
   * 一个稳定的容器工作区，会话按天归档在它下面（`<tasksRoot>/default/<日期>/<会话>/`）。
   * @returns {Promise<object>} 容器工作区的任务视图（已登记）。
   * @throws {Error} 注册表不可用或登记失败。
   */
  async function ensureDefault() {
    const dir = path.resolve(path.join(root, 'default'))
    const found = list().find((task) => task.path.toLowerCase() === dir.toLowerCase())
    if (found !== undefined && found.registered !== false) return found
    fs.mkdirSync(dir, { recursive: true })
    try {
      const ignore = path.join(dir, '.gitignore')
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, archiveGitignore(), 'utf8')
    } catch {
      /* 只影响 git 干净度 */
    }
    if (workspaces === undefined || typeof workspaces.create !== 'function') {
      throw new Error('当前 DSH 没有 workspaceRegistry.create，无法建任务容器')
    }
    const entity = await workspaces.create(dir, '任务')
    return viewOf(entity)
  }

  return { root, isTaskPath, list, find, findByPath, create, ensureDefault, adopt, rename, remove }
}
