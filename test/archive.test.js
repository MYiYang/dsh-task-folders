import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createSessionArchive, frameOf, inflateFrames } from '../lib/archive.js'
import { SESSION_FILE, SESSION_LOG_FILE } from '../lib/paths.js'

/**
 * 建一个空的会话文件夹。
 * @returns {string} 目录绝对路径。
 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-archive-'))
}

/**
 * 读回一个会话日志的所有行。
 * @param {string} dir - 会话文件夹。
 * @returns {object[]} 解析后的事件行。
 */
function readLines(dir) {
  const buffer = fs.readFileSync(path.join(dir, SESSION_LOG_FILE))
  return inflateFrames(buffer)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

const header = { version: 4, id: 'session-aaaa', createdAt: 1_700_000_000_000, cwd: 'F:\\ws', isSeeded: false }

test('open 写 DSH 默认格式的会话头', () => {
  const dir = tempDir()
  const archive = createSessionArchive({ flushDelayMs: 0 })
  archive.open({ dir, header })
  archive.closeAll()

  const lines = readLines(dir)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].type, 'session')
  assert.equal(lines[0].version, 4)
  assert.equal(lines[0].id, 'session-aaaa')
  assert.equal(lines[0].cwd, 'F:\\ws')

  const meta = JSON.parse(fs.readFileSync(path.join(dir, SESSION_FILE), 'utf8'))
  assert.equal(meta.sessionId, 'session-aaaa')
  // -1 = 还没写过任何事件（不是「写过 seq 0」）
  assert.equal(meta.lastSeq, -1)
  assert.equal(meta.log, SESSION_LOG_FILE)
  assert.equal(meta.format, 'dsh-task-folders/session@3')
})

test('append + flush 把事件按 seq 顺序写成多帧 zstd JSONL', () => {
  const dir = tempDir()
  const archive = createSessionArchive({ flushDelayMs: 0 })
  const handle = archive.open({ dir, header, task: { id: 't1', title: '任务' }, day: '2026-10-26' })

  const events = [
    { type: 'user/message', seq: 0, time: 1_700_000_001_000, data: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', seq: 1, time: 1_700_000_002_000, data: { turn: 1, step: 1, message: { role: 'assistant' }, stream: [] } },
    { type: 'tool/call', seq: 2, time: 1_700_000_003_000, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
  ]
  assert.equal(archive.append(handle, events), 3)
  archive.flush(handle)
  archive.closeAll()

  const lines = readLines(dir)
  assert.equal(lines.length, 4)
  assert.deepEqual(
    lines.slice(1).map((line) => [line.type, line.seq]),
    [
      ['user/message', 0],
      ['assistant/message', 1],
      ['tool/call', 2],
    ],
  )
  assert.equal(lines[1].data.content[0].text, '你好')

  // 多帧：文件里不止一个 zstd 魔数（DSH 自己也是逐帧 append 的）
  const raw = fs.readFileSync(path.join(dir, SESSION_LOG_FILE))
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  let frames = 0
  for (let cursor = raw.indexOf(magic, 0); cursor !== -1; cursor = raw.indexOf(magic, cursor + magic.length)) {
    frames += 1
  }
  assert.ok(frames >= 2, `期望多帧，实际 ${frames}`)

  const meta = JSON.parse(fs.readFileSync(path.join(dir, SESSION_FILE), 'utf8'))
  assert.equal(meta.lastSeq, 2)
  assert.equal(meta.task.id, 't1')
  assert.equal(meta.day, '2026-10-26')
})

test('按 seq 去重：重复投递的事件不会写第二遍', () => {
  const dir = tempDir()
  const archive = createSessionArchive({ flushDelayMs: 0 })
  const handle = archive.open({ dir, header })
  archive.append(handle, [{ type: 'user/message', seq: 0, time: 1, data: {} }])
  archive.flush(handle)
  // 同一条事件再来一次（例如 Host 重启后重复补写）
  assert.equal(archive.append(handle, [{ type: 'user/message', seq: 0, time: 1, data: {} }]), 0)
  // 乱序到达的旧 seq 也一样被忽略，新的照写
  assert.equal(archive.append(handle, [{ type: 'step/start', seq: 5, time: 2, data: {} }, { type: 'step/end', seq: 3, time: 3, data: {} }]), 1)
  archive.flush(handle)
  archive.closeAll()

  const seqs = readLines(dir).slice(1).map((line) => line.seq)
  assert.deepEqual(seqs, [0, 5])
})

test('重新打开时从日志恢复写入进度（session.json 落后也不重复）', () => {
  const dir = tempDir()
  const first = createSessionArchive({ flushDelayMs: 0 })
  const handle = first.open({ dir, header })
  first.append(handle, [
    { type: 'user/message', seq: 0, time: 1, data: {} },
    { type: 'assistant/message', seq: 1, time: 2, data: {} },
  ])
  first.flush(handle)
  first.closeAll()

  // 模拟崩溃：元数据里的 lastSeq 落后于日志
  const metaPath = path.join(dir, SESSION_FILE)
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, lastSeq: 0 }), 'utf8')

  const second = createSessionArchive({ flushDelayMs: 0 })
  const reopened = second.open({ dir, header })
  assert.equal(reopened.nextSeq, 2)
  second.append(reopened, [{ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }])
  second.flush(reopened)
  second.closeAll()

  const lines = readLines(dir)
  assert.equal(lines.length, 1 + 3)
  assert.deepEqual(lines.slice(1).map((line) => line.seq), [0, 1, 2])
})

