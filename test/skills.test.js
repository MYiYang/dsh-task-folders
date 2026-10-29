/**
 * lib/skills.js 的单测：frontmatter 解析、上传规整、安装/覆盖/回收站删除、分类投影。
 *
 * 全部用临时目录，不碰真实 `~/.dsh/skills`；删除只断言「目标从技能根消失、回收站里
 * 有一份完整副本」，不猜回收站的随机后缀。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  SkillInstallError,
  composeSkillMarkdown,
  deleteSkill,
  draftToFiles,
  installSkill,
  normalizeRelativePath,
  parseFrontmatter,
  prepareUpload,
  skillCategory,
  skillView,
  stripCommonRoot,
} from '../lib/skills.js'

/**
 * 造一个临时 DSH home。
 * @returns {string} 绝对路径。
 */
function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-skills-'))
}

/**
 * 一份最小的 SKILL.md。
 * @param {string} name - 技能名。
 * @param {string} [description] - 描述。
 * @param {string} [body] - 正文。
 * @returns {string} 文件内容。
 */
function skillMd(name, description = `${name} 的描述`, body = '# 用法\n\n照做即可。') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

/**
 * 上传条目（文本）。
 * @param {string} filePath - 相对路径。
 * @param {string} content - 文本。
 * @returns {{path: string, content: string}} 条目。
 */
function textFile(filePath, content) {
  return { path: filePath, content }
}

test('parseFrontmatter：裸值、引号、块标量与缺失 frontmatter', () => {
  const plain = parseFrontmatter('---\r\nname: demo-skill\r\ndescription: 一句话\r\n---\r\n\r\n正文\r\n')
  assert.deepEqual(plain?.data, { name: 'demo-skill', description: '一句话' })
  assert.equal(plain?.body.trim(), '正文')

  const quoted = parseFrontmatter('---\nname: "demo"\ndescription: "带 \\"引号\\" 的描述"\n---\nbody')
  assert.equal(quoted?.data.description, '带 "引号" 的描述')

  const block = parseFrontmatter('---\nname: demo\ndescription: |\n  第一行\n  第二行\nwhenToUse: >\n  需要时\n  再看\n---\n')
  assert.equal(block?.data.description, '第一行\n第二行')
  assert.equal(block?.data.whenToUse, '需要时 再看')

  assert.equal(parseFrontmatter('# 没有 frontmatter\n'), undefined)
  assert.equal(parseFrontmatter(42), undefined)
})

test('composeSkillMarkdown：引号与换行不会弄坏 frontmatter，且能原样解析回来', () => {
  const markdown = composeSkillMarkdown({
    name: 'quote-safe',
    description: '带 "双引号"、冒号: 还有\n换行的描述',
    whenToUse: '需要导出表格时',
    body: '# 步骤\n\n1. 打开文件\n2. 另存为',
  })
  const parsed = parseFrontmatter(markdown)
  assert.equal(parsed?.data.name, 'quote-safe')
  assert.equal(parsed?.data.description, '带 "双引号"、冒号: 还有\n换行的描述')
  assert.equal(parsed?.data.whenToUse, '需要导出表格时')
  assert.equal(parsed?.body.trim(), '# 步骤\n\n1. 打开文件\n2. 另存为')
})

test('normalizeRelativePath / stripCommonRoot：拒绝越界，目录上传去掉公共根', () => {
  assert.equal(normalizeRelativePath('references\\a.md'), 'references/a.md')
  assert.equal(normalizeRelativePath('./skills/demo/SKILL.md'), 'skills/demo/SKILL.md')
  for (const bad of ['../evil.md', '/etc/passwd', 'C:\\Windows\\x.md', '', 'a\0b.md', '.']) {
    assert.equal(normalizeRelativePath(bad), undefined, `应拒绝：${bad}`)
  }

  const stripped = stripCommonRoot([
    textFile('my-skill/SKILL.md', 'x'),
    textFile('my-skill/references/a.md', 'y'),
  ])
  assert.deepEqual(
    stripped.map((file) => file.path),
    ['SKILL.md', 'references/a.md'],
  )
  const untouched = stripCommonRoot([textFile('SKILL.md', 'x'), textFile('references/a.md', 'y')])
  assert.deepEqual(
    untouched.map((file) => file.path),
    ['SKILL.md', 'references/a.md'],
  )
})

