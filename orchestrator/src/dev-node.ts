import { z } from "zod";
import { MAX_FILE_LINES, MAX_LINE_COLS, verifyEvidence } from "./guardrails.ts";
import { context, guarded, log, rulesBlock, sh, ticketData } from "./graph-kit.ts";
import { runAgent } from "./run-agent.ts";
import { Brief, cap, DEV_FILE, summary, type T } from "./ticket.ts";

const DevOutput = z.object({ summary, brief: Brief });

export const devRules = (test = "npm test", turns?: number) =>
  `Implement in the current worktree, run ${test} and commit (git add/git commit). Do not push. ` +
  `Also fill \`brief\`: why (the problem or goal this solves), how (approach and key decisions), ` +
  `where it applies (modules, endpoints, screens or users affected, and what is deliberately not touched). ` +
  `Modularity is mandatory: every source file you touch must stay within ${MAX_FILE_LINES} lines and ${MAX_LINE_COLS} columns per line; ` +
  `split by responsibility instead of growing a file. The orchestrator rejects the commit otherwise. ` +
  (turns
    ? `You have at most ${turns} turns and uncommitted work is lost value: ` +
      `get a first version passing ${test} and commit it early, then refine and commit again. `
    : "") +
  `Shell: one simple command per call (git add, git commit, git status, git diff, git log, ${test}); ` +
  `no ';', '&&' or pipes, they are denied, so on a denial retry with a single command.`;
export const DEV_RULES = devRules();

// A dev that stopped (turn limit, timeout) leaves uncommitted work in the worktree: tell the next attempt to build on it instead of starting over.
export const partialWork = (porcelain: string) =>
  porcelain.trim()
    ? [
        `The worktree already has uncommitted work from a previous attempt. Continue from it: do not restart, rename or duplicate it. ` +
          `Review it, make it pass and commit.\n${porcelain.split("\n").slice(0, 40).join("\n")}`,
      ]
    : [];

// With several atomic tasks the dev gets one at a time, fresh context each, and must not start the later ones.
export const taskBlock = (t: Pick<T, "tasks" | "task_done">) => {
  if (!t.tasks.length) return [];
  const last = t.task_done === t.tasks.length - 1;
  return [
    [
      `Task ${t.task_done + 1} of ${t.tasks.length}. Do ONLY this task, in one commit that keeps the verification green: ${t.tasks[t.task_done]}`,
      t.task_done
        ? `Already committed by earlier tasks (build on them, do not redo them):\n${t.tasks
            .slice(0, t.task_done)
            .map((x, i) => `${i + 1}. ${x}`)
            .join("\n")}`
        : "",
      last
        ? "This is the last task: `brief` must describe the whole ticket (all tasks), not just this one."
        : `Later tasks, do not start them:\n${t.tasks
            .slice(t.task_done + 1)
            .map((x, i) => `${t.task_done + i + 2}. ${x}`)
            .join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n"),
  ];
};

export const dev = guarded("dev", async (t) => {
  const before = sh(t.worktree, "rev-parse", "HEAD");
  const { output, usage } = await runAgent({
    role: "dev",
    files: [DEV_FILE[t.specialty]],
    cwd: t.worktree,
    schema: DevOutput,
    context: context(
      ticketData(t),
      devRules(t.test, Number(process.env.TURNS_DEV ?? process.env.TURNS_DEFAULT) || undefined),
      ...taskBlock(t),
      ...partialWork(sh(t.worktree, "status", "--porcelain", "--untracked-files=all")),
      ...rulesBlock(t),
    ),
    test: t.test,
  });
  const v = verifyEvidence(t.worktree, t.base, t.test, t.install);
  if (!v.ok)
    return {
      status: "dev_failed",
      explanation: "",
      revisions: t.revisions + 1,
      summary: `verification: ${v.reason}`,
      history: log(t, "dev", `verification failed`, usage),
    };
  if (t.tasks.length && v.sha === before)
    return {
      status: "dev_failed",
      explanation: "",
      revisions: t.revisions + 1,
      summary: `task ${t.task_done + 1} produced no new commit`,
      history: log(t, "dev", "task without commit", usage),
    };
  if (t.task_done + 1 < t.tasks.length)
    return {
      status: "dev_next",
      task_done: t.task_done + 1,
      summary: cap(output.summary),
      history: log(t, "dev", `task ${t.task_done + 1}/${t.tasks.length} committed`, usage),
    };
  return {
    status: "review",
    explanation: "",
    brief: output.brief,
    summary: cap(output.summary),
    author_id: v.author,
    evidence: v.evidence,
    history: log(t, "dev", "commit verified", usage),
  };
});
