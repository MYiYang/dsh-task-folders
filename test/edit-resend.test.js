/**
 * 「停止 / 失败 → 编辑重发」的契约测试。
 *
 * 形状：用户消息动作行里（复制图标旁）一颗铅笔；点开**就地**把那条气泡换成编辑框
 * （给流节点打 `data-tsr-editing` 把原生行藏起来，编辑框 portal 进同一个流节点）。
 *
 * 这里用假 React（会跑 effect）+ 假 DOM 钉住：
 *   1. 只有 aborted / error / interrupted 的**最后一轮**、且有人工 `user` 消息才给入口；
 *   2. 子代理不给、找不到流节点就不画；
 *   3. 点铅笔 = 进入就地编辑并预填原文；
 *   4. 编辑时打标记、收起时清掉；
 *   5. 重发 = `setDraft(改后的字)` + `submit()` + 收起；空白不可发；
 *   6. Esc 收起、Enter 重发、Shift+Enter 不重发；
 *   7. 「用输入框改（可贴图）」= 放回 composer 并聚焦；
 *   8. 图标集缺席时退回自带 SVG。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

/** `__ModuleLoader__.load` 收到的包定义。 */
let loaded

/** 记账：注册了哪些槽。 */
const slots = []

/**
 * 假 React：`useState` 按 hook 序号从 fixture 取值并记录 setter；`useEffect` 收集起来，
 * 由 `renderTail` 在渲染后统一跑一次（这样 DOM 标记、聚焦这类副作用也能断言）。
 * @returns {object} 假 React。
 */
