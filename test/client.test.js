/**
 * 客户端半侧的静态契约 + 渲染冒烟测试。
 *
 * 没有浏览器、没有 DOM、没有 React：用一个极小的假 React 把侧栏区域跑一遍，验证七件事——
 *   1. 只注册 `sidebar.workspaces` 一个槽，并用 priority -1 遮盖内置浏览器；
 *   2. 「任务」直接按天列会话（今天 / 昨天 / YYYY-MM-DD），不需要展开；
 *   3. 「任务」的 ＋ 建一条**没有工作区**的会话（sessions.create({cwd}) → openSession）；
 *   4. 每个工作区行尾都有 ＋，点在它上面是在这个工作区里新建会话（startSession(workspaceId)）；
 *   5. 会话行首有状态点（running / done / pending / idle），颜色走 DSH 令牌；
 *   6. 「项目」标题与工作区行都有文件夹图标（DSH 图标集优先，拿不到退回自带 SVG）；
 *   7. 样式表用 DSH 的令牌与几何。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

/** `__ModuleLoader__.load` 收到的包定义。 */
let loaded

/**
 * 造一个假 React。
 * @returns {object} 假 React。
 */
function makeReact() {
  const element = (type, props, children) => ({ type, props: props ?? {}, children })
  return {
    createElement(type, props, ...children) {
      return element(type, props, children.flat(Number.POSITIVE_INFINITY))
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    useRef(value) {
      return { current: value }
    },
  }
}

/**
 * 遍历假元素树，收集所有文本。
 * @param {unknown} node - 节点。
 * @param {string[]} [out] - 收集器。
 * @returns {string[]} 文本数组。
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  for (const child of node.children ?? []) collectText(child, out)
  return out
}

/**
 * 遍历假元素树，按类型收集节点。
 * @param {unknown} node - 节点。
 * @param {string} type - 节点类型。
 * @param {object[]} [out] - 收集器。
 * @returns {object[]} 命中的节点。
 */
function collectByType(node, type, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.type === type) out.push(node)
  for (const child of node.children ?? []) collectByType(child, type, out)
  return out
}

