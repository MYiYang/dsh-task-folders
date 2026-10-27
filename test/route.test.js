import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { inflateFrames } from '../lib/archive.js'
import { SESSION_LOG_FILE, dayKey } from '../lib/paths.js'

/**
 * 假会话：够 apply() 用（header + snapshotEvents + id）。
 * @param {string} id - 会话 id。
 * @param {string|null} [cwd] - 工作目录（null = 没有 cwd）。
 * @param {object[]} [seed] - 已发生的事件。
 * @param {number} [createdAt] - 创建时间（决定归档到哪一天）。
 * @returns {object} 会话。
 */
function fakeSession(id, cwd = null, seed = [], createdAt = 1_700_000_000_000) {
  return {
    id,
    header: { version: 4, id, createdAt, ...(cwd === null ? {} : { cwd }), isSeeded: false },
    events: seed.slice(),
    snapshotEvents(fromSeq = 0) {
      return this.events.filter((event) => event.seq >= fromSeq)
    },
  }
}

/**
 * 造一个假的工作区注册表（行为对齐 workspaceRegistry：create 幂等、实体带 sessionIds
 * 与 attachSession、delete 只摘登记、archiveSession 只进归档集合）。
 * @returns {object} 假注册表。
 */
function fakeRegistry() {
  const entities = []
  const archived = []
  let counter = 0
  return {
    entities,
    archived,
    list: () => entities.slice(),
    get archivedSessionIds() {
      return archived.slice()
    },
    create(dir, title) {
      const known = entities.find((entity) => entity.path === dir)
      if (known !== undefined) return Promise.resolve(known)
      counter += 1
      const entity = {
        id: `workspace-${counter}`,
        path: dir,
        title: title ?? path.basename(dir),
        sessionIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attachSession(sessionId) {
          if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId)
          return Promise.resolve()
        },
        detachSession(sessionId) {
          const index = this.sessionIds.indexOf(sessionId)
          if (index >= 0) this.sessionIds.splice(index, 1)
          return Promise.resolve()
        },
      }
      entities.unshift(entity)
      return Promise.resolve(entity)
    },
    delete(id) {
      const index = entities.findIndex((entity) => entity.id === id)
      if (index < 0) return Promise.resolve(false)
      entities.splice(index, 1)
      return Promise.resolve(true)
    },
    archiveSession(sessionId) {
      if (!archived.includes(sessionId)) archived.push(sessionId)
      return Promise.resolve()
    },
    unarchiveSession(sessionId) {
      const index = archived.indexOf(sessionId)
      if (index >= 0) archived.splice(index, 1)
      return Promise.resolve()
    },
  }
}

/**
 * 造一个假的 Host 上下文并把 apply() 挂上去。
 * @param {{tasksRoot?: string, sessions?: Map<string, object>, denied?: boolean, records?: object[],
 *   messages?: Set<string>, activity?: (sessionId: string) => object[], config?: object,
 *   seed?: (workspaces: object, tasksRoot: string) => void|Promise<void>}} [options] - 初始状态。
 * @returns {object} harness。
 */
