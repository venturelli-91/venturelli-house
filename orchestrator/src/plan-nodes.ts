import { z } from "zod";
import { cap, FlagsSchema, SPECIALTIES, summary } from "./ticket.ts";
import { context, guarded, log } from "./graph-kit.ts";
import { runAgent } from "./run-agent.ts";

const TriageOutput = z.object({
  title: z.string(),
  priority: z.enum(["P0", "P1", "P2", "Bug"]),
  specialty: z.enum(SPECIALTIES),
  clear: z.boolean(),
  flags: FlagsSchema,
  criteria: z.array(z.string()),
  summary,
  split: z.array(z.string().max(300)).max(8).default([]),
});
// `question` is empty when clear; otherwise it is what the CEO needs to answer.
const PlanOutput = TriageOutput.extend({ question: z.string(), briefing: z.string().default(""), stories: z.array(z.string()).default([]) });

// Divide and conquer: one dev session handles one atomic task. Work that needs more is split into an ordered list of tasks
// that the dev runs one at a time in the same worktree, one commit and one verification each.
export const SPLIT_RULE =
  "`split`: if the work needs more than one small commit (several layers, or roughly more than 10 files), " +
  "break it into ordered atomic tasks, at most 8, one line each, " +
  "every one leaving the verification green and building on the previous; otherwise leave it empty.";
const tasksOf = (split: string[]) => (split.length > 1 ? split : []);

export const triage = guarded("triage", async (t) => {
  const { output, usage } = await runAgent({
    role: "triage",
    files: ["triage"],
    cwd: t.worktree,
    schema: TriageOutput,
    context: context(`CEO request: ${t.request}`, SPLIT_RULE),
  });
  const { clear, summary, split, ...rest } = output;
  return {
    ...rest,
    tasks: tasksOf(split),
    task_done: 0,
    priority: t.incident ? ("P0" as const) : rest.priority,
    criteria: clear ? rest.criteria : [],
    summary: cap(summary),
    status: clear ? "dev" : "ambiguous",
    history: log(t, "triage", clear ? "clear" : "ambiguous", usage),
  };
});

// demand-analyst -> product-manager -> tech-lead in a single agent turn (tokens: one context only).
// Without closed criteria there is no ticket: the question goes to the CEO and the answer comes back here.
export const planner = guarded("planner", async (t) => {
  const { output, usage } = await runAgent({
    role: "planner",
    files: ["demand-analyst", "product-manager", "tech-lead"],
    cwd: t.worktree,
    schema: PlanOutput,
    context: context(
      `CEO request: ${t.request}`,
      `Triage (ambiguous request): ${t.summary}`,
      "If missing information prevents verifiable acceptance criteria, set clear=false and put what is missing in `question`.",
      SPLIT_RULE,
    ),
  });
  const { clear, question, split, ...plan } = output;
  if (!clear || !plan.criteria.length) return { status: "ambiguous", summary: cap(question || plan.summary), history: log(t, "planner", "ambiguous", usage) };
  return {
    ...plan,
    tasks: tasksOf(split),
    task_done: 0,
    priority: t.incident ? ("P0" as const) : plan.priority,
    summary: cap(plan.summary),
    status: "dev",
    history: log(t, "planner", "clear", usage),
  };
});
