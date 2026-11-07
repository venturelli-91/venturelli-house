// Section 1: flow rules between nodes (constants + evidence). Section 2: defense inside each node.
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Usage } from "./run-agent.ts";
// On Windows, os.devNull (a \\.\nul path) is not valid for git; use NUL.
export const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
// On Windows the shell of claude -p is PowerShell; on POSIX, Bash.
export const SHELL = process.platform === "win32" ? "PowerShell" : "Bash";
const sh = (...patterns: string[]) => patterns.map((p) => `${SHELL}(${p})`);

export type Role = "triage" | "planner" | "dev" | "reviewer" | "qa" | "devops" | "watchdog" | "knowledge" | "docs";

// ===== Section 1: flow rules =====
export const MAX_REVISIONS = 3;
export const RECURSION_LIMIT = 40;
export const MAX_ACTIVE_TICKETS = 5;
export const NODE_TIMEOUT_MS = 600_000;

export const tokens = (c: Usage) => c.tokens_in + c.tokens_out + c.cache_read + c.cache_create;

// Per-ticket token budget (TOKEN_BUDGET_TICKET). Missing = fail closed.
// The budget is per atomic task, granted by progress the code verified (one more cap per committed and verified task), never by the number of tasks a model declared.
export function budgetExceeded(usages: (Usage | undefined)[], env: NodeJS.ProcessEnv = process.env, verifiedTasks = 0): string | null {
  const cap = Number(env.TOKEN_BUDGET_TICKET) * (1 + Math.min(Math.max(0, verifiedTasks), 7));
  if (!Number(env.TOKEN_BUDGET_TICKET)) throw new Error("missing env: TOKEN_BUDGET_TICKET");
  const used = usages.reduce((a, c) => a + (c ? tokens(c) : 0), 0);
  return used > cap ? `token budget exceeded (${used} > ${cap})` : null;
}

// Nobody approves their own delivery: whoever reviews/tests cannot be the commit author.
export function selfApproval(author: string | null, who: string): string | null {
  if (!author) return "commit author unknown";
  return author === who ? `${who} cannot approve its own delivery` : null;
}

// Active tickets = ticket/* worktrees of the target repo (state lives in git itself, no other database).
export function activeTickets(repo: string): number {
  return safeGit(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("branch refs/heads/ticket/")).length;
}

// Paths no agent may change: secrets, CI and the orchestrator itself.
const FORBIDDEN = /(^|\/)\.env|^\.github\/|^orchestrator\/|^\.orchestrator\.json$|(^|\/)(\.git-credentials|\.npmrc|id_rsa[^/]*)$|\.(pem|key)$|credential|secret/i;

// Host-side git over a repo the agent touched: no fsmonitor, pager, system config or external diff.
export function safeGit(cwd: string, ...args: string[]): string {
  return run(cwd, {}, args);
}

const run = (cwd: string, extraEnv: NodeJS.ProcessEnv, args: string[]) =>
  execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", `core.hooksPath=${devNull}`, ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_EXTERNAL_DIFF: "", GIT_TERMINAL_PROMPT: "0", ...extraEnv }, encoding: "utf8",
  }).trim();

// Network git on the main checkout: no hooks, and plain `ssh` (env wins over a core.sshCommand an agent could have written).
// Pair it with assertGitConfigUnchanged: the rest of .git/config is only trusted if it still matches the ticket's snapshot.
export const safeRemoteGit = (cwd: string, ...args: string[]): string =>
  run(cwd, { GIT_SSH_COMMAND: "ssh", GIT_ALLOW_PROTOCOL: "file:https:ssh:git" }, ["-c", `core.hooksPath=${devNull}`, ...args]);

// The shared .git/config is writable from a ticket worktree; snapshot it before any agent runs.
export const gitConfigHash = (repo: string): string =>
  createHash("sha256").update(readFileSync(resolve(repo, safeGit(repo, "rev-parse", "--git-path", "config")))).digest("hex");

export function assertGitConfigUnchanged(repo: string, expected: string): void {
  if (expected && gitConfigHash(repo) !== expected) throw new Error(".git/config changed since the ticket started; review it, then re-run the ticket");
}

// The main checkout a ticket worktree was created from.
export const repoOf = (worktree: string): string => dirname(resolve(worktree, safeGit(worktree, "rev-parse", "--git-common-dir")));

// Files npm runs on the host: if the agent changed them, the ticket goes to the CEO instead of running.
const RUNS_ON_HOST = /(^|\/)(package\.json|\.npmrc|conftest\.py|setup\.py|setup\.cfg|pyproject\.toml|pytest\.ini|tox\.ini|Makefile)$/i;

