# Changelog

All notable changes to `codex-team-mcp` are documented here. This project
follows [semantic versioning](https://semver.org/).

## v0.5.1 — workspace root 误绑定的诊断与守卫(安装目录场景)

修复一类难以自查的失败:当 MCP server 的 `cwd` 被(安装器/vendored 配置)写死到自身
安装目录(如 `~/.codex/vendor/codex-team-mcp`)且未设 `CODEX_TEAM_WORKSPACE_ROOT` 时,
工作区根目录回退到那个非 Git 目录,导致所有 team 绑到安装目录、且每个文件改动型
TeamMate 都被 `workspace_isolation_required` 拦下——而错误信息此前零线索,看起来像
git/worktree 问题。本版不改变解析行为,只让失败**可自解释**。

### 修复 (Fixes)
- **`workspace_isolation_required` 现在带可执行 remediation**:`Agent` 结果在隔离失败时
  新增 `error_detail` 字段(与稳定的 `error_code` 并存),说明具体原因(worktree 建不起来——
  通常因为 leader 工作区根不是 git 仓)+ 三种修法(传 `cwd` / 设 `CODEX_TEAM_WORKSPACE_ROOT` /
  从项目仓启动)。文本经 sanitize,绝不回显 prompt。此前该原因只记在审计事件 payload 里,
  工具返回只有光秃秃的 error_code。
- **修复安装目录探测漏洞**:`state_root_inside_package` 守卫此前只认开发态 checkout 名
  `codex-team`,认不出发布/vendored 包名 `codex-team-mcp`,所以最常见的误绑定场景连告警都
  不触发。现改为按工作区根目录的 basename 检测(`codex-team` 或 `codex-team-mcp`),并给出
  可执行的告警文案。

### 新增 (Features)
- **`workspace_warnings` 在工具结果中暴露**:当检测到工作区根目录是 codex-team 自身的安装
  目录时,`TeamCreate` / `Agent` 结果会附带 `workspace_warnings`(此前该告警仅作为
  `TeamDiagnostics` 内的死元数据,从不在创建路径上暴露给用户)。
- **`TeamDiagnostics` debug 块新增 `clientCapabilities`**:`include_debug` 时透出已连接
  MCP client(如 codex)声明的能力,用于确认是否支持 `roots`——这是后续“从 MCP roots 解析
  工作区根、实现零配置”的前置判断依据。

### 变更 (Changes)
- 向后兼容、无破坏性变更:`error_detail` / `workspace_warnings` / `clientCapabilities`
  均为新增字段;解析顺序(`CODEX_TEAM_WORKSPACE_ROOT` → `process.cwd()`)与隔离 fail-closed
  语义不变。README / README.zh-CN 新增「工作区根目录的解析方式」一节,警示写死 `cwd` 的坑。
- **README 安装步骤改为 agent-proof**:edon 的根因是让 Codex 读 README 代为安装时,Codex
  自行 vendoring 并写死了 `cwd`。Quickstart 现新增一条硬约束:严格用 `npx`、不要 vendoring、
  不要设 `cwd`(对"由 agent 代装"显式适用),并解释 workspace root 取自 server 的 cwd——
  从源头阻止安装方即兴写死 `cwd`。

## v0.5.0 — TL 收件箱拉取优化 + 使用最佳实践 skill + 中文 README

### 新增 (Features)
- **TL 收件箱拉取优化**:每个 codex-team 工具结果新增 `inbox_pending: N` 计数(leader
  未读数,在自动浮现 claim 之后计算,恒存在含 0);leader 自动浮现(auto-surface)改为
  **size-aware**——小/短批量内联全文,大/重批量给紧凑 digest(发件人 + summary + 预览
  ≤200 字 + message_id),全文按需经 `CheckInbox` 拉取。
- **可选 `UserPromptSubmit` 收件箱提示 hook**:作为**只读、不自动安装**的仓库工件随包
  发布(`hooks/`),在 TL 提交 prompt 时注入未读提示(仅 N>0;绝不标记已读;teammate
  会话 / 空收件箱 no-op;绝不抛进 prompt 路径)。
- **新增 `codex-team-best-practices` skill**:任务无关的使用最佳实践指南,覆盖 Team Lead
  与 TeamMate 两个角色(投递心智模型、状态解码、何时建 team、隔离=合并门、收件箱纪律、
  沟通规范),含 `references/delivery-model.md` 与 `references/troubleshooting.md`。可用
  `npx skills add` 安装(README 有说明)。
- **3 条核心 norm 蒸馏进工具描述**:`SendMessage`(turn-boundary 非同步)、`CheckInbox`
  (pull-not-push + `inbox_pending` 语义)、`Agent`(隔离=合并门)——always-on 的可靠通道。
- **新增 `README.zh-CN.md`**(简体中文全量翻译)+ 首页语言切换。

### 变更 (Changes)
- 移除旧 skill `agent-team-compatibility`,内容迁入新 skill(词汇映射)与
  `references/troubleshooting.md`("layer unavailable" 排障)。
- 向后兼容、无破坏性变更:`inbox_pending` 为新增字段,size-aware 仅改变渲染量,不改变
  消息选择 / 投递语义 / D-02。

## v0.4.0 — 双向消息 + CheckInbox + turn-boundary 投递模型 + UAT 修复

### 新增 (Features)
- **双向消息 (bidirectional messaging)**:支持 teammate → Team Lead 以及
  teammate ↔ teammate 的消息路由(此前仅 TL → teammate 单向)。
- **CheckInbox 工具**:teammate 与 TL 可主动拉取未读消息。新增收件箱读模型
  (`messageInboxService`)与 `inboxHandler`。
- **TL 收件箱自动浮现 (auto-surface)**:任意 leader 工具调用的结果会自动附带
  `inbox` 块(`withLeaderInboxSurface`),TL 无需显式轮询即可看到 teammate 回话。
- **turn-boundary 投递模型**:消息在 turn 边界排空投递
  (`queued_while_idle` / `queued_for_next_turn`),不在 turn 中途打断 teammate。
- **teammate 能力门 + 主动消息限流**:`capabilityGuard` 限定 teammate 可用工具;
  `CODEX_TEAM_MAX_PROACTIVE_MESSAGES_PER_TURN` 限制每个 turn 的主动消息数量。
- **caller / member 身份解析增强**:基于环境变量的 caller 身份识别与 teammate
  member 身份解析(`contextResolver`)。

### 修复 (Fixes)
- **teardown 停止收敛为 `stopped`(不再 `failed`)**:主动拆除 pane 的 run/member
  现标记为 `stopped`,并写入 `intentional_stop` 标记;真实崩溃(无标记)仍判定为
  `failed`。
- **message `status` / `delivery_status` 收敛到终态**:消息状态从 `queued` 正确
  推进到 `delivered` → `read`,`delivery_status` 不再永久卡在推送尝试值。时间戳
  (`delivered_at` / `read_at`)成为消息选择的唯一真相源,CheckInbox / pending 的
  选择行为保持不变(delivered 但未读的消息仍会浮现)。
- **`changed_files` 在 teardown 边界重新捕获**:worktree 在 revert → teardown 之后,
  `changed_files` 现反映最终的干净状态,修掉此前残留 stale 文件列表的问题。

### 内部 (Internal)
- schema:`MESSAGE_ROW_STATUSES` 新增 `delivered` / `read`,
  `MESSAGE_DELIVERY_STATUSES` 新增 `delivered`(TEXT 列,含 migration,向后兼容)。
- diagnostics 大幅扩展(消息 / lifecycle / pane 可观测性)。
- 测试:528 passed(52 文件),覆盖双向消息、turn-boundary 投递、能力门、
  status 收敛、`changed_files` teardown 捕获等回归。

## v0.3.3
Pane-hosted codex TUI teammates + multi-repo worktree isolation + robust
reconcile/delivery.

## v0.3.2
iTerm2 pane parity (live tail + stacked layout) + pane teardown.

## v0.3.1
Context-aware pane backend selection + iTerm2 `it2` fix.

## v0.3.0
Real execution hardening (async exec, multi-repo worktrees, diagnosability).

## v0.2.0
Real worktree-isolated execution backend.

## v0.1.1
Recommend pane mode in README.
