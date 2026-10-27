// Preview what the new sidebar would show, using the REAL $DSH_HOME data (read-only).
// Feeds buildState with: real workspace registry rows (storages/workspace.json),
// real session records (storages/session_projcache), real tasksRoot on disk.
import fs from 'node:fs'
import path from 'node:path'
import { buildState } from '../lib/state.js'

const home = 'C:\\Users\\17915\\.dsh'
const root = path.join(home, 'tasks')

const registry = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'))
const entities = Object.entries(registry.tables?.workspaces ?? {}).map(([id, record]) => ({
  id,
  path: record.path,
  title: record.title,
  sessionIds: record.sessionIds ?? [],
}))

// 真实会话记录：projcache 的 identity（含 cwd / createdAt）
const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')
const records = []
for (const file of fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf8'))
  } catch {
    continue
  }
  const identity = parsed?.record?.identity
  if (identity === undefined) continue
  records.push({
    id: file.replace(/\.json$/, ''),
    createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : 0,
    cwd: typeof identity.cwd === 'string' ? identity.cwd : '',
    origin: identity.origin,
    live: false,
  })
}

// v0.4 视角：任务区（root 及其子目录）的工作区照旧登记着，只是侧栏不显示它们；
// buildState 自己会过滤，并把它们的会话算进「任务」。
const rootKey = root.toLowerCase()
const taskWorkspaceId =
  entities.find((entity) => String(entity.path).toLowerCase() === root.toLowerCase())?.id ?? ''

const state = buildState({
  root,
  taskWorkspaceId,
  records,
  workspaces: entities,
  archivedIds: new Set(registry.global?.archivedSessionIds ?? []),
})

console.log('tasksRoot:', state.tasksRoot)
console.log('taskWorkspaceId:', state.taskWorkspaceId || '（无）')
console.log('\n== 工作区组（普通工作区） ==')
for (const workspace of state.workspaces) {
  console.log(`  ${workspace.title}  (${workspace.sessionIds.length} 个会话)  ${workspace.path}`)
}

console.log('\n== 任务组（任务区会话 + 无主遗留，按天分隔） ==')
for (const group of state.dayGroups) {
  console.log(`  ${group.day}  (${group.sessions.length})`)
  for (const session of group.sessions) {
    const created = session.createdAt > 0 ? new Date(session.createdAt).toISOString().slice(0, 16) : '?'
    console.log(`      ${session.id}  createdAt=${created}${session.archived ? '  [有归档]' : ''}`)
  }
}
console.log('\ntotals:', JSON.stringify(state.totals))
console.log(
  '任务区工作区（隐藏）：',
  entities
    .filter((e) => String(e.path).toLowerCase().startsWith(rootKey))
    .map((e) => `${e.title} @ ${e.path}`)
    .join('；') || '无',
)