function mount(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-route-'))
  const tasksRoot = options.tasksRoot ?? path.join(home, 'tasks')
  const workspaces = fakeRegistry()
  const sessions = options.sessions ?? new Map()
  const records = options.records ?? []
  const messages = options.messages instanceof Set ? options.messages : new Set()
  const routes = []
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get(name) {
      if (name === 'workspaceRegistry') return workspaces
      if (name === 'sessions') return { list: () => [...sessions.values()], get: (id) => sessions.get(id) }
      if (name === 'sessionQuery') {
        return { listSessions: async () => records.map((record) => ({ header: record, live: false })) }
      }
      if (name === 'sessionPersistence') {
        return {
          open: async (id) => ({
            read: async () => ({ events: messages.has(id) ? [{ type: 'user/message', seq: 0, data: {} }] : [] }),
            close: async () => {},
          }),
        }
      }
      return undefined
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    connection: { requestRejection: () => (options.denied === true ? { code: 'no-peer' } : undefined) },
    // 新版 DSH 的「这会话在干嘛」瀑布：没配 activity 就当没人报活动（删除放行）。
    waterfall(event, payload, fallback) {
      if (event === 'workspace/session-activity' && typeof options.activity === 'function') {
        const reported = options.activity(payload?.sessionId)
        return Promise.resolve(reported ?? [])
      }
      return typeof fallback === 'function' ? fallback() : Promise.resolve([])
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  // 先种下「旧模型」的现场（登记在任务根目录下的工作区），再挂插件：迁移在 apply 时跑。
  if (typeof options.seed === 'function') {
    const seeded = options.seed(workspaces, tasksRoot)
    if (seeded !== undefined && typeof seeded.then === 'function') {
      throw new Error('seed 只支持同步种现场（迁移本身是异步重试的）')
    }
  }
  apply(ctx, { home, tasksRoot, flushDelayMs: 0, flushBatchSize: 1, ...(options.config ?? {}) })
  return { ctx, routes, listeners, workspaces, sessions, tasksRoot, home }
}

/**
 * 调一次 Host 路由。
 * @param {object} harness - mount() 的产物。
 * @param {string} method - 操作名。
 * @param {object} [payload] - 请求体。
 * @param {{httpMethod?: string, body?: string}} [raw] - 覆盖方法/原始体。
 * @returns {Promise<{status: number, json: any}>} 应答。
 */
async function post(harness, method, payload, raw = {}) {
  const route = harness.routes[0]
  assert.ok(route, '应该注册了前缀路由')
  const body = raw.body ?? (payload === undefined ? '' : JSON.stringify(payload))
  const req = {
    method: raw.httpMethod ?? 'POST',
    url: `/task-folders/api/${method}`,
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  }
  const chunks = []
  let status = 0
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
    },
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  return { status, json: text === '' ? undefined : JSON.parse(text) }
}

/**
 * 读回一个会话存档的所有事件行。
 * @param {string} dir - 会话目录。
 * @returns {object[]} 解析后的行。
 */
function readLines(dir) {
  return inflateFrames(fs.readFileSync(path.join(dir, SESSION_LOG_FILE)))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

test('state 一开始是空的，并告诉面板任务默认工作区与新会话的工作目录', async () => {
  const harness = mount()
  const answer = await post(harness, 'state')
  assert.equal(answer.status, 200)
  assert.equal(answer.json.ok, true)
  assert.equal(answer.json.value.canCreate, true)
  assert.deepEqual(answer.json.value.dayGroups, [])
  assert.deepEqual(answer.json.value.workspaces, [], '任务默认工作区不显示在工作区组')
  assert.equal(answer.json.value.cwd, path.resolve(harness.tasksRoot))
  assert.equal(answer.json.value.tasksRoot, path.resolve(harness.tasksRoot))
  assert.equal(typeof answer.json.value.taskWorkspaceId, 'string')
  assert.notEqual(answer.json.value.taskWorkspaceId, '', '任务根目录登记成了工作区')
  assert.deepEqual(
    harness.workspaces.entities.map((entity) => path.resolve(entity.path)),
    [path.resolve(harness.tasksRoot)],
    '只登记任务根目录一份',
  )
  assert.deepEqual(answer.json.value.totals, {
    sessions: 0,
    archivedSessions: 0,
    archivedWorkspaces: 0,
    days: 0,
    workspaces: 0,
    workspaceSessions: 0,
  })
})

test('只有可信页面能调路由；GET 与非 POST 被拒', async () => {
  const denied = mount({ denied: true })
  assert.equal((await post(denied, 'state')).status, 403)

  const harness = mount()
  assert.equal((await post(harness, 'state', undefined, { httpMethod: 'GET' })).status, 405)
  assert.equal((await post(harness, 'nope')).status, 404)
  assert.equal((await post(harness, 'createTask')).status, 404, 'v0.2 的建任务路由已经没有了')
  assert.equal((await post(harness, 'state', undefined, { body: '[]' })).status, 400)
})

test('newTaskSession 确保任务区就绪：根目录 + 它的默认工作区 + .gitignore', async () => {
  const harness = mount()
  const answer = await post(harness, 'newTaskSession')
  assert.equal(answer.status, 200)
  const value = answer.json.value
  assert.equal(value.cwd, path.resolve(harness.tasksRoot))
  assert.equal(fs.existsSync(value.cwd), true)
  assert.equal(fs.existsSync(path.join(value.cwd, '.gitignore')), true)
  // 任务是一个真实的默认工作区：客户端拿这个 id 走 connectWorkspace。
  assert.notEqual(value.workspaceId, '')
  assert.equal(harness.workspaces.entities.length, 1)
  assert.equal(path.resolve(harness.workspaces.entities[0].path), path.resolve(value.cwd))
  assert.equal(harness.workspaces.entities[0].title, '任务')

  const again = (await post(harness, 'newTaskSession')).json.value
  assert.equal(again.cwd, value.cwd)
  assert.equal(again.workspaceId, value.workspaceId, '幂等：不重复登记')
  assert.equal(harness.workspaces.entities.length, 1)
})

test('没有工作区的会话自动按天归档；有工作区的一概不动', async () => {
  const harness = mount()
  const created = harness.listeners.get('session/created')
  const onEvent = harness.listeners.get('session/event')
  assert.ok(created && onEvent)

  // ① 没有 cwd 的会话（谁都不归属）：自动建档 + 补写已有事件
  const loose = fakeSession('session-loose', null, [
    { type: 'user/message', seq: 0, time: 1, data: { role: 'user', content: [] } },
    { type: 'session/title', seq: 1, time: 2, data: { title: '会话甲' } },
  ])
  created(loose)
  const day = dayKey(loose.header.createdAt)
  const dir = path.join(harness.tasksRoot, day, 'session-loose')
  assert.equal(fs.existsSync(path.join(dir, SESSION_LOG_FILE)), true)
  const seeded = readLines(dir)
  assert.equal(seeded[0].type, 'session')
  assert.deepEqual(seeded.slice(1).map((line) => line.seq), [0, 1])
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'))
  assert.equal(meta.title, '会话甲', '补写时要把标题落进元数据')
  assert.equal(meta.day, day)

  // ② 之后的事件继续追加
  onEvent(loose, { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, step: 1 } })
  assert.deepEqual(readLines(dir).slice(1).map((line) => line.seq), [0, 1, 2])

  // ③ 落在已登记工作区里的会话：不归档
  const project = path.join(harness.home, 'my-project')
  fs.mkdirSync(project, { recursive: true })
  await harness.workspaces.create(project, '我的项目')
  const inside = fakeSession('session-inside', project, [
    { type: 'user/message', seq: 0, time: 1, data: {} },
  ])
  created(inside)
  onEvent(inside, { type: 'assistant/message', seq: 1, time: 2, data: {} })
  assert.equal(fs.existsSync(path.join(project, dayKey(inside.header.createdAt))), false)
  assert.equal(fs.existsSync(path.join(harness.tasksRoot, dayKey(inside.header.createdAt), 'session-inside')), false)

  // 面板能看到这条归档（按天分组）
  const state = (await post(harness, 'state')).json.value
  assert.deepEqual(state.dayGroups.map((group) => group.day), [day])
  assert.deepEqual(state.dayGroups[0].sessions.map((session) => session.id), ['session-loose'])
  assert.equal(state.workspaces.length, 1, '普通工作区照旧')
})

test('子代理不归档；重复 session/created 不重复写；丢了对工作区的归属就补归档', async () => {
  const harness = mount()
  const created = harness.listeners.get('session/created')
  const onEvent = harness.listeners.get('session/event')

  const subagent = fakeSession('session-sub', null, [{ type: 'step/start', seq: 0, time: 1, data: {} }])
  subagent.header.origin = 'subagent'
  created(subagent)
  onEvent(subagent, { type: 'step/end', seq: 1, time: 2, data: {} })
  assert.equal(fs.existsSync(path.join(harness.tasksRoot, dayKey(subagent.header.createdAt), 'session-sub')), false)

  const normal = fakeSession('session-normal', null, [{ type: 'step/start', seq: 0, time: 1, data: {} }])
  created(normal)
  created(normal) // 再来一次：已接上的会话不应重开句柄、重复补写
  const dir = path.join(harness.tasksRoot, dayKey(normal.header.createdAt), 'session-normal')
  assert.deepEqual(readLines(dir).slice(1).map((line) => line.seq), [0])

  // 先在有工作区里（不归档），工作区被删掉后下一条事件补接归档
  const project = path.join(harness.home, 'temp-project')
  fs.mkdirSync(project, { recursive: true })
  const entity = await harness.workspaces.create(project, '临时项目')
  const moved = fakeSession('session-moved', project, [{ type: 'step/start', seq: 0, time: 1, data: {} }])
  created(moved)
  assert.equal(fs.existsSync(path.join(harness.tasksRoot, dayKey(moved.header.createdAt), 'session-moved')), false)
  await harness.workspaces.delete(entity.id)
  onEvent(moved, { type: 'assistant/message', seq: 1, time: 2, data: {} })
  assert.deepEqual(readLines(path.join(harness.tasksRoot, dayKey(moved.header.createdAt), 'session-moved')).slice(1).map((line) => line.seq), [0, 1])
})

test('任务区只留一份：老容器登记被摘掉，空壳会话归档，有内容的不动', async () => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-prune-'))
  const tasksRoot = path.join(legacy, 'tasks')
  const container = path.join(tasksRoot, 'default')
  const other = path.join(tasksRoot, '1-tedb612')
  fs.mkdirSync(container, { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(container, 'session.v4.jsonl.zstd'), '老日志', 'utf8')
  const harness = mount({
    tasksRoot,
    records: [
      { id: 'session-empty', createdAt: 1_700_000_000_000, cwd: container },
      { id: 'session-chatty', createdAt: 1_700_000_000_000, cwd: other },
    ],
    messages: new Set(['session-chatty']),
    seed: (workspaces) => {
      // v0.2 时代的两个老容器（「任务 = 工作区」）：v0.4 要摘掉，只留任务根那一份。
      for (const [id, dir] of [['workspace-default', container], ['workspace-legacy', other]]) {
        workspaces.entities.unshift({
          id,
          path: dir,
          title: '任务',
          sessionIds: [id === 'workspace-default' ? 'session-empty' : 'session-chatty'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          attachSession() {
            return Promise.resolve()
          },
        })
      }
    },
  })

  const state = (await post(harness, 'state')).json.value
  assert.deepEqual(
    harness.workspaces.entities.map((entity) => path.resolve(entity.path)),
    [path.resolve(tasksRoot)],
    '只剩任务根那一份登记',
  )
  assert.equal(state.taskWorkspaceId, harness.workspaces.entities[0].id)
  assert.deepEqual(harness.workspaces.archived, ['session-empty'], '空壳会话归档，有内容的那条不碰')
  assert.deepEqual(state.workspaces.map((workspace) => workspace.id), [], '任务区工作区不出现在工作区组')
  // 有内容的老会话仍然在任务组里（只是没有工作区归属）
  assert.deepEqual(
    state.dayGroups.flatMap((group) => group.sessions.map((session) => session.id)),
    ['session-chatty'],
  )
  assert.equal(fs.existsSync(container), true, '目录不动')
  assert.equal(fs.readFileSync(path.join(container, 'session.v4.jsonl.zstd'), 'utf8'), '老日志', '日志不动')
})

test('任务区只留一份：任务根上的老会话挂进成员表（空白会话才开得了口）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-attach-'))
  const tasksRoot = path.join(home, 'tasks')
  fs.mkdirSync(tasksRoot, { recursive: true })
  const harness = mount({
    tasksRoot,
    records: [{ id: 'session-on-root', createdAt: 1_700_000_000_000, cwd: tasksRoot }],
    messages: new Set(['session-on-root']),
  })
  await post(harness, 'state')
  const root = harness.workspaces.entities.find((entity) => path.resolve(entity.path) === path.resolve(tasksRoot))
  assert.deepEqual(root.sessionIds, ['session-on-root'], 'cwd 就在任务根的既有会话要挂进去')
})

