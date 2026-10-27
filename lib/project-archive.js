/**
 * 「已归档项目」的落盘（v0.5）。
 *
 * DSH 自己只给**会话**提供归档（`workspaceRegistry.archiveSession`），工作区只有
 * 「删除登记」这一条路——那是把项目从列表里抹掉，会话跟着落回「未分组」，既不好看
 * 也不可逆。所以「项目归档」只能由插件自己记：一个 JSON 文件，存工作区 id 数组。
 *
 *   <home>/task-folders/projects.json  →  {"version":1,"archived":[ "<workspaceId>", … ]}
 *
 * 三条底线：
 *   1. **不碰工作区登记**：归档只影响侧栏怎么画，`workspaceRegistry` 一个字节都不动；
 *   2. **坏文件不炸**：读不出、不是 JSON、结构不对，一律当「没有归档」；
 *   3. **写不进去也不炸**：先写临时文件再 rename，失败只记 warn，侧栏退化成没归档。
 *
 * 纯逻辑（只依赖 fs / path），可脱离 ctx 单测。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 文件格式版本；将来要迁移时靠它认。 */
const FORMAT_VERSION = 1

/**
 * 工作区 id 是否能用（非空字符串就收，别把 id 的格式焊死在插件里）。
 * @param {unknown} value - 待判定值。
 * @returns {boolean} 是否是合法 id。
 */
function isId(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 建一个「已归档项目」存储。
 * @param {object} input - 依赖。
 * @param {string} input.file - JSON 文件绝对路径。
 * @param {{warn?: Function, info?: Function}} [input.logger] - 日志（可选）。
 * @returns {object} 存储 API。
 */
export function createProjectArchive(input) {
  const file = path.resolve(input.file)
  const logger = input.logger

  /** 内存里的归档集合（第一次读盘后填上）。 */
  let cache

  /**
   * 读盘。任何异常都退化成空集合——归档状态丢了顶多项目又冒出来，不能拖垮侧栏。
   * @returns {string[]} 工作区 id 数组。
   */
  function readDisk() {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      // 文件不存在是常态（第一次运行），不写日志；其它错误才提示。
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`dsh-task-folders: 读项目归档失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return []
    }
    try {
      const parsed = JSON.parse(text)
      const ids = Array.isArray(parsed?.archived) ? parsed.archived : []
      return ids.filter(isId).map((id) => id.trim())
    } catch {
      logger?.warn?.('dsh-task-folders: 项目归档文件不是合法 JSON，按「没有归档」处理')
      return []
    }
  }

  /**
   * 当前归档 id 集合（第一次调用读盘，之后走内存）。
   * @returns {Set<string>} 归档 id 集合。
   */
  function ids() {
    if (cache === undefined) cache = new Set(readDisk())
    return cache
  }

  /**
   * 写盘：临时文件 + rename，避免半截 JSON。
   * @param {Iterable<string>} values - 归档 id。
   * @returns {boolean} 是否写成功。
   */
  function writeDisk(values) {
    const list = [...values]
    const body = `${JSON.stringify({ version: FORMAT_VERSION, archived: list }, null, 2)}\n`
    const temporary = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(temporary, body, 'utf8')
      fs.renameSync(temporary, file)
      return true
    } catch (error) {
      logger?.warn?.(`dsh-task-folders: 写项目归档失败：${error instanceof Error ? error.message : String(error)}`)
      try {
        fs.rmSync(temporary, { force: true })
      } catch {
        /* 临时文件清不掉无所谓 */
      }
      return false
    }
  }

  return {
    /** 归档文件路径（自检用）。 */
    file,

    /**
     * 当前归档的工作区 id（数组，按写入顺序）。
     * @returns {string[]} id 数组。
     */
    list() {
      return [...ids()]
    },

    /**
     * 某个工作区是否被归档。
     * @param {unknown} workspaceId - 工作区 id。
     * @returns {boolean} 是否归档。
     */
    includes(workspaceId) {
      return isId(workspaceId) ? ids().has(workspaceId.trim()) : false
    },

    /**
     * 归档 / 恢复一个项目（幂等）。
     * @param {unknown} workspaceId - 工作区 id。
     * @param {boolean} archived - true = 归档，false = 恢复。
     * @returns {{archived: string[], changed: boolean}} 新的归档清单与是否真的变了。
     */
    set(workspaceId, archived) {
      if (!isId(workspaceId)) return { archived: this.list(), changed: false }
      const id = workspaceId.trim()
      const set = ids()
      const had = set.has(id)
      if (had === (archived === true)) return { archived: [...set], changed: false }
      if (archived === true) set.add(id)
      else set.delete(id)
      const ok = writeDisk(set)
      // 写失败就把内存也回滚：下次读盘仍与磁盘一致，不给侧栏留幻觉。
      if (!ok) {
        if (had) set.add(id)
        else set.delete(id)
        return { archived: [...set], changed: false }
      }
      logger?.info?.(`dsh-task-folders: ${archived === true ? '归档' : '恢复'}项目 ${id}`)
      return { archived: [...set], changed: true }
    },
  }
}
