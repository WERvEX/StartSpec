# KM0 1.1 规划

状态：规划中（2026-11）。本文档随实现推进更新；每完成一个阶段，把定稿的设计并入 [DESIGN.md](DESIGN.md)。

## 分工

- **KM0** 负责确认需求、拆分任务，并规划每个任务由哪个 Agent 的哪个模型来做；然后按这个规划把任务交给对应的 Agent，收回结果并验收。KM0 不在执行中途切换模型：任务没通过时，沿用 1.0 的做法，由用户决定是否换到升级链上更强的组合重做。
- **KM0 Runner** 是和其他 Agent 同级的一种执行方式：它用 pi 执行，并且按任务完成情况自己决定是否切换模型。Runner 的路线图和协议不因 1.1 改变。
- **各个 Agent**（Claude Code、Claude Desktop，以后还有 Codex、Cursor、DSH、ZCode、WorkBuddy 等）只负责在给定的工作目录里完成交给它的那一个任务。

## 目标

1.1 先接入两个 Agent，验证它们能按 KM0 的规划配合完成一个项目：

- **Claude Code**：KM0 直接启动 `claude -p`，全自动执行。
- **Claude Desktop**：它不能被程序启动，改为由它来找 KM0 领任务（MCP），做完回报。

另外补上 1.0 的一个缺口：应用内更新从没用打包好的程序真实测试过（U1）。

不做：

- 自动测试里不调用真实的 Claude Code 和 Claude Desktop，只用冒充的程序和脚本化的 MCP 客户端。真实调用留一份手动验收清单和一个默认不跑的测试。
- 其他 Agent 放到 1.1 之后，一个 Agent 一个 PR（见第 5 节）。
- 没有依赖关系的任务暂不并行，按依赖顺序一个一个执行。
- KM0 不合并 Agent 产出的分支。

## 1. 直接交给 Agent 执行（E1）

“设置 → 执行”新增第三种执行方式“**直接交给 Agent**”，和 KM0 Runner、自定义命令并列。

- **执行过程**：按依赖顺序，逐个任务：
  1. 在运行目录里给任务建一个 git worktree，分支 `km0/<run_id>/<编号>`，基于仓库当前的 HEAD；有依赖的任务基于它所依赖任务的分支（依赖多个时依次合并，冲突就把这个任务标为“阻塞”）。用户的工作区和已有分支不动。
  2. 按路由结果找到这个任务的 Agent 和模型，交给对应的接入方式（第 2、3 节）。
  3. Agent 结束后，把 worktree 里没提交的改动提交到任务分支；任务有测试命令就运行一次。
  4. 写这个任务的报告。
- **和 Runner 用同一种文件格式**：运行目录里写 `progress.jsonl`、`reports/NN.json`（`report_version: 2`）、`summary.json`；停止也看 `STOP` 文件。所以 1.0 的进度面板、停止、自动导入、验收、本地记录和“重做”都直接可用。
- 一个任务失败、被阻塞或者等不到回报时，依赖它的任务标为“阻塞”，不执行。
- 预检：仓库、每个任务的 Agent 能不能用（第 2、3 节各自的检查）、预算。

## 2. Claude Code（E2）

- 命令：`claude -p --output-format stream-json --verbose --model <模型> --permission-mode acceptEdits --allowedTools <白名单> --max-budget-usd <上限>`。提示词就是交接包里这个任务的内容，从 stdin 传入；工作目录是任务的 worktree。
- 读 stream-json：工具调用计步数并显示在进度里；`result` 事件给出花费、token 用量和是否出错。
- 停止：结束整个进程（Windows 上结束进程树）。
- 登录：服务商配了 API Key（或中转地址）时，通过环境变量 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 传给它；没配时使用用户本机 Claude Code 自己的登录，并在设置里提示用户自行确认这样用符合订阅条款。
- 预检：找到 `claude`、版本不低于测试过的最低版本。

## 3. Claude Desktop（E3）

