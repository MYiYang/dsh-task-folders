/**
 * 技能清单 / 安装 / 删除（Host 侧纯逻辑，可脱离 ctx 单测）。
 *
 * DSH 的技能目录由 `ctx.skills` 注册表合并多个提供方：官方随包带的技能来源是
 * `bundled`，本地文件系统提供方（`dsh-skill-filesystem`）再按 rank 扫描
 * `<project>/.dsh/skills`、`<project>/.agents/skills`、自定义目录、`<DSH_HOME>/skills`
 * 与 `~/.agents/skills`。设置页只负责**展示**与**管理用户自己的那份**
 * （`<DSH_HOME>/skills`，source = `user-dsh`）：官方技能只读，项目/共享目录里的技能
 * 也不在删除范围内——这是本模块里唯一一条防线的用意。
 *
 * 技能格式（与 `dsh-skill-filesystem` 一致）：
 *
 *   <root>/<name>/SKILL.md      ← 目录 bundle，可有 references/、scripts/ 等资源
 *   <root>/<name>.md            ← 平铺单文件
 *
 * SKILL.md 以 YAML frontmatter 开头，`name`（kebab-case）与 `description` 必填。
 * 安装时把上传的文件写进 `<root>/<name>/`，先落临时目录再整目录 rename——
 * 中途失败不会留下半套技能；删除默认移进 `<DSH_HOME>/task-folders/skill-trash/`，
 * 和会话删除的回收站同一个家。
 * @module lib/skills
 */
import fs from 'node:fs'
import path from 'node:path'
import { isInside } from './paths.js'

/** 技能名规则：与 `dsh-skill` 的 `SKILL_NAME` 完全一致（kebab-case）。 */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 单个上传文件上限（解码后字节数）。 */
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024
/** 单次安装的上传总字节上限。 */
export const MAX_SKILL_TOTAL_BYTES = 8 * 1024 * 1024
/** 单次安装的文件数上限：技能包是几个 markdown + 脚本，120 已经很宽松。 */
export const MAX_SKILL_FILES = 120

/** frontmatter 的起止：允许 BOM、CRLF，正文可以没有尾换行。 */
const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

/** 带 HTTP 语义的技能操作失败。 */
export class SkillInstallError extends Error {
  /**
   * @param {string} code - 机器可读错误码。
   * @param {string} message - 给人看的原因。
   * @param {number} [status] - HTTP 状态码。
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'SkillInstallError'
    this.code = code
    this.status = status
  }
}

/**
 * 把 frontmatter 里的一个标量还原成字符串：支持双引号（JSON 转义）、单引号与裸值。
 * @param {string} raw - `key:` 后面的原文。
 * @returns {string} 还原后的值。
 */
function scalar(raw) {
  const text = raw.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed === 'string') return parsed
    } catch {
      /* 不是合法 JSON 字符串：按字面去掉引号 */
    }
    return text.slice(1, -1)
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

/**
 * 解析 SKILL.md 的 YAML frontmatter（只关心顶层的简单标量，够目录用）。
 *
 * 为什么不用 `yaml` 包：这是插件，零依赖是硬约束；技能 frontmatter 的字段是
 * `name` / `description` / `whenToUse` / 两个布尔，嵌套字段（`metadata`）原样不解析，
 * 交给 DSH 自己那份 `yaml` 处理。解析失败（没有 frontmatter）返回 `undefined`。
 * @param {string} raw - 文件全文。
 * @returns {{data: Record<string, string>, body: string}|undefined} 解析结果。
 */
export function parseFrontmatter(raw) {
  if (typeof raw !== 'string') return undefined
  const match = FRONTMATTER.exec(raw)
  if (match === null) return undefined
  const lines = match[1].split(/\r?\n/)
  /** @type {Record<string, string>} */
  const data = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*(#|$)/.test(line)) continue
    const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (field === null) continue
    const key = field[1]
    const rest = field[2].trim()
    // 块标量：description: | / >，收掉后面的缩进行。
    if (/^[|>][+-]?$/.test(rest)) {
      const folded = rest.startsWith('>')
      const collected = []
      while (index + 1 < lines.length && (lines[index + 1].trim() === '' || /^\s+/.test(lines[index + 1]))) {
        index += 1
        collected.push(lines[index].replace(/^\s+/, ''))
      }
      data[key] = folded ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n').trim()
      continue
    }
    // 嵌套对象 / 数组（metadata、tags 之类）不归这里管。
    if (rest === '') continue
    data[key] = scalar(rest)
  }
  return { data, body: raw.slice(match[0].length) }
}

