import { orchHome } from "./daily-cap.ts";
import { coverage, docsMode, DocsOutput, ensureLocalOnly, snapshot, writeDocs } from "./docs.ts";
import { repoOf } from "./guardrails.ts";
import { log, sh, ticketData } from "./graph-kit.ts";
import { runAgent, type Usage } from "./run-agent.ts";
import type { T } from "./ticket.ts";

// Project docs under <repo>/.claude/docs (local only). Never blocks: every problem becomes a warning for `orch status`.
// Docs usage is logged under node "docs" and left out of the ticket budget.
export const docsNode =
  (phase: "start" | "end") =>
  async (t: T): Promise<Partial<T>> => {
    const prefix = `${phase}: `;
    const keep = t.docs_warnings.filter((w) => !w.startsWith(prefix));
    const done = (warnings: string[], result: string, usage?: Usage): Partial<T> => ({
      docs_warnings: [...keep, ...warnings.map((w) => prefix + w)],
      history: log(t, "docs", result, usage),
    });
    try {
      const repo = t.repo || repoOf(t.worktree);
      const guard = ensureLocalOnly(repo);
      if (guard) return done([guard], "skipped");
      const mode = docsMode(repo);
      const snap = snapshot(repo);
      const facts =
        phase === "end"
          ? [
              `Evidence: ${t.evidence.join(", ")}`,
              `Revisions: ${t.revisions}`,
              `Node history: ${t.history.map((h) => `${h.node}: ${h.result}`).join("; ")}`,
              `Diff stat:\n${sh(t.worktree, "diff", "--stat", t.base, "HEAD")}`,
              ticketData(t),
            ]
          : [];
      const editable =
        Object.entries(snap.shown)
          .map(([p, c]) => `### ${p}\n${c}`)
          .join("\n") || "(none)";
      const { output, usage } = await runAgent({
        role: "docs",
        files: ["docs"],
        cwd: t.worktree,
        schema: DocsOutput,
        context: [
          phase === "start"
            ? "Phase: start. The CEO request just arrived: document the idea, scope and plan."
            : "Phase: end. The delivery is ready: record what was done, what worked and what failed, from the facts below.",
          `Mode: ${mode}`,
          `CEO request: ${t.request}`,
          ...facts,
          `Existing docs (path | title | lines):\n${snap.index || "(none)"}`,
          `Contents you may edit:\n${editable}`,
        ].join("\n\n"),
      });
      const w = writeDocs(repo, output, snap.seen, orchHome());
      return done([...w.warnings, ...(phase === "end" ? coverage(repo) : [])], `${w.written.length} file(s) written`, usage);
    } catch (e) {
      return done([(e instanceof Error ? e.message : String(e)).slice(0, 200)], "failed");
    }
  };