test('任务区：注册表晚就绪时也会补登记（面板轮询/启动重试都行）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-late-'))
  const tasksRoot = path.join(home, 'tasks')
  let registryService
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get(name) {
      if (name === 'workspaceRegistry') return registryService
      return undefined
    },
    on() {
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx, { home, tasksRoot, flushDelayMs: 0, flushBatchSize: 1 })
  // 插件挂上时注册表还没就绪；过一会儿才出现（模拟服务就绪顺序）。
  registryService = fakeRegistry()
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(registryService.entities.length, 1, '重试直到把任务工作区登记上')
  assert.equal(path.resolve(registryService.entities[0].path), path.resolve(tasksRoot))
})

test('state 用 sessionQuery 列举冷会话，认不出工作区归属的也算任务', async () => {
  const harness = mount({
    records: [
      { id: 'session-cold', createdAt: 1_700_000_000_000, cwd: 'C:\\gone\\away' },
      { id: 'session-sub', createdAt: 1_700_000_000_000, cwd: '', origin: 'subagent' },
    ],
  })
  const state = (await post(harness, 'state')).json.value
  assert.deepEqual(state.dayGroups.flatMap((group) => group.sessions.map((session) => session.id)), ['session-cold'])
})

test('openFolder 定位任务根 / 某天 / 某个会话，越界被拒', async () => {
  const harness = mount()
  const root = (await post(harness, 'openFolder', {})).json.value
  assert.equal(root.path, path.resolve(harness.tasksRoot))
  assert.equal(root.opened, true)

  // 某一天 / 某个会话的文件夹（先在磁盘上造出来）
  const dayDir = path.join(harness.tasksRoot, '2026-10-26', 'session-abc')
  fs.mkdirSync(dayDir, { recursive: true })
  const day = (await post(harness, 'openFolder', { day: '2026-10-26' })).json.value
  assert.equal(day.path, path.join(path.resolve(harness.tasksRoot), '2026-10-26'))
  assert.equal(day.opened, true)
  const session = (await post(harness, 'openFolder', { day: '2026-10-26', sessionId: 'session-abc' })).json.value
  assert.equal(session.path, dayDir)

  const missing = await post(harness, 'openFolder', { day: '1999-01-01' })
  assert.equal(missing.status, 404)

  // 不是日期就当没给：安全地落到任务根本身，而不是拿它拼路径
  const fallback = await post(harness, 'openFolder', { day: '..' })
  assert.equal(fallback.status, 200)
  assert.equal(fallback.json.value.path, path.resolve(harness.tasksRoot))
})

