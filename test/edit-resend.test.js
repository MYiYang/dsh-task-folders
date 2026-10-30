/**
 * 对话流里「停止 / 失败 → 编辑重发」的契约测试。
 *
 * 这条功能挂在会话自己的 `conversation.chat.turnTail` 上，判断与重发全靠槽位给的
 * 三个标准道具（`turn` 回合记录、`useChat` Chat 快照、`inputActions` 输入面板）。
 * 这里用假 React + 假快照把那几个判断逐个钉住：
 *   1. 只有 `turn/end` 的 aborted / error / interrupted 三种才给入口；
 *   2. 只有**最后一个**回合给入口（历史回合重发会把结果挂到今天的尾巴上）；
 *   3. 只认这一轮里人工发的 `user` 消息——引导（steering）、通知唤起（turn-trigger）都不算；
 *   4. 点「重发」走 `setDraft` → `submit`（和手打一条消息同一条路），不自己拼请求；
 *   5. 输入面板不可用时给一句人话，不抛。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

/** `__ModuleLoader__.load` 收到的包定义。 */
let loaded

/** 记账：注册了哪些槽。 */
const slots = []

/**
 * 假 React：`useState` 按 hook 序号从 fixture 取值，并把 setter 的入参记下来，
 * 这样「点一下之后调了什么」可以断言，而不需要一个真的 React 调度器。
 * @returns {object} 假 React。
 */
function makeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Number.POSITIVE_INFINITY) }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
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

/** 平台共享模块表里的图标集（只要有名字就够：组件只把它交给 React 画）。 */
const FAKE_PRIMITIVES = {
  IconEditOutlineRegular: 'IconEditOutlineRegular',
  IconSendOutlineRegular: 'IconSendOutlineRegular',
  IconFolderCloseRegular: 'IconFolderCloseRegular',
  IconFolderOpenRegular: 'IconFolderOpenRegular',
  IconTriangleRightFillRegular: 'IconTriangleRightFillRegular',
  IconSearchOutlineRegular: 'IconSearchOutlineRegular',
  IconEllipsisOutlineRegular: 'IconEllipsisOutlineRegular',
}

/**
 * 装上 window / document 桩，载入并 apply 一遍客户端半侧。
 * @param {{primitives?: boolean}} [options] - `primitives: false` 模拟老版本 DSH。
 * @returns {Promise<object>} 载入结果。
 */
async function bootstrap(options = {}) {
  const primitives = options.primitives !== false
  slots.length = 0
  const styles = []
  globalThis.window = { __ModuleLoader__: { load(definition) { loaded = definition } } }
  globalThis.document = {
    createElement() {
      return { textContent: '', setAttribute() {}, remove() {} }
    },
    head: { appendChild(node) { styles.push(node) } },
    body: {},
  }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) })

  // 带查询串导入：同一进程里（`--test-isolation=none`）也不会命中另一份测试的模块缓存。
  await import('../client.js?edit-resend')
  assert.equal(loaded.id, 'dsh-task-folders')

  const dictionaries = []
  const react = makeReact()
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get() {
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
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node) => node }
    if (!primitives) throw new Error(`module not found: ${name}`)
    return FAKE_PRIMITIVES
  })
  module.apply(ctx)
  const slot = slots.find((entry) => entry.definition.name === 'conversation.chat.turnTail')
  assert.ok(slot !== undefined, '必须注册 conversation.chat.turnTail')
  const t = ctx.locale.bind('taskFolders')
  const css = (styles[0]?.textContent ?? '').toString()
  return { module, react, ctx, slot, t, css, definitions: [...slots] }
}

const client = await bootstrap()

/**
 * 造一份 Chat 快照：只填这条功能会读的字段。
 * @param {{order?: number[], turns?: Record<number, {kind: string, content?: unknown}[]>, reason?: string}} [input]
 * @returns {object} 假快照。
 */
