/**
 * Client half of `dsh-task-folders`（任务）：接管侧栏的浏览区。
 *
 * 形态（对齐 DSH 自己的侧栏语言：12px 行、26-32px 行高、6px 圆角、`--dsw-alias-*` 令牌）：
 *
 *   项目                                  ← 行首文件夹图标（「项目」这块就是个目录）
 *   任务  ▾                    ＋        ← 「任务」= 任务区默认工作区名下的会话，按天分组
 *     今天                                 ← 按天分隔（今天 / 昨天 / YYYY-MM-DD）
 *       · 聊聊登录重构            3 分钟   ← 行首是状态点（运行中/有新结果/待确认/空闲）
 *     昨天
 *       · 昨天那条                2 小时
 *   工作区 ▾                   ＋        ← ＋ 添加工作区（走 DSH 自己的目录选择框）
 *     [文件夹] 我的项目        8  ＋     ← 行首文件夹，悬停换成折叠三角（共用一格）；行尾 ＋ = 新建会话
 *       · 会话甲
 *
 * 三个要点：
 *   1. 「任务」底下是**任务默认工作区**（Host 把 `<tasksRoot>` 登记成了工作区）名下的
 *      会话：侧栏里不显示那个工作区，只画成「任务 + 按天」。它必须是真工作区——DSH 的
 *      对话框对空白会话要求「有工作区才有芯片」，芯片缺席时输入框会变成「选择工作区」，
 *      无主会话永远发不出第一句话（这就是 v0.3 的病根）。
 *   2. 两个 ＋ 各做一件事：任务组的 ＋ `connectWorkspace(taskWorkspaceId)`（DSH 原生，
 *      复用该工作区的空白会话或新建），工作区行尾的 ＋ 在那个工作区里新建会话；
 *      工作区组的 ＋ 添加工作区。
 *   3. 会话行首的状态点跟 DSH 自己的 StateDot 同一套语义与颜色令牌；
 *      图标一律走 DSH 图标集（`IconFolderClose/OpenRegular`、`IconTriangleRightFillRegular`），
 *      与内置侧栏同一套图形（拿不到时退回自带的同形 SVG）。**文件夹与折叠三角同一格换来换去**，
 *      绝不同时出现——那是重复的「可展开」语义。
 *
 * 数据：按天分组与工作区结构来自 Host（`/task-folders/api/state`）；会话标题来自客户端
 * `ctx.sessions.list` 快照（持久标题在 `projectionValues.title` / `title`；v0.12 起 Host 的
 * `sessionMeta.title` 兜住「指令开的会话」，`sessionMeta.activityAt` 兜住它们停摆的 updatedAt），
 * 运行/待确认/未读状态来自 `ctx.uiSession.sessionStatus`（拿不到就退回快照的 `running`）。
 * 任何取数失败只降级成一行提示，不白屏。
 *
 * v0.5 把内置侧栏原有、被整块接管后丢掉的三样补了回来（实现细节见各自注释）：
 *   1. **搜索**：标题右侧放大镜 / Ctrl(+⌘)+K → 本地按标题、工作区、id 命中，
 *      再叠 Host 的 `sessions.search()` 全文结果（带摘要片段）；
 *   2. **会话行「…」菜单**：归档会话 / 取消归档（`uiWorkspace.archiveSession`，
 *      原生没有物理删除）与复制 Session ID；
 *   3. **项目归档**：工作区行「…」→ 归档项目，收进底部「已归档项目」分组，可一键恢复；
 *      归档状态由 Host 记在它自己的 `projects.json` 里（不碰工作区登记）。
 *
 * v0.6 补上内置侧栏也没有的那一样：**删除会话**。原生只有归档，所以「删除」是插件自己
 * 在 Host 侧收走磁盘痕迹（默认移进回收站），客户端这里只负责两件事：菜单里一个
 * 用 error 令牌染色的「删除会话…」，以及原地换成的二次确认（取消 / 删除）。
 * 删成功后先把 id 记进本地的 `hiddenIds`，等 Host 的下一份状态追上再忘掉——
 * sessionQuery 的索引要一次 reconcile 才掉那条，这几秒里侧栏不该挂着点不开的行。
 *
 * v0.7 收两处侧栏几何：
 *   1. `.tsb-root` 补 `flex: 1 1 auto` 铺满 DSH 的 regionArea，行一律 `flex: 0 0 auto`
 *      不许压扁；弹出菜单改成量视口坐标 + `createPortal` 挂 body（fixed），
 *      否则侧栏区域一矮，菜单就在内容底边被当场裁掉；
 *   2. 一组会话超过 `SESSION_LIMIT`（10）条就折进「展开其余 N 个会话」，
 *      跑着 / 等回话的那几条无论如何都露脸。
 *
 * v0.10 给上级行补「下面有任务在跑」的标记：会话行的状态点只说这一条，
 * 折叠起来就看不见了。所以任务组 / 按天小标题 / 工作区组 / 工作区行 / 顶部「项目」
 * 各自往上汇总：只要子孙里有跑着或等回话的，就在行尾亮一个脉冲小圆环（多条带数量），
 * 悬停列出是哪几条；折叠状态照样看得见。
 *
 * v0.11 收顶部：「项目」那一行（含放大镜 / 视图选项 / 搜索框）不再跟着列表滚。
 * 照内置侧栏的几何拆两层——根收紧成 `overflow: hidden`，标题与搜索框进 `.tsb-top`
 * （`flex: 0 0 auto`），列表进 `.tsb-scroll`（`flex: 1 1 auto; min-height: 0;
 * overflow-y: auto`）。滚动只剩这一层，头部常驻；内置是 `.GAkraW_root → sectionHeader
 * + listArea/list`，同一套思路。
 *
 * v0.11.1 修「搜索框关不掉」：原来只有输入框里有词时才画一颗 ✕，而那颗 ✕ 只清词、不收框，
 * 于是空词状态下搜索框一露头就再也回不去（只剩一个没人知道的 Esc）。现在照内置侧栏补齐
 * 四条收起路径，全部走同一个 `closeSearch()`（清词 + 收框，缺一不可）：
 *   1. 放大镜再点一次 = 收起（开 / 关同一个入口）；
 *   2. 框尾那颗 ✕ **常显**（内置的 `clearButton` 也是展开就有），点了清词 + 收框；
 *   3. 点到头部以外（`.tsb-top` 之外）且还没输词，自动收起（内置的 document click）；
 *   4. 点开一条搜索结果就等于选完了：先收起再打开会话，侧栏立刻回到任务列表。
 *
 * v0.11.2 补内置侧栏的蓝色文件夹（`.wnFoaW_folderActive` → `--dsw-alias-state-business-primary`，
 * 即 deepseek-500 #4176e6）：**打开着的**文件夹是蓝的；收着、但里面正开着主视图那条会话的
 * 工作区也是蓝的（内置的祖先高亮）。「当前会话」照内置取 `sessions.list` 快照里
 * `retainedBy.mainView > 0` 的那一条，不另存状态——快照一变就跟着重画。
 *
 * v0.11.3 修「新会话没排在最上面」：DSH 的工作区成员表 `sessionIds` 是**登记顺序**
 * （`attachSession` 往数组头部 unshift），不是展示顺序。新会话确实在最前，可一条老会话
 * 被重新打开、跑完一轮之后，它在表里的位置并不动——于是「最近聊过的那条」埋在中间，
 * 而内置侧栏里它始终在最上面（内置用 `summary.updatedAt` 倒序）。现在工作区成员与
 * 搜索结果都照内置的 `orderByRecency` 口径重排：`updatedAt` 大的在前，相同（含拿不到，
 * 都记 0）时按 id 字符串兜底，保证顺序稳定、不抖动。
 *
 * v0.11.4 删除会话不再弹浮层：原来点「删除会话…」是菜单**原地换成一个 214px 的确认块**
 * （标题 + 一句说明 + 取消 / 删除），浮在行上、还带着红按钮——一下把人从列表里拽走，
 * 太突兀。现在统一改成**顶部提示条**（`.tsb-flash`，画在常驻头 `.tsb-top` 里，不随列表滚）：
 *   1. 点「删除会话…」＝ 菜单正常收起 + 顶部一行「删除这条会话？日志会移进回收站…」
 *      ＋「取消 / 删除」两颗按钮，取消或 Esc 都能撤；
 *   2. 删成功 / 复制 Session ID 的反馈也走同一条（4 秒后自己消失），不再丢在列表最底下
 *      那行灰字里——列表一长，那行根本滚不到。
 * 二次确认本身留着：删除是唯一动文件的动作，不该点一下就执行（只是换个不突兀的问法）。
 *
 * v0.12 修「指令开的会话」：DSH 的 `displayTitle` 在缺持久标题时会退回 **cwd 目录名**
 * （项目名），`updatedAt` 又只认 `user/message`（source.kind === 'user'）——用 `/goal`、
 * `/permission` 这类指令开的会话两样都拿不到，于是侧栏里标题变成项目名、时间停在创建时刻
 * （DSH 的「新建会话」还会复用几天前建的空壳会话，位置就更离谱）。现在：
 *   1. **标题**：只认持久标题（`projectionValues.title` / `title`）；`displayTitle` 只有在
 *      不是 cwd 目录名、也不是会话 id 时才当标题。其余按 Host 的指令文本提示 → 「未命名」
 *      兜底（空白会话仍是「新会话」）；
 *   2. **时间**：排序与行尾相对时间改用 Host 的 `sessionMeta[id].activityAt`（会话事件 +
 *      会话日志 mtime 算出来的真实活跃时间），与 DSH 快照的 `updatedAt` 取最大；
 *   3. **分组**：任务区按 Host 给的「最后活跃那天」分组（v0.12 起），不再按创建日。
 * 旧版 Host 没有 `sessionMeta` 时全部退回原行为，不会白屏。
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-folders',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * DSH 自己的图标集（平台共享模块表里的 `@deepseek-ai/dsh-client-ui-primitives`）：
     * 内置侧栏的「项目」行就是用它的 `IconFolderClose/OpenRegular` 画的文件夹图标，
     * 侧栏里换人做也该用同一套图形。
     *
     * 它是**可选**依赖：共享模块表随 DSH 版本变，`require` 失败在这里只会退回到自带的
     * 同形 SVG，绝不因为一个图标把整个客户端半侧吃掉（那会连槽位一起消失）。
     */
    const primitives = (() => {
      try {
        const module = require('@deepseek-ai/dsh-client-ui-primitives')
        return module !== null && typeof module === 'object' ? module : null
      } catch {
        return null
      }
    })()

    /**
     * `react-dom`：只为了 `createPortal`——弹出菜单要挂在 `document.body` 上。
     * 侧栏那块区域是 `overflow: hidden` + 自己再套一层滚动，菜单留在行里就会被
     * 区域的底边当场裁掉（视图选项打开就只剩两个半菜单项）。同样是可选依赖：
     * 拿不到就退回「贴在行里」的老画法，别为一个浮层把整个客户端半侧吃掉。
     */
    const reactDom = (() => {
      try {
        const module = require('react-dom')
        return module !== null && typeof module === 'object' ? module : null
      } catch {
        return null
      }
    })()

    /** 自带兜底的文件夹描边（16×16，与 DSH 图标集同形）：闭合 / 打开。 */
    const FOLDER_GLYPHS = {
      closed: ['M1.9 4.8c0-.5.4-.9.9-.9h2.7c.3 0 .58.15.75.4l.6.8h6.35c.5 0 .9.4.9.9v5.2c0 .5-.4.9-.9.9H2.8c-.5 0-.9-.4-.9-.9z'],
      open: [
        'M1.9 6.2V4.8c0-.5.4-.9.9-.9h2.7c.3 0 .58.15.75.4l.6.8h6.35c.5 0 .9.4.9.9v.2',
        'M1.9 6.2h12.2l-1.15 5.1c-.1.44-.5.75-.95.75H2.75a.83.83 0 0 1-.82-1z',
      ],
    }

    /**
     * 画一个文件夹图标：优先用 DSH 图标集（与内置侧栏同一套图形与线宽），
     * 拿不到就画自带的同形 SVG。
     * @param {{open?: boolean, size?: number, className?: string}} props - 是否展开 / 边长 / 附加类名。
     * @returns {object} React 元素。
     */
    function folderIcon(props) {
      const open = props?.open === true
      const size = typeof props?.size === 'number' ? props.size : 16
      const className = typeof props?.className === 'string' ? props.className : undefined
      const Icon = open ? primitives?.IconFolderOpenRegular : primitives?.IconFolderCloseRegular
      if (Icon !== undefined && Icon !== null) return h(Icon, { className, size })
      return h(
        'svg',
        {
          className,
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        (open ? FOLDER_GLYPHS.open : FOLDER_GLYPHS.closed).map((d, index) => h('path', { key: index, d })),
      )
    }

    /**
     * 折叠指示（`>`）：优先用 DSH 图标集里的 `IconTriangleRightFillRegular`。
     *
     * 名字叫 Fill，图形其实是一根 `strokeWidth: 1` 的细 chevron、默认 14px——内置侧栏
     * 工作区行用的就是它（展开时 `transform: rotate(90deg)` 变 `v`）。兜底也照这个画：
     * 描边 chevron，不是实心三角。
     *
     * 别再用文字 `▸`：9px 的字形摆在一个 14px 的图标旁边只剩一个小黑点，粗细也对不上。
     * @param {number} [size] - 边长，默认 14（DSH 图标集里的默认值）。
     * @returns {object} React 元素。
     */
    function triangleIcon(size = 14) {
      const Icon = primitives?.IconTriangleRightFillRegular
      if (Icon !== undefined && Icon !== null) return h(Icon, { size })
      return h(
        'svg',
        {
          className: 'tsb-chev-glyph',
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M6.3 4.4 10.6 8 6.3 11.6' }),
      )
    }

    /**
     * 放大镜（搜索入口）：优先用 DSH 图标集的 `IconSearchOutlineRegular`（内置侧栏的
     * 搜索按钮就是它），拿不到退回同形的描边圆 + 斜柄。
     * @param {number} [size] - 边长，默认 14（与内置侧栏一致）。
     * @returns {object} React 元素。
     */
    function searchIcon(size = 14) {
      const Icon = primitives?.IconSearchOutlineRegular
      if (Icon !== undefined && Icon !== null) return h(Icon, { size })
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('circle', { cx: 6.9, cy: 6.9, r: 4.3 }),
        h('path', { d: 'M10.1 10.1 13.2 13.2' }),
      )
    }

    /**
     * 行尾的「…」（更多操作菜单）：`IconEllipsisOutlineRegular` 优先，退回三个实心点。
     * @param {number} [size] - 边长，默认 14。
     * @returns {object} React 元素。
     */
    function ellipsisIcon(size = 14) {
      const Icon = primitives?.IconEllipsisOutlineRegular
      if (Icon !== undefined && Icon !== null) return h(Icon, { size })
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'currentColor',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('circle', { cx: 3.4, cy: 8, r: 1.15 }),
        h('circle', { cx: 8, cy: 8, r: 1.15 }),
        h('circle', { cx: 12.6, cy: 8, r: 1.15 }),
      )
    }

    /**
     * 铅笔（「编辑重发」的入口）：优先用 DSH 图标集的 `IconEditOutlineRegular`。
     *
     * 兜底照原图标画：一个右上角开口的方框（实心路径）+ 一根描边的笔杆，
     * 线宽 1、viewBox 16——和内置对话流的动作图标同一个视觉重量。
     * @param {number} [size] - 边长，默认 14（对话流里的动作图标就是 14-15）。
     * @returns {object} React 元素。
     */
    function editIcon(size = 14) {
      const Icon = primitives?.IconEditOutlineRegular
      if (Icon !== undefined && Icon !== null) return h(Icon, { size })
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z',
          fill: 'currentColor',
          stroke: 'none',
        }),
        h('path', { d: 'M7.7849 8.23878L13.888 2.13574' }),
      )
    }

    /** 词典命名空间。 */
    const NS = 'taskFolders'    /** 区域 id（样式与排查用）。 */
    const REGION_ID = 'task-folders'
    /** Host 路由前缀（相对页面 base）。 */
    const API_PREFIX = 'task-folders/api'
    /** 单次请求超时。 */
    const REQUEST_TIMEOUT_MS = 15_000
    /** 侧栏数据轮询间隔。 */
    const POLL_MS = 8_000
    /**
     * 一组会话默认最多铺开几条，其余折进「展开其余 N 个会话」。
     * 内置侧栏的 `SESSION_WATERMARK_BASE` 是 5（每个工作区 5 条），这里按任务区
     * 一天几十条的量放宽到 10：一屏之内看得完，再长就折起来。
     */
    const SESSION_LIMIT = 10
    /** 折起来也一定要露脸的状态：跑着的、等着你回话的，藏起来等于让人干等。 */
    const ATTENTION_STATES = new Set(['running', 'pending'])
    /** 弹出菜单的宽度（视图选项 / 会话「…」/ 工作区「…」都是同一档）。 */
    const MENU_WIDTH = 156

    const zh = {
      project: '项目',
      tasks: '任务',
      workspaces: '工作区',
      collapse: '收起',
      expand: '展开',
      newTask: '新建会话',
      newSessionIn: '在这个工作区里新建会话',
      newWorkspace: '添加工作区',
      today: '今天',
      yesterday: '昨天',
      noTask: '还没有会话，点 ＋ 直接开一个。',
      noWorkspace: '还没有工作区。',
      noSession: '还没有会话',
      sessionUntitled: '新会话',
      sessionUnnamed: '未命名',
      errorLoad: '侧栏数据读取失败',
      errorGeneric: '操作失败',
      errorOpen: '打不开会话',
      errorCreate: '当前 DSH 不能新建会话',
      errorStaleHost: '侧栏连的是旧版 Host：重启 DSH 后，任务才有一个默认工作区',
      canNotCreate: '当前 DSH 不能建工作区',
      // —— v0.5：搜索 / 会话归档 / 项目归档 ——
      search: '搜索会话',
      searchPlaceholder: '搜索会话名称',
      searchClear: '清除搜索',
      searchClose: '收起搜索',
      searchPending: '正在搜索会话历史…',
      searchEmpty: '无匹配会话',
      searchHasMore: '仅显示前 20 条结果，请缩小范围',
      viewOptions: '视图选项',
      filterHideArchived: '隐藏已归档',
      filterShowArchived: '全部对话（显示已归档）',
      filterOnlyArchived: '仅已归档',
      actions: '更多操作',
      archiveSession: '归档会话',
      unarchiveSession: '取消归档',
      archivedBadge: '已归档',
      copySessionId: '复制 Session ID',
      copied: 'Session ID 已复制',
      copyFailed: '复制失败',
      archiveFailed: '归档失败',
      archiveBusy: '这会话还在干活，先停下来再归档',
      // —— v0.6：删除会话（原生只有归档，删除是插件自己收走磁盘痕迹）——
      deleteSession: '删除会话…',
      deleteConfirmTitle: '删除这条会话？',
      deleteConfirmHint: '日志会移进回收站，侧栏里立刻消失。',
      deleteConfirmAction: '删除',
      deleteFailed: '删除失败',
      deleteBusy: '这会话还在干活，先停下来再删除',
      deleted: '会话已删除（在回收站里可找回）',
      cancel: '取消',
      archivedProjects: '已归档项目',
      archiveProject: '归档项目',
      restoreProject: '恢复项目',
      restore: '恢复',
      noArchivedSession: '没有已归档的会话',
      noArchivedProject: '没有归档的项目',
      // —— v0.7：一屏铺不完就折起来（与内置侧栏同一套说法与几何）——
      expandSessions: '展开其余 {n} 个会话',
      collapseSessions: '收起',
      // —— v0.8：设置 → 技能（列出官方 / 我的 / 项目 / 运行时，并管理用户自己的那份）——
      skillsNav: '技能',
      skillsTitle: '技能',
      skillsIntro:
        '这里能看到 DSH 当前加载的全部技能：官方随包提供的、你自己安装的、项目里的，以及运行时注册的。上传或新建的技能会写进下面的安装位置，保存后自动出现在下一次会话目录里。',
      skillsSearch: '搜索技能名称或描述',
      skillsAll: '全部',
      skillsOfficial: '官方内置',
      skillsUser: '我的技能',
      skillsProject: '项目',
      skillsRuntime: '运行时',
      skillsOther: '其他',
      skillsEmpty: '还没有技能。点「上传技能」把一个技能目录或 SKILL.md 放进来。',
      skillsFilterEmpty: '这个分类下没有技能。',
      skillsLoading: '正在读取技能…',
      skillsError: '技能读取失败',
      skillsRefresh: '刷新',
      skillsUpload: '上传技能',
      skillsNew: '新建技能',
      skillsUserRoot: '安装位置：{path}',
      skillsSourceUserDsh: 'DSH 用户目录',
      skillsSourceUserAgents: '共享 Agent 目录',
      skillsSourceCustom: '自定义目录',
      skillsSourceProjectDsh: '项目 .dsh',
      skillsSourceProjectAgents: '项目 .agents',
      skillsSourceBundled: '官方内置',
      skillsSourceRuntime: '运行时',
      skillsModelOnly: '仅模型',
      skillsUserOnly: '仅用户',
      skillsModelUser: '模型 + 用户',
      skillsDetail: '技能详情',
      skillsDetailLoading: '正在读取 SKILL.md…',
      skillsDetailError: '技能正文读取失败',
      skillsTruncated: '正文过长，只显示前 256 KB。',
      skillsDelete: '删除技能',
      skillsDeleteConfirm: '删除「{name}」？它会移进 task-folders/skill-trash，可以从磁盘找回。',
      skillsDeleted: '技能已删除（在 skill-trash 里可找回）',
      skillsDeleteFailed: '删除失败',
      skillsUploadTitle: '上传技能',
      skillsNewTitle: '新建技能',
      skillsUploadHint: '拖一个技能目录 / SKILL.md 到这里，或从磁盘选择',
      skillsChooseFolder: '选择技能目录',
      skillsChooseFiles: '选择文件',
      skillsDropHere: '松开即可读取',
      skillsFiles: '已选文件',
      skillsNoFiles: '还没有选择文件',
      skillsDetected: '识别到技能：{name}',
      skillsNotDetected: '没有找到 SKILL.md；上传单个 .md 时会按技能安装',
      skillsName: '技能名（kebab-case）',
      skillsNameHint: '小写字母、数字与连字符，例如 report-builder',
      skillsDescription: '一句话描述',
      skillsDescriptionHint: '模型靠它判断什么时候该用这个技能',
      skillsWhenToUse: '什么时候用（可选）',
      skillsBody: '技能正文（frontmatter 之后的部分）',
      skillsInstall: '安装',
      skillsInstalling: '安装中…',
      skillsInstalled: '技能「{name}」已安装',
      skillsInstallFailed: '安装失败',
      skillsExists: '同名技能已存在，覆盖安装？',
      skillsOverwrite: '覆盖安装',
      skillsClose: '关闭',
      skillsCancel: '取消',
      skillsTooLarge: '文件太大（单次最多 {size}）',
      skillsIncomplete: '有技能提供方没有读全，列表可能缺少条目。',
      skillsNoRegistry: '当前 DSH 没有技能注册表（dsh-skill 未加载）。',
      skillsRefreshFailed: '刷新失败',
      skillsPath: '路径',
      skillsInvocation: '调用方式',
      skillsNoDescription: '（没有描述）',
      skillsReading: '正在读取文件…',
      skillsHidden: '系统目录里的技能不在这里管理。',
      // —— v0.9：回合停止 / 失败之后，就地改这条消息再发一次 ——
      editResend: '编辑重发',
      editResendTitle: '就地编辑这条消息，改完重新发一次',
      editResendPlaceholder: '编辑这条消息',
      editResendSend: '重发',
      editResendHint: 'Enter 重发 · Shift+Enter 换行',
      editResendComposer: '用输入框改（可贴图）',
      // —— v0.10：上级行上的「下面有任务在跑」标记 ——
      runningBelow: '下面有 {n} 个任务在跑',
      waitingBelow: '下面有 {n} 个任务等你回话',
    }

    const en = {
      project: 'Project',
      tasks: 'Tasks',
      workspaces: 'Workspaces',
      collapse: 'Collapse',
      expand: 'Expand',
      newTask: 'New session',
      newSessionIn: 'New session in this workspace',
      newWorkspace: 'Add workspace',
      today: 'Today',
      yesterday: 'Yesterday',
      noTask: 'No session yet — press ＋.',
      noWorkspace: 'No workspace yet.',
      noSession: 'No session yet',
      sessionUntitled: 'New session',
      sessionUnnamed: 'Untitled',
      errorLoad: 'Could not read the sidebar data',
      errorGeneric: 'Operation failed',
      errorOpen: 'Could not open the session',
      errorCreate: 'This DSH cannot create a session',
      errorStaleHost: 'This sidebar is talking to an older Host; restart DSH so Tasks gets its default workspace',
      canNotCreate: 'This DSH cannot create a workspace',
      search: 'Search sessions',
      searchPlaceholder: 'Search session names',
      searchClear: 'Clear search',
      searchClose: 'Close search',
      searchPending: 'Searching session history…',
      searchEmpty: 'No matching sessions',
      searchHasMore: 'Showing the first 20 results; narrow the search',
      viewOptions: 'View options',
      filterHideArchived: 'Hide archived',
      filterShowArchived: 'All conversations (show archived)',
      filterOnlyArchived: 'Archived only',
      actions: 'More actions',
      archiveSession: 'Archive session',
      unarchiveSession: 'Unarchive session',
      archivedBadge: 'Archived',
      copySessionId: 'Copy Session ID',
      copied: 'Session ID copied',
      copyFailed: 'Copy failed',
      archiveFailed: 'Archive failed',
      archiveBusy: 'This session is still working; stop it before archiving',
      deleteSession: 'Delete session…',
      deleteConfirmTitle: 'Delete this session?',
      deleteConfirmHint: 'Its log moves to the recycle bin; the row disappears right away.',
      deleteConfirmAction: 'Delete',
      deleteFailed: 'Delete failed',
      deleteBusy: 'This session is still working; stop it before deleting',
      deleted: 'Session deleted (recoverable from the recycle bin)',
      cancel: 'Cancel',
      archivedProjects: 'Archived projects',
      archiveProject: 'Archive project',
      restoreProject: 'Restore project',
      restore: 'Restore',
      noArchivedSession: 'No archived sessions',
      noArchivedProject: 'No archived projects',
      expandSessions: 'Show {n} more sessions',
      collapseSessions: 'Show less',
      skillsNav: 'Skills',
      skillsTitle: 'Skills',
      skillsIntro:
        'Every skill DSH currently loads is listed here: the official bundle, your own installs, project skills, and runtime registrations. Uploaded or newly created skills are written to the install location below and show up in the next session catalog.',
      skillsSearch: 'Search skill names or descriptions',
      skillsAll: 'All',
      skillsOfficial: 'Official',
      skillsUser: 'Mine',
      skillsProject: 'Project',
      skillsRuntime: 'Runtime',
      skillsOther: 'Other',
      skillsEmpty: 'No skills yet. Use “Upload skill” to add a skill folder or a SKILL.md.',
      skillsFilterEmpty: 'No skills in this category.',
      skillsLoading: 'Reading skills…',
      skillsError: 'Could not read skills',
      skillsRefresh: 'Refresh',
      skillsUpload: 'Upload skill',
      skillsNew: 'New skill',
      skillsUserRoot: 'Installed at: {path}',
      skillsSourceUserDsh: 'DSH user folder',
      skillsSourceUserAgents: 'Shared agent folder',
      skillsSourceCustom: 'Custom folder',
      skillsSourceProjectDsh: 'Project .dsh',
      skillsSourceProjectAgents: 'Project .agents',
      skillsSourceBundled: 'Official',
      skillsSourceRuntime: 'Runtime',
      skillsModelOnly: 'Model only',
      skillsUserOnly: 'User only',
      skillsModelUser: 'Model + user',
      skillsDetail: 'Skill details',
      skillsDetailLoading: 'Reading SKILL.md…',
      skillsDetailError: 'Could not read the skill body',
      skillsTruncated: 'The body is too long; only the first 256 KB is shown.',
      skillsDelete: 'Delete skill',
      skillsDeleteConfirm: 'Delete “{name}”? It moves to task-folders/skill-trash and can be recovered from disk.',
      skillsDeleted: 'Skill deleted (recover it from skill-trash)',
      skillsDeleteFailed: 'Delete failed',
      skillsUploadTitle: 'Upload skill',
      skillsNewTitle: 'New skill',
      skillsUploadHint: 'Drop a skill folder / SKILL.md here, or pick from disk',
      skillsChooseFolder: 'Choose folder',
      skillsChooseFiles: 'Choose files',
      skillsDropHere: 'Release to read',
      skillsFiles: 'Selected files',
      skillsNoFiles: 'No files selected yet',
      skillsDetected: 'Detected skill: {name}',
      skillsNotDetected: 'No SKILL.md found; a single .md upload is installed as a skill',
      skillsName: 'Skill name (kebab-case)',
      skillsNameHint: 'Lowercase letters, digits and hyphens, e.g. report-builder',
      skillsDescription: 'One-line description',
      skillsDescriptionHint: 'The model uses it to decide when to load this skill',
      skillsWhenToUse: 'When to use (optional)',
      skillsBody: 'Skill body (everything after the frontmatter)',
      skillsInstall: 'Install',
      skillsInstalling: 'Installing…',
      skillsInstalled: 'Skill “{name}” installed',
      skillsInstallFailed: 'Install failed',
      skillsExists: 'A skill with that name already exists. Overwrite it?',
      skillsOverwrite: 'Overwrite',
      skillsClose: 'Close',
      skillsCancel: 'Cancel',
      skillsTooLarge: 'Files too large (up to {size} per install)',
      skillsIncomplete: 'A skill provider did not finish reading; the list may be missing entries.',
      skillsNoRegistry: 'This DSH has no skill registry (dsh-skill is not loaded).',
      skillsRefreshFailed: 'Refresh failed',
      skillsPath: 'Path',
      skillsInvocation: 'Invocation',
      skillsNoDescription: '(no description)',
      skillsReading: 'Reading files…',
      skillsHidden: 'Skills in the system folder are not managed here.',
      // —— v0.9: edit this message in place and send it again ——
      editResend: 'Edit & resend',
      editResendTitle: 'Edit this message in place, then send it again',
      editResendPlaceholder: 'Edit this message',
      editResendSend: 'Resend',
      editResendHint: 'Enter to resend · Shift+Enter for a new line',
      editResendComposer: 'Edit in the composer (paste images)',
      // —— v0.10: "a task below is running" marks on ancestor rows ——
      runningBelow: '{n} running below',
      waitingBelow: '{n} waiting for you below',
    }

    /**
     * 比着 DSH 侧栏的令牌与几何写的样式表：
     * 行高 26-32 / 字号 12-14 / 次要信息 11-12 / 圆角 6 / hover 用 `--dsw-alias-interactive-bg-hover`。
     * 状态点与 DSH 的 StateDot 同色：运行/有新结果 = success，待确认 = warn，空闲 = idle。
     *
     * 缩进只有一列台阶，量出来的（都算上 `.tsb-root` 的 6px 左内边距）：
     *   「项目」标题、任务 / 工作区组标题    8px   ← 目录层级的最外层，往左顶
     *   按天小标题、工作区行（文件夹）      16px   ← 组标题的子项，右移一格
     *   任务区里的会话                      26px
     *   工作区里的会话                      34px
     * 原来标题和子项都落在 14px，左边缘齐平，层级读不出来——这一步就是把它拉开。
     */
    const CSS = `
 .tsb-root {
   display: flex;
   flex-direction: column;
   gap: 2px;
   /* 铺满 DSH 给的侧栏区域（regionArea 是 flex:1 的列）。
      少这一行，插件的高度就只有内容那么高：全折叠起来时区域被挤成三行，
      连视图选项的弹出菜单都被内容底边当场切掉。 */
   flex: 1 1 auto;
   min-height: 0;
   /* 底距留给下面的滚动区，免得最后一行贴着区域底边 */
   padding: 2px 6px 0;
   /* 自己不再滚：滚动归 .tsb-scroll。这样「项目」标题与搜索框留在滚动之外，
       跟内置侧栏的 sectionHeader / list 同一个几何（标题常驻，列表自滚）。 */
   overflow: hidden;
   color: var(--dsw-alias-label-primary);
 }
 /* 常驻头：标题 + 展开时的搜索框。不许被压扁、不参与滚动。 */
 .tsb-top {
   flex: 0 0 auto;
   display: flex;
   flex-direction: column;
   gap: 2px;
 }
 /* 唯一的那层滚动：任务按天 / 工作区 / 归档组 / 提示都在这下面滚。 */
 .tsb-scroll {
   flex: 1 1 auto;
   min-height: 0;
   display: flex;
   flex-direction: column;
   gap: 2px;
   overflow-y: auto;
   overflow-x: hidden;
   padding-bottom: 6px;
 }
 .tsb-caption {
   display: flex;
   align-items: center;
   gap: 6px;
   /* 行不许被压扁：内容超出时该滚动，不是把每一行挤成一条 */
   flex: 0 0 auto;
   padding: 2px 8px 4px 2px;
   font-size: 12px;
   line-height: 17px;
   color: var(--dsw-alias-label-tertiary);
   user-select: none;
 }
 .tsb-caption-icon { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
 .tsb-folder {
   flex: 0 0 auto;
   display: inline-flex;
   align-items: center;
   justify-content: center;
   width: 16px;
   height: 20px;
   color: var(--dsw-alias-label-tertiary);
 }
 .tsb-row.is-open .tsb-folder,
 .tsb-row.is-open .tsb-chev { color: var(--dsw-alias-label-secondary); }
 /* 打开着的文件夹是蓝的：内置侧栏那枚 .wnFoaW_folderActive 就是这一句
    （color: var(--dsw-alias-state-business-primary)，即 deepseek-500）。
    选择器带上 .tsb-row（0,3,0），才压得过上面那条 .tsb-row.is-open .tsb-folder。 */
 .tsb-row .tsb-folder.is-active { color: var(--dsw-alias-state-business-primary); }
 .tsb-group {
   display: flex;
   align-items: center;
   gap: 2px;
   flex: 0 0 auto;
   height: 28px;
   padding: 0 8px 0 2px;
   border-radius: var(--dsw-radius-sm);
 }
 .tsb-group:hover { background: var(--dsw-alias-interactive-bg-hover); }
 .tsb-head {
   flex: 1 1 auto;
   min-width: 0;
   display: flex;
   align-items: center;
   gap: 6px;
   height: 100%;
   padding: 0;
   border: 0;
   background: transparent;
   color: var(--dsw-alias-label-secondary);
   font-size: 12px;
   line-height: 17px;
   font-weight: 500;
   text-align: left;
   cursor: pointer;
 }
 .tsb-chev {
   flex: 0 0 auto;
   width: 16px;
   height: 20px;
   display: inline-flex;
   align-items: center;
   justify-content: center;
   color: var(--dsw-alias-label-caption);
   transition: transform .15s ease;
 }
 .tsb-chev.is-open { transform: rotate(90deg); }
 /* 工作区行的「文件夹」与「折叠三角」共用一格：平时画文件夹，鼠标进来 / 键盘聚焦换成三角。
    两个同时出现是重复的「可展开」语义，DSH 内置的工作区行也是这么换的；颜色取同一级灰，
    换的时候不会闪一下深浅。 */
 .tsb-row .tsb-chev { display: none; color: var(--dsw-alias-label-tertiary); }
 .tsb-row:hover .tsb-chev,
 .tsb-row:focus-within .tsb-chev { display: inline-flex; }
 .tsb-row:hover .tsb-folder,
 .tsb-row:focus-within .tsb-folder { display: none; }
 .tsb-head-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
 .tsb-count { flex: 0 0 auto; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
 .tsb-add {
   flex: 0 0 auto;
   width: 20px;
   height: 20px;
   display: inline-flex;
   align-items: center;
   justify-content: center;
   border: 0;
   border-radius: var(--dsw-radius-sm);
   background: transparent;
   color: var(--dsw-alias-label-caption);
   font-size: 14px;
   line-height: 1;
   cursor: pointer;
   opacity: .6;
 }
 .tsb-group:hover .tsb-add,
 .tsb-add:focus-visible { opacity: 1; }
 .tsb-add:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
 .tsb-add:disabled { opacity: .35; cursor: default; }
 .tsb-rows { display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }
 .tsb-row {
   display: flex;
   align-items: center;
   gap: 6px;
   flex: 0 0 auto;
   height: 32px;
   padding: 0 8px 0 var(--tsb-indent, 10px);
   border-radius: var(--dsw-radius-md);
   cursor: pointer;
   user-select: none;
   position: relative;
 }
 .tsb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
 .tsb-row.is-open { background: var(--dsw-alias-interactive-bg-hover); }
 .tsb-row-main {
   flex: 1 1 auto;
   min-width: 0;
   display: flex;
   align-items: center;
   gap: 6px;
   height: 100%;
   padding: 0;
   border: 0;
   background: transparent;
   color: inherit;
   font-size: 14px;
   line-height: 20px;
   text-align: left;
   cursor: pointer;
 }
 .tsb-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
 .tsb-meta { flex: 0 0 auto; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
 .tsb-day {
   display: flex;
   align-items: center;
   gap: 4px;
   flex: 0 0 auto;
   padding: 4px 8px 2px var(--tsb-indent, 10px);
   font-size: 11px;
   line-height: 15px;
   color: var(--dsw-alias-label-tertiary);
   user-select: none;
 }
 /* 「展开其余 N 个会话 / 收起」：几何照抄内置侧栏的 sessionOverflowButton
    （28px 高、左内边距对齐会话行标题、12px 字、tertiary→secondary 的 hover）。 */
 .tsb-more-sessions {
   flex: 0 0 auto;
   height: 28px;
   /* 14px = 会话行里「状态点 8 + 间隙 6」，这样折起来那行字正好落在上面会话标题的竖线上 */
   padding: 0 12px 0 calc(14px + var(--tsb-indent, 10px));
   border: 0;
   border-radius: var(--dsw-radius-md);
   background: transparent;
   color: var(--dsw-alias-label-tertiary);
   font-size: 12px;
   line-height: 17px;
   text-align: left;
   cursor: pointer;
 }
 .tsb-more-sessions:hover { color: var(--dsw-alias-label-secondary); }
 .tsb-dot {
   flex: 0 0 auto;
   position: relative;
   display: inline-block;
   width: 8px;
   height: 8px;
   border-radius: 50%;
   background: currentColor;
 }
 .tsb-dot[data-state="running"],
 .tsb-dot[data-state="done"] { color: var(--dsw-alias-state-success-primary); }
 .tsb-dot[data-state="pending"] { color: var(--dsw-alias-state-warn-primary); }
 .tsb-dot[data-state="idle"] { color: var(--dsw-alias-state-idle-primary); }
 .tsb-dot[data-state="running"] { animation: tsb-pulse 1.6s ease-in-out infinite; }
 @keyframes tsb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
 @media (prefers-reduced-motion: reduce) {
   .tsb-dot[data-state="running"] { animation: none; }
 }
 /* —— v0.10：上级行的「下面有任务在跑」标记 ——
    做成胶囊徽标：success-tertiary 底色 + 实心点 + 常显数字。
    只画一个 8px 空心环时着色面积太小，远看像标题旁的小写 o；胶囊把色块与数量一起摆出来，
    浅色/深色各用主题里的 tertiary 底，数字走 label-primary（success 色写小字对比不够）。
    等回话时整枚换成 warn 色系；窄条（rail）位置不够，退回一个不带底色的实心点。 */
 .tsb-runmark {
   flex: 0 0 auto;
   display: inline-flex;
   align-items: center;
   gap: 4px;
   box-sizing: border-box;
   height: 18px;
   padding: 0 6px 0 5px;
   border-radius: 999px;
   background: var(--dsw-alias-state-success-tertiary, var(--dsw-alias-bg-layer-2));
   color: var(--dsw-alias-label-primary);
   font-size: 11px;
   line-height: 18px;
   font-weight: 500;
   font-variant-numeric: tabular-nums;
 }
 .tsb-runmark::before {
   content: '';
   display: inline-block;
   flex: 0 0 auto;
   width: 7px;
   height: 7px;
   border-radius: 50%;
   background: var(--dsw-alias-state-success-primary);
   animation: tsb-pulse 1.6s ease-in-out infinite;
 }
 .tsb-runmark[data-state="pending"] {
   background: var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-bg-layer-2));
 }
 .tsb-runmark[data-state="pending"]::before {
   background: var(--dsw-alias-state-warn-primary);
   animation: none;
 }
 .tsb-runmark-count { flex: 0 0 auto; }
 /* 窄条：只留一颗点，不占胶囊的宽度 */
 .tsb-runmark.is-dot {
   width: 8px;
   height: 8px;
   padding: 0;
   border-radius: 50%;
   background: transparent;
 }
 .tsb-runmark.is-dot::before { width: 8px; height: 8px; }
 .tsb-day .tsb-runmark { height: 16px; padding: 0 5px 0 4px; font-size: 10px; line-height: 16px; }
 .tsb-day .tsb-runmark::before { width: 6px; height: 6px; }
 .tsb-day .tsb-runmark.is-dot { width: 8px; height: 8px; padding: 0; }
 .tsb-rail .tsb-runmark.is-dot { width: 8px; height: 8px; }
 @media (prefers-reduced-motion: reduce) {
   .tsb-runmark::before { animation: none; }
 }
 .tsb-notice {
   flex: 0 0 auto;
   padding: 2px 8px 4px 24px;
   font-size: 12px;
   line-height: 17px;
   color: var(--dsw-alias-label-tertiary);
 }
 .tsb-notice.is-error { color: var(--dsw-alias-state-error-primary); }
 .tsb-head:focus,
 .tsb-row-main:focus { outline: none; }
 .tsb-head:focus-visible,
 .tsb-row-main:focus-visible {
   outline: none;
   box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2);
   border-radius: inherit;
 }
 .tsb-rail { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 6px 0; }
 .tsb-rail .tsb-add { opacity: 1; }
 /* —— v0.5：标题右侧的搜索 / 视图选项 —— */
 .tsb-header-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; position: relative; }
 .tsb-icon {
   width: 20px;
   height: 20px;
   display: inline-flex;
   align-items: center;
   justify-content: center;
   padding: 0;
   border: 0;
   border-radius: var(--dsw-radius-sm);
   background: transparent;
   color: var(--dsw-alias-label-tertiary);
   cursor: pointer;
 }
 .tsb-icon:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
 /* 搜索开着时放大镜常亮：它此刻就是「收起」按钮，得看得出自己按下去过（与 hover 同一层底色）。 */
 .tsb-icon.is-active { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
 .tsb-search {
   display: flex;
   align-items: center;
   gap: 6px;
   flex: 0 0 auto;
   height: 28px;
   margin: 0 2px 4px;
   padding: 0 6px;
   border: 1px solid var(--dsw-alias-border-l1);
   border-radius: var(--dsw-radius-md);
   background: var(--dsw-alias-bg-layer-2);
   color: var(--dsw-alias-label-tertiary);
 }
 .tsb-search-input {
   flex: 1 1 auto;
   min-width: 0;
   border: 0;
   background: transparent;
   color: var(--dsw-alias-label-primary);
   font-size: 12px;
   line-height: 17px;
   outline: none;
 }
 .tsb-search-input::placeholder { color: var(--dsw-alias-label-tertiary); }
 /* 框尾那颗 ✕：常显，靠右；字比图标小一号，视觉重量跟放大镜一致。 */
 .tsb-search-close { flex: 0 0 auto; font-size: 12px; line-height: 1; }
 .tsb-search-status { padding: 2px 8px 4px 24px; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
 /* 会话行尾的「…」：平时不占位，鼠标进来 / 菜单开着才出现（与内置侧栏的行操作一致）。 */
 .tsb-more {
   flex: 0 0 auto;
   width: 18px;
   height: 18px;
   display: none;
   align-items: center;
   justify-content: center;
   padding: 0;
   border: 0;
   border-radius: var(--dsw-radius-sm);
   background: transparent;
   color: var(--dsw-alias-label-tertiary);
   cursor: pointer;
 }
 .tsb-row:hover .tsb-more,
 .tsb-row:focus-within .tsb-more,
 .tsb-row.is-menu-open .tsb-more { display: inline-flex; }
 .tsb-more:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
 /* 弹出菜单：浮在最上层，圆角 / 分隔 / 阴影都走令牌与 DSH 的 overlay 底色。 */
 .tsb-menu {
   position: absolute;
   z-index: 40;
   top: calc(100% - 2px);
   right: 4px;
   min-width: 156px;
   display: flex;
   flex-direction: column;
   gap: 1px;
   padding: 4px;
   border: 1px solid var(--dsw-alias-border-l1);
   border-radius: var(--dsw-radius-md);
   background: var(--dsw-alias-bg-overlay);
   box-shadow: 0 8px 24px var(--dsw-alias-border-l1);
 }
 .tsb-menu-item {
   display: flex;
   align-items: center;
   gap: 6px;
   height: 28px;
   padding: 0 8px;
   border: 0;
   border-radius: var(--dsw-radius-sm);
   background: transparent;
   color: var(--dsw-alias-label-primary);
   font-size: 12px;
   line-height: 17px;
   text-align: left;
   cursor: pointer;
   white-space: nowrap;
 }
 .tsb-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
 /* 破坏性操作（删除会话）用 error 令牌染字，与 DSH 自己的危险动作同色。 */
 .tsb-menu-item.is-danger { color: var(--dsw-alias-state-error-primary); }
 .tsb-menu-check { width: 10px; color: var(--dsw-alias-brand-primary); }
 /* 顶部提示条：删除会话的二次确认与「已删除 / 已复制」的反馈都画在这一条里。
    它挂在常驻头 .tsb-top 上，不随列表滚——列表一长，丢在列表最底下的提示根本没人看见；
    而原来那个「菜单原地换成确认块」的浮层太突兀，一下把人从行上拽走。 */
 .tsb-flash {
   flex: 0 0 auto;
   display: flex;
   align-items: center;
   gap: 8px;
   margin: 0 0 2px;
   padding: 6px 8px;
   border: 1px solid var(--dsw-alias-border-l1);
   border-radius: var(--dsw-radius-sm);
   background: var(--dsw-alias-bg-layer-2);
   color: var(--dsw-alias-label-secondary);
   font-size: 12px;
   line-height: 17px;
 }
 .tsb-flash.is-error { color: var(--dsw-alias-state-error-primary); }
 .tsb-flash.is-ok { color: var(--dsw-alias-state-success-primary); }
 .tsb-flash-text { flex: 1 1 auto; min-width: 0; }
 .tsb-flash-title { color: var(--dsw-alias-label-primary); font-weight: 600; }
 .tsb-flash-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; }
 .tsb-flash-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
 .tsb-flash-btn {
   height: 24px;
   padding: 0 10px;
   border: 1px solid var(--dsw-alias-border-l1);
   border-radius: var(--dsw-radius-sm);
   background: transparent;
   color: var(--dsw-alias-label-primary);
   font-size: 12px;
   line-height: 22px;
   cursor: pointer;
 }
 .tsb-flash-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
 .tsb-flash-btn.is-danger {
   border-color: var(--dsw-alias-state-error-primary);
   color: var(--dsw-alias-state-error-primary);
 }
 .tsb-badge {
   flex: 0 0 auto;
   padding: 0 5px;
   border-radius: 4px;
   background: var(--dsw-alias-bg-layer-2);
   color: var(--dsw-alias-label-tertiary);
   font-size: 10px;
   line-height: 16px;
 }
 .tsb-row.is-archived .tsb-title { color: var(--dsw-alias-label-secondary); }
 /* 搜索结果一行：标题 + 工作区 / 摘要片段（与内置侧栏的搜索结果同构）。 */
 .tsb-result {
   display: flex;
   flex-direction: column;
   gap: 1px;
   width: 100%;
   flex: 0 0 auto;
   padding: 4px 8px 4px var(--tsb-indent, 10px);
   border: 0;
   border-radius: var(--dsw-radius-md);
   background: transparent;
   color: var(--dsw-alias-label-primary);
   text-align: left;
   cursor: pointer;
 }
 .tsb-result:hover { background: var(--dsw-alias-interactive-bg-hover); }
 /* 结果行里的主按钮是两层 flex 里的一层：行高交给外面那行决定。 */
 .tsb-result .tsb-row-main { height: auto; }
 .tsb-result-meta {
   display: flex;
   align-items: center;
   gap: 6px;
   min-width: 0;
   margin-left: 14px;
   font-size: 11px;
   line-height: 15px;
   color: var(--dsw-alias-label-tertiary);
 }
 .tsb-result-workspace { flex: 0 0 auto; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
 .tsb-result-snippet {
   flex: 1 1 auto;
   min-width: 0;
   overflow: hidden;
   text-overflow: ellipsis;
   white-space: nowrap;
   color: var(--dsw-alias-label-secondary);
 }
 .tsb-restore { flex: 0 0 auto; height: 20px; padding: 0 6px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 17px; cursor: pointer; opacity: .7; }
 .tsb-row:hover .tsb-restore { opacity: 1; }
 .tsb-restore:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

 /* ---- 设置 → 技能（v0.8）：照设置页自己的尺度：18px 标题、13px 正文、760px 列宽 ---- */
 .tsk-section { display: flex; flex-direction: column; gap: 12px; max-width: 760px; color: var(--dsw-alias-label-primary); }
 .tsk-heading { margin: 0; font-size: 18px; font-weight: 600; line-height: 26px; }
 .tsk-intro { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
 .tsk-toolbar { display: flex; align-items: center; gap: 8px; }
 .tsk-search {
   flex: 1 1 auto;
   min-width: 0;
   height: 30px;
   padding: 0 10px 0 28px;
   border: .5px solid var(--dsw-alias-border-l2);
   border-radius: var(--dsw-radius-sm);
   background-color: var(--dsw-alias-bg-layer-1);
   background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23888' stroke-width='1.2'%3E%3Ccircle cx='7' cy='7' r='4.3'/%3E%3Cpath d='M10.2 10.2 14 14'/%3E%3C/svg%3E");
   background-repeat: no-repeat;
   background-position: 9px center;
   background-size: 14px 14px;
   color: var(--dsw-alias-label-primary);
   font: inherit;
   font-size: 13px;
 }
 .tsk-search::placeholder { color: var(--dsw-alias-label-tertiary); }
 .tsk-search:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 1px; }
 .tsk-btn {
   flex: 0 0 auto;
   height: 28px;
   padding: 0 10px;
   border: .5px solid var(--dsw-alias-border-l2);
   border-radius: var(--dsw-radius-sm);
   background: var(--dsw-alias-bg-layer-1);
   color: var(--dsw-alias-label-primary);
   font: inherit;
   font-size: 12px;
   line-height: 26px;
   cursor: pointer;
 }
 .tsk-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
 .tsk-btn[disabled] { cursor: default; opacity: .5; }
 /* 主按钮：填充色与前景色都走 DSH 自己的按钮令牌。深色主题下 brand-primary 是近白，
    写死 color:#fff 会把字吃掉——label-primary-foreground 正好是它的反色（浅色主题白字、深色主题黑字）。 */
 .tsk-btn.is-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-primary-foreground, #fff); }
 .tsk-btn.is-primary:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
 .tsk-btn.is-danger { color: var(--dsw-alias-state-error-primary); }
 .tsk-tabs { display: flex; align-items: flex-end; gap: 20px; border-bottom: .5px solid var(--dsw-alias-border-l2); margin-top: 2px; }
 .tsk-tab {
   position: relative;
   padding: 7px 1px 9px;
   border: 0;
   background: transparent;
   color: var(--dsw-alias-label-tertiary);
   font: inherit;
   font-size: 13px;
   line-height: 20px;
   cursor: pointer;
 }
 .tsk-tab:hover, .tsk-tab[data-active='true'] { color: var(--dsw-alias-label-primary); }
 .tsk-tab[data-active='true']::after {
   content: '';
   position: absolute;
   left: 0;
   right: 0;
   bottom: -1px;
   height: 2px;
   border-radius: 2px 2px 0 0;
   background: var(--dsw-alias-label-primary);
 }
 .tsk-tab:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 2px; border-radius: 2px; }
 .tsk-tab-count { margin-left: 5px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
 .tsk-list { display: flex; flex-direction: column; padding: 2px 0; }
 .tsk-row {
   display: flex;
   flex-direction: column;
   gap: 3px;
   width: 100%;
   padding: 9px 8px;
   border: 0;
   border-bottom: .5px solid var(--dsw-alias-border-l1);
   border-radius: var(--dsw-radius-md);
   background: transparent;
   color: inherit;
   text-align: left;
   font: inherit;
   cursor: pointer;
 }
 .tsk-row:hover { background: var(--dsw-alias-bg-layer-2); }
 .tsk-row:last-child { border-bottom: 0; }
 .tsk-row-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
 .tsk-name { flex: 0 0 auto; font-size: 13px; font-weight: 600; line-height: 19px; }
 .tsk-badge {
   flex: 0 0 auto;
   padding: 1px 6px;
   border-radius: 4px;
   background: var(--dsw-alias-bg-layer-2);
   color: var(--dsw-alias-label-secondary);
   font-size: 11px;
   line-height: 16px;
 }
 .tsk-badge.is-official { color: var(--dsw-alias-brand-primary); }
 .tsk-desc {
   margin: 0;
   display: -webkit-box;
   -webkit-box-orient: vertical;
   -webkit-line-clamp: 2;
   overflow: hidden;
   color: var(--dsw-alias-label-secondary);
   font-size: 12px;
   line-height: 18px;
 }
 .tsk-path {
   margin: 1px 0 0;
   overflow: hidden;
   text-overflow: ellipsis;
   white-space: nowrap;
   color: var(--dsw-alias-label-tertiary);
   font-size: 11px;
   line-height: 15px;
 }
 .tsk-empty { padding: 18px 8px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
 .tsk-notice { padding: 6px 10px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
 .tsk-notice.is-error { color: var(--dsw-alias-state-error-primary); }
 .tsk-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
 .tsk-overlay {
   position: fixed;
   inset: 0;
   z-index: 1100;
   display: flex;
   align-items: center;
   justify-content: center;
   padding: 20px;
   background: rgba(0, 0, 0, .34);
 }
 .tsk-modal {
   display: flex;
   flex-direction: column;
   width: min(720px, 100%);
   max-height: min(82vh, 900px);
   overflow: hidden;
   border: .5px solid var(--dsw-alias-border-l2);
   border-radius: 12px;
   background: var(--dsw-alias-bg-overlay);
   box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
 }
 .tsk-modal-head { display: flex; align-items: center; gap: 8px; padding: 13px 18px; border-bottom: .5px solid var(--dsw-alias-border-l1); }
 .tsk-modal-title { flex: 1 1 auto; margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
 .tsk-modal-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
 .tsk-modal-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 11px 18px; border-top: .5px solid var(--dsw-alias-border-l1); }
 .tsk-modal-foot .tsk-hint { flex: 1 1 auto; }
 .tsk-field { display: flex; flex-direction: column; gap: 4px; }
 .tsk-label { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
 .tsk-input, .tsk-textarea {
   width: 100%;
   box-sizing: border-box;
   padding: 7px 9px;
   border: .5px solid var(--dsw-alias-border-l2);
   border-radius: var(--dsw-radius-sm);
   background: var(--dsw-alias-bg-layer-1);
   color: var(--dsw-alias-label-primary);
   font: inherit;
   font-size: 13px;
   line-height: 19px;
 }
 .tsk-textarea { min-height: 130px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 18px; }
 .tsk-input:focus-visible, .tsk-textarea:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 1px; }
 .tsk-drop {
   display: flex;
   flex-direction: column;
   align-items: center;
   gap: 4px;
   padding: 20px 14px;
   border: 1px dashed var(--dsw-alias-border-l2);
   border-radius: 8px;
   background: var(--dsw-alias-bg-layer-1);
   color: var(--dsw-alias-label-secondary);
   font-size: 12px;
   line-height: 18px;
   text-align: center;
 }
 .tsk-drop.is-over { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
 .tsk-files { display: flex; flex-direction: column; gap: 2px; max-height: 160px; overflow: auto; padding: 2px 0; }
 .tsk-file { display: flex; gap: 8px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 17px; }
 .tsk-file-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
 .tsk-file-size { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
 .tsk-content {
   margin: 0;
   max-height: 46vh;
   overflow: auto;
   padding: 10px;
   border: .5px solid var(--dsw-alias-border-l1);
   border-radius: var(--dsw-radius-sm);
   background: var(--dsw-alias-bg-layer-1);
   color: var(--dsw-alias-label-primary);
   white-space: pre-wrap;
   word-break: break-word;
   font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
   font-size: 12px;
   line-height: 18px;
 }
 /* —— v0.9：回合停止 / 失败后的「编辑重发」 ——
    编辑时不是塞回底部输入框，而是**就地**把这条用户气泡换成编辑框：
    给流节点打上 data-tsr-editing，把原生行藏起来，编辑框 portal 进同一个流节点，
    右对齐、宽度跟气泡一样（ui-chat 的 userStack 是 70.2% / 最多 82%）。 */
 /* 原生行的槽包裹层带内联 display:contents，必须 !important 才压得住。 */
 [data-slot="conversation.chat.flow"] [data-tsr-editing="true"] > :not(.tsr-editor) {
   display: none !important;
 }
 .tsr-host { display: none; }
 /* 动作行里那颗铅笔（复制旁边）：几何照抄 ui-chat 的 MessageIconActions。 */
 .tsr-action {
   width: calc(28px + var(--dsh-content-font-delta, 0px));
   height: calc(28px + var(--dsh-content-font-delta, 0px));
   display: inline-flex;
   align-items: center;
   justify-content: center;
   padding: 6px;
   border: none;
   border-radius: var(--dsw-radius-sm);
   background: 0 0;
   color: var(--dsw-alias-label-tertiary);
   cursor: pointer;
 }
 .tsr-action svg {
   width: calc(15px + var(--dsh-content-font-delta, 0px));
   height: calc(15px + var(--dsh-content-font-delta, 0px));
 }
 .tsr-action:hover {
   background: var(--dsw-alias-interactive-bg-hover);
   color: var(--dsw-alias-label-secondary);
 }
 .tsr-action:focus-visible {
   outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
   outline-offset: 1px;
 }
 /* 就地编辑框：底色/圆角/宽度都跟用户气泡一致，字也一样大。 */
 .tsr-editor {
   display: flex;
   flex-direction: column;
   gap: 6px;
   box-sizing: border-box;
   width: min(calc(var(--dsh-chat-content-width, 748px) * .702), 82%);
   margin-left: auto;
   padding: 8px 10px 8px 12px;
   border: .5px solid var(--dsw-alias-border-l2);
   border-radius: var(--dsw-radius-xl);
   background: var(--dsw-specific-bubble);
 }
 .tsr-editor-input {
   box-sizing: border-box;
   width: 100%;
   min-height: 44px;
   max-height: 320px;
   padding: 2px 4px;
   border: none;
   outline: none;
   background: transparent;
   color: var(--dsw-alias-label-primary);
   font: inherit;
   font-size: var(--dsh-content-font-size, 14px);
   line-height: calc(22px + var(--dsh-content-font-delta, 0px));
   resize: none;
   overflow-y: auto;
 }
 .tsr-editor-input::placeholder { color: var(--dsw-alias-label-tertiary); }
 .tsr-editor-foot { display: flex; align-items: center; gap: 8px; min-width: 0; }
 .tsr-editor-hint {
   flex: 0 1 auto;
   min-width: 0;
   overflow: hidden;
   color: var(--dsw-alias-label-tertiary);
   font-size: 12px;
   line-height: 16px;
   text-overflow: ellipsis;
   white-space: nowrap;
 }
 .tsr-editor-link {
   flex: 0 0 auto;
   padding: 0;
   border: none;
   background: none;
   color: var(--dsw-alias-brand-primary);
   font: inherit;
   font-size: 12px;
   line-height: 16px;
   cursor: pointer;
 }
 .tsr-editor-link:hover { text-decoration: underline; }
 .tsr-editor-gap { flex: 1 1 auto; }
 .tsr-btn {
   flex: 0 0 auto;
   height: 26px;
   padding: 0 10px;
   border: .5px solid var(--dsw-alias-border-l2);
   border-radius: var(--dsw-radius-sm);
   background: transparent;
   color: var(--dsw-alias-label-primary);
   font: inherit;
   font-size: 12px;
   line-height: 24px;
   cursor: pointer;
 }
 .tsr-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
 .tsr-btn[disabled] { cursor: default; opacity: .5; }
 .tsr-btn.is-primary {
   border-color: transparent;
   background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
   color: var(--dsw-alias-label-primary-foreground, #fff);
 }
 .tsr-btn:focus-visible,
 .tsr-editor-link:focus-visible {
   outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
   outline-offset: 1px;
 }
 @media (max-width: 640px) {
   .tsk-toolbar { flex-wrap: wrap; }
   .tsk-search { flex-basis: 100%; }
 }
 `

    /**
     * 发一次 Host 请求。
     * @param {string} method - 操作名。
     * @param {object} [payload] - 请求体。
     * @param {number} [timeoutMs] - 超时（安装大技能包时放宽）。
     * @returns {Promise<any>} 应答里的 value。
     */
    async function callHost(method, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(`${API_PREFIX}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal: controller?.signal,
        })
        const data = await response.json().catch(() => null)
        if (!response.ok || data === null || data.ok !== true) {
          const failure = new Error(data?.error?.message ?? `HTTP ${response.status}`)
          // `skill-exists` 这类错误码要交给界面做二次确认（覆盖安装），不能只剩一句文案。
          failure.code = data?.error?.code ?? ''
          failure.status = response.status
          throw failure
        }
        return data.value
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }

    /**
     * 本地时区的日历日键（与 Host 的 dayKey 同一套算法）。
     * @param {number} time - epoch 毫秒。
     * @returns {string} `YYYY-MM-DD`。
     */
    function dayKey(time) {
      const date = new Date(typeof time === 'number' && Number.isFinite(time) ? time : Date.now())
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /**
     * 按天分隔的小标题：今天 / 昨天 / `YYYY-MM-DD`。
     * @param {string} day - `YYYY-MM-DD`。
     * @param {(key: string) => string} t - 词典绑定。
     * @returns {string} 展示文本。
     */
    function dayLabel(day, t) {
      if (day === dayKey(Date.now())) return t('today')
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      if (day === dayKey(yesterday.getTime())) return t('yesterday')
      return day
    }

    /**
     * 一组会话按「最近活跃」倒序（同内置侧栏的 `orderByRecency`，再叠 Host 的活动时间）。
     *
     * 为什么要自己排：DSH 的工作区成员表 `sessionIds` 是**登记顺序**（`attachSession` 往
     * 数组头部 unshift），不是展示顺序。新会话确实在最前，可一条老会话被重新打开、
     * 跑完一轮之后，它在表里的位置并不动——于是「最近聊过的那条」埋在中间，内置侧栏
     * 里却始终在最上面（内置用的是 `summary.updatedAt` 倒序）。
     *
     * v0.12 再补一层：DSH 的 `updatedAt` 是 `max(createdAt, lastPromptAt)`，而
     * `lastPromptAt` **只**在 `user/message` 且 source.kind === 'user' 时更新。用「指令」
     * （`/goal`、`/permission` 这类）开的会话没有这种消息——`updatedAt` 永远停在创建时刻，
     * 于是刚跑完几轮也排不到上面。Host 的 `sessionMeta[id].activityAt` 是从会话事件流 /
     * 会话日志 mtime 算出来的真实活跃时间，两者取大。
     *
     * 口径与内置逐字对齐：时间大的在前；相同（都拿不到时为 0）时按 id 字符串比，
     * 保证每次渲染顺序稳定、不抖动。
     * @param {string[]} ids - 会话 id 数组（会被就地排序，调用方传副本）。
     * @param {object} ctx - 客户端上下文（读 `sessions.list` 快照）。
     * @param {Record<string, {activityAt?: number, title?: string}>} [metadata] - Host 给的会话元数据。
     * @returns {string[]} 排好序的 id 数组。
     */
    function orderByRecency(ids, ctx, metadata) {
      const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
      const byId = snapshot?.byId
      const stamp = (id) => {
        const host = metadata !== null && typeof metadata === 'object' ? metadata?.[id]?.activityAt : undefined
        const hostAt = typeof host === 'number' && Number.isFinite(host) ? host : 0
        const value = byId?.[id]?.updatedAt
        return Math.max(hostAt, typeof value === 'number' && Number.isFinite(value) ? value : 0)
      }
      return ids.sort((left, right) => {
        const delta = stamp(right) - stamp(left)
        return delta !== 0 ? delta : left < right ? -1 : left > right ? 1 : 0
      })
    }

    /**
     * 侧栏里那种短短的相对时间。
     * @param {number} value - epoch 毫秒。
     * @returns {string} `刚刚` / `N 分钟` / `N 小时` / `MM-DD`。
     */
    function relativeTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
      const delta = Date.now() - value
      if (delta < 60_000) return '刚刚'
      if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟`
      if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时`
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /**
     * 一个路径的最后一截（会话 cwd 的目录名）。
     * @param {unknown} target - 路径。
     * @returns {string} 目录名；不是字符串或空路径时是空串。
     */
    function baseNameOf(target) {
      if (typeof target !== 'string' || target === '') return ''
      const parts = target.split(/[\\/]+/u).filter((part) => part !== '')
      return parts.length === 0 ? '' : parts[parts.length - 1]
    }

    /**
     * 一条会话快照里的展示标题（持久标题优先，其次是「像标题的」displayTitle）。
     *
     * 为什么不能直接用 `displayTitle`：DSH 的 `displayTitleOf(title, cwd, id)` 在没有持久
     * 标题时会退回 **cwd 的目录名**（也就是项目名），再不行退回 id。用指令（`/goal` 这类
     * `command/run`）开的会话拿不到持久标题，于是侧栏里就看到「项目名」当标题——v0.12
     * 把这两种兜底值识别出来、当没有标题处理（交给调用方回落「未命名」或指令文本提示）。
     * @param {object|undefined} summary - 客户端会话快照里的一条。
     * @returns {string} 标题；没有就是空串。
     */
    function titleOfSummary(summary) {
      if (summary === undefined || summary === null) return ''
      const durable = [summary?.projectionValues?.title, summary?.title].find(
        (value) => typeof value === 'string' && value.trim() !== '',
      )
      if (typeof durable === 'string') return durable.trim()
      if (summary.blank === true) return ''
      const display = typeof summary.displayTitle === 'string' ? summary.displayTitle.trim() : ''
      if (display === '') return ''
      // 项目名 / id 兜底 ≠ 标题
      if (display === summary.id) return ''
      if (display === baseNameOf(summary.cwd)) return ''
      return display
    }

    /**
     * 会话行的显示文案：有标题用标题，空白会话「新会话」，其余没标题的「未命名」
     * （与内置侧栏的 `session.untitled` 同一套说法）。
     * @param {object|undefined} info - {@link sessionInfo} 的结果。
     * @param {(key: string) => string} t - 词典绑定。
     * @returns {string} 展示文案。
     */
    function sessionLabel(info, t) {
      if (info !== undefined && info !== null && typeof info.title === 'string' && info.title !== '') {
        return info.title
      }
      return info?.blank === true ? t('sessionUntitled') : t('sessionUnnamed')
    }

    /**
     * 从客户端会话快照 + Host 元数据里取一条会话的展示信息（拿不到就是 undefined，绝不抛）。
     *
     * 字段实测：持久标题在 `projectionValues.title`（空白会话为 null），`displayTitle` 在
     * 缺标题时会退回 cwd 目录名 / id；`updatedAt = max(createdAt, lastPromptAt)`，指令不算
     * 「prompt」，所以指令开的会话要靠 Host 的 `sessionMeta[id].activityAt` 纠偏。
     * @param {object} ctx - 客户端上下文。
     * @param {string} sessionId - 会话 id。
     * @param {Record<string, {activityAt?: number, title?: string}>} [metadata] - Host 会话元数据。
     * @returns {{title: string, blank: boolean, running: boolean, updatedAt: number, activityAt: number}|undefined} 展示信息。
     */
    function sessionInfo(ctx, sessionId, metadata) {
      try {
        const sessions = ctx.get('sessions')
        const snapshot = sessions?.list?.getSnapshot?.()
        const summary = snapshot?.byId?.[sessionId]
        const meta = metadata !== null && typeof metadata === 'object' ? metadata?.[sessionId] : undefined
        const hostAt =
          typeof meta?.activityAt === 'number' && Number.isFinite(meta.activityAt) ? meta.activityAt : 0
        const hint = typeof meta?.title === 'string' ? meta.title.trim() : ''
        if (summary === undefined || summary === null) {
          // 快照里没有这条（冷会话 / 索引还没追上）：Host 元数据有东西就先画出来。
          if (hostAt <= 0 && hint === '') return undefined
          return { title: hint, blank: false, running: false, updatedAt: hostAt, activityAt: hostAt }
        }
        const blank = summary.blank === true
        const title = blank ? '' : titleOfSummary(summary) || hint
        const snapshotAt =
          typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt) ? summary.updatedAt : 0
        const activityAt = Math.max(snapshotAt, hostAt)
        return {
          title,
          blank,
          running: summary.running === true,
          updatedAt: activityAt,
          activityAt,
        }
      } catch {
        return undefined
      }
    }

    /**
     * 主视图里正开着的那条会话：内置侧栏也是这么认的——
     * `sessions.list` 快照里 `retainedBy.mainView > 0` 的那一条（`ui-workspace` 的
     * `mainSessionId()`）。拿不到、或者后台面板盖住了主视图，就当没有。
     * @param {object} ctx - 客户端上下文。
     * @returns {string|undefined} 会话 id。
     */
    function currentSessionId(ctx) {
      try {
        const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
        const byId = snapshot?.byId
        if (byId === null || typeof byId !== 'object') return undefined
        for (const row of Object.values(byId)) {
          if ((row?.retainedBy?.mainView ?? 0) > 0 && typeof row?.id === 'string') return row.id
        }
        return undefined
      } catch {
        return undefined
      }
    }

    /**
     * 一条会话的状态点状态：与 DSH 的 StateDot 同一套语义。
     * pending（待批准/待审计划/待回答）> running > 有新结果 > idle。
     * @param {object} ctx - 客户端上下文。
     * @param {string} sessionId - 会话 id。
     * @param {boolean} fallbackRunning - 快照里的 running（uiSession 缺席时用）。
     * @returns {'running'|'done'|'pending'|'idle'} 状态键。
     */
    function statusOf(ctx, sessionId, fallbackRunning) {
      try {
        const uiSession = ctx.get('uiSession')
        const statuses = uiSession?.sessionStatus?.getSnapshot?.()
        const status = statuses instanceof Map ? statuses.get(sessionId) : undefined
        if (status !== undefined) {
          if (status.pendingInteraction !== undefined && status.pendingInteraction !== null) return 'pending'
          if (status.running === true) return 'running'
          if (status.completionUnread === true) return 'done'
          return 'idle'
        }
      } catch {
        /* 退回快照 */
      }
      return fallbackRunning === true ? 'running' : 'idle'
    }

    /**
     * 一组会话里「正在忙」的那些：跑着的 + 等你回话的。
     *
     * 上级行（任务组 / 按天小标题 / 工作区组 / 工作区行 / 顶部「项目」）靠它往上汇总——
     * 会话行自己的状态点只说那一条，组一折起来就什么也看不见了。
     * @param {object} ctx - 客户端上下文。
     * @param {Array<{id?: string, running?: boolean}|string>} entries - 会话视图或 id。
     * @param {(key: string) => string} t - 词典绑定（标题缺席时用「新会话」/「未命名」）。
     * @param {Record<string, {activityAt?: number, title?: string}>} [metadata] - Host 会话元数据。
     * @returns {{ids: string[], states: string[], names: string[], count: number, running: number, pending: number}} 汇总。
     */
    function activeDescendants(ctx, entries, t, metadata) {
      const ids = []
      const states = []
      const names = []
      let running = 0
      let pending = 0
      const seen = new Set()
      for (const entry of Array.isArray(entries) ? entries : []) {
        const id = String(typeof entry === 'string' ? entry : entry?.id ?? '')
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        const info = sessionInfo(ctx, id, metadata)
        const fallback =
          (typeof entry === 'object' && entry !== null && entry.running === true) || info?.running === true
        const status = statusOf(ctx, id, fallback)
        if (status !== 'running' && status !== 'pending') continue
        ids.push(id)
        states.push(status)
        if (status === 'running') running += 1
        else pending += 1
        names.push(sessionLabel(info, t))
      }
      return { ids, states, names, count: ids.length, running, pending }
    }

    /**
     * 把几份「正在忙」汇总叠成一份（上级的上级用），按 id 去重、顺序按传入顺序保留。
     * @param {object[]} summaries - `activeDescendants` 的结果。
     * @returns {{ids: string[], states: string[], names: string[], count: number, running: number, pending: number}} 合并结果。
     */
    function mergeActive(summaries) {
      const ids = []
      const states = []
      const names = []
      let running = 0
      let pending = 0
      const seen = new Set()
      for (const summary of Array.isArray(summaries) ? summaries : []) {
        if (summary === undefined || summary === null || !Array.isArray(summary.ids)) continue
        for (let index = 0; index < summary.ids.length; index += 1) {
          const id = summary.ids[index]
          if (seen.has(id)) continue
          seen.add(id)
          ids.push(id)
          const state = summary.states?.[index] === 'pending' ? 'pending' : 'running'
          states.push(state)
          if (state === 'running') running += 1
          else pending += 1
          names.push(summary.names?.[index] ?? '')
        }
      }
      return { ids, states, names, count: ids.length, running, pending }
    }

    /**
     * 把客户端侧异常回传给 Host（写 `<home>/task-folders/note-*.json`），
     * 这样看不到浏览器控制台时也能定位问题。只在出错时写。
     * @param {string} where - 出错位置。
     * @param {unknown} error - 异常。
     */
    function reportClientFailure(where, error) {
      try {
        void fetch(`${API_PREFIX}/note`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientFailure: where,
            message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            stack: error instanceof Error ? String(error.stack ?? '').slice(0, 2000) : undefined,
            at: new Date().toISOString(),
          }),
        }).catch(() => {})
      } catch {
        /* 连回传都失败就算了 */
      }
    }

    /** 首屏状态只回传一次（`debug: true` 时）。 */
    let reportedFirstState = false

    /**
     * 首屏摘要回传：用来在没有浏览器控制台时确认侧栏拿到了数据。
     *
     * 顺手带上技能目录的一份摘要（总数 / 分类 / 前几个名字 / 走的哪个 scope）：设置页
     * 最容易出问题的地方是「注册表挂在哪一层」，从 note 文件里一眼就能看出 Host 到底是
     * 从当前会话的预设层读的（session）、默认预设租约（preset），还是只读到全局层（global）。
     * @param {object} state - Host 状态。
     */
    function reportFirstState(state) {
      try {
        void (async () => {
          let skills
          try {
            const value = await callHost('skills', {})
            const rows = Array.isArray(value?.skills) ? value.skills : []
            const byCategory = {}
            const bySource = {}
            for (const row of rows) {
              byCategory[row.category] = (byCategory[row.category] ?? 0) + 1
              bySource[row.source] = (bySource[row.source] ?? 0) + 1
            }
            skills = {
              total: rows.length,
              scopeKind: value?.scopeKind ?? null,
              complete: value?.complete ?? null,
              userRoot: value?.userRoot ?? null,
              byCategory,
              bySource,
              names: rows.slice(0, 12).map((row) => row.name),
            }
          } catch (failure) {
            skills = { error: failure instanceof Error ? failure.message : String(failure) }
          }
          await fetch(`${API_PREFIX}/note`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              at: new Date().toISOString(),
              firstState: {
                tasksRoot: state?.tasksRoot ?? null,
                taskWorkspaceId: state?.taskWorkspaceId ?? null,
                canCreate: state?.canCreate ?? null,
                days: (state?.dayGroups ?? []).map((group) => ({ day: group.day, sessions: group.sessions.length })),
                workspaces: (state?.workspaces ?? []).slice(0, 12).map((workspace) => ({
                  title: workspace.title,
                  sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : -1,
                })),
                skills,
              },
            }),
          }).catch(() => {})
        })()
      } catch {
        /* 诊断失败无所谓 */
      }
    }

    /**
     * 过滤掉登记在任务根目录之下的工作区（v0.2「任务 = 工作区」的残留）。
     * Host 新版自己就会过滤；旧版 Host 不过滤，客户端补上，刷新页面也能得到正确分组。
     * @param {object[]} list - 工作区视图数组。
     * @param {string} tasksRoot - 任务根目录。
     * @returns {object[]} 过滤后的数组。
     */
    function outsideTasksRoot(list, tasksRoot) {
      if (!Array.isArray(list)) return []
      if (typeof tasksRoot !== 'string' || tasksRoot === '') return list
      const key = tasksRoot.toLowerCase()
      return list.filter((workspace) => {
        const target = typeof workspace?.path === 'string' ? workspace.path.toLowerCase() : ''
        return target !== '' && !target.startsWith(key)
      })
    }

    /**
     * 按「归档过滤」把主列表与归档两组按天合并回来。
     *
     * Host 给的是两份：`dayGroups`（未归档）和 `archivedDayGroups`（已归档）。分成两份
     * 是为了不把「磁盘上有按天副本」（会话字段 `archived`）和「在 DSH 里归档了」混成
     * 一件事——前者几乎每条命中会话都有，后者才是要藏起来的。
     * @param {object[]} visible - 未归档的按天分组。
     * @param {object[]} archived - 已归档的按天分组。
     * @param {'hide'|'show'|'only'} filter - 归档过滤档位。
     * @returns {object[]} `{day, sessions}` 数组，每条会话带 `sidebarArchived` 标记。
     */
    function mergeDayGroups(visible, archived, filter) {
      const rows = []
      const push = (groups, sidebarArchived) => {
        for (const group of Array.isArray(groups) ? groups : []) {
          const day = typeof group?.day === 'string' ? group.day : ''
          for (const session of Array.isArray(group?.sessions) ? group.sessions : []) {
            if (session === undefined || session === null) continue
            rows.push({
              session: { ...session, day, sidebarArchived },
              day,
            })
          }
        }
      }
      if (filter !== 'only') push(visible, false)
      if (filter !== 'hide') push(archived, true)
      const byDay = new Map()
      for (const row of rows) {
        if (!byDay.has(row.day)) byDay.set(row.day, [])
        byDay.get(row.day).push(row.session)
      }
      return [...byDay.entries()]
        .sort((left, right) => (left[0] < right[0] ? 1 : left[0] > right[0] ? -1 : 0))
        .map(([day, sessions]) => ({
          day,
          // v0.12：同一天里按最后活动时间排（Host 已经算好 `activityAt`）；老版本 Host
          // 没有这个字段时退回 createdAt，顺序仍然稳定。
          sessions: sessions.sort((left, right) => {
            const delta =
              (right.activityAt ?? right.createdAt ?? 0) - (left.activityAt ?? left.createdAt ?? 0)
            return delta !== 0 ? delta : String(left.id) < String(right.id) ? -1 : 1
          }),
        }))
    }

    /**
     * 从客户端自己的快照算「无工作区的会话」。
     * Host 的 `state` 带着按天分组时优先用它（v0.12 起那天是**最后活跃那天**）；
     * Host 还是旧版（没有 dayGroups）时用这条兜底——数据都在客户端快照里：
     * 会话清单 + 每条会话的 cwd/origin，加上工作区清单的 sessionIds。
     * @param {object} ctx - 客户端上下文。
     * @param {string} tasksRoot - 任务根目录（过滤残留任务工作区用）。
     * @returns {{dayGroups: object[], workspaces: object[]}} 按天分组（天 = 会话最后活跃那天）与工作区。
     */
    function deriveFromSnapshots(ctx, tasksRoot) {
      const workspaces = []
      const grouped = new Set()
      const archived = new Set()
      try {
        const snapshot = ctx.get('workspaces')?.list?.getSnapshot?.()
        for (const item of snapshot?.items ?? []) {
          const sessionIds = Array.isArray(item?.sessionIds) ? item.sessionIds.map(String) : []
          for (const id of sessionIds) grouped.add(id)
          workspaces.push({
            id: String(item?.workspaceId ?? item?.path ?? ''),
            title: typeof item?.title === 'string' && item.title !== '' ? item.title : String(item?.path ?? ''),
            path: typeof item?.path === 'string' ? item.path : '',
            sessionIds,
          })
        }
        for (const id of snapshot?.archivedSessionIds ?? []) archived.add(String(id))
      } catch {
        /* 快照读不到就返回空 */
      }

      const byDay = new Map()
      try {
        const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
        for (const id of snapshot?.ids ?? []) {
          const summary = snapshot?.byId?.[id]
          if (summary === undefined || summary === null) continue
          if (summary.origin === 'subagent') continue
          if (grouped.has(String(id)) || archived.has(String(id))) continue
          const updatedAt = typeof summary.updatedAt === 'number' ? summary.updatedAt : 0
          const day = dayKey(updatedAt > 0 ? updatedAt : Date.now())
          if (!byDay.has(day)) byDay.set(day, [])
          byDay.get(day).push({ id: String(id), day, createdAt: updatedAt, live: summary.running === true })
        }
      } catch {
        /* 同上 */
      }
      const dayGroups = [...byDay.entries()]
        .sort((left, right) => (left[0] < right[0] ? 1 : left[0] > right[0] ? -1 : 0))
        .map(([day, sessions]) => ({ day, sessions }))
      return { dayGroups, workspaces }
    }

    /**
     * 把刚删掉的会话从按天分组里摘掉（删完到下一份 Host 状态到手之间那几秒，别让它赖在侧栏上）。
     * 一整天空了就整组去掉——按天小标题不该为一条已删的会话留着。
     * @param {object[]} groups - `{day, sessions}` 数组。
     * @param {Set<string>} hiddenIds - 刚从侧栏摘掉的会话 id。
     * @returns {object[]} 过滤后的数组。
     */
    function withoutHiddenSessions(groups, hiddenIds) {
      if (!(hiddenIds instanceof Set) || hiddenIds.size === 0) return groups
      const kept = []
      for (const group of Array.isArray(groups) ? groups : []) {
        const sessions = (Array.isArray(group?.sessions) ? group.sessions : []).filter(
          (session) => !hiddenIds.has(String(session?.id ?? '')),
        )
        if (sessions.length > 0) kept.push({ ...group, sessions })
      }
      return kept
    }

    /**
     * 一份 Host 状态里还列不列这条会话——Host 追上来之后，本地的隐藏标记就该忘掉。
     * @param {object} state - Host 状态。
     * @param {string} id - 会话 id。
     * @returns {boolean} 是否还在。
     */
    function stateListsSession(state, id) {
      const key = String(id)
      const hit = (list) =>
        Array.isArray(list) ? list.some((session) => String(session?.id ?? '') === key) : false
      for (const group of [...(state?.dayGroups ?? []), ...(state?.archivedDayGroups ?? [])]) {
        if (hit(group?.sessions)) return true
      }
      if (hit(state?.sessions) || hit(state?.archivedSessions)) return true
      for (const workspace of Array.isArray(state?.workspaces) ? state.workspaces : []) {
        const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
        if (ids.some((candidate) => String(candidate) === key)) return true
      }
      return false
    }

    /**
     * 构造侧栏区域组件。
     * @param {object} ctx - 客户端插件上下文。
     * @param {(key: string) => string} t - 词典绑定。
     * @returns {Function} React 组件。
     */
    function createSidebar(ctx, t) {
      return function TaskSidebar(props) {
        const [state, setState] = React.useState(null)
        const [error, setError] = React.useState('')
        const [busy, setBusy] = React.useState('')
        const [tick, setTick] = React.useState(0)
        const [tasksOpen, setTasksOpen] = React.useState(true)
        const [workspacesOpen, setWorkspacesOpen] = React.useState(true)
        const [expanded, setExpanded] = React.useState(() => new Set())

        // ---- v0.5：搜索 / 行菜单 / 归档过滤 / 已归档项目 ----
        // 注意 hooks 的**顺序**：新的状态一律排在 `expanded`（第 7 个）之后，
        // 免得打乱既有顺序（单测按序号覆盖 useState 初值）。
        const [query, setQuery] = React.useState('')
        const [searchOpen, setSearchOpen] = React.useState(false)
        const [archivedFilter, setArchivedFilter] = React.useState('hide')
        const [menu, setMenu] = React.useState(null)
        const [archivedProjectsOpen, setArchivedProjectsOpen] = React.useState(false)
        const [remoteSearch, setRemoteSearch] = React.useState({ pending: false, items: [], hasMore: false })
        // 顶部提示条（v0.11.4）：`null` = 不画；`{confirm: sessionId}` = 删除会话的二次确认
        // （说明 + 取消 / 删除）；`{text, tone}` = 一句反馈，4 秒后自己消失。
        const [notice, setNotice] = React.useState(null)
        // v0.6：刚删掉的会话先在本地藏起来，等 Host 的下一份状态追上（sessionQuery 索引
        // 要等一次 reconcile 才会掉这条），这几秒里侧栏不该还挂着一条点不开的行。
        const [hiddenIds, setHiddenIds] = React.useState(() => new Set())
        // v0.7：一屏铺不完就先折起来——任务按天列表一个开关，工作区成员各记各的。
        const [tasksExpanded, setTasksExpanded] = React.useState(false)
        const [wsExpanded, setWsExpanded] = React.useState(() => new Set())
        // 弹出菜单的视口坐标（量不到时为 null，退回 CSS 里的「贴在行下面」）。
        const [menuAnchor, setMenuAnchor] = React.useState(null)

        const searchInput = React.useRef(null)
        /** 常驻头（标题行 + 搜索框）：点到它外面才算「离开搜索」，见下面的 mousedown 监听。 */
        const searchTop = React.useRef(null)
        /** 顶部提示条的自消定时器：换一条先把上一条的定时器收掉，别让旧的那条迟来覆盖。 */
        const flashTimer = React.useRef(null)

        const mounted = React.useRef(true)

        /**
         * 收起搜索：**清词与收框必须一起做**。
         *
         * `searching` 只看 query——只收框不清词，列表那块就还是搜索结果，搜索框一露头就再也
         * 变不回任务 / 工作区；只清词不收框，输入框又白白挂在那儿。所以所有收起路径（✕、
         * 再点一次放大镜、Esc、点开一条结果、点头部以外）都只调这一个函数。
         */
        const closeSearch = React.useCallback(() => {
          setQuery('')
          setSearchOpen(false)
        }, [])

        /**
         * 一组会话默认铺开几条：`SESSION_LIMIT` 之后折进「展开其余 N 个会话」；
         * 跑着 / 等回话的那几条无论排到第几名都得露脸（藏起来等于让人干等）。
         * @param {object[]|string[]} sessions - 会话对象（或 id）数组。
         * @param {number} limit - 铺开的上限（`Infinity` = 全铺）。
         * @param {(entry: object|string) => {id: string, running?: boolean}} [read] - 从一条里取出 id / running。
         * @returns {{rows: object[]|string[], hidden: number}} 要画的与折起来的条数。
         */
        const visibleSessions = (
          sessions,
          limit,
          read = (entry) => ({ id: typeof entry === 'string' ? entry : entry?.id, running: entry?.running === true }),
        ) => {
          if (!Number.isFinite(limit) || limit >= sessions.length) return { rows: sessions, hidden: 0 }
          const rows = sessions.filter((session, index) => {
            if (index < limit) return true
            const { id, running } = read(session)
            return ATTENTION_STATES.has(statusOf(ctx, String(id ?? ''), running === true))
          })
          return { rows, hidden: sessions.length - rows.length }
        }

        /**
         * 量一下弹出菜单该挂在视口的哪儿：先试触发按钮下方，放不下就翻到上方，
         * 左右也夹在视口里。量不到（没有 DOM / 没有 window）就返回 null。
         * @param {object|null} element - 触发按钮（事件里的 currentTarget）。
         * @param {number} height - 菜单高度估计（菜单项 29px + 内边距）。
         * @returns {{top: number, left: number}|null} 视口坐标。
         */
        const measureMenu = (element, height) => {
          try {
            if (element === null || typeof element !== 'object') return null
            if (typeof element.getBoundingClientRect !== 'function') return null
            if (typeof window === 'undefined') return null
            const rect = element.getBoundingClientRect()
            const viewportHeight = Number(window.innerHeight)
            const viewportWidth = Number(window.innerWidth)
            if (!Number.isFinite(viewportHeight) || !Number.isFinite(viewportWidth)) return null
            const margin = 8
            const gap = 2
            const width = 156
            const below = rect.bottom + gap
            const above = rect.top - gap - height
            const fitsBelow = below + height <= viewportHeight - margin
            const top = fitsBelow || above < margin ? Math.min(below, Math.max(margin, viewportHeight - margin - height)) : above
            const left = Math.max(margin, Math.min(rect.right - width, viewportWidth - margin - width))
            return { top, left }
          } catch {
            return null
          }
        }

        /**
         * 开 / 关菜单，同时把它的落点量好。
         *
         * 开新菜单时顺手撤掉顶部那条删除确认：人都改去点别处了，那行问句没有占着地方的理由。
         * @param {object|null} next - 菜单状态（null = 关）。
         * @param {object|null} element - 触发按钮。
         * @param {number} [height] - 菜单高度估计。
         */
        const openMenu = (next, element, height = 99) => {
          if (next !== null) setNotice(null)
          setMenu(next)
          setMenuAnchor(next === null ? null : measureMenu(element, height))
        }

        /**
         * 菜单挂到 `document.body` 上：侧栏那块区域自己套着滚动 + `overflow: hidden`，
         * 留在行里的浮层会被区域底边裁掉。拿不到 `createPortal` 时原样返回。
         * @param {object|null} node - 菜单元素。
         * @param {string} [key] - React key（portal 也要带上，否则列表里会告警）。
         * @returns {object|null} 可渲染的节点。
         */
        const portalMenu = (node, key) => {
          if (node === null) return null
          try {
            const body = typeof document === 'undefined' ? undefined : document.body
            if (body === undefined || body === null) return node
            if (typeof reactDom?.createPortal !== 'function') return node
            return reactDom.createPortal(node, body, key)
          } catch {
            return node
          }
        }

        const refresh = React.useCallback(async () => {
          try {
            const next = await callHost('state')
            if (!mounted.current) return
            setState(next)
            setError('')
            // Host 追上来了（不再列这条会话）就忘掉本地隐藏标记——真复活时也不会一直被藏着。
            setHiddenIds((current) => {
              if (current.size === 0) return current
              const kept = new Set()
              for (const id of current) if (stateListsSession(next, id)) kept.add(id)
              return kept.size === current.size ? current : kept
            })
            if (next?.debug === true && !reportedFirstState) {
              reportedFirstState = true
              reportFirstState(next)
            }
          } catch (failure) {
            if (!mounted.current) return
            setError(`${t('errorLoad')}：${failure instanceof Error ? failure.message : String(failure)}`)
          }
        }, [t])

        React.useEffect(() => {
          mounted.current = true
          refresh()
          const timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return
            refresh()
          }, POLL_MS)
          return () => {
            mounted.current = false
            clearInterval(timer)
          }
        }, [refresh])

        // 会话标题/运行状态来自客户端快照：订阅一次，变了就重画。
        React.useEffect(() => {
          const snapshot = ctx.get('sessions')?.list
          if (snapshot === undefined || typeof snapshot.subscribe !== 'function') return undefined
          const unsubscribe = snapshot.subscribe(() => {
            if (mounted.current) setTick((value) => value + 1)
          })
          return () => {
            if (typeof unsubscribe === 'function') unsubscribe()
          }
        }, [])

        // 运行中 / 待确认 / 有新结果：订阅 uiSession 的状态源（没有就只用快照的 running）。
        React.useEffect(() => {
          const source = ctx.get('uiSession')?.sessionStatus
          if (source === undefined || typeof source.subscribe !== 'function') return undefined
          const unsubscribe = source.subscribe(() => {
            if (mounted.current) setTick((value) => value + 1)
          })
          return () => {
            if (typeof unsubscribe === 'function') unsubscribe()
          }
        }, [])

        const run = React.useCallback(
          async (action) => {
            setBusy('go')
            setError('')
            try {
              await action()
            } catch (failure) {
              setError(`${t('errorGeneric')}：${failure instanceof Error ? failure.message : String(failure)}`)
            } finally {
              setBusy('')
              await refresh()
            }
          },
          [refresh, t],
        )

        /**
         * 顶部提示条的一句反馈（删成功 / 复制成功之类），4 秒后自己消失。
         *
         * 画在常驻头里而不是列表最底下：列表一长，那行灰字根本滚不到眼前，而且会在列表里
         * 突然冒出来一行、把下面的内容往下顶——那就是「突兀」的由来。
         * @param {string} text - 提示文本。
         * @param {''|'ok'|'error'} [tone] - 色调（空 = 次要文字）。
         */
        const flash = React.useCallback((text, tone = '') => {
          setNotice({ text: String(text), tone, confirm: '' })
          if (flashTimer.current !== null) clearTimeout(flashTimer.current)
          flashTimer.current = setTimeout(() => {
            if (mounted.current) setNotice(null)
          }, 4000)
        }, [])

        /**
         * 删除会话的二次确认（v0.11.4 起走顶部提示条，不再是菜单里的浮层）：
         * 菜单由 `renderMenu` 的点击处理照常收起，这里只把问句摆到顶部——
         * 「删除这条会话？…」＋「取消 / 删除」，取消或 Esc 都能撤。
         * 删除是唯一动文件的动作，不该点一下就执行——只是换个不突兀的问法。
         * @param {string} sessionId - 待确认删除的会话 id。
         */
        const confirmDeleteSession = React.useCallback((sessionId) => {
          if (flashTimer.current !== null) clearTimeout(flashTimer.current)
          setNotice({ text: '', tone: '', confirm: String(sessionId) })
        }, [])

        /**
         * 归档 / 取消归档一条会话 —— 走 DSH 原生 `uiWorkspace.archiveSession`，
         * 与内置侧栏那个「归档会话」是同一条路：会话立刻从侧栏消失（日志保留），
         * 之后可以在「全部对话（显示已归档）」里取消归档找回来。
         * @param {string} sessionId - 会话 id。
         * @param {boolean} archived - true = 归档，false = 取消归档。
         */
        const archiveSession = React.useCallback(
          (sessionId, archived) => {
            void run(async () => {
              const uiWorkspace = ctx.get('uiWorkspace')
              const workspacesService = ctx.get('workspaces')
              const method = archived ? 'archiveSession' : 'unarchiveSession'
              const service = typeof uiWorkspace?.[method] === 'function' ? uiWorkspace : workspacesService
              if (service === undefined || typeof service?.[method] !== 'function') {
                throw new Error(t('archiveFailed'))
              }
              try {
                await service[method](sessionId)
              } catch (failure) {
                const reason = failure instanceof Error ? failure.message : String(failure)
                // 会话还在跑时 DSH 会拒绝归档（原生在这一步弹「停止并归档」确认框）。
                // 我们只把话说清楚、让人自己决定停不停，不替人中断正在做的工作。
                throw new Error(
                  /activ|running|busy|进行/i.test(reason) ? t('archiveBusy') : `${t('archiveFailed')}：${reason}`,
                )
              }
            })
          },
          [run, t],
        )

        /**
         * 删除一条会话（v0.6）——DSH 原生只有归档，物理删除由插件的 Host 那侧落地：
         * 把会话日志、按天副本、投影缓存收进回收站，再把 id 从归档集合与工作区成员表里摘掉。
         * Host 只会因为一件事拒绝：会话还在干活（先停再删，别把这一轮工作丢掉）。
         *
         * v0.11.4：入口从「菜单里的就地确认浮层」改成顶部提示条（`confirmDeleteSession`），
         * 删成功的反馈也画回同一条（`ok` 色调，4 秒自消）。
         * @param {string} sessionId - 会话 id。
         */
        const deleteSession = React.useCallback(
          (sessionId) => {
            void run(async () => {
              try {
                await callHost('deleteSession', { sessionId })
              } catch (failure) {
                const reason = failure instanceof Error ? failure.message : String(failure)
                throw new Error(reason === '' ? t('deleteFailed') : reason)
              }
              // 先本地藏起来：sessionQuery 的索引要等一次 reconcile 才会掉这条，别让侧栏
              // 在这几秒里挂着一条点不开的行。
              setHiddenIds((current) => new Set(current).add(String(sessionId)))
              flash(t('deleted'), 'ok')
            })
          },
          [run, flash, t],
        )

        /**
         * 复制 Session ID（菜单里的那一行，与内置侧栏同一个动作）。
         * @param {string} sessionId - 会话 id。
         */
        const copySessionId = React.useCallback(
          (sessionId) => {
            const done = (ok) => flash(ok ? t('copied') : t('copyFailed'), ok ? 'ok' : 'error')
            try {
              const clipboard = typeof navigator !== 'undefined' ? navigator?.clipboard : undefined
              if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
                void clipboard.writeText(sessionId).then(() => done(true), () => done(false))
                return
              }
            } catch {
              /* 走下面的兜底 */
            }
            done(false)
          },
          [flash, t],
        )

        /**
         * 归档 / 恢复一个项目（普通工作区）。只写插件自己那份归档清单：
         * DSH 的工作区登记、目录、名下会话日志一个字节都不动，恢复即原样回来。
         * @param {string} workspaceId - 工作区 id。
         * @param {boolean} archived - true = 归档，false = 恢复。
         */
        const archiveProject = React.useCallback(
          (workspaceId, archived) => {
            void run(async () => {
              await callHost('archiveProject', { workspaceId, archived })
            })
          },
          [run],
        )

        // 菜单：点外面就关掉。菜单容器自己 stopPropagation，所以点菜单项不会被这里抢走。
        React.useEffect(() => {
          if (menu === null || typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
            return undefined
          }
          const close = () => setMenu(null)
          document.addEventListener('click', close)
          return () => document.removeEventListener('click', close)
        }, [menu])

        // 菜单挂在 body 上，是「钉在视口某一点」的：一滚动 / 一改窗口大小，
        // 触发它的那行就跑开了，留着它反而指错地方——直接收掉。
        React.useEffect(() => {
          if (menu === null || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return undefined
          }
          const close = () => setMenu(null)
          window.addEventListener('scroll', close, true)
          window.addEventListener('resize', close)
          return () => {
            window.removeEventListener('scroll', close, true)
            window.removeEventListener('resize', close)
          }
        }, [menu])

        // Ctrl/⌘+K 开搜索（与内置侧栏同一个快捷键）；Esc 收起搜索、菜单与顶部提示条。
        React.useEffect(() => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const onKeyDown = (event) => {
            const key = typeof event?.key === 'string' ? event.key.toLowerCase() : ''
            if (key === 'k' && (event.metaKey === true || event.ctrlKey === true)) {
              event.preventDefault()
              setSearchOpen(true)
              setTimeout(() => searchInput.current?.focus?.(), 0)
              return
            }
            if (event.key === 'Escape') {
              setMenu(null)
              // 顶部那条删除确认也一起撤：Esc 在这一块区域里就是「算了」。
              setNotice(null)
              closeSearch()
            }
          }
          document.addEventListener('keydown', onKeyDown)
          return () => document.removeEventListener('keydown', onKeyDown)
        }, [closeSearch])

        // 点到常驻头（标题行 + 搜索框）以外就收起搜索：内置侧栏的 `document click` 同一套。
        // 只在**还没输词**时收——输着词的时候结果正列在下面，碰一下别处就把结果收掉反而碍事
        // （内置也是 `if (normalizedQuery !== "") return`）。有词的收起走 ✕ / 放大镜 / Esc。
        React.useEffect(() => {
          if (!searchOpen) return undefined
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const onPointerDown = (event) => {
            const top = searchTop.current
            const target = event?.target
            if (top !== null && top !== undefined && typeof top.contains === 'function' && target !== null && top.contains(target) === true) {
              return
            }
            if (query.trim() !== '') return
            setSearchOpen(false)
          }
          document.addEventListener('mousedown', onPointerDown)
          return () => document.removeEventListener('mousedown', onPointerDown)
        }, [searchOpen, query])

        // 全文搜索（Host 的 `sessions.search`）：输入停 250ms 再发，换词就 abort 上一发。
        React.useEffect(() => {
          const text = query.trim()
          const sessions = ctx.get('sessions')
          if (text === '' || sessions === undefined || typeof sessions.search !== 'function') {
            setRemoteSearch({ pending: false, items: [], hasMore: false })
            return undefined
          }
          let cancelled = false
          const controller = typeof AbortController === 'function' ? new AbortController() : undefined
          setRemoteSearch((previous) => ({ ...previous, pending: true }))
          const timer = setTimeout(() => {
            Promise.resolve()
              .then(() => sessions.search(text, controller?.signal))
              .then((result) => {
                if (cancelled) return
                const items = Array.isArray(result?.value?.items) ? result.value.items : []
                setRemoteSearch({ pending: false, items, hasMore: result?.value?.hasMore === true })
              })
              .catch(() => {
                if (!cancelled) setRemoteSearch({ pending: false, items: [], hasMore: false })
              })
          }, 250)
          return () => {
            cancelled = true
            clearTimeout(timer)
            try {
              controller?.abort()
            } catch {
              /* abort 失败无所谓 */
            }
          }
        }, [query])

        /** 打开一条会话。 */
        const openSession = React.useCallback(
          (sessionId) => {
            // 人都改去开会话了，顶部那条删除问句没有占着地方的理由（取消 / Esc 之外第三条撤法）。
            setNotice(null)
            const uiWorkspace = ctx.get('uiWorkspace')
            if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
              setError(t('errorOpen'))
              return
            }
            try {
              uiWorkspace.openSession(sessionId)
            } catch (failure) {
              setError(`${t('errorOpen')}：${failure instanceof Error ? failure.message : String(failure)}`)
            }
          },
          [t],
        )

        /**
         * 在某个工作区里开一条新会话（工作区行尾的 ＋）。
         * 刚建好的工作区可能还没进客户端快照，所以失败重试几次（≤3 次，间隔 250ms）。
         * @param {string} workspaceId - 工作区 id。
         */
        const startWorkspaceSession = React.useCallback(
          (workspaceId) => {
            const uiWorkspace = ctx.get('uiWorkspace')
            if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
              setError(t('errorOpen'))
              return
            }
            const attempt = (left) => {
              try {
                uiWorkspace.startSession(workspaceId)
              } catch (failure) {
                if (left > 0) {
                  setTimeout(() => attempt(left - 1), 250)
                  return
                }
                setError(`${t('errorOpen')}：${failure instanceof Error ? failure.message : String(failure)}`)
              }
            }
            attempt(3)
            // startSession 自己吞掉了异步失败，过一会儿主动刷一次让新会话露出来。
            setTimeout(() => {
              if (mounted.current) void refresh()
            }, 600)
          },
          [refresh, t],
        )

        /**
         * 「任务」的 ＋：在任务默认工作区里起一条会话，不问名字、不选目录。
         *
         * 走 `uiWorkspace.connectWorkspace(taskWorkspaceId)` —— DSH 原生的「工作区的
         * 新会话」：有空白会话就复用，没有就让 Host 用 `{workspaceId}` 建一条，
         * cwd 自动等于工作区路径。**不能**再用 `sessions.create({cwd})`：那条路建出来的
         * 会话谁都不属于，DSH 的对话框不给它工作区芯片，输入框会退化成「选择工作区」，
         * 第一句话永远发不出去（v0.3 的病根）。
         *
         * 刚建的工作区可能还没进客户端快照，所以失败重试几次（≤3 次，间隔 250ms）；
         * 连不上就退回 `startSession(workspaceId)`（它自己会做连接 + 导航）。
         */
        const newTask = React.useCallback(() => {
          void run(async () => {
            const uiWorkspace = ctx.get('uiWorkspace')
            const workspaceId = typeof state?.taskWorkspaceId === 'string' ? state.taskWorkspaceId : ''
            if (workspaceId === '') throw new Error(t('errorStaleHost'))
            if (!uiWorkspace) throw new Error(t('errorCreate'))

            const connect = async () => {
              if (typeof uiWorkspace.connectWorkspace === 'function') return uiWorkspace.connectWorkspace(workspaceId)
              if (typeof uiWorkspace.startSession === 'function') {
                uiWorkspace.startSession(workspaceId)
                return ''
              }
              throw new Error(t('errorCreate'))
            }
            let sessionId = ''
            let lastError
            for (let left = 3; left >= 0; left -= 1) {
              try {
                sessionId = await connect()
                break
              } catch (failure) {
                lastError = failure
                if (left === 0) throw failure
                await new Promise((resolve) => setTimeout(resolve, 250))
              }
            }
            if (sessionId === '') {
              // startSession 路径自己会打开会话，到此为止。
              if (lastError !== undefined) throw lastError
              return
            }
            if (typeof uiWorkspace.openSession !== 'function') throw new Error(t('errorOpen'))
            uiWorkspace.openSession(sessionId)
          })
        }, [run, state, t])

        /** 加工作区：走 DSH 自己的目录选择框。 */
        const addWorkspace = React.useCallback(() => {
          void run(async () => {
            const uiWorkspace = ctx.get('uiWorkspace')
            const workspaces = ctx.get('workspaces')
            if (
              !uiWorkspace ||
              typeof uiWorkspace.pickDirectory !== 'function' ||
              !workspaces ||
              typeof workspaces.create !== 'function'
            ) {
              throw new Error(t('canNotCreate'))
            }
            const picked = await uiWorkspace.pickDirectory()
            if (typeof picked !== 'string' || picked === '') return
            await workspaces.create({ path: picked })
          })
        }, [run, t])

        void tick
        // v0.12：Host 给的会话元数据（真实活跃时间 + 指令标题提示）。旧版 Host 没有这一份，
        // 就退化成只看 DSH 快照（更新前的行为）。
        const sessionMeta =
          state?.sessionMeta !== null && typeof state?.sessionMeta === 'object' ? state.sessionMeta : undefined
        const infoOf = (id) => sessionInfo(ctx, id, sessionMeta)
        const recency = (ids) => orderByRecency(ids, ctx, sessionMeta)
        const labelOf = (info) => sessionLabel(info, t)
        const canCreate = state?.canCreate !== false
        // 任务会话只能在「任务默认工作区」里生：id 由 Host 给（旧版 Host 没有）。
        const taskWorkspaceId = typeof state?.taskWorkspaceId === 'string' ? state.taskWorkspaceId : ''
        const uiWorkspace = ctx.get('uiWorkspace')
        const hasWorkspaceStarter =
          typeof uiWorkspace?.connectWorkspace === 'function' || typeof uiWorkspace?.startSession === 'function'
        const canCreateSession = taskWorkspaceId !== '' && hasWorkspaceStarter
        // 旧版 Host 还活着（插件 Client 已更新、Host 还没重启）：说清楚，别让人点空。
        const staleHost = state !== null && taskWorkspaceId === ''
        // Host 是新版就给按天分组（v0.12 起按最后活跃那天，指令开的会话也能落到今天）；旧版 Host 没有 dayGroups，
        // 用客户端快照现算一份兜底——刷新页面就能用，不必等 Host 重启。
        const derived = React.useMemo(
          () => (Array.isArray(state?.dayGroups) ? null : deriveFromSnapshots(ctx, typeof state?.tasksRoot === 'string' ? state.tasksRoot : '')),
          [state, tick],
        )
        const visibleGroups = Array.isArray(state?.dayGroups) ? state.dayGroups : derived?.dayGroups ?? []
        const archivedGroups = Array.isArray(state?.archivedDayGroups) ? state.archivedDayGroups : []
        // 归档过滤三档（对齐内置侧栏的「视图选项」）：藏起来 / 一起看 / 只看归档。
        const dayGroups = React.useMemo(
          () => withoutHiddenSessions(mergeDayGroups(visibleGroups, archivedGroups, archivedFilter), hiddenIds),
          [state, tick, archivedFilter, hiddenIds],
        )
        const allWorkspaces = outsideTasksRoot(
          Array.isArray(state?.workspaces) ? state.workspaces : derived?.workspaces ?? [],
          typeof state?.tasksRoot === 'string' ? state.tasksRoot : '',
        )
        // 项目归档（v0.5）：归档的从主列表挪到底部的「已归档项目」分组，可一键恢复。
        const plainWorkspaces = allWorkspaces.filter((workspace) => workspace?.archived !== true)
        const archivedWorkspaces = allWorkspaces.filter((workspace) => workspace?.archived === true)
        const taskCount = dayGroups.reduce((total, group) => total + group.sessions.length, 0)
        const archivedSessionIds = new Set(
          Array.isArray(state?.archivedSessionIds) ? state.archivedSessionIds.map(String) : [],
        )
        // 主视图里正开着的那条会话。工作区行的文件夹「高亮」只认它——与内置侧栏同一套判据
        // （`.wnFoaW_folderActive` 只在 `containsCurrent` 时挂上）。拿不到就 undefined，照旧全灰。
        const currentId = currentSessionId(ctx)

        // ---- v0.10：上级行的「下面有任务在跑」汇总 ----
        // 一次算清每一层：按天 → 任务组；工作区 → 工作区组；两边 → 顶部「项目」。
        // 折叠不参与计算：折起来时上级正好该继续亮着；过滤参与（标的是你看得见的那些）。
        const dayActive = new Map(
          dayGroups.map((group) => [group.day, activeDescendants(ctx, group.sessions, t, sessionMeta)]),
        )
        const taskActive = mergeActive([...dayActive.values()])

        /**
         * 一个工作区当前要画的成员（跟着「归档过滤」与本地隐藏走，与行里列的一致），
         * 并按最近活跃倒序——与内置侧栏同一套口径。
         * @param {object} workspace - 工作区视图。
         * @returns {string[]} 成员 id。
         */
        const workspaceMembers = (workspace) =>
          recency(
            (Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []).filter((sessionId) => {
              if (hiddenIds.has(String(sessionId))) return false
              const sidebarArchived = archivedSessionIds.has(String(sessionId))
              if (archivedFilter === 'hide') return !sidebarArchived
              if (archivedFilter === 'only') return sidebarArchived
              return true
            }),
          )

        const workspaceActive = new Map(
          plainWorkspaces.map((workspace) => [
            workspace.id,
            activeDescendants(ctx, workspaceMembers(workspace), t, sessionMeta),
          ]),
        )
        const workspacesActive = mergeActive([...workspaceActive.values()])
        // 归档项目里的会话同样可能还在跑：分组标题与行上也要能看见。
        const archivedWorkspaceActive = new Map(
          archivedWorkspaces.map((workspace) => [
            workspace.id,
            activeDescendants(
              ctx,
              (Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []).filter(
                (sessionId) => !hiddenIds.has(String(sessionId)),
              ),
              t,
              sessionMeta,
            ),
          ]),
        )
        const archivedWorkspacesActive = mergeActive([...archivedWorkspaceActive.values()])
        const allActive = mergeActive([taskActive, workspacesActive, archivedWorkspacesActive])
        /** 搜索能认出来的会话（任务区 + 各工作区名下，含已归档的）。 */
        const searchableSessions = React.useMemo(() => {
          const entries = []
          const seen = new Set()
          const push = (id, workspace, sidebarArchived) => {
            const key = String(id)
            if (key === '' || seen.has(key) || hiddenIds.has(key)) return
            seen.add(key)
            entries.push({ id: key, workspace, sidebarArchived })
          }
          for (const group of [...visibleGroups, ...archivedGroups]) {
            for (const session of Array.isArray(group?.sessions) ? group.sessions : []) {
              if (session?.id === undefined) continue
              push(
                session.id,
                t('tasks'),
                session.sidebarArchived === true || archivedSessionIds.has(String(session.id)),
              )
            }
          }
          for (const workspace of allWorkspaces) {
            for (const id of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
              push(id, workspace.title, archivedSessionIds.has(String(id)))
            }
          }
          return entries
        }, [state, tick, t, hiddenIds])

        /** 搜索：本地标题 / 工作区 / id 命中 + Host 全文命中的合并（最多 20 条）。 */
        const searchResults = React.useMemo(() => {
          const text = query.trim().toLowerCase()
          if (text === '') return { items: [], pending: false, hasMore: false }
          const items = []
          const byId = new Map()
          for (const entry of searchableSessions) {
            const info = infoOf(entry.id)
            const title = labelOf(info)
            const hit =
              title.toLowerCase().includes(text) ||
              entry.workspace.toLowerCase().includes(text) ||
              entry.id.toLowerCase().includes(text)
            if (!hit) continue
            const item = { ...entry, title }
            byId.set(entry.id, item)
            items.push(item)
          }
          for (const raw of remoteSearch.items) {
            const id = String(raw?.sessionId ?? '')
            if (id === '') continue
            const known = byId.get(id)
            if (known !== undefined) {
              if (typeof raw.snippet === 'string' && raw.snippet !== '') known.snippet = raw.snippet
              continue
            }
            const info = infoOf(id)
            const entry = searchableSessions.find((candidate) => candidate.id === id)
            const item = {
              id,
              title: labelOf(info),
              workspace: entry?.workspace ?? '',
              sidebarArchived: entry?.sidebarArchived === true || archivedSessionIds.has(id),
              snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
            }
            byId.set(id, item)
            items.push(item)
          }
          const limit = 20
          return {
            // 搜索结果也按最近活跃倒序（与内置侧栏的搜索同口径），
            // 免得「最近聊过的那条」被登记顺序埋在后头。
            items: recency(items.map((item) => item.id))
              .map((id) => byId.get(id))
              .slice(0, limit),
            pending: remoteSearch.pending === true,
            hasMore: items.length > limit || remoteSearch.hasMore === true,
          }
        }, [query, searchableSessions, remoteSearch, tick, t])

        /**
         * 菜单落点的内联样式：量到视口坐标就用 fixed（叠在整页之上，不被侧栏区域裁）；
         * 量不到就返回 undefined，交给 `.tsb-menu` 里那套「贴在行下面」的 CSS 兜底。
         * @returns {object|undefined} 内联样式。
         */
        const menuStyle = () => {
          if (menuAnchor === null) return undefined
          const width = MENU_WIDTH
          const viewportWidth = typeof window === 'undefined' ? Number.NaN : Number(window.innerWidth)
          const maxLeft = Number.isFinite(viewportWidth) ? viewportWidth - width - 8 : menuAnchor.left
          return {
            position: 'fixed',
            zIndex: 1000,
            top: `${menuAnchor.top}px`,
            left: `${Math.max(8, Math.min(menuAnchor.left, maxLeft))}px`,
            right: 'auto',
            width: `${width}px`,
            minWidth: 0,
          }
        }

        /**
         * 画一个弹出菜单（浮在行下面，能翻到上面去）。
         * @param {object[]} items - `{key, label, checked, danger, onSelect}`。
         * @param {string} key - React key。
         * @returns {object} React 元素。
         */
        const renderMenu = (items, key) =>
          portalMenu(
            h(
              'div',
              {
                className: 'tsb-menu',
                key,
                role: 'menu',
                style: menuStyle(),
                // 点菜单项时别让 document 上的「点外面关掉」抢走这一次点击。
                onClick: (event) => event.stopPropagation(),
              },
              items.map((item) =>
                h(
                  'button',
                  {
                    className: ['tsb-menu-item', item.checked === true ? 'is-checked' : '', item.danger === true ? 'is-danger' : '']
                      .filter(Boolean)
                      .join(' '),
                    key: item.key,
                    type: 'button',
                    role: 'menuitem',
                    // 菜单点完就收（v0.11.4 起删除的二次确认改走顶部提示条，不再有「留着菜单」的项）。
                    onClick: () => {
                      setMenu(null)
                      item.onSelect()
                    },
                  },
                  h('span', { className: 'tsb-menu-check' }, item.checked === true ? '✓' : ''),
                  h('span', null, item.label),
                ),
              ),
            ),
            key,
          )

        /**
         * 顶部提示条（v0.11.4）：删除会话的二次确认与删成功 / 复制成功的反馈都画在这里。
         *
         * 为什么不放在列表里：`.tsb-scroll` 一长，列表最底下那行提示滚不到眼前，而且会在
         * 列表中间突然冒出来、把内容往下顶。挂在常驻头 `.tsb-top` 上，位置固定、来去都有交代。
         * 删除是唯一动文件的动作，所以问句照问——只是不再用浮层一下把人从行上拽走。
         * @returns {object|null} React 元素（没有提示时 null）。
         */
        const renderTopNotice = () => {
          if (notice === null || typeof notice !== 'object') return null
          if (typeof notice.confirm === 'string' && notice.confirm !== '') {
            return h(
              'div',
              { className: 'tsb-flash is-confirm', key: 'top-notice', role: 'alert' },
              h(
                'div',
                { className: 'tsb-flash-text' },
                h('div', { className: 'tsb-flash-title' }, t('deleteConfirmTitle')),
                h('div', { className: 'tsb-flash-hint' }, t('deleteConfirmHint')),
              ),
              h(
                'div',
                { className: 'tsb-flash-actions' },
                h(
                  'button',
                  { className: 'tsb-flash-btn', key: 'cancel', type: 'button', onClick: () => setNotice(null) },
                  t('cancel'),
                ),
                h(
                  'button',
                  {
                    className: 'tsb-flash-btn is-danger',
                    key: 'confirm',
                    type: 'button',
                    onClick: () => {
                      // 先收问句再动手：删成功会换成一条 ok 反馈，失败则由 run() 报在下面。
                      setNotice(null)
                      deleteSession(notice.confirm)
                    },
                  },
                  t('deleteConfirmAction'),
                ),
              ),
            )
          }
          if (notice.text === '') return null
          return h(
            'div',
            {
              className: ['tsb-flash', notice.tone === '' ? '' : `is-${notice.tone}`].filter(Boolean).join(' '),
              key: 'top-notice',
              role: 'status',
            },
            h('span', { className: 'tsb-flash-text' }, notice.text),
          )
        }

        /** 视图选项里的归档过滤三档。 */
        const viewMenuItems = [
          { key: 'hide', label: t('filterHideArchived'), checked: archivedFilter === 'hide', onSelect: () => setArchivedFilter('hide') },
          { key: 'show', label: t('filterShowArchived'), checked: archivedFilter === 'show', onSelect: () => setArchivedFilter('show') },
          { key: 'only', label: t('filterOnlyArchived'), checked: archivedFilter === 'only', onSelect: () => setArchivedFilter('only') },
        ]

        /**
         * 一条会话行的菜单项（对齐内置侧栏：归档 / 取消归档、复制 Session ID；
         * v0.6 再加一条 DSH 自己都没有的「删除会话…」——原生只有归档，删是插件补的）。
         * @param {string} sessionId - 会话 id。
         * @param {boolean} sidebarArchived - 这条会话是否已归档。
         * @returns {object[]} 菜单项数组。
         */
        const sessionMenuItems = (sessionId, sidebarArchived) => [
          {
            key: 'archive',
            label: sidebarArchived ? t('unarchiveSession') : t('archiveSession'),
            onSelect: () => archiveSession(sessionId, sidebarArchived !== true),
          },
          { key: 'copy', label: t('copySessionId'), onSelect: () => copySessionId(sessionId) },
          {
            key: 'delete',
            label: t('deleteSession'),
            danger: true,
            // v0.11.4：不再在菜单里就地换确认浮层（太突兀），改为收起菜单 + 顶部提示条问一句。
            onSelect: () => confirmDeleteSession(sessionId),
          },
        ]

        /**
         * 一条会话行（行首状态点 + 标题 + 相对时间 + 行尾「…」菜单）。
         * @param {string} sessionId - 会话 id。
         * @param {string} indent - 左缩进（CSS 长度）。
         * @param {string} key - React key。
         * @param {{sidebarArchived?: boolean}} [options] - 是否已归档（显示徽标 / 菜单项换「取消归档」）。
         * @returns {object} React 元素。
         */
        const renderSession = (sessionId, indent, key, options = {}) => {
          const info = infoOf(sessionId)
          const title = labelOf(info)
          const status = statusOf(ctx, sessionId, info?.running === true)
          const sidebarArchived = options.sidebarArchived === true
          const isMenuOpen = menu !== null && menu.kind === 'session' && menu.id === sessionId
          const className = ['tsb-row', sidebarArchived ? 'is-archived' : '', isMenuOpen ? 'is-menu-open' : '']
            .filter(Boolean)
            .join(' ')
          return h(
            'div',
            { className, key, style: { '--tsb-indent': indent } },
            h(
              'button',
              {
                className: 'tsb-row-main',
                type: 'button',
                title: `${title}\n${sessionId}`,
                onClick: () => openSession(sessionId),
              },
              h('span', { className: 'tsb-dot', 'data-state': status, 'aria-label': status }),
              h('span', { className: 'tsb-title' }, title),
              sidebarArchived ? h('span', { className: 'tsb-badge' }, t('archivedBadge')) : null,
            ),
            h('span', { className: 'tsb-meta' }, relativeTime(info?.updatedAt)),
            h(
              'button',
              {
                className: 'tsb-more',
                type: 'button',
                title: t('actions'),
                onClick: (event) => {
                  event.stopPropagation()
                  openMenu(isMenuOpen ? null : { kind: 'session', id: sessionId, sidebarArchived }, event.currentTarget)
                },
              },
              ellipsisIcon(14),
            ),
            isMenuOpen ? renderMenu(sessionMenuItems(sessionId, sidebarArchived), `menu:${sessionId}`) : null,
          )
        }

        /**
         * 上级行上的「下面有任务在跑」标记：浅色胶囊（实心点 + 常显数字），
         * 等回话时整枚换 warn 色系；窄条位置不够，`count: false` 退回一个实心点。
         * 悬停列出是哪几条——不用展开就知道下面谁在跑。
         * @param {object} summary - `activeDescendants` / `mergeActive` 的结果。
         * @param {string} key - React key。
         * @param {{count?: boolean}} [options] - `count: false` 只画点（顶部窄条用）。
         * @returns {object|null} React 元素（没有在跑的就没有标记）。
         */
        const renderActiveMark = (summary, key, options = {}) => {
          if (summary === undefined || summary === null || !(summary.count > 0)) return null
          const compact = options.count === false
          const state = summary.running > 0 ? 'running' : 'pending'
          const lines = []
          if (summary.running > 0) lines.push(t('runningBelow').replace('{n}', String(summary.running)))
          if (summary.pending > 0) lines.push(t('waitingBelow').replace('{n}', String(summary.pending)))
          const label = lines.join('\n')
          const names = (Array.isArray(summary.names) ? summary.names : []).filter(
            (name) => typeof name === 'string' && name !== '',
          )
          const shownNames = names.slice(0, 5)
          if (names.length > shownNames.length) shownNames.push('…')
          return h(
            'span',
            {
              className: compact ? 'tsb-runmark is-dot' : 'tsb-runmark',
              key,
              'data-state': state,
              role: 'img',
              'aria-label': label,
              title: shownNames.length === 0 ? label : `${label}\n${shownNames.join('\n')}`,
            },
            compact ? null : h('span', { className: 'tsb-runmark-count' }, String(summary.count)),
          )
        }

        /**
         * 「任务」组的内容：按天分隔的会话行（归档的按当前过滤档位决定显不显示）。
         * @returns {object[]} React 元素数组。
         */
        const renderTaskDays = () => {
          if (dayGroups.length === 0) {
            return [
              h(
                'div',
                { className: 'tsb-notice', key: 'empty' },
                archivedFilter === 'only' ? t('noArchivedSession') : t('noTask'),
              ),
            ]
          }
          const nodes = []
          // 任务一天动辄几十条，全铺出来侧栏得滚半天：默认只铺最近 10 条，
          // 其余折进「展开其余 N 个会话」（跑着 / 等回话的那几条例外，照样露脸）。
          const flat = []
          for (const group of dayGroups) {
            for (const session of group.sessions) flat.push({ day: group.day, session })
          }
          const shown = visibleSessions(
            flat,
            tasksExpanded || flat.length <= SESSION_LIMIT ? Number.POSITIVE_INFINITY : SESSION_LIMIT,
            (entry) => ({ id: entry?.session?.id, running: entry?.session?.running === true }),
          )
          let currentDay = ''
          for (const entry of shown.rows) {
            if (entry.day !== currentDay) {
              currentDay = entry.day
              nodes.push(
                h(
                  'div',
                  { className: 'tsb-day', key: `day:${entry.day}`, style: { '--tsb-indent': '10px' } },
                  h('span', { className: 'tsb-day-label' }, dayLabel(entry.day, t)),
                  // 这一天里只要还有任务在跑，按天小标题就亮着（会话折到「展开其余」也照样）。
                  renderActiveMark(dayActive.get(entry.day), `day-active:${entry.day}`),
                ),
              )
            }
            nodes.push(
              renderSession(entry.session.id, '20px', `task:${entry.session.id}`, {
                sidebarArchived: entry.session.sidebarArchived === true,
              }),
            )
          }
          if (shown.hidden > 0 || (tasksExpanded && flat.length > SESSION_LIMIT)) {
            const more = shown.hidden > 0
            nodes.push(
              h(
                'button',
                {
                  className: 'tsb-more-sessions',
                  key: 'tasks-more',
                  type: 'button',
                  style: { '--tsb-indent': '10px' },
                  'aria-expanded': more ? false : true,
                  onClick: () => setTasksExpanded((open) => !open),
                },
                more ? t('expandSessions').replace('{n}', String(shown.hidden)) : t('collapseSessions'),
              ),
            )
          }
          return nodes
        }

        /**
         * 搜索结果：标题 + 工作区 + 摘要片段；归档的给一个「取消归档」。
         * @returns {object} React 元素。
         */
        const renderSearchResults = () => {
          if (searchResults.items.length === 0) {
            const message = searchResults.pending ? t('searchPending') : t('searchEmpty')
            return h('div', { className: 'tsb-search-status', key: 'search-empty' }, message)
          }
          const rows = searchResults.items.map((item) => {
            const info = infoOf(item.id)
            return h(
              'div',
              { className: 'tsb-result', key: `search:${item.id}` },
              h(
                'button',
                {
                  className: 'tsb-row-main',
                  type: 'button',
                  title: `${item.title}\n${item.id}`,
                  onClick: () => {
                    // 点开一条结果 = 选完了：先收起搜索（清词 + 收框），再打开会话——
                    // 否则侧栏会一直停在结果页，人还得自己找地方关掉它（内置也是先收再开）。
                    closeSearch()
                    openSession(item.id)
                  },
                },
                h('span', {
                  className: 'tsb-dot',
                  'data-state': statusOf(ctx, item.id, info?.running === true),
                }),
                h('span', { className: 'tsb-title' }, item.title),
                item.sidebarArchived ? h('span', { className: 'tsb-badge' }, t('archivedBadge')) : null,
              ),
              h(
                'div',
                { className: 'tsb-result-meta' },
                item.workspace !== '' ? h('span', { className: 'tsb-result-workspace' }, item.workspace) : null,
                item.snippet ? h('span', { className: 'tsb-result-snippet' }, item.snippet) : null,
                item.sidebarArchived
                  ? h(
                      'button',
                      {
                        className: 'tsb-restore',
                        type: 'button',
                        onClick: () => archiveSession(item.id, false),
                      },
                      t('unarchiveSession'),
                    )
                  : null,
              ),
            )
          })
          if (searchResults.hasMore) {
            rows.push(h('div', { className: 'tsb-search-status', key: 'search-more' }, t('searchHasMore')))
          }
          if (searchResults.pending) {
            rows.push(h('div', { className: 'tsb-search-status', key: 'search-pending' }, t('searchPending')))
          }
          return h('div', { className: 'tsb-rows' }, rows)
        }

        /**
         * 底部的「已归档项目」：默认收起，展开后每行一个「恢复」。
         * @returns {object|null} React 元素（没有归档项目时 null）。
         */
        const renderArchivedProjects = () => {
          if (archivedWorkspaces.length === 0) return null
          const header = h(
            'div',
            { className: 'tsb-group', key: 'archived-projects' },
            h(
              'button',
              {
                className: 'tsb-head',
                type: 'button',
                title: archivedProjectsOpen ? t('collapse') : t('expand'),
                onClick: () => setArchivedProjectsOpen((open) => !open),
              },
              h('span', { className: archivedProjectsOpen ? 'tsb-chev is-open' : 'tsb-chev' }, triangleIcon()),
              h('span', { className: 'tsb-head-label' }, t('archivedProjects')),
              renderActiveMark(archivedWorkspacesActive, 'archived-projects-active'),
              h('span', { className: 'tsb-count' }, String(archivedWorkspaces.length)),
            ),
          )
          if (!archivedProjectsOpen) return header
          return [
            header,
            h(
              'div',
              { className: 'tsb-rows', key: 'archived-projects-rows' },
              archivedWorkspaces.map((workspace) =>
                h(
                  'div',
                  {
                    className: 'tsb-row is-archived',
                    key: `archived-ws:${workspace.id}`,
                    style: { '--tsb-indent': '10px' },
                  },
                  h('span', { className: 'tsb-folder' }, folderIcon({ size: 16 })),
                  h('span', { className: 'tsb-title', title: workspace.path }, workspace.title),
                  renderActiveMark(archivedWorkspaceActive.get(workspace.id), `archived-ws-active:${workspace.id}`),
                  h(
                    'button',
                    {
                      className: 'tsb-restore',
                      type: 'button',
                      title: t('restoreProject'),
                      onClick: () => archiveProject(workspace.id, false),
                    },
                    t('restore'),
                  ),
                ),
              ),
            ),
          ]
        }

        /**
         * 一个普通工作区（可展开它自己的会话；行尾 ＋ 在这个工作区里新建会话）。
         * @param {object} workspace - 工作区视图。
         * @returns {object[]} React 元素数组。
         */
        const renderWorkspace = (workspace) => {
          const key = `ws:${workspace.id}`
          const isOpen = expanded.has(key)
          const isMenuOpen = menu !== null && menu.kind === 'workspace' && menu.id === workspace.id
          // 工作区自己的会话也要跟着「归档过滤」走（与内置侧栏一致）：
          // 隐藏已归档时不列归档的，仅已归档时只列归档的。
          const members = workspaceMembers(workspace)
          // 文件夹染蓝的两种情形，合起来就是内置侧栏那枚 `.folderActive`：
          //   1. **打开着的**（`isOpen`）——「打开文件夹」本身就该是蓝的，这也是这一版要补的样子；
          //   2. **收着、但里面正开着会话**（`containsCurrent`）——内置侧栏的祖先工作区折起来
          //      也照样高亮（README：ancestor folder icons stay highlighted），别让「我在哪」消失。
          const containsCurrent =
            currentId !== undefined &&
            (Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []).some(
              (sessionId) => String(sessionId) === currentId,
            )
          const folderActive = isOpen || containsCurrent
          const className = ['tsb-row', isOpen ? 'is-open' : '', isMenuOpen ? 'is-menu-open' : '']
            .filter(Boolean)
            .join(' ')
          const nodes = [
            h(
              'div',
              { className, key, style: { '--tsb-indent': '10px' } },
              h(
                'button',
                {
                  className: 'tsb-row-main',
                  type: 'button',
                  title: `${workspace.title}\n${workspace.path}`,
                  onClick: () => {
                    setExpanded((current) => {
                      const next = new Set(current)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  },
                },
                // 文件夹与折叠三角占同一格：平时是文件夹，鼠标进来才换成三角（与内置侧栏一致），
                // 展开时换成打开的文件夹。两个同时画是重复的「可展开」语义。
                // 打开着的 / 当前会话所在的那个 = 内置的 `.folderActive` 蓝色（见上面的 folderActive）。
                h(
                  'span',
                  { className: folderActive ? 'tsb-folder is-active' : 'tsb-folder' },
                  folderIcon({ open: isOpen, size: 16 }),
                ),
                h('span', { className: isOpen ? 'tsb-chev is-open' : 'tsb-chev' }, triangleIcon()),
                h('span', { className: 'tsb-title' }, workspace.title),
                // 工作区里只要还有任务在跑 / 等回话，行尾就亮一个标记——收起时也看得见。
                renderActiveMark(workspaceActive.get(workspace.id), `ws-active:${workspace.id}`),
                h('span', { className: 'tsb-meta' }, String(members.length)),
              ),
              h(
                'button',
                {
                  className: 'tsb-add',
                  type: 'button',
                  title: t('newSessionIn'),
                  disabled: busy !== '',
                  onClick: () => startWorkspaceSession(workspace.id),
                },
                '＋',
              ),
              h(
                'button',
                {
                  className: 'tsb-more',
                  type: 'button',
                  title: t('actions'),
                  onClick: (event) => {
                    event.stopPropagation()
                    openMenu(isMenuOpen ? null : { kind: 'workspace', id: workspace.id }, event.currentTarget, 41)
                  },
                },
                ellipsisIcon(14),
              ),
              isMenuOpen
                ? renderMenu(
                    [
                      {
                        key: 'archive-project',
                        label: t('archiveProject'),
                        onSelect: () => archiveProject(workspace.id, true),
                      },
                    ],
                    `menu:ws:${workspace.id}`,
                  )
                : null,
            ),
          ]
          if (!isOpen) return nodes
          if (members.length === 0) {
            nodes.push(h('div', { className: 'tsb-notice', key: `wse:${workspace.id}` }, t('noSession')))
            return nodes
          }
          // 一个工作区名下也可能挂着几十条：默认铺 10 条，其余折进「展开其余 N 个会话」。
          const wsOpen = wsExpanded.has(key)
          const shown = visibleSessions(members, wsOpen ? Number.POSITIVE_INFINITY : SESSION_LIMIT)
          for (const sessionId of shown.rows) {
            nodes.push(
              renderSession(sessionId, '28px', `wss:${workspace.id}:${sessionId}`, {
                sidebarArchived: archivedSessionIds.has(String(sessionId)),
              }),
            )
          }
          if (shown.hidden > 0 || (wsOpen && members.length > SESSION_LIMIT)) {
            const more = shown.hidden > 0
            nodes.push(
              h(
                'button',
                {
                  className: 'tsb-more-sessions',
                  key: `wsm:${workspace.id}`,
                  type: 'button',
                  style: { '--tsb-indent': '28px' },
                  'aria-expanded': more ? false : true,
                  onClick: () =>
                    setWsExpanded((current) => {
                      const next = new Set(current)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    }),
                },
                more ? t('expandSessions').replace('{n}', String(shown.hidden)) : t('collapseSessions'),
              ),
            )
          }
          return nodes
        }

        // 侧栏被折成窄条时，只给一个能把它撑开的入口（区域自己不能白屏）。
        if (props && props.wide === false) {
          return h(
            'div',
            { className: 'tsb-rail', 'data-task-folders': REGION_ID },
            h(
              'button',
              {
                className: 'tsb-add',
                type: 'button',
                title: t('expand'),
                onClick: () => {
                  if (typeof props.expandSidebar === 'function') props.expandSidebar()
                },
              },
              '☰',
            ),
            // 侧栏整个折成窄条时，这是唯一还看得见的「下面有任务在跑」。
            renderActiveMark(allActive, 'rail-active', { count: false }),
          )
        }

        const searching = query.trim() !== ''

        /** 「任务」组的标题行（＋ = 在任务默认工作区里开一条新会话）。 */
        const tasksGroup = h(
          'div',
          { className: 'tsb-group', key: 'tasks-group' },
          h(
            'button',
            {
              className: 'tsb-head',
              type: 'button',
              title: tasksOpen ? t('collapse') : t('expand'),
              onClick: () => setTasksOpen((open) => !open),
            },
            h('span', { className: tasksOpen ? 'tsb-chev is-open' : 'tsb-chev' }, triangleIcon()),
            h('span', { className: 'tsb-head-label' }, t('tasks')),
            renderActiveMark(taskActive, 'tasks-active'),
            h('span', { className: 'tsb-count' }, String(taskCount)),
          ),
          h(
            'button',
            {
              className: 'tsb-add',
              type: 'button',
              title: t('newTask'),
              disabled: busy !== '' || canCreateSession === false,
              onClick: newTask,
            },
            '＋',
          ),
        )

        /** 「工作区」组的标题行（＋ = 添加工作区，走 DSH 自己的目录选择框）。 */
        const workspacesGroup = h(
          'div',
          { className: 'tsb-group', key: 'workspaces-group' },
          h(
            'button',
            {
              className: 'tsb-head',
              type: 'button',
              title: workspacesOpen ? t('collapse') : t('expand'),
              onClick: () => setWorkspacesOpen((open) => !open),
            },
            h('span', { className: workspacesOpen ? 'tsb-chev is-open' : 'tsb-chev' }, triangleIcon()),
            h('span', { className: 'tsb-head-label' }, t('workspaces')),
            renderActiveMark(workspacesActive, 'workspaces-active'),
            h('span', { className: 'tsb-count' }, String(plainWorkspaces.length)),
          ),
          h(
            'button',
            {
              className: 'tsb-add',
              type: 'button',
              title: t('newWorkspace'),
              disabled: busy !== '' || canCreate === false,
              onClick: addWorkspace,
            },
            '＋',
          ),
        )

        return h(
          'div',
          { className: 'tsb-root', 'data-task-folders': REGION_ID },
          // 常驻头：标题 + 展开时的搜索框（照内置侧栏的 sectionHeader，不参与滚动）。
          h(
            'div',
            { className: 'tsb-top', ref: searchTop },
            h(
              'div',
              { className: 'tsb-caption' },
              folderIcon({ size: 14, className: 'tsb-caption-icon' }),
              h('span', null, t('project')),
              // 最顶上这一层也汇总：任务组与工作区组都折起来时，至少这里还亮着。
              renderActiveMark(allActive, 'caption-active'),
              // 标题右侧：搜索（Ctrl/⌘+K）与视图选项（归档过滤三档）——内置侧栏这两样都在这一带。
              h(
                'div',
                { className: 'tsb-header-actions' },
                h(
                  'button',
                  {
                    // 展开时这颗放大镜自己也是「收起」按钮，亮一下底告诉人它正开着。
                    className: searchOpen ? 'tsb-icon is-active' : 'tsb-icon',
                    type: 'button',
                    title: searchOpen ? t('searchClose') : t('search'),
                    'aria-label': searchOpen ? t('searchClose') : t('search'),
                    'aria-expanded': searchOpen,
                    onClick: () => {
                      // 开 / 关同一个入口：开着就收（清词 + 收框），关着才铺开并抢焦点。
                      // 内置侧栏的开关在框尾那颗 ✕ 上，这里两个都给，第一下点哪儿都能关。
                      if (searchOpen) {
                        closeSearch()
                        return
                      }
                      setSearchOpen(true)
                      setTimeout(() => searchInput.current?.focus?.(), 0)
                    },
                  },
                  searchIcon(14),
                ),
                h(
                  'button',
                  {
                    className: 'tsb-icon',
                    type: 'button',
                    title: t('viewOptions'),
                    onClick: (event) => {
                      event.stopPropagation()
                      openMenu(menu !== null && menu.kind === 'view' ? null : { kind: 'view' }, event.currentTarget)
                    },
                  },
                  ellipsisIcon(14),
                ),
                menu !== null && menu.kind === 'view' ? renderMenu(viewMenuItems, 'menu:view') : null,
              ),
            ),

            // 顶部提示条（删除会话的二次确认 / 删成功与复制成功的反馈）。
            // 画在常驻头里：位置固定，不会被列表滚走，也不会在列表中间突然顶出一行。
            renderTopNotice(),

            searchOpen
              ? h(
                  'div',
                  { className: 'tsb-search', key: 'search-box' },
                  searchIcon(12),
                  h('input', {
                    className: 'tsb-search-input',
                    type: 'text',
                    value: query,
                    placeholder: t('searchPlaceholder'),
                    ref: searchInput,
                    onChange: (event) => setQuery(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Escape') closeSearch()
                    },
                  }),
                  // 框尾那颗 ✕ **常显**（内置侧栏的 clearButton 也是展开就有）：
                  // 有词时它清词 + 收框，空词时它照样把框收掉——这就是「关得掉」的那一下。
                  h(
                    'button',
                    {
                      className: 'tsb-icon tsb-search-close',
                      type: 'button',
                      // 有词时说「清除」，空词时说「收起」——同一个动作，两种说法各自贴切。
                      title: query !== '' ? t('searchClear') : t('searchClose'),
                      'aria-label': query !== '' ? t('searchClear') : t('searchClose'),
                      onClick: closeSearch,
                    },
                    '✕',
                  ),
                )
              : null,
          ),

          // 唯一的一层滚动：任务按天 / 工作区 / 归档组 / 提示都在这里滚。
          h(
            'div',
            { className: 'tsb-scroll' },
            searching ? renderSearchResults() : [tasksGroup, tasksOpen ? h('div', { className: 'tsb-rows', key: 'tasks-rows' }, renderTaskDays()) : null],

            searching
              ? null
              : [
                  workspacesGroup,
                  workspacesOpen
                    ? plainWorkspaces.length === 0
                      ? h('div', { className: 'tsb-notice', key: 'ws-empty' }, t('noWorkspace'))
                      : h(
                          'div',
                          { className: 'tsb-rows', key: 'ws-rows' },
                          plainWorkspaces.map((workspace) => renderWorkspace(workspace)),
                        )
                    : null,
                  renderArchivedProjects(),
                ],

            error !== '' ? h('div', { className: 'tsb-notice is-error' }, error) : null,
            staleHost ? h('div', { className: 'tsb-notice is-error' }, t('errorStaleHost')) : null,
            canCreate === false ? h('div', { className: 'tsb-notice' }, t('canNotCreate')) : null,
          ),
        )
      }
    }

    // ================= v0.8：设置 → 技能 =================
    //
    // 设置壳（ui-settings-general）把导航投影成 `settings.section` 账本，一页一个注册项；
    // 我们这一页只做三件事：
    //   1. 读：`ctx.skills` 已经把官方 bundled、用户目录、项目目录与运行时注册的技能合并好了，
    //      这里按来源分类（官方 / 我的 / 项目 / 其他），并标出哪些能删（只有用户技能根里的）；
    //   2. 装：拖目录 / 选 SKILL.md / 表单新建，统一交给 Host 的 `/task-folders/api/installSkill`，
    //      由它先落临时目录再整目录 rename；
    //   3. 删：只对 `<DSH_HOME>/skills` 里的技能露出删除按钮，Host 侧还有一道 403 兜底。
    //
    // 关键取舍：**列表与正文都以 Host 的注册表为准**，客户端不自己扫盘——否则分类、重名裁决、
    // 项目根定位都会和 DSH 自己的技能目录对不上。客户端只做「把用户选的文件读成字节」这一件事。

    /** 上传上限：与 Host 的 lib/skills.js 保持一致（客户端先拦，省得白传 8MB）。 */
    const SKILL_TOTAL_LIMIT = 8 * 1024 * 1024
    const SKILL_FILE_LIMIT = 2 * 1024 * 1024
    const SKILL_FILE_COUNT = 120

    /** 分类顺序与词典键。`other` 只在真有来源不明的技能时露出来。 */
    const SKILL_CATEGORY_LABEL = {
      all: 'skillsAll',
      official: 'skillsOfficial',
      user: 'skillsUser',
      project: 'skillsProject',
      runtime: 'skillsRuntime',
      other: 'skillsOther',
    }
    const SKILL_CATEGORY_RANK = { official: 0, user: 1, project: 2, runtime: 3, other: 4 }

    /** 来源 → 角标文案。未知来源直接把 source 原样显示，别藏。 */
    const SKILL_SOURCE_LABEL = {
      bundled: 'skillsSourceBundled',
      'user-dsh': 'skillsSourceUserDsh',
      'user-agents': 'skillsSourceUserAgents',
      custom: 'skillsSourceCustom',
      'project-dsh': 'skillsSourceProjectDsh',
      'project-agents': 'skillsSourceProjectAgents',
      runtime: 'skillsSourceRuntime',
    }

    /**
     * 来源分类（Host 一般已经给了 `category`；这里做兜底，保证老 Host 也能分类）。
     * @param {string} source - `SkillSummary.source`。
     * @returns {'official'|'user'|'project'|'runtime'|'other'} 分类。
     */
    function skillCategoryOf(source) {
      if (source === 'bundled') return 'official'
      if (source === 'user-dsh' || source === 'user-agents' || source === 'custom') return 'user'
      if (source === 'project-dsh' || source === 'project-agents') return 'project'
      if (source === 'runtime') return 'runtime'
      return 'other'
    }

    /**
     * 分类兜底读取。
     * @param {object} skill - Host 投影的技能视图。
     * @returns {string} 分类。
     */
    function categoryOf(skill) {
      return typeof skill?.category === 'string' && skill.category !== '' ? skill.category : skillCategoryOf(skill?.source)
    }

    /**
     * 来源角标：优先词典，未知来源原样显示。
     * @param {(key: string) => string} t - 词典绑定。
     * @param {string} source - 来源。
     * @returns {string} 展示文本。
     */
    function skillSourceText(t, source) {
      const key = SKILL_SOURCE_LABEL[source]
      return key === undefined ? String(source ?? '') : t(key)
    }

    /**
     * 调用方式角标。
     * @param {(key: string) => string} t - 词典绑定。
     * @param {{modelInvocable?: boolean, userInvocable?: boolean}} invocation - 调用策略。
     * @returns {string} 展示文本。
     */
    function skillInvocationText(t, invocation) {
      const model = invocation?.modelInvocable !== false
      const user = invocation?.userInvocable !== false
      if (model && user) return t('skillsModelUser')
      if (model) return t('skillsModelOnly')
      if (user) return t('skillsUserOnly')
      return ''
    }

    /**
     * 人类可读的字节数。
     * @param {number} bytes - 字节。
     * @returns {string} `12 KB` / `1.2 MB`。
     */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    /**
     * 规整上传相对路径（与 Host 侧同一套规则；越界返回 undefined）。
     * @param {string} value - 原始路径。
     * @returns {string|undefined} 规整后的路径。
     */
    function normalizeUploadPath(value) {
      if (typeof value !== 'string') return undefined
      const cleaned = value.replace(/\\/g, '/').replace(/^\.\//, '').trim()
      if (cleaned === '' || cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) return undefined
      const parts = cleaned.split('/').filter((part) => part !== '' && part !== '.')
      if (parts.length === 0 || parts.some((part) => part === '..' || part.includes('\u0000'))) return undefined
      return parts.join('/')
    }

    /**
     * 目录上传去掉公共根（与 Host 侧一致：多文件才去根；单文件只有「目录里的 SKILL.md」才去）。
     * @param {{path: string}[]} files - 文件列表。
     * @returns {{path: string}[]} 处理后的列表。
     */
    function stripUploadRoot(files) {
      if (files.length === 0) return files
      const segments = files.map((file) => file.path.split('/'))
      const root = segments[0][0]
      if (!segments.every((parts) => parts.length > 1 && parts[0] === root)) return files
      if (files.length === 1 && segments[0][1].toLowerCase() !== 'skill.md') return files
      return files.map((file, index) => ({ ...file, path: segments[index].slice(1).join('/') }))
    }

    /**
     * 客户端预览用的 frontmatter 读取（只认顶层简单标量；真正的校验在 Host）。
     * @param {string} text - SKILL.md 全文。
     * @returns {{name?: string, description?: string}} 识别结果。
     */
    function detectSkillHeader(text) {
      if (typeof text !== 'string') return {}
      const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/u.exec(text)
      if (match === null) return {}
      const result = {}
      for (const line of match[1].split(/\r?\n/)) {
        const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
        if (field === null) continue
        let value = field[2].trim()
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
          try {
            value = JSON.parse(value)
          } catch {
            value = value.slice(1, -1)
          }
        } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
          value = value.slice(1, -1).replace(/''/g, "'")
        }
        if (field[1] === 'name' || field[1] === 'description') result[field[1]] = value
      }
      return result
    }

    /**
     * ArrayBuffer → base64（分块，避免 `String.fromCharCode(...几 MB)` 爆栈）。
     * @param {ArrayBuffer} buffer - 字节。
     * @returns {string} base64。
     */
    function base64FromBuffer(buffer) {
      const bytes = new Uint8Array(buffer)
      const chunk = 0x8000
      let binary = ''
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
      }
      return btoa(binary)
    }

    /**
     * 从拖放事件里递归收集文件（目录也能拖）。拿不到 `webkitGetAsEntry` 就退回 files。
     * @param {DataTransfer|undefined} dataTransfer - 拖放数据。
     * @returns {Promise<{path: string, file: File}[]>} 文件列表。
     */
    async function collectDroppedFiles(dataTransfer) {
      const entries = []
      const items = dataTransfer?.items
      if (items !== undefined && items !== null && items.length > 0 && typeof items[0]?.webkitGetAsEntry === 'function') {
        for (const item of items) {
          const entry = item.webkitGetAsEntry()
          if (entry !== null && entry !== undefined) await walkDroppedEntry(entry, '', entries)
        }
      }
      if (entries.length === 0) {
        for (const file of dataTransfer?.files ?? []) {
          entries.push({ path: file.webkitRelativePath || file.name, file })
        }
      }
      return entries
    }

    /**
     * 递归读一个拖放条目。
     * @param {object} entry - FileSystemEntry。
     * @param {string} prefix - 已经走过的目录前缀。
     * @param {{path: string, file: File}[]} out - 收集器。
     * @returns {Promise<void>} 完成。
     */
    async function walkDroppedEntry(entry, prefix, out) {
      if (entry.isFile === true) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
        out.push({ path: `${prefix}${file.name}`, file })
        return
      }
      if (entry.isDirectory !== true) return
      const reader = entry.createReader()
      const children = []
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
        if (batch.length === 0) break
        children.push(...batch)
      }
      for (const child of children) await walkDroppedEntry(child, `${prefix}${entry.name}/`, out)
    }

    /**
     * 把用户选的文件整理成一次可安装的技能（客户端预览）。
     * @param {{path: string, file: File}[]} entries - 文件列表。
     * @param {(key: string) => string} t - 词典绑定。
     * @returns {Promise<{files: {path: string, file: File, size: number}[], name: string, description: string, hasSkillMd: boolean}>} 整理结果。
     */
    async function prepareUploadEntries(entries, t) {
      const files = []
      let total = 0
      for (const entry of Array.isArray(entries) ? entries : []) {
        const rel = normalizeUploadPath(entry?.path)
        if (rel === undefined || entry?.file === undefined) continue
        const size = typeof entry.file.size === 'number' ? entry.file.size : 0
        if (size > SKILL_FILE_LIMIT) {
          throw new Error(`${rel}：${t('skillsTooLarge').replace('{size}', formatBytes(SKILL_FILE_LIMIT))}`)
        }
        total += size
        files.push({ path: rel, file: entry.file, size })
      }
      if (files.length === 0) throw new Error(t('skillsNoFiles'))
      if (files.length > SKILL_FILE_COUNT) {
        throw new Error(t('skillsTooLarge').replace('{size}', formatBytes(SKILL_TOTAL_LIMIT)))
      }
      if (total > SKILL_TOTAL_LIMIT) {
        throw new Error(t('skillsTooLarge').replace('{size}', formatBytes(SKILL_TOTAL_LIMIT)))
      }

      let prepared = stripUploadRoot(files)
      let skillIndex = prepared.findIndex((file) => file.path.toLowerCase() === 'skill.md')
      if (skillIndex < 0 && prepared.length === 1 && /^[^/]+\.md$/i.test(prepared[0].path)) {
        prepared = [{ ...prepared[0], path: 'SKILL.md' }]
        skillIndex = 0
      }
      let name = ''
      let description = ''
      if (skillIndex >= 0 && typeof prepared[skillIndex].file.text === 'function') {
        const header = detectSkillHeader(await prepared[skillIndex].file.text())
        name = typeof header.name === 'string' ? header.name : ''
        description = typeof header.description === 'string' ? header.description : ''
      }
      return { files: prepared, name, description, hasSkillMd: skillIndex >= 0 }
    }

    /**
     * 造「设置 → 技能」页组件。
     * @param {object} ctx - 客户端插件上下文（读当前会话 cwd，供项目技能根定位）。
     * @returns {Function} React 组件。
     */
    function createSkillsSection(ctx) {
      /**
       * 兜底翻译器：设置壳通常会把页面词典绑定成 `props.t` 递进来（`locale` 注册项），
       * 但不同 DSH 版本对 slot 组件的 props 注入不完全一致。`ctx.locale.bind(NS)` 是我们
       * 自己注册的同一份词典，拿它兜底，页面永远不会退化成 `skillsTitle` 这种键名。
       */
      const boundT = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : null

      /**
       * 当前会话的 cwd + id：cwd 定位项目技能根，id 让 Host 复用这个会话的预设层
       * （`agentPresets.serviceFor`）。拿不到就都不传，Host 退回默认预设 / 默认目录。
       * @returns {{cwd?: string, sessionId?: string}} 当前会话信息。
       */
      function currentSession() {
        try {
          const binding = ctx.get('uiSession')?.current?.getSnapshot?.()
          const candidates = [
            binding?.session?.header?.cwd,
            binding?.session?.cwd,
            binding?.cwd,
            binding?.entry?.session?.header?.cwd,
          ]
          const cwd = candidates.find((candidate) => typeof candidate === 'string' && candidate !== '')
          const sessionId =
            typeof binding?.sessionId === 'string'
              ? binding.sessionId
              : typeof binding?.key === 'string'
                ? binding.key
                : undefined
          return {
            ...(cwd === undefined ? {} : { cwd }),
            ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
          }
        } catch {
          /* 读不到就当没有当前会话 */
        }
        return {}
      }

      /**
       * 把失败原因变成一句人话。
       * @param {unknown} failure - 异常。
       * @returns {string} 消息。
       */
      function messageOf(failure) {
        return failure instanceof Error ? failure.message : String(failure)
      }

      /**
       * 设置页：技能列表 + 上传/新建 + 详情/删除。
       * @param {object} props - 设置壳给的 props（`t` 来自 locale 绑定）。
       * @returns {object} React 元素。
       */
      return function SkillsSection(props) {
        const t = typeof props?.t === 'function' ? props.t : boundT ?? ((key) => key)
        const [data, setData] = React.useState(null)
        const [loading, setLoading] = React.useState(true)
        const [error, setError] = React.useState('')
        const [ui, setUi] = React.useState({ query: '', filter: 'all', modal: null, notice: '', busy: '' })
        const [detail, setDetail] = React.useState({ loading: false, content: '', error: '', truncated: false })
        const [upload, setUpload] = React.useState({
          files: [],
          name: '',
          description: '',
          reading: false,
          error: '',
          hasSkillMd: false,
          dragging: false,
        })
        const [draft, setDraft] = React.useState({ name: '', description: '', whenToUse: '', body: '', error: '' })
        const [conflict, setConflict] = React.useState('')
        const [confirmDelete, setConfirmDelete] = React.useState(false)
        const mounted = React.useRef(true)
        const fileInput = React.useRef(null)
        const folderInput = React.useRef(null)

        React.useEffect(
          () => () => {
            mounted.current = false
          },
          [],
        )

        /** 读一份技能列表；失败只落在页内，不白屏。 */
        const refresh = React.useCallback(async () => {
          setLoading(true)
          setError('')
          try {
            const session = currentSession()
            const value = await callHost('skills', session)
            if (mounted.current) setData(value)
          } catch (failure) {
            if (mounted.current) setError(messageOf(failure))
          } finally {
            if (mounted.current) setLoading(false)
          }
        }, [])

        React.useEffect(() => {
          void refresh()
        }, [refresh])

        /**
         * 安装成功后等目录刷新：dsh-skill-filesystem 监视磁盘，新技能通常几百毫秒内进目录。
         * 轮询有上限，等不到也把最后一次结果留在页面上，不把成功说成失败。
         * @param {string} name - 刚安装的技能名。
         */
        const refreshAfterInstall = React.useCallback(async (name) => {
          for (let attempt = 0; attempt < 12; attempt += 1) {
            try {
              const session = currentSession()
              const value = await callHost('skills', session)
              if (!mounted.current) return
              setData(value)
              if (Array.isArray(value?.skills) && value.skills.some((skill) => skill.name === name)) return
            } catch {
              /* 下一次再试 */
            }
            await new Promise((resolve) => setTimeout(resolve, 300))
          }
        }, [])

        /**
         * 删除成功后等目录刷新：和安装一样轮询，确认这条真的从注册表里消失再停。
         * @param {string} name - 刚删除的技能名。
         */
        const refreshAfterDelete = React.useCallback(async (name) => {
          for (let attempt = 0; attempt < 12; attempt += 1) {
            try {
              const value = await callHost('skills', currentSession())
              if (!mounted.current) return
              setData(value)
              if (!Array.isArray(value?.skills) || !value.skills.some((skill) => skill.name === name)) return
            } catch {
              /* 下一次再试 */
            }
            await new Promise((resolve) => setTimeout(resolve, 300))
          }
        }, [])

        /** 关掉弹窗，顺手清掉冲突与二次确认状态。 */
        const closeModal = React.useCallback(() => {
          setUi((previous) => ({ ...previous, modal: null, busy: '' }))
          setConflict('')
          setConfirmDelete(false)
          setDetail({ loading: false, content: '', error: '', truncated: false })
        }, [])

        // 弹窗打开时截住 Escape：设置壳自己也监听 Escape（会把整个设置面板关掉），
        // 在 window 捕获阶段先停掉传播，只关我们这一层，别把用户填了一半的表单一起关掉。
        React.useEffect(() => {
          if (ui.modal === null) return undefined
          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            closeModal()
          }
          window.addEventListener('keydown', onKeyDown, true)
          return () => window.removeEventListener('keydown', onKeyDown, true)
        }, [ui.modal, closeModal])

        /**
         * 打开详情：正文按名字现取（列表只带摘要，不带 body）。
         * @param {object} skill - 列表里的技能。
         */
        const openDetail = React.useCallback(async (skill) => {
          setUi((previous) => ({ ...previous, modal: { kind: 'detail', skill }, notice: '' }))
          setConflict('')
          setConfirmDelete(false)
          setDetail({ loading: true, content: '', error: '', truncated: false })
          try {
            const session = currentSession()
            const value = await callHost('skillDetail', { ...session, name: skill.name })
            if (mounted.current) {
              setDetail({
                loading: false,
                content: typeof value?.content === 'string' ? value.content : '',
                error: '',
                truncated: value?.truncated === true,
              })
            }
          } catch (failure) {
            if (mounted.current) setDetail({ loading: false, content: '', error: messageOf(failure), truncated: false })
          }
        }, [])

        /** 打开上传弹窗：清掉上一次选的文件。 */
        const openUpload = React.useCallback(() => {
          setUpload({ files: [], name: '', description: '', reading: false, error: '', hasSkillMd: false, dragging: false })
          setConflict('')
          setUi((previous) => ({ ...previous, modal: { kind: 'upload' }, busy: '', notice: '' }))
        }, [])

        /** 打开新建弹窗。 */
        const openCreate = React.useCallback(() => {
          setDraft({ name: '', description: '', whenToUse: '', body: '', error: '' })
          setConflict('')
          setUi((previous) => ({ ...previous, modal: { kind: 'create' }, busy: '', notice: '' }))
        }, [])

        /**
         * 收文件：读成「路径 + File」并识别 SKILL.md 的名字/描述。
         * @param {{path: string, file: File}[]} entries - 文件列表。
         */
        const ingestFiles = React.useCallback(
          async (entries) => {
            setConflict('')
            setUpload((previous) => ({ ...previous, files: [], reading: true, error: '', name: '', description: '' }))
            try {
              const prepared = await prepareUploadEntries(entries, t)
              if (mounted.current) setUpload({ ...prepared, reading: false, error: '', dragging: false })
            } catch (failure) {
              if (mounted.current) {
                setUpload((previous) => ({ ...previous, reading: false, dragging: false, error: messageOf(failure) }))
              }
            }
          },
          [t],
        )

        /**
         * 从 `<input type="file">` 收文件。
         * @param {object} event - change 事件。
         */
        const onPicked = React.useCallback(
          (event) => {
            const files = [...(event?.target?.files ?? [])]
            if (typeof event?.target?.value === 'string') event.target.value = ''
            void ingestFiles(files.map((file) => ({ path: file.webkitRelativePath || file.name, file })))
          },
          [ingestFiles],
        )

        /**
         * 拖放：目录递归，文件直取。
         * @param {object} event - drop 事件。
         */
        const onDrop = React.useCallback(
          async (event) => {
            event.preventDefault()
            setUpload((previous) => ({ ...previous, dragging: false }))
            const entries = await collectDroppedFiles(event.dataTransfer)
            void ingestFiles(entries)
          },
          [ingestFiles],
        )

        /**
         * 安装上传的目录 / 文件。
         * @param {boolean} overwrite - 同名时是否覆盖。
         */
        const installUpload = React.useCallback(
          async (overwrite) => {
            if (upload.files.length === 0 || ui.busy === 'install') return
            setUpload((previous) => ({ ...previous, error: '' }))
            setUi((previous) => ({ ...previous, busy: 'install' }))
            try {
              const files = []
              for (const entry of upload.files) {
                const buffer = await entry.file.arrayBuffer()
                files.push({ path: entry.path, data: base64FromBuffer(buffer) })
              }
              const value = await callHost('installSkill', { files, overwrite }, 60_000)
              if (!mounted.current) return
              setUi((previous) => ({
                ...previous,
                modal: null,
                busy: '',
                notice: t('skillsInstalled').replace('{name}', value?.name ?? ''),
              }))
              setConflict('')
              void refreshAfterInstall(value?.name ?? '')
            } catch (failure) {
              if (!mounted.current) return
              const message = messageOf(failure)
              if (failure?.code === 'skill-exists') setConflict(upload.name)
              setUpload((previous) => ({ ...previous, error: message }))
              setUi((previous) => ({ ...previous, busy: '' }))
            }
          },
          [upload, ui.busy, t, refreshAfterInstall],
        )

        /**
         * 安装「新建技能」表单。
         * @param {boolean} overwrite - 同名时是否覆盖。
         */
        const installDraft = React.useCallback(
          async (overwrite) => {
            if (ui.busy === 'install') return
            const name = draft.name.trim()
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
              setDraft((previous) => ({ ...previous, error: `${t('skillsName')}：${t('skillsNameHint')}` }))
              return
            }
            if (draft.description.trim() === '') {
              setDraft((previous) => ({ ...previous, error: t('skillsDescription') }))
              return
            }
            setDraft((previous) => ({ ...previous, error: '' }))
            setUi((previous) => ({ ...previous, busy: 'install' }))
            try {
              const value = await callHost(
                'installSkill',
                {
                  draft: {
                    name,
                    description: draft.description.trim(),
                    whenToUse: draft.whenToUse.trim(),
                    body: draft.body,
                  },
                  overwrite,
                },
                60_000,
              )
              if (!mounted.current) return
              setUi((previous) => ({
                ...previous,
                modal: null,
                busy: '',
                notice: t('skillsInstalled').replace('{name}', value?.name ?? name),
              }))
              setConflict('')
              void refreshAfterInstall(value?.name ?? name)
            } catch (failure) {
              if (!mounted.current) return
              if (failure?.code === 'skill-exists') setConflict(name)
              setDraft((previous) => ({ ...previous, error: messageOf(failure) }))
              setUi((previous) => ({ ...previous, busy: '' }))
            }
          },
          [draft, ui.busy, t, refreshAfterInstall],
        )

        /**
         * 删除一个用户技能（Host 侧还会再验一次路径）。
         * @param {object} skill - 当前详情里的技能。
         */
        const removeSkill = React.useCallback(
          async (skill) => {
            if (ui.busy === 'delete') return
            setUi((previous) => ({ ...previous, busy: 'delete' }))
            try {
              await callHost('deleteSkill', { name: skill.name, path: skill.path })
              if (!mounted.current) return
              setUi((previous) => ({
                ...previous,
                busy: '',
                modal: null,
                notice: t('skillsDeleted').replace('{name}', skill.name),
              }))
              setConfirmDelete(false)
              void refreshAfterDelete(skill.name)
            } catch (failure) {
              if (!mounted.current) return
              setDetail((previous) => ({ ...previous, error: messageOf(failure) }))
              setUi((previous) => ({ ...previous, busy: '' }))
            }
          },
          [ui.busy, t, refreshAfterDelete],
        )

        const allSkills = Array.isArray(data?.skills) ? data.skills : []
        const sorted = allSkills
          .slice()
          .sort(
            (left, right) =>
              (SKILL_CATEGORY_RANK[categoryOf(left)] ?? 9) - (SKILL_CATEGORY_RANK[categoryOf(right)] ?? 9) ||
              String(left.name).localeCompare(String(right.name)),
          )
        const counts = { all: sorted.length, official: 0, user: 0, project: 0, runtime: 0, other: 0 }
        for (const skill of sorted) counts[categoryOf(skill)] = (counts[categoryOf(skill)] ?? 0) + 1
        const categories = ['all', 'official', 'user', 'project']
        // 「其他」只在本机真有运行时 / 未知来源技能时露脸；空分类不占一行位置。
        if (counts.runtime > 0) categories.push('runtime')
        if (counts.other > 0) categories.push('other')
        const query = ui.query.trim().toLowerCase()
        const filtered = sorted.filter((skill) => {
          if (ui.filter !== 'all' && categoryOf(skill) !== ui.filter) return false
          if (query === '') return true
          return `${skill.name} ${skill.description}`.toLowerCase().includes(query)
        })

        /**
         * 一行技能。
         * @param {object} skill - 技能视图。
         * @returns {object} React 元素。
         */
        function renderRow(skill) {
          const category = categoryOf(skill)
          const invocation = skillInvocationText(t, skill.invocation)
          return h(
            'button',
            {
              key: skill.name,
              className: 'tsk-row',
              type: 'button',
              title: t('skillsDetail'),
              onClick: () => void openDetail(skill),
            },
            h(
              'span',
              { className: 'tsk-row-head' },
              h('span', { className: 'tsk-name' }, skill.name),
              h(
                'span',
                { className: category === 'official' ? 'tsk-badge is-official' : 'tsk-badge' },
                skillSourceText(t, skill.source),
              ),
              invocation === '' ? null : h('span', { className: 'tsk-badge' }, invocation),
            ),
            h('span', { className: 'tsk-desc' }, skill.description || t('skillsNoDescription')),
            typeof skill.path === 'string' && skill.path !== '' ? h('span', { className: 'tsk-path' }, skill.path) : null,
          )
        }

        /**
         * 详情弹窗。
         * @param {object} skill - 技能视图。
         * @returns {object} React 元素。
         */
        function renderDetail(skill) {
          return h(
            'div',
            { className: 'tsk-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('skillsDetail') },
            h(
              'div',
              { className: 'tsk-modal-head' },
              h('h3', { className: 'tsk-modal-title' }, skill.name),
              h('span', { className: 'tsk-badge' }, skillSourceText(t, skill.source)),
            ),
            h(
              'div',
              { className: 'tsk-modal-body' },
              h('span', { className: 'tsk-desc' }, skill.description || t('skillsNoDescription')),
              skill.whenToUse ? h('span', { className: 'tsk-hint' }, skill.whenToUse) : null,
              h(
                'div',
                { className: 'tsk-hint' },
                `${t('skillsPath')}：${skill.path || '—'}　·　${t('skillsInvocation')}：${skillInvocationText(t, skill.invocation) || '—'}`,
              ),
              detail.loading ? h('div', { className: 'tsk-empty' }, t('skillsDetailLoading')) : null,
              detail.error !== '' ? h('div', { className: 'tsk-notice is-error' }, detail.error) : null,
              !detail.loading && (detail.content !== '' || detail.error === '')
                ? h('pre', { className: 'tsk-content' }, detail.content === '' ? t('skillsNoDescription') : detail.content)
                : null,
              detail.truncated === true ? h('div', { className: 'tsk-hint' }, t('skillsTruncated')) : null,
              detail.error !== '' && !skill.userManaged
                ? h('div', { className: 'tsk-hint' }, t('skillsHidden'))
                : null,
            ),
            h(
              'div',
              { className: 'tsk-modal-foot' },
              h('span', { className: 'tsk-hint' }, skill.userManaged ? t('skillsUserRoot').replace('{path}', data?.userRoot ?? '') : ''),
              confirmDelete
                ? [
                    h('span', { className: 'tsk-hint', key: 'confirm' }, t('skillsDeleteConfirm').replace('{name}', skill.name)),
                    h('button', { className: 'tsk-btn', type: 'button', key: 'cancel', onClick: () => setConfirmDelete(false) }, t('skillsCancel')),
                    h(
                      'button',
                      {
                        className: 'tsk-btn is-danger',
                        type: 'button',
                        key: 'delete',
                        disabled: ui.busy === 'delete',
                        onClick: () => void removeSkill(skill),
                      },
                      t('skillsDelete'),
                    ),
                  ]
                : [
                    skill.userManaged
                      ? h('button', { className: 'tsk-btn is-danger', type: 'button', key: 'delete', onClick: () => setConfirmDelete(true) }, t('skillsDelete'))
                      : null,
                    h('button', { className: 'tsk-btn', type: 'button', key: 'close', onClick: closeModal }, t('skillsClose')),
                  ],
            ),
          )
        }

        /**
         * 上传弹窗。
         * @returns {object} React 元素。
         */
        function renderUpload() {
          const busy = ui.busy === 'install'
          return h(
            'div',
            { className: 'tsk-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('skillsUploadTitle') },
            h('div', { className: 'tsk-modal-head' }, h('h3', { className: 'tsk-modal-title' }, t('skillsUploadTitle'))),
            h(
              'div',
              { className: 'tsk-modal-body' },
              h(
                'div',
                {
                  className: upload.dragging ? 'tsk-drop is-over' : 'tsk-drop',
                  onDragOver: (event) => {
                    event.preventDefault()
                    setUpload((previous) => ({ ...previous, dragging: true }))
                  },
                  onDragLeave: () => setUpload((previous) => ({ ...previous, dragging: false })),
                  onDrop: (event) => void onDrop(event),
                },
                h('span', {}, upload.dragging ? t('skillsDropHere') : t('skillsUploadHint')),
                h(
                  'span',
                  { className: 'tsk-toolbar' },
                  h('button', { className: 'tsk-btn', type: 'button', onClick: () => folderInput.current?.click?.() }, t('skillsChooseFolder')),
                  h('button', { className: 'tsk-btn', type: 'button', onClick: () => fileInput.current?.click?.() }, t('skillsChooseFiles')),
                ),
                h('input', { type: 'file', multiple: true, webkitdirectory: '', directory: '', ref: folderInput, style: { display: 'none' }, onChange: onPicked }),
                h('input', { type: 'file', multiple: true, ref: fileInput, style: { display: 'none' }, onChange: onPicked }),
              ),
              upload.reading ? h('div', { className: 'tsk-empty' }, t('skillsReading')) : null,
              upload.error !== '' ? h('div', { className: 'tsk-notice is-error' }, upload.error) : null,
              upload.name !== ''
                ? h('div', { className: 'tsk-hint' }, t('skillsDetected').replace('{name}', upload.name))
                : upload.files.length > 0
                  ? h('div', { className: 'tsk-hint' }, t('skillsNotDetected'))
                  : null,
              upload.description !== '' ? h('span', { className: 'tsk-desc' }, upload.description) : null,
              upload.files.length === 0
                ? h('div', { className: 'tsk-hint' }, t('skillsNoFiles'))
                : h(
                    'div',
                    { className: 'tsk-files' },
                    h('div', { className: 'tsk-hint' }, `${t('skillsFiles')}（${upload.files.length}）`),
                    upload.files.map((file) =>
                      h(
                        'div',
                        { className: 'tsk-file', key: file.path },
                        h('span', { className: 'tsk-file-name' }, file.path),
                        h('span', { className: 'tsk-file-size' }, formatBytes(file.size)),
                      ),
                    ),
                  ),
              data?.userRoot ? h('div', { className: 'tsk-hint' }, t('skillsUserRoot').replace('{path}', data.userRoot)) : null,
            ),
            h(
              'div',
              { className: 'tsk-modal-foot' },
              conflict === upload.name && upload.name !== ''
                ? h('span', { className: 'tsk-hint' }, t('skillsExists'))
                : h('span', { className: 'tsk-hint' }),
              h('button', { className: 'tsk-btn', type: 'button', onClick: closeModal }, t('skillsCancel')),
              conflict === upload.name && upload.name !== ''
                ? h(
                    'button',
                    { className: 'tsk-btn is-primary', type: 'button', disabled: busy, onClick: () => void installUpload(true) },
                    busy ? t('skillsInstalling') : t('skillsOverwrite'),
                  )
                : h(
                    'button',
                    {
                      className: 'tsk-btn is-primary',
                      type: 'button',
                      disabled: busy || upload.files.length === 0 || upload.reading,
                      onClick: () => void installUpload(false),
                    },
                    busy ? t('skillsInstalling') : t('skillsInstall'),
                  ),
            ),
          )
        }

        /**
         * 新建技能弹窗。
         * @returns {object} React 元素。
         */
        function renderCreate() {
          const busy = ui.busy === 'install'
          return h(
            'div',
            { className: 'tsk-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('skillsNewTitle') },
            h('div', { className: 'tsk-modal-head' }, h('h3', { className: 'tsk-modal-title' }, t('skillsNewTitle'))),
            h(
              'div',
              { className: 'tsk-modal-body' },
              h(
                'label',
                { className: 'tsk-field' },
                h('span', { className: 'tsk-label' }, t('skillsName')),
                h('input', {
                  className: 'tsk-input',
                  type: 'text',
                  value: draft.name,
                  placeholder: 'report-builder',
                  onChange: (event) => setDraft((previous) => ({ ...previous, name: event.target.value })),
                }),
                h('span', { className: 'tsk-hint' }, t('skillsNameHint')),
              ),
              h(
                'label',
                { className: 'tsk-field' },
                h('span', { className: 'tsk-label' }, t('skillsDescription')),
                h('input', {
                  className: 'tsk-input',
                  type: 'text',
                  value: draft.description,
                  onChange: (event) => setDraft((previous) => ({ ...previous, description: event.target.value })),
                }),
                h('span', { className: 'tsk-hint' }, t('skillsDescriptionHint')),
              ),
              h(
                'label',
                { className: 'tsk-field' },
                h('span', { className: 'tsk-label' }, t('skillsWhenToUse')),
                h('input', {
                  className: 'tsk-input',
                  type: 'text',
                  value: draft.whenToUse,
                  onChange: (event) => setDraft((previous) => ({ ...previous, whenToUse: event.target.value })),
                }),
              ),
              h(
                'label',
                { className: 'tsk-field' },
                h('span', { className: 'tsk-label' }, t('skillsBody')),
                h('textarea', {
                  className: 'tsk-textarea',
                  value: draft.body,
                  onChange: (event) => setDraft((previous) => ({ ...previous, body: event.target.value })),
                }),
              ),
              draft.error !== '' ? h('div', { className: 'tsk-notice is-error' }, draft.error) : null,
              data?.userRoot ? h('div', { className: 'tsk-hint' }, t('skillsUserRoot').replace('{path}', data.userRoot)) : null,
            ),
            h(
              'div',
              { className: 'tsk-modal-foot' },
              conflict === draft.name.trim() && draft.name.trim() !== ''
                ? h('span', { className: 'tsk-hint' }, t('skillsExists'))
                : h('span', { className: 'tsk-hint' }),
              h('button', { className: 'tsk-btn', type: 'button', onClick: closeModal }, t('skillsCancel')),
              conflict === draft.name.trim() && draft.name.trim() !== ''
                ? h(
                    'button',
                    { className: 'tsk-btn is-primary', type: 'button', disabled: busy, onClick: () => void installDraft(true) },
                    busy ? t('skillsInstalling') : t('skillsOverwrite'),
                  )
                : h(
                    'button',
                    { className: 'tsk-btn is-primary', type: 'button', disabled: busy, onClick: () => void installDraft(false) },
                    busy ? t('skillsInstalling') : t('skillsInstall'),
                  ),
            ),
          )
        }

        // 诊断（Host 的 debug: true）：技能页真的渲染出来时回传一份摘要。
        // 没开 debug 的部署一个字节都不写；开了之后能回答两个问题——页面有没有拿到
        // `t`（决定文案是中文还是键名）、真实分类计数是多少。
        React.useEffect(() => {
          if (data?.debug !== true) return
          try {
            void fetch(`${API_PREFIX}/note`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                at: new Date().toISOString(),
                skillsSection: {
                  rendered: true,
                  hasT: typeof props?.t === 'function',
                  total: allSkills.length,
                  categories: counts,
                  scopeKind: data?.scopeKind ?? null,
                  userRoot: data?.userRoot ?? null,
                },
              }),
            }).catch(() => {})
          } catch {
            /* 诊断失败无所谓 */
          }
        }, [data])

        const modal = ui.modal
        const overlay =
          modal === null
            ? null
            : h(
                'div',
                {
                  className: 'tsk-overlay',
                  onClick: (event) => {
                    if (event.target === event.currentTarget) closeModal()
                  },
                },
                modal.kind === 'detail' ? renderDetail(modal.skill) : modal.kind === 'upload' ? renderUpload() : renderCreate(),
              )
        // 挂到 body：设置面板自己的滚动 / 变换不该把弹窗裁掉。拿不到 react-dom 就退回内联。
        const renderedOverlay =
          overlay !== null && typeof reactDom?.createPortal === 'function' && typeof document !== 'undefined'
            ? reactDom.createPortal(overlay, document.body)
            : overlay
        return h(
          'div',
          { className: 'tsk-section' },
          h('h2', { className: 'tsk-heading' }, t('skillsTitle')),
          h('p', { className: 'tsk-intro' }, t('skillsIntro')),
          h(
            'div',
            { className: 'tsk-toolbar' },
            h('input', {
              className: 'tsk-search',
              type: 'search',
              value: ui.query,
              placeholder: t('skillsSearch'),
              'aria-label': t('skillsSearch'),
              onChange: (event) => setUi((previous) => ({ ...previous, query: event.target.value })),
            }),
            h('button', { className: 'tsk-btn', type: 'button', disabled: loading, onClick: () => void refresh() }, t('skillsRefresh')),
            h('button', { className: 'tsk-btn is-primary', type: 'button', onClick: openUpload }, t('skillsUpload')),
            h('button', { className: 'tsk-btn', type: 'button', onClick: openCreate }, t('skillsNew')),
          ),
          data?.userRoot ? h('div', { className: 'tsk-hint' }, t('skillsUserRoot').replace('{path}', data.userRoot)) : null,
          error !== '' ? h('div', { className: 'tsk-notice is-error' }, `${t('skillsError')}：${error}`) : null,
          ui.notice !== '' ? h('div', { className: 'tsk-notice' }, ui.notice) : null,
          data?.complete === false ? h('div', { className: 'tsk-notice' }, t('skillsIncomplete')) : null,
          h(
            'div',
            { className: 'tsk-tabs', role: 'tablist' },
            categories.map((category) =>
              h(
                'button',
                {
                  key: category,
                  className: 'tsk-tab',
                  type: 'button',
                  role: 'tab',
                  'data-active': ui.filter === category ? 'true' : undefined,
                  onClick: () => setUi((previous) => ({ ...previous, filter: category })),
                },
                t(SKILL_CATEGORY_LABEL[category] ?? 'skillsAll'),
                h('span', { className: 'tsk-tab-count' }, String(counts[category] ?? 0)),
              ),
            ),
          ),
          loading && data === null ? h('div', { className: 'tsk-empty' }, t('skillsLoading')) : null,
          data !== null && filtered.length === 0
            ? h('div', { className: 'tsk-empty' }, allSkills.length === 0 ? t('skillsEmpty') : t('skillsFilterEmpty'))
            : null,
          filtered.length > 0 ? h('div', { className: 'tsk-list' }, filtered.map(renderRow)) : null,
          renderedOverlay,
        )
      }
    }

    /**
     * 一段消息内容里的纯文本（用户消息的 `content` 是 wire 块数组：text / image / file / …）。
     * @param {unknown} content - 消息内容块。
     * @returns {string} 纯文本；没有文字块就是空串。
     */
    function contentText(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        }
      }
      return parts.join('').trim()
    }

    /**
     * 一个回合里**人工**发出的最后一条消息的内容。
     *
     * `conversation.chat.node` 里的用户消息有三种：`user`（你打的那句话）、
     * `steering`（跑着的时候补的一句）、`turn-trigger` / `context`（通知唤起、注入的上下文）。
     * 「编辑重发」要的是第一种——后两类都不是「上一条消息」。
     * @param {object} snapshot - Chat 快照（`useChat` 拿到的那份）。
     * @param {number} turnId - 回合号。
     * @returns {unknown} 消息内容块数组；没有就是 undefined。
     */
    function lastUserContent(snapshot, turnId) {
      const keys = snapshot?.locations?.getTurn?.(turnId)
      if (!Array.isArray(keys)) return undefined
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const node = snapshot?.nodes?.get?.(keys[index])
        if (node === undefined || node === null || node.kind !== 'user') continue
        return node.data?.content
      }
      return undefined
    }

    /**
     * 这个回合是怎么结束的（DSH 的 `turn/end` 事件里的 `reason.kind`）。
     *
     * 槽位 owner 直接把回合记录（`TurnLocation`）传进来，`turn.end` 就是那条 `turn/end`
     * 事件；拿不到再从 Chat 快照的时间线里补一次（老版本 DSH 的 owner props 可能只给个 id）。
     * @param {object} snapshot - Chat 快照。
     * @param {unknown} turn - owner 传进来的回合（对象或回合号）。
     * @param {number} turnId - 回合号。
     * @returns {string} 结束原因；没结束 / 读不到就是空串。
     */
    function turnEndKind(snapshot, turn, turnId) {
      const declared = turn !== null && typeof turn === 'object' ? turn.end?.data?.reason?.kind : undefined
      if (typeof declared === 'string') return declared
      const record = snapshot?.timeline?.turns?.get?.(turnId)
      const kind = record?.end?.data?.reason?.kind
      return typeof kind === 'string' ? kind : ''
    }

    /**
     * 「停止 / 失败」的判定：只有 `aborted`（你按了停止）、`error`（本轮报错）、
     * `interrupted`（DSH 进程中途退出）三种才给「编辑重发」。
     * `completed`（跑完了）、`max-tokens`（撞输出上限）、`forked`、`blocked` 都不算。
     * @param {object} snapshot - Chat 快照。
     * @param {unknown} turn - owner 传进来的回合。
     * @param {number} turnId - 回合号。
     * @returns {'stopped'|'failed'|null} 停止 / 失败，其余为 null。
     */
    function turnOutcome(snapshot, turn, turnId) {
      const kind = turnEndKind(snapshot, turn, turnId)
      if (kind === 'aborted') return 'stopped'
      if (kind === 'error' || kind === 'interrupted') return 'failed'
      return null
    }

    /**
     * 这个回合是不是**最后一个**回合。
     *
     * 历史回合不给入口：DSH 的会话只往后追加（没有回滚），对着三天前的一条消息
     * 「重发」，结果会挂到今天的尾巴上，谁看都莫名其妙。最新的那一轮才值得重来一次。
     * @param {object} snapshot - Chat 快照。
     * @param {number} turnId - 回合号。
     * @returns {boolean} 是否最后一个回合。
     */
    function isLatestTurn(snapshot, turnId) {
      const order = snapshot?.timeline?.turnOrder
      if (!Array.isArray(order) || order.length === 0) return false
      return order[order.length - 1] === turnId
    }

    /**
     * 找一条用户消息的**动作行**（时间 + 复制那一行）。
     *
     * ui-chat 的用户行没有动作槽（`MessageIconActions` 是写死的，只有 assistant 才走
     * `conversation.chat.assistant-actions`），所以只能按 DOM 找。用的两个坐标都是
     * ui-chat 自己的约定，不是猜类名哈希：
     *   - 流里每个节点外层带 `data-chat-flow-kind` / `data-chat-turn`（`ChatView` 写的，
     *     滚动锚点与 Turn 导航都按它们找行）；
     *   - 动作行本身带 `data-clock`（用户行是 `start`、回合尾部是 `end`）——`MessageIconActions`
     *     写在行上，ui-chat 自己的样式也认这个属性。
     * 找不到就返回 null，调用方什么都不画。
     * @param {number} turnId - 回合号。
     * @returns {Element|null} 这条用户消息的流节点；找不到就是 null（结构变了就什么都不做）。
     */
    function findUserItem(turnId) {
      try {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
        const items = document.querySelectorAll('[data-slot="conversation.chat.flow"] [data-chat-flow-kind="user"]')
        const wanted = String(turnId)
        let item = null
        for (const candidate of items) {
          if (
            candidate !== null &&
            typeof candidate.getAttribute === 'function' &&
            candidate.getAttribute('data-chat-turn') === wanted
          ) {
            item = candidate
          }
        }
        return item
      } catch {
        return null
      }
    }

    /**
     * 按内容量一次编辑框的高度（最多 320px，超出在框里滚动）。
     * @param {Element|null|undefined} node - textarea 元素。
     * @returns {void}
     */
    function growTextarea(node) {
      try {
        if (node === null || node === undefined || node.style === undefined) return
        node.style.height = 'auto'
        const height = Number(node.scrollHeight)
        if (Number.isFinite(height) && height > 0) node.style.height = `${Math.min(height, 320)}px`
      } catch {
        /* 量不出来就按 rows 走 */
      }
    }

    /**
     * 把键盘送回会话输入框（尽力而为）。
     *
     * 公开的 `inputActions` 没有 focus；composer 的 contenteditable 带
     * `[data-composer-input]`（`ComposerContentEditable` 写死的属性），就按这个找。
     * 裸 DOM focus 可能把光标放到开头，但草稿已经先 `setDraft` 落到末尾，点一下即可修正。
     * @returns {void}
     */
    function focusComposerInput() {
      try {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
        const input = document.querySelector('[data-composer-input]')
        if (input !== null && input !== undefined && typeof input.focus === 'function') input.focus({ preventScroll: true })
      } catch {
        /* 聚焦失败不影响文字已经放进去 */
      }
    }

    /**
     * 会话「停止 / 失败」之后的「编辑重发」。
     *
     * 入口是**用户消息动作行里的一个小铅笔**（复制图标旁边），点开则**就地**把那条气泡换成
     * 编辑框（不是塞回底部输入框）：给这条消息的流节点打上 `data-tsr-editing`，样式把原生行藏起来，
     * 编辑框 `createPortal` 进同一个流节点，右对齐、宽度与气泡一致。
     * 槽位仍用 `conversation.chat.turnTail`，但它只当**挂载点**：每个回合结束都会渲染一次，
     * 又能拿到 `turn` / `useChat` / `useSession` / `inputActions` 这些标准道具。
     *
     * 判定仍从标准道具读，不碰私有接口：
     *   - `turn`：owner 传进来的回合记录 → `turn.end.data.reason.kind` 判断停止 / 失败；
     *   - `useChat`：Chat 快照 → 是不是最后一轮、这一轮里人工发的那条消息的正文；
     *   - `useSession` / `inputActions`：会话本身（子代理跳过）与它的输入面板。
     *
     * 提交 = `setDraft(改好的字)` + `inputActions.submit()`：和手打一条消息走同一条路
     * （队列、权限、命令全按当前会话的规矩来），插件不自己拼请求、不写会话日志。
     * DSH 的会话是追加式日志、没有截断接口，所以「重发」就是在**本会话**里再发一条——
     * 旧回合仍留在记录里，这是原生的样子，不是插件偷偷加戏。
     * 编辑框只收文字；**贴图 / 拖文件**这类附件仍走下方原生输入框——编辑框里留了一个
     * 「用输入框改（可贴图）」的出口，点它把当前文字放回 composer 并聚焦。
     *
     * 老版本 DSH 找不到那个动作行（或没有 `react-dom`）时什么都不渲染，不硬塞到别处。
     * @param {object} ctx - 客户端插件上下文。
     * @returns {Function} 注册到 `conversation.chat.turnTail` 的组件（只负责把按钮送进用户行）。
     */
    function createTurnTailResend(ctx) {
      /** 拿不到 Chat / Input 钩子时的占位：渲染期不能改 hook 顺序，一律当「没有数据」。 */
      const emptyHook = () => undefined

      return function EditResend(props) {
        const turn = props?.turn
        // owner 传的是回合记录本身；万一哪天换成 `{kind:'turn', turn: 记录}` 的包装，
        // 就往下拆一层——拆不动也不会炸，最多是这次不给入口。
        const turnRecord =
          turn !== null && typeof turn === 'object' && typeof turn.turn === 'object' && turn.turn !== null ? turn.turn : turn
        const turnId = Number.isSafeInteger(turn) ? turn : Number(turnRecord?.turn)
        const useChat = typeof props?.useChat === 'function' ? props.useChat : emptyHook
        const useSession = typeof props?.useSession === 'function' ? props.useSession : emptyHook
        const t = typeof props?.t === 'function' ? props.t : (key) => key
        const inputActions = props?.inputActions

        // 只选基本值：快照选择器返回新对象会让 React 每次渲染都当成新值。
        const subagent = useSession((session) => session?.subagent !== null && session?.subagent !== undefined)
        const outcome = useChat((snapshot) => turnOutcome(snapshot, turnRecord, turnId))
        const latest = useChat((snapshot) => isLatestTurn(snapshot, turnId))
        const prompt = useChat((snapshot) => contentText(lastUserContent(snapshot, turnId)))

        // 那条用户消息的 DOM 是别的组件画的：首帧可能还没进 DOM，挂载后再找一次；换了节点就跟上。
        // 只对「停止 / 失败的最后一轮」查 DOM——跑完的回合一条查询都不发。
        const candidate = outcome !== null && latest === true
        const [item, setItem] = React.useState(() => (candidate ? findUserItem(turnId) : null))
        React.useEffect(() => {
          const next = candidate ? findUserItem(turnId) : null
          if (next !== item) setItem(next)
        })

        const [editing, setEditing] = React.useState(false)
        const [draft, setDraft] = React.useState('')
        const area = React.useRef(null)

        // 编辑时就地顶掉原生气泡：给这条消息的流节点打一个标记，样式把原生行藏起来。
        React.useEffect(() => {
          if (editing !== true || item === null || typeof item.setAttribute !== 'function') return undefined
          item.setAttribute('data-tsr-editing', 'true')
          return () => {
            try {
              if (typeof item.removeAttribute === 'function') item.removeAttribute('data-tsr-editing')
            } catch {
              /* 节点已经被换掉就算了 */
            }
          }
        }, [editing, item])

        // 打开编辑框：聚焦、光标放到末尾、按内容量一次高度。
        React.useEffect(() => {
          if (editing !== true) return
          const node = area.current
          if (node === null || node === undefined) return
          try {
            if (typeof node.focus === 'function') node.focus({ preventScroll: true })
            if (typeof node.setSelectionRange === 'function') {
              const end = String(node.value ?? '').length
              node.setSelectionRange(end, end)
            }
          } catch {
            /* 聚焦失败不影响编辑 */
          }
          growTextarea(node)
        }, [editing])

        const ready =
          subagent !== true &&
          outcome !== null &&
          latest === true &&
          prompt !== '' &&
          typeof inputActions?.setDraft === 'function'
        if (ready !== true || item === null || item === undefined) return null

        const portal = reactDom?.createPortal
        if (typeof portal !== 'function') return null

        const actions = typeof item.querySelector === 'function' ? item.querySelector('[data-clock="start"]') : null

        const close = () => {
          setEditing(false)
          setDraft('')
        }

        const begin = () => {
          setDraft(prompt)
          setEditing(true)
        }

        // 重发 = 把改好的字放回会话的输入面板，走它自己的提交（不自己拼请求、不写日志）。
        const send = () => {
          const text = typeof draft === 'string' ? draft.trim() : ''
          if (text === '') return
          try {
            inputActions.setDraft(text)
            inputActions.submit()
            close()
          } catch (error) {
            reportClientFailure('edit-resend', error)
          }
        }

        // 需要贴图 / 拖文件时退回下方原生输入框（那是唯一能挂附件的地方）。
        const useComposer = () => {
          const text = (typeof draft === 'string' && draft.trim() !== '' ? draft : prompt).trim()
          try {
            inputActions.setDraft(text)
            focusComposerInput()
            close()
          } catch (error) {
            reportClientFailure('edit-resend', error)
          }
        }

        const node = editing === true
          ? h(
              'div',
              { className: 'tsr-editor', 'data-tsr-editor': 'true' },
              h('textarea', {
                ref: area,
                className: 'tsr-editor-input',
                value: typeof draft === 'string' ? draft : '',
                rows: 2,
                spellCheck: false,
                placeholder: t('editResendPlaceholder'),
                'aria-label': t('editResendTitle'),
                onChange: (event) => {
                  const value = event?.target?.value
                  setDraft(typeof value === 'string' ? value : '')
                  growTextarea(event?.target)
                },
                onKeyDown: (event) => {
                  if (event === null || typeof event !== 'object') return
                  if (event.key === 'Escape') {
                    if (typeof event.preventDefault === 'function') event.preventDefault()
                    close()
                    return
                  }
                  if (event.key !== 'Enter' || event.shiftKey === true) return
                  if (typeof event.preventDefault === 'function') event.preventDefault()
                  send()
                },
              }),
              h(
                'div',
                { className: 'tsr-editor-foot' },
                h('span', { className: 'tsr-editor-hint' }, t('editResendHint')),
                h('button', { type: 'button', className: 'tsr-editor-link', onClick: useComposer }, t('editResendComposer')),
                h('span', { className: 'tsr-editor-gap' }),
                h('button', { type: 'button', className: 'tsr-btn', onClick: close }, t('cancel')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tsr-btn is-primary',
                    disabled: typeof draft !== 'string' || draft.trim() === '',
                    onClick: send,
                  },
                  t('editResendSend'),
                ),
              ),
            )
          : h(
              'button',
              {
                type: 'button',
                className: 'tsr-action',
                title: t('editResendTitle'),
                'aria-label': t('editResendTitle'),
                'data-tsr-edit-resend': 'true',
                onClick: begin,
              },
              editIcon(15),
            )

        const target = editing === true ? item : actions
        if (target === null || target === undefined) return null
        let portalNode
        try {
          portalNode = portal(node, target)
        } catch (error) {
          // 目标节点在渲染间隙被换掉之类的小概率情况：这一颗不画，别拖垮整条对话流。
          reportClientFailure('edit-resend-portal', error)
          return null
        }
        // 挂载点本身不占位（真正画出去的是 portal），hidden 与样式都兜一层。
        return h('div', { className: 'tsr-host', hidden: true }, portalNode)
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          applyRegion(ctx)
        } catch (error) {
          reportClientFailure('apply', error)
          throw error
        }
      },
    }

    /**
     * 真正的接线：样式、词典、接管侧栏浏览区、注册「设置 → 技能」页。
     * @param {object} ctx - 客户端插件上下文。
     */
    function applyRegion(ctx) {
      ctx.effect(() => {
        const element = document.createElement('style')
        element.setAttribute('data-dsh-plugin', 'task-folders')
        element.textContent = CSS
        document.head.appendChild(element)
        return () => element.remove()
      }, 'dsh-task-folders: stylesheet')

      for (const [id, dict] of [
        ['zh', zh],
        ['en', en],
      ]) {
        ctx.effect(() => ctx.locale.register(NS, id, dict), `dsh-task-folders: ${id} dictionary`)
      }

      const t = ctx.locale.bind(NS)
      const Sidebar = createSidebar(ctx, t)

      // 整块接管侧栏浏览区：内置浏览器占着 priority 0，必须用更低的 priority 遮盖。
      ctx.slots.inject('sidebar.workspaces', () =>
        ctx.slots.register({ name: 'sidebar.workspaces', priority: -1 }, function Region(props) {
          return h(Sidebar, props)
        }),
      )

      // 设置 → 技能：settings.section 是「一页一个注册项」的列表槽，label 走词典 thunk，
      // 排序插在「内置插件」(15) 与「Agent 预设」(20) 之间。老版本 DSH 没有这个槽时
      // 只记一笔客户端失败，绝不让它把侧栏一起带走。
      try {
        const SkillsPage = createSkillsSection(ctx)
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'skills', order: 18, label: () => t('skillsNav'), locale: NS },
            function SkillsSettings(props) {
              return h(SkillsPage, props)
            },
          ),
        )
      } catch (error) {
        reportClientFailure('skills-section', error)
      }

      // 对话流：回合停止 / 失败之后的「编辑重发」。
      // 槽位由 ui-chat 声明（每个回合结束渲染一次、位置在动作行之前）；老版本 DSH 没有
      // 这个槽时 inject 等不到声明，什么也不会发生——不能让它把侧栏一起带走。
      try {
        const EditResend = createTurnTailResend(ctx)
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: 'edit-resend',
              order: 10,
              label: () => t('editResend'),
              locale: NS,
            },
            EditResend,
          ),
        )
      } catch (error) {
        reportClientFailure('edit-resend', error)
      }
    }
  },
})
