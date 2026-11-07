import { z } from "zod";
import { selfApproval, verifyEvidence } from "./guardrails.ts";
import { context, guarded, log, rulesBlock, sh, ticketData } from "./graph-kit.ts";
import { NodeFailure, runAgent } from "./run-agent.ts";
import { cap, summary, type T } from "./ticket.ts";

const ReviewOutput = z.object({ verdict: z.enum(["approved", "rejected"]), comments: z.string(), summary, explanation: z.string().default("") });

export const evidenceNote = (evidence: string[]) =>
  `Evidence checked by the orchestrator in code (not by you): ${evidence.join(", ")}. ` +
  `Do not reject only because you cannot run the tests yourself; judge the diff and the code against the criteria.`;
// The reviewer must see every changed line: a diff over the limit goes to the CEO instead of being cut (multi-task tickets reach this).
export const DIFF_LIMIT = 60_000;
const diff = (t: T) => {
  const d = sh(t.worktree, "diff", "--no-ext-diff", "--no-textconv", t.base, "HEAD");
  if (d.length > DIFF_LIMIT)
    throw new NodeFailure(`diff too large to review in full (${d.length} > ${DIFF_LIMIT} characters): split the work into smaller tickets`);
  return d;
};

function reviewStep(name: "reviewer" | "qa", files: (t: T) => string[], next: string) {
  return guarded(name, async (t) => {
    // Flow rules in code: independence and verified evidence before spending tokens.
    const who = `agent-${name}`;
    const block = selfApproval(t.author_id, who);
    if (block) throw new NodeFailure(block);
    const v = t.evidence.length ? verifyEvidence(t.worktree, t.base, t.test, t.install) : { ok: false as const, reason: "no evidence" };
    if (!v.ok) throw new NodeFailure(`invalid evidence: ${v.reason}`);
    const { output, usage } = await runAgent({
      role: name,
      files: files(t),
      cwd: t.worktree,
      schema: ReviewOutput,
      context: context(
        ticketData(t),
        evidenceNote(v.evidence),
        "`explanation`: what changed and why, in plain language a non-programmer follows, up to 6 lines.",
        ...(name === "reviewer" ? rulesBlock(t) : []),
        `Diff:\n${diff(t)}`,
      ),
    });
    const id = name === "reviewer" ? { reviewer_id: `agent-${name}` } : { qa_id: `agent-${name}` };
    if (output.verdict === "approved")
      return {
        ...id,
        status: next,
        summary: cap(output.summary),
        explanation: [t.explanation, output.explanation.trim().split("\n").slice(0, 6).join("\n")].filter(Boolean).join("\n"),
        history: log(t, name, "approved", usage),
      };
    return {
      status: "dev_failed",
      revisions: t.revisions + 1,
      summary: output.comments.split("\n").slice(0, 10).join("\n"),
      history: log(t, name, "rejected", usage),
    };
  });
}
export const reviewer = reviewStep(
  "reviewer",
  (t) => [
    "code-reviewer",
    ...(t.flags.touches_security ? ["security"] : []),
    ...(t.flags.touches_performance ? ["performance"] : []),
    ...(t.flags.touches_ai ? ["evals-engineer"] : []),
  ],
  "qa",
);
export const qa = reviewStep("qa", () => ["qa-automation"], "publish");