/**
 * 由表单字段拼一份 SKILL.md：frontmatter 用 JSON 转义（YAML 双引号标量兼容 JSON），
 * 正文原样保留。description 里带引号、换行都不会把 frontmatter 弄坏。
 * @param {{name: string, description: string, whenToUse?: string, body?: string}} draft - 表单字段。
 * @returns {string} SKILL.md 全文。
 */
export function composeSkillMarkdown(draft) {
  const lines = ['---', `name: ${draft.name}`, `description: ${JSON.stringify(draft.description)}`]
  if (typeof draft.whenToUse === 'string' && draft.whenToUse.trim() !== '') {
    lines.push(`whenToUse: ${JSON.stringify(draft.whenToUse)}`)
  }
  lines.push('---', '', String(draft.body ?? '').trim(), '')
  return lines.join('\n')
}

/**
 * 校验技能名并返回它。
 * @param {unknown} value - 候选名。
 * @returns {string} kebab-case 技能名。
 */
export function requireSkillName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!SKILL_NAME.test(name)) {
    throw new SkillInstallError('invalid-name', `技能名必须是 kebab-case（小写字母、数字、连字符）：${name || '（空）'}`, 400)
  }
  return name
}

/**
 * 规整上传文件的相对路径；越界（绝对路径、盘符、`..`、NUL）一律拒绝。
 * @param {unknown} value - 原始路径（浏览器给的可能是 `a\b\c.md`）。
 * @returns {string|undefined} 以 `/` 分段的相对路径。
 */
export function normalizeRelativePath(value) {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (cleaned === '' || cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) return undefined
  const parts = cleaned.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0) return undefined
  if (parts.some((part) => part === '..' || part.includes('\u0000'))) return undefined
  return parts.join('/')
}

/**
 * 目录上传（`webkitdirectory` / 拖文件夹）通常自带一层根目录名：所有文件都在同一个
 * 顶层目录下时把它去掉，SKILL.md 才能落在技能根上。多文件但顶层不同则原样保留。
 * @param {{path: string}[]} files - 文件列表。
 * @returns {{path: string}[]} 去掉公共根后的列表。
 */
export function stripCommonRoot(files) {
  if (files.length === 0) return files
  const segments = files.map((file) => file.path.split('/'))
  const root = segments[0][0]
  const shared = segments.every((parts) => parts.length > 1 && parts[0] === root)
  if (!shared) return files
  // 单个 `references/a.md` 不算「带根目录的技能包」——去掉 references 会让它冒充
  // SKILL.md，把一份资源误装成技能。单个文件只有在本身就是 `*/SKILL.md` 时才去根。
  if (files.length === 1 && segments[0][1].toLowerCase() !== 'skill.md') return files
  return files.map((file, index) => ({ ...file, path: segments[index].slice(1).join('/') }))
}

/**
 * 把 base64 解成 Buffer；空串返回空 Buffer。
 * @param {unknown} value - base64 文本。
 * @returns {Buffer} 字节。
 */
function decodeBase64(value) {
  if (typeof value !== 'string') throw new SkillInstallError('invalid-file', '上传文件缺少内容', 400)
  const text = value.replace(/\s+/g, '')
  if (text === '') return Buffer.alloc(0)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new SkillInstallError('invalid-file', '上传文件不是合法 base64', 400)
  return Buffer.from(text, 'base64')
}

/**
 * 文本上传（`content` 字段）转字节。
 * @param {unknown} value - 文本。
 * @returns {Buffer} utf8 字节。
 */
function encodeText(value) {
  if (typeof value !== 'string') throw new SkillInstallError('invalid-file', '上传文件缺少内容', 400)
  return Buffer.from(value, 'utf8')
}

/**
 * 读一个上传条目的字节：优先 `data`（base64），其次 `content`（文本）。
 * @param {object} entry - `{ path, data?, content? }`。
 * @returns {Buffer} 字节。
 */
function entryBytes(entry) {
  if (typeof entry?.data === 'string') return decodeBase64(entry.data)
  return encodeText(entry?.content)
}

