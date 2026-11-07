// Flow guardrails against fake nodes: no model, no credentials.
import { workRoot } from "../src/daily-cap.ts";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createFixture, git } from "../scripts/fixture.ts";
import { FileSaver } from "../src/file-saver.ts";
import { readDeploy } from "../src/deploy.ts";
import { gitConfigHash } from "../src/guardrails.ts";
import { config, createWorktree, buildGraph, report, resume, DEV_RULES, deployTicket, Ticket } from "../src/graph.ts";
import { ciVerdict, registerPublisher } from "../src/publish.ts";
import { NodeFailure, registerExecutor, type Req } from "../src/run-agent.ts";
import { alerts, watchdog } from "../src/watchdog.ts";

type Behavior = Partial<Record<string, (req: Req<unknown>) => unknown>>;
let override: Behavior = {};
let calls: string[] = [];
let docsCalls: string[] = [];
let docsContexts: string[] = [];
let afterFixture: ((repo: string) => void) | null = null;
let tokensPerCall = 10;
const roots: string[] = [];

const BRIEF = { why: "the goal of the ticket", how: "small focused change", where: "only the touched module" };
const FLAGS = { touches_security: false, touches_performance: false, touches_ai: false, touches_schema: false, touches_public_api: false, touches_permissions: false, touches_external_integration: false, touches_cost: false };
const commit = (cwd: string, author: string, file = "checkout.html", content = "<button>Submit order</button>\n") => {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "-c", `user.name=${author}`, "commit", "-q", "--allow-empty", "-m", "dev");
};
const defaults: Behavior = {
  triage: () => ({ title: "t", priority: "P2", specialty: "frontend", clear: true, flags: FLAGS, criteria: ["button says Submit order"], summary: "ok" }),
  planner: () => ({ ...(defaults.triage!({} as Req<unknown>) as object), question: "" }),
  dev: (req) => (commit(req.cwd, "agent-dev"), { summary: "ok", brief: BRIEF }),
  reviewer: () => ({ verdict: "approved", comments: "", summary: "ok" }),
  qa: () => ({ verdict: "approved", comments: "", summary: "ok" }),
  watchdog: () => ({ alerts: ["T-1 stalled"], summary: "ok" }),
  docs: () => ({ files: [], not_applicable: [], notes: "" }),
};
let publications: string[] = [];
let merges: string[] = [];
let mergeError: string | null = null;
registerPublisher("fake", {
  publish: (p) => (publications.push(`${p.id}@${p.sha}`), "pr:https://example/pull/1"),
  merge: async (m) => {
    if (mergeError) throw new Error(mergeError);
    merges.push(`${m.pr}@${m.sha}`);
    return `merged:${m.pr}`;
  },
});

registerExecutor("fake", {
  async run<T>(req: Req<T>) {
    if (req.role === "docs") (docsCalls.push(req.role), docsContexts.push(req.context));
    else calls.push(req.role);
    const raw = (override[req.role] ?? defaults[req.role]!)(req as Req<unknown>);
    const output = req.schema.safeParse(raw);
    if (!output.success) throw new NodeFailure(`${req.role}: invalid output`);
    return { output: output.data, usage: { tokens_in: tokensPerCall, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 } };
  },
});

beforeEach(() => {
  process.env.EXECUTOR = "fake";
  const orchRoot = mkdtempSync(join(tmpdir(), "oh-"));
  roots.push(orchRoot);
  process.env.ORCH_HOME = orchRoot;
  process.env.PUBLISHER = "fake";
  publications = [];
  merges = [];
  mergeError = null;
  process.env.TOKEN_BUDGET_TICKET = "100000";
  override = {};
  calls = [];
  docsCalls = [];
  docsContexts = [];
  afterFixture = null;
  tokensPerCall = 10;
});
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

async function start(id = "T-1", saver: MemorySaver = new MemorySaver(), extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "gt-"));
  roots.push(root);
  const repo = createFixture(root);
  afterFixture?.(repo);
  if ("deploy_cfg" in extra) writeFileSync(join(process.env.ORCH_HOME!, "config.json"), JSON.stringify({ repos: { [resolve(repo)]: { deploy: extra.deploy_cfg } } }));
  const graph = buildGraph(saver);
  const cfg = config(id);
  const r = await graph.invoke({ id, request: "p", ...createWorktree(repo, id, join(root, "wt")), ...extra }, cfg);
  return { graph, cfg, r, repo, root };
}
const paused = (r: unknown) => (r as { __interrupt__?: { value: Record<string, unknown> }[] }).__interrupt__?.[0]?.value;
const answer = (g: Awaited<ReturnType<typeof start>>, reply: string) => g.graph.invoke(resume(reply) as never, g.cfg);