// Modularity: every source file a ticket touches must stay within these limits (untouched legacy files are not checked).
export const MAX_FILE_LINES = 300;
export const MAX_LINE_COLS = 160;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|css|scss|go|rs|java|kt|swift|rb|php|vue|svelte|html|sh|sql|c|h|cpp|cs)$/i;
const MAX_FILE_BYTES = MAX_FILE_LINES * (MAX_LINE_COLS + 2);

// Reads the committed blob (never the worktree file, so symlinks are not followed); a blob too big to comply is refused unread.
function modularityViolations(wt: string, files: string[]): string[] {
  return files.filter((f) => SOURCE_FILE.test(f)).flatMap((f) => {
    if (Number(safeGit(wt, "cat-file", "-s", `HEAD:${f}`)) > MAX_FILE_BYTES) return [`${f} (over ${MAX_FILE_BYTES} bytes)`];
    const lines = safeGit(wt, "cat-file", "blob", `HEAD:${f}`).split(/\r?\n/);
    const long = lines.filter((l) => l.length > MAX_LINE_COLS).length;
    return lines.length > MAX_FILE_LINES || long ? [`${f} (${lines.length} lines, ${long} over ${MAX_LINE_COLS} cols)`] : [];
  });
}

// Evidence verified by code (zero token cost): what the agent claims does not count.
export function verifyEvidence(wt: string, base: string, test = DEFAULT_TEST, install = false):{ ok: true; author: string; sha: string; evidence: string[] } | { ok: false; reason: string } {
  const git = (...a: string[]) => safeGit(wt, ...a);
  const sha = git("rev-parse", "HEAD");
  if (Number(git("rev-list", "--count", `${base}..HEAD`)) === 0) return { ok: false, reason: "no new commit in the worktree" };
  // With install, whatever the agent left outside the commit is wiped first and node_modules is rebuilt from the lockfile just before the test.
  if (install) git("clean", "-fdXq");
  // assume-unchanged / skip-worktree hide edits from `git status` and from the diff gate while npm still reads them from disk.
  if (git("ls-files", "-v").split("\n").some((l) => /^[a-zS] /.test(l))) return { ok: false, reason: "worktree has files hidden from git (assume-unchanged or skip-worktree)" };
  // npm test runs over the working tree: only what is committed counts, with no dirt and no ignored executable file.
  const dirt = git("status", "--porcelain", "--untracked-files=all", "--ignored").split("\n").filter(Boolean);
  if (dirt.some((l) => !l.startsWith("!!"))) return { ok: false, reason: "worktree has uncommitted changes" };
  if (dirt.some((l) => RUNS_ON_HOST.test(l.slice(3)))) return { ok: false, reason: "file that runs code on the host is outside the commit (ignored)" };
  const diffFiles = (...extra: string[]) => git("-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", ...extra, `${base}..HEAD`).split("\0").filter(Boolean);
  const files = diffFiles();
  const forbidden = files.filter((f) => FORBIDDEN.test(f));
  if (forbidden.length) return { ok: false, reason: `diff touches forbidden path (${forbidden.join(", ")})` };
  const risky = files.filter((f) => RUNS_ON_HOST.test(f) || (install && /(^|\/)(package-lock|npm-shrinkwrap)\.json$/i.test(f)));
  if (risky.length) return { ok: false, reason: `diff touches a file that runs code on the host (${risky.join(", ")}): requires CEO review` };
  const oversized = modularityViolations(wt, diffFiles("--diff-filter=d"));
  if (oversized.length) return { ok: false, reason: `touched files break the modularity limit (${MAX_FILE_LINES} lines, ${MAX_LINE_COLS} cols): ${oversized.join(", ")}; split them` };
  if (install) installDeps(wt);
  try {
    // execSync (shell) because npm is npm.cmd on Windows. `test` comes from .orchestrator.json at the base commit
    // (a ticket cannot edit it) and RepoConfig only accepts a plain command with no shell operators.
    execSync(test, { cwd: wt, env: minimalEnv("dev"), stdio: "pipe", timeout: NODE_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, reason: `${test} failed: ${String((e as { stdout?: Buffer }).stdout ?? "").slice(-400)}` };
  }
  // npm test runs repo code: if it moved HEAD or dirtied the tree, the verification is void.
  if (git("rev-parse", "HEAD") !== sha) return { ok: false, reason: "HEAD changed during verification" };
  if (git("status", "--porcelain", "--untracked-files=all").length) return { ok: false, reason: "worktree changed during verification" };
  return { ok: true, sha, author: git("log", "-1", "--format=%an", sha), evidence: [`commit:${git("rev-parse", "--short", sha)}`, `tests:${test} ok`] };
}

// Host-side install for repos that opt in (`install` in the repo config): the lockfile comes from the base commit and no package script runs.
export function installDeps(wt: string): void {
  try {
    safeGit(wt, "cat-file", "-e", "HEAD:package-lock.json");
  } catch {
    throw new Error("install: the repo has no committed package-lock.json");
  }
  try {
    execSync("npm ci --ignore-scripts --no-audit --no-fund", { cwd: wt, env: minimalEnv("dev"), stdio: "pipe", timeout: NODE_TIMEOUT_MS });
  } catch (e) {
    throw new Error(`install failed: ${String((e as { stderr?: Buffer }).stderr ?? "").slice(-400)}`);
  }
}

// ===== Section 2: defense inside each node =====
const READ_ONLY = ["Read", "Grep", "Glob"];
const SECRETS = [
  "Read(**/.env*)", "Edit(**/.env*)", "Write(**/.env*)",
  "Read(~/.ssh/**)", "Read(~/.claude/**)", "Read(~/.npmrc)", "Read(~/.git-credentials)", "Read(**/.git/config)",
];
// Git hooks, filters and fsmonitor run code: the dev must not write to them.
const GIT_INTERNALS = ["Write(**/node_modules/**)", "Edit(**/node_modules/**)", "Write(**/.git/**)", "Edit(**/.git/**)", "Write(**/.git)", "Edit(**/.git)", "Write(**/.gitattributes)", "Edit(**/.gitattributes)", "Write(**/.gitmodules)", "Edit(**/.gitmodules)"];

// tools = built-in tools available; allow = auto-approved; deny = always denied.
// Bash with an allowlist is inherently weak: the real barrier is a worktree without .env + an env without credentials.
export const PERMISSIONS: Record<Role, { tools: string[]; allow: string[]; deny: string[] }> = {
  triage: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  planner: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  reviewer: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  qa: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  devops: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  watchdog: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  knowledge: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  docs: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  dev: {
    tools: [...READ_ONLY, "Write", "Edit", SHELL],
    allow: [...READ_ONLY, "Write(./**)", "Edit(./**)", ...sh("git add *", "git commit *", "git status*", "git diff*", "git log*", "npm test*", "npm run typecheck*")],
    deny: [...SECRETS, ...GIT_INTERNALS, ...sh("npm exec*", "npx*", "npm config*", "npm publish*", "npm pkg*", "git push*", "git log*--output*", "git diff*--output*", "git remote*", "git config*", "rm *", "Remove-Item*", "del *", "rmdir*")],
  },
};

export const ALLOWED_ENV = [
  "PATH", "PATHEXT", "SystemRoot", "windir", "COMSPEC", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "LANG", "SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CLAUDE_CODE_GIT_BASH_PATH",
];

// Whitelist: ANTHROPIC_*, tokens and any other variable stay out of the subprocess.
// Git gets a per-role identity (it becomes the verifiable author_id) and loses the credential helper.
export function minimalEnv(role: Role, src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ALLOWED_ENV) if (src[k] !== undefined) env[k] = src[k];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: devNull,
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.pager",
    GIT_CONFIG_VALUE_2: "cat",
    GIT_EXTERNAL_DIFF: "",
    NPM_CONFIG_USERCONFIG: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: `agent-${role}`,
    GIT_AUTHOR_EMAIL: `${role}@orchestrator.local`,
    GIT_COMMITTER_NAME: `agent-${role}`,
    GIT_COMMITTER_EMAIL: `${role}@orchestrator.local`,
  };
}

// MODEL, EFFORT, TURNS: <NAME>_<ROLE> overrides <NAME>_DEFAULT. Missing = failure (closed).
export function readEnv(name: "MODEL" | "EFFORT" | "TURNS", role: Role, src: NodeJS.ProcessEnv = process.env): string {
  const v = src[`${name}_${role.toUpperCase()}`] ?? src[`${name}_DEFAULT`];
  if (!v) throw new Error(`missing env: ${name}_${role.toUpperCase()} or ${name}_DEFAULT`);
  return v;
}

export const DEFAULT_TEST = "npm test";

// `test` is the repo's own test command (from .orchestrator.json); the dev may run exactly that.
export function permissionArgs(role: Role, test = DEFAULT_TEST): string[] {
  const p = PERMISSIONS[role];
  const allow = role === "dev" ? [...p.allow.filter((a) => a !== `${SHELL}(${DEFAULT_TEST}*)`), `${SHELL}(${test}*)`] : p.allow;
  return [
    "--permission-mode", "dontAsk",
    "--tools", p.tools.join(","),
    "--allowedTools", ...allow,
    "--disallowedTools", ...p.deny,
  ];
}