function makeReact() {
  const effects = []
  return {
    effects,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Number.POSITIVE_INFINITY) }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect(fn) {
      effects.push(fn)
    },
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
    querySelectorAll() {
      return []
    },
    querySelector() {
      return null
    },
  }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) })

  // 带查询串导入：同一进程里（`--test-isolation=none`）也不会命中另一份测试的模块缓存。
  await import('../client.js?edit-resend')
  assert.equal(loaded.id, 'dsh-task-folders')

  const dictionaries = []
  const react = makeReact()
  /** 测试可注入的服务（sessions / uiWorkspace …）。 */
  const services = new Map()
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get(name) {
      return services.get(name)
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
  return { module, react, ctx, slot, t, css, services }
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
      nodes.set(key, { key, kind: node.kind, data: { content: node.content, seq: node.seq ?? 100 + index } })
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
 * 装一份「用户消息流节点」的假 DOM。
 *
 * 结构照 ui-chat 的真实 DOM：`[data-chat-flow-kind=user][data-chat-turn=n]` 是一个流节点，
 * 里面有一行动作（时间 + 复制），动作行带 `data-clock="start"`；底部输入框带 `[data-composer-input]`。
 * @param {{turn?: number, hasNode?: boolean}} [options] - 回合号 / 是否找得到流节点。
 * @returns {{attrs: Map<string, string>, actions: object, item: object, composer: object}} 断言用的桩。
 */
function installDom(options = {}) {
  const turn = options.turn ?? 1
  const attrs = new Map()
  const actions = { kind: 'actions' }
  const item = {
    kind: 'node',
    getAttribute(name) {
      return name === 'data-chat-turn' ? String(turn) : null
    },
    querySelector(selector) {
      return selector === '[data-clock="start"]' ? actions : null
    },
    setAttribute(name, value) {
      attrs.set(name, value)
    },
    removeAttribute(name) {
      attrs.delete(name)
    },
  }
  const composer = {
    focused: false,
    focus() {
      this.focused = true
    },
  }
  globalThis.document = {
    ...globalThis.document,
    querySelectorAll(selector) {
      if (options.hasNode === false) return []
      // 找用户行、以及「扫这个回合全部流节点」都落到同一个桩上。
      return selector.includes('[data-chat-flow-kind="user"]') || selector.includes('[data-chat-turn=')
        ? [item]
        : []
    },
    querySelector(selector) {
      return selector === '[data-composer-input]' ? composer : null
    },
  }
  return { attrs, actions, item, composer }
}

/**
 * 渲染这个槽位的组件一次：跑一遍渲染、再跑一遍收集到的 effect。
 * @param {object} props - 传给组件的 props。
 * @param {Record<number, unknown>} [extra] - 覆盖 useState 的初值（0 = 流节点，1 = 编辑中，2 = 草稿）。
 * @param {object} [bundle] - 用哪一份客户端半侧（默认是主实例）。
 * @returns {{tree: unknown, setCalls: {slot: number, next: unknown}[], cleanups: Function[]}} 渲染结果。
 */
function renderTail(props, extra = {}, bundle = client) {
  const React = bundle.react
  const originalUseState = React.useState
  const originalUseEffect = React.useEffect
  const fixture = { ...extra }
  const setCalls = []
  const cleanups = []
  const effects = []
  let hookIndex = 0
  React.useState = (initial) => {
    const slot = hookIndex
    hookIndex += 1
    const value = slot in fixture ? fixture[slot] : typeof initial === 'function' ? initial() : initial
    return [value, (next) => setCalls.push({ slot, next })]
  }
  React.useEffect = (fn) => effects.push(fn)
  try {
    const tree = bundle.slot.Component(props)
    for (const effect of effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    return { tree, setCalls, cleanups }
  } finally {
    React.useState = originalUseState
    React.useEffect = originalUseEffect
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
    turn:
      options.turn ??
      {
        turn: 1,
        start: { type: 'turn/start', seq: 100, time: 0, data: { turn: 1 } },
        end: { type: 'turn/end', data: { reason: { kind: options.reason ?? 'aborted' } } },
      },
    seq: 12,
    sessionId: options.sessionId ?? 'session-1',
    useChat: (selector) => selector(snapshot),
    useSession: (selector) => selector(options.session ?? { sessionId: 'session-1', subagent: null }),
    inputActions: 'inputActions' in options ? options.inputActions : { setDraft() {}, submit() {} },
    t: options.t ?? client.t,
    renderSlot: () => null,
    openFile: () => {},
  }
}

/** 按 class 找第一个节点。 */
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

test('停止（aborted）的最后一轮：用户消息动作行里多一颗编辑图标', () => {
  installDom()
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('帮我把登录拆一下') }] }, reason: 'aborted' })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted' }))
  const button = findByClass(tree, 'tsr-action')
  assert.ok(button !== undefined, '要有一颗动作行图标')
  assert.equal(button.props['data-tsr-edit-resend'], 'true')
  assert.equal(button.props['aria-label'], '就地编辑这条消息，改完重新发一次')
  assert.equal(collectText(button).join(''), '', '图标按钮不占文字')
})

test('失败（error）与进程中断（interrupted）也给入口', () => {
  for (const reason of ['error', 'interrupted']) {
    installDom()
    const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('跑一下测试') }] }, reason })
    const { tree } = renderTail(propsFor(snapshot, { reason }))
    assert.ok(findByClass(tree, 'tsr-action') !== undefined, `${reason} 要给入口`)
  }
})

test('跑完 / 撞输出上限 / 分支 / 阻塞：都不给', () => {
  for (const reason of ['completed', 'max-tokens', 'forked', 'blocked']) {
    installDom()
    const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('跑一下测试') }] }, reason })
    const { tree } = renderTail(propsFor(snapshot, { reason }))
    assert.equal(tree, null, `${reason} 不该出现`)
  }
})

test('历史回合不给：只有最后一个回合能重发', () => {
  installDom()
  const snapshot = makeSnapshot({
    order: [1, 2],
    turns: { 1: [{ kind: 'user', content: textContent('第一轮') }], 2: [{ kind: 'user', content: textContent('第二轮') }] },
    reason: 'aborted',
  })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted' }))
  assert.equal(tree, null)
})

