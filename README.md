# dsh-task-folders · 任务

把 DSH 侧栏那块浏览区重画成图里的样子：

```
项目                     🔍 ⋯        ← 标题右侧：搜索、视图选项（归档过滤）
任务  ▾                    ＋        ← 「任务」= 任务区自己的默认工作区，按天分隔
  今天                                 ← 按天分隔（今天 / 昨天 / YYYY-MM-DD）
    · 聊聊登录重构        3 分钟  ⋯    ← 行首状态点：运行中 / 有新结果 / 待确认 / 空闲；行尾「…」= 归档 / 复制 ID / 删除
    · 昨天那条            2 小时  ⋯
  昨天
    · 更早的一条          昨天    ⋯
  展开其余 4 个会话                     ← 一组超过 10 条就折起来（跑着 / 等回话的照样露脸）
工作区 ▾                   ＋        ← ＋ 添加工作区（走 DSH 自己的目录选择框）
  [文件夹] 我的项目       8  ＋  ⋯    ← 行首文件夹，悬停换成折叠三角（二者共用一格）；＋ = 新建会话；⋯ = 归档项目
    · 会话甲
▸ 已归档项目  2                        ← 归档的项目收在这里，展开后每行一个「恢复」
```

三条要点：

1. **「任务」底下是一个真实的默认工作区**（`<tasksRoot>`，默认 `$DSH_HOME/tasks`），
   只是侧栏把这份登记藏起来、统一画成「任务」；老的任务容器（`<root>/default` 等）一并认领；
2. **两个 ＋ 各做一件事**：任务组的 ＋ 在任务默认工作区里起一条会话（走 DSH 原生的
   `uiWorkspace.connectWorkspace`，不选目录、不起名字，复用空白会话），会话按**创建那天**归档；
   工作区行尾的 ＋ 在这个工作区里新建会话；工作区组的 ＋ 添加工作区；
3. **样式跟 DSH 自己的侧栏走**：12px 正文 / 26-32px 行高 / 6px 圆角，
   颜色只用 `--dsw-alias-*` 令牌，状态点与内置的 StateDot 同一套语义。

缩进只走一条台阶（下面是含 `.tsb-root` 6px 内边距的**绝对左偏移**）：

| 层 | 左偏移 | 内容 |
| --- | --- | --- |
| 一级 | 8px | 「项目」标题、任务 / 工作区组标题 |
| 二级 | 16px | 按天小标题、工作区行（文件夹） |
| 三级 | 26px | 任务区里的会话 |
| 四级 | 34px | 工作区里的会话 |

组标题原来和它下面的项目左边缘齐平（都在 14px），看着像同一层，层级读不出来；
现在标题往左顶到 8px、子项挪到 16px，一眼能看出谁在谁底下。

### 文件夹图标与折叠箭头

「项目」标题与每个工作区行都用**文件夹图标**，图形取自 DSH 自己的图标集
（平台共享模块表里的 `@deepseek-ai/dsh-client-ui-primitives`：`IconFolderCloseRegular` /
`IconFolderOpenRegular`），展开时换成打开的那个。

工作区行的**文件夹和折叠箭头共用一格**：平时画文件夹，鼠标移进来（或键盘聚焦）换成
`IconTriangleRightFillRegular`，离开再换回去——这正是内置侧栏的做法
（`.projectRow:hover .chevron{display:inline-flex} .projectRow:hover .folder{display:none}`）。
两个同时画出来是重复的「可展开」语义，右边那个还会因为字号小而缩成一个小黑点，既挤又不在一个
视觉重量上。折叠箭头统一走 DSH 的图标，别再用 9px 的文字 `▸`。

顺带一个反直觉的点：`IconTriangleRightFillRegular` 名字叫 Fill，图形其实是**一根
`strokeWidth: 1` 的细 chevron、默认 14px**，只是导出名沿用了旧命名——照着名字自己画实心三角，
粗细当场就对不上。

