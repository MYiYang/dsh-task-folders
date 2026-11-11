import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildState } from '../lib/state.js'

/**
 * 在任务根目录里写一条按天归档（模拟 Host 写过的样子）。
 * @param {string} root - 任务根目录。
 * @param {string} day - `YYYY-MM-DD`。
 * @param {string} sessionId - 会话 id。
 * @param {{title?: string, createdAt?: number, bytes?: number, container?: string}} [meta] - 附加元数据。
 * @returns {string} 会话目录。
 */
function writeSession(root, day, sessionId, meta = {}) {
  const dir = path.join(root, meta.container ?? '', day, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'session.json'),
    JSON.stringify({
      format: 'dsh-task-folders/session@3',
      sessionId,
      title: meta.title ?? '',
      createdAt: meta.createdAt ?? 0,
      updatedAt: meta.createdAt ?? 0,
      lastSeq: 3,
    }),
    'utf8',
  )
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(meta.bytes ?? 12))
  return dir
}

/**
 * 本地时区某天某点的时间戳（测试用；按天分组的键与本地时区走）。
 * @param {number} year - 年。
 * @param {number} month - 月（1-12）。
 * @param {number} day - 日。
 * @param {number} [hour] - 时（默认 9 点）。
 * @returns {number} epoch 毫秒。
 */
function at(year, month, day, hour = 9) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

test('buildState：无工作区的会话按天分组，工作区里的不掺进来', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-state-'))
  const root = path.join(home, 'tasks')
  const project = path.join(home, 'my-project')
  fs.mkdirSync(project, { recursive: true })
  writeSession(root, '2026-10-26', 'session-x', { title: '会话甲', createdAt: at(2026, 10, 26, 9) })
  writeSession(root, '2026-10-26', 'session-y', { title: '', createdAt: at(2026, 10, 26, 10) })
  writeSession(root, '2026-10-25', 'session-z', { title: '老会话', createdAt: at(2026, 10, 25, 9) })

  const state = buildState({
    root,
    liveIds: new Set(['session-y']),
    canCreate: true,
    records: [
      { id: 'session-x', createdAt: at(2026, 10, 26, 9), cwd: root, live: false },
      { id: 'session-y', createdAt: at(2026, 10, 26, 10), cwd: '', live: true },
      { id: 'session-z', createdAt: at(2026, 10, 25, 9), cwd: root, live: false },
      // 工作区里的会话：不进任务组
      { id: 'session-p', createdAt: at(2026, 10, 26, 11), cwd: project, live: false },
      // 子代理：不是独立对话
      { id: 'session-sub', createdAt: at(2026, 10, 26, 11), cwd: '', origin: 'subagent', live: false },
      // 全局归档的：默认不显示
      { id: 'session-archived', createdAt: at(2026, 10, 26, 11), cwd: '', live: false },
    ],
    workspaces: [{ id: 'w-plain', path: project, title: '我的项目', sessionIds: ['session-p'] }],
    archivedIds: new Set(['session-archived']),
    now: () => at(2026, 10, 26, 12),
  })

  assert.equal(state.tasksRoot, path.resolve(root))
  assert.equal(state.cwd, path.resolve(root), '新任务会话的工作目录就是任务根')
  assert.equal(state.taskWorkspaceId, '', '没给工作区 id 时是空串（客户端据此判断 Host 新旧）')
  assert.equal(state.canCreate, true)
  assert.equal(state.layout.sessionLog, 'session.v4.jsonl.zstd')

  // 工作区清单：普通工作区照旧列出
  assert.equal(state.workspaces.length, 1)
  assert.equal(state.workspaces[0].title, '我的项目')

  // 「任务」= 无工作区的会话，按天倒序
  assert.deepEqual(state.dayGroups.map((group) => group.day), ['2026-10-26', '2026-10-25'])
  assert.deepEqual(state.dayGroups[0].sessions.map((session) => session.id), ['session-y', 'session-x'])
  assert.equal(state.dayGroups[0].sessions.find((session) => session.id === 'session-y').live, true)
  assert.deepEqual(state.sessions.map((session) => session.id).sort(), ['session-x', 'session-y', 'session-z'])
  assert.deepEqual(state.totals, {
    sessions: 3,
    archivedSessions: 1,
    archivedWorkspaces: 0,
    days: 2,
    workspaces: 1,
    workspaceSessions: 1,
  })
  // v0.5：归档的会话不再消失，而是单列一组（客户端按「归档过滤」决定显不显示）
  assert.deepEqual(state.archivedSessions.map((session) => session.id), ['session-archived'])
  assert.deepEqual(
    state.archivedDayGroups.map((group) => group.day),
    ['2026-10-26'],
    '归档会话也按最后活跃那天分组（v0.12）；没有归档副本时就用创建时刻',
  )
  // v0.12：每条会话都带「最后活动时间」，客户端排序 / 显示时间不再被 DSH 的 updatedAt 拖住
  assert.equal(
    state.dayGroups[0].sessions.find((session) => session.id === 'session-y').activityAt,
    at(2026, 10, 26, 10),
  )
  // 工作区里的会话也在元数据里（客户端给工作区成员排序要用）
  assert.equal(state.sessionMeta['session-p'].activityAt, at(2026, 10, 26, 11))
  assert.equal(state.sessionMeta['session-sub'], undefined, '子代理不进元数据')
})

