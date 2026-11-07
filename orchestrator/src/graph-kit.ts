import { assertGitConfigUnchanged, budgetExceeded, repoOf, safeGit } from "./guardrails.ts";
import { NodeFailure, type Usage } from "./run-agent.ts";
import { briefMarkdown, type T } from "./ticket.ts";

export const log = (t: T, node: string, result: string, usage?: Usage) => [
  ...t.history,
  { node, time: new Date().toISOString(), result, ms: usage?.ms ?? 0, usage },
];

export const sh = safeGit;

// Minimal context: only what the role needs, never the conversation history.
export const context = (...parts: string[]) =>
  [...parts, "Answer only in the structured format. `summary`: up to 10 lines, only what the next node needs."].join("\n\n");
export const ticketData = (t: T) =>
  `Ticket ${t.id}: ${t.title}\n${t.briefing ? `Briefing:\n${t.briefing}\n` : ""}` +
  `${t.stories.length ? `Stories:\n${t.stories.map((s) => `- ${s}`).join("\n")}\n` : ""}` +
  `Acceptance criteria:\n${t.criteria.map((c) => `- ${c}`).join("\n")}\nCurrent summary:\n${t.summary}` +
  (t.brief ? `\nDeveloper brief (check it matches the diff):\n${briefMarkdown(t.brief)}` : "");

export const escalate = (t: T, name: string, reason: string, usage?: Usage): Partial<T> => ({
  status: "escalated",
  failed_node: name,
  summary_before_failure: t.summary,
  summary: `${name}: ${reason}`.split("\n").slice(0, 10).join("\n"),
  history: log(t, name, `escalated: ${reason}`, usage),
});

// An executor failure (error, timeout, invalid output) or an exceeded budget does not break the graph:
// the ticket stops and goes to the CEO via ceo_approval.
export const guarded =
  (name: string, fn: (t: T) => Promise<Partial<T>>) =>
  async (t: T): Promise<Partial<T>> => {
    const overrun = budgetExceeded(
      t.history.filter((h) => h.node !== "docs").map((h) => h.usage),
      process.env,
      t.task_done,
    );
    if (overrun) return escalate(t, name, overrun);
    try {
      return await fn(t);
    } catch (e) {
      if (!(e instanceof NodeFailure)) throw e;
      return escalate(t, name, e.message, e.usage);
    }
  };

export const rulesBlock = (t: T) =>
  t.rules
    ? [
        `Target repo conventions (its CLAUDE.md; follow them, including the commit message format):
${t.rules}`,
      ]
    : [];

export const checkConfig = (t: T) => {
  try {
    assertGitConfigUnchanged(t.repo || repoOf(t.worktree), t.git_config_hash);
  } catch (e) {
    throw new NodeFailure((e as Error).message);
  }
};