图标是**可选依赖**：`require` 拿不到（老版本 DSH 的共享模块表里没有这个包）就退回插件自带的
同形 16×16 SVG（文件夹与折叠箭头都是描边图形）。**一个图标绝不该把整块侧栏吃掉**——client
半侧的 `require` 抛错会让整个槽位注册失败、页面看起来什么都没发生，所以这里整段包在 try/catch 里。

## 为什么任务必须是一个工作区

v0.3 曾经把「任务」定义成「无工作区的会话」（内置侧栏叫「未分组」）。这个定义在 DSH 里
**走不通**，因为对话框对空白会话有一道硬门槛：

```js
// packages/client/ui-conversation
const hero = sessionId === undefined || (shellPhase === 'blank' && …)
const storedChipTitle = sessionWorkspace?.title ?? …   // 工作区成员才有芯片
const inert = sessionId === undefined || (hero && chipTitle === undefined)
```

`inert` 为真时，输入框整个换成「选择工作区」按钮；点它选一个目录，视图会**跳到那个工作区的
空白会话**，刚建的会话被留在原地。于是无主会话永远发不出第一句话——创建得出来，却开不了口。
现场证据：`$DSH_HOME/sessions/--C-Users-…-.dsh-tasks--/<会话>/session.v4.jsonl.zstd` 只有
头部和 `end-seed`，一条 `user/message` 都没有。

所以 v0.4 反过来做：任务区就是**登记过的目录**。会话有主、芯片在场、输入框可用，
「按天分组」纯粹是侧栏的渲染方式，跟 DSH 的成员判定不冲突。

## 「任务」收哪些会话

- `cwd` 落在任务根目录树里的会话（含已经不在登记里的老目录，所以 `default` 那些老会话照样看得到）；
- 无主的遗留会话（v0.3 时代建出来、谁都不归属的）：照样收，能聊的继续聊；
- **子代理会话不收**（`origin: 'subagent'`）：它们挂在父会话底下，不是独立对话；
- 全局归档（隐藏）的会话默认不显示，与内置侧栏一致。

任务工作区**有且只有一份**：任务根目录那一份。理由仍是 DSH 的成员判定——会话 `header.cwd`
不可改，一个目录只能对应一份登记；而任务根目录树里的子目录（v0.2 留下的 `default`、
`1-tedb612`）没有资格各占一行「任务」。所以插件启动时会把这些多余登记摘掉，只摘登记，
目录与日志一个字节都不动；它们名下**一句人话都没说过**的空壳会话顺手归档（否则侧栏会留下
点了也发不出话的哑巴行），有内容的会话留在任务组里，照常能聊。

## 会话存在哪

聊天记录按天归档在任务根目录：

```
<tasksRoot>/                          ← 任务根（= 任务默认工作区的路径）
├── .gitignore                        ← 只忽略下面的按天文件夹
├── 2026-10-27/                       ← 按天文件夹（会话创建当天，本地时区）
│   └── session-16810972…/            ← 一个会话一个文件夹
│       ├── session.json              ← 会话元数据（标题、seq 进度…）
│       └── session.v4.jsonl.zstd     ← 会话 + 聊天记录（DSH 默认格式）
└── default/2026-10-26/session-…      ← v0.2 及以前的「任务容器」（照样扫得出来，不搬走）
```

DSH 自己的存档（`$DSH_HOME/sessions/<转义 cwd>/<会话>/`）仍是权威存储，这里是同格式副本。

### 从 v0.2 / v0.3 升上来

- v0.2 的「任务 = 工作区」登记（`tasks\default`、`tasks\1-tedb612` 之类）**会被摘掉**：
  任务只留根目录那一份，别人看到的工作区列表里不会冒出第二、第三个「任务」；
- 摘登记前先看它们名下的会话：**没有 `user/message` 的空壳归档**（从侧栏隐藏，日志保留），
  有内容的留在任务组里，仍是可聊的遗留会话；
- 目录与日志一个字节都不动；v0.3 已经摘掉的那批不会因为升级又登记回来。

