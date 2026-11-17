// Second Computer, Outsource: code jobs (PS 1.65). A code job is a kind in the owner's sealed outsource body
// ({kind: "code", title, prompt, repo, base, tool, model?, minutes?, shots?}); PS on the main Mac seals and signs it, PS on
// the second Mac runs it in its own copy (claude -p or codex exec, walls against pushing), and the git bundle comes back
// sealed through the file stream (ps-mac SecondCodeCore.swift, SecondCodeRunner.swift, Second.swift codeLand).
// Off until the person switches Code jobs on in the Outsource tab (settings.secondCodeJobs, synced, so both Macs agree;
// each Mac also refuses on its own). Research keeps working as the owner built it.
// Pure: the window, the store and scripts/second.ts import it; tests/secondcode.test.ts checks it.

export const CODE_MIN_MINUTES = 5;
export const CODE_MAX_MINUTES = 240;   // ps-mac SecondCodeJob.maxMinutes
export const CODE_DEFAULT_MINUTES = 30;
export const CODE_MAX_PROMPT = 20_000;
export const CODE_MINUTE_CHOICES = [15, 30, 60, 120, 240] as const;
export type CodeTool = "claude" | "codex";

/** Is the person's Code jobs switch on? Off unless they switched it on (true only, never a guess). */
export function codeJobsOn(settings: unknown): boolean {
  return !!settings && typeof settings === "object" && (settings as { secondCodeJobs?: unknown }).secondCodeJobs === true;
}