- 新增预置 Agent “Claude Desktop”，本家厂商 Anthropic，默认不启用。路由很少会自动选它，用户可以在路由表里把某个任务手动指定给它。
- KM0 提供一个 MCP 服务器，用 `KM0 --mcp` 启动（不打开窗口，stdio）。“设置 → 执行”显示要加到 Claude Desktop 配置里的片段，可以一键复制；交互式的 Claude Code 用 `claude mcp add` 也能接。
- 执行到这样的任务时，它在进度里显示为“**等待 Claude Desktop 领取**”。用户在 Claude Desktop 里说“做 KM0 的任务”，Claude 通过这些工具完成：
  - `km0_next_task`：领取任务，返回任务内容（和交接包一致）。
  - `km0_list_files`、`km0_read_file`、`km0_write_file`：只能访问这个任务的 worktree。Claude Desktop 本身不能改本地文件，这几个工具给它一个限定在 worktree 里的工作区。
  - `km0_run_tests`：运行任务的测试命令，返回结果。
  - `km0_report`：回报完成或放弃，附一句说明。
- 回报之后的提交、测试和报告和 Claude Code 一样。
- MCP 服务器不碰数据库，只读写 KM0 数据目录里的任务收件箱（`dispatch/`），执行进程写入、MCP 服务器领取，所以和打开着的 KM0 窗口互不影响。

## 4. 测试：两个 Agent 配合完成一个项目

- **冒充的 `claude`**：一个脚本，按剧本修改文件、输出 stream-json，覆盖成功、出错、超出预算和停止的情况。
- **脚本化的 Claude Desktop**：用 MCP SDK 的客户端启动 `--mcp` 服务器，像 Claude 一样领任务、读写文件、跑测试、回报。
- **配合测试**：一个项目拆成三个任务，01 给 Claude Code，02 给 Claude Desktop（依赖 01），03 给 Claude Code（依赖 02）。检查：
  - 三个任务都完成；
  - 02 的分支里有 01 的改动，03 的分支里有前两个的改动；
  - 报告被导入、完成验收；
  - 中途停止时，等待领取的任务被取消。

  单元测试和 e2e 各跑一遍，e2e 截图给界面验收用。
- **手动验收清单**（[checklists/claude-agents.md](checklists/claude-agents.md)）：在一台装了 Claude Code 和 Claude Desktop 的电脑上，用真实的两个 Agent 走一遍同样的三个任务。
- **真实调用测试**：`KM0_CLAUDE_REAL=1` 时用真实的 `claude` 跑 Claude Code 那一半，默认不跑。

**完成标准**：自动测试全部通过；**暂停，请用户确认设置页和执行面板**；手动验收清单走通。

## 5. 之后的 Agent

每个 Agent 要的是同一套东西：

- 接入方式：命令行驱动或者 MCP 领取；
- 输出解析（有结构化输出就读步数和花费，没有就只看退出码和改动）；
- 预检；
- 一个冒充的程序和测试。

1.0 的交接包里已经有这些 Agent 的无界面命令，可以直接作为起点：

- Codex：`codex exec`
- Cursor：`agent -p`
- DSH：`dsh headless`
- ZCode：`zcode --prompt --mode build`

WorkBuddy 要先调研它的接入方式。自定义 Agent 走它自己的启动命令模板，只看退出码和改动。

## 6. 应用内更新的真实测试（U1）

- `KM0_UPDATE_FEED=<地址>` 让打包后的程序改用这个更新源（generic provider），“设置 → 关于”会显示来源。
- 用同一份代码打 `1.1.0-test.1` 和 `1.1.0-test.2` 两个版本，本地 HTTP 服务器提供 test.2，启动 test.1 后走完检查、下载、安装、重启，确认版本号变了、数据还在。
- Linux（AppImage）和 Windows（NSIS）在 CI 里跑；macOS 未签名，跳过并写明原因。
- 风险：Playwright 能不能直接驱动打包后的程序，先做最小试验。

## 阶段与顺序

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| E1 直接交给 Agent（已完成） | 第三种执行方式；worktree 和分支；Runner 格式的进度和报告 | 单元测试通过；Runner 和自定义命令照常可用 |
| E2 Claude Code（已完成） | `claude -p` 接入、登录、预检、冒充的 `claude` | 单元测试和 e2e 通过 |
| E3 Claude Desktop（已完成，待界面确认和手动验收） | 预置 Agent、`KM0 --mcp`、收件箱、设置页的配置片段 | 配合测试通过；**暂停，确认界面**；手动清单走通 |
| U1 更新的真实测试（已完成，Windows 以 CI 结果为准） | 第 6 节 | Linux、Windows 在 CI 里通过 |
| R1 发布 1.1 | 文档、安装包 | **最终界面验收** |

顺序：E1 → E2 → E3；U1 可以穿插做。
