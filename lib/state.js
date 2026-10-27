/**
 * 侧栏数据装配（v0.4）：「任务」= 任务区（任务根目录这个默认工作区，以及老的
 * `<root>/<容器>`）名下的会话 + 谁都不归属的遗留会话，按天分组；「工作区」= 普通工作区。
 *
 * 面板不读磁盘、不猜路径，只渲染这里的结构——所有路径知识都留在 Host 侧。
 * 会话清单来自 `sessionQuery`（含冷会话）+ 归档扫描（补 day），标题由客户端
 * 从自己的会话快照解析（`displayTitle` / `projectionValues.title`）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { dayKey } from './paths.js'
import { scanSessionsRoot } from './scan.js'

/**
 * 规范化路径键：能 realpath 就 realpath，否则归一化；Windows 下忽略大小写。
 * @param {string} target - 目录路径。
 * @returns {string} 比较键。
 */
function pathKey(target) {
  let resolved = target
  try {
    resolved = fs.realpathSync(target)
  } catch {
    resolved = path.resolve(target)
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 判断路径是否是已存在的目录。
 * @param {string} target - 绝对路径。
 * @returns {boolean} 是否存在且为目录。
 */
function directoryExists(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * 装配侧栏要的整份状态。
 * @param {object} input - 输入。
 * @param {string} input.root - 任务根目录绝对路径（= 任务默认工作区的路径）。
 * @param {string} [input.taskWorkspaceId] - 任务默认工作区 id（客户端 ＋ 用它建会话）。
 * @param {object[]} [input.records] - 全部会话记录 `{id, createdAt, cwd, origin, live}`。
 * @param {object[]} [input.workspaces] - `workspaceRegistry.list()` 的原样实体。
 * @param {Set<string>} [input.liveIds] - 当前存活会话 id（= 有 Agent 的会话）。
 * @param {Set<string>} [input.archivedIds] - 全局归档的会话 id（不混进主列表，单列成 archivedDayGroups）。
 * @param {Set<string>} [input.archivedWorkspaces] - 插件自己记的「已归档项目」工作区 id（v0.5）。
 * @param {boolean} [input.canCreate] - 能否新建工作区（注册表可用）。
 * @param {() => number} [input.now] - 时钟（测试用）。
 * @returns {object} 侧栏状态。
 */
export function buildState(input) {
  const root = path.resolve(input.root)
  const liveIds = input.liveIds instanceof Set ? input.liveIds : new Set()
  const archivedIds = input.archivedIds instanceof Set ? input.archivedIds : new Set()
  const archivedWorkspaces =
    input.archivedWorkspaces instanceof Set ? input.archivedWorkspaces : new Set()
  const now = typeof input.now === 'function' ? input.now : () => Date.now()

  // ---- 工作区（普通工作区照常显示；任务区的工作区一律不显示） ----
  const workspaceKeys = new Set()
  const groupedIds = new Set()
  /** 任务区工作域名下的会话（DSH 的成员表口径）。 */
  const taskAreaIds = new Set()
  const workspaces = (Array.isArray(input.workspaces) ? input.workspaces : [])
    .map((entity, order) => {
      const target = typeof entity?.path === 'string' ? path.resolve(entity.path) : ''
      const sessionIds = Array.isArray(entity?.sessionIds) ? entity.sessionIds.map(String) : []
      const isTask = isInsideRoot(root, target)
      if (isTask) {
        for (const id of sessionIds) taskAreaIds.add(id)
      } else if (target !== '') {
        workspaceKeys.add(pathKey(target))
        for (const id of sessionIds) groupedIds.add(id)
      }
      const workspaceId = String(entity?.id ?? target)
      return {
        id: workspaceId,
        title:
          typeof entity?.title === 'string' && entity.title.trim() !== ''
            ? entity.title.trim()
            : target.split(/[\\/]/).filter(Boolean).pop() ?? target,
        path: target,
        order,
        sessionIds,
        live: sessionIds.filter((id) => liveIds.has(id)),
        isTask,
        // v0.5：插件自己记的「已归档项目」。它只影响侧栏怎么画，登记表一个字节没动——
        // 所以归档的项目依旧能开会话、能收成员，只是被收进侧栏底部的归档分组。
        archived: archivedWorkspaces.has(workspaceId),
      }
    })
    .filter((workspace) => workspace.isTask !== true)

  // ---- 「任务」：任务区会话 + 无主的遗留会话，按创建那天分组 ----
  const scan = scanSessionsRoot(root, { liveIds })
  /** 主列表里的会话（未归档）。 */
  const sessions = []
  /** 已归档的会话（v0.5 单列一组，客户端按「归档过滤」决定显不显示）。 */
  const archivedSessions = []
  const seen = new Set()
  /**
   * 一条会话归到哪一摞：归档的进 archivedSessions，其余进 sessions。
   * @param {object} entry - 会话视图。
   */
  const pushSession = (entry) => {
    ;(archivedIds.has(entry.id) ? archivedSessions : sessions).push(entry)
  }
  for (const record of Array.isArray(input.records) ? input.records : []) {
    const id = typeof record?.id === 'string' ? record.id : ''
    if (id === '' || seen.has(id)) continue
    if (record.origin === 'subagent') continue
    const cwd = typeof record.cwd === 'string' ? record.cwd : ''
    // 任务区：cwd 在任务根目录树里，或者它已经是某个任务区工作区的成员。
    const inTaskArea = taskAreaIds.has(id) || (cwd !== '' && isInsideRoot(root, cwd))
    if (!inTaskArea) {
      const grouped = groupedIds.has(id) || (cwd !== '' && workspaceKeys.has(pathKey(cwd)))
      if (grouped) continue
    }
    seen.add(id)
    const archived = scan.byId.get(id)
    const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0
    pushSession({
      id,
      day: archived?.day ?? dayKey(createdAt > 0 ? createdAt : now()),
      createdAt,
      live: record.live === true || liveIds.has(id),
      archived: archived !== undefined,
      dir: archived?.dir,
    })
  }
  // 归档里有、records 里没有的会话也列出来（sessionQuery 缺席时的兜底）
  for (const [id, entry] of scan.byId) {
    if (seen.has(id)) continue
    seen.add(id)
    pushSession({
      id,
      day: entry.day,
      createdAt: entry.createdAt,
      live: liveIds.has(id),
      archived: true,
      dir: entry.dir,
    })
  }

  /**
   * 按天分组（天键倒序；同一天里新的在前）。
   * @param {object[]} list - 会话视图数组。
   * @returns {object[]} `{day, sessions}` 数组。
   */
  function groupByDay(list) {
    const byDay = new Map()
    for (const session of list) {
      if (!byDay.has(session.day)) byDay.set(session.day, [])
      byDay.get(session.day).push(session)
    }
    return [...byDay.entries()]
      .sort((left, right) => (left[0] < right[0] ? 1 : left[0] > right[0] ? -1 : 0))
      .map(([day, daySessions]) => ({
        day,
        sessions: daySessions.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0)),
      }))
  }

  const dayGroups = groupByDay(sessions)
  const archivedDayGroups = groupByDay(archivedSessions)

  return {
    generatedAt: now(),
    tasksRoot: root,
    // 任务默认工作区：客户端 ＋ 直接 connectWorkspace(它) —— DSH 原生建会话，
    // 芯片/输入框天然就位，不用再摸 sessions.create 那条私有面。
    taskWorkspaceId: typeof input.taskWorkspaceId === 'string' ? input.taskWorkspaceId : '',
    // 兼容旧字段：任务会话的工作目录就是任务根（= 默认工作区的路径）。
    cwd: root,
    canCreate: input.canCreate !== false,
    layout: {
      dayFormat: 'YYYY-MM-DD',
      sessionLog: 'session.v4.jsonl.zstd',
    },
    workspaces,
    dayGroups,
    // v0.5：归档的会话不再被丢掉，而是原样带出来，由客户端按「归档过滤」三档决定显不显示。
    // 这样切「全部对话」时不用再跑一趟 Host，也不会和磁盘上的归档副本混淆
    // （`archived` 字段说的是「磁盘上有按天副本」，不是「DSH 里归档了」）。
    archivedDayGroups,
    sessions,
    archivedSessions,
    archivedSessionIds: [...archivedIds],
    totals: {
      sessions: sessions.length,
      archivedSessions: archivedSessions.length,
      archivedWorkspaces: workspaces.filter((workspace) => workspace.archived === true).length,
      days: dayGroups.length,
      workspaces: workspaces.length,
      workspaceSessions: workspaces.reduce((total, workspace) => total + workspace.sessionIds.length, 0),
    },
  }
}

/**
 * 判断目标是否在任务根目录内部（含根目录自身）。
 * @param {string} root - 任务根目录。
 * @param {string} target - 待判断路径。
 * @returns {boolean} 是否在内部。
 */
function isInsideRoot(root, target) {
  if (target === '') return false
  const key = process.platform === 'win32' ? target.toLowerCase() : target
  const base = process.platform === 'win32' ? root.toLowerCase() : root
  if (key === base) return true
  const relative = path.relative(base, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