/**
 * 把上传列表整理成一次可安装的技能：找根上的 SKILL.md、解析 frontmatter、校验名字。
 *
 * 兼容三种现实上传形态：
 *   1. 拖/选一个技能目录 → 带根目录名，先 stripCommonRoot；
 *   2. 选单个 `<name>.md`（平铺技能）→ 没有 SKILL.md 时把它当作 SKILL.md；
 *   3. 只上传 SKILL.md 本身。
 * @param {{files?: unknown}} input - 请求里的 `files` 数组。
 * @returns {{name: string, description: string, files: {path: string, buffer: Buffer}[]}} 规整结果。
 */
export function prepareUpload(input) {
  const raw = Array.isArray(input?.files) ? input.files : []
  if (raw.length === 0) throw new SkillInstallError('no-files', '没有收到要安装的技能文件', 400)
  if (raw.length > MAX_SKILL_FILES) throw new SkillInstallError('too-many-files', `一次最多上传 ${MAX_SKILL_FILES} 个文件`, 413)

  let files = []
  let total = 0
  for (const entry of raw) {
    const rel = normalizeRelativePath(entry?.path)
    if (rel === undefined) throw new SkillInstallError('invalid-path', `上传路径不合法：${String(entry?.path ?? '')}`, 400)
    const buffer = entryBytes(entry)
    if (buffer.length > MAX_SKILL_FILE_BYTES) {
      throw new SkillInstallError('file-too-large', `文件过大（上限 ${MAX_SKILL_FILE_BYTES / 1024 / 1024}MB）：${rel}`, 413)
    }
    total += buffer.length
    if (total > MAX_SKILL_TOTAL_BYTES) {
      throw new SkillInstallError('upload-too-large', `一次安装的内容过大（上限 ${MAX_SKILL_TOTAL_BYTES / 1024 / 1024}MB）`, 413)
    }
    files.push({ path: rel, buffer })
  }

  files = stripCommonRoot(files)

  let skillIndex = files.findIndex((file) => file.path.toLowerCase() === 'skill.md')
  if (skillIndex < 0 && files.length === 1 && /^[^/]+\.md$/i.test(files[0].path)) {
    files[0] = { ...files[0], path: 'SKILL.md' }
    skillIndex = 0
  }
  if (skillIndex < 0) {
    throw new SkillInstallError('missing-skill-md', '技能包里没有 SKILL.md（目录 bundle 的根上必须有这个文件）', 400)
  }

  const text = files[skillIndex].buffer.toString('utf8')
  const parsed = parseFrontmatter(text)
  if (parsed === undefined) throw new SkillInstallError('invalid-frontmatter', 'SKILL.md 缺少 YAML frontmatter（--- 开头的那一段）', 400)
  const name = requireSkillName(parsed.data.name)
  if (name.length > 100) throw new SkillInstallError('invalid-name', '技能名过长（上限 100 字）', 400)
  const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : ''
  if (description === '') throw new SkillInstallError('missing-description', 'SKILL.md 的 frontmatter 缺少 description', 400)
  if (description.length > 2_000) throw new SkillInstallError('description-too-long', '技能描述过长（上限 2000 字）', 400)
  if (files.filter((file) => file.path.toLowerCase() === 'skill.md').length > 1) {
    throw new SkillInstallError('duplicate-skill-md', '技能包里有多份 SKILL.md', 400)
  }

  return { name, description, files }
}

/**
 * 把表单草稿转成一份上传列表。
 * @param {object} draft - `{ name, description, whenToUse, body }`。
 * @returns {{path: string, content: string}[]} 上传列表。
 */
export function draftToFiles(draft) {
  const name = requireSkillName(draft?.name)
  const description = typeof draft?.description === 'string' ? draft.description.trim() : ''
  if (description === '') throw new SkillInstallError('missing-description', '技能描述不能为空', 400)
  if (description.length > 2_000) throw new SkillInstallError('description-too-long', '技能描述过长（上限 2000 字）', 400)
  const whenToUse = typeof draft?.whenToUse === 'string' ? draft.whenToUse.trim() : ''
  const body = typeof draft?.body === 'string' ? draft.body : ''
  return [
    {
      path: 'SKILL.md',
      content: composeSkillMarkdown({ name, description, whenToUse, body }),
    },
  ]
}

