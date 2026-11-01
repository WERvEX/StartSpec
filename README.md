# KM0

KM0 是编码 Agent 的上游：你用一句话描述要做的事，KM0 判断它的复杂度，通过提问和你把需求与实现方案谈清楚，输出《产品需求文档》和《技术实现方案》，再把实现拆成任务，按公开榜单估计的能力为每个任务选择合适的 Agent 和模型（Claude Code、Codex、Cursor、Pi、DSH、ZCode、你自己添加的 Agent，或通用格式），生成可以直接交接的任务包，也可以一键交给 KM0 Runner 执行。简单的任务交给便宜的模型，复杂的任务才用强模型。

名字取自“零公里”：所有道路的里程都从这里起算。

> 当前版本 1.0（[发布说明](docs/releases/v1.0.0.md)）。设置环境变量 `KM0_FAKE_LLM=1` 可以用模拟模型体验流程，不需要 API Key。设计见 [docs/DESIGN.md](docs/DESIGN.md)，1.0 的规划见 [docs/ROADMAP-1.0.md](docs/ROADMAP-1.0.md)，下一版（1.1）的规划见 [docs/ROADMAP-1.1.md](docs/ROADMAP-1.1.md)。

## 下载

从 [GitHub Releases](https://github.com/WERvEX/KM0/releases/latest) 下载最新版本：

| 平台 | 文件 |
| --- | --- |
| Windows (x64) | `KM0-1.0.0-setup-x64.exe` |
| macOS (Apple 芯片) | `KM0-1.0.0-arm64.dmg` |
| macOS (Intel) | `KM0-1.0.0-x64.dmg` |
| Linux (x64) | `KM0-1.0.0-x86_64.AppImage`（先 `chmod +x`） |

1.0.0 的安装包没有签名：Windows 首次运行会出现 SmartScreen 提示，点“更多信息 → 仍要运行”；macOS 会提示“无法验证开发者”，在“系统设置 → 隐私与安全性”里点“仍要打开”。装好后在“设置 → 关于”里检查和安装新版本（未签名的 macOS 版本和非 AppImage 的 Linux 安装需要重新下载）。

## 截图

截图用模拟模型（`KM0_FAKE_LLM=1`）生成，问题和文档内容是固定的示例。

**讨论**：按阶段提问，每题都有推荐答案，回答写进右侧的决策账本。

![讨论](docs/screenshots/discussion.png)

**文档**：生成《产品需求文档》和《技术实现方案》，可以按小节编辑、AI 修订和恢复版本。

![产品需求文档](docs/screenshots/prd.png)

**任务路由**：选一个分发策略，每个任务显示选中的 Agent 和模型、预计首次通过率和期望成本。

![任务路由](docs/screenshots/routing.png)

**执行**：交给 KM0 Runner 执行，实时看每个任务的进度和花费，结束后自动导入并验收。

![执行](docs/screenshots/execution.png)

**模型设置**：服务商、计费方式和模型，模型自动匹配榜单数据，显示价格和典型通过率。

![模型设置](docs/screenshots/models.png)

## 形态

- 桌面应用（Windows / macOS / Linux），数据全部保存在本地。
- 支持 OpenAI 兼容接口（OpenAI、DeepSeek、Qwen、GLM、MiMo 等）和 Anthropic 接口。
- API Key 由操作系统凭据存储加密。KM0 自己不改你的仓库；执行时由 KM0 Runner 在独立的 git worktree 和分支里改动，不碰你的工作区。

## 能做什么

1. **分诊**：判断任务类型和复杂度，选择快速、轻量或完整通道，可以手动改。
2. **讨论**：完整通道分四个阶段（定位与规模、产品需求、技术选型、实现方案）提问，每轮最多 3 题，全程只点“推荐”也能走完。每个回答写进决策账本，回改一条决策只复核受影响的部分。
3. **查证**：技术选型阶段出题前，用配置好的搜索服务（博查搜索 API，或任意提供搜索工具的 MCP 服务器）查证最多 3 次，问题卡上列出来源；没有配置时标注“未查证”。
4. **关联本地仓库**：新建任务时可以选一个本地文件夹，KM0 只读扫描依赖清单、语言和 CI 配置，识别出的前端、后端、存储、部署方式直接写进技术选型阶段，不再重复提问。
5. **文档**：生成 PRD 和技术方案（轻量通道是一份精简版），支持按小节编辑、AI 修订、版本恢复，决策变了会标出过期的小节。
6. **任务路由**：拆成任务，按特征给每个任务定难度，再在所有“Agent × 模型”组合里按策略档位（激进、偏省、平衡、偏稳、保守）选：达到目标首次通过率的组合里期望成本最低的。通过率来自公开榜单（SWE-bench、Terminal-Bench 等）估计的能力，并用你本机记录的运行结果修正。每个任务显示预计通过率、期望成本和理由，可以设项目预算，每一项都能手动调整。
7. **交接**：为 Claude Code、Codex、Cursor、Pi、DSH、ZCode 和通用格式生成交接包（zip），解压到代码库根目录后都在 `km0/` 文件夹里。
8. **执行与验收**：在路由表下方一键交给 [KM0 Runner](https://github.com/WERvEX/KM0-runner)（0.3.0 或更新）执行：KM0 先逐项检查，再根据路由结果和你的模型生成 Runner 配置（密钥只通过环境变量传给它），实时显示每个任务的进度，可以随时停止。结束后 KM0 自动导入结果，用规划模型对照每个任务的 EARS 验收标准判定，可以手动改判；未通过的任务换到更强的组合重做。也可以导入自己运行的结果，或改用自定义命令执行（未验证）。

## 快速上手

1. 设置 → 模型：添加一个模型并测试连接。第一个模型自动作为路由模型；可以再加一个能力更强的作为规划模型。
2. 设置 → Agent：启用你用的 Agent，勾选每个 Agent 能用的模型。模型会自动匹配榜单数据，拿到官方价格和能力估计；服务商的计费方式（按 token、中转倍率、订阅、免费）在“设置 → 模型”里选。
3. 设置 → 执行（可选）：安装 KM0 Runner 和 pi 后，KM0 会自动找到它们；也可以填写启动方式或改用自定义命令。
4. 设置 → 搜索服务（可选）：
   - 博查：填 API Key 即可。
   - 远程 MCP 服务器：填地址、搜索工具名和查询参数名，需要鉴权时在“请求头”里每行写一个 `Name=value`。
   - 本地 MCP 服务器（仅桌面版）：填启动命令和参数，例如 `npx` 和 `-y <包名>`，密钥写在“环境变量”里。
5. 设置 → 通用 → 导入与导出配置：把以上配置导出成 JSON，在另一台电脑上导入。默认不含密钥，勾选后密钥以明文写入文件。

## 网页调试版

不想安装也可以直接在浏览器里试用：<https://wervex.github.io/KM0/>（加 `?simulated=1` 使用模拟模型，不需要 API Key）。

网页版和桌面版运行同一套代码，数据保存在当前浏览器的 IndexedDB 里，API Key 没有加密，只适合测试。网页版不能启动本地进程，所以不支持本地 MCP 服务器；关联本地仓库需要 Chrome 或 Edge（用浏览器的文件夹选择框，刷新页面后要重新选择）。每次推送到 `master` 或 `claude/*` 分支，CI 都会重新部署。首次使用需要在仓库 Settings → Pages 里把 Source 设为 “Deploy from a branch”，分支选 `gh-pages`、目录选 `/ (root)`。

## 开发

需要 Node.js 22.12+ 和 pnpm 10。

```bash
pnpm install
pnpm dev          # 启动开发版应用
pnpm web:dev      # 在浏览器里启动网页调试版（打开 /web.html）
pnpm web:build    # 构建网页调试版到 apps/desktop/out/web
pnpm test         # 单元与组件测试
pnpm typecheck    # 类型检查
pnpm lint         # Biome 检查
pnpm build        # 构建到 apps/desktop/out
pnpm e2e          # Playwright 端到端测试，包括桌面版和网页版（需先 pnpm build；Linux 无显示环境时用 xvfb-run -a pnpm e2e）
pnpm e2e:update:build && pnpm e2e:update   # 用打包后的程序真实测试一次应用内更新（Linux、Windows）
pnpm package      # 生成当前平台的安装包到 apps/desktop/release
pnpm registry:fetch && pnpm registry:build   # 重新抓取榜单并生成模型注册表
pnpm eval:record && pnpm eval:replay          # 离线评测：录制模型回答、回放评分（见 packages/eval/README.md）
```

GitHub Actions 会在每次推送时运行检查，分别在 Windows、macOS、Linux 上构建安装包（作为构建产物上传），并部署网页调试版。推送 `v*` 标签（例如 `v1.0.0`），或在 Actions 页面手动运行 CI 并填写版本号时，还会把安装包和应用内更新要读的 `latest*.yml` 发布成 GitHub Release，说明文字取自 `docs/releases/<标签>.md`。

签名：在仓库 Settings → Secrets → Actions 里配置以下密钥后，CI 会签名（和公证）安装包；没有配置时照常发布未签名版，发布说明末尾写明哪些平台未签名。

| 平台 | 密钥 |
| --- | --- |
| Windows | `WIN_CSC_LINK`（base64 编码的 .pfx）、`WIN_CSC_KEY_PASSWORD` |
| macOS | `MAC_CSC_LINK`（base64 编码的 Developer ID .p12）、`MAC_CSC_KEY_PASSWORD`；公证需要 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` |

未签名的 macOS 版本不能在应用内更新。

## 目录结构

```
packages/core     领域逻辑与模型网关（纯 TypeScript，不依赖 Electron）
packages/shared   zod schema、IPC 契约、共享类型
packages/registry 模型注册表：从公开榜单拟合每个模型的能力先验（见 packages/registry/README.md）
packages/eval     离线评测集：拆解是否保留验收条件、验收评审是否与隐藏测试一致（见 packages/eval/README.md）
apps/desktop      Electron 应用：主进程、预加载脚本、React 界面，以及网页调试版入口
e2e/              Playwright 端到端测试
e2e-packaged/     打包后的程序的测试（应用内更新）
docs/DESIGN.md    设计文档
```

## 本地数据

数据保存在应用数据目录下的 `KM0` 文件夹：Windows 为 `%APPDATA%\KM0`，macOS 为 `~/Library/Application Support/KM0`，Linux 为 `~/.config/KM0`。其中 `km0.db` 是 SQLite 数据库；升级数据库结构前会在同一文件夹留一份备份（`km0.db.before-<n>-<时间>.bak`，保留最近 3 份）。KM0 启动的执行默认放在其中的 `runs/` 文件夹。

## 许可证

[Apache License 2.0](LICENSE)
