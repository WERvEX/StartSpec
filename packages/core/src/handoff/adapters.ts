import type { AgentConfig, AgentId, PresetAgentId } from "@km0/shared";
import type { Language } from "../discussion/prompts";

type Localized = Record<Language, string>;

export interface AgentAdapter {
  id: AgentId;
  name: string;
  /** The project instructions file the agent reads by itself, if it has one. */
  instructions: {
    /** File name inside the package's agents folder. */
    packagedAs: string;
    /** Where it belongs in the repository. */
    target: string;
    render(overview: string, language: Language): string;
  } | null;
  /** A shell command that starts the agent on a prompt; null when it is driven from its own UI. */
  command(prompt: string, model: string | null, taskFile: string): string | null;
  /** How to start it, including anything not yet verified. */
  howTo: Localized;
}

/** Double-quoted for POSIX shells and PowerShell alike; the prompts KM0 writes contain no quotes. */
const quote = (value: string) => `"${value.replaceAll('"', "'")}"`;
const plain = (overview: string) => overview;

export const ADAPTERS: Record<PresetAgentId, AgentAdapter> = {
  claude_code: {
    id: "claude_code",
    name: "Claude Code",
    instructions: { packagedAs: "CLAUDE.md", target: "CLAUDE.md", render: plain },
    command: (prompt, model) => `claude${model ? ` --model ${model}` : ""} -p ${quote(prompt)}`,
    howTo: {
      "zh-CN":
        "在代码库根目录运行表中的命令（`-p` 为非交互模式，去掉 `-p` 则进入交互会话）。代码库里已有 CLAUDE.md 时，把内容合并进去；Claude Code 只在没有 CLAUDE.md 时才读 AGENTS.md。",
      en: "Run the command at the repository root (`-p` runs non-interactively; drop it for an interactive session). Merge into an existing CLAUDE.md; Claude Code reads AGENTS.md only when there is no CLAUDE.md.",
    },
  },
  claude_desktop: {
    id: "claude_desktop",
    name: "Claude Desktop",
    instructions: null,
    command: () => null,
    howTo: {
      "zh-CN":
        "在“设置 → 执行”里把 KM0 的 MCP 服务器加到 Claude Desktop，然后在 Claude Desktop 里说“做 KM0 的任务”：它会领取任务、在任务的工作目录里修改并回报。也可以把任务文件的内容整段粘贴进对话。",
      en: "Add KM0's MCP server to Claude Desktop under Settings → Execution, then ask Claude Desktop to \"do the KM0 tasks\": it takes a task, edits the task's working folder and reports back. Or paste the task file into a chat.",
    },
  },
  codex: {
    id: "codex",
    name: "Codex",
    instructions: { packagedAs: "AGENTS.md", target: "AGENTS.md", render: plain },
    // workspace-write lets the run edit files in the repository and nothing outside it.
    command: (prompt, model) => `codex exec${model ? ` -m ${model}` : ""} -s workspace-write ${quote(prompt)}`,
    howTo: {
      "zh-CN":
        "在代码库根目录运行表中的命令（`codex exec` 为非交互模式，`-s workspace-write` 只允许改动当前代码库）。去掉 `exec` 则进入交互会话。",
      en: "Run the command at the repository root (`codex exec` runs non-interactively; `-s workspace-write` limits edits to this repository). Drop `exec` for an interactive session.",
    },
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    instructions: {
      packagedAs: "km0.mdc",
      target: ".cursor/rules/km0.mdc",
      render: (overview, language) =>
        [
          "---",
          `description: ${language === "en" ? "Project overview and how to work on KM0 tasks" : "项目概览，以及如何完成 KM0 任务"}`,
          "alwaysApply: true",
          "---",
          "",
          overview,
        ].join("\n"),
    },
    command: (prompt, model) => `agent -p ${quote(prompt)}${model ? ` --model ${model}` : ""}`,
    howTo: {
      "zh-CN":
        "用 Cursor CLI（`agent`，旧名 `cursor-agent`）运行表中的命令，或在编辑器的 Agent 对话中粘贴任务文件。无人值守运行时可以加 `--trust` 跳过工作区信任确认；`agent models` 可以查看可用的模型 ID。",
      en: "Run the command with the Cursor CLI (`agent`, formerly `cursor-agent`), or paste the task file into an agent chat in the editor. Add `--trust` to skip the workspace-trust prompt in unattended runs; `agent models` lists model IDs.",
    },
  },
  pi: {
    id: "pi",
    name: "Pi",
    instructions: { packagedAs: "AGENTS.md", target: "AGENTS.md", render: plain },
    command: (prompt, model) => `pi -p ${quote(prompt)}${model ? ` --model ${model}` : ""}`,
    howTo: {
      "zh-CN":
        "安装 `@earendil-works/pi-coding-agent` 后运行表中的命令（`-p` 为非交互模式）。Pi 的模型写作 `provider/模型 ID`，例如 `anthropic/claude-sonnet-5-5`；`pi --list-models` 可以查看。",
      en: "Install `@earendil-works/pi-coding-agent`, then run the command (`-p` runs non-interactively). Pi names models as `provider/model-id`, e.g. `anthropic/claude-sonnet-5-5`; `pi --list-models` lists them.",
    },
  },
  dsh: {
    id: "dsh",
    name: "DSH",
    instructions: { packagedAs: "AGENTS.md", target: "AGENTS.md", render: plain },
    // DeepSeek Harness has no model flag; the model comes from its settings.
    command: (prompt) => `npx @deepseek-ai/dsh headless ${quote(prompt)}`,
    howTo: {
      "zh-CN":
        "DSH（DeepSeek Harness，目前是 0.x 候选版）需要 `DEEPSEEK_API_KEY`。运行表中的命令无人值守执行，或者运行 `npx @deepseek-ai/dsh web` 打开网页界面（http://127.0.0.1:3080）粘贴任务文件。DSH 没有命令行模型参数，请在它的设置里选择表中建议的模型。",
      en: "DSH (DeepSeek Harness, currently a 0.x release candidate) needs `DEEPSEEK_API_KEY`. Run the command for an unattended run, or run `npx @deepseek-ai/dsh web` and paste the task file into the web UI (http://127.0.0.1:3080). DSH has no model flag; pick the suggested model in its settings.",
    },
  },
  zcode: {
    id: "zcode",
    name: "ZCode",
    instructions: { packagedAs: "AGENTS.md", target: "AGENTS.md", render: plain },
    // Without --mode the CLI runs in yolo mode and executes tools without asking.
    command: (prompt) => `zcode --prompt ${quote(prompt)} --mode build`,
    howTo: {
      "zh-CN":
        "在 ZCode 桌面端粘贴任务文件，或者用它的命令行运行表中的命令。命令里写明了 `--mode build`：不指定时默认是 yolo 模式，工具调用不经确认就会执行。模型在 ZCode 的设置里选择（GLM 系列）。",
      en: "Paste the task file into the ZCode desktop app, or run the command with its CLI. The command sets `--mode build` on purpose: without it the CLI runs in yolo mode and executes tools without asking. Pick the model (GLM series) in ZCode's settings.",
    },
  },
  generic: {
    id: "generic",
    name: "Generic",
    instructions: null,
    command: () => null,
    howTo: {
      "zh-CN": "把任务文件的内容整段粘贴给任意编码 Agent；它是自包含的。",
      en: "Paste the task file into any coding agent; it is self-contained.",
    },
  },
};