## 它怎么接管侧栏的

`sidebar.workspaces` 是 **single** 槽，内置「工作区浏览器」占着 priority 0。按 DSH 的规则，
同一个 single 槽换人必须**用更低的 priority 遮盖**：

```js
ctx.slots.register({ name: 'sidebar.workspaces', priority: -1 }, Region)
```

不传 priority 会抛 `single slot "sidebar.workspaces" already has a registration at priority 0`，
而这个异常会把**整个客户端半侧静默吃掉**（之前注册的槽一起消失，页面看起来什么都没发生）。

代价（刻意接受）：内置浏览区的**拖拽排序**、**视图选项里的分组/排序**、
以及**会话行上别家插件挂的菜单项**没有了。搜索、归档过滤、会话归档/取消归档这三样在 v0.5 里
由插件自己补了回来（见下节）。

## v0.5：把内置侧栏的另外三样补回来

整块接管侧栏之后，内置浏览器原本自带的三件事跟着消失了。它们现在都由插件自己实现，
数据与调用仍走 DSH 原生的面，不另建一套：

### 1. 会话行「…」菜单：归档 / 取消归档、复制 Session ID（v0.6 起多了删除）

原生侧栏里**会话没有物理删除**，从列表里消失的那条路叫「归档会话」——它调的是
`uiWorkspace.archiveSession(sessionId)`：会话立刻从侧栏消失，日志一个字节都不丢，
随时能取消归档找回来。v0.5 先按原生的语义把这几个菜单项补齐，菜单项与内置侧栏同名同义：

| 菜单项 | 调用 | 效果 |
| --- | --- | --- |
| 归档会话 / 取消归档 | `uiWorkspace.archiveSession` / `unarchiveSession` | 从侧栏移除 / 复原；日志保留 |
| 复制 Session ID | `navigator.clipboard` | 复制会话 id |
| 删除会话… | Host 的 `deleteSession`（见下节 v0.6） | 真删：三处磁盘痕迹收进回收站 |

会话还在干活时 DSH 会拒绝归档（原生这一步弹「停止并归档」确认框）。插件只把话说清楚
（「这会话还在干活，先停下来再归档」），不替人中断正在跑的工作。

### 2. 归档过滤三档（视图选项）

标题右侧的「⋯」里就是内置侧栏那三档，文案照抄：

- **隐藏已归档**（默认）
- **全部对话（显示已归档）** — 归档的会话带「已归档」小徽标
- **仅已归档**

Host 因此不再把归档会话从 `state` 里丢掉，而是单列一份 `archivedDayGroups` + `archivedSessionIds`；
客户端按档位合并。注意别把两件事搞混：会话字段 `archived` 说的是「磁盘上有按天副本」，
几乎每条都有；「在 DSH 里归档了」看的是 `archivedSessionIds`。

### 3. 项目归档

DSH 只给**会话**提供归档，工作区只有「删除登记」——那是把项目从列表里抹掉、会话落回
「未分组」，既不可逆也不好看。所以项目归档由插件自己记一份清单：

```
$DSH_HOME/task-folders/projects.json   →  {"version":1,"archived":["<workspaceId>",…]}
```

- 只影响侧栏怎么画：**工作区登记、目录、名下会话的日志一个字节都不动**，恢复即原样回来；
- 归档的项目收进底部「已归档项目」分组（默认收起），展开后每行一个「恢复」；
- 文件读不出 / 不是 JSON / 写不进去，一律退化成「没有归档」并记一条 warn，侧栏不白屏。

### 4. 搜索

- 入口：标题右侧的放大镜，或 **Ctrl/⌘ + K**（与内置侧栏同一个快捷键）；Esc 收起。
- 两层结果合并：本地按**会话标题 / 所属工作区 / 会话 id** 立刻命中；停手 250ms 后
  再叠一层 Host 全文搜索 `sessions.search(query, signal)`，带会话历史里的**摘要片段**。