/** 本地时区的 YYYY-MM-DD（与插件的 dayKey 同一算法）。 */
function dayKey(time) {
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const TODAY = dayKey(Date.now())
const YESTERDAY = (() => {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  return dayKey(date.getTime())
})()

/** 客户端会话快照的假数据。 */
const SESSION_SUMMARIES = {
  'session-aaaa1111': {
    displayTitle: '聊聊登录重构',
    running: true,
    updatedAt: Date.now() - 60_000,
    projectionValues: { title: null },
  },
  'session-bbbb2222': {
    displayTitle: '1-tedb612',
    running: false,
    updatedAt: Date.now() - 7_200_000,
    projectionValues: { title: '昨天那条' },
  },
  'session-cccc3333': {
    displayTitle: '别的项目会话',
    running: false,
    updatedAt: Date.now() - 90_000_000,
    projectionValues: { title: null },
  },
  'session-dddd4444': {
    displayTitle: '归档的老会话',
    running: false,
    updatedAt: Date.now() - 200_000_000,
    projectionValues: { title: '归档的老会话' },
  },
  'session-eeee5555': {
    displayTitle: '远程搜到的',
    running: false,
    updatedAt: Date.now() - 300_000_000,
    projectionValues: { title: '远程搜到的' },
  },
}

/** uiSession 的假状态：会话 id → {running, pendingInteraction, completionUnread}。 */
const SESSION_STATUSES = new Map([
  ['session-aaaa1111', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ['session-bbbb2222', { running: false, pendingInteraction: undefined, completionUnread: true }],
  ['session-cccc3333', { running: false, pendingInteraction: 'approval', completionUnread: false }],
])

/** 一份和 Host `state` 同形的状态。 */
function fixtureState() {
  return {
    generatedAt: Date.now(),
    tasksRoot: 'C:\\Users\\17915\\.dsh\\tasks',
    taskWorkspaceId: 'w-tasks',
    cwd: 'C:\\Users\\17915\\.dsh\\tasks',
    canCreate: true,
    layout: { dayFormat: 'YYYY-MM-DD', sessionLog: 'session.v4.jsonl.zstd' },
    dayGroups: [
      {
        day: TODAY,
        sessions: [
          { id: 'session-aaaa1111', day: TODAY, createdAt: 1, live: true, archived: true },
          { id: 'session-bbbb2222', day: TODAY, createdAt: 2, live: false, archived: true },
        ],
      },
      { day: YESTERDAY, sessions: [{ id: 'session-cccc3333', day: YESTERDAY, createdAt: 3, live: false, archived: true }] },
    ],
    sessions: [],
    workspaces: [
      {
        id: 'w-plain',
        title: '我的项目',
        path: 'F:\\ssdwork\\vscode\\work',
        order: 0,
        sessionIds: ['session-cccc3333'],
        live: [],
      },
    ],
    totals: { sessions: 3, days: 2, workspaces: 1, workspaceSessions: 1 },
  }
}

/** 假图标集：只关心「有没有用上 DSH 自己的图标」，图形本身无所谓。 */
const FAKE_PRIMITIVES = {
  IconFolderCloseRegular: 'IconFolderCloseRegular',
  IconFolderOpenRegular: 'IconFolderOpenRegular',
  IconTriangleRightFillRegular: 'IconTriangleRightFillRegular',
  IconSearchOutlineRegular: 'IconSearchOutlineRegular',
  IconEllipsisOutlineRegular: 'IconEllipsisOutlineRegular',
}

/** 客户端半侧允许 require 的平台模块（DSH 共享模块表里的那几个）。 */
const PLATFORM_MODULES = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

/** 安装 window / document / fetch 桩并载入 client.js。 */
async function bootstrap(options = {}) {
  const primitives = options.primitives !== false
  const moduleUrl = options.moduleUrl ?? '../client.js'
  const slots = []
  const dictionaries = []
  const styles = []
  const hostCalls = []
  const react = makeReact()

  // 全局桩单独装一份：同一进程里（--test-isolation=none）别的测试文件也会 bootstrap
  // 一遍、把 globalThis.document 换成它自己的——那样本实例 apply 时画出去的样式就落进
  // 别人的 styles 数组了。用例在 apply / 读样式前先调 useDom() 装回自己这份。
  const installDom = () => {
    globalThis.window = { __ModuleLoader__: { load(definition) { loaded = definition } } }
    globalThis.document = {
      createElement() {
        return { textContent: '', setAttribute() {}, remove() {} }
      },
      head: { appendChild(node) { styles.push(node) } },
      // 弹出菜单走 createPortal 挂到 body：假 React 里原样返回，树形不变。
      body: {},
    }
    globalThis.fetch = async (url) => {
      const method = String(url).replace(/^.*task-folders\/api\//, '')
      hostCalls.push(method)
      if (method === 'newTaskSession') {
        return { ok: true, status: 200, json: async () => ({ ok: true, value: { cwd: 'C:\\Users\\17915\\.dsh\\tasks', exists: true } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
    }
  }
  installDom()

  await import(moduleUrl)
  assert.equal(loaded.id, 'dsh-task-folders')

  const created = []
  const started = []
  const connected = []
  const opened = []
  const archiveCalls = []
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get(name) {
      if (name === 'sessions') {
        return {
          list: {
            getSnapshot: () => ({ ids: Object.keys(SESSION_SUMMARIES), byId: SESSION_SUMMARIES, phase: 'ready' }),
            subscribe: () => () => {},
          },
          create: async (opts) => {
            created.push(opts)
            return 'session-newly-created'
          },
        }
      }
      if (name === 'uiSession') {
        return {
          sessionStatus: {
            getSnapshot: () => SESSION_STATUSES,
            subscribe: () => () => {},
          },
        }
      }
      if (name === 'uiWorkspace') {
        return {
          openSession: (id) => opened.push(id),
          startSession: (workspaceId) => started.push(workspaceId),
          connectWorkspace: async (workspaceId) => {
            connected.push(workspaceId)
            return 'session-workspace-blank'
          },
          pickDirectory: async () => '',
          // v0.5：会话归档走的就是这两条（与内置侧栏同一条路）。
          archiveSession: async (id, options) => {
            archiveCalls.push(['archive', id, options])
          },
          unarchiveSession: async (id) => {
            archiveCalls.push(['unarchive', id, undefined])
          },
        }
      }
      if (name === 'workspaces') {
        return {
          list: {
            getSnapshot: () => ({
              items: [
                {
                  workspaceId: 'w-plain',
                  path: 'F:\\ssdwork\\vscode\\work',
                  title: '我的项目',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                  sessionIds: ['session-cccc3333'],
                },
              ],
              archivedSessionIds: [],
              pinnedSessionIds: [],
              state: 'idle',
              phase: 'ready',
              error: null,
            }),
            subscribe: () => () => {},
          },
          create: async () => ({}),
        }
      }
      return undefined
    },
    slots: {
      inject(name, callback) {
        callback()
        return () => {}
      },
      register(definition, Component) {
        slots.push({ definition, Component })
        return { definition, Component }
      },
    },
    locale: {
      register(namespace, id, dict) {
        dictionaries.push({ namespace, id, dict })
        return () => {}
      },
      bind() {
        const zhDict = dictionaries.find((entry) => entry.id === 'zh')?.dict ?? {}
        return (key) => zhDict[key] ?? key
      },
    },
  }

  const module = loaded.factory((name) => {
    assert.ok(PLATFORM_MODULES.includes(name), `客户端半侧只允许 require 平台模块：${name}`)
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node) => node }
    // `primitives: false` 模拟老版本 DSH：共享模块表里没有这个包（require 直接抛）。
    if (!primitives) throw new Error(`module not found: ${name}`)
    return FAKE_PRIMITIVES
  })
  return { module, slots, dictionaries, styles, ctx, react, created, started, connected, opened, hostCalls, archiveCalls, useDom: installDom }
}

const client = await bootstrap()

/**
 * 用一份状态渲染某个客户端半侧实例的侧栏区域，返回假元素树。
 * @param {object} bundle - `bootstrap()` 的返回值。
 * @param {object} state - Host 状态。
 * @param {{wide?: boolean, expandSidebar?: Function}} [props] - 区域 props。
 * @param {Record<number, unknown>} [extra] - 覆盖其它 useState 初值（按 hook 序号）。
 * @returns {object} React 元素树。
 */
function renderFrom(bundle, state, props = { wide: true }, extra = {}) {
  const Component = bundle.slots.find((slot) => slot.definition.name === 'sidebar.workspaces').Component
  const React = bundle.react
  const originalUseState = React.useState
  const fixture = { 0: state, ...extra }
  let hookIndex = 0
  React.useState = (initial) => {
    const slot = hookIndex
    hookIndex += 1
    const value = slot in fixture ? fixture[slot] : typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  }
  try {
    let tree = Component(props)
    let guard = 0
    while (tree !== null && typeof tree === 'object' && typeof tree.type === 'function' && guard < 8) {
      tree = tree.type(tree.props)
      guard += 1
    }
    return tree
  } finally {
    React.useState = originalUseState
  }
}

/**
 * 用默认实例渲染（绝大多数用例）。
 * @param {object} state - Host 状态。
 * @param {{wide?: boolean, expandSidebar?: Function}} [props] - 区域 props。
 * @param {Record<number, unknown>} [extra] - 覆盖其它 useState 初值（按 hook 序号）。
 * @returns {object} React 元素树。
 */
function render(state, props, extra) {
  return renderFrom(client, state, props, extra)
}

test('注册三个槽：sidebar.workspaces（priority -1 遮盖）、settings.section「技能」页、对话流「编辑重发」', () => {
  // 别的测试文件可能已经把 globalThis.document 换成它自己的桩了：装回本实例这份再 apply，
  // 否则样式表会落进别人的 styles 数组（下面的样式用例就什么都读不到）。
  client.useDom()
  client.module.apply(client.ctx)

  assert.equal(client.slots.length, 3, '侧栏浏览区 + 设置里的技能页 + 对话流回合尾部的「编辑重发」')
  const sidebar = client.slots.find((slot) => slot.definition.name === 'sidebar.workspaces')
  assert.equal(sidebar.definition.priority, -1, 'single 槽必须用更低 priority 遮盖')
  const settings = client.slots.find((slot) => slot.definition.name === 'settings.section')
  assert.equal(settings.definition.id, 'skills')
  assert.equal(settings.definition.order, 18, '插在内置插件 (15) 与 Agent 预设 (20) 之间')
  assert.equal(settings.definition.label(), '技能')
  assert.equal(typeof settings.Component, 'function')
  const resend = client.slots.find((slot) => slot.definition.name === 'conversation.chat.turnTail')
  assert.equal(resend.definition.id, 'edit-resend')
  assert.equal(resend.definition.locale, 'taskFolders', '文案走插件自己的词典')
  assert.equal(typeof resend.definition.label, 'function')
  assert.equal(resend.definition.label(), '编辑重发')
  assert.equal(typeof resend.Component, 'function')
})

test('注入 zh / en 词典与令牌化样式表（含状态点与按天分隔）', () => {
  assert.deepEqual(client.dictionaries.map((entry) => entry.id).sort(), ['en', 'zh'])
  for (const entry of client.dictionaries) {
    assert.equal(entry.namespace, 'taskFolders')
    assert.equal(typeof entry.dict.project, 'string')
    assert.equal(typeof entry.dict.today, 'string')
    assert.equal(typeof entry.dict.newSessionIn, 'string')
    assert.equal(typeof entry.dict.skillsNav, 'string')
    assert.equal(typeof entry.dict.skillsIntro, 'string')
    assert.equal(typeof entry.dict.skillsUpload, 'string')
  }
  const css = client.styles[0].textContent
  assert.match(css, /\.tsb-root/)
  assert.match(css, /\.tsk-section/, '设置里的技能页有独立样式')
  assert.match(css, /\.tsk-tab\[data-active='true'\]::after/, '分类页签用内置设置页同款下划线')
  assert.match(css, /\.tsk-overlay \{[^}]*position: fixed/, '上传 / 详情用浮层，不挤设置页布局')
  assert.match(css, /\.tsk-btn\.is-primary \{[^}]*--dsw-alias-label-primary-foreground/, '主按钮前景走反色令牌，深色主题下白字不会被近白底吞掉')
  assert.match(css, /\.tsk-drop\.is-over/, '拖放悬停有反馈')
  assert.match(css, /var\(--dsw-alias-label-primary\)/, '颜色必须走 DSH 令牌')
  assert.match(css, /\.tsb-day/, '按天分隔的小标题')
  assert.match(css, /\.tsb-folder\b/, '工作区行的文件夹图标')
  assert.match(css, /\.tsb-caption-icon\b/, '「项目」标题的文件夹图标')
  // 缩进台阶：组标题往左顶，子项右移一格，层级才看得出来
  assert.match(css, /\.tsb-group \{[^}]*padding: 0 8px 0 2px/, '任务 / 工作区组标题左对齐到最外层')
  assert.match(css, /\.tsb-caption \{[^}]*padding: 2px 8px 4px 2px/, '「项目」标题与组标题同一条竖线')
  assert.match(css, /\.tsb-row \{[^}]*var\(--tsb-indent, 10px\)/, '工作区行比组标题右移一格')
  assert.match(css, /\.tsb-day \{[^}]*var\(--tsb-indent, 10px\)/, '按天小标题与工作区行同一条竖线')
  assert.match(css, /\.tsb-dot\[data-state="running"\][^}]*--dsw-alias-state-success-primary/, '运行中用 success 令牌')
  assert.match(css, /\.tsb-dot\[data-state="pending"\][^}]*--dsw-alias-state-warn-primary/, '待确认用 warn 令牌')
  assert.match(css, /var\(--dsw-radius-md\)/, '圆角要用 DSH 的 radius 令牌')
  assert.match(css, /var\(--dsw-alias-interactive-bg-hover\)/, 'hover 要用 DSH 的交互令牌')
  assert.doesNotMatch(css, /rgba\(127,\s*127,\s*127/, '不要自造半透明灰')
})

test('「项目」标题与工作区行都带文件夹图标（DSH 图标集）', () => {
  const tree = render(fixtureState())

  const caption = collectByType(tree, 'div').find((node) => node.props.className === 'tsb-caption')
  assert.ok(caption, '侧栏顶上那行「项目」')
  assert.equal(caption.children[0].type, 'IconFolderCloseRegular', '「项目」前面是 DSH 的文件夹图标')
  assert.equal(caption.children[0].props.size, 14)
  assert.equal(caption.children[0].props.className, 'tsb-caption-icon')
  assert.match(collectText(caption).join(''), /^项目/, '图标不占文本（后面可以跟活动数量）')

  const folders = collectByType(tree, 'span').filter((node) => node.props.className === 'tsb-folder')
  assert.equal(folders.length, 1, '每个工作区行一个文件夹图标')
  assert.equal(folders[0].children[0].type, 'IconFolderCloseRegular', '收着的工作区是闭合文件夹')

  // 展开后换成打开的文件夹（和 DSH 自己一样）：expanded 是第 7 个 useState（序号 6）
  const expandedTree = render(fixtureState(), { wide: true }, { 6: new Set(['ws:w-plain']) })
  const expandedFolders = collectByType(expandedTree, 'span').filter((node) => node.props.className === 'tsb-folder')
  assert.equal(expandedFolders[0].children[0].type, 'IconFolderOpenRegular', '展开的工作区是打开文件夹')
})

test('折叠指示用 DSH 图标集的细 chevron（不再是 9px 的文字 ▸），与文件夹共用一格', () => {
  const tree = render(fixtureState())
  const chevrons = collectByType(tree, 'span').filter((node) => typeof node.props.className === 'string' && node.props.className.startsWith('tsb-chev'))
  assert.equal(chevrons.length, 3, '任务组 / 工作区组 / 每个工作区行各一个')
  for (const chevron of chevrons) {
    assert.equal(chevron.children[0].type, 'IconTriangleRightFillRegular', '折叠指示来自 DSH 图标集')
  }
  assert.equal(collectText(tree).includes('▸'), false, '不再用文字三角')

  // 展开态只靠 .is-open 旋转，图形本身不换
  const expandedTree = render(fixtureState(), { wide: true }, { 6: new Set(['ws:w-plain']) })
  const expandedRowChevron = collectByType(expandedTree, 'span').find((node) => node.props.className === 'tsb-chev is-open' && node.children[0]?.type === 'IconTriangleRightFillRegular')
  assert.ok(expandedRowChevron, '展开的工作区行把三角转 90°（CSS 里 .is-open）')

  // 文件夹与三角同一格换来换去，靠样式表里的 hover 规则，而不是两个一起画
  const css = client.styles[0].textContent
  assert.match(css, /\.tsb-row \.tsb-chev \{ display: none;/, '行里的三角平时不占位')
  assert.match(css, /\.tsb-row:hover \.tsb-chev,[^{]*\{ display: inline-flex; \}/, '鼠标进来才換成三角')
  assert.match(css, /\.tsb-row:hover \.tsb-folder,[^{]*\{ display: none; \}/, '这时候把文件夹收起来')
  assert.doesNotMatch(css, /font-size: 9px/, '文字三角的字号规则一并去掉')
})

test('拿不到 DSH 图标集时退回自带的 SVG，侧栏照常渲染', async () => {
  // 老版本 DSH 的共享模块表里没有 primitives 包：require 抛错也不能把客户端半侧吃掉。
  const fallback = await bootstrap({ primitives: false, moduleUrl: '../client.js?without-primitives' })
  fallback.module.apply(fallback.ctx)

  const tree = renderFrom(fallback, fixtureState())
  const spans = collectByType(tree, 'span')
  const folderGlyphs = spans
    .filter((node) => node.props.className === 'tsb-folder')
    .map((node) => node.children[0])
  const chevronGlyphs = spans
    .filter((node) => typeof node.props.className === 'string' && node.props.className.startsWith('tsb-chev'))
    .map((node) => node.children[0])
  const caption = collectByType(tree, 'div').find((node) => node.props.className === 'tsb-caption')

  assert.equal(folderGlyphs.length, 1, '工作区行的文件夹')
  assert.equal(chevronGlyphs.length, 3, '两个组标题 + 工作区行的折叠指示')
  for (const icon of [caption.children[0], ...folderGlyphs, ...chevronGlyphs]) {
    assert.equal(icon.type, 'svg', '拿不到图标集就退回自带 SVG')
    assert.equal(icon.props.viewBox, '0 0 16 16')
    assert.equal(icon.props['aria-hidden'], 'true', '图标不进无障碍树')
    assert.equal(icon.props.fill, 'none', '都是描边图形')
    assert.equal(icon.props.stroke, 'currentColor', '颜色跟文字走（令牌在 CSS 里）')
  }
  assert.equal(caption.children[0].props.width, 14, '标题里的文件夹小一号')
  assert.equal(folderGlyphs[0].props.width, 16, '工作区行的文件夹')
  assert.equal(chevronGlyphs[0].props.width, 14, '折叠指示与 DSH 图标集同为 14px')
  assert.equal(chevronGlyphs[0].props.strokeWidth, 1, '细 chevron，不是实心三角')
  assert.match(collectText(tree).join(' | '), /我的项目/, '换兜底图标不影响其余渲染')
})

test('「任务」按天分隔列会话（今天/昨天 + 标题 + 状态点 + 时间）', () => {
  const tree = render(fixtureState())
  const text = collectText(tree).join(' | ')

  assert.match(text, /项目/)
  assert.match(text, /任务/)
  assert.match(text, /工作区/)
  assert.match(text, /今天/, '今天的会话归在「今天」底下')
  assert.match(text, /昨天/, '昨天的会话归在「昨天」底下')
  assert.match(text, /聊聊登录重构/, '会话标题来自快照 displayTitle')
  assert.match(text, /昨天那条/, '持久标题优先于 displayTitle')
  assert.match(text, /分钟|刚刚/, '要显示相对时间')

  // 行首状态点：running / done(unread) / pending 三种都来自 uiSession
  const dots = collectByType(tree, 'span').filter((node) => node.props.className === 'tsb-dot')
  const states = dots.map((dot) => dot.props['data-state'])
  assert.ok(states.includes('running'), '运行中的会话有状态点')
  assert.ok(states.includes('done'), '有新结果的会话有状态点')
  assert.ok(states.includes('pending'), '待确认的会话有状态点')

  const sessionButton = collectByType(tree, 'button').find((button) =>
    collectText(button).join('|').includes('聊聊登录重构'),
  )
  assert.ok(sessionButton, '会话行应可点（点开会话）')
  assert.equal(typeof sessionButton.props.onClick, 'function')
})

test('上级行标出「下面有任务在跑」：任务组 / 按天 / 工作区组 / 工作区行 / 顶部「项目」', () => {
  const tree = render(fixtureState())
  const marks = collectByType(tree, 'span').filter((node) => node.props.className === 'tsb-runmark')

  // 顺序：顶部「项目」→ 任务组 → 今天 → 昨天 → 工作区组 → 工作区行
  assert.equal(marks.length, 6, '每一层上级各一个标记')
  assert.deepEqual(
    marks.map((mark) => mark.props['data-state']),
    ['running', 'running', 'running', 'pending', 'pending', 'pending'],
    '有在跑的就是 running（success），只有等回话的是 pending（warn）',
  )

  const captionMark = marks[0]
  assert.equal(collectText(captionMark).join(''), '2', '顶部「项目」也带整体数量')
  assert.match(captionMark.props.title, /下面有 1 个任务在跑/, '汇总里有一条在跑')
  assert.match(captionMark.props.title, /下面有 1 个任务等你回话/, '也有一条在等回话')
  assert.match(captionMark.props.title, /聊聊登录重构|别的项目会话/, '悬停直接列出是哪几条')
  // session-cccc3333 同时出现在任务区与工作区（fixture 故意重叠）：按 id 去重，
  // 不然顶部会把同一条会话数两遍。
  assert.equal(
    (captionMark.props.title.match(/等你回话/g) ?? []).length,
    1,
    '同一会话在两层里只算一次',
  )

  const taskMark = marks[1]
  assert.equal(collectText(taskMark).join(''), '2', '任务组有两条在忙，带数量')
  assert.match(taskMark.props.title, /聊聊登录重构/)
  assert.match(taskMark.props['aria-label'], /任务在跑/)

  const todayMark = marks[2]
  assert.equal(collectText(todayMark).join(''), '1', '只有一条也要报数，不再只剩一个空点')
  assert.match(todayMark.props.title, /聊聊登录重构/, '今天的标记只说今天这条')

  const yesterdayMark = marks[3]
  assert.match(yesterdayMark.props.title, /别的项目会话/, '昨天那条在等回话')
  assert.doesNotMatch(yesterdayMark.props['aria-label'], /任务在跑/)
  assert.match(yesterdayMark.props['aria-label'], /等你回话/)

  const workspacesMark = marks[4]
  assert.equal(workspacesMark.props['data-state'], 'pending')
  assert.match(workspacesMark.props.title, /别的项目会话/, '工作区组汇总到具体工作区里的会话')

  const workspaceMark = marks[5]
  assert.match(workspaceMark.props.title, /别的项目会话/, '工作区行自己也要亮')
})

test('没有在跑 / 等回话的子孙时，上级行不挂标记', () => {
  const idle = {
    generatedAt: Date.now(),
    tasksRoot: 'C:\\Users\\17915\\.dsh\\tasks',
    taskWorkspaceId: 'w-tasks',
    cwd: 'C:\\Users\\17915\\.dsh\\tasks',
    canCreate: true,
    layout: { dayFormat: 'YYYY-MM-DD', sessionLog: 'session.v4.jsonl.zstd' },
    dayGroups: [
      { day: TODAY, sessions: [{ id: 'session-bbbb2222', day: TODAY, createdAt: 1, live: false, archived: true }] },
      { day: YESTERDAY, sessions: [{ id: 'session-eeee5555', day: YESTERDAY, createdAt: 2, live: false, archived: true }] },
    ],
    sessions: [],
    workspaces: [],
    totals: { sessions: 2, days: 2, workspaces: 0, workspaceSessions: 0 },
  }
  const tree = render(idle)
  assert.equal(
    collectByType(tree, 'span').filter((node) => node.props.className === 'tsb-runmark').length,
    0,
    '空闲 / 有新结果都不算「在跑」',
  )
})

test('会话从空闲变成跑着：重画后上级标记跟着出现（状态源订阅驱动 tick）', () => {
  const idleState = {
    generatedAt: Date.now(),
    tasksRoot: 'C:\\Users\\17915\\.dsh\\tasks',
    taskWorkspaceId: 'w-tasks',
    cwd: 'C:\\Users\\17915\\.dsh\\tasks',
    canCreate: true,
    layout: { dayFormat: 'YYYY-MM-DD', sessionLog: 'session.v4.jsonl.zstd' },
    dayGroups: [
      { day: TODAY, sessions: [{ id: 'session-bbbb2222', day: TODAY, createdAt: 1, live: false, archived: true }] },
    ],
    sessions: [],
    workspaces: [],
    totals: { sessions: 1, days: 1, workspaces: 0, workspaceSessions: 0 },
  }
  const countMarks = (tree) =>
    collectByType(tree, 'span').filter((node) => node.props.className === 'tsb-runmark').length

  assert.equal(countMarks(render(idleState)), 0, '空闲时上级不挂标记')

  const saved = SESSION_STATUSES.get('session-bbbb2222')
  SESSION_STATUSES.set('session-bbbb2222', { running: true, pendingInteraction: undefined, completionUnread: false })
  try {
    const running = render(idleState)
    assert.equal(countMarks(running), 3, '同一份数据重画：「项目」+ 任务组 + 今天各亮一个')
    const labels = collectByType(running, 'span')
      .filter((node) => node.props.className === 'tsb-runmark')
      .map((node) => node.props['aria-label'])
    for (const label of labels) assert.match(label, /任务在跑/)
  } finally {
    if (saved === undefined) SESSION_STATUSES.delete('session-bbbb2222')
    else SESSION_STATUSES.set('session-bbbb2222', saved)
  }
})

test('组折起来时上级标记照样亮着；窄栏（wide=false）也留一颗', () => {
  // tasksOpen / workspacesOpen 是第 5 / 第 6 个 useState（序号 4 / 5）：都折起来
  const collapsed = render(fixtureState(), { wide: true }, { 4: false, 5: false })
  const marks = collectByType(collapsed, 'span').filter((node) => node.props.className === 'tsb-runmark')
  assert.equal(marks.length, 3, '「项目」+ 任务组 + 工作区组各一个（工作区行被收起，不算）')
  assert.equal(
    collectByType(collapsed, 'div').filter((node) => node.props.className === 'tsb-day').length,
    0,
    '会话按天列表确实折起来了',
  )

  const rail = render(fixtureState(), { wide: false, expandSidebar: () => {} })
  assert.match(collectText(rail).join(' | '), /☰/)
  const railMarks = collectByType(rail, 'span').filter((node) =>
    String(node.props.className).startsWith('tsb-runmark'),
  )
  assert.equal(railMarks.length, 1, '窄条上只剩这一颗')
  assert.equal(railMarks[0].props['data-state'], 'running')
  assert.equal(railMarks[0].props.className, 'tsb-runmark is-dot', '窄条退回单点，不占胶囊宽度')
  assert.equal(collectText(railMarks[0]).join(''), '', '窄条不摆数字')
  assert.match(railMarks[0].props.title, /聊聊登录重构/)
})

test('「下面有任务在跑」标记的样式：胶囊 / 实心点 / 常显数字 / 状态令牌', () => {
  const css = client.styles[0].textContent
  assert.match(css, /\.tsb-runmark \{/, '标记有独立样式')
  assert.match(css, /\.tsb-runmark \{[^}]*height: 18px/, '胶囊比原来的 8px 圆环更有体量')
  assert.match(css, /\.tsb-runmark \{[^}]*--dsw-alias-state-success-tertiary/, '在跑 = success tertiary 底色')
  assert.match(css, /\.tsb-runmark \{[^}]*--dsw-alias-label-primary/, '数字走 label-primary，浅色/深色都读得清')
  assert.match(css, /\.tsb-runmark::before \{[^}]*background: var\(--dsw-alias-state-success-primary\)/, '实心点用 success 主色')
  assert.match(css, /\.tsb-runmark\[data-state="pending"\] \{[^}]*--dsw-alias-state-warn-tertiary/, '等回话 = warn tertiary 底色')
  assert.match(css, /\.tsb-runmark\[data-state="pending"\]::before \{[^}]*--dsw-alias-state-warn-primary/, '等回话 = warn 主色实心点')
  assert.match(css, /\.tsb-runmark::before \{[^}]*animation: tsb-pulse/, '复用状态点的脉冲')
  assert.match(css, /\.tsb-runmark\.is-dot \{/, '窄条退回单点')
  assert.match(css, /\.tsb-day \.tsb-runmark \{[^}]*height: 16px/, '按天小标题的胶囊小一号')
  assert.match(css, /\.tsb-day \{[^}]*display: flex/, '按天小标题要能横排「今天 + 标记」')
})

test('「任务」的 ＋ 在任务默认工作区里起会话（connectWorkspace），不碰私有 sessions.create', async () => {
  const tree = render(fixtureState())
  const plusButtons = collectByType(tree, 'button').filter((button) => collectText(button).join('') === '＋')
  assert.equal(plusButtons.length, 3, '任务组一个、工作区组一个、每个工作区行一个')
  assert.equal(plusButtons[0].props.title, '新建会话', '任务组 ＋ = 直接建会话')
  assert.equal(plusButtons[0].props.disabled, false, 'Host 给了任务工作区，就能建')

  await plusButtons[0].props.onClick()
  // run() 是异步的：等它内部的 await 走完
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(client.connected, ['w-tasks'], 'connectWorkspace(任务默认工作区)')
  assert.deepEqual(client.opened, ['session-workspace-blank'], '连上就打开那条会话')
  assert.deepEqual(client.created, [], '不再走 sessions.create —— 那条路建出来的会话没主、发不出话')
})

test('工作区行尾的 ＋ = 在这个工作区里新建会话', () => {
  const tree = render(fixtureState())
  const plusButtons = collectByType(tree, 'button').filter((button) => collectText(button).join('') === '＋')
  const workspacePlus = plusButtons.find((button) => button.props.title === '在这个工作区里新建会话')
  assert.ok(workspacePlus, '每个工作区行都要有新建会话入口')
  workspacePlus.props.onClick()
  assert.deepEqual(client.started, ['w-plain'], 'startSession(workspaceId)')
})

test('工作区组的 ＋ 还是添加工作区（目录选择框）', () => {
  const tree = render(fixtureState())
  const plusButtons = collectByType(tree, 'button').filter((button) => collectText(button).join('') === '＋')
  const addWorkspace = plusButtons.find((button) => button.props.title === '添加工作区')
  assert.ok(addWorkspace)
  assert.equal(typeof addWorkspace.props.onClick, 'function')
})

test('旧版 Host（没有 taskWorkspaceId）：说清楚要重启，不偷偷建无主会话', async () => {
  // 旧版 state：有 tasksRoot / workspaces，没有 dayGroups，也没有 taskWorkspaceId
  const legacyState = {
    generatedAt: Date.now(),
    tasksRoot: 'C:\\Users\\17915\\.dsh\\tasks',
    canCreate: true,
    layout: { dayFormat: 'YYYY-MM-DD', sessionLog: 'session.v4.jsonl.zstd' },
    tasks: [],
    sessions: [],
    // 旧版 Host 会把残留的「任务 = 工作区」也列进来：客户端要自己滤掉
    workspaces: [
      { id: 'w-legacy', title: '任务', path: 'C:\\Users\\17915\\.dsh\\tasks\\default', order: 0, sessionIds: ['session-aaaa1111'], live: [] },
      { id: 'w-plain', title: '我的项目', path: 'F:\\ssdwork\\vscode\\work', order: 1, sessionIds: ['session-cccc3333'], live: [] },
    ],
    totals: { tasks: 0, sessions: 0, days: 0, workspaceSessions: 2 },
  }
  const tree = render(legacyState)
  const text = collectText(tree).join(' | ')

  // 无工作区的会话（session-aaaa1111 / session-bbbb2222）从快照现算，按最后活跃那天分隔
  assert.match(text, /今天|昨天/, '客户端兜底也要按天分隔')
  assert.match(text, /聊聊登录重构/)
  assert.match(text, /昨天那条/)
  assert.match(text, /我的项目/, '普通工作区照旧')
  assert.doesNotMatch(text, /任务\s*\d/, '任务根目录下的残留工作区不出现在工作区组')
  assert.match(text, /重启 DSH/, '旧版 Host 要明说，而不是让人对着点不动的 ＋')

  const connectedBefore = client.connected.length
  const openedBefore = client.opened.length
  const createdBefore = client.created.length
  const plusButtons = collectByType(tree, 'button').filter((button) => collectText(button).join('') === '＋')
  assert.equal(plusButtons[0].props.disabled, true, '没有任务工作区就禁用新建')
  await plusButtons[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(client.connected.slice(connectedBefore), [], '不调 connectWorkspace')
  assert.deepEqual(client.opened.slice(openedBefore), [], '不打开任何会话')
  assert.deepEqual(client.created.slice(createdBefore), [], '不再退回 sessions.create')
})

test('空态：没有会话/没有工作区各给一句提示', () => {
  const empty = render({
    generatedAt: 0,
    tasksRoot: 'C:\\Users\\17915\\.dsh\\tasks',
    taskWorkspaceId: 'w-tasks',
    cwd: 'C:\\Users\\17915\\.dsh\\tasks',
    canCreate: true,
    layout: { dayFormat: 'YYYY-MM-DD', sessionLog: 'session.v4.jsonl.zstd' },
    dayGroups: [],
    sessions: [],
    workspaces: [],
    totals: { sessions: 0, days: 0, workspaces: 0, workspaceSessions: 0 },
  })
  const text = collectText(empty).join(' | ')
  assert.match(text, /还没有会话/)
  assert.match(text, /还没有工作区/)
  assert.equal(
    collectByType(empty, 'button').filter((button) => button.props.className === 'tsb-row-main').length,
    0,
  )
  assert.equal(collectByType(empty, 'span').filter((node) => node.props.className === 'tsb-day').length, 0)
})

test('窄栏（wide=false）只给展开入口；不能建工作区时禁用「添加工作区」', () => {
  const rail = render(fixtureState(), { wide: false, expandSidebar: () => {} })
  assert.match(collectText(rail).join(' | '), /☰/)

  const disabled = render({
    generatedAt: 0,
    tasksRoot: 'C:\\Users\\17915\\.dsh\\tasks',
    taskWorkspaceId: 'w-tasks',
    cwd: 'C:\\Users\\17915\\.dsh\\tasks',
    canCreate: false,
    layout: { dayFormat: 'YYYY-MM-DD', sessionLog: 'session.v4.jsonl.zstd' },
    dayGroups: [],
    sessions: [],
    workspaces: [],
    totals: { sessions: 0, days: 0, workspaces: 0, workspaceSessions: 0 },
  })
  assert.match(collectText(disabled).join(' | '), /不能建工作区/)
  const plusButtons = collectByType(disabled, 'button').filter((button) => collectText(button).join('') === '＋')
  for (const button of plusButtons) {
    if (button.props.title === '添加工作区') assert.equal(button.props.disabled, true, '建不了工作区就禁用添加')
    else assert.equal(button.props.disabled, false, '建会话不依赖工作区注册表')
  }
})

test('快照缺席时回落到「新会话」，不抛', () => {
  const Component = client.slots.find((slot) => slot.definition.name === 'sidebar.workspaces').Component
  const React = client.react
  const originalGet = client.ctx.get
  const originalUseState = React.useState
  let hookIndex = 0
  const fixture = { 0: fixtureState() }
  React.useState = (initial) => {
    const slot = hookIndex
    hookIndex += 1
    const value = slot in fixture ? fixture[slot] : typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  }
  client.ctx.get = (name) => {
    if (name === 'sessions') {
      return {
        list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }), subscribe: () => () => {} },
        create: async () => 'session-x',
      }
    }
    return originalGet(name)
  }
  try {
    let tree = Component({ wide: true })
    let guard = 0
    while (tree !== null && typeof tree === 'object' && typeof tree.type === 'function' && guard < 8) {
      tree = tree.type(tree.props)
      guard += 1
    }
    assert.match(collectText(tree).join(' | '), /新会话/)
  } finally {
    client.ctx.get = originalGet
    React.useState = originalUseState
  }
})

// ---- v0.5：搜索 / 会话归档 / 项目归档 ----

/**
 * 带归档会话与归档项目的一份状态。
 * @returns {object} Host 状态。
 */
function fixtureWithArchives() {
  const state = fixtureState()
  state.archivedDayGroups = [
    {
      day: TODAY,
      sessions: [{ id: 'session-dddd4444', day: TODAY, createdAt: 0, live: false, archived: true }],
    },
  ]
  state.archivedSessionIds = ['session-dddd4444']
  state.workspaces = [
    { ...state.workspaces[0], sessionIds: ['session-cccc3333', 'session-dddd4444'] },
    {
      id: 'w-old',
      title: '归档的老项目',
      path: 'F:\\ssdwork\\vscode\\work\\old',
      order: 1,
      sessionIds: [],
      live: [],
      archived: true,
    },
  ]
  return state
}

test('「项目」标题右侧有搜索入口（Ctrl/⌘+K 同一个入口），展开就是搜索框', () => {
  const tree = render(fixtureState())
  const searchButton = collectByType(tree, 'button').find((button) => button.props.title === '搜索会话')
  assert.ok(searchButton, '标题右边要有放大镜')
  assert.equal(typeof searchButton.props.onClick, 'function')
  assert.equal(searchButton.children[0].type, 'IconSearchOutlineRegular', '图标走 DSH 图标集')

  const opened = render(fixtureState(), { wide: true }, { 8: true })
  const input = collectByType(opened, 'input')[0]
  assert.ok(input, '展开后是输入框')
  assert.equal(input.props.placeholder, '搜索会话名称')
  assert.equal(input.props.value, '')
})

test('搜索：按标题本地命中，结果里带所属工作区', () => {
  const tree = render(fixtureState(), { wide: true }, { 7: '昨天' })
  const text = collectText(tree).join(' | ')
  assert.match(text, /昨天那条/, '命中的会话进结果')
  assert.doesNotMatch(text, /聊聊登录重构/, '没命中的不出现')

  const rows = collectByType(tree, 'div').filter((node) => node.props.className === 'tsb-result')
  assert.equal(rows.length, 1)
  const meta = collectByType(rows[0], 'div').find((node) => node.props.className === 'tsb-result-meta')
  assert.match(collectText(meta).join(' | '), /任务/, '结果标出所属工作区')
})

test('全文搜索命中（Host sessions.search）并进结果，带摘要片段', () => {
  const tree = render(
    fixtureState(),
    { wide: true },
    { 7: 'zig', 12: { pending: false, items: [{ sessionId: 'session-eeee5555', snippet: '片段甲' }], hasMore: false } },
  )
  const text = collectText(tree).join(' | ')
  assert.match(text, /远程搜到的/, '本地没命中也从 Host 结果补上')
  assert.match(text, /片段甲/, '摘要片段要显示')
})

test('归档过滤三档：默认藏起来、可一起看、可只看归档', () => {
  const state = fixtureWithArchives()
  assert.doesNotMatch(collectText(render(state)).join(' | '), /归档的老会话/, '默认隐藏已归档')

  const shown = collectText(render(state, { wide: true }, { 9: 'show' })).join(' | ')
  assert.match(shown, /归档的老会话/)
  assert.match(shown, /聊聊登录重构/, '「全部对话」两边都在')
  assert.match(shown, /已归档/, '归档的会话带徽标')

  const only = collectText(render(state, { wide: true }, { 9: 'only' })).join(' | ')
  assert.match(only, /归档的老会话/)
  assert.doesNotMatch(only, /聊聊登录重构/, '「仅已归档」只剩归档的')
})

test('视图选项菜单里有归档过滤三档（与内置侧栏同名）', () => {
  const text = collectText(render(fixtureState(), { wide: true }, { 10: { kind: 'view' } })).join(' | ')
  assert.match(text, /隐藏已归档/)
  assert.match(text, /全部对话/)
  assert.match(text, /仅已归档/)
})

test('会话行「…」菜单：归档会话走 DSH 原生 archiveSession', async () => {
  const tree = render(
    fixtureState(),
    { wide: true },
    { 10: { kind: 'session', id: 'session-aaaa1111', sidebarArchived: false } },
  )
  const menu = collectByType(tree, 'div').find((node) => node.props.className === 'tsb-menu')
  assert.ok(menu, '菜单画在会话行里')
  const labels = collectText(menu).join(' | ')
  assert.match(labels, /归档会话/)
  assert.match(labels, /复制 Session ID/)

  const item = collectByType(menu, 'button').find((button) => collectText(button).join('').includes('归档会话'))
  item.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(client.archiveCalls.at(-1), ['archive', 'session-aaaa1111', undefined])
})

test('已归档的会话：菜单项换成「取消归档」，点了走 unarchiveSession', async () => {
  const tree = render(
    fixtureWithArchives(),
    { wide: true },
    { 9: 'show', 10: { kind: 'session', id: 'session-dddd4444', sidebarArchived: true } },
  )
  const menu = collectByType(tree, 'div').find((node) => node.props.className === 'tsb-menu')
  assert.match(collectText(menu).join(' | '), /取消归档/)

  const item = collectByType(menu, 'button').find((button) => collectText(button).join('').includes('取消归档'))
  item.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(client.archiveCalls.at(-1), ['unarchive', 'session-dddd4444', undefined])
})

test('工作区行「…」：归档项目只发一条 host 请求，不碰工作区登记', async () => {
  const tree = render(fixtureState(), { wide: true }, { 10: { kind: 'workspace', id: 'w-plain' } })
  const menu = collectByType(tree, 'div').find((node) => node.props.className === 'tsb-menu')
  assert.match(collectText(menu).join(' | '), /归档项目/)

  // 别的用例换过 globalThis.fetch（拿了另一份 bootstrap 的桩），这里自己装一个记到本实例上。
  const originalFetch = globalThis.fetch
  client.hostCalls.length = 0
  globalThis.fetch = async (url) => {
    client.hostCalls.push(String(url).replace(/^.*task-folders\/api\//, ''))
    return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
  }
  try {
    collectByType(menu, 'button')[0].props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.ok(client.hostCalls.includes('archiveProject'), `走插件的 archiveProject 路由：${client.hostCalls.join(',')}`)
})

test('工作区自己的会话也跟着归档过滤走', () => {
  const collapsedKey = new Set(['ws:w-plain'])
  const hidden = collectText(render(fixtureWithArchives(), { wide: true }, { 6: collapsedKey })).join(' | ')
  assert.match(hidden, /别的项目会话/)
  assert.doesNotMatch(hidden, /归档的老会话/, '「隐藏已归档」时工作区里也不列')

  const shown = collectText(
    render(fixtureWithArchives(), { wide: true }, { 6: collapsedKey, 9: 'show' }),
  ).join(' | ')
  assert.match(shown, /归档的老会话/, '「全部对话」时工作区里也列出来')
})

test('已归档项目收在底部一组：平时收起，展开能一键恢复', () => {
  const collapsed = collectText(render(fixtureWithArchives())).join(' | ')
  assert.match(collapsed, /已归档项目/)
  assert.doesNotMatch(collapsed, /归档的老项目/, '收起时不占地方')

  const opened = render(fixtureWithArchives(), { wide: true }, { 11: true })
  assert.match(collectText(opened).join(' | '), /归档的老项目/)
  const restore = collectByType(opened, 'button').find((button) => collectText(button).join('') === '恢复')
  assert.ok(restore, '归档项目行尾有「恢复」')
  assert.equal(typeof restore.props.onClick, 'function')
})

test('新样式也走 DSH 令牌：搜索框、菜单、归档徽标、结果行', () => {
  const css = client.styles[0].textContent
  assert.match(css, /\.tsb-menu \{[^}]*var\(--dsw-alias-bg-overlay\)/, '菜单用 overlay 底色')
  assert.match(css, /\.tsb-search \{[^}]*var\(--dsw-alias-border-l1\)/, '搜索框边框用令牌')
  assert.match(css, /\.tsb-row\.is-archived/, '归档行有独立样式')
  assert.match(css, /\.tsb-result-snippet/, '搜索结果摘要')
  assert.match(css, /\.tsb-more/, '行尾的「…」')
  assert.match(css, /\.tsb-badge/, '归档徽标')
})

// ---- v0.6：删除会话 ----

test('会话行「…」里多一条染红的「删除会话…」，点了先换成就地确认（不直接删）', () => {
  const tree = render(
    fixtureState(),
    { wide: true },
    { 10: { kind: 'session', id: 'session-aaaa1111', sidebarArchived: false } },
  )
  const menu = collectByType(tree, 'div').find((node) => node.props.className === 'tsb-menu')
  const item = collectByType(menu, 'button').find((button) => collectText(button).join('').includes('删除会话'))
  assert.ok(item, '菜单里有删除会话')
  assert.match(item.props.className, /is-danger/, '破坏性操作用 error 令牌染色')

  // 点它只是换一步确认：这一下不该发出任何 Host 请求。
  client.hostCalls.length = 0
  item.props.onClick()
  assert.deepEqual(client.hostCalls, [], '第一次点击不删')
})

test('删除确认块：说清后果，「删除」才发 Host 的 deleteSession', async () => {
  const tree = render(
    fixtureState(),
    { wide: true },
    { 10: { kind: 'session', id: 'session-aaaa1111', sidebarArchived: false, confirm: 'delete' } },
  )
  const dialog = collectByType(tree, 'div').find((node) => node.props.className === 'tsb-menu tsb-confirm')
  assert.ok(dialog, '菜单原地换成确认块')
  const text = collectText(dialog).join(' | ')
  assert.match(text, /删除这条会话？/)
  assert.match(text, /回收站/, '把「能找回来」说清楚')

  const buttons = collectByType(dialog, 'button')
  assert.deepEqual(
    buttons.map((button) => collectText(button).join('')),
    ['取消', '删除'],
    '两颗按钮：取消在前，删除在后',
  )

  const originalFetch = globalThis.fetch
  client.hostCalls.length = 0
  globalThis.fetch = async (url) => {
    client.hostCalls.push(String(url).replace(/^.*task-folders\/api\//, ''))
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { deleted: true } }) }
  }
  try {
    buttons[1].props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.ok(client.hostCalls.includes('deleteSession'), `走 Host 的 deleteSession：${client.hostCalls.join(',')}`)
})

test('删除相关的样式：危险项、确认块、按钮都走 DSH 令牌', () => {
  const css = client.styles[0].textContent
  assert.match(css, /\.tsb-menu-item\.is-danger \{[^}]*--dsw-alias-state-error-primary/, '删除项用 error 令牌')
  assert.match(css, /\.tsb-confirm \{[^}]*width/, '确认块是独立一块')
  assert.match(css, /\.tsb-confirm-btn\.is-danger \{[^}]*--dsw-alias-state-error-primary/, '确认按钮同色')
  assert.match(css, /\.tsb-confirm-hint \{[^}]*--dsw-alias-label-tertiary/, '提示文字用次要色')
})

// —— v0.7：区域高度铺满 + 一屏铺不完就折起来 ——

/**
 * 造一份「任务」列表：同一天里塞 count 条会话，工作区留空（专注任务区）。
 * @param {number} count - 会话条数。
 * @returns {object} Host 状态。
 */
function bulkTasksState(count) {
  const sessions = []
  for (let index = 0; index < count; index += 1) {
    sessions.push({ id: `session-bulk-${index}`, day: TODAY, createdAt: index, live: false, archived: false })
  }
  const state = fixtureState()
  state.dayGroups = [{ day: TODAY, sessions }]
  state.workspaces = []
  return state
}

/**
 * 数一数树里画了几条会话行。
 * @param {object} tree - 元素树。
 * @param {string} indent - 该层会话行的缩进（任务 20px / 工作区成员 28px）。
 * @returns {object[]} 会话行节点。
 */
function sessionRows(tree, indent = '20px') {
  return collectByType(tree, 'div').filter((node) => {
    const className = String(node.props.className ?? '').split(' ')
    if (className[0] !== 'tsb-row') return false
    return node.props.style?.['--tsb-indent'] === indent
  })
}

/**
 * 找「展开其余 N 个会话 / 收起」那颗按钮。
 * @param {object} tree - 元素树。
 * @returns {object|undefined} 按钮节点。
 */
function moreSessionsButton(tree) {
  return collectByType(tree, 'button').find((node) => node.props.className === 'tsb-more-sessions')
}

test('任务超过 10 条：只铺 10 条，其余折进「展开其余 N 个会话」', () => {
  const tree = render(bulkTasksState(13))

  assert.equal(sessionRows(tree).length, 10, '默认铺开 10 条，不再一路铺到底')
  const more = moreSessionsButton(tree)
  assert.ok(more, '多出来的要有折叠入口')
  assert.equal(collectText(more).join(''), '展开其余 3 个会话', '按钮上写清折了几条')
  assert.equal(more.props['aria-expanded'], false)
})

test('展开后全部铺开，按钮换成「收起」', () => {
  // hook 15 = tasksExpanded
  const tree = render(bulkTasksState(13), undefined, { 15: true })

  assert.equal(sessionRows(tree).length, 13)
  const more = moreSessionsButton(tree)
  assert.ok(more, '展开后还得能收回')
  assert.equal(collectText(more).join(''), '收起')
  assert.equal(more.props['aria-expanded'], true)
})

test('排到限额之外但还在跑的会话照样露脸（急着看的不能被折起来）', () => {
  // Host 的 dayGroups 经 mergeDayGroups 之后是新的在前：createdAt 小的排在最底下，
  // 所以拿 createdAt=1 那条（倒数第二）当「折在里面的跑着的会话」。
  SESSION_STATUSES.set('session-bulk-1', { running: true, pendingInteraction: undefined, completionUnread: false })
  try {
    const tree = render(bulkTasksState(14))
    assert.equal(sessionRows(tree).length, 11, '10 条 + 那条跑着的')
    assert.equal(collectText(moreSessionsButton(tree)).join(''), '展开其余 3 个会话', '折起来的条数如实扣掉露脸的那条')
  } finally {
    SESSION_STATUSES.delete('session-bulk-1')
  }
})

test('工作区名下超过 10 条也折起来（每个工作区各记各的）', () => {
  const sessionIds = Array.from({ length: 12 }, (_unused, index) => `session-ws-${index}`)
  const state = fixtureState()
  state.dayGroups = []
  state.workspaces = [{ id: 'w-big', title: '大项目', path: 'F:\\big', order: 0, sessionIds, live: [] }]

  // hook 6 = 展开的工作区集合；hook 16 = 展开过成员列表的工作区集合
  const collapsed = render(state, undefined, { 6: new Set(['ws:w-big']) })
  assert.equal(sessionRows(collapsed, '28px').length, 10)
  assert.equal(collectText(moreSessionsButton(collapsed)).join(''), '展开其余 2 个会话')

  const expanded = render(state, undefined, { 6: new Set(['ws:w-big']), 16: new Set(['ws:w-big']) })
  assert.equal(sessionRows(expanded, '28px').length, 12)
  assert.equal(collectText(moreSessionsButton(expanded)).join(''), '收起')
})

test('样式：根容器铺满侧栏区域、行不被压扁、折叠按钮照抄内置几何', () => {
  const css = client.styles[0].textContent

  assert.match(css, /\.tsb-root \{[^}]*flex: 1 1 auto/, '铺满 DSH 给的区域，别只占内容那么高')
  assert.match(css, /\.tsb-root \{[^}]*min-height: 0/, '保住自己的滚动而不是撑破侧栏')
  for (const selector of ['.tsb-caption', '.tsb-group', '.tsb-row', '.tsb-day', '.tsb-notice']) {
    assert.match(css, new RegExp(`\\${selector} \\{[^}]*flex: 0 0 auto`), `${selector} 不许被压扁`)
  }
  assert.match(css, /\.tsb-more-sessions \{[^}]*height: 28px/, '折叠按钮与内置 sessionOverflowButton 同高')
  assert.match(css, /\.tsb-more-sessions \{[^}]*--dsw-alias-label-tertiary/, '折叠按钮用 tertiary 字色')
})

test('弹出菜单按视口坐标 fixed 定位（不再被侧栏区域的底边裁掉）', () => {
  // hook 10 = 菜单状态，hook 17 = 量好的落点
  const tree = render(fixtureState(), undefined, { 10: { kind: 'view' }, 17: { top: 120, left: 40 } })
  const menu = collectByType(tree, 'div').find((node) => node.props.className === 'tsb-menu')

  assert.ok(menu, '视图选项菜单要画出来')
  assert.equal(menu.props.style.position, 'fixed', '浮层挂视口，跟着整页走')
  assert.equal(menu.props.style.top, '120px')
  assert.equal(menu.props.style.left, '40px')
  assert.equal(menu.props.style.right, 'auto', 'fixed 时要把 CSS 里的 right: 4px 关掉')
})


// ---- v0.8：设置 → 技能 ----

/**
 * 用一份 useState 初值渲染「设置 → 技能」页。
 * hook 顺序：0 data / 1 loading / 2 error / 3 ui / 4 detail / 5 upload / 6 draft / 7 conflict / 8 confirmDelete
 * @param {Record<number, unknown>} [fixture] - 覆盖初始状态。
 * @returns {object} 假元素树。
 */
function renderSettings(fixture = {}) {
  const slot = client.slots.find((entry) => entry.definition.name === 'settings.section')
  assert.ok(slot, '应该注册了 settings.section')
  const dict = client.dictionaries.find((entry) => entry.id === 'zh')?.dict ?? {}
  const t = (key) => dict[key] ?? key
  const React = client.react
  const originalUseState = React.useState
  let hookIndex = 0
  React.useState = (initial) => {
    const index = hookIndex
    hookIndex += 1
    const value = index in fixture ? fixture[index] : typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  }
  try {
    let tree = slot.Component({ t })
    let guard = 0
    while (tree !== null && typeof tree === 'object' && typeof tree.type === 'function' && guard < 8) {
      tree = tree.type(tree.props)
      guard += 1
    }
    return tree
  } finally {
    React.useState = originalUseState
  }
}

/** 设置页首屏数据：官方 / 用户目录 / 共享目录 / 项目各一条。 */
const SKILLS_DATA = {
  complete: true,
  userRoot: 'C:/Users/17915/.dsh/skills',
  cwd: 'F:/work',
  skills: [
    {
      name: 'office',
      description: '官方 Office 技能',
      source: 'bundled',
      category: 'official',
      path: 'E:/app/office/SKILL.md',
      invocation: { modelInvocable: true, userInvocable: true },
      userManaged: false,
    },
    {
      name: 'mine',
      description: '我自己写的',
      whenToUse: '做报表时',
      source: 'user-dsh',
      category: 'user',
      path: 'C:/Users/17915/.dsh/skills/mine/SKILL.md',
      invocation: { modelInvocable: true, userInvocable: false },
      userManaged: true,
    },
    {
      name: 'shared',
      description: '共享 Agent 目录里的',
      source: 'user-agents',
      category: 'user',
      path: 'C:/Users/17915/.agents/skills/shared/SKILL.md',
      invocation: { modelInvocable: true, userInvocable: true },
      userManaged: false,
    },
    {
      name: 'project-one',
      description: '项目里的',
      source: 'project-dsh',
      category: 'project',
      path: 'F:/work/.dsh/skills/project-one/SKILL.md',
      invocation: { modelInvocable: true, userInvocable: true },
      userManaged: false,
    },
  ],
}

test('技能页：按来源分类，官方 / 我的 / 项目分组并显示计数与安装位置', () => {
  const tree = renderSettings({ 0: SKILLS_DATA, 1: false })
  const text = collectText(tree).join(' ')

  assert.match(text, /^技能/)
  assert.match(text, /官方随包提供/)
  assert.match(text, /C:\/Users\/17915\/\.dsh\/skills/, '显示安装位置')
  for (const name of ['office', 'mine', 'shared', 'project-one']) assert.match(text, new RegExp(name))
  assert.match(text, /仅模型/, 'mine 只对模型可调（user-invocable: false）')

  const tabs = collectByType(tree, 'button').filter((node) => node.props.className === 'tsk-tab')
  assert.deepEqual(
    tabs.map((tab) => collectText(tab).join('')),
    ['全部4', '官方内置1', '我的技能2', '项目1'],
  )
  assert.equal(tabs[0].props['data-active'], 'true')
  assert.equal(tabs[1].props['data-active'], undefined)

  const rows = collectByType(tree, 'button').filter((node) => node.props.className === 'tsk-row')
  assert.deepEqual(
    rows.map((row) => collectText(row).join(' ').split(' ')[0]),
    ['office', 'mine', 'shared', 'project-one'],
    '官方排最前，用户其次，项目最后',
  )
  const badges = collectByType(tree, 'span')
    .filter((node) => typeof node.props.className === 'string' && node.props.className.startsWith('tsk-badge'))
    .map((node) => collectText(node).join(''))
  for (const badge of ['官方内置', '模型 + 用户', 'DSH 用户目录', '仅模型', '共享 Agent 目录', '项目 .dsh']) {
    assert.ok(badges.includes(badge), `缺少角标：${badge}`)
  }
})

test('技能页：加载 / 空 / 读取失败三种状态都有一句人话', () => {
  assert.match(collectText(renderSettings({ 0: null, 1: true })).join(' '), /正在读取技能/)
  assert.match(
    collectText(renderSettings({ 0: { skills: [], userRoot: 'x', complete: true }, 1: false })).join(' '),
    /还没有技能/,
  )
  assert.match(collectText(renderSettings({ 0: null, 1: false, 2: 'boom' })).join(' '), /技能读取失败：boom/)
  assert.match(
    collectText(renderSettings({ 0: { ...SKILLS_DATA, complete: false }, 1: false })).join(' '),
    /没有读全/,
  )
})

test('技能详情：正文按需读取；只有用户技能根里的才露出删除按钮', () => {
  const mine = SKILLS_DATA.skills[1]
  const detailTree = renderSettings({
    0: SKILLS_DATA,
    1: false,
    3: { query: '', filter: 'all', modal: { kind: 'detail', skill: mine }, notice: '', busy: '' },
    4: { loading: false, content: '# 完整正文\n\n照着做。', error: '' },
  })
  const text = collectText(detailTree).join(' ')
  const dialog = collectByType(detailTree, 'div').find((node) => node.props.role === 'dialog')
  assert.equal(dialog.props['aria-label'], '技能详情')
  assert.match(text, /# 完整正文/)
  assert.match(text, /删除技能/)
  assert.match(text, /做报表时/)

  const official = SKILLS_DATA.skills[0]
  const officialTree = renderSettings({
    0: SKILLS_DATA,
    1: false,
    3: { query: '', filter: 'all', modal: { kind: 'detail', skill: official }, notice: '', busy: '' },
    4: { loading: false, content: '官方正文', error: '' },
  })
  const officialButtons = collectByType(officialTree, 'button')
    .filter((node) => node.props.className === 'tsk-btn')
    .map((node) => collectText(node).join(''))
  assert.equal(officialButtons.includes('删除技能'), false, '官方技能只读')
})

test('技能上传弹窗：目录输入、文件清单、识别结果与安装按钮', () => {
  const tree = renderSettings({
    0: SKILLS_DATA,
    1: false,
    3: { query: '', filter: 'all', modal: { kind: 'upload' }, notice: '', busy: '' },
    5: {
      files: [
        { path: 'mine/SKILL.md', size: 2048 },
        { path: 'mine/references/a.md', size: 512 },
      ],
      name: 'mine',
      description: '我自己写的',
      reading: false,
      error: '',
      hasSkillMd: true,
      dragging: false,
    },
  })
  const text = collectText(tree).join(' ')
  assert.match(text, /上传技能/)
  assert.match(text, /识别到技能：mine/)
  assert.match(text, /mine\/SKILL\.md/)
  assert.match(text, /2 KB/)
  assert.match(text, /安装/)

  const inputs = collectByType(tree, 'input')
  assert.ok(inputs.some((input) => input.props.type === 'file' && input.props.webkitdirectory === ''), '有目录选择输入')
  assert.ok(inputs.some((input) => input.props.type === 'file' && input.props.webkitdirectory === undefined), '也有单文件输入')
})

test('新建技能弹窗：四个字段都受控，点安装发 installSkill', () => {
  const tree = renderSettings({
    0: SKILLS_DATA,
    1: false,
    3: { query: '', filter: 'all', modal: { kind: 'create' }, notice: '', busy: '' },
    6: { name: 'report-builder', description: '做报表', whenToUse: '每月初', body: '# 步骤', error: '' },
  })
  const text = collectText(tree).join(' ')
  assert.match(text, /新建技能/)
  assert.match(text, /report-builder/)

  const inputs = collectByType(tree, 'input').filter((input) => input.props.className === 'tsk-input')
  assert.deepEqual(
    inputs.map((input) => input.props.value),
    ['report-builder', '做报表', '每月初'],
  )
  const textarea = collectByType(tree, 'textarea').find((node) => node.props.className === 'tsk-textarea')
  assert.equal(textarea.props.value, '# 步骤')
})
