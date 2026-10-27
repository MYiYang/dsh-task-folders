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

test('buildState：无工作区的会话按天分组，工作区里的不掺进来', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-state-'))
  const root = path.join(home, 'tasks')
  const project = path.join(home, 'my-project')
  fs.mkdirSync(project, { recursive: true })
  writeSession(root, '2026-10-26', 'session-x', { title: '会话甲', createdAt: 5 })
  writeSession(root, '2026-10-26', 'session-y', { title: '', createdAt: 6 })
  writeSession(root, '2026-10-25', 'session-z', { title: '老会话', createdAt: 1 })

  const state = buildState({
    root,
    liveIds: new Set(['session-y']),
    canCreate: true,
    records: [
      { id: 'session-x', createdAt: 5, cwd: root, live: false },
      { id: 'session-y', createdAt: 6, cwd: '', live: true },
      { id: 'session-z', createdAt: 1, cwd: root, live: false },
      // 工作区里的会话：不进任务组
      { id: 'session-p', createdAt: 7, cwd: project, live: false },
      // 子代理：不是独立对话
      { id: 'session-sub', createdAt: 7, cwd: '', origin: 'subagent', live: false },
      // 全局归档的：默认不显示
      { id: 'session-archived', createdAt: 7, cwd: '', live: false },
    ],
    workspaces: [{ id: 'w-plain', path: project, title: '我的项目', sessionIds: ['session-p'] }],
    archivedIds: new Set(['session-archived']),
    now: () => 1_800_000_000_000,
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
    ['1970-01-01'],
    '归档会话按它自己的那天分组',
  )
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
  writeSession(root, '2026-10-24', 'session-cold', { title: '冷会话', createdAt: 4 })
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