test('buildState：任务区工作区不显示在工作区组，但它的会话算任务', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-state2-'))
  const root = path.join(home, 'tasks')
  const legacy = path.join(root, 'default')
  fs.mkdirSync(legacy, { recursive: true })
  const state = buildState({
    root,
    taskWorkspaceId: 'w-tasks',
    records: [
      { id: 'session-x', createdAt: 5, cwd: legacy, live: false },
      { id: 'session-root', createdAt: 6, cwd: root, live: false },
    ],
    workspaces: [
      { id: 'w-legacy', path: legacy, title: '任务', sessionIds: ['session-x'] },
      { id: 'w-tasks', path: root, title: '任务', sessionIds: ['session-root'] },
      { id: 'w-plain', path: path.join(home, 'my-project'), title: '我的项目', sessionIds: [] },
    ],
  })
  assert.deepEqual(state.workspaces.map((workspace) => workspace.id), ['w-plain'], '任务区工作区不显示')
  assert.equal(state.taskWorkspaceId, 'w-tasks')
  // 任务区（root + 老的 default）名下的会话都进任务组，按天倒序
  assert.deepEqual(state.sessions.map((session) => session.id).sort(), ['session-root', 'session-x'])
})

test('buildState：普通工作区的会话不进任务组（哪怕它 cwd 认不出来）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-state2b-'))
  const root = path.join(home, 'tasks')
  const project = path.join(home, 'my-project')
  fs.mkdirSync(project, { recursive: true })
  const state = buildState({
    root,
    records: [
      { id: 'session-p', createdAt: 5, cwd: project, live: false },
      { id: 'session-stray', createdAt: 6, cwd: 'C:\\gone\\away', live: false },
    ],
    workspaces: [{ id: 'w-plain', path: project, title: '我的项目', sessionIds: ['session-p'] }],
  })
  assert.deepEqual(state.workspaces.map((workspace) => workspace.id), ['w-plain'])
  assert.deepEqual(state.sessions.map((session) => session.id), ['session-stray'], '只有无主的落进任务')
})

test('buildState：归档里有、records 里没有的会话也列出来', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-state3-'))
  writeSession(root, '2026-10-24', 'session-cold', { title: '冷会话', createdAt: at(2026, 10, 24) })
  const state = buildState({ root, records: [] })
  assert.deepEqual(state.dayGroups.map((group) => group.day), ['2026-10-24'])
  assert.equal(state.dayGroups[0].sessions[0].id, 'session-cold')
  assert.equal(state.dayGroups[0].sessions[0].archived, true)
})

test('buildState：没有 cwd 的会话也算无工作区', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-state4-'))
  const state = buildState({
    root,
    records: [{ id: 'session-nocwd', createdAt: 5, cwd: '', live: false }],
    workspaces: [{ id: 'w', path: path.join(root, '..', 'p'), title: 'p', sessionIds: [] }],
  })
  assert.deepEqual(state.sessions.map((session) => session.id), ['session-nocwd'])
  // 没有归档就按会话创建那天分组（epoch 5ms 在本地时区是 1970-01-01）
  assert.equal(state.dayGroups[0].sessions[0].day, '1970-01-01')
})

test('buildState：空根目录也给得出结构', () => {
  const root = path.join(os.tmpdir(), 'dtf-empty-root-xyz')
  fs.rmSync(root, { recursive: true, force: true })
  const state = buildState({ root, records: [], workspaces: [] })
  assert.deepEqual(state.dayGroups, [])
  assert.deepEqual(state.sessions, [])
  assert.deepEqual(state.totals, {
    sessions: 0,
    archivedSessions: 0,
    archivedWorkspaces: 0,
    days: 0,
    workspaces: 0,
    workspaceSessions: 0,
  })
  assert.deepEqual(state.archivedDayGroups, [], '没有归档就空着，别让客户端画出空分组')
  assert.equal(state.canCreate, true)
})