function makeSnapshot(input = {}) {
  const order = input.order ?? [1]
  const nodes = new Map()
  const locations = new Map()
  for (const [turn, list] of Object.entries(input.turns ?? {})) {
    const keys = []
    for (const [index, node] of list.entries()) {
      const key = `${turn}:${node.kind}:${index}`
      keys.push(key)
      nodes.set(key, { key, kind: node.kind, data: { content: node.content } })
    }
    locations.set(Number(turn), keys)
  }
  const turns = new Map()
  if (input.reason !== undefined) {
    turns.set(1, { turn: 1, end: { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: input.reason } } } })
  }
  return {
    timeline: { turnOrder: order, turns },
    locations: { getTurn: (turn) => locations.get(turn) ?? [] },
    nodes,
  }
}

/** 一段普通用户消息的内容（wire 块）。 */
function textContent(text) {
  return [{ type: 'text', text }]
}

/**
 * 渲染这个槽位的组件一次，返回假元素树和 setter 记账。
 * @param {object} props - 传给组件的 props。
 * @param {Record<number, unknown>} [extra] - 覆盖 useState 的初值（0 = 展开、1 = 草稿、2 = 提示）。
 * @param {object} [bundle] - 用哪一份客户端半侧（默认是主实例）。
 * @returns {{tree: unknown, setCalls: {slot: number, next: unknown}[]}} 渲染结果。
 */
function renderTail(props, extra = {}, bundle = client) {
  const React = bundle.react
  const originalUseState = React.useState
  const fixture = { 0: false, ...extra }
  const setCalls = []
  let hookIndex = 0
  React.useState = (initial) => {
    const slot = hookIndex
    hookIndex += 1
    const value = slot in fixture ? fixture[slot] : typeof initial === 'function' ? initial() : initial
    return [value, (next) => setCalls.push({ slot, next })]
  }
  try {
    return { tree: bundle.slot.Component(props), setCalls }
  } finally {
    React.useState = originalUseState
  }
}

/**
 * 拼一份正常的槽位 props。
 * @param {object} snapshot - 假快照。
 * @param {object} [options] - 覆盖项。
 * @returns {object} props。
 */
function propsFor(snapshot, options = {}) {
  return {
    turn: options.turn ?? { turn: 1, end: { type: 'turn/end', data: { reason: { kind: options.reason ?? 'aborted' } } } },
    seq: 12,
    useChat: (selector) => selector(snapshot),
    useInput: (selector) => selector(options.input ?? { draft: '' }),
    useSession: (selector) => selector(options.session ?? { sessionId: 'session-1', subagent: null }),
    inputActions: 'inputActions' in options ? options.inputActions : { setDraft() {}, submit() {} },
    t: options.t ?? client.t,
    renderSlot: () => null,
    openFile: () => {},
  }
}

/** 判断假元素树上有没有某个 class（可以写多个，逗号都算「全都得在」）。 */
function hasClass(node, className) {
  const wanted = String(className).split(/\s+/).filter(Boolean)
  if (node === null || node === undefined || node === false) return false
  if (Array.isArray(node)) return node.some((child) => hasClass(child, className))
  if (typeof node !== 'object') return false
  const classes = String(node.props?.className ?? '').split(/\s+/)
  if (wanted.every((name) => classes.includes(name))) return true
  return (node.children ?? []).some((child) => hasClass(child, className))
}

/** 收集假元素树上的文本。 */
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

/** 按 class 找第一个节点（可以写多个 class，逗号都算「全都得在」）。 */
function findByClass(node, className) {
  const wanted = String(className).split(/\s+/).filter(Boolean)
  if (node === null || node === undefined || node === false) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByClass(child, className)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  const classes = String(node.props?.className ?? '').split(/\s+/)
  if (wanted.every((name) => classes.includes(name))) return node
  for (const child of node.children ?? []) {
    const hit = findByClass(child, className)
    if (hit !== undefined) return hit
  }
  return undefined
}

test('停止（turn/end 的 aborted）在最后一轮：给「编辑重发」入口', () => {
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('帮我把登录拆一下') }] }, reason: 'aborted' })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted' }))
  assert.ok(hasClass(tree, 'tsr-trigger'), '要有入口按钮')
  assert.equal(findByClass(tree, 'tsr-row').props['data-outcome'], 'stopped')
  const text = collectText(tree).join('')
  assert.match(text, /编辑重发/)
  assert.equal(typeof findByClass(tree, 'tsr-trigger').props.onClick, 'function')
})

