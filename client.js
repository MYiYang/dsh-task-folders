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
 * `ctx.sessions.list` 快照（字段是 `displayTitle` / `projectionValues.title`），
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
      errorLoad: 'Could not read the sidebar data',
      errorGeneric: 'Operation failed',
      errorOpen: 'Could not open the session',
      errorCreate: 'This DSH cannot create a session',
      errorStaleHost: 'This sidebar is talking to an older Host; restart DSH so Tasks gets its default workspace',
      canNotCreate: 'This DSH cannot create a workspace',
      search: 'Search sessions',
      searchPlaceholder: 'Search session names',
      searchClear: 'Clear search',
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
   padding: 2px 6px 6px;
   overflow: auto;
   color: var(--dsw-alias-label-primary);
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
 /* 就地二次确认：菜单原地换成一句话 + 两颗按钮，不弹系统对话框。 */
 .tsb-confirm {
   width: 214px;
   gap: 6px;
   padding: 8px;
   cursor: default;
 }
 .tsb-confirm-title {
   font-size: 12px;
   line-height: 17px;
   font-weight: 600;
   color: var(--dsw-alias-label-primary);
 }
 .tsb-confirm-hint { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
 .tsb-confirm-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
 .tsb-confirm-btn {
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
 .tsb-confirm-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
 .tsb-confirm-btn.is-danger {
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
 `

    /**
     * 发一次 Host 请求。
     * @param {string} method - 操作名。
     * @param {object} [payload] - 请求体。
     * @returns {Promise<any>} 应答里的 value。
     */
    async function callHost(method, payload) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(`${API_PREFIX}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal: controller?.signal,
        })
        const data = await response.json().catch(() => null)
        if (!response.ok || data === null || data.ok !== true) {
          throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
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
     * 从客户端会话快照里取一条会话的展示信息（拿不到就是 undefined，绝不抛）。
     * 字段实测：`displayTitle`（持久标题在 `projectionValues.title`，空白会话为 null）。
     * @param {object} ctx - 客户端上下文。
     * @param {string} sessionId - 会话 id。
     * @returns {{title: string, running: boolean, updatedAt: number}|undefined} 展示信息。
     */
    function sessionInfo(ctx, sessionId) {
      try {
        const sessions = ctx.get('sessions')
        const snapshot = sessions?.list?.getSnapshot?.()
        const summary = snapshot?.byId?.[sessionId]
        if (summary === undefined || summary === null) return undefined
        const durable = summary?.projectionValues?.title
        const title =
          typeof durable === 'string' && durable !== ''
            ? durable
            : summary.blank === true
              ? // 空白会话的 displayTitle 是 cwd 的目录名（default / 1-tedb612 这种），
                // 直接摆出来很难看，交给调用方回落到「新会话」。
                ''
              : typeof summary.displayTitle === 'string'
                ? summary.displayTitle
                : ''
        return {
          title,
          running: summary.running === true,
          updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0,
        }
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
     * @param {object} state - Host 状态。
     */
    function reportFirstState(state) {
      try {
        void fetch(`${API_PREFIX}/note`, {
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
            },
          }),
        }).catch(() => {})
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
          sessions: sessions.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0)),
        }))
    }

    /**
     * 从客户端自己的快照算「无工作区的会话」。
     * Host 的 `state` 带着按天分组时优先用它（那天是**创建那天**，和磁盘归档一致）；
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
        const [notice, setNotice] = React.useState('')
        // v0.6：刚删掉的会话先在本地藏起来，等 Host 的下一份状态追上（sessionQuery 索引
        // 要等一次 reconcile 才会掉这条），这几秒里侧栏不该还挂着一条点不开的行。
        const [hiddenIds, setHiddenIds] = React.useState(() => new Set())
        // v0.7：一屏铺不完就先折起来——任务按天列表一个开关，工作区成员各记各的。
        const [tasksExpanded, setTasksExpanded] = React.useState(false)
        const [wsExpanded, setWsExpanded] = React.useState(() => new Set())
        // 弹出菜单的视口坐标（量不到时为 null，退回 CSS 里的「贴在行下面」）。
        const [menuAnchor, setMenuAnchor] = React.useState(null)

        const searchInput = React.useRef(null)

        const mounted = React.useRef(true)

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
         * @param {object|null} next - 菜单状态（null = 关）。
         * @param {object|null} element - 触发按钮。
         * @param {number} [height] - 菜单高度估计。
         */
        const openMenu = (next, element, height = 99) => {
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
         * 弹一句短提示（复制成功 / 归档失败之类），4 秒后自己消失。
         * @param {string} text - 提示文本。
         */
        const flash = React.useCallback((text) => {
          setNotice(text)
          setTimeout(() => {
            if (mounted.current) setNotice('')
          }, 4000)
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
              flash(t('deleted'))
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
            const done = (ok) => flash(ok ? t('copied') : t('copyFailed'))
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

        // Ctrl/⌘+K 开搜索（与内置侧栏同一个快捷键）；Esc 收起搜索与菜单。
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
              setSearchOpen(false)
              setQuery('')
            }
          }
          document.addEventListener('keydown', onKeyDown)
          return () => document.removeEventListener('keydown', onKeyDown)
        }, [])

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
        const canCreate = state?.canCreate !== false
        // 任务会话只能在「任务默认工作区」里生：id 由 Host 给（旧版 Host 没有）。
        const taskWorkspaceId = typeof state?.taskWorkspaceId === 'string' ? state.taskWorkspaceId : ''
        const uiWorkspace = ctx.get('uiWorkspace')
        const hasWorkspaceStarter =
          typeof uiWorkspace?.connectWorkspace === 'function' || typeof uiWorkspace?.startSession === 'function'
        const canCreateSession = taskWorkspaceId !== '' && hasWorkspaceStarter
        // 旧版 Host 还活着（插件 Client 已更新、Host 还没重启）：说清楚，别让人点空。
        const staleHost = state !== null && taskWorkspaceId === ''
        // Host 是新版就给按天分组（创建那天，和磁盘归档一致）；旧版 Host 没有 dayGroups，
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
            const info = sessionInfo(ctx, entry.id)
            const title = info?.title || t('sessionUntitled')
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
            const info = sessionInfo(ctx, id)
            const entry = searchableSessions.find((candidate) => candidate.id === id)
            const item = {
              id,
              title: info?.title || t('sessionUntitled'),
              workspace: entry?.workspace ?? '',
              sidebarArchived: entry?.sidebarArchived === true || archivedSessionIds.has(id),
              snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
            }
            byId.set(id, item)
            items.push(item)
          }
          const limit = 20
          return {
            items: items.slice(0, limit),
            pending: remoteSearch.pending === true,
            hasMore: items.length > limit || remoteSearch.hasMore === true,
          }
        }, [query, searchableSessions, remoteSearch, tick, t])

        /**
         * 菜单落点的内联样式：量到视口坐标就用 fixed（叠在整页之上，不被侧栏区域裁）；
         * 量不到就返回 undefined，交给 `.tsb-menu` 里那套「贴在行下面」的 CSS 兜底。
         * @param {number} width - 菜单宽度（视图 / 会话菜单 156，删除确认 214）。
         * @returns {object|undefined} 内联样式。
         */
        const menuStyle = (width) => {
          if (menuAnchor === null) return undefined
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
         * @param {object[]} items - `{key, label, checked, onSelect}`。
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
                style: menuStyle(156),
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
                    // 需要再点一步的项（删除的二次确认）自己留着菜单，其余点完就收。
                    onClick: () => {
                      if (item.keepMenu !== true) setMenu(null)
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
         * 删除会话的就地二次确认：菜单原地换成一句说明 + 「取消 / 删除」。
         * 删除对用户就是不可逆的，不该点一下就执行——先让手停半秒。
         * @param {string} sessionId - 会话 id。
         * @param {string} key - React key。
         * @returns {object} React 元素。
         */
        const renderDeleteConfirm = (sessionId, key) =>
          portalMenu(
            h(
              'div',
              {
                className: 'tsb-menu tsb-confirm',
                key,
                role: 'dialog',
                style: menuStyle(214),
                onClick: (event) => event.stopPropagation(),
              },
              h('div', { className: 'tsb-confirm-title' }, t('deleteConfirmTitle')),
              h('div', { className: 'tsb-confirm-hint' }, t('deleteConfirmHint')),
              h(
                'div',
                { className: 'tsb-confirm-actions' },
                h(
                  'button',
                  { className: 'tsb-confirm-btn', key: 'cancel', type: 'button', onClick: () => setMenu(null) },
                  t('cancel'),
                ),
                h(
                  'button',
                  {
                    className: 'tsb-confirm-btn is-danger',
                    key: 'confirm',
                    type: 'button',
                    onClick: () => {
                      setMenu(null)
                      deleteSession(sessionId)
                    },
                  },
                  t('deleteConfirmAction'),
                ),
              ),
            ),
            key,
          )

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
            // 留着菜单，下一步换成就地确认（就地确认块由 renderDeleteConfirm 画）。
            keepMenu: true,
            onSelect: () =>
              setMenu({ kind: 'session', id: sessionId, sidebarArchived: sidebarArchived === true, confirm: 'delete' }),
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
          const info = sessionInfo(ctx, sessionId)
          const title = info?.title || t('sessionUntitled')
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
            isMenuOpen
              ? menu.confirm === 'delete'
                ? renderDeleteConfirm(sessionId, `menu:${sessionId}`)
                : renderMenu(sessionMenuItems(sessionId, sidebarArchived), `menu:${sessionId}`)
              : null,
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
                h('div', { className: 'tsb-day', key: `day:${entry.day}`, style: { '--tsb-indent': '10px' } }, dayLabel(entry.day, t)),
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
            const info = sessionInfo(ctx, item.id)
            return h(
              'div',
              { className: 'tsb-result', key: `search:${item.id}` },
              h(
                'button',
                {
                  className: 'tsb-row-main',
                  type: 'button',
                  title: `${item.title}\n${item.id}`,
                  onClick: () => openSession(item.id),
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
          const members = (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []).filter((sessionId) => {
            if (hiddenIds.has(String(sessionId))) return false
            const sidebarArchived = archivedSessionIds.has(String(sessionId))
            if (archivedFilter === 'hide') return !sidebarArchived
            if (archivedFilter === 'only') return sidebarArchived
            return true
          })
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
                h('span', { className: 'tsb-folder' }, folderIcon({ open: isOpen, size: 16 })),
                h('span', { className: isOpen ? 'tsb-chev is-open' : 'tsb-chev' }, triangleIcon()),
                h('span', { className: 'tsb-title' }, workspace.title),
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
          h(
            'div',
            { className: 'tsb-caption' },
            folderIcon({ size: 14, className: 'tsb-caption-icon' }),
            h('span', null, t('project')),
            // 标题右侧：搜索（Ctrl/⌘+K）与视图选项（归档过滤三档）——内置侧栏这两样都在这一带。
            h(
              'div',
              { className: 'tsb-header-actions' },
              h(
                'button',
                {
                  className: 'tsb-icon',
                  type: 'button',
                  title: t('search'),
                  onClick: () => {
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
                    if (event.key === 'Escape') {
                      setQuery('')
                      setSearchOpen(false)
                    }
                  },
                }),
                query !== ''
                  ? h(
                      'button',
                      {
                        className: 'tsb-icon',
                        type: 'button',
                        title: t('searchClear'),
                        onClick: () => {
                          setQuery('')
                          setTimeout(() => searchInput.current?.focus?.(), 0)
                        },
                      },
                      '✕',
                    )
                  : null,
              )
            : null,

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
          notice !== '' ? h('div', { className: 'tsb-notice' }, notice) : null,
          staleHost ? h('div', { className: 'tsb-notice is-error' }, t('errorStaleHost')) : null,
          canCreate === false ? h('div', { className: 'tsb-notice' }, t('canNotCreate')) : null,
        )
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
     * 真正的接线：样式、词典、接管侧栏浏览区。
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
    }
  },
})