test('prepareUpload：目录 bundle / 平铺单文件 / 缺 SKILL.md / 非法名字', () => {
  const bundle = prepareUpload({
    files: [textFile('demo/SKILL.md', skillMd('demo')), textFile('demo/references/a.md', '# ref')],
  })
  assert.equal(bundle.name, 'demo')
  assert.equal(bundle.description, 'demo 的描述')
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    ['SKILL.md', 'references/a.md'],
  )

  const flat = prepareUpload({ files: [textFile('flat-skill.md', skillMd('flat-skill'))] })
  assert.equal(flat.name, 'flat-skill')
  assert.equal(flat.files[0].path, 'SKILL.md')

  assert.throws(
    () => prepareUpload({ files: [textFile('references/a.md', '# no skill')] }),
    (error) => error instanceof SkillInstallError && error.code === 'missing-skill-md',
  )
  assert.throws(
    () => prepareUpload({ files: [textFile('SKILL.md', '---\nname: Bad_Name\ndescription: x\n---\n')] }),
    (error) => error instanceof SkillInstallError && error.code === 'invalid-name',
  )
  assert.throws(
    () => prepareUpload({ files: [textFile('SKILL.md', '---\nname: ok\ndescription: ""\n---\n')] }),
    (error) => error instanceof SkillInstallError && error.code === 'missing-description',
  )
  assert.throws(
    () => prepareUpload({ files: [textFile('../escape/SKILL.md', skillMd('escape'))] }),
    (error) => error instanceof SkillInstallError && error.code === 'invalid-path',
  )
})

test('installSkill：写进用户技能根、同名冲突、覆盖安装把旧目录收进回收站', () => {
  const home = tempHome()
  const root = path.join(home, 'skills')

  const first = installSkill({
    home,
    files: [textFile('demo/SKILL.md', skillMd('demo', 'v1')), textFile('demo/references/a.md', '# v1')],
  })
  assert.equal(first.name, 'demo')
  assert.equal(first.overwritten, false)
  assert.equal(fs.readFileSync(path.join(root, 'demo', 'SKILL.md'), 'utf8'), skillMd('demo', 'v1'))
  assert.equal(fs.readFileSync(path.join(root, 'demo', 'references', 'a.md'), 'utf8'), '# v1')

  assert.throws(
    () => installSkill({ home, files: [textFile('demo/SKILL.md', skillMd('demo', 'v2'))] }),
    (error) => error instanceof SkillInstallError && error.code === 'skill-exists' && error.status === 409,
  )

  const second = installSkill({
    home,
    files: [textFile('demo/SKILL.md', skillMd('demo', 'v2'))],
    overwrite: true,
  })
  assert.equal(second.overwritten, true)
  assert.equal(fs.readFileSync(path.join(root, 'demo', 'SKILL.md'), 'utf8'), skillMd('demo', 'v2'))
  assert.equal(fs.existsSync(path.join(root, 'demo', 'references', 'a.md')), false, '覆盖是整目录替换')
  const trashRoot = path.join(home, 'task-folders', 'skill-trash')
  const trashed = fs.readdirSync(trashRoot)
  assert.equal(trashed.length, 1, '旧版本进回收站')
  assert.equal(fs.existsSync(path.join(trashRoot, trashed[0], 'references', 'a.md')), true)
})

test('installSkill：表单草稿也能装，落盘的是带 frontmatter 的 SKILL.md', () => {
  const home = tempHome()
  const result = installSkill({
    home,
    draft: { name: 'draft-skill', description: '草稿技能', whenToUse: '想省事时', body: '# 正文' },
  })
  assert.equal(result.name, 'draft-skill')
  const raw = fs.readFileSync(path.join(home, 'skills', 'draft-skill', 'SKILL.md'), 'utf8')
  const parsed = parseFrontmatter(raw)
  assert.equal(parsed?.data.name, 'draft-skill')
  assert.equal(parsed?.data.description, '草稿技能')
  assert.equal(parsed?.body.trim(), '# 正文')
  assert.deepEqual(draftToFiles({ name: 'x', description: 'y' }).map((file) => file.path), ['SKILL.md'])
})

