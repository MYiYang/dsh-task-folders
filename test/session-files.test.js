import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_TRASH_RETENTION_MS,
  describeRemoval,
  projectionCacheFile,
  pruneTrash,
  removeSessionFiles,
  sessionArtifactDirs,
  sessionDeleteTargets,
  trashRoot,
  trashStamp,
} from '../lib/session-files.js'
import { SESSION_LOG_FILE } from '../lib/paths.js'

/** 建一个临时 DSH home。 */
function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-files-'))
}

/**
 * 造一条会话的三处痕迹：DSH 日志、插件按天副本、投影缓存。
 * @param {string} home - DSH home。
 * @param {string} tasksRoot - 任务根目录。
 * @param {string} id - 会话 id。
 * @param {{group?: string, day?: string, cache?: boolean}} [options] - 细节。
 * @returns {{sessionDir: string, archiveDir: string, cacheFile: string}} 路径。
 */
function seedSession(home, tasksRoot, id, options = {}) {
  const group = options.group ?? '--C-Users-17915-.dsh-tasks--'
  const day = options.day ?? '2026-10-27'
  const sessionDir = path.join(home, 'sessions', group, id)
  const archiveDir = path.join(tasksRoot, day, id)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, SESSION_LOG_FILE), 'log')
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.writeFileSync(path.join(archiveDir, 'session.json'), '{}')
  const cacheFile = projectionCacheFile(home, id)
  if (options.cache !== false) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, '{}')
  }
  return { sessionDir, archiveDir, cacheFile }
}

test('会话日志按「分组目录里的同名子目录」找，不猜 cwd 的转义规则', () => {
  const home = makeHome()
  const seeded = seedSession(home, path.join(home, 'tasks'), 'session-aaaa1111', { cache: false })
  fs.mkdirSync(path.join(home, 'sessions', '--F-ssdwork-other--', 'session-bbbb2222'), { recursive: true })

  assert.deepEqual(sessionArtifactDirs(home, 'session-aaaa1111'), [seeded.sessionDir])
  assert.deepEqual(sessionArtifactDirs(home, 'session-nope'), [])
  assert.deepEqual(sessionArtifactDirs(home, ''), [], '空 id 不扫')
})

test('要删的目标：DSH 日志 + 按天副本 + 投影缓存，缺的不进清单', () => {
  const home = makeHome()
  const tasksRoot = path.join(home, 'tasks')
  const seeded = seedSession(home, tasksRoot, 'session-cccc3333')

  const targets = sessionDeleteTargets({
    home,
    sessionId: 'session-cccc3333',
    archiveDirs: [seeded.archiveDir],
    archiveRoot: tasksRoot,
  })
  assert.deepEqual(
    targets.map((target) => target.kind).sort(),
    ['archive', 'projection', 'session'],
  )

  const onlyLog = seedSession(home, tasksRoot, 'session-dddd4444', { cache: false })
  fs.rmSync(onlyLog.archiveDir, { recursive: true, force: true })
  assert.deepEqual(
    sessionDeleteTargets({ home, sessionId: 'session-dddd4444', archiveDirs: [], archiveRoot: tasksRoot }).map(
      (target) => target.kind,
    ),
    ['session'],
  )
  assert.deepEqual(sessionDeleteTargets({ home, sessionId: 'session-nope' }), [], '什么都没留下就是空清单')
})

