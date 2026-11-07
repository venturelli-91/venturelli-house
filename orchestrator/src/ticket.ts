import { z } from "zod";
import { DeployConfig } from "./repo-config.ts";
import type { Usage } from "./run-agent.ts";

export const SPECIALTIES = ["frontend", "backend", "fullstack", "mobile", "integrations", "ai", "data"] as const;
export const DEV_FILE: Record<(typeof SPECIALTIES)[number], string> = {
  frontend: "dev-frontend",
  backend: "dev-backend",
  fullstack: "dev-fullstack",
  mobile: "dev-mobile",
  integrations: "dev-integrations",
  ai: "ai-engineer",
  data: "data-engineer",
};
export const summary = z.string().describe("at most 10 lines");
export const cap = (s: string) => s.split("\n").slice(0, 10).join("\n");
export const FlagsSchema = z.object({
  touches_security: z.boolean(),
  touches_performance: z.boolean(),
  touches_ai: z.boolean(),
  touches_schema: z.boolean(),
  touches_public_api: z.boolean(),
  touches_permissions: z.boolean(),
  touches_external_integration: z.boolean(),
  touches_cost: z.boolean(),
});
const EMPTY_FLAGS = Object.fromEntries(Object.keys(FlagsSchema.shape).map((k) => [k, false])) as z.infer<typeof FlagsSchema>;

// The graph's only state. `request`, `criteria`, `worktree` and `base` are the minimal extras the code needs.
// Every delivery says why it exists, how it was done and where it applies: it goes into the PR and the CEO notification.
const briefField = z.string().min(10).max(600);
export const Brief = z.object({ why: briefField, how: briefField, where: briefField });
// Agent text lands in a PR body and in reviewer prompts: one paragraph per field, no headings, images or live @mentions.
const plain = (s: string) =>
  s
    .replace(/[\s\u0085]+/g, " ")
    .replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/[\\`*_~!#|[\]]/g, "\\$&")
    .replace(/@(?=\w)/g, "@\u200b")
    .trim();
export const briefMarkdown = (b: z.infer<typeof Brief>) => `## Why\n${plain(b.why)}\n\n## How\n${plain(b.how)}\n\n## Where it applies\n${plain(b.where)}`;

export const Ticket = z.object({
  id: z.string(),
  request: z.string(),
  worktree: z.string(),
  base: z.string(),
  repo: z.string().default(""),
  git_config_hash: z.string().default(""),
  test: z.string().default("npm test"),
  install: z.boolean().default(false),
  merge: z.enum(["pr", "auto", "local"]).default("pr"),
  publisher: z.string().default(""),
  push_remote: z.string().default("origin"),
  base_repo: z.string().default(""),
  disclosure: z.boolean().default(true),
  base_branch: z.string().default(""),
  approved_sha: z.string().default(""),
  rules: z.string().default(""),
  title: z.string().default(""),
  priority: z.enum(["P0", "P1", "P2", "Bug"]).default("P2"),
  specialty: z.enum(SPECIALTIES).default("fullstack"),
  flags: FlagsSchema.default(EMPTY_FLAGS),
  criteria: z.array(z.string()).default([]),
  status: z.string().default("new"),
  failed_node: z.string().default(""),
  summary_before_failure: z.string().default(""),
  summary: z.string().default(""),
  explanation: z.string().default(""),
  brief: Brief.nullable().default(null),
  tasks: z.array(z.string()).default([]),
  task_done: z.number().default(0),
  briefing: z.string().default(""),
  stories: z.array(z.string()).default([]),
  incident: z.string().default(""),
  deploy_target: z.string().default("simulated"),
  deploy_cfg: DeployConfig.nullable().default(null),
  author_id: z.string().nullable().default(null),
  reviewer_id: z.string().nullable().default(null),
  qa_id: z.string().nullable().default(null),
  revisions: z.number().default(0),
  evidence: z.array(z.string()).default([]),
  docs_warnings: z.array(z.string()).default([]),
  history: z.array(z.object({ node: z.string(), time: z.string(), result: z.string(), ms: z.number(), usage: z.custom<Usage>().optional() })).default([]),
});
export type T = z.infer<typeof Ticket>;