test('describe 暴露任务根目录、任务工作区、能否建工作区与当前归档', async () => {
  const harness = mount({
    records: [{ id: 'session-cold', createdAt: 1_700_000_000_000, cwd: 'C:\\gone\\away' }],
  })
  const answer = await post(harness, 'describe')
  assert.equal(answer.json.value.tasksRoot, path.resolve(harness.tasksRoot))
  assert.equal(answer.json.value.canCreateWorkspace, true)
  assert.notEqual(answer.json.value.taskWorkspaceId, '', '任务默认工作区 id')
  assert.equal(answer.json.value.taskAreas.length, 1)
  assert.equal(path.resolve(answer.json.value.taskAreas[0].path), path.resolve(harness.tasksRoot))
  assert.equal(answer.json.value.dayGroups.length, 1)
  assert.match(answer.json.value.layout, /session\.v4\.jsonl\.zstd$/)
})

// ---- v0.6：删除会话 ----

/**
 * 在磁盘上造一条会话的痕迹：DSH 日志 + 插件按天副本 + 投影缓存。
 * @param {string} home - DSH home。
 * @param {string} tasksRoot - 任务根目录。
 * @param {string} sessionId - 会话 id。
 * @param {string} [day] - 按天副本放在哪天。
 * @returns {{sessionDir: string, archiveDir: string, cacheFile: string}} 三处路径。
 */