test('删除默认进回收站：目录搬走、manifest 记下原路径、空的按天文件夹顺手收掉', () => {
  const home = makeHome()
  const tasksRoot = path.join(home, 'tasks')
  const id = 'session-eeee5555'
  const seeded = seedSession(home, tasksRoot, id)
  const dayDir = path.dirname(seeded.archiveDir)

  const report = removeSessionFiles({ home, sessionId: id, archiveDirs: [seeded.archiveDir], archiveRoot: tasksRoot })

  assert.equal(report.deleted, true)
  assert.equal(report.missing, false)
  assert.equal(fs.existsSync(seeded.sessionDir), false, 'DSH 日志搬走了')
  assert.equal(fs.existsSync(seeded.archiveDir), false, '按天副本搬走了')
  assert.equal(fs.existsSync(seeded.cacheFile), false, '投影缓存搬走了')
  assert.equal(fs.existsSync(dayDir), false, '那一天的文件夹空了就收掉')

  assert.ok(report.trashDir.startsWith(trashRoot(home)))
  const manifest = JSON.parse(fs.readFileSync(path.join(report.trashDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.sessionId, id)
  assert.equal(manifest.targets.length, 3)
  assert.ok(manifest.targets.every((entry) => fs.existsSync(entry.to)), 'manifest 里的新位置都在')
  assert.deepEqual(
    manifest.targets.map((entry) => entry.from).sort(),
    [seeded.archiveDir, seeded.cacheFile, seeded.sessionDir].sort(),
  )
  assert.equal(report.trashed.length, 3)
  assert.deepEqual(report.skipped, [])
})

test('trash:false 才真的删：不留回收站', () => {
  const home = makeHome()
  const tasksRoot = path.join(home, 'tasks')
  const id = 'session-ffff6666'
  const seeded = seedSession(home, tasksRoot, id)

  const report = removeSessionFiles({
    home,
    sessionId: id,
    archiveDirs: [seeded.archiveDir],
    archiveRoot: tasksRoot,
    trash: false,
  })

  assert.equal(report.deleted, true)
  assert.equal(report.trashDir, null)
  assert.deepEqual(report.removed.map((entry) => entry.kind).sort(), ['archive', 'projection', 'session'])
  assert.equal(fs.existsSync(seeded.sessionDir), false)
  assert.equal(fs.existsSync(seeded.archiveDir), false)
  assert.equal(fs.existsSync(seeded.cacheFile), false)
  assert.equal(fs.existsSync(trashRoot(home)), false, '不建回收站')
})

test('磁盘上什么都没有：missing，且不建空的回收站条目', () => {
  const home = makeHome()
  const report = removeSessionFiles({ home, sessionId: 'session-ghost' })
  assert.deepEqual(
    { deleted: report.deleted, missing: report.missing, trashDir: report.trashDir },
    { deleted: false, missing: true, trashDir: null },
  )
  assert.equal(fs.existsSync(trashRoot(home)), false)
  assert.equal(describeRemoval(report), '磁盘上没有这条会话的痕迹')
})

test('护栏：调用方塞进来的目录不在任务根里就跳过，一个字节都不动', () => {
  const home = makeHome()
  const tasksRoot = path.join(home, 'tasks')
  const id = 'session-9999aaaa'
  const seeded = seedSession(home, tasksRoot, id, { cache: false })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-outside-'))
  const victim = path.join(outside, 'important')
  fs.mkdirSync(victim)
  fs.writeFileSync(path.join(victim, 'keep.txt'), '别动我')

  const report = removeSessionFiles({
    home,
    sessionId: id,
    archiveDirs: [seeded.archiveDir, victim],
    archiveRoot: tasksRoot,
  })

  assert.equal(fs.existsSync(victim), true, '任务根之外的目录不许删')
  assert.ok(
    report.skipped.some((entry) => entry.reason === 'outside-root' && entry.path === victim),
    '越界的那条要记进 skipped',
  )
  assert.equal(report.deleted, true, '合法的目标照常搬走')
  assert.equal(fs.existsSync(seeded.archiveDir), false)
})

test('回收站保留 30 天：过期的清掉，新的留着', () => {
  const home = makeHome()
  const root = trashRoot(home)
  fs.mkdirSync(root, { recursive: true })
  const oldEntry = path.join(root, '20260101-000000-session-old')
  const newEntry = path.join(root, '20261027-200000-session-new')
  fs.mkdirSync(oldEntry)
  fs.mkdirSync(newEntry)
  const now = Date.parse('2026-10-27T20:00:00+08:00')
  const old = new Date(now - DEFAULT_TRASH_RETENTION_MS - 86400000)
  fs.utimesSync(oldEntry, old, old)

  const report = pruneTrash({ home, now })
  assert.deepEqual(report.removed, [oldEntry])
  assert.equal(report.kept, 1)
  assert.equal(fs.existsSync(oldEntry), false)
  assert.equal(fs.existsSync(newEntry), true)
})

test('回收站条目名：本地时区的时间戳 + 压过的会话 id', () => {
  assert.match(trashStamp(Date.parse('2026-10-27T21:03:05+08:00')), /^20261027-210305$/)
  const home = makeHome()
  const report = removeSessionFiles({ home, sessionId: 'session-:bad' })
  assert.equal(report.missing, true, '怪 id 只是删不到东西，不该抛')
})

test('同一条会话连删两次也不会撞名，第二次只是 missing', () => {
  const home = makeHome()
  const tasksRoot = path.join(home, 'tasks')
  const id = 'session-7777bbbb'
  const seeded = seedSession(home, tasksRoot, id, { cache: false })
  const now = Date.parse('2026-10-27T10:00:00+08:00')
  const first = removeSessionFiles({ home, sessionId: id, archiveDirs: [seeded.archiveDir], archiveRoot: tasksRoot, now })
  const second = removeSessionFiles({ home, sessionId: id, archiveDirs: [seeded.archiveDir], archiveRoot: tasksRoot, now })
  assert.equal(first.deleted, true)
  assert.equal(second.deleted, false)
  assert.equal(second.missing, true)
  assert.equal(fs.existsSync(first.trashDir), true)
})