test('setTitle 更新 session.json，重复写同标题不再落盘', () => {
  const dir = tempDir()
  const archive = createSessionArchive({ flushDelayMs: 0 })
  const handle = archive.open({ dir, header })
  archive.setTitle(handle, '重构登录会话')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, SESSION_FILE), 'utf8')).title, '重构登录会话')
  const before = fs.statSync(path.join(dir, SESSION_FILE)).mtimeMs
  archive.setTitle(handle, '重构登录会话')
  assert.equal(fs.statSync(path.join(dir, SESSION_FILE)).mtimeMs, before)
  archive.closeAll()
})

test('大 payload 与换行文本能原样往返', () => {
  const dir = tempDir()
  const archive = createSessionArchive({ flushDelayMs: 0 })
  const handle = archive.open({ dir, header })
  const big = 'line\nwith\nnewlines ' + 'x'.repeat(200_000)
  archive.append(handle, [{ type: 'tool/result', seq: 0, time: 1, data: { text: big } }])
  archive.flush(handle)
  archive.closeAll()
  const lines = readLines(dir)
  assert.equal(lines[1].data.text.length, big.length)
})

test('坏事件不打断写入，且 nextSeq 仍然推进', () => {
  const dir = tempDir()
  const archive = createSessionArchive({ flushDelayMs: 0 })
  const handle = archive.open({ dir, header })
  const circular = { type: 'tool/result', seq: 0, time: 1, data: {} }
  circular.data.self = circular
  assert.equal(archive.append(handle, [circular]), 0)
  assert.equal(handle.nextSeq, 1)
  assert.equal(archive.append(handle, [{ type: 'step/start', seq: 1, time: 2, data: {} }]), 1)
  archive.flush(handle)
  archive.closeAll()
  assert.deepEqual(readLines(dir).slice(1).map((line) => line.seq), [1])
})

test('setHeader：还没写事件时能用真实头纠正占位头，写了事件就锁死', () => {
  const dir = tempDir()
  const archive = createSessionArchive({ flushDelayMs: 0 })
  // 打开时用了占位头（例如会话对象还没就绪）
  const handle = archive.open({
    dir,
    header: { version: 4, id: 'session-aaaa', createdAt: 1, cwd: 'C:\\guess', isSeeded: false },
  })
  const real = { version: 4, id: 'session-aaaa', createdAt: 1_700_000_000_000, cwd: 'F:\\ws', isSeeded: false, agentPreset: 'cordis' }
  assert.equal(archive.setHeader(handle, real), 'rewritten')
  const lines = readLines(dir)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].cwd, 'F:\\ws')
  assert.equal(lines[0].agentPreset, 'cordis')
  assert.equal(archive.setHeader(handle, real), 'same')

  // 一旦有事件，头部就不能再改写（它是文件第一帧）
  archive.append(handle, [{ type: 'step/start', seq: 0, time: 2, data: {} }])
  archive.flush(handle)
  assert.equal(archive.setHeader(handle, { version: 4, id: 'session-aaaa', createdAt: 9, cwd: 'X:\\other' }), 'locked')
  archive.closeAll()
})

test('frameOf / inflateFrames 互为逆运算', () => {
  const frame = frameOf(['{"a":1}', '{"b":2}'])
  assert.equal(inflateFrames(frame), '{"a":1}\n{"b":2}\n')
  assert.equal(inflateFrames(Buffer.concat([frame, frame])), '{"a":1}\n{"b":2}\n{"a":1}\n{"b":2}\n')
  assert.equal(inflateFrames(Buffer.alloc(0)), '')
})