/** A folder name the other Mac has, or a git link without a name or password (ps-mac OutSafe.repoOk). */
export function repoOk(s: string): boolean {
  if (!s || s.length > 300 || /[\s]/.test(s) || ![...s].every((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127)) return false;
  if (folderName(s)) return true;
  if (s.startsWith("https://")) {
    try { const u = new URL(s); return !!u.hostname && !u.username && !u.password && !u.search && !s.includes("@"); } catch { return false; }
  }
  if (s.startsWith("ssh://git@")) return !s.slice(10).includes("@");
  if (s.startsWith("git@")) return s.slice(4).includes(":") && !s.slice(4).includes("@") && !s.includes("::");
  return false;
}
export function folderName(s: string): boolean {
  return !!s && s.length <= 100 && !s.startsWith(".") && !s.startsWith("-") && !s.includes("..") && /^[A-Za-z0-9._-]+$/.test(s);
}
/** A commit or a branch name of safe characters (ps-mac OutSafe.baseOk). */
export function baseOk(s: string): boolean {
  if (!s || s.length > 100 || s.startsWith("-") || s.startsWith("/") || s.includes("..") || s.endsWith("/") || s.endsWith(".lock")) return false;
  return /^[A-Za-z0-9_./-]+$/.test(s);
}

export interface CodeJobIn { title?: string; prompt: string; repo: string; base: string; tool?: CodeTool; model?: "opus" | "sonnet"; minutes?: number; shots?: boolean }

/** The sealed body for a code job, or the plain reason it cannot go. `looksSecret` is core/second.ts's own check. */
export function codeBody(j: CodeJobIn, looksSecret: (s: string) => string | null): { body?: Record<string, unknown>; why?: string } {
  const prompt = j.prompt.trim(), repo = j.repo.trim(), base = j.base.trim(), title = (j.title ?? "").trim();
  if (!prompt) return { why: "Say what it should do." };
  if (prompt.length > CODE_MAX_PROMPT) return { why: `The instructions are over ${CODE_MAX_PROMPT} characters.` };
  if (!repoOk(repo)) return { why: "The repo is a folder name on the other Mac or a git link without a name or password." };
  if (!baseOk(base)) return { why: "The base is a commit or a branch name." };
  const tool: CodeTool = j.tool === "codex" ? "codex" : "claude";
  if (j.model && tool !== "claude") return { why: "A model is only picked for Claude Code." };
  const minutes = j.minutes ?? CODE_DEFAULT_MINUTES;
  if (!Number.isInteger(minutes) || minutes < CODE_MIN_MINUTES || minutes > CODE_MAX_MINUTES) return { why: `The time limit is ${CODE_MIN_MINUTES} to ${CODE_MAX_MINUTES} minutes.` };
  if (title.length > 80 || title.includes("\n")) return { why: "The title is 80 characters at most." };
  const s = looksSecret(`${title}\n${prompt}\n${repo}`);
  if (s) return { why: `It looks like it holds ${s}. Nothing secret may go to the other Mac.` };
  return { body: { kind: "code", ...(title ? { title } : {}), prompt, repo, base, tool, ...(j.model ? { model: j.model } : {}), minutes, ...(j.shots ? { shots: true } : {}) } };
}

/** What the window shows for a code job's result (from PS's ojobs list). */
export interface CodeInfo { tool?: string; repo?: string; base?: string; branch?: string; head?: string; commits?: number; files?: string[]; note?: string; exit?: number; seconds?: number }
export function codeLine(c: CodeInfo | undefined): string {
  if (!c) return "";
  const tool = c.tool === "codex" ? "Codex" : "Claude Code";
  const n = typeof c.commits === "number" ? c.commits : null;
  return [tool, c.repo, n === null ? "" : n === 1 ? "1 commit" : `${n} commits`].filter(Boolean).join(" · ");
}

/** The words the Outsource tab shows for code jobs (the developer approves them). */
export const CODE_WORDS = {
  switchName: "Code jobs",
  switchLine: "Let your AI send code work to the other Mac. It works in its own copy, never pushes, and sends back a git bundle you review.",
  offNote: "Off: no code job is sent from or run on this Mac. Research works as before.",
  bothMacs: "Both Macs follow this switch. The other Mac also says no while it is off there.",
  kind: "Code job",
  kindHint: "Code changes, builds and tests in the other Mac's own copy. A git bundle comes back for you to review.",
  repo: "Repo",
  repoHint: "A folder name or a git link",
  base: "Base",
  baseHint: "A commit or a branch there",
  ask: "What should it do?",
  askHint: "For example: make the failing tests in tests/mail.test.ts pass, and run them",
  tool: "Tool",
  shots: "Send back up to 3 screenshots",
  fine: "Runs in its own copy on the other Mac: no MCP servers, no push, deploy or send, no keys. Sealed to the other Mac and signed by this one.",
  landed: "Bundle in",
  waiting: "Bundle on its way",
  fetch: "Copy the fetch line",
  copied: "Copied",
  forAI: "Copy for AI",
  forAICopied: "Copied. Paste it into your AI",
  noMerge: "Nothing is merged. Fetch it into a review branch and decide.",
};

/** What "Copy for AI" puts on the clipboard: how the person's own AI on the main Mac sends a code job and reads the result. */
export function aiGuide(peer: string): string {
  return [
    `You can send code work to my other Mac (${peer}) through PS. PS must be open on both Macs.`,
    "From a terminal in the PS web folder on this Mac:",
    "  node scripts/second.ts code <repo> \"<what to do>\" [--base <commit>] [--tool claude|codex] [--model opus|sonnet] [--minutes 5..240] [--shots] [--title \"<short title>\"]",
    "  <repo> is a folder name the other Mac has (its Projects folder or Second Computer's copy) or a git link without a name or password.",
    "  --base defaults to the current commit of the folder of that name here; the other Mac must have that commit.",
    "  node scripts/second.ts wait <job>      waits until it finishes (run it in the background)",
    "  node scripts/second.ts result <job>    prints the report and the git fetch line",
    "The other Mac works in its own copy, can not push, deploy or send anything, and hands back a git bundle and a short report.",
    "Fetch the bundle into a review branch, review it, and tell me what it changed. Never merge or push it without asking me.",
    "Never put a password, key or token in the instructions: PS refuses them.",
  ].join("\n");
}