- 结果行：状态点 + 标题 + 所属工作区 + 摘要；归档的会话带徽标，行尾直接给「取消归档」。
- 最多 20 条，超了提示「请缩小范围」；命中的会话点一下就打开。

## v0.6：删除会话（DSH 自己也没有这一样）

DSH 的会话只有归档，没有删除——`workspaceRegistry` 里没有 `deleteSession`，
`sessionPersistence` 也没有删文件的接口。想要「真的删掉」，只能由插件把文件收走。
一条会话在磁盘上有三处痕迹，删除就是这三处一起处理：

| 位置 | 是什么 |
| --- | --- |
| `$DSH_HOME/sessions/<转义cwd>/<会话>/` | DSH 自己的会话日志（唯一权威存储） |
| `<tasksRoot>/<YYYY-MM-DD>/<会话>/` | 插件按天归档的那份同格式副本 |
| `$DSH_HOME/storages/session_projcache/sessions/<会话>.json` | 侧栏 / 搜索用的投影缓存 |

`<转义cwd>` 那一层的拼法（`--C-Users-…--`、非 ASCII 走 `~XXXX`）属于 DSH 内部约定，
插件**不去复刻**：`sessions/` 下只有「按工作目录分组」这一层，直接扫一层、看哪个分组里
有同名的会话目录即可，换个 DSH 版本也不会认错。

删除的规矩：

- **点「删除会话…」不是立刻删**：菜单原地换成一句「日志会移进回收站，侧栏里立刻消失」
  ＋「取消 / 删除」两颗按钮，再点一次才动手；
- **默认进回收站**：`$DSH_HOME/task-folders/trash/<YYYYMMDD-HHmmss>-<会话>/`，里面按
  `session/`、`archive/`、`projection/` 分好，另有一份 `manifest.json` 写着原本在哪——
  删错了照着 `from` 搬回去即可（DSH 重启后才会重新看见这条会话）；
- **保留 30 天**：开机与每次删除时顺手清掉更早的条目；
- **想彻底删干净**就把配置里的 `trash` 设成 `false`：直接 rm，不留回收站；
- **正在干活的会话一律拒绝**：问的是 DSH 自己的 `workspace/session-activity` 瀑布
  （与归档同一套判据），忙就回 409 并说「先停下来再删除」，绝不替人中断这一轮；
- **日志搬不动就整单放弃**：`sessions/<分组>/<会话>/` 是权威那份，它搬不走（Windows 上
  DSH 还开着这条会话时 `rename` 会报 `EPERM`）时，按天副本与缓存一个都不动、登记表也不动，
  只回一句「换个会话或重启 DSH 之后再删」；
- **登记面一起摘**：删完把 id 从 `archivedSessionIds`（归档集合）与各工作区的
  `sessionIds`（成员表）里摘掉，免得侧栏留一条点不开的幽灵行、工作区计数虚高；
- **搬不动就如实说**：Windows 上日志还被 DSH 攥着时回 409「日志正被 DSH 占用」，
  不假装删掉了；一处都没搬成时不动登记表，磁盘与登记不会各说各话。

客户端删成功后会先把这条会话记进本地的 `hiddenIds`：`sessionQuery` 的索引要等一次
reconcile 才会掉这条，这几秒里侧栏不该还挂着一条点不开的行；等 Host 的下一份状态不再
列它，本地标记就忘掉（万一真复活了也不会一直被藏着）。

## v0.7：区域高度不再被内容挤住，会话多了会折起来

两处都在客户端半侧（`client.js`），Host 一行没动。

### 1. 折叠起来时区域不再只有三行高

插件这块区域是 `.tsb-root`，它的父级 `.wtg9ga_regionArea`（DSH 侧栏自己画的）
是 `flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden`。
插件原来只写了 `min-height: 0`，**没写 `flex`**：于是它按内容高度长——全折叠时高度只有
「项目 + 任务 + 工作区」三行那么点，内容再长就压着滚动。两个后果：