test('buildState：项目归档只给工作区打标记，不摘登记（v0.5）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-state5-'))
  const root = path.join(home, 'tasks')
  const alpha = path.join(home, 'alpha')
  const beta = path.join(home, 'beta')
  fs.mkdirSync(alpha, { recursive: true })
  fs.mkdirSync(beta, { recursive: true })

  const state = buildState({
    root,
    records: [],
    workspaces: [
      { id: 'w-alpha', path: alpha, title: '甲项目', sessionIds: [] },
      { id: 'w-beta', path: beta, title: '乙项目', sessionIds: [] },
    ],
    archivedWorkspaces: new Set(['w-alpha']),
  })

  assert.deepEqual(
    state.workspaces.map((workspace) => workspace.id),
    ['w-alpha', 'w-beta'],
    '归档的项目仍然留在清单里，由客户端自己分堆',
  )
  assert.equal(state.workspaces[0].archived, true)
  assert.equal(state.workspaces[1].archived, false)
  assert.equal(state.totals.archivedWorkspaces, 1)
})

test('buildState：归档的会话与未归档的分开两摞，天数各算各的', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-state6-'))
  const state = buildState({
    root,
    records: [
      { id: 'session-live', createdAt: 5, cwd: root, live: false },
      { id: 'session-old', createdAt: 6, cwd: root, live: false },
    ],
    archivedIds: new Set(['session-old']),
  })
  assert.deepEqual(state.sessions.map((session) => session.id), ['session-live'])
  assert.deepEqual(state.archivedSessions.map((session) => session.id), ['session-old'])
  assert.deepEqual(state.archivedSessionIds, ['session-old'])
  assert.equal(state.dayGroups.length, 1)
  assert.equal(state.archivedDayGroups.length, 1)
  assert.equal(state.totals.sessions + state.totals.archivedSessions, 2)
})

test('buildState：指令开的会话按最后活跃那天分组（v0.12）', () => {
  // 复现真实场景：一个 2026-09-25 建好的空壳会话被「新会话」复用，2026-11-11 用
  // /goal 指令开始跑。DSH 的 updatedAt 会停在创建时刻，插件的活动索引要把它拉回今天。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-state-command-'))
  writeSession(root, '2026-09-25', 'session-command', {
    title: '',
    createdAt: at(2026, 9, 25),
  })
  const state = buildState({
    root,
    records: [{ id: 'session-command', createdAt: at(2026, 9, 25), cwd: root, live: false }],
    activity: new Map([['session-command', at(2026, 11, 11, 17)]]),
    titleHints: { 'session-command': '日志输出如下内容，是什么问题' },
    now: () => at(2026, 11, 11, 17, 30),
  })
  assert.deepEqual(state.dayGroups.map((group) => group.day), ['2026-11-11'], '按最后活跃那天落到今天')
  assert.equal(state.dayGroups[0].sessions[0].archiveDay, '2026-09-25', '磁盘副本仍记着原日期')
  assert.equal(state.dayGroups[0].sessions[0].activityAt, at(2026, 11, 11, 17))
  assert.deepEqual(state.sessionMeta['session-command'], {
    activityAt: at(2026, 11, 11, 17),
    title: '日志输出如下内容，是什么问题',
  })
})

test('buildState：工作区会话的活跃时间与标题提示也进 sessionMeta（v0.12）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-state-meta-'))
  const root = path.join(home, 'tasks')
  const project = path.join(home, 'my-project')
  fs.mkdirSync(project, { recursive: true })
  const state = buildState({
    root,
    records: [{ id: 'session-p', createdAt: at(2026, 10, 19), cwd: project, live: false }],
    workspaces: [{ id: 'w-plain', path: project, title: '我的项目', sessionIds: ['session-p'] }],
    activity: new Map([['session-p', at(2026, 11, 11, 17)]]),
    titleHints: { 'session-p': '日志输出如下内容' },
  })
  assert.deepEqual(state.workspaces[0].sessionIds, ['session-p'], '工作区成员表不动（登记顺序仍由 DSH 管）')
  assert.equal(state.sessionMeta['session-p'].activityAt, at(2026, 11, 11, 17))
  assert.equal(state.sessionMeta['session-p'].title, '日志输出如下内容')
})