test("deploy only happens after CEO approval; rejection goes back to the dev", async () => {
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.notEqual(g.r.status, "simulated_deploy");
  const rej = await answer(g, "did not like it");
  assert.equal(paused(rej)?.type, "approval");
  assert.equal(rej.revisions, 1);
  assert.notEqual(rej.status, "simulated_deploy");
  assert.equal((await answer(g, "approve")).status, "simulated_deploy");
});

test("a pending approval survives the process and can be answered by a new graph", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "gt-")), "state.json");
  roots.push(join(file, ".."));
  const g = await start("T-1", new FileSaver(file));
  assert.equal(paused(g.r)?.type, "approval");
  const later = buildGraph(new FileSaver(file));
  assert.equal(((await later.getState(g.cfg)).tasks[0]?.interrupts[0]?.value as { type: string }).type, "approval");
  assert.equal((await later.invoke(resume("approve") as never, g.cfg)).status, "simulated_deploy");
});

test("a summary over 10 lines is truncated, not a node failure", async () => {
  const long = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
  override.qa = () => ({ verdict: "approved", comments: "", summary: long });
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(String(paused(g.r)?.summary).split("\n").length, 10);
});

test("an approval flag reaches the CEO as an active flag", async () => {
  override.triage = () => ({ ...(defaults.triage!({} as Req<unknown>) as object), flags: { ...FLAGS, touches_schema: true } });
  const g = await start();
  assert.deepEqual(paused(g.r)?.active_flags, ["touches_schema"]);
});

test("self-approval blocked: reviewer equal to the author does not even run", async () => {
  override.dev = (req) => (commit(req.cwd, "agent-reviewer"), { summary: "ok", brief: BRIEF });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /its own delivery/);
  assert.ok(!calls.includes("reviewer"));
  assert.equal((await answer(g, "abort")).status, "aborted");
});

test("the cap of 3 revisions escalates to the CEO", async () => {
  override.reviewer = () => ({ verdict: "rejected", comments: "redo it", summary: "x" });
  const g = await start();
  assert.equal(calls.filter((c) => c === "dev").length, 3);
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /cap of 3/);
});

test("invalid node output is a failure: it escalates and does not advance", async () => {
  override.triage = () => ({ junk: 1 });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.ok(!calls.includes("dev"));
});

const ambiguous = () => ({ ...(defaults.triage!({} as Req<unknown>) as object), clear: false, criteria: [] });

test("an ambiguous request goes through the planner and proceeds to the dev once it closes the criteria", async () => {
  override.triage = ambiguous;
  const g = await start();
  assert.deepEqual(calls.slice(0, 2), ["triage", "planner"]);
  assert.equal(paused(g.r)?.type, "approval");
});

test("a planner without criteria escalates with the question; the CEO's answer returns to the planner", async () => {
  override.triage = ambiguous;
  let rounds = 0;
  let seenRequest = "";
  override.planner = (req) => {
    seenRequest = req.context;
    return ++rounds === 1
      ? { ...(ambiguous() as object), question: "which button?", criteria: [] }
      : { ...(defaults.planner!(req) as object) };
  };
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /which button\?/);
  assert.ok(!calls.includes("dev"));
  const r2 = await answer(g, "the checkout one");
  assert.match(seenRequest, /CEO clarification: the checkout one/);
  assert.equal(paused(r2)?.type, "approval");
});

test("the CEO aborts when the planner asks for clarification", async () => {
  override.triage = ambiguous;
  override.planner = () => ({ ...(ambiguous() as object), question: "?", criteria: [] });
  const g = await start();
  assert.equal((await answer(g, "abort")).status, "aborted");
  assert.ok(!calls.includes("dev"));
});

test("an exceeded token budget interrupts the ticket", async () => {
  process.env.TOKEN_BUDGET_TICKET = "50";
  tokensPerCall = 40;
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /budget/);
  assert.ok(!calls.includes("reviewer"));
});

