import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { orchHome, workRoot } from "./daily-cap.ts";
import { type CommandSettings, commandTarget, getDeployTarget, recordDeploy } from "./deploy.ts";
import { repoOf, safeGit, verifyEvidence } from "./guardrails.ts";
import { checkConfig, guarded, log } from "./graph-kit.ts";
import { mergeLocal } from "./local-merge.ts";
import { mergePr, publish } from "./publish.ts";
import { loadRepoConfig } from "./repo-config.ts";
import { NodeFailure } from "./run-agent.ts";
import { briefMarkdown, type T } from "./ticket.ts";

// Branch push and (draft) PR done by code, not by the agent; only while the evidence still holds.
export const publishNode = guarded("publish", async (t) => {
  const v = t.evidence.length ? verifyEvidence(t.worktree, t.base, t.test, t.install) : { ok: false as const, reason: "no evidence" };
  if (!v.ok) throw new NodeFailure(`invalid evidence: ${v.reason}`);
  checkConfig(t);
  const body = [
    ...(t.brief ? [briefMarkdown(t.brief)] : []),
    t.summary,
    "Criteria:",
    ...t.criteria.map((c) => `- ${c}`),
    `Evidence: ${v.evidence.join(", ")}`,
  ].join("\n\n");
  const pr = publish(
    {
      cwd: t.repo || t.worktree,
      id: t.id,
      sha: v.sha,
      title: `${t.id}: ${t.title}`,
      body,
      remote: t.push_remote,
      baseRepo: t.base_repo,
      disclosure: t.disclosure,
    },
    t.publisher,
  );
  return { status: "approval", approved_sha: v.sha, evidence: [...v.evidence, pr], history: log(t, "publish", pr) };
});

// Deploy only after the CEO, by code: the ticket's target runs the approved commit and the deploy is recorded for the monitor.
// A command target runs in a fresh checkout of exactly the approved commit, never in the worktree the agent touched.
export async function deployTicket(t: T): Promise<Partial<T>> {
  let result: string;
  let cmd: CommandSettings | undefined;
  let target;
  const repo = t.repo || repoOf(t.worktree);
  if (t.deploy_target === "command" && t.deploy_cfg) {
    checkConfig(t);
    if (!isDeepStrictEqual(loadRepoConfig(repo, t.base).deploy, t.deploy_cfg))
      throw new NodeFailure("deploy settings changed since the ticket started; re-run the ticket");
    const c = t.deploy_cfg;
    cmd = {
      rollback: c.rollback,
      health_url: c.health_url,
      env: c.env,
      timeout_s: c.timeout_s,
      max_latency_ms: c.max_latency_ms,
      environment: c.environment,
      git_config_hash: t.git_config_hash,
    };
    const dir = join(workRoot(), "deploy-work", t.id);
    rmSync(dir, { recursive: true, force: true });
    try {
      safeGit(repo, "worktree", "prune");
      safeGit(repo, "worktree", "add", "--detach", dir, t.approved_sha);
    } catch {
      throw new NodeFailure(`approved commit ${t.approved_sha.slice(0, 7)} cannot be checked out for the deploy`);
    }
    try {
      result = commandTarget(c, dir, t.base).deploy({ id: t.id, sha: t.approved_sha });
    } catch (e) {
      // The masked output stays local: the escalation text goes to NOTIFY_URL, which may be a third-party service.
      const logs = join(orchHome(), "deploy-logs");
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, `${t.id}.txt`), (e as Error).message);
      throw new NodeFailure(`deploy command failed; the masked output is in deploy-logs/${t.id}.txt under ORCH_HOME`);
    } finally {
      try {
        safeGit(repo, "worktree", "remove", "--force", dir);
      } catch {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
    target = { sandbox: false };
  } else {
    try {
      target = getDeployTarget(t.deploy_target);
      result = target.deploy({ id: t.id, sha: t.approved_sha });
    } catch (e) {
      throw new NodeFailure((e as Error).message);
    }
  }
  recordDeploy(orchHome(), {
    id: t.id,
    repo,
    sha: t.approved_sha,
    previous: t.base,
    target: t.deploy_target,
    sandbox: target.sandbox,
    ...(cmd ? { cmd } : {}),
  });
  return {
    status: t.deploy_target === "simulated" ? "simulated_deploy" : "deployed",
    evidence: [...t.evidence, `deploy:${result}`],
    history: log(t, "deploy", result),
  };
}
export const deploy = guarded("deploy", deployTicket);

// Squash-merge by code, only for repos that opted in (merge=auto), after the CEO approved, with the evidence still holding.
export const mergeNode = guarded("merge_pr", async (t) => {
  if (t.merge === "pr") return { history: log(t, "merge_pr", "skipped (merge=pr)") };
  const v = verifyEvidence(t.worktree, t.base, t.test, t.install);
  if (!v.ok) throw new NodeFailure(`invalid evidence: ${v.reason}`);
  // What the CEO approved is the commit that was published, not whatever HEAD is now.
  if (!t.approved_sha || v.sha !== t.approved_sha) throw new NodeFailure("merge: commit changed since it was published");
  checkConfig(t);
  if (t.merge === "local") {
    try {
      const merged = mergeLocal(t.repo || repoOf(t.worktree), t.base_branch, t.approved_sha);
      return { evidence: [...t.evidence, merged], history: log(t, "merge_pr", merged) };
    } catch (e) {
      throw new NodeFailure(`merge: ${(e as Error).message}`);
    }
  }
  const pr = t.evidence.find((e) => e.startsWith("pr:"))?.slice(3);
  if (!pr || pr === "none") throw new NodeFailure("merge: no PR to merge");
  const merged = await mergePr({ cwd: t.repo || t.worktree, pr, sha: t.approved_sha, baseRepo: t.base_repo }, t.publisher);
  return { evidence: [...t.evidence, merged], history: log(t, "merge_pr", merged) };
});
