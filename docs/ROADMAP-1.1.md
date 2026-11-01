# KM0 1.1 规划

状态：规划中（2026-11）。本文档随实现推进更新；每完成一个阶段，把定稿的设计并入 [DESIGN.md](DESIGN.md)。Runner 一侧的阶段同时写进 KM0-runner 的 [docs/ROADMAP.md](https://github.com/WERvEX/KM0-runner/blob/main/docs/ROADMAP.md)，按它的 [CONTRIBUTING.md](https://github.com/WERvEX/KM0-runner/blob/main/CONTRIBUTING.md) 走：协议有改动时两边各开一个 PR，先合并并发布 Runner，再合并 KM0。

## 目标

1.0 有三个缺口：

- 应用内更新只用假的更新源（`KM0_FAKE_UPDATE`）测过界面，打包后的程序从来没有真的下载、替换、重启过一次。
- 执行只有一条路：KM0 → KM0 Runner → pi。路由选中 Claude Code 的任务，实际是 pi 在跑同一个模型，Claude Code 本身没有参与。
- Claude Desktop 和交互式的 Claude Code 只能手动复制交接包里的提示词。

1.1 的做法：

- **更新**：在 CI 里用打包好的程序真实地走一遍更新：装一个旧版本，本地起一个更新源提供新版本，自动检查、下载、安装、重启，最后确认版本号变了。
- **Claude Code 执行**：Runner 的阶梯上，每一级可以指定用 pi 还是 Claude Code。路由到 Claude Code 的任务，在 worktree 里由真正的 `claude -p` 执行，升档、测试、合并、报告、停止和进度都沿用 Runner 现有的机制。
- **Claude Desktop**：KM0 提供一个 MCP 服务器。Claude Desktop（或交互式的 Claude Code）通过它领任务、读交接内容、回报结果，KM0 照常验收。

不做：

- CI 和自动测试里不调用真实的 Claude Code，只用脚本冒充 `claude`。真实调用留一个手动开启的测试，由用户在本地运行。
- 未签名的 macOS 版本仍然不能在应用内更新。
- Runner 不接 Codex 等其他 Agent，等 Claude Code 这条路跑通再看。
- KM0 不合并 Agent 产出的分支。

## 1. 应用内更新的真实测试（U1，只改 KM0）

- `KM0_UPDATE_FEED=<地址>` 让打包后的程序改用这个地址作为更新源（electron-updater 的 generic provider）。设置后，“设置 → 关于”会显示更新来源，避免悄悄换源。
- `e2e-packaged/update.spec.ts`：
  1. 用同一份代码打两个版本：`1.1.0-test.1` 和 `1.1.0-test.2`（electron-builder 的 `extraMetadata.version`）。
  2. 在本地起一个 HTTP 服务器，放 test.2 的安装包和 `latest*.yml`。
  3. 启动 test.1，在“关于”里检查、下载、重启安装。
  4. 等它重启，确认“关于”里的版本是 test.2，数据目录里的项目还在。
- 平台：Linux 测 AppImage；Windows 测 NSIS（先静默安装 test.1）。macOS 未签名，跳过并写明原因。
- CI：新增 `update-test` 任务，在 Linux 和 Windows 上跑。PR 改到更新相关的文件或打包配置时必跑，`master` 上每次都跑。

**完成标准**：Linux 和 Windows 的 `update-test` 在 CI 里通过；发布 1.1.0 时，再从 1.0.0 实际升级一次。

**风险**：Playwright 能不能直接驱动 AppImage 和装好的 NSIS 程序，要先做一个最小的试验。不行的话，改成在程序里加一个只在测试版本里生效的自动操作开关。

## 2. Runner：Claude Code 后端（C1，KM0-runner 0.4.0）

这一项原来在 Runner 路线图的“暂不做”里，理由是 KM0 的自定义执行命令可以覆盖。自定义命令只能启动、显示输出，没有升档、测试、合并和逐任务的报告，所以改为在 Runner 里做，并更新 Runner 的路线图。

- **配置**：阶梯的每一级（全局 `ladder` 和 `task_ladders`）新增可选字段 `agent: pi | claude_code`，默认 `pi`。`claude_code` 的级，`model` 写 Claude 的模型 ID（如 `claude-sonnet-5-5`），不经过 pi 的 `models.json`。
- **执行**：新增 `ClaudeCodeClient`，和 `PiClient` 同一套接口（开始、续跑、中止，返回同样的 `RunOutcome`）：
  - 命令：`claude -p --output-format stream-json --verbose --model <模型> --permission-mode acceptEdits --allowedTools <列表> --max-budget-usd <本级 cost_limit> --append-system-prompt <Runner 的规则>`。提示词从 stdin 传入，工作目录是任务的 worktree。
  - 读 stream-json：每次工具调用记一步（对应 `step_limit`）；`result` 事件给出花费、轮数、token 用量和是否出错。
  - 续跑：服务商出错时，用 `--resume <session_id>` 接着跑，和 pi 的续跑一样。
  - 停止：Linux/macOS 用 SIGTERM 结束整个进程组；Windows 结束进程树。`STOP` 文件照常生效。
- **登录**：用户可以用 Claude 订阅登录，也可以用 API Key。Runner 不碰登录信息，只把 KM0 传来的 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_BASE_URL` 原样交给 `claude`。
- **版本**：`claude --version` 不低于一个测试过的最低版本。Claude Code 会自动更新，所以不锁定到某一个版本。
- **报告**：`attempts[]` 新增可选字段 `agent`；订阅登录时，花费照记，另外记 token 用量，由 KM0 按计费方式换算。`report_version` 不变。
- **测试**：`tests/fixtures/claude` 用脚本冒充 `claude`，按剧本输出 stream-json；覆盖升档、续跑、停止、超出预算和输出不是 UTF-8 的情况。`tests/test_real_claude.py` 只在设置了 `KM0_TEST_CLAUDE` 时运行。三平台 CI 全绿。

**完成标准**：Runner 0.4.0 发布；只用 pi 的配置照常能跑。

**待确认**：权限默认用 `acceptEdits` 加工具白名单（Bash 会放行，和 pi 现在一样能执行命令）。要更严格的话，可以像 pi 一样放进容器里跑。

## 3. KM0：用 Claude Code 执行（C2，要求 Runner 0.4.0）

- 生成 Runner 配置时，路由到 Claude Code、模型属于 Anthropic 的那一级写 `agent: claude_code`；其他组合仍然由 pi 执行。
- “设置 → 执行”：
  - 显示是否找到 `claude`、版本，以及登录方式（订阅或 API Key）。
  - 开关“路由到 Claude Code 的任务用 Claude Code 执行”：找到 `claude` 时默认打开；关掉就退回 1.0 的做法，交给 pi。
- 预检：
  - `claude` 找到且版本够用。
  - 服务商按 token 或中转计费时，要有 key（中转还要有地址）。
  - 订阅计费时，提醒会占用订阅额度。
- 密钥仍然只通过环境变量传给 Runner。
- 订阅额度开始统计 Claude Code 的运行（来自报告里的 token 用量），补上 1.0 的已知缺口。
- 执行面板：每个任务显示是哪个 Agent 在跑。
- `fake-runner.mjs` 认识 `agent` 字段；`RUNNER_MIN_VERSION` 改为 0.4.0；`KM0_RUNNER_REAL` 集成测试用冒充的 `claude` 跑一遍。

**完成标准**：e2e 里路由到 Claude Code 的任务由（冒充的）Claude Code 跑完、验收；**完成后暂停，请用户确认执行面板和设置页**。

## 4. Claude Desktop：KM0 的 MCP 服务器（D1）

- **启动方式**：`KM0 --mcp`（安装好的程序，不打开窗口），以 stdio 方式提供 MCP 服务。它直接读写 KM0 的数据库（SQLite WAL），和打开着的 KM0 窗口互不影响；窗口发现数据有变化时自动刷新。
- **工具**：
  - `km0_projects`：列出项目和进度。
  - `km0_next_task(project)`：下一个可以开始的任务，依赖都已完成。
  - `km0_task(project, seq)`：任务说明、验收标准、相关决策和文档摘录，与交接包内容一致，并要求 Agent 在 `km0/<编号>-<短名>` 分支上提交。
  - `km0_report(project, seq, branch, summary)`：回报完成。KM0 只读取这个分支相对基线的 diff，按验收标准判定，结果和 Runner 的运行一样记录和显示。
- **设置**：“设置 → 执行 → Claude Desktop”显示要加到 `claude_desktop_config.json` 的配置片段，可以一键复制；同时给出 Claude Code 的 `claude mcp add` 命令。
- **测试**：用 MCP SDK 的客户端驱动服务器（vitest），e2e 里走一遍“领任务 → 在临时仓库里提交 → 回报 → 窗口里看到验收结果”。Claude Desktop 本身写一份手动验收清单。

**完成标准**：自动测试通过；手动清单在一台装了 Claude Desktop 的电脑上走通；**完成后暂停，请用户确认设置页**。

## 5. 发布 1.1（R1）

- 文档：README、DESIGN、发布说明。
- 全量测试和 `update-test` 通过，三平台安装包。
- **最终界面验收**。

## 阶段与顺序

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| U1 更新的真实测试 | `KM0_UPDATE_FEED`；打包后的更新 e2e；CI 任务 | Linux、Windows 的 `update-test` 通过 |
| C1 Runner：Claude Code 后端 | `agent` 字段、`ClaudeCodeClient`、报告字段、冒充的 `claude` | Runner 0.4.0 发布，三平台 CI 全绿 |
| C2 KM0：用 Claude Code 执行 | 配置生成、设置、预检、额度统计、执行面板 | e2e 通过；**暂停，确认界面** |
| D1 MCP 服务器 | `KM0 --mcp`、四个工具、设置页、回报后验收 | 自动测试通过，手动清单走通；**暂停，确认界面** |
| R1 发布 1.1 | 文档、安装包 | **最终界面验收** |

顺序：U1 和 C1 互不依赖，可以并行；C1 → C2 → D1 → R1。

## 需要用户确认

1. Runner 路线图里“不接 pi 以外的 Agent”的决定，改为接入 Claude Code（理由见第 2 节）。
2. Claude Code 的权限默认用 `acceptEdits` 加工具白名单，不放进容器。
3. 通过 MCP 做的任务，由 Agent 在用户仓库里建 `km0/…` 分支并提交；KM0 自己仍然只读，不改仓库。
