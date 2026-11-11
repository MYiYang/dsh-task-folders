/**
 * lib/session-hints.js 的单元测试（v0.12）。
 *
 * 覆盖：指令文本清洗、事件里取提示、落盘 / 重启后读回、去重、forget、条数上限、
 * 坏文件降级。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { cleanTitleHint, createSessionHints, titleHintOfEvent } from '../lib/session-hints.js'

test('cleanTitleHint：只取第一行、折叠空白、截断', () => {
  assert.equal(cleanTitleHint('  日志输出如下内容\n第二行'), '日志输出如下内容')
  assert.equal(cleanTitleHint('a   b\t c'), 'a b c')
  assert.equal(cleanTitleHint('`日志输出`'), '日志输出')
  assert.equal(cleanTitleHint(''), '')
  assert.equal(cleanTitleHint('   \n\n '), '')
  assert.equal(cleanTitleHint(undefined), '')
  const long = cleanTitleHint('一'.repeat(200))
  assert.equal(Array.from(long).length, 80)
  assert.ok(long.endsWith('…'))
})

test('titleHintOfEvent：/goal 的 goal/change 与 command/run 都能取到提示', () => {
  assert.equal(
    titleHintOfEvent({
      type: 'goal/change',
      data: { goal: { objective: '日志输出如下内容 是什么问题' } },
    }),
    '日志输出如下内容 是什么问题',
  )
  assert.equal(
    titleHintOfEvent({ type: 'command/run', data: { name: 'goal', args: ' 查一下这个报错' } }),
    '查一下这个报错',
  )
  // /permission 这种参数不是标题
  assert.equal(titleHintOfEvent({ type: 'command/run', data: { name: 'permission', args: ' danger-full-access' } }), undefined)
  assert.equal(titleHintOfEvent({ type: 'command/run', data: { name: 'goal', args: '  ' } }), undefined)
  assert.equal(titleHintOfEvent({ type: 'user/message', data: {} }), undefined)
  assert.equal(titleHintOfEvent(undefined), undefined)
})

test('sessionHints：落盘后重启还能读回', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-hints-'))
  const file = path.join(home, 'task-folders', 'session-hints.json')
  const first = createSessionHints({ file, now: () => 1_000 })
  assert.equal(first.set('session-a', '日志输出如下内容'), true)
  assert.equal(first.set('session-a', '日志输出如下内容'), false, '同标题不重复写')
  assert.equal(first.get('session-a'), '日志输出如下内容')

  const second = createSessionHints({ file })
  assert.equal(second.get('session-a'), '日志输出如下内容')
  assert.deepEqual(second.snapshot(), { 'session-a': '日志输出如下内容' })
  // 文件结构可读
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(parsed.version, 1)
  assert.equal(parsed.hints[0].id, 'session-a')
})

test('sessionHints：forget / 空标题 / 坏文件都不炸', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-hints2-'))
  const file = path.join(home, 'task-folders', 'session-hints.json')
  const store = createSessionHints({ file })
  assert.equal(store.set('session-a', '第一句'), true)
  assert.equal(store.set('session-a', '   '), false, '空标题不收')
  assert.equal(store.forget('session-a'), true)
  assert.equal(store.get('session-a'), '')
  assert.equal(store.forget('session-a'), false)

  fs.writeFileSync(file, '{ not json', 'utf8')
  const broken = createSessionHints({ file })
  assert.deepEqual(broken.snapshot(), {})
  assert.equal(broken.set('session-b', '第二句'), true)
  assert.deepEqual(createSessionHints({ file }).snapshot(), { 'session-b': '第二句' })
})

test('sessionHints：超出上限丢最老的', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-hints3-'))
  const file = path.join(home, 'task-folders', 'session-hints.json')
  let clock = 1_000
  const store = createSessionHints({ file, limit: 3, now: () => clock })
  for (const id of ['session-a', 'session-b', 'session-c', 'session-d']) {
    clock += 1_000
    store.set(id, `标题-${id}`)
  }
  const snapshot = store.snapshot()
  assert.deepEqual(Object.keys(snapshot).sort(), ['session-b', 'session-c', 'session-d'])
  assert.equal(createSessionHints({ file }).get('session-a'), '', '最老的那条不落盘')
})