test("evidence declared by the dev without a real passing test is rejected", async () => {
  override.dev = (req) => (commit(req.cwd, "agent-dev", "other.txt", "x"), { summary: "done, tests pass", brief: BRIEF });
  const g = await start();
  assert.ok(!calls.includes("reviewer"));
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /npm test failed/);
});

test("limit of 5 active tickets", async () => {
  const root = mkdtempSync(join(tmpdir(), "gt-"));
  roots.push(root);
  const repo = createFixture(root);
  for (let i = 1; i <= 5; i++) createWorktree(repo, `T-${i}`, join(root, `wt${i}`));
  assert.throws(() => createWorktree(repo, "T-6", join(root, "wt6")), /limit of 5/);
});

test("push and PR come from the graph's code, after QA and before the CEO; deploy only after the CEO", async () => {
  const g = await start();
  assert.equal(publications.length, 1);
  assert.match(publications[0], /^T-1@[0-9a-f]{40}$/);
  assert.ok((paused(g.r)?.evidence as string[]).includes("pr:https://example/pull/1"));
  assert.ok(!calls.includes("devops"));
  const end = await answer(g, "approve");
  assert.equal(end.status, "simulated_deploy");
  assert.ok(!calls.includes("devops"));
});

test("CEO rejection does not trigger the deploy", async () => {
  const g = await start();
  await answer(g, "did not like it");
  assert.ok(!calls.includes("devops"));
});

test("a missing PUBLISHER escalates to the CEO and nothing is published", async () => {
  delete process.env.PUBLISHER;
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /PUBLISHER/);
  assert.equal(publications.length, 0);
});

test("a failing publisher escalates to the CEO", async () => {
  process.env.PUBLISHER = "broken";
  registerPublisher("broken", { publish: () => { throw new Error("push refused"); } });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /push refused/);
});

test("the watchdog reads the state and returns alerts without writing", async () => {
  const g = await start();
  const r = await watchdog([g.r], g.root);
  assert.deepEqual(r.alerts, ["T-1 stalled"]);
  assert.equal(calls.at(-1), "watchdog");
});

test("dev gets the shell rules and qa gets the code-verified evidence", async () => {
  const ctx: Record<string, string> = {};
  for (const role of ["dev", "qa"] as const) {
    const base = defaults[role]!;
    override[role] = (req) => ((ctx[role] = req.context), base(req));
  }
  await start();
  assert.ok(ctx.dev.includes(DEV_RULES));
  assert.match(ctx.qa, /Evidence checked by the orchestrator in code.*tests:npm test ok/);
});

test("alerts flag stalled, looping, over-budget and escalated tickets, and skip finished ones", async () => {
  const g = await start();
  const t = (o: object) => ({ ...g.r, ...o });
  const old = [{ node: "dev", time: "2026-01-01T00:00:00Z", result: "x", ms: 0 }];
  const now = Date.parse("2026-01-02T12:00:00Z");
  const env = { TOKEN_BUDGET_TICKET: "100", STALE_HOURS: "24" };
  assert.deepEqual(alerts([t({ status: "simulated_deploy", history: old })], now, env), []);
  const found = alerts([t({ id: "A", status: "approval", history: old, revisions: 2 })], now, env).join("|");
  assert.match(found, /A \[P2\] approval for 36\.0h/);
  assert.match(found, /A review loop: 2\/3/);
  const usage = { tokens_in: 90, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 };
  assert.match(alerts([t({ id: "B", status: "dev", history: [{ ...old[0], time: "2026-01-02T11:30:00Z", usage }] })], now, env).join(), /B token budget at 90%/);
  assert.match(alerts([t({ id: "C", status: "escalated", summary: "qa: budget", history: [{ ...old[0], time: "2026-01-02T11:30:00Z" }] })], now, env).join(), /C escalated: qa: budget/);
  assert.match(alerts([t({ id: "D", priority: "P0", status: "dev", history: [{ ...old[0], time: "2026-01-02T10:30:00Z" }] })], now, env).join(), /D \[P0\] dev for 1\.5h/);
});