- 折叠状态下区域被挤成一条，底下全是空白，视图选项的弹出菜单在内容底边处被**当场切掉**
  （`overflow: auto` 连浮层一起裁）；
- 行是纵向 flex 的子项，默认 `flex-shrink: 1`，内容一多每行先被压扁再去滚动。

现在：

- `.tsb-root` 补上 `flex: 1 1 auto`，铺满 DSH 给的整块区域；
- `.tsb-caption / .tsb-group / .tsb-row / .tsb-day / .tsb-notice / .tsb-search / .tsb-result`
  一律 `flex: 0 0 auto`：宁可滚动，也不许把行压扁；
- 弹出菜单（视图选项 / 会话「…」/ 工作区「…」/ 删除确认）改成量好触发按钮的
  `getBoundingClientRect()` 之后 `createPortal` 挂到 `document.body` 上用 `position: fixed`
  画：下方放不下就翻到按钮上方，左右夹在视口里，滚动或改窗口大小自动收起。
  （`react-dom` 与图标集一样是可选依赖，拿不到就退回原来「贴在行下面」的画法。）

### 2. 一组会话超过 10 条就折起来

照抄内置侧栏的 `sessionOverflowButton`（5 条一折、文案「展开其余 N 个会话」/「收起」、
28px 高、12px 字、tertiary→secondary 的 hover），阈值按任务区的量放宽到 **10 条**：

- 「任务」的按天列表：默认只铺最近 10 条，多出来的折进一颗「展开其余 N 个会话」，
  展开后按钮换成「收起」（`SESSION_LIMIT`）；
- 工作区展开后的成员列表同样处理，**每个工作区各记各的**；
- **跑着 / 等回话的会话例外**：不管排到第几名都露脸——折起来的那条正在等人回话，
  比折叠本身更要紧，按钮上的 N 也如实扣掉它们。

## v0.8：设置里的「技能」页

设置面板（`Ctrl/⌘ + ,`）的左侧多一项**技能**，夹在「内置插件」(15) 与「Agent 预设」(20)
之间。这一页回答两个问题：**装了什么、从哪来**，以及**怎么再加一个 / 删掉一个**。

### 它怎么知道有哪些技能

数据完全来自 DSH 的 `ctx.skills` 注册表，不自己扫盘。这里有一个容易踩空的点：
本机 profile 把 `dsh-skill-filesystem` / `dsh-tool-skill` 挂在 **Agent 预设**里
（全局 `include:skill` 只有注册表本体）。只读全局层的话，页面会一个文件技能都看不到。
所以 Host 按 DSH 自己 `SessionSkillCatalog` 的做法分两条路：

- 当前会话还活着（客户端把 `uiSession` 的 `sessionId` 带上来）→
  `agentPresets.serviceFor(agent, 'skills')` 拿这份**带预设层**的注册表；
- 没有活会话（刚启动、设置页也能开）→ `agentPresets.acquireScope()` 借一份默认预设的
  scope（`AsyncDisposable`，读完归还），再在全局注册表上带 `{ scope }` 读。

界面上的分类是**来源**的投影：

| 分类 | `source` | 说明 |
| --- | --- | --- |
| 官方内置 | `bundled` | 随 DSH 包发布的技能（Office、诊断脚本等） |
| 我的技能 | `user-dsh` / `user-agents` / `custom` | `$DSH_HOME/skills`、`~/.agents/skills` 与自定义目录 |
| 项目 | `project-dsh` / `project-agents` | 当前项目根下的 `.dsh/skills` 与 `.agents/skills` |
| 运行时 / 其他 | `runtime` / 未知 | 运行时注册的（预设 / 插件注入） |

### 安装：目录、SKILL.md，还是表单

「上传技能」支持三种现实形态，Host 侧统一整理：

1. **拖 / 选一个技能目录**：浏览器给的是 `my-skill/SKILL.md` + `my-skill/references/…`，
   自动去掉公共根后按 bundle 安装；