function seedSessionFiles(home, tasksRoot, sessionId, day = '2026-10-27') {
  const sessionDir = path.join(home, 'sessions', '--C-Users-17915-.dsh-tasks--', sessionId)
  const archiveDir = path.join(tasksRoot, day, sessionId)
  const cacheFile = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, SESSION_LOG_FILE), 'log')
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.writeFileSync(path.join(archiveDir, 'session.json'), '{}')
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  fs.writeFileSync(cacheFile, '{}')
  return { sessionDir, archiveDir, cacheFile }
}

test('deleteSession：日志 / 按天副本 / 投影缓存移进回收站，登记面一并摘干净', async () => {
  const harness = mount({
    records: [{ id: 'session-del', createdAt: 1_700_000_000_000, cwd: null }],
  })
  const seeded = seedSessionFiles(harness.home, harness.tasksRoot, 'session-del')

  // 先让它成为任务区工作区的成员，并且处于「已归档」——这两处都要被摘掉。
  await post(harness, 'state')
  const root = harness.workspaces.entities.find(
    (entity) => path.resolve(entity.path) === path.resolve(harness.tasksRoot),
  )
  await root.attachSession('session-del')
  await harness.workspaces.archiveSession('session-del')
  assert.deepEqual(root.sessionIds, ['session-del'])
  assert.deepEqual(harness.workspaces.archived, ['session-del'])

  const answer = await post(harness, 'deleteSession', { sessionId: 'session-del' })
  assert.equal(answer.status, 200)
  const value = answer.json.value
  assert.equal(value.deleted, true)
  assert.equal(value.missing, false)
  assert.ok(
    value.trashDir.startsWith(path.join(harness.home, 'task-folders', 'trash')),
    '默认进回收站',
  )
  assert.equal(fs.existsSync(seeded.sessionDir), false, 'DSH 日志搬走')
  assert.equal(fs.existsSync(seeded.archiveDir), false, '按天副本搬走')
  assert.equal(fs.existsSync(seeded.cacheFile), false, '投影缓存搬走')
  assert.equal(fs.existsSync(path.dirname(seeded.archiveDir)), false, '空的按天文件夹顺手收掉')

  const manifest = JSON.parse(fs.readFileSync(path.join(value.trashDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.sessionId, 'session-del')
  assert.equal(manifest.targets.length, 3)
  assert.ok(manifest.targets.every((entry) => fs.existsSync(entry.to)), '回收站里三份都在')

  assert.deepEqual(harness.workspaces.archived, [], '归档集合里也摘掉')
  assert.deepEqual(root.sessionIds, [], '工作区成员表里也摘掉')
  assert.deepEqual(value.forgotten, { unarchived: true, detached: 1 })

  const described = (await post(harness, 'describe')).json.value
  assert.equal(described.trashRoot, path.join(harness.home, 'task-folders', 'trash'))
  assert.equal(described.trashMode, true)
})

test('deleteSession：会话还在干活就拒绝（409），一个字节都不动', async () => {
  const harness = mount({ activity: () => [{ kind: 'turn' }] })
  const seeded = seedSessionFiles(harness.home, harness.tasksRoot, 'session-busy')

  const answer = await post(harness, 'deleteSession', { sessionId: 'session-busy' })
  assert.equal(answer.status, 409)
  assert.equal(answer.json.error.code, 'session-active')
  assert.match(answer.json.error.message, /先停下来再删除/)
  assert.equal(fs.existsSync(seeded.sessionDir), true)
  assert.equal(fs.existsSync(seeded.archiveDir), true)
})

test('deleteSession：缺 id / 带路径字符 / 超长一律 400；找不到的会话是幂等的 missing', async () => {
  const harness = mount()
  assert.equal((await post(harness, 'deleteSession', {})).status, 400)
  assert.equal((await post(harness, 'deleteSession', { sessionId: 'a/b' })).status, 400)
  assert.equal((await post(harness, 'deleteSession', { sessionId: '..' })).status, 400)
  assert.equal((await post(harness, 'deleteSession', { sessionId: 'x'.repeat(201) })).status, 400)

  const ghost = await post(harness, 'deleteSession', { sessionId: 'session-ghost' })
  assert.equal(ghost.status, 200)
  assert.deepEqual(
    { deleted: ghost.json.value.deleted, missing: ghost.json.value.missing, trashDir: ghost.json.value.trashDir },
    { deleted: false, missing: true, trashDir: null },
  )
})

test('deleteSession：config.trash=false 时永久删除，不留回收站', async () => {
  const harness = mount({ config: { trash: false } })
  const seeded = seedSessionFiles(harness.home, harness.tasksRoot, 'session-purge')

  const answer = await post(harness, 'deleteSession', { sessionId: 'session-purge' })
  assert.equal(answer.status, 200)
  const value = answer.json.value
  assert.equal(value.deleted, true)
  assert.equal(value.trashDir, null, '不建回收站条目')
  assert.deepEqual(value.removed.map((entry) => entry.kind).sort(), ['archive', 'projection', 'session'])
  assert.equal(fs.existsSync(seeded.sessionDir), false)
  assert.equal(fs.existsSync(seeded.archiveDir), false)
  assert.equal(fs.existsSync(path.join(harness.home, 'task-folders', 'trash')), false)
})

test(
  'deleteSession：会话日志搬不动时整单放弃——别的痕迹不动，登记表也不动',
  { skip: process.platform === 'win32' ? false : 'rename 在 POSIX 上不受打开的句柄影响' },
  async () => {
    const harness = mount({
      records: [{ id: 'session-locked', createdAt: 1_700_000_000_000, cwd: null }],
    })
    const seeded = seedSessionFiles(harness.home, harness.tasksRoot, 'session-locked')
    await post(harness, 'state')
    const root = harness.workspaces.entities.find(
      (entity) => path.resolve(entity.path) === path.resolve(harness.tasksRoot),
    )
    await root.attachSession('session-locked')
    await harness.workspaces.archiveSession('session-locked')

    // Windows 上目录里有打开着的文件时 rename 会 EPERM：正是「DSH 还开着这会话」的样子。
    const handle = fs.openSync(path.join(seeded.sessionDir, SESSION_LOG_FILE), 'r+')
    try {
      const answer = await post(harness, 'deleteSession', { sessionId: 'session-locked' })
      assert.equal(answer.status, 409)
      assert.equal(answer.json.error.code, 'session-locked')
      assert.match(answer.json.error.message, /重启 DSH/)
    } finally {
      fs.closeSync(handle)
    }

    assert.equal(fs.existsSync(seeded.archiveDir), true, '按天副本也没动')
    assert.equal(fs.existsSync(seeded.cacheFile), true, '投影缓存也没动')
    assert.deepEqual(root.sessionIds, ['session-locked'], '成员表不动')
    assert.deepEqual(harness.workspaces.archived, ['session-locked'], '归档集合不动')
    assert.equal(fs.existsSync(path.join(harness.home, 'task-folders', 'trash')), false, '不留空回收站条目')
  },
)