/**
 * 技能来源 → 设置页的分类。分类是 UI 概念，但放在 Host 侧保证同一份口径：
 *   - official：官方随包提供（`bundled`）
 *   - user：用户自己的（`user-dsh` 与共享的 `user-agents`，以及自定义目录）
 *   - project：项目仓库里的
 *   - runtime：运行时注册的（预设/插件注入）
 * @param {string} source - `SkillSummary.source`。
 * @returns {'official'|'user'|'project'|'runtime'|'other'} 分类。
 */
export function skillCategory(source) {
  switch (source) {
    case 'bundled':
      return 'official'
    case 'user-dsh':
    case 'user-agents':
    case 'custom':
      return 'user'
    case 'project-dsh':
    case 'project-agents':
      return 'project'
    case 'runtime':
      return 'runtime'
    default:
      return 'other'
  }
}

/**
 * 把一个 `SkillSummary` 投影成设置页要的视图。
 * @param {object} summary - `ctx.skills` 的摘要。
 * @param {string} userRoot - 用户技能根（删除权限的边界）。
 * @returns {object} 视图对象。
 */
export function skillView(summary, userRoot) {
  const skillPath = typeof summary?.path === 'string' ? summary.path : ''
  const relative = skillPath === '' || !isInside(userRoot, skillPath) ? '' : path.relative(userRoot, skillPath)
  const managed = relative !== '' && relative.split(/[\\/]/)[0] !== '.system'
  return {
    name: String(summary?.name ?? ''),
    description: String(summary?.description ?? ''),
    whenToUse: typeof summary?.whenToUse === 'string' ? summary.whenToUse : '',
    source: String(summary?.source ?? ''),
    category: skillCategory(summary?.source),
    provider: String(summary?.provider ?? ''),
    path: skillPath,
    invocation: {
      modelInvocable: summary?.invocation?.modelInvocable !== false,
      userInvocable: summary?.invocation?.userInvocable !== false,
    },
    resourceBase: summary?.resourceBase ?? null,
    userManaged: managed,
  }
}

/**
 * 清掉技能名里的危险片段，只用于回收站目录名（不参与技能查找）。
 * @param {string} name - 技能名。
 * @returns {string} 安全名字。
 */
function safeName(name) {
  return String(name).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80)
}

/**
 * 把已经存在的目标移到回收站；`trash: false` 时直接删除。
 * @param {string} target - 绝对路径。
 * @param {string} home - DSH home。
 * @param {string} name - 技能名（回收站子目录名用）。
 * @returns {{trashed: boolean, trashPath: string}} 结果。
 */
function moveToTrash(target, home, name) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)
  const trashRoot = path.join(home, 'task-folders', 'skill-trash')
  fs.mkdirSync(trashRoot, { recursive: true })
  const destination = path.join(trashRoot, `${safeName(name)}-${stamp}-${Math.random().toString(36).slice(2, 6)}`)
  fs.renameSync(target, destination)
  return { trashed: true, trashPath: destination }
}

/**
 * 安装一个技能到用户技能根：先写临时目录，再整目录 rename。
 *
 * 已存在同名技能时：`overwrite !== true` 抛 `skill-exists`（409），由客户端弹
 * 「覆盖安装」二次确认；`overwrite === true` 时先把旧目录移进回收站再装新的。
 * @param {{home: string, root?: string, files?: unknown, draft?: object, overwrite?: boolean}} input - 安装参数。
 * @returns {{name: string, path: string, files: number, overwritten: boolean}} 安装结果。
 */