test('deleteSkill：目录 bundle 整目录进回收站，平铺文件也能删，越界/系统目录拒绝', () => {
  const home = tempHome()
  const root = path.join(home, 'skills')
  fs.mkdirSync(path.join(root, 'demo', 'references'), { recursive: true })
  fs.writeFileSync(path.join(root, 'demo', 'SKILL.md'), skillMd('demo'))
  fs.writeFileSync(path.join(root, 'demo', 'references', 'a.md'), '# ref')
  fs.writeFileSync(path.join(root, 'flat.md'), skillMd('flat'))
  fs.mkdirSync(path.join(root, '.system', 'hidden'), { recursive: true })
  fs.writeFileSync(path.join(root, '.system', 'hidden', 'SKILL.md'), skillMd('hidden'))

  const removed = deleteSkill({ home, name: 'demo', path: path.join(root, 'demo', 'SKILL.md') })
  assert.equal(removed.trashed, true)
  assert.equal(fs.existsSync(path.join(root, 'demo')), false)
  assert.equal(fs.existsSync(path.join(removed.trashPath, 'references', 'a.md')), true)

  const flat = deleteSkill({ home, name: 'flat', path: path.join(root, 'flat.md') })
  assert.equal(fs.existsSync(path.join(root, 'flat.md')), false)
  assert.equal(fs.existsSync(flat.trashPath), true)

  assert.throws(
    () => deleteSkill({ home, name: 'office', path: path.join(home, 'elsewhere', 'office', 'SKILL.md') }),
    (error) => error instanceof SkillInstallError && error.code === 'not-managed',
  )
  assert.throws(
    () => deleteSkill({ home, name: 'hidden', path: path.join(root, '.system', 'hidden', 'SKILL.md') }),
    (error) => error instanceof SkillInstallError && error.code === 'not-managed',
  )
  assert.throws(
    () => deleteSkill({ home, name: 'nope', path: path.join(root, 'nope', 'SKILL.md') }),
    (error) => error instanceof SkillInstallError && error.code === 'not-found',
  )
})

test('skillCategory / skillView：官方、用户、项目、运行时分开，只有用户根内的可删', () => {
  assert.equal(skillCategory('bundled'), 'official')
  assert.equal(skillCategory('user-dsh'), 'user')
  assert.equal(skillCategory('user-agents'), 'user')
  assert.equal(skillCategory('custom'), 'user')
  assert.equal(skillCategory('project-dsh'), 'project')
  assert.equal(skillCategory('project-agents'), 'project')
  assert.equal(skillCategory('runtime'), 'runtime')
  assert.equal(skillCategory('remote-registry'), 'other')

  const userRoot = path.join('C:', 'Users', 'demo', '.dsh', 'skills')
  const user = skillView(
    {
      name: 'mine',
      description: '我的技能',
      path: path.join(userRoot, 'mine', 'SKILL.md'),
      source: 'user-dsh',
      provider: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: false },
    },
    userRoot,
  )
  assert.equal(user.category, 'user')
  assert.equal(user.userManaged, true)
  assert.equal(user.invocation.userInvocable, false)

  const official = skillView(
    {
      name: 'office',
      description: '官方',
      path: 'E:\\soft\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-skill-office\\assets\\office\\SKILL.md',
      source: 'bundled',
      provider: 'dsh-office',
    },
    userRoot,
  )
  assert.equal(official.category, 'official')
  assert.equal(official.userManaged, false)

  const system = skillView(
    { name: 'system', description: '系统', path: path.join(userRoot, '.system', 'x', 'SKILL.md'), source: 'user-dsh' },
    userRoot,
  )
  assert.equal(system.userManaged, false)
})

test('installSkill：同名平铺 `<name>.md` 也算冲突，覆盖时一并清掉', () => {
  const home = tempHome()
  const root = path.join(home, 'skills')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'flat-demo.md'), skillMd('flat-demo', '平铺旧版'))

  assert.throws(
    () => installSkill({ home, files: [textFile('flat-demo/SKILL.md', skillMd('flat-demo', '目录版'))] }),
    (error) => error instanceof SkillInstallError && error.code === 'skill-exists',
  )

  const result = installSkill({
    home,
    files: [textFile('flat-demo/SKILL.md', skillMd('flat-demo', '目录版'))],
    overwrite: true,
  })
  assert.equal(result.overwritten, true)
  assert.equal(fs.existsSync(path.join(root, 'flat-demo', 'SKILL.md')), true)
  assert.equal(fs.existsSync(path.join(root, 'flat-demo.md')), false, '旧的平铺文件进回收站')
})

test('deleteSkill：只给名字时也能删掉平铺 `<name>.md`', () => {
  const home = tempHome()
  const root = path.join(home, 'skills')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'by-name.md'), skillMd('by-name'))
  const removed = deleteSkill({ home, name: 'by-name' })
  assert.equal(removed.trashed, true)
  assert.equal(fs.existsSync(path.join(root, 'by-name.md')), false)
  assert.equal(fs.existsSync(removed.trashPath), true)
})
