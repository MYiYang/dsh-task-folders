/**
 * 「已归档项目」存储的单测：只碰一个 JSON 文件，读坏、写坏都不能炸。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProjectArchive } from '../lib/project-archive.js'

/**
 * 造一个临时归档文件路径。
 * @returns {{dir: string, file: string}} 目录与文件。
 */
function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-projects-'))
  return { dir, file: path.join(dir, 'task-folders', 'projects.json') }
}

test('初始为空；归档 / 恢复会落盘，并且幂等', () => {
  const { file } = temporary()
  const store = createProjectArchive({ file })
  assert.deepEqual(store.list(), [])
  assert.equal(store.includes('w-1'), false)

  const first = store.set('w-1', true)
  assert.deepEqual(first, { archived: ['w-1'], changed: true })
  assert.equal(fs.existsSync(file), true, '第一次归档就把文件建出来')

  // 重复归档：不再写盘，也说「没变」
  assert.deepEqual(store.set('w-1', true), { archived: ['w-1'], changed: false })

  // 再开一个实例读同一份文件：归档是持久的
  const reopened = createProjectArchive({ file })
  assert.deepEqual(reopened.list(), ['w-1'])
  assert.equal(reopened.includes('w-1'), true)

  assert.deepEqual(reopened.set('w-1', false), { archived: [], changed: true })
  assert.equal(createProjectArchive({ file }).includes('w-1'), false, '恢复也落盘了')
})

test('文件结构是 {version, archived}，可读可查', () => {
  const { file } = temporary()
  const store = createProjectArchive({ file })
  store.set('w-alpha', true)
  store.set('w-beta', true)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.version, 1)
  assert.deepEqual(saved.archived, ['w-alpha', 'w-beta'])
})

test('坏文件当「没有归档」，不抛；写入失败时内存跟着回滚', () => {
  const { dir, file } = temporary()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8')
  const store = createProjectArchive({ file })
  assert.deepEqual(store.list(), [], '坏 JSON 退化成空集合')

  // 让写入失败：把父目录换成一个文件，mkdir / rename 都会失败
  const brokenFile = path.join(dir, 'blocked', 'projects.json')
  fs.writeFileSync(path.join(dir, 'blocked'), '', 'utf8')
  const blocked = createProjectArchive({ file: brokenFile })
  const result = blocked.set('w-x', true)
  assert.deepEqual(result, { archived: [], changed: false }, '写不进去就说没变')
  assert.equal(blocked.includes('w-x'), false, '内存里不留幻觉')
})

test('非法 id 一律不收（空串 / 非字符串 / 空白）', () => {
  const { file } = temporary()
  const store = createProjectArchive({ file })
  assert.deepEqual(store.set('', true), { archived: [], changed: false })
  assert.deepEqual(store.set('   ', true), { archived: [], changed: false })
  assert.deepEqual(store.set(undefined, true), { archived: [], changed: false })
  assert.equal(store.includes(undefined), false)
  assert.equal(store.includes(''), false)
})

test('文件里混进垃圾 id 也只保留合法的那几条', () => {
  const { file } = temporary()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 1, archived: ['w-ok', '', 42, null, 'w-two'] }), 'utf8')
  const store = createProjectArchive({ file })
  assert.deepEqual(store.list(), ['w-ok', 'w-two'])
})
