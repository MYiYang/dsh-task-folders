/**
 * 按天归档扫描：任务根目录下的会话存档（新布局 + v0.2 遗留容器）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { scanSessionsRoot } from '../lib/scan.js'

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

test('scanSessionsRoot 按天倒序、天内按创建时间倒序', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-scan-'))
  writeSession(root, '2026-10-24', 'session-a', { title: '老会话', createdAt: 1 })
  writeSession(root, '2026-10-26', 'session-c', { title: '新会话', createdAt: 9 })
  writeSession(root, '2026-10-26', 'session-b', { title: '次新', createdAt: 3 })
  // 不是日期目录的东西不能混进来
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), '# 用户自己的文件', 'utf8')

  const scan = scanSessionsRoot(root, { liveIds: new Set(['session-c']) })
  assert.deepEqual(scan.days.map((group) => group.day), ['2026-10-26', '2026-10-24'])
  assert.deepEqual(scan.days[0].sessions.map((session) => session.id), ['session-c', 'session-b'])
  assert.equal(scan.days[0].sessions[0].live, true)
  assert.equal(scan.days[0].sessions[0].title, '新会话')
  assert.equal(scan.days[0].sessions[0].dir, '2026-10-26/session-c')
  assert.equal(scan.days[0].sessions[0].bytes, 12)
  assert.equal(scan.dayCount, 2)
  assert.equal(scan.sessionCount, 3)
  assert.equal(scan.byId.get('session-b').day, '2026-10-26')
})

test('scanSessionsRoot 对缺失目录 / 坏 session.json 都不炸', () => {
  assert.deepEqual(scanSessionsRoot(path.join(os.tmpdir(), 'dtf-not-there-xyz')), {
    days: [],
    dayCount: 0,
    sessionCount: 0,
    byId: new Map(),
  })

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-scan2-'))
  const broken = path.join(root, '2026-10-26', 'session-broken')
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(path.join(broken, 'session.json'), '{ 坏掉的', 'utf8')
  const scan = scanSessionsRoot(root)
  assert.equal(scan.sessionCount, 1)
  assert.equal(scan.days[0].sessions[0].id, 'session-broken', '读不到元数据就用目录名')
})

test('scanSessionsRoot 两种布局都认，新布局优先、老容器补缺', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-scan3-'))
  // v0.2 的遗留任务容器：<root>/<容器>/<天>/<会话>/
  writeSession(root, '2026-10-25', 'session-old', { title: '老任务会话', createdAt: 2, container: 'default' })
  writeSession(root, '2026-10-25', 'session-legacy', { title: '另一个容器', createdAt: 3, container: '1-tedb612' })
  // v0.3 的新布局：<root>/<天>/<会话>/
  writeSession(root, '2026-10-27', 'session-new', { title: '新会话', createdAt: 8 })
  // 同一个会话两处都有：新的赢
  writeSession(root, '2026-10-27', 'session-old', { title: '新布局里的同名会话', createdAt: 8 })

  const scan = scanSessionsRoot(root)
  assert.equal(scan.sessionCount, 3)
  assert.equal(scan.byId.get('session-old').title, '新布局里的同名会话', '新布局覆盖旧容器')
  assert.equal(scan.byId.get('session-legacy').day, '2026-10-25')
  assert.deepEqual(scan.days.map((group) => group.day), ['2026-10-27', '2026-10-25'])
})