test("merge=pr never merges; merge=auto merges the verified commit only after the CEO approves", async () => {
  const pr = await start("T-1");
  assert.equal((await answer(pr, "approve")).status, "simulated_deploy");
  assert.deepEqual(merges, []);

  const auto = await start("T-2", new MemorySaver(), { merge: "auto" });
  assert.equal(paused(auto.r)?.type, "approval");
  assert.deepEqual(merges, [], "nothing merges before approval");
  const done = await answer(auto, "approve");
  assert.equal(done.status, "simulated_deploy");
  assert.equal(merges.length, 1);
  assert.match(merges[0], /^https:\/\/example\/pull\/1@[0-9a-f]{40}$/);
  assert.ok(done.evidence.some((e: string) => e.startsWith("merged:")));
});

test("a failed merge escalates to the CEO; retry merges, anything else goes back to the dev", async () => {
  mergeError = "CI checks failed";
  const g = await start("T-1", new MemorySaver(), { merge: "auto" });
  const esc = await answer(g, "approve");
  assert.equal(paused(esc)?.type, "escalation");
  assert.match(String(paused(esc)?.reason), /CI checks failed/);
  assert.notEqual(esc.status, "simulated_deploy");
  mergeError = null;
  const retried = await answer(g, "retry");
  assert.equal(retried.status, "simulated_deploy");
  assert.equal(merges.length, 1);

  mergeError = "CI checks failed";
  const h = await start("T-2", new MemorySaver(), { merge: "auto" });
  await answer(h, "approve");
  const back = await answer(h, "fix the failing check");
  assert.equal(paused(back)?.type, "approval", "the dev reran and a new approval was requested");
  assert.equal(merges.length, 1);
});

test("the merge is bound to the commit that was published and approved", async () => {
  const g = await start("T-1", new MemorySaver(), { merge: "auto" });
  assert.equal(paused(g.r)?.type, "approval");
  // someone adds a commit after the PR was opened and before the CEO answers
  commit(join(g.root, "wt"), "agent-dev", "extra.txt", "x\n");
  const r = await answer(g, "approve");
  // the old approval is void: the ticket is re-reviewed, republished and needs a new approval of the new commit
  assert.equal(paused(r)?.type, "approval");
  assert.notEqual(r.approved_sha, g.r.approved_sha);
  assert.deepEqual(merges, []);
  assert.equal((await answer(g, "approve")).status, "simulated_deploy");
  assert.equal(merges.length, 1);
  assert.ok((merges as string[])[0].endsWith(r.approved_sha));
});

test("merge=local fast-forwards main to the approved commit only after the CEO approves; a dirty main escalates", async () => {
  const g = await start("T-1", new MemorySaver(), { merge: "local" });
  assert.equal(paused(g.r)?.type, "approval");
  const before = git(g.repo, "rev-parse", "main");
  const done = await answer(g, "approve");
  assert.equal(done.status, "simulated_deploy");
  assert.equal(git(g.repo, "rev-parse", "main"), done.approved_sha);
  assert.notEqual(before, done.approved_sha);

  const d = await start("T-2", new MemorySaver(), { merge: "local" });
  const base = git(d.repo, "rev-parse", "main");
  writeFileSync(join(d.repo, "checkout.html"), "dirty\n");
  const esc = await answer(d, "approve");
  assert.equal(paused(esc)?.type, "escalation");
  assert.match(String(paused(esc)?.reason), /uncommitted/);
  assert.equal(git(d.repo, "rev-parse", "main"), base);
});

const approved = () => ({ verdict: "approved", comments: "", summary: "ok" });
const reviewerFailsOnce = () => {
  let n = 0;
  return () => {
    if (n++ === 0) throw new NodeFailure("boom");
    return approved();
  };
};

test("the reviewer gets the repo conventions and QA does not", async () => {
  const seen: Record<string, string> = {};
  for (const role of ["dev", "reviewer", "qa"]) {
    override[role] = (req) => ((seen[role] = req.context), defaults[role]!(req));
  }
  await start("T-1", new MemorySaver(), { rules: "R-CANARY" });
  assert.match(seen.dev, /R-CANARY/);
  assert.match(seen.reviewer, /R-CANARY/);
  assert.doesNotMatch(seen.qa, /R-CANARY/);
});

test("retry after a reviewer failure re-runs the reviewer and not the dev", async () => {
  override.reviewer = reviewerFailsOnce();
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  const r = await answer(g, "retry");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(calls.filter((c) => c === "dev").length, 1);
  assert.equal(calls.filter((c) => c === "reviewer").length, 2);
});

