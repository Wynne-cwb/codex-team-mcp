# codex-team-mcp

[English](README.md) | 简体中文

[![npm package](https://img.shields.io/npm/v/codex-team-mcp.svg)](https://www.npmjs.com/package/codex-team-mcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-43853d.svg)](package.json)

为 Codex 提供的非官方 Claude Agent Team 兼容层，以 stdio MCP 服务器形式打包。

`codex-team-mcp` 向 Codex 暴露 Claude 风格的团队工具——`TeamCreate`、`Agent`、`SendMessage`、团队级任务工具、`TeamDiagnostics`，以及 `TeamMerge` / `CheckInbox` 扩展。它为面向团队的技能提供一个持久、可审计的协作层，并带有真实的、可选启用的执行后端，且无需修改 Codex CLI 内部实现。

> [!IMPORTANT]
> 这是一个外部兼容层，并非与 Claude 运行时完全对等。它提供持久的团队状态、可寻址的 TeamMate、持久化消息、团队任务、生命周期诊断、可选启用的真实执行后端（worktree 隔离，读**和**写）、持久化恢复，以及可选的 pane 可视化。消息投递是**回合边界拉取（pull），而非同步推送（push）**:`SendMessage` 会被立即持久化,并在收件方两次回合之间处于空闲时投递;消息正文通过 `CheckInbox` 拉取,绝不在回合中途注入。它**不**提供真正的 Claude 进程内执行、保证的回合中途消息注入、审批桥接对等,或与 Claude 完全一致的 tmux/iTerm2 pane。

## 能力一览

| 能力 | 状态 |
| --- | --- |
| 持久的团队创建与活跃团队绑定 | 支持 |
| 通过具名 `Agent` 调用获得可寻址的 TeamMate 身份 | 支持 |
| 显式持久化的 `SendMessage` 收件箱消息 | 支持 |
| 回合边界投递 + `CheckInbox` 拉取（正文拉取,绝不推送） | 支持 |
| 团队级 `TaskCreate`、`TaskUpdate`、`TaskList`、`TaskGet` | 支持 |
| 重启安全的 SQLite 运行时状态 | 支持 |
| 每个 TeamMate 的真实后端状态 + 已脱敏的调试诊断 | 支持 |
| 只读 / 仅评审执行（不写文件） | 支持 |
| 在隔离的 git worktree 中执行改文件的工作 | 可选启用,取决于后端 |
| 由 TL 主导、可审计的 worktree 合并 / 升级（`TeamMerge`） | 取决于后端 |
| 通过 `SendMessage` 对空闲/已停止 TeamMate 的持久化恢复 | 取决于后端 |
| 可选的、覆盖在真实运行之上的 tmux/iTerm2 风格 pane 可视化 | 取决于后端 |

> [!NOTE]
> 执行后端是**可选启用、默认关闭**的。在没有 `CODEX_TEAM_EXECUTION=1` 的情况下,服务器仍会创建团队、TeamMate、消息、任务和诊断,但 TeamMate 会停留在 `scheduled` 状态并标记为 `backend_unavailable`,而不会真正运行。这是有意为之——本层绝不会伪造 run/thread ID,也不会悄悄启动进程。

## 快速开始

把 MCP 服务器加入你的 Codex 配置。要启用真实的、worktree 隔离的执行,你需要把 [Codex CLI](https://github.com/openai/codex) 放进 `PATH`,并设置 `CODEX_TEAM_EXECUTION=1`:

```json
{
  "mcpServers": {
    "codex-team": {
      "command": "npx",
      "args": ["-y", "codex-team-mcp@latest"],
      "env": {
        "CODEX_TEAM_EXECUTION": "1",
        "CODEX_TEAM_EXECUTION_BACKEND": "auto",
        "CODEX_TEAM_PANE_MODE": "1",
        "CODEX_TEAM_PANE_BACKEND": "auto"
      }
    }
  }
}
```

使用 Codex CLI:

```bash
codex mcp add codex-team \
  --env CODEX_TEAM_EXECUTION=1 \
  --env CODEX_TEAM_EXECUTION_BACKEND=auto \
  --env CODEX_TEAM_PANE_MODE=1 \
  --env CODEX_TEAM_PANE_BACKEND=auto \
  -- npx -y codex-team-mcp@latest
```

重新加载或重启 Codex 的 MCP 服务器,然后确认工具清单包含:

```text
TeamCreate
TeamDelete
Agent
SendMessage
TaskCreate
TaskUpdate
TaskList
TaskGet
TeamDiagnostics
TeamMerge
CheckInbox
```

如果发现异常,先调用 `TeamDiagnostics`。它会报告包版本、已注册的工具、状态根目录、活跃绑定、每个 TeamMate 的生命周期状态、pane 元数据、排队中的消息、任务摘要,以及工作区的评审/合并状态。

### 最小模式

如果你只想要持久的团队状态、消息、任务和诊断——而不尝试真实执行或 pane——把相关环境变量省略即可:

```json
{
  "mcpServers": {
    "codex-team": {
      "command": "npx",
      "args": ["-y", "codex-team-mcp@latest"]
    }
  }
}
```

最小模式会创建团队和 TeamMate 身份、持久化消息、管理任务,但 TeamMate 会一直处于 `scheduled` 并标记 `backend_unavailable`,直到启用某个执行后端。

## 配套技能

`codex-team-mcp` 附带一个配套技能 **`codex-team-best-practices`**,教 agent 如何把这套团队层用*好*——回合边界 pull-not-push 的投递模型、收件箱纪律、隔离 worktree 的"先评审后合并",以及不靠忙轮询和消息 ping-pong 的协作方式。它是任务无关的(只指引*怎么用*工具,而不规定你*做什么*),并覆盖 Team Lead 和 TeamMate 两个角色。

MCP 服务器给 Codex 提供工具;技能教它如何驾驭这些工具。用开源的 [`skills`](https://github.com/vercel-labs/skills) CLI 安装(它支持 Codex、Claude Code、Cursor、OpenCode 等):

```bash
# 预览 repo 中附带的技能
npx skills add Wynne-cwb/codex-team-mcp --list

# 安装它(自动检测你已安装的 agent;加 -g 安装到用户全局,-a <agent> 指定某个 agent)
npx skills add Wynne-cwb/codex-team-mcp --skill codex-team-best-practices
```

该技能源码也随本包发布,位于 [`skills/codex-team-best-practices/`](skills/codex-team-best-practices/SKILL.md)——可以从这个本地路径安装,或直接阅读。

## 配置

所有配置都通过环境变量完成。

| 变量 | 取值 | 用途 |
| --- | --- | --- |
| `CODEX_TEAM_EXECUTION` | `1` / `true` / `enabled` | 启用真实执行后端。默认关闭。 |
| `CODEX_TEAM_EXECUTION_BACKEND` | `auto`（默认）,或某个后端名称（如 `codex_cli_exec`） | 固定指定某个后端,或让按能力排序的后端链自行选择。 |
| `CODEX_TEAM_PANE_MODE` | `1` / `true` / `enabled` | 启用覆盖在真实运行之上的 tmux/iTerm2 风格 pane 可视化。 |
| `CODEX_TEAM_PANE_BACKEND` | `auto`（默认） / `tmux` / `iterm2` | 偏好的终端后端（先 tmux,再 iTerm2）。 |
| `CODEX_TEAM_PANE_SESSION_PREFIX` | 受信任的前缀字符串 | 生成 pane 会话时使用的前缀。 |
| `CODEX_TEAM_CODEX_COMMAND` | 命令名称（默认 `codex`） | 在 pane 支撑的运行中用于调用 Codex 的命令。 |
| `CODEX_TEAM_STATE_ROOT` | 路径 | 覆盖 SQLite 状态目录。 |
| `CODEX_TEAM_WORKSPACE_ROOT` | 路径 | 覆盖解析出的工作区根目录。 |

## 工具

| 工具 | 用途 |
| --- | --- |
| `TeamCreate` | 创建持久的团队、leader 身份,以及作用域内的活跃绑定。 |
| `TeamDelete` | 归档团队并使活跃绑定失效,而不硬删除状态。 |
| `Agent` | 创建可寻址的 TeamMate(如 `builder@alpha-team`);记录生命周期/隔离元数据,并尝试取决于后端的启动。 |
| `SendMessage` | 持久化显式消息,随后在收件方下一个回合边界排队投递;当存在持久的后端元数据时,恢复空闲/已停止的 TeamMate。绝不在回合中途注入。 |
| `TaskCreate` | 在 SQLite 中创建团队级任务。 |
| `TaskUpdate` | 更新任务状态、负责人、备注、元数据和阻塞项。 |
| `TaskList` | 按状态或负责人列出简洁的任务投影。 |
| `TaskGet` | 读取完整的任务详情和任务历史。 |
| `TeamDiagnostics` | 报告工具、状态、每个 TeamMate 的生命周期、消息、任务、pane,以及工作区评审/合并摘要(带一个已脱敏的 `include_debug` 视图)。 |
| `TeamMerge` | **codex-team 扩展**——由 TL 主导,对隔离 worktree 分支进行 `review` / `merge` / `escalate`,合回 leader 工作树。 |
| `CheckInbox` | **codex-team 扩展**——通过可靠的 MCP/JSON 通道拉取寄给调用方的消息(完整正文,最旧在前)。正文是拉取的,绝不推送:被提示(每个工具结果上的 `inbox_pending` 计数,或一行 📬)时才调用,而不是循环轮询。 |

`TeamCreate`、`TeamDelete`、`Agent`、`SendMessage` 以及四个任务工具与 Claude Agent Team 工具一一对应。`TeamDiagnostics`、`TeamMerge` 和 `CheckInbox` 是明确的 codex-team 扩展,并非原生 Claude 工具。

## 真实执行后端

执行后端是可选启用的。当 `CODEX_TEAM_EXECUTION=1` 且 Codex CLI 可用时,一条按能力排序的后端链会选出最安全的可运行后端(`codex_cli_exec` 后端用 `codex exec --json` 启动一次运行并捕获持久的 `thread_id`,用 `codex exec resume` 续接它)。一个后端只有在能在指定的 worktree 目录中运行、并能暴露一个持久标识符时才符合条件。

当已设置启用开关但没有任何后端符合条件时(例如 `PATH` 里缺少 `codex` CLI),`Agent` 仍会持久化团队/成员/运行记录,然后返回一个清晰的 `execution_backend_unavailable` 错误并附带修复指引——它绝不会报告一个伪造的成功。

### 模型供应方认证(代理 / 自定义 `env_key`)

`codex_cli_exec` 后端会把 `codex exec` 作为一个**继承 MCP 服务器环境的子进程**运行。使用 Codex 默认的 OpenAI 登录时,不需要额外配置。但如果你的 `~/.codex/config.toml` 选用了一个通过环境变量(其 `env_key`)认证的自定义或代理 `model_provider`,那么该变量也必须能到达 codex-team MCP 服务器——否则嵌套的 `codex exec` 会失败,TeamMate 运行会显示 `backend_failed`,真实原因为 `Missing environment variable: <KEY>`(在 `TeamDiagnostics` 的 `last_error` 中呈现)。

```toml
# 顶层:一个通过环境变量认证的自定义/代理供应方
model_provider = "proxy"

[model_providers.proxy]
base_url = "https://your-proxy.example.com/v1"
env_key = "AM_API_KEY"             # ← Codex 从这个环境变量读取认证信息

# 执行后端会派生 `codex exec`,它需要同一个认证变量:
[mcp_servers.codex-team]
command = "npx"
args = ["-y", "codex-team-mcp@latest"]
env_vars = ["AM_API_KEY"]          # 从 Codex 自身的环境转发(推荐——配置文件里不出现密钥)

[mcp_servers.codex-team.env]
CODEX_TEAM_EXECUTION = "1"
CODEX_TEAM_EXECUTION_BACKEND = "auto"
```

> [!IMPORTANT]
> `env_vars` 从 Codex 自身的环境转发该值,因此不会把密钥写进配置文件。Codex **不会**展开 `config.toml` 中的 `${VAR}`。如果变量名匹配 Codex 默认的密钥排除规则(名称包含 `KEY`、`TOKEN`、`SECRET` …),即使列在 `env_vars` 中也可能被过滤掉;如果重启 Codex 后 `TeamDiagnostics` 仍报告该变量缺失,可以设置 `shell_environment_policy.ignore_default_excludes = true`,或者在 `[mcp_servers.codex-team.env]` 下直接写入字面值(如 `AM_API_KEY = "<value>"`)。

### worktree 隔离的改文件工作

本版本已交付改文件的 TeamMate 工作,但只能通过独立分支上的**隔离 git worktree** 进行:

- 每次改文件的运行都必须在一个必备的、隔离的 worktree 中进行(记录基线版本);只读和仅评审的工作不需要隔离。
- 没有具体隔离 worktree 的改文件运行会被**阻断**,绝不会被重定向到 leader 工作树(`ISOL-01`,fail-closed)。
- 当后端支持时,操作系统沙箱会作为可选的 `sandbox_overlay` 记录在 worktree 之上——尽力而为且不作为门禁;它的缺失绝不会阻断一次运行。

> [!NOTE]
> worktree 隔离使用真实的 `git worktree`,因此 leader 工作区**必须是一个 Git 仓库**。如果不是,就无法创建隔离 worktree,改文件的运行会被阻断(fail-closed)——只读/仅评审的工作不受影响。请在一个 Git 仓库内运行 codex-team(只是想试用的话可以 `git init` 一个空仓库)。

### 用 `TeamMerge` 进行 TL 评审后的合并

当一个 TeamMate 在它的隔离分支上完成工作后,Team Lead 用 `TeamMerge` 把它合回来:

```js
TeamMerge({ "action": "review", "run_id": "<run>" })   // 分支、基线、变更文件、diff 摘要、冲突预览
TeamMerge({ "action": "merge",  "run_id": "<run>" })   // 可审计地合并进 leader 工作树,随后清理 worktree
TeamMerge({ "action": "escalate", "run_id": "<run>" }) // 把未解决的冲突交给人类处理
```

> [!IMPORTANT]
> `TeamMerge` 是一个显式、可审计的 TL 动作——绝不是悄悄的后台自动合并。发生合并冲突时,leader 工作树会被干净回滚,worktree 会被保留以供评审;未解决的冲突可以升级给人类。对账过程绝不自动合并,且自动删除工作区或丢弃排队消息始终被禁止。

## 示例工作流

创建一个团队和一个可寻址的 TeamMate:

```js
TeamCreate({ "team_name": "Alpha Team", "description": "Compatibility validation" })

Agent({
  "name": "Builder",
  "mode": "write",
  "prompt": "Add a health-check endpoint and a unit test."
})
```

启用执行后,该运行会在一个隔离 worktree 中启动、捕获持久元数据,并以空闲收尾。给它发一条后续消息——一个带有持久元数据的空闲 TeamMate 会被自动恢复:

```js
SendMessage({
  "to": "Builder",
  "summary": "Follow-up",
  "message": "Also cover the error path in the test."
})
```

然后评审并把分支合回:

```js
TeamMerge({ "action": "review", "run_id": "<run>" })
TeamMerge({ "action": "merge",  "run_id": "<run>" })
```

> [!NOTE]
> 普通对话文本不是 TeamMate 的收件箱消息。每当用户文本需要被投递给某个 TeamMate 时,都要用 `SendMessage`。

## 消息投递:回合边界拉取,而非推送

投递是**回合边界,而非同步**的。`SendMessage` 会被立即*持久化*到共享的 SQLite `messages` 表,但它只会在某个回合边界*投递*——即收件方在两次回合之间处于空闲或已停止时,绝不在回合中途注入(你无法在模型思考中途打断它)。正在运行的收件方的消息状态为 `queued_for_next_turn`;空闲/已停止的为 `queued_while_idle`。这两种状态都不是错误。

正文是**拉取的,绝不推送**。唯一会朝着活跃运行时传递的,是一个简短、长度有界的提示(一个计数加发送方 ID),绝不包含正文。收件方通过可靠的 MCP/JSON 通道用 `CheckInbox` 拉取完整正文。具体来说:

- **TeamMate**(pane 支撑)会在其 pane 中被注入一行 `📬 N new message(s) — run CheckInbox to read.`,随后调用 `CheckInbox` 读取正文。
- **Team Lead** 没有 pane,因此它*拉取*:未读的 teammate→TL 消息会作为 `inbox` 块自动浮现到 codex-team 工具结果上(小批量给出完整正文,大批量给出紧凑摘要),并且每个工具结果都携带一个 `inbox_pending: N` 计数。TL 在 `inbox_pending > 0` 或被提示时才调用 `CheckInbox`——而不是循环轮询。

> [!NOTE]
> 这仍然是拉取。向交互式 TL 的浮现绑定于模型驱动的动作(一次用户提问,或任意一次 codex-team 工具调用)。不存在"消息到达 → 空闲的 TL 立即被唤醒"的推送;恢复/注入的结果是*尝试性的*,绝非保证回合中途注入。

### 可选的 `UserPromptSubmit` 收件箱提示钩子

一个小巧的、**只读**的 Codex CLI 钩子作为仓库工件提供,位于 [`hooks/`](hooks/README.md)——它**不会**被自动安装,也不会向 `~/.codex` 写入任何内容。接好后,它会在 Codex 的 `UserPromptSubmit` 事件上运行,统计 leader 的未读消息数,并(仅当 `N > 0` 时)在 TL 提交提问的同一回合注入一行 `📬 You have N new teammate message(s) — call CheckInbox before responding.`。它是只读的(一次走索引的 `COUNT`,绝不把消息标记为已读),对 teammate 会话和空收件箱都不做任何事,且绝不向提问路径抛出异常。契约和手动安装片段见 [`hooks/README.md`](hooks/README.md)。

## 诊断与恢复

- **每个 TeamMate 的状态:** 默认的 `TeamDiagnostics` 会为每个 TeamMate 增加一行 `teammates[]`,带上它真实的持久状态(`unavailable` / `starting` / `running` / `idle` / `stopped` / `failed` / `stale`)以及 `attached` / `needs_review` 标志。这些行只携带名称 + 状态 + 标志。
- **增强调试:** `TeamDiagnostics({ include_debug: true })` 会增加已脱敏的后端能力、持久元数据、完整的 attach 命令,以及——当某次运行命中 `codex_session_metadata_unavailable` 时——一个 `metadataDiagnostics` 块(缺失来源、观察到的键、所选后端、修复指引)。调试细节被脱敏为键名、枚举值和恒定的修复指引;它绝不包含原始的 prompt/输出/元数据值。
- **持久化恢复:** 对一个带有持久恢复元数据的空闲或已停止 TeamMate 调用 `SendMessage`,会触发一次自动恢复(去抖动到每一阵只尝试一次)。正在运行的收件方会被排队到下一个回合边界。一次失败的恢复会让收件箱消息保持排队,并向发送方发送一条已脱敏的失败通知——不存在保证的回合中途注入。

## Pane 模式

Pane 模式在真实运行之上增加一个可选的、取决于后端的可视化层。启用且有支持的终端后端可用时,一个由 `Agent` 启动的运行会自动创建或附着一个可见的 tmux/iTerm2 风格 pane,并持久化它的 attach 元数据。该 pane 是一种可视化近似——Codex 并不在 pane *内部*运行,这个覆盖层也绝不会改变运行的状态、后端或 thread id。如果 pane 不可用,运行会降级为一个 `unavailable` 的 pane 标记,核心团队行为不受影响。

默认情况下,诊断只显示一个 attach 提示和会话标签;完整、可直接粘贴的 attach 命令出现在 `include_debug` 下。空闲/已停止的 pane 会保持打开,以保留回滚缓冲(scrollback)。每个 pane 会 tail TeamMate 的实时运行日志(对 codex exec 日志 `tail -f`),在 iTerm2 中 leader 留在左侧,TeamMate 在右侧纵向堆叠。

### Pane 清理(拆除)

pane 在两个显式触发下关闭,两者都是尽力而为且不作为门禁(关闭失败绝不会让发起的调用失败):`TeamDelete` 会关闭属于该团队的每一个 pane;向某个 TeamMate(通过 `SendMessage`)发送一条结构化的 `{ "type": "shutdown_request" }` 消息会关闭该 TeamMate 的 pane。该 shutdown 消息仍像往常一样被持久化/排队——关闭 pane 是一个额外的副作用,不会改变成员状态或恢复语义。被关闭的 pane 在运行元数据中标记为 `unavailable`(`degradation_reason: "pane_closed"`)。

### iTerm2 pane 设置(运行 Codex CLI 时)

iTerm2 后端从 `TERM_PROGRAM` / `ITERM_SESSION_ID` 检测它的终端上下文,并把 TeamMate 的 pane 堆叠到 leader 会话旁边。Codex 默认**不会**把这些变量转发给 MCP 服务器,因此请在 `~/.codex/config.toml` 中为 codex-team 服务器把它们加进 `env_vars`(以及 `TMUX` / `TMUX_PANE`,让 tmux 后端也能检测到一个原生会话):

```toml
[mcp_servers.codex-team]
env_vars = ["AM_API_KEY", "TERM_PROGRAM", "ITERM_SESSION_ID", "TMUX", "TMUX_PANE"]
```

没有 `TERM_PROGRAM` / `ITERM_SESSION_ID` 时,iTerm2 后端会报告不可用,pane 模式会回退到一个分离(detached)的 tmux 会话(仅支持 attach)。

## 运行时状态与安全

运行时状态存储在对话记录之外的 SQLite 中。默认情况下,服务器把状态解析到工作区根目录下的:

```text
.codex-team/state/codex-team.sqlite
```

用 `CODEX_TEAM_STATE_ROOT` 和 `CODEX_TEAM_WORKSPACE_ROOT` 覆盖这些位置。

工作区检查使用真实的 `git status`/`diff` 并 fail-closed:有改动或无法核实的 worktree 会被标记为 `needs_review`,而不是自动合并或删除。把 `pending_review`、`needs_review` 和 `merge_conflict` 当作评审门禁,而不是 Team Lead 工作区里已接受的改动。

## 本地开发

```bash
npm install
npm run build
npm test -- --run
npm run smoke:list-tools
npm run pack:dry-run
```

冒烟测试会启动构建好的 stdio MCP 服务器,并验证核心兼容工具是否可见。

## 文档

- [启动与排错](docs/startup.md)
- [Claude 到 Codex 的工具映射](docs/tool-mapping.md)
- [兼容性矩阵](docs/compatibility.md)
- [验证证据](docs/validation.md)
- [codex-team best-practices 技能](skills/codex-team-best-practices/SKILL.md)
- [可选的 `UserPromptSubmit` 收件箱提示钩子](hooks/README.md)