test('子代理会话不给', () => {
  installDom()
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('子代理任务') }] }, reason: 'aborted' })
  const { tree } = renderTail(
    propsFor(snapshot, {
      reason: 'aborted',
      session: { sessionId: 'session-1', subagent: { address: { id: 'child' } } },
    }),
  )
  assert.equal(tree, null)
})

test('只认人工发的 user 消息：引导 / 通知唤起不算「上一条消息」', () => {
  installDom()
  const snapshot = makeSnapshot({
    turns: { 1: [{ kind: 'turn-trigger' }, { kind: 'steering', content: textContent('顺带看下日志') }] },
    reason: 'aborted',
  })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted' }))
  assert.equal(tree, null)
})

test('找不到那条用户消息的流节点：什么都不画', () => {
  installDom({ hasNode: false })
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted' }))
  assert.equal(tree, null)
})

test('拿不到输入面板（没有 setDraft）：不出现「点不动的按钮」', () => {
  installDom()
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted', inputActions: undefined }))
  assert.equal(tree, null)
})

test('点铅笔：就地进入编辑，预填这一轮的原话', () => {
  installDom()
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('帮我把登录拆成两步') }] }, reason: 'aborted' })
  const { tree, setCalls } = renderTail(propsFor(snapshot, { reason: 'aborted' }))
  findByClass(tree, 'tsr-action').props.onClick()
  assert.equal(setCalls.find((call) => call.slot === 1)?.next, true, '要进入编辑态')
  assert.equal(setCalls.find((call) => call.slot === 2)?.next, '帮我把登录拆成两步', '编辑框预填原文')
})

test('编辑态：气泡位置换成编辑框（预填、带重发 / 取消 / 输入框出口）', () => {
  installDom()
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted' }), { 1: true, 2: '原来的话' })
  const editor = findByClass(tree, 'tsr-editor')
  assert.ok(editor !== undefined, '要出现就地编辑框')
  const input = findByClass(tree, 'tsr-editor-input')
  assert.equal(input.props.value, '原来的话')
  assert.equal(findByClass(tree, 'tsr-action'), undefined, '编辑时不再显示铅笔')
  const texts = collectText(editor).join(' ')
  assert.match(texts, /重发/)
  assert.match(texts, /取消/)
  assert.match(texts, /用输入框改/)
  assert.match(texts, /Enter 重发/)
})

test('编辑时给流节点打 data-tsr-editing，收起时清掉', () => {
  const dom = installDom()
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const { cleanups } = renderTail(propsFor(snapshot, { reason: 'aborted' }), { 1: true, 2: '原来的话' })
  assert.equal(dom.attrs.get('data-tsr-editing'), 'true', '原生行要靠这个标记藏起来')
  for (const cleanup of cleanups) cleanup()
  assert.equal(dom.attrs.has('data-tsr-editing'), false, '收起后要把标记清掉')
})

test('重发：setDraft(改后的字) + submit + 收起编辑框', () => {
  installDom()
  const calls = []
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const props = propsFor(snapshot, {
    reason: 'aborted',
    inputActions: {
      setDraft: (text) => calls.push(['setDraft', text]),
      submit: () => calls.push(['submit']),
    },
  })
  const { tree, setCalls } = renderTail(props, { 1: true, 2: '改过的话' })
  findByClass(tree, 'tsr-btn is-primary').props.onClick()
  assert.deepEqual(calls, [['setDraft', '改过的话'], ['submit']], '走会话自己的提交，不自己拼请求')
  assert.equal(setCalls.find((call) => call.slot === 1)?.next, false, '发完收起编辑框')
})

test('编辑框里是空白时「重发」按不动', () => {
  installDom()
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted' }), { 1: true, 2: '   ' })
  assert.equal(findByClass(tree, 'tsr-btn is-primary').props.disabled, true)
})

