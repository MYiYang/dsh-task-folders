import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createSessionIndex } from '../lib/sessions.js'

/**
 * 造一个假的工作区注册表（行为对齐 workspaceRegistry 的公开语义：
 * list 返回实体、delete 只摘登记）。
 * @returns {object} 假注册表。
 */
function fakeRegistry() {
  const entities = []
  return {
    entities,
    list: () => entities.slice(),
    create(dir, title) {
      const entity = {
        id: `workspace-${entities.length + 1}`,
        path: dir,
        title: title ?? path.basename(dir),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
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
  }
}

test('isTaskHeader：没有 cwd 的会话也算任务（v0.3 遗留的无主会话）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-sess-'))
  const tasks = createSessionIndex({ tasksRoot: root, workspaces: fakeRegistry() })
  assert.equal(tasks.isTaskHeader({ cwd: undefined }), true)
  assert.equal(tasks.isTaskHeader({}), true)
})

test('isTaskHeader：cwd 落在任务根目录树里就收（哪怕它就是任务工作区自己）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-sess2-'))
  const root = path.join(home, 'tasks')
  fs.mkdirSync(path.join(root, 'default'), { recursive: true })
  const workspaces = fakeRegistry()
  return workspaces.create(root, '任务').then(() => {
    const tasks = createSessionIndex({ tasksRoot: root, workspaces })
    assert.equal(tasks.isTaskHeader({ cwd: root }), true, '任务默认工作区本身')
    assert.equal(tasks.isTaskHeader({ cwd: path.join(root, 'default') }), true, '老任务容器')
  })
})

test('isTaskHeader：cwd 落在普通工作区里就不收', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-sess3-'))
  const root = path.join(home, 'tasks')
  const workspaces = fakeRegistry()
  const project = path.join(home, 'my-project')
  fs.mkdirSync(project, { recursive: true })
  return workspaces.create(project, '我的项目').then(() => {
    const tasks = createSessionIndex({ tasksRoot: root, workspaces })
    assert.equal(tasks.isTaskHeader({ cwd: project }), false, '工作区里的会话不收')
    assert.equal(tasks.isTaskHeader({ cwd: path.join(home, 'elsewhere') }), true, '无主的仍然收')
  })
})

test('isTaskHeader：子代理会话一律不收', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-sess4-'))
  const tasks = createSessionIndex({ tasksRoot: root, workspaces: fakeRegistry() })
  assert.equal(tasks.isTaskHeader({ cwd: undefined, origin: 'subagent' }), false)
  const project = path.join(root, '..', 'dtf-proj')
  fs.mkdirSync(project, { recursive: true })
  assert.equal(tasks.isTaskHeader({ cwd: project, origin: 'subagent' }), false)
  assert.equal(tasks.isTaskHeader({ cwd: root, origin: 'subagent' }), false, '任务区里的子代理也不收')
})

test('isTaskPath 只认根目录内部（大小写/相对路径都归到绝对路径比较）', () => {
  const tasks = createSessionIndex({ tasksRoot: 'F:\\dsh\\tasks', workspaces: fakeRegistry() })
  assert.equal(tasks.isTaskPath('F:\\dsh\\tasks\\default'), true)
  assert.equal(tasks.isTaskPath('F:\\dsh\\tasks'), true)
  assert.equal(tasks.isTaskPath('F:\\dsh\\tasks-other'), false)
  assert.equal(tasks.isTaskPath('F:\\dsh\\tasks\\..\\takeout'), false)
  assert.equal(tasks.isTaskPath(''), false)
  assert.equal(tasks.isTaskPath(undefined), false)
})

test('workspacePathKeys 收已登记工作区的规范化路径', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-sess4-'))
  const root = path.join(home, 'tasks')
  const workspaces = fakeRegistry()
  const project = path.join(home, 'my-project')
  fs.mkdirSync(project, { recursive: true })
  return workspaces.create(project, '我的项目').then(() => {
    const tasks = createSessionIndex({ tasksRoot: root, workspaces })
    const keys = tasks.workspacePathKeys()
    assert.equal(keys.size, 1)
    const expected = process.platform === 'win32' ? fs.realpathSync(project).toLowerCase() : fs.realpathSync(project)
    assert.equal(keys.has(expected), true)
  })
})

test('注册表缺席时：没有工作区路径、所有带 cwd 的会话都算无工作区', () => {
  const tasks = createSessionIndex({ tasksRoot: path.join(os.tmpdir(), 'dtf-none'), workspaces: undefined })
  assert.equal(tasks.workspacePathKeys().size, 0)
  assert.equal(tasks.isTaskHeader({ cwd: 'F:\\anywhere' }), true)
})

test('ensureRoot 建目录 + .gitignore，且不覆盖用户改过的内容', () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-sess5-')), 'tasks')
  const tasks = createSessionIndex({ tasksRoot: root, workspaces: fakeRegistry() })
  assert.equal(tasks.ensureRoot(), path.resolve(root))
  assert.equal(fs.existsSync(root), true)
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /20\[0-9\]/)

  fs.writeFileSync(path.join(root, '.gitignore'), '# 用户自己写的', 'utf8')
  tasks.ensureRoot()
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '# 用户自己写的', '不覆盖')
})