2. **选单个 `.md`**：按平铺技能安装（没有 SKILL.md 时把它当 SKILL.md）；
3. **「新建技能」表单**：填 name / description / whenToUse / body，Host 拼出带
   YAML frontmatter 的 SKILL.md。

安装位置固定是 `<DSH_HOME>/skills/<name>/`（可用 `skillsRoot` 改），**先写临时目录再整目录
`rename`**，中途失败不会留下半套技能；同名已存在时返回 409 `skill-exists`，界面弹「覆盖
安装」二次确认，旧版本进 `$DSH_HOME/task-folders/skill-trash/`。限制：单文件 2MB、单次
8MB、120 个文件；路径拒绝绝对路径 / 盘符 / `..` / NUL。

### 删除：只动用户技能根

详情弹窗里的「删除技能」只对 `<DSH_HOME>/skills` 里的条目出现（官方、项目、共享
`~/.agents/skills` 都不给删）。Host 侧还有一道 403：路径必须在用户技能根内、不是
`.system`；目录 bundle 搬的是整个技能目录，而不是单独一份 `SKILL.md`。默认移进
`task-folders/skill-trash/`，`skillTrash: false` 才永久删除。

**为什么只读用户根**：官方技能在 asar 里，项目技能属于仓库，共享目录属于别的 agent 配置；
从设置页删它们不是「管理自己的技能」，是越界。

### 详情与失败

点一行打开详情，正文按名字现取（`skillDetail` → `ctx.skills.get`），列表只带摘要；来源、
调用方式（模型 / 用户）、完整路径都写在弹窗里。注册表没挂载时页面显示一句人话
（`skills-unavailable`），不会白屏。`debug: true` 时，技能页真正渲染出来后会往
`$DSH_HOME/task-folders/note-*.json` 写一份摘要（`hasT` / 总数 / 分类 / `scopeKind`），
排查「页面到底读到了哪一层」时先看它。

## 顺带一提：为什么「项目归档」不写进工作区登记

`workspaceRegistry` 是 DSH 的持久登记，删一次就真的没了（虽然目录和日志还在）。
归档是**可逆的展示状态**，属于插件的偏好，不该污染 DSH 的登记表；将来换一个侧栏插件，
那些项目也只是恢复成普通的未归档工作区，不会留下「已删除」的坑。

反过来，**删除会话**是实打实的文件操作（见上节）：所以它带二次确认、默认进回收站，
而且搬不动时宁可报错也不改登记表。

## 「DSH 默认格式」具体是什么

与 `$DSH_HOME/sessions/<工作区>/<会话>/session.v4.jsonl.zstd` 完全一致：

- 第一帧：一行头部 `{"type":"session","version":4,"id":…,"cwd":…}`
- 之后每帧：一批事件行 `{"type":"user/message","seq":N,"time":…,"data":{…}}`
- 整个文件是**多帧 zstd 的拼接**，因此可以一直 append，不必重写历史

任何会读 DSH 会话日志的工具（例如 `dsh-usage-panel` 的扫描器）都能直接读这些文件；
插件自己重启后也从这份日志恢复写入进度，不会重复写事件。

## 行为边界（刻意如此）

- **只归档任务区的会话**：普通工作区里的会话由 DSH 自己的存档管，这里一个字节都不写。
- **不搬走 DSH 自己的会话存档**：`$DSH_HOME/sessions` 仍是唯一权威存储，这里是同格式副本。
- **写失败不影响会话**：所有 IO 都 try/catch，写不出存档只在 Host 日志里留一条 warn。
- **子代理不归档**：`origin: 'subagent'` 的会话跳过。
- **删除是唯一会动文件的动作**（v0.6）：它只处理被点名的那一条会话，默认进回收站，
  正在干活的会话直接拒绝——其余任何时候插件都不删别人的东西。
- **跨天不搬家**：会话归档在**创建那天**的文件夹；第二天继续聊仍写同一份日志（时间戳真实），
  侧栏也始终按创建那天把它归在那一天底下。