export function installSkill(input) {
  const home = path.resolve(input.home)
  const root = path.resolve(input.root ?? path.join(home, 'skills'))
  const prepared =
    input.files !== undefined && input.files !== null
      ? prepareUpload({ files: input.files })
      : (() => {
          const draftFiles = draftToFiles(input.draft)
          return prepareUpload({ files: draftFiles })
        })()

  const target = path.join(root, prepared.name)
  const flatTarget = path.join(root, `${prepared.name}.md`)
  if (!isInside(root, target) || !isInside(root, flatTarget)) {
    throw new SkillInstallError('invalid-target', '技能目录不在用户技能根内', 400)
  }

  fs.mkdirSync(root, { recursive: true })
  // 同名技能可能以两种形态存在：目录 bundle `<name>/` 或平铺文件 `<name>.md`。
  // 只查目录会漏掉平铺那份，装完就变成「两份同名、谁赢看 rank」的暗坑。
  const existing = []
  for (const candidate of [target, flatTarget]) {
    try {
      fs.lstatSync(candidate)
      existing.push(candidate)
    } catch {
      /* 不存在 */
    }
  }
  if (existing.length > 0 && input.overwrite !== true) {
    throw new SkillInstallError('skill-exists', `同名技能已经存在：${prepared.name}`, 409)
  }

  const tempRoot = path.join(home, 'task-folders', 'tmp')
  fs.mkdirSync(tempRoot, { recursive: true })
  const temp = fs.mkdtempSync(path.join(tempRoot, 'skill-'))
  const movedAside = []
  try {
    for (const file of prepared.files) {
      const destination = path.join(temp, ...file.path.split('/'))
      if (!isInside(temp, destination)) throw new SkillInstallError('invalid-path', `上传路径越界：${file.path}`, 400)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, file.buffer)
    }
    for (const candidate of existing) {
      // 旧目标先挪走：Windows 的 rename 不能覆盖已存在的目录；软链只摘链接。
      const stat = fs.lstatSync(candidate)
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(candidate)
      } else {
        const trashed = moveToTrash(candidate, home, prepared.name)
        movedAside.push({ from: candidate, to: trashed.trashPath })
      }
    }
    fs.renameSync(temp, target)
    return {
      name: prepared.name,
      path: target,
      files: prepared.files.length,
      overwritten: existing.length > 0,
      description: prepared.description,
    }
  } catch (error) {
    // 装失败时把已经挪走的旧版本放回原位——别让一次失败的覆盖把用户原来的技能弄没。
    for (const entry of movedAside.reverse()) {
      try {
        if (!fs.existsSync(entry.from) && fs.existsSync(entry.to)) fs.renameSync(entry.to, entry.from)
      } catch {
        /* 放不回去就留在回收站，至少没丢 */
      }
    }
    try {
      fs.rmSync(temp, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉也不影响主流程 */
    }
    if (error instanceof SkillInstallError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new SkillInstallError('install-failed', `技能写入失败：${message}`, 500)
  }
}

/**
 * 删除一个用户技能：只允许 `<DSH_HOME>/skills` 里的路径，默认移进回收站。
 *
 * 官方技能、项目技能、共享 `~/.agents/skills` 里的技能都不在删除范围内——它们的
 * `path` 不在用户根下，这里会直接 403。符号链接只摘链接本身，不碰指向的目标。
 * @param {{home: string, root?: string, name: string, path?: string, trash?: boolean}} input - 删除参数。
 * @returns {{name: string, trashed: boolean, trashPath: string}} 结果。
 */
export function deleteSkill(input) {
  const home = path.resolve(input.home)
  const root = path.resolve(input.root ?? path.join(home, 'skills'))
  const name = requireSkillName(input.name)
  let candidate = path.resolve(typeof input.path === 'string' && input.path !== '' ? input.path : path.join(root, name))
  if (!isInside(root, candidate)) {
    throw new SkillInstallError('not-managed', '只能删除安装在 DSH 用户技能目录里的技能', 403)
  }
  let relative = path.relative(root, candidate)
  if (relative === '' || relative.split(/[\\/]/)[0] === '.system') {
    throw new SkillInstallError('not-managed', '不能删除系统内置的技能目录', 403)
  }
  let stat
  try {
    stat = fs.lstatSync(candidate)
  } catch {
    // 客户端只给了技能名 / 目录路径时，兼容平铺形态 `<root>/<name>.md`。
    const flat = path.join(root, `${name}.md`)
    if (candidate === path.join(root, name) && fs.existsSync(flat)) {
      candidate = flat
      relative = path.relative(root, flat)
      stat = fs.lstatSync(flat)
    } else {
      throw new SkillInstallError('not-found', `技能文件不存在：${relative}`, 404)
    }
  }

  // 目录 bundle 的摘要 path 是 `<root>/<name>/SKILL.md`：要摘的是它所在的那个技能目录，
  // 而不是单独一份 SKILL.md（否则 references/ 等资源会留在原地变成孤儿）。
  const target =
    !stat.isDirectory() && path.basename(candidate).toLowerCase() === 'skill.md'
      ? path.dirname(candidate)
      : candidate
  if (target === root || !isInside(root, target)) {
    throw new SkillInstallError('not-managed', '只能删除技能目录本身', 403)
  }

  if (input.trash === false) {
    fs.rmSync(target, { recursive: true, force: true })
    return { name, trashed: false, trashPath: '' }
  }
  const trashed = moveToTrash(target, home, name)
  return { name, ...trashed }
}