test("retry is honoured only for the commit that was verified; a new commit goes back through the dev", async () => {
  override.reviewer = reviewerFailsOnce();
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  commit(join(g.root, "wt"), "agent-dev", "extra.txt", "x\n");
  const r = await answer(g, "retry");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(calls.filter((c) => c === "dev").length, 2);
});

test("a retried node does not see the failure text, but the CEO does", async () => {
  const seen: string[] = [];
  override.reviewer = (req) => {
    seen.push(req.context);
    if (seen.length === 1) throw new NodeFailure("SECRET-DETAIL");
    return approved();
  };
  const g = await start();
  assert.match(String(paused(g.r)?.summary), /SECRET-DETAIL/);
  await answer(g, "retry");
  assert.equal(seen.length, 2);
  assert.doesNotMatch(seen[1], /SECRET-DETAIL/);
});

test("retry on a revision-cap escalation still instructs the dev", async () => {
  override.reviewer = () => ({ verdict: "rejected", comments: "no", summary: "s" });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.equal(calls.filter((c) => c === "dev").length, 3);
  override.reviewer = approved;
  const r = await answer(g, "retry");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(calls.filter((c) => c === "dev").length, 4);
});

test("a non-retry answer after an escalation still goes to the dev", async () => {
  override.reviewer = reviewerFailsOnce();
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  const r = await answer(g, "please fix it");
  assert.equal(paused(r)?.type, "approval");
  assert.equal(calls.filter((c) => c === "dev").length, 2);
});

test("CI is green only with a passing check, no failures, and a stable set of checks", () => {
  const c = (...b: string[]) => b.map((bucket) => ({ bucket }));
  assert.equal(ciVerdict(null, c("pass")), "wait", "first poll never merges");
  assert.equal(ciVerdict(1, c("pass")), "green");
  assert.equal(ciVerdict(1, c("pass", "pass")), "wait", "a check appeared since the last poll");
  assert.equal(ciVerdict(1, c("pass", "pending")), "wait");
  assert.equal(ciVerdict(1, c("skipping")), "wait", "all skipped is not proof");
  assert.equal(ciVerdict(0, c()), "wait", "no checks");
  assert.equal(ciVerdict(2, c("pass", "fail")), "fail");
  assert.equal(ciVerdict(2, c("pass", "cancel")), "fail");
});

test("the reviewer and qa explanations reach the approval request", async () => {
  override = {
    reviewer: () => ({ verdict: "approved", comments: "", summary: "ok", explanation: "R-EXPL" }),
    qa: () => ({ verdict: "approved", comments: "", summary: "ok", explanation: "Q-EXPL" }),
  };
  const g = await start();
  const expl = String(paused(g.r)?.explanation);
  assert.ok(expl.includes("R-EXPL") && expl.includes("Q-EXPL"), expl);
});

test("the planner's briefing and stories land on the ticket and in the dev context", async () => {
  let devCtx = "";
  override = {
    triage: () => ({ ...(defaults.triage!({} as Req<unknown>) as object), clear: false, criteria: [] }),
    planner: () => ({ ...(defaults.triage!({} as Req<unknown>) as object), question: "", briefing: "B-CANARY", stories: ["As a buyer I want X so that Y"] }),
    dev: (req) => ((devCtx = req.context), commit(req.cwd, "agent-dev"), { summary: "ok", brief: BRIEF }),
  };
  const g = await start();
  assert.ok(devCtx.includes("B-CANARY") && devCtx.includes("As a buyer I want X so that Y"), devCtx);
  const s = await g.graph.getState(g.cfg);
  assert.equal(s.values.briefing, "B-CANARY");
  assert.deepEqual(s.values.stories, ["As a buyer I want X so that Y"]);
});

test("a ticket with an incident keeps priority P0 even if triage says P2", async () => {
  const g = await start("T-1", new MemorySaver(), { incident: "inc-1" });
  const s = await g.graph.getState(g.cfg);
  assert.equal(s.values.priority, "P0");
  assert.equal(s.values.incident, "inc-1");
});