## 安装

从 npm 装：

```sh
dsh plugin --profile desktop add dsh-task-folders
```

自己改代码时，也可以直接指向本地目录：

```sh
dsh plugin --profile desktop add link:/abs/path/to/dsh-task-folders
```

装完重启 DSH，侧栏就有「任务」这一行。

Host 侧改动默认要重启；改完想立刻生效又不想重启，可以用
`plugin_manager set_plugin` 对 `include:task-folders` 关一次再开一次。

## 配置（可选，写在 profile 的 `cordis.patch.yml`）

```yaml
- id: task-folders
  name: 'dsh-task-folders'
  config:
    tasksRoot: '~/.dsh/tasks'   # 任务目录的根（默认 $DSH_HOME/tasks）；支持 ~ 前缀
    taskTitle: '任务'            # 任务默认工作区的显示名（会出现在对话框的工作区芯片上）
    flushDelayMs: 300           # 会话事件攒批落盘的时间窗（毫秒）
    flushBatchSize: 64          # 攒到多少行立刻落盘
    recoverFromLog: true        # 重启后从日志恢复写入进度
    trash: true                 # 删除会话时移进回收站（false = 永久删除，不留退路）
    skillsRoot: '~/.dsh/skills' # 设置页安装 / 删除的用户技能根（默认 $DSH_HOME/skills）
    skillTrash: true            # 删除技能时移进 task-folders/skill-trash（false = 永久删除）
    debug: false                # true 时客户端会把它看到的第一屏摘要回传一次（排查用）
```

`reveal` 是只给代码用的注入点（YAML 写不了函数）：`openFolder` 靠它去开文件夹，默认按平台
`explorer.exe` / `open` / `xdg-open`。测试传一个只记路径的替身，断言返回值时就不会在开发机上弹窗。

## Host 接口

一条带部署可信校验的 POST 路由族 `/task-folders/api/*`，只接受可信页面（`connection.requestRejection`）：

| 方法 | 请求 | 作用 |
| --- | --- | --- |
| `state` | `{}` | 按天分组的任务会话（含归档那份）+ 普通工作区（带 `archived` 标记）+ 任务默认工作区 id |
| `newTaskSession` | `{}` | 确保任务区就绪，返回 `{cwd, workspaceId}`（＋ 失败时的兜底入口） |
| `archiveProject` | `{workspaceId, archived}` | 归档 / 恢复一个项目，只写插件自己的 `projects.json` |
| `openFolder` | `{day?, sessionId?}` | 在资源管理器里定位（护栏：只允许 `tasksRoot` 之内） |
| `deleteSession` | `{sessionId}` | v0.6 删一条会话：三处磁盘痕迹进回收站 + 摘登记面；忙则 409，搬不动则 409 |
| `skills` | `{cwd?, sessionId?}` | v0.8 技能目录：按来源投影 + `userManaged` 删除权限；`scopeKind` 说明读的是会话 / 预设 / 全局层 |
| `skillDetail` | `{name, cwd?, sessionId?}` | 按名字加载完整 `SKILL.md` 正文（列表只带摘要） |
| `installSkill` | `{files?, draft?, overwrite?}` | 安装目录 bundle / 单个 `.md` / 表单草稿；同名 409 `skill-exists`，`overwrite` 才替换（旧的进回收站） |
| `deleteSkill` | `{name, path}` | 只允许用户技能根内的路径（403 兜底），整目录进 `task-folders/skill-trash/` |
| `note` | 任意 JSON | 客户端异常/诊断回传，写 `$DSH_HOME/task-folders/note-*.json`（保留 20 个） |
| `describe` | `{}` | 自检：根目录、任务工作区 id、任务区清单、能否建工作区、归档项目与按天归档、回收站与技能根 |

`state` 的应答形如：

