/**
 * lib/activity.js 的单元测试（v0.12）。
 *
 * 覆盖：会话日志 mtime 扫描、活会话事件即时补、TTL 缓存、forget、目录不存在时降级。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createActivityIndex } from '../lib/activity.js'

/**
 * 造一个假的 DSH home，并写一条会话日志（可指定 mtime）。
 * @param {string} home - home 路径。
 * @param {string} group - 分组目录名（转义 cwd）。
 * @param {string} sessionId - 会话 id。
 * @param {number} [mtimeMs] - 日志 mtime（epoch 毫秒）。
 * @param {string} [fileName] - 日志文件名。
 * @returns {string} 会话目录。
 */
function writeSessionLog(home, group, sessionId, mtimeMs, fileName = 'session.v4.jsonl.zstd') {
  const dir = path.join(home, 'sessions', group, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, fileName)
  fs.writeFileSync(file, 'x')
  if (typeof mtimeMs === 'number') fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return dir
}

test('activity：扫会话日志 mtime，压缩 / 未压缩都认', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-activity-'))
  writeSessionLog(home, '--p-one--', 'session-a', 1_700_000_000_000)
  writeSessionLog(home, '--p-two--', 'session-b', 1_700_000_500_000)
  writeSessionLog(home, '--p-two--', 'session-c', 1_700_000_800_000, 'session.v4.jsonl')
  const index = createActivityIndex({ home })
  const snapshot = index.snapshot()
  assert.equal(snapshot.get('session-a'), 1_700_000_000_000)
  assert.equal(snapshot.get('session-b'), 1_700_000_500_000)
  assert.equal(snapshot.get('session-c'), 1_700_000_800_000)
})

test('activity：活会话的事件时间即时生效，且与磁盘时间取最大', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-activity-note-'))
  writeSessionLog(home, '--p--', 'session-a', 1_700_000_000_000)
  const index = createActivityIndex({ home })
  index.snapshot()
  index.note('session-a', 1_700_000_900_000)
  index.note('session-a', 1_700_000_100_000) // 更早的事件不覆盖
  index.note('session-new', 1_700_000_950_000)
  assert.equal(index.get('session-a'), 1_700_000_900_000)
  assert.equal(index.get('session-new'), 1_700_000_950_000)
  // 事件时间更早时退回磁盘 mtime
  index.note('session-b', 1)
  writeSessionLog(home, '--p--', 'session-b', 1_700_000_777_000)
  index.refresh(true)
  assert.equal(index.get('session-b'), 1_700_000_777_000)
})

test('activity：磁盘索引按 TTL 缓存，过期后重扫', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-activity-ttl-'))
  writeSessionLog(home, '--p--', 'session-a', 1_700_000_000_000)
  let clock = 1_800_000_000_000
  const index = createActivityIndex({ home, ttlMs: 10_000, now: () => clock })
  assert.equal(index.snapshot().get('session-a'), 1_700_000_000_000)
  // 磁盘上变了，但 TTL 内不重扫
  writeSessionLog(home, '--p--', 'session-a', 1_750_000_000_000)
  clock += 5_000
  assert.equal(index.snapshot().get('session-a'), 1_700_000_000_000, 'TTL 内用缓存')
  clock += 6_000
  assert.equal(index.snapshot().get('session-a'), 1_750_000_000_000, '过了 TTL 重扫')
})

test('activity：forget 之后不再返回该会话', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-activity-forget-'))
  writeSessionLog(home, '--p--', 'session-a', 1_700_000_000_000)
  const index = createActivityIndex({ home })
  index.note('session-a', 1_700_000_500_000)
  assert.equal(index.get('session-a'), 1_700_000_500_000)
  index.forget('session-a')
  assert.equal(index.get('session-a'), 0)
})

test('activity：没有 session 目录 / 没有日志文件时安静降级', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-activity-empty-'))
  const index = createActivityIndex({ home })
  assert.deepEqual([...index.snapshot()], [])
  assert.equal(index.get('session-none'), 0)
  assert.equal(index.get(''), 0)
  // 只有目录、没有日志文件：退回目录 mtime
  const dir = path.join(home, 'sessions', '--p--', 'session-dir')
  fs.mkdirSync(dir, { recursive: true })
  fs.utimesSync(dir, 1_700_000_123, 1_700_000_123)
  index.refresh(true)
  assert.equal(index.get('session-dir'), 1_700_000_123_000)
})