test("an explanation from a superseded commit does not reach the approval request", async () => {
  let r = 0, q = 0;
  override = {
    reviewer: () => ({ verdict: "approved", comments: "", summary: "ok", explanation: `R${++r}-EXPL` }),
    qa: () => (++q === 1 ? { verdict: "rejected", comments: "no", summary: "no" } : { verdict: "approved", comments: "", summary: "ok", explanation: "Q2-EXPL" }),
  };
  const g = await start();
  const expl = String(paused(g.r)?.explanation);
  assert.ok(expl.includes("R2-EXPL") && expl.includes("Q2-EXPL") && !expl.includes("R1-EXPL"), expl);
});

test("after approval the deploy node runs the ticket's target and ends in simulated_deploy", async () => {
  const g = await start();
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
  const end = await answer(g, "approve");
  assert.equal(end.status, "simulated_deploy");
  const d = readDeploy(process.env.ORCH_HOME!, "T-1");
  assert.equal(d.sandbox, true);
  assert.equal(d.target, "simulated");
  assert.equal(d.sha, end.approved_sha);
  assert.equal(d.previous, end.base);
  assert.ok(end.evidence.some((e: string) => e.startsWith("deploy:simulated:")));
  assert.ok(!calls.includes("devops"));
});

const CMD_CFG = { command: "node --version", rollback: "node --version", health_url: "http://127.0.0.1:1/health", environment: "staging", env: [], timeout_s: 30, max_latency_ms: 2000 };

test("a command deploy runs only after approval and ends in deployed with cmd settings in the record", async () => {
  const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: CMD_CFG });
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
  const end = await answer(g, "approve");
  assert.equal(end.status, "deployed");
  const d = readDeploy(process.env.ORCH_HOME!, "T-1");
  assert.equal(d.target, "command");
  assert.equal(d.sandbox, false);
  assert.deepEqual(d.cmd, { rollback: "node --version", health_url: CMD_CFG.health_url, env: [], timeout_s: 30, max_latency_ms: 2000, environment: "staging", git_config_hash: end.git_config_hash });
  assert.ok(end.evidence.some((e: string) => e.startsWith("deploy:")));
});

test("a failing deploy command escalates and writes no record", async () => {
  const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: { ...CMD_CFG, command: "node --nonexistent-flag" } });
  const end = await answer(g, "approve");
  assert.notEqual(end.status, "deployed");
  assert.equal(end.status, "escalated");
  assert.match(end.summary, /deploy command failed/);
  assert.ok(!end.summary.includes("nonexistent-flag"), "command output must not reach the escalation text");
  assert.match(readFileSync(join(process.env.ORCH_HOME!, "deploy-logs", "T-1.txt"), "utf8"), /nonexistent-flag/);
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
});

test("the deploy command is not run when the approved commit cannot be checked out", async () => {
  const { t } = await commandTicket();
  await assert.rejects(() => deployTicket(Ticket.parse({ ...t, approved_sha: "0".repeat(40) })), /approved commit/);
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
});

test("the approval request shows the deploy environment", async () => {
  const g = await start("T-1", new MemorySaver(), { deploy_target: "command", deploy_cfg: { ...CMD_CFG, environment: "production" } });
  assert.deepEqual(paused(g.r)?.deploy, { target: "command", environment: "production", command: "node --version", rollback: "node --version", env: [], health_url: CMD_CFG.health_url });
});

const writeExternal = (repo: string, deploy: object) => writeFileSync(join(process.env.ORCH_HOME!, "config.json"), JSON.stringify({ repos: { [resolve(repo)]: { deploy } } }));
async function commandTicket(cfgOver: object = {}) {
  const root = mkdtempSync(join(tmpdir(), "gt-"));
  roots.push(root);
  const repo = createFixture(root);
  const cfg = { ...CMD_CFG, ...cfgOver };
  writeExternal(repo, cfg);
  const sha = git(repo, "rev-parse", "HEAD");
  const t = Ticket.parse({ id: "T-1", request: "p", worktree: repo, repo, base: sha, approved_sha: sha, git_config_hash: gitConfigHash(repo), deploy_target: "command", deploy_cfg: cfg });
  return { t, repo, root, sha };
}