/**
 * An agent the user defined: its instructions file is the project overview under the name it reads,
 * and its command is the user's template with {prompt}, {task_file} and {model} filled in.
 */
export function customAdapter(
  agent: Pick<AgentConfig, "id" | "name" | "instructionFile" | "launchTemplate">,
): AgentAdapter {
  const file = agent.instructionFile;
  return {
    id: agent.id,
    name: agent.name,
    instructions: file ? { packagedAs: file.split(/[\\/]/).pop() || file, target: file, render: plain } : null,
    command: agent.launchTemplate
      ? (prompt, model, taskFile) =>
          (agent.launchTemplate as string)
            .replaceAll("{prompt}", quote(prompt))
            .replaceAll("{task_file}", taskFile)
            .replaceAll("{model}", model ?? "")
            .replace(/\s{2,}/g, " ")
            .trim()
      : () => null,
    howTo: agent.launchTemplate
      ? {
          "zh-CN": "这是你在“设置 → Agent”里添加的 Agent：在代码库根目录运行表中的命令，命令按你填写的启动方式生成。",
          en: "An agent you added under Settings → Agents: run the command at the repository root; it follows the launch command you set.",
        }
      : {
          "zh-CN": "这是你在“设置 → Agent”里添加的 Agent：把任务文件的内容粘贴给它；任务文件是自包含的。",
          en: "An agent you added under Settings → Agents: paste the task file into it; the file is self-contained.",
        },
  };
}

/** The adapter for an agent: a preset's own, a custom agent's from its definition, or the generic one. */
export function adapterFor(id: AgentId, custom: AgentConfig[] = []): AgentAdapter {
  if (id in ADAPTERS) return ADAPTERS[id as PresetAgentId];
  const definition = custom.find((agent) => agent.id === id);
  return definition ? customAdapter(definition) : ADAPTERS.generic;
}
