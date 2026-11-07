import { interrupt } from "@langchain/langgraph";
import { MAX_REVISIONS, safeGit, verifyEvidence } from "./guardrails.ts";
import { log } from "./graph-kit.ts";
import type { T } from "./ticket.ts";

// The only merge/deploy and escalation point. Approval only counts if the evidence still holds.
export const ceoApproval = async (t: T): Promise<Partial<T>> => {
  const v = t.status === "approval" && t.evidence.length ? verifyEvidence(t.worktree, t.base, t.test, t.install) : null;
  const reason =
    t.status === "approval"
      ? v?.ok
        ? v.sha === t.approved_sha
          ? null
          : "commit changed since it was published"
        : `invalid evidence: ${v ? v.reason : "no evidence"}`
      : t.status === "dev_failed"
        ? `cap of ${MAX_REVISIONS} revisions reached: ${t.summary}`
        : `${t.status}: ${t.summary}`;
  const r = interrupt({
    type: reason ? "escalation" : "approval",
    reason,
    ticket: t.id,
    title: t.title,
    summary: t.summary,
    explanation: t.explanation,
    brief: t.brief,
    evidence: t.evidence,
    deploy: {
      target: t.deploy_target,
      environment: t.deploy_cfg?.environment ?? "simulated",
      ...(t.deploy_cfg ? { command: t.deploy_cfg.command, rollback: t.deploy_cfg.rollback, env: t.deploy_cfg.env, health_url: t.deploy_cfg.health_url } : {}),
    },
    active_flags: Object.entries(t.flags)
      .filter(([, active]) => active)
      .map(([k]) => k),
  }) as string;
  const h = (res: string) => log(t, "ceo_approval", res);
  if (!reason) {
    if (r === "approve") return { status: "approved", history: h("approved") };
    return { status: "dev_failed", revisions: t.revisions + 1, summary: `CEO rejected: ${r}`.slice(0, 500), history: h("rejected") };
  }
  if (r === "abort") return { status: "aborted", history: h("aborted") };
  // Missing information: the CEO's answer supplements the request and the planner tries again.
  if (t.status === "ambiguous") return { status: "replan", request: `${t.request}\n\nCEO clarification: ${r}`, history: h("clarified") };
  // A failed merge (CI red, PR moved): "retry" runs it again, anything else is an instruction for the dev.
  if (t.history.at(-1)?.node === "merge_pr" && r === "retry") return { status: "approved", history: h("merge retry") };
  // A node that stopped on an error or timeout: "retry" runs just that node again, not the dev.
  // Only for the commit that was reviewed: a new commit in the worktree must go back through the dev and both reviews.
  // The failure text stays out of the retried node's context (and out of the PR body).
  const sameCommit = () => !POST_DEV.includes(t.failed_node) || t.evidence.includes(`commit:${safeGit(t.worktree, "rev-parse", "--short", "HEAD")}`);
  if (r === "retry" && t.status === "escalated" && RETRYABLE.includes(t.failed_node) && sameCommit())
    return { status: "retry", summary: t.summary_before_failure, history: h("retry") };
  // Any other escalation: the CEO instructs the dev (only if criteria already exist).
  if (!t.criteria.length) return { status: "aborted", history: h("aborted") };
  return { status: "dev_failed", revisions: 0, summary: `CEO instructed: ${r}`.slice(0, 500), history: h("resumed") };
};

const RETRYABLE = ["triage", "planner", "dev", "reviewer", "qa", "publish", "deploy"];
const POST_DEV = ["reviewer", "qa", "publish", "deploy"];
