import assert from 'node:assert/strict'
import test from 'node:test'
import {
  archiveGitignore,
  dayDir,
  dayKey,
  isDayKey,
  isInside,
  safeSegment,
  sessionDir,
  sessionRelative,
} from '../lib/paths.js'

test('dayKey 用本地时区，不是 UTC', () => {
  // 本地时间 2026-10-26 00:30：如果实现用 toISOString，UTC 早于 +08 会掉到 25 号。
  const local = new Date(2026, 9, 26, 0, 30, 0, 0)
  assert.equal(dayKey(local.getTime()), '2026-10-26')
  const late = new Date(2026, 9, 26, 23, 59, 59, 0)
  assert.equal(dayKey(late.getTime()), '2026-10-26')
  assert.equal(dayKey(new Date(2026, 0, 1, 0, 0, 0).getTime()), '2026-01-01')
})

test('dayKey 对非法输入回退到当前时间', () => {
  const today = dayKey(Date.now())
  assert.equal(dayKey(Number.NaN), today)
  assert.equal(dayKey(undefined), today)
})

test('isDayKey 只认 YYYY-MM-DD', () => {
  assert.equal(isDayKey('2026-10-26'), true)
  assert.equal(isDayKey('2026-1-6'), false)
  assert.equal(isDayKey('2026-10-26/..'), false)
  assert.equal(isDayKey(undefined), false)
  assert.equal(isDayKey('../2026-10-26'), false)
})

test('safeSegment 保留中文、清理非法字符', () => {
  assert.equal(safeSegment('查询行政许可'), '查询行政许可')
  assert.equal(safeSegment('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i')
  assert.equal(safeSegment('  两边空格  '), '两边空格')
  assert.equal(safeSegment('trailing dots...'), 'trailing-dots')
  assert.equal(safeSegment(''), 'task')
  assert.equal(safeSegment('...'), 'task')
  assert.equal(safeSegment('CON'), 'CON-task')
  assert.equal(safeSegment('lpt1'), 'lpt1-task')
})

test('safeSegment 按码点截断，不会切坏中文', () => {
  const sliced = safeSegment('一二三四五六七八九十', 4)
  assert.equal(sliced, '一二三四')
  assert.equal(Array.from(sliced).length, 4)
})

test('目录布局拼装（任务根 / 天 / 会话）', () => {
  assert.equal(dayDir('F:\\tasks', '2026-10-26'), 'F:\\tasks\\2026-10-26')
  assert.equal(sessionDir('F:\\tasks', '2026-10-26', 'session-1234'), 'F:\\tasks\\2026-10-26\\session-1234')
  assert.equal(sessionRelative('2026-10-26', 'session-1234'), '2026-10-26/session-1234')
})

test('isInside 拒绝父目录自身与外部路径', () => {
  const root = 'F:\\tasks'
  assert.equal(isInside(root, 'F:\\tasks\\2026-10-26'), true)
  assert.equal(isInside(root, root), false)
  assert.equal(isInside(root, 'F:\\other'), false)
  assert.equal(isInside(root, 'F:\\tasks\\..\\takeout'), false)
})

test('.gitignore 只忽略按天文件夹', () => {
  const text = archiveGitignore()
  assert.match(text, /20\[0-9\]\[0-9\]-\[0-9\]\[0-9\]-\[0-9\]\[0-9\]\//)
  assert.doesNotMatch(text, /^\*$/m, '不能整目录忽略，用户自己的文件要能进 git')
})
