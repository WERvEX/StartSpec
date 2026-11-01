import { execFile } from "node:child_process";

/** Commits KM0 makes on a task's branch carry this author, as KM0 Runner's carry its own. */
export const AUTHOR = ["-c", "user.name=KM0", "-c", "user.email=km0@localhost"];
/** Never committed: the hand-off package KM0 copies into the worktree, and bytecode left by test runs. */
export const EXCLUDES = [":!km0", ":!**/__pycache__/**", ":!*.pyc"];

export class GitError extends Error {}

/** Run git in `cwd`; its stdout, trimmed. Throws GitError when it fails, unless `check` is false. */
export function git(cwd: string, args: string[], check = true): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && check) {
          const detail = (stderr || stdout || error.message).trim().slice(-1000);
          reject(new GitError(`git ${args.join(" ")} failed in ${cwd}: ${detail}`));
        } else resolve(stdout.trim());
      },
    );
  });
}

/** The raw diff between two commits, untrimmed, for the patch file. */
export function gitDiff(cwd: string, from: string, to: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["diff", from, to],
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (_error, stdout) => resolve(stdout),
    );
  });
}