test("the command runs in a checkout of the approved commit and the checkout is gone afterwards", async () => {
  const { t, sha } = await commandTicket({ command: "git rev-parse HEAD" });
  const out = await deployTicket(t);
  assert.ok((out.evidence as string[]).some((e) => e === `deploy:${sha}`), String(out.evidence));
  assert.equal(existsSync(join(workRoot(), "deploy-work", "T-1")), false);
});

test("a git hook in the repo does not run during the deploy checkout", async () => {
  const { t, repo, root } = await commandTicket();
  const marker = join(root, "hook-ran");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  writeFileSync(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho x > "${marker.split("\\").join("/")}"\n`);
  await deployTicket(t);
  assert.equal(existsSync(marker), false);
});

test("a changed .git/config blocks the deploy", async () => {
  const { t, repo } = await commandTicket();
  git(repo, "config", "--local", "foo.bar", "x");
  await assert.rejects(() => deployTicket(t), /\.git\/config changed/);
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
});

test("deploy settings that changed after the ticket started are refused", async () => {
  const { t, repo } = await commandTicket();
  writeExternal(repo, { ...CMD_CFG, command: "node --help" });
  await assert.rejects(() => deployTicket(t), /settings changed/);
  assert.throws(() => readDeploy(process.env.ORCH_HOME!, "T-1"));
});

test("the dev is told its turn limit, and about partial work left by a previous attempt", async () => {
  const { devRules, partialWork } = await import("../src/graph.ts");
  assert.match(devRules("npm test", 40), /at most 40 turns/);
  assert.doesNotMatch(devRules("npm test"), /turns/);
  assert.deepEqual(partialWork("  \n"), []);
  assert.match(partialWork("?? src/server/a.ts\n")[0], /uncommitted work from a previous attempt[\s\S]*src\/server\/a\.ts/);
});

test("the brief (why, how, where it applies) is mandatory for the dev output and renders as PR sections", async () => {
  const { Brief, briefMarkdown, devRules } = await import("../src/graph.ts");
  assert.equal(Brief.safeParse({ why: "short", how: "x", where: "y" }).success, false);
  const b = { why: "Monitoring needs a liveness probe", how: "Added checkHealth with injectable db check", where: "src/lib/health.ts and /api/health only" };
  assert.equal(Brief.safeParse(b).success, true);
  const md = briefMarkdown(b);
  assert.match(md, /## Why\nMonitoring[\s\S]*## How\nAdded[\s\S]*## Where it applies\nsrc\/lib/);
  assert.match(devRules(), /`brief`/);
  assert.equal(Brief.safeParse({ ...b, why: "x".repeat(601) }).success, false);
  const hostile = briefMarkdown({ ...b, how: "# Fake heading\n![p](http://evil/x.png) cc @someone\n## Another" });
  assert.equal(hostile.match(/^## /gm)?.length, 3);
  assert.doesNotMatch(hostile, /(^|[^\\])!\[|@someone/);
  const tricky = briefMarkdown({ ...b, why: "!![a](http://evil/x.png) <img src=http://evil/y.png> `x`" });
  assert.doesNotMatch(tricky, /<img|(^|[^\\])!\[|(^|[^\\])\[a\]/);
  const breaks = briefMarkdown({ ...b, where: "ok\r---\r===\u2028# H\u0085## H2\v\f### H3" });
  assert.equal(breaks.match(/^## /gm)?.length, 3);
  assert.doesNotMatch(breaks, /[\r\v\f\u0085]/);
  assert.ok(!breaks.includes(String.fromCharCode(0x2028)));
});

test("a request that needs several commits is split into atomic tasks run one at a time, then reviewed as a whole", async () => {
  override.triage = () => ({ title: "t", priority: "P2", specialty: "fullstack", clear: true, flags: FLAGS, criteria: ["c"], summary: "ok", split: ["engine and store", "API routes", "ops UI"] });
  const ctxs: string[] = [];
  let n = 0;
  override.dev = (req) => (ctxs.push(req.context), commit(req.cwd, "agent-dev"), n++, { summary: "ok", brief: BRIEF });
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(calls.filter((c) => c === "dev").length, 3);
  assert.equal(calls.filter((c) => c === "reviewer").length, 1);
  assert.match(ctxs[0], /Task 1 of 3[\s\S]*engine and store[\s\S]*Later tasks[\s\S]*2\. API routes/);
  assert.match(ctxs[1], /Task 2 of 3[\s\S]*Already committed[\s\S]*1\. engine and store/);
  assert.match(ctxs[2], /Task 3 of 3[\s\S]*ops UI[\s\S]*last task[\s\S]*whole ticket/);
});

test("a task that ends without a new commit is a failed revision, not progress", async () => {
  override.triage = () => ({ title: "t", priority: "P2", specialty: "fullstack", clear: true, flags: FLAGS, criteria: ["c"], summary: "ok", split: ["one", "two"] });
  let n = 0;
  override.dev = (req) => (++n === 1 ? commit(req.cwd, "agent-dev") : undefined, { summary: "ok", brief: BRIEF });
  const g = await start();
  assert.notEqual(paused(g.r)?.type, "approval");
  assert.equal(calls.filter((c) => c === "reviewer").length, 0);
});

test("a diff over the review limit escalates instead of being cut, and no reviewer runs", async () => {
  override.dev = (req) => (commit(req.cwd, "agent-dev"), commit(req.cwd, "agent-dev", "big.txt", "x".repeat(70_000)), { summary: "ok", brief: BRIEF });
  const g = await start();
  assert.equal(paused(g.r)?.type, "escalation");
  assert.match(String(paused(g.r)?.reason), /diff too large to review in full/);
  assert.ok(!calls.includes("qa"));
});

test("the token budget grows only with verified tasks, up to a fixed ceiling", async () => {
  const { budgetExceeded } = await import("../src/guardrails.ts");
  const u = { tokens_in: 150, tokens_out: 0, cache_read: 0, cache_create: 0, cost_usd: 0, turns: 1, ms: 1 };
  const env = { TOKEN_BUDGET_TICKET: "100" };
  assert.match(String(budgetExceeded([u], env)), /budget exceeded/);
  assert.equal(budgetExceeded([u], env, 1), null);
  assert.match(String(budgetExceeded([u, u, u], env, 1)), /budget exceeded \(450 > 200\)/);
  assert.match(String(budgetExceeded([u], env, -3)), /budget exceeded \(150 > 100\)/);
  assert.match(String(budgetExceeded(Array(100).fill(u), env, 999)), /> 800\)/);
});

const DOC_FILE = { files: [{ path: "arquitetura/visao.md", content: "# Visao\n" }], not_applicable: [], notes: "" };

test("docs run first and last, land in .claude/docs of the main checkout and never dirty it", async () => {
  override = { docs: () => DOC_FILE };
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(readFileSync(join(g.repo, ".claude", "docs", "arquitetura", "visao.md"), "utf8"), "# Visao\n");
  assert.equal(git(g.repo, "status", "--porcelain"), "");
  assert.equal(docsCalls.length, 2);
  assert.match(docsContexts[0], /Mode: scan/);
  assert.match(docsContexts[1], /commit:[0-9a-f]+/);
  assert.match(docsContexts[1], /tests:npm test ok/);
  assert.ok((g.r.history as { node: string }[]).filter((h) => h.node === "docs").length === 2);
});

test("a failing or invalid docs agent only adds warnings; the ticket still reaches approval", async () => {
  for (const docs of [() => { throw new NodeFailure("boom"); }, () => ({ files: "nope" })]) {
    override = { docs };
    const g = await start();
    assert.equal(paused(g.r)?.type, "approval");
    const w = g.r.docs_warnings as string[];
    assert.ok(w.some((x) => x.startsWith("start: ")) && w.some((x) => x.startsWith("end: ")), w.join("|"));
    assert.match(report(Ticket.parse(g.r)), /docs/);
  }
});

test("docs are not written when git would not ignore .claude", async () => {
  afterFixture = (repo) => {
    writeFileSync(join(repo, ".gitignore"), "!.claude/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "unignore");
  };
  override = { docs: () => DOC_FILE };
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(existsSync(join(g.repo, ".claude", "docs", "arquitetura", "visao.md")), false);
  assert.ok((g.r.docs_warnings as string[]).some((x) => /not ignored/.test(x)));
  assert.equal(docsCalls.length, 0);
});

test("docs usage does not count against the ticket token budget", async () => {
  tokensPerCall = 20;
  process.env.TOKEN_BUDGET_TICKET = "90";
  const g = await start();
  assert.equal(paused(g.r)?.type, "approval");
  assert.equal(g.r.status, "approval");
});