test('键盘：Esc 收起、Enter 重发、Shift+Enter 只在框里换行', async () => {
  installDom()
  const calls = []
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const props = propsFor(snapshot, {
    reason: 'aborted',
    inputActions: {
      setDraft: (text) => calls.push(['setDraft', text]),
      submit: () => calls.push(['submit']),
    },
  })
  const { tree, setCalls } = renderTail(props, { 1: true, 2: '改过的话' })
  const input = findByClass(tree, 'tsr-editor-input')
  let prevented = 0
  const preventDefault = () => {
    prevented += 1
  }
  input.props.onKeyDown({ key: 'Enter', shiftKey: true, preventDefault })
  assert.deepEqual(calls, [], 'Shift+Enter 不重发')
  assert.equal(prevented, 0)
  input.props.onKeyDown({ key: 'Enter', preventDefault })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls, [['setDraft', '改过的话'], ['submit']], 'Enter 重发')
  input.props.onKeyDown({ key: 'Escape', preventDefault })
  assert.equal(setCalls.find((call) => call.slot === 1)?.next, false, 'Esc 收起')
})

test('「用输入框改（可贴图）」：把当前文字放回 composer 并聚焦，然后收起', () => {
  const dom = installDom()
  const calls = []
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const props = propsFor(snapshot, {
    reason: 'aborted',
    inputActions: {
      setDraft: (text) => calls.push(['setDraft', text]),
      submit: () => calls.push(['submit']),
    },
  })
  const { tree, setCalls } = renderTail(props, { 1: true, 2: '改过的话' })
  findByClass(tree, 'tsr-editor-link').props.onClick()
  assert.deepEqual(calls, [['setDraft', '改过的话']], '只放回输入框，不代按发送')
  assert.equal(dom.composer.focused, true, '要把键盘送回输入框')
  assert.equal(setCalls.find((call) => call.slot === 1)?.next, false, '收起编辑框')
})

test('拿不到 DSH 图标集时退回自带铅笔 SVG', async () => {
  const bare = await bootstrap({ primitives: false })
  installDom()
  const snapshot = makeSnapshot({ turns: { 1: [{ kind: 'user', content: textContent('原来的话') }] }, reason: 'aborted' })
  const { tree } = renderTail(propsFor(snapshot, { reason: 'aborted', t: bare.t }), {}, bare)
  const button = findByClass(tree, 'tsr-action')
  assert.ok(button !== undefined)
  const icon = button.children.find((child) => child?.type === 'svg')
  assert.ok(icon !== undefined, '图标要退回自带 SVG')
  assert.equal(icon.props.viewBox, '0 0 16 16')
  assert.equal(icon.children.length, 2, '铅笔 = 方框 + 笔杆')
})

test('样式：铅笔照抄原生动作图标；编辑框照抄用户气泡', () => {
  assert.match(client.css, /\.tsr-action \{[\s\S]*?width: calc\(28px \+ var\(--dsh-content-font-delta, 0px\)\)/, '28px 见方')
  assert.match(client.css, /\.tsr-action svg \{[\s\S]*?width: calc\(15px \+ var\(--dsh-content-font-delta, 0px\)\)/, '15px 图标')
  assert.match(
    client.css,
    /\.tsr-editor \{[\s\S]*?width: min\(calc\(var\(--dsh-chat-content-width, 748px\) \* \.702\), 82%\)/,
    '与气泡同宽',
  )
  assert.match(client.css, /\.tsr-editor \{[\s\S]*?background: var\(--dsw-specific-bubble\)/, '底色跟气泡一致')
  assert.match(
    client.css,
    /\[data-tsr-editing="true"\] > :not\(\.tsr-editor\) \{[\s\S]*?display: none !important/,
    '编辑时把原生行藏起来（槽包裹层是内联 display:contents，必须 !important）',
  )
  assert.match(
    client.css,
    /\.tsr-btn\.is-primary \{[\s\S]*?background: var\(--dsw-alias-button-primary-fill/,
    '主按钮走 DSH 令牌',
  )
})
