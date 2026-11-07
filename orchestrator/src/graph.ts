import { Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { activeTickets, gitConfigHash, installDeps, MAX_ACTIVE_TICKETS, MAX_REVISIONS, RECURSION_LIMIT, tokens } from "./guardrails.ts";
import { ceoApproval } from "./ceo-node.ts";
import { dev, DEV_RULES, devRules, partialWork, taskBlock } from "./dev-node.ts";
import { docsNode } from "./docs-node.ts";
import { sh } from "./graph-kit.ts";
import { planner, SPLIT_RULE, triage } from "./plan-nodes.ts";
import { loadConventions, loadRepoConfig } from "./repo-config.ts";
import { DIFF_LIMIT, evidenceNote, qa, reviewer } from "./review-nodes.ts";
import { deploy, deployTicket, mergeNode, publishNode } from "./ship-nodes.ts";
import { Brief, briefMarkdown, Ticket, type T } from "./ticket.ts";

export { Brief, briefMarkdown, Ticket, DEV_RULES, devRules, partialWork, taskBlock, SPLIT_RULE, DIFF_LIMIT, evidenceNote, deployTicket };

// Review loop: above the cap, or on any escalation/ambiguity, the ticket goes to the CEO.
const route = (ok: string, node: string) => (t: T) =>
  t.status === ok ? node : t.status === "dev_failed" && t.revisions < MAX_REVISIONS ? "dev" : "ceo_approval";
const afterTriage = (t: T) => (t.status === "dev" ? "dev" : t.status === "ambiguous" ? "planner" : "ceo_approval");

const afterCeo = (t: T) =>
  t.status === "retry" ? t.failed_node : t.status === "dev_failed" ? "dev" : t.status === "replan" ? "planner" : t.status === "approved" ? "merge_pr" : END;
const afterMerge = (t: T) => (t.status === "approved" ? "deploy" : "ceo_approval");

export function buildGraph(checkpointer = new MemorySaver()) {
  return new StateGraph(Ticket)
    .addNode("triage", triage)
    .addNode("planner", planner)
    .addNode("dev", dev)
    .addNode("reviewer", reviewer)
    .addNode("qa", qa)
    .addNode("publish", publishNode)
    .addNode("ceo_approval", ceoApproval)
    .addNode("merge_pr", mergeNode)
    .addNode("deploy", deploy)
    .addNode("docs_start", docsNode("start"))
    .addNode("docs_end", docsNode("end"))
    .addEdge(START, "docs_start")
    .addEdge("docs_start", "triage")
    .addConditionalEdges("triage", afterTriage, ["dev", "planner", "ceo_approval"])
    .addConditionalEdges("planner", route("dev", "dev"), ["dev", "ceo_approval"])
    .addConditionalEdges("dev", (t: T) => (t.status === "dev_next" ? "dev" : route("review", "reviewer")(t)), ["reviewer", "dev", "ceo_approval"])
    .addConditionalEdges("reviewer", route("qa", "qa"), ["qa", "dev", "ceo_approval"])
    .addConditionalEdges("qa", route("publish", "publish"), ["publish", "dev", "ceo_approval"])
    .addConditionalEdges("publish", route("approval", "docs_end"), ["docs_end", "dev", "ceo_approval"])
    .addEdge("docs_end", "ceo_approval")
    .addConditionalEdges("ceo_approval", afterCeo, ["triage", "planner", "dev", "reviewer", "qa", "publish", "deploy", "merge_pr", END])
    .addConditionalEdges("merge_pr", afterMerge, ["deploy", "ceo_approval"])
    .addEdge("deploy", END)
    .compile({ checkpointer });
}

export const config = (id: string) => ({ configurable: { thread_id: id }, recursionLimit: RECURSION_LIMIT });
export const resume = (answer: string) => new Command({ resume: answer });

export function createWorktree(repo: string, id: string, dir: string, home?: string) {
  if (activeTickets(repo) >= MAX_ACTIVE_TICKETS) throw new Error(`limit of ${MAX_ACTIVE_TICKETS} active tickets reached`);
  const base_branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
  sh(repo, "worktree", "add", "-q", "-b", `ticket/${id}`, dir);
  const base = sh(repo, "rev-parse", "HEAD");
  const { test, merge, publisher, push_remote, base_repo, disclosure, deploy, install } = loadRepoConfig(repo, base, home);
  if (install) installDeps(dir);
  return {
    worktree: dir,
    repo,
    git_config_hash: gitConfigHash(repo),
    base,
    test,
    install,
    merge,
    publisher: publisher ?? "",
    push_remote,
    base_repo,
    disclosure,
    base_branch,
    rules: loadConventions(repo, base),
    deploy_cfg: deploy,
    ...(deploy ? { deploy_target: "command" } : {}),
  };
}

export function report(t: T): string {
  const lines = t.history
    .filter((h) => h.usage)
    .map((h) => {
      const c = h.usage!;
      return (
        `${h.node.padEnd(10)} tokens=${tokens(c)} (ctx ${c.cache_create + c.cache_read + c.tokens_in}, output ${c.tokens_out}) ` +
        `turns=${c.turns} ${(c.ms / 1000).toFixed(1)}s US$${c.cost_usd.toFixed(3)}`
      );
    });
  const total = t.history.reduce((a, h) => ({ tok: a.tok + (h.usage ? tokens(h.usage) : 0), usd: a.usd + (h.usage?.cost_usd ?? 0), ms: a.ms + h.ms }), {
    tok: 0,
    usd: 0,
    ms: 0,
  });
  return [
    ...lines,
    ...t.docs_warnings.map((w) => `docs warning: ${w}`),
    `TOTAL ${t.id} status=${t.status} revisions=${t.revisions} tokens=${total.tok} ${(total.ms / 1000).toFixed(1)}s US$${total.usd.toFixed(3)}`,
  ].join("\n");
}