test('失败（turn/end 的 error）与进程中断（interrupted）也算，标成 failed', () => {
  for (const reason of ['error', 'interrupted']) {
    const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('跑一下测试') }] }, reason })
    const { tree } = renderTail(propsFor(snapshot, { reason }))
    assert.ok(hasClass(tree, 'tsr-trigger'), `${reason} 要有入口`)
    assert.equal(findByClass(tree, 'tsr-row').props['data-outcome'], 'failed', `${reason} 标成 failed`)
  }
})

test('跑完 / 撞输出上限 / 分支 / 阻塞：都不给入口', () => {
  for (const reason of ['completed', 'max-tokens', 'forked', 'blocked']) {
    const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('跑一下测试') }] }, reason })
    const { tree } = renderTail(propsFor(snapshot, { reason }))
    assert.equal(tree, null, `${reason} 不该出现`)
  }
})

test('历史回合不给入口：只有最后一个回合能重发', () => {
  const snapshot = makeSnapshot({
    order: [1, 2],
    turns: {
      1: [{ kind: 'user', content: textContent('第一轮') }],
      2: [{ kind: 'user', content: textContent('第二轮') }],
    },
    reason: 'aborted',
  })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted' }))
  assert.equal(tree, null, '回合 1 不是最后一轮，不给入口')
})

test('子代理会话不给入口：输入面板是父会话底下的只读面板', () => {
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('这是一个子代理任务') }] }, reason: 'aborted' })
  const { tree } = renderTail(
    propsFor(snapshot, { reason: 'aborted', session: { sessionId: 'session-1', subagent: { address: { id: 'child' } } } }),
  )
  assert.equal(tree, null)
})

test('只认人工发的 user 消息：引导 / 通知唤起不算「上一条消息」', () => {
  const snapshot = makeSnapshot({
    turns: { 1: [{ kind: 'turn-trigger' }, { kind: 'steering', content: textContent('顺带看下日志') }] },
    reason: 'aborted',
  })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted' }))
  assert.equal(tree, null, '没有 user 消息就不给入口')
})

test('点入口：把这一轮的人工消息塞进编辑框并展开', () => {
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('帮我改一下登录') }] }, reason: 'aborted' })
  const { tree, setCalls } = renderTail(propsFor(snapshot, { reason: 'aborted' }))
  findByClass(tree, 'tsr-trigger').props.onClick()
  const opened = setCalls.find((call) => call.slot === 0)
  assert.equal(opened?.next, true, '要展开编辑框')
  const seeded = setCalls.find((call) => call.slot === 1)
  assert.equal(seeded?.next, '帮我改一下登录', '编辑框预填原来那句话')
})

test('重发：先 setDraft（编辑后的文字）再 submit，关掉编辑框', () => {
  const calls = []
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const props = propsFor(snapshot, {
    reason: 'aborted',
    inputActions: {
      setDraft(text) {
        calls.push(['setDraft', text])
      },
      submit() {
        calls.push(['submit'])
      },
    },
  })
  const { tree, setCalls } = renderTail(props, { 0: true, 1: '改过的话' })
  const primary = findByClass(tree, 'tsk-btn is-primary')
  assert.equal(primary.props.disabled, false)
  primary.props.onClick()
  assert.deepEqual(calls, [['setDraft', '改过的话'], ['submit']], '走会话自己的输入面板，不自己拼请求')
  assert.equal(setCalls.find((call) => call.slot === 0)?.next, false, '发完收起编辑框')
})

test('编辑框里是空白时「重发」按不动', () => {
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted' }), { 0: true, 1: '   ' })
  assert.equal(findByClass(tree, 'tsk-btn is-primary').props.disabled, true)
})

test('输入面板不可用（拿不到 setDraft/submit）：给一句人话，不抛', () => {
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const { tree, setCalls } = renderTail(propsFor(snapshot, { reason: 'aborted', inputActions: undefined }), {
    0: true,
    1: '原来的话',
  })
  const primary = findByClass(tree, 'tsk-btn is-primary')
  assert.doesNotThrow(() => primary.props.onClick())
  const notice = setCalls.find((call) => call.slot === 2)
  assert.match(String(notice?.next ?? ''), /输入框不可用/)
})

