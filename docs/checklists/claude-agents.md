# 手动验收：Claude Code 和 Claude Desktop 配合完成一个项目

自动测试用冒充的 `claude` 和脚本化的 MCP 客户端；这份清单在一台真实的电脑上，用真实的 Claude Code 和 Claude Desktop 走一遍同样的流程。每一步后面写了应该看到什么。

## 准备

- [ ] 安装 Claude Code（`npm install -g @anthropic-ai/claude-code`），登录，或者准备一个 Anthropic API Key。终端里 `claude --version` 能输出版本号。
- [ ] 安装 Claude Desktop 并登录。
- [ ] 准备一个小的 git 仓库：至少有一次提交，最好带一个能跑的测试命令（比如 `npm test`）。

## KM0 的设置

1. [ ] “设置 → 执行”选“直接交给 Agent”，保存。Claude Code 一行显示绿色对勾和版本号。
2. [ ] 同一页“Claude Desktop”下，点“复制”配置片段；在 Claude Desktop 的“设置 → 开发者 → 编辑配置”里合并进 `claude_desktop_config.json`，重启 Claude Desktop。Claude Desktop 的工具列表里能看到 km0 的 7 个工具（`km0_next_task` 等）。
3. [ ] “设置 → Agent”里勾选 Claude Desktop 并保存。
4. [ ] 用 API Key 测试时：“设置 → 模型”里给 Claude Code 服务商填 Key。用订阅登录测试时不填。

## 规划和执行

5. [ ] 新建一个完整通道的任务，关联第 0 步准备的仓库，讨论完拆解任务，至少 3 个任务，后面的依赖前面的。
6. [ ] 在路由表里展开中间那个任务，“组合”选 Claude Desktop 的一项。表里这个任务的 Agent 变成 Claude Desktop。
7. [ ] 点“执行”。预检里：
   - Claude Code 显示版本号，以及“密钥通过环境变量”或“使用 Claude Code 自己的登录”；
   - 有一条“1 个任务会等待 Claude Desktop 领取”。
8. [ ] 开始执行。第一个任务由 Claude Code 执行，“最近的输出”里能看到它调用的工具（`→ Edit …`）。结束后状态是“通过”（有测试命令）或“待验收”。
9. [ ] 交给 Claude Desktop 的任务显示“等待领取”和提示。在 Claude Desktop 里新开对话，说“做 KM0 的任务”：
   - 它调用 `km0_next_task`，KM0 里这个任务变成“执行中”；
   - 它用 `km0_read_file`、`km0_write_file` 修改，用 `km0_run_tests` 跑测试，最后 `km0_report`；
   - 让它读 `../` 或 `.git/config`，工具应当拒绝。
10. [ ] 回报后 KM0 继续执行后面的任务；全部结束后显示“已结束”，结果自动导入，在“执行结果验收”里逐个判定。
11. [ ] 在仓库里检查：
    - `git branch --list 'km0/*'` 列出每个任务的分支；
    - 后面任务的分支包含前面任务的改动；
    - 当前分支和工作区没有变化（`git status` 干净）。

## 停止和异常

12. [ ] 再执行一次，在等待 Claude Desktop 领取时点“停止”。这个任务和后面的任务标为“已取消”；在 Claude Desktop 里再调用 `km0_next_task`，回答没有等待领取的任务。
13. [ ] 再执行一次，Claude Code 执行中点“停止”。`claude` 进程结束（任务管理器或 `ps` 里看不到它），任务标为“已取消”。
14. [ ] 执行中关闭 KM0 窗口，KM0 先用自己的对话框询问；选“停止并退出”后，没有残留的 `claude` 进程。
15. [ ] （Windows）在 Windows 上把第 7–13 步走一遍。

## 记录

把每一步的结果、用的 Claude Code 版本、Claude Desktop 版本、操作系统和发现的问题，记在这份清单所在 PR 的评论里，或者新开一个 issue。