```jsonc
{
  "tasksRoot": "C:\\Users\\…\\.dsh\\tasks",
  "taskWorkspaceId": "0f3a…",              // 任务默认工作区（客户端 ＋ 用它 connectWorkspace）
  "cwd": "C:\\Users\\…\\.dsh\\tasks",     // 兼容字段：任务会话的工作目录
  "canCreate": true,                       // 能否添加工作区
  "dayGroups": [{ "day": "2026-10-27", "sessions": [{ "id": "session-…", "live": true }] }],
  "archivedDayGroups": [],                 // v0.5：已归档会话，结构同 dayGroups
  "archivedSessionIds": [],                // v0.5：DSH 里归档了的会话 id（客户端据此换菜单项）
  "workspaces": [{ "id": "w1", "title": "我的项目", "path": "F:\\…", "sessionIds": ["session-…"], "archived": false }],
  "totals": { "sessions": 3, "archivedSessions": 0, "archivedWorkspaces": 0, "days": 2, "workspaces": 1, "workspaceSessions": 1 }
}
```

标题由客户端从自己的会话快照解析（`displayTitle` / `projectionValues.title`），
Host 只负责「哪些会话属于任务、归在哪一天」。

## 测试

```sh
node --test --test-isolation=none test/paths.test.js test/sessions.test.js test/scan.test.js test/archive.test.js test/session-files.test.js test/state.test.js test/project-archive.test.js test/skills.test.js test/route.test.js test/client.test.js
```

126 个用例，覆盖：本地时区日期、目录名清洗、任务判定（cwd 在任务区 / 普通工作区 / 子代理 / 注册表缺席）、
按天归档扫描（倒序、坏 `session.json`、非日期目录不混入、新旧两种布局）、DSH 格式写入
（多帧 zstd、seq 去重、崩溃后从日志恢复进度、大 payload）、删除落盘（按分组找日志、三处目标、
回收站与 manifest、`trash:false` 直删、越界目录护栏、30 天清理、重复删除幂等、日志搬不动就整单放弃）、
项目归档存储（落盘、幂等、坏 JSON、写失败回滚、垃圾 id）、侧栏状态装配（按天分组、归档会话单列一组、项目归档只打标记、
任务区工作区过滤、归档兜底、冷会话）、路由全链路（403/405/404/400、自动归档、补接归档、
只留一份任务登记、空壳会话归档、根上会话挂成员表、注册表晚就绪重试、打开文件夹的路径计算与注入替身
（测试断言交给「打开」的路径，不真弹资源管理器）、
删除会话的三处搬运与摘登记、忙则 409、坏 id 400、找不到的会话幂等）、
客户端槽位契约（priority -1 遮盖、按天分隔、`connectWorkspace` 建任务会话、旧版 Host 提示、
状态点、文件夹图标（DSH 图标集 + 拿不到时的自带 SVG 兜底）、令牌化样式表、窄栏降级、
搜索入口与本地/全文结果、归档过滤三档、会话行「…」归档/取消归档、删除的二次确认与 deleteSession、
项目归档与恢复、归档徽标）。

## Host 改动与热重载

Host 半侧的改动（新路由、登记任务工作区、归档触发、删除会话）**不会自动热重载**：DSH 桌面版只对 profile 的
配置文件做热重载。要么重启应用，要么用 `plugin_manager set_plugin` 对 `include:task-folders`
关一次再开一次（会 dispose + 重新从磁盘 import）。客户端半侧刷新页面即可。

客户端对旧版 Host 有两处兜底：`state` 没有 `dayGroups` 时用客户端快照现算分组
（按**最后活跃那天**，新版 Host 按**创建那天**）；**没有 `taskWorkspaceId` 的旧版 Host
不提供「建任务会话」**——任务会话必须有工作区才开得了口，所以这时 ＋ 是禁用的，侧栏会提示
「重启 DSH 后生效」，而不是偷偷建一条说不了话的无主会话。还没重启的 v0.5 Host 不认
`deleteSession`：点「删除」会得到一句「unknown method」的提示，重启 DSH 后即生效。