test('输入框里还有没发出去的内容：先提醒会被替换', () => {
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const withDraft = renderTail(propsFor(snapshot, { reason: 'aborted', input: { draft: '我正在写的另一件事' } }), {
    0: true,
    1: '原来的话',
  })
  assert.match(collectText(withDraft.tree).join(''), /重发会替换掉它/)
  const empty = renderTail(propsFor(snapshot, { reason: 'aborted', input: { draft: '' } }), { 0: true, 1: '原来的话' })
  assert.doesNotMatch(collectText(empty.tree).join(''), /重发会替换掉它/)
})

test('输入框正忙着发上一条：提醒一句，「重发」按不动', () => {
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted', input: { draft: '', phase: 'submitting' } }), {
    0: true,
    1: '原来的话',
  })
  assert.match(collectText(tree).join(''), /输入框正忙/)
  assert.equal(findByClass(tree, 'tsk-btn is-primary').props.disabled, true)
})

test('原消息带附件：说清楚附件不会一起重发', () => {
  const snapshot = makeSnapshot({
    turns: { 1: [{ kind: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image' }, { type: 'file' }] }] },
    reason: 'aborted',
  })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted' }), { 0: true, 1: '看这张图' })
  assert.match(collectText(tree).join(''), /2 个附件不会一起重发/)
})

test('编辑框：Esc 收起，Ctrl/⌘ + Enter 直接重发', () => {
  const calls = []
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const props = propsFor(snapshot, {
    reason: 'aborted',
    inputActions: {
      setDraft: (text) => calls.push(['setDraft', text]),
      submit: () => calls.push(['submit']),
    },
  })
  const { tree, setCalls } = renderTail(props, { 0: true, 1: '改过的话' })
  const input = findByClass(tree, 'tsr-input')
  let prevented = false
  input.props.onKeyDown({ key: 'Escape', preventDefault: () => { prevented = true } })
  assert.equal(setCalls.find((call) => call.slot === 0)?.next, false, 'Esc 收起')
  assert.equal(prevented, true)
  input.props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {} })
  assert.deepEqual(calls, [['setDraft', '改过的话'], ['submit']], 'Ctrl + Enter 直接重发')
})

test('拿不到 DSH 图标集时退回自带 SVG（铅笔 / 上行箭头）', async () => {
  const bare = await bootstrap({ primitives: false })
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const collapsed = renderTail(propsFor(snapshot, { reason: 'aborted', t: bare.t }), {}, bare)
  assert.ok(hasClass(collapsed.tree, 'tsr-trigger'))
  const pencil = findByClass(collapsed.tree, 'tsr-trigger').children.find((child) => child?.type === 'svg')
  assert.ok(pencil !== undefined, '入口图标要退回自带 SVG')
  assert.equal(pencil.props.viewBox, '0 0 16 16')
  assert.equal(pencil.props['aria-hidden'], 'true')
  assert.equal(pencil.children.length, 2, '铅笔 = 方框 + 笔杆')

  const expanded = renderTail(propsFor(snapshot, { reason: 'aborted', t: bare.t }), { 0: true, 1: '原来的话' }, bare)
  const primary = findByClass(expanded.tree, 'tsk-btn is-primary')
  const arrow = primary.children.find((child) => child?.type === 'svg')
  assert.ok(arrow !== undefined, '重发按钮也要有图标')
  assert.equal(arrow.props.viewBox, '0 0 16 16')
})

test('样式：入口与编辑框都用对话流的令牌与几何', () => {
  assert.match(client.css, /\.tsr-trigger \{/, '入口按钮有样式')
  assert.match(client.css, /\.tsr-root \{/, '编辑框卡片有样式')
  assert.match(client.css, /\.tsr-input:focus-visible[\s\S]*outline: var\(--dsw-focus-ring-width\)/, '聚焦环走 DSH 令牌')
  assert.match(client.css, /\.tsr-note\.is-error \{ color: var\(--dsw-alias-state-error-primary\)/, '失败提示用 error 令牌')
  assert.match(client.css, /\.tsr-note\.is-warn \{ color: var\(--dsw-alias-state-warn-primary\)/, '提醒用 warn 令牌')
  assert.match(client.css, /\.tsr-input \{[\s\S]*font-size: var\(--dsh-content-font-size, 14px\)/, '字号跟对话正文走，不是侧栏的 12px')
})
