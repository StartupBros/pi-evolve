import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isToolCallEventType, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

export type SkillEntry = {
  name: string
  commandName: string
  filePath: string
}

export type CeReviewDispatchInput = {
  explicitArgs?: string
  prNumber?: number
  currentBranch?: string
  defaultBranch?: string
  hasUncommittedChanges: boolean
}

export type CeReviewDispatch = {
  resolution: "explicit" | "pr" | "branch" | "working-tree" | "none"
  skillArgs?: string
  reason: string
}

export type PrReviewMetadata = {
  number: number
  title?: string
  url?: string
  baseRefName?: string
  headRefName?: string
  isDraft?: boolean
  mergeStateStatus?: string
}

export type CompoundEngineeringConfig = {
  path: string
  reviewAgents: string[]
  planReviewAgents: string[]
  reviewContext: string
}

export type CePluginPaths = {
  root: string
  reviewCommandPath: string
  gitWorktreeSkillPath?: string
  setupSkillPath?: string
}

export type CeResourceReference = {
  name: string
  kind: "skill" | "agent-file"
  path: string
}

export type CeReviewLensResult = {
  name: string
  kind: CeResourceReference["kind"]
  path: string
  exitCode: number
  output: string
  stderr: string
}

export type CeReviewPromptInput = {
  dispatch: CeReviewDispatch
  explicitArgs?: string
  currentBranch?: string
  defaultBranch?: string
  pr?: PrReviewMetadata
  originRemote?: string
  reviewFiles: string[]
  config?: CompoundEngineeringConfig
  plugin?: CePluginPaths
  references: CeResourceReference[]
  lensResults?: CeReviewLensResult[]
  shouldUseMakerkitReviewer: boolean
}

const FALLBACK_REVIEW_AGENTS = [
  "code-simplicity-reviewer",
  "security-sentinel",
  "performance-oracle",
  "architecture-strategist",
]

const ALWAYS_ON_CE_REVIEWERS = [
  "agent-native-reviewer",
  "learnings-researcher",
]

const MAX_PARALLEL_CE_REVIEW_LENSES = 8
const DEFAULT_CE_REVIEW_SUBAGENT_TIMEOUT_MS = 8 * 60 * 1000
const MAX_CE_REVIEW_SUBAGENT_OUTPUT_BYTES = 3 * 1024

export type CeReviewFinding = {
  priority: "p1" | "p2" | "p3"
  title: string
  evidence: string
  impact: string
  fix: string
}

function truncateUtf8(value: string, maxBytes: number): string {
  const input = value || ""
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input

  let truncated = input
  while (Buffer.byteLength(truncated, "utf8") > maxBytes - 20) {
    truncated = truncated.slice(0, -1)
  }

  return `${truncated}\n\n[Output truncated]`
}

function shellEscape(value: string): string {
  return `'${String(value || "").replace(/'/g, `'"'"'`)}'`
}

export function normalizeSkillName(value: string): string {
  return String(value || "")
    .replace(/^skill:/i, "")
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[:\s]+/g, "-")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function normalizeReadPath(inputPath: string, cwd: string): string {
  let resolved = inputPath
  if (resolved.startsWith("@")) resolved = resolved.slice(1)
  if (resolved === "~") resolved = os.homedir()
  else if (resolved.startsWith("~/")) resolved = path.join(os.homedir(), resolved.slice(2))
  if (!path.isAbsolute(resolved)) resolved = path.resolve(cwd, resolved)
  return path.resolve(resolved)
}

export function getSkillIndex(pi: ExtensionAPI, cwd: string): SkillEntry[] {
  const seen = new Set<string>()
  const entries: SkillEntry[] = []

  for (const command of pi.getCommands()) {
    if (command.source !== "skill" || !command.path) continue

    const name = normalizeSkillName(command.name)
    const filePath = normalizeReadPath(command.path, cwd)
    const key = `${name}:${filePath}`
    if (!name || seen.has(key)) continue

    seen.add(key)
    entries.push({
      name,
      commandName: command.name,
      filePath,
    })
  }

  return entries
}

export function scoreSkillMatch(query: string, skill: SkillEntry): number {
  if (!query) return 0
  if (skill.name === query) return 100
  if (skill.commandName === query || skill.commandName === `skill:${query}`) return 95
  if (skill.name.startsWith(query) || query.startsWith(skill.name)) return 80
  if (skill.name.includes(query) || query.includes(skill.name)) return 65

  const queryParts = query.split("-").filter(Boolean)
  if (queryParts.length > 0 && queryParts.every((part) => skill.name.includes(part))) {
    return 55
  }

  return 0
}

export function findSkillMatch(query: string, skills: SkillEntry[]): {
  match?: SkillEntry
  suggestions: SkillEntry[]
} {
  const normalized = normalizeSkillName(query)
  const ranked = skills
    .map((skill) => ({ skill, score: scoreSkillMatch(normalized, skill) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))

  return {
    match: ranked[0]?.skill,
    suggestions: ranked.slice(0, 5).map((entry) => entry.skill),
  }
}

export function extractReferencedSkillNames(prompt: string): string[] {
  const refs = new Set<string>()
  const patterns = [
    /load(?:\s+the)?\s+[`'"]?([a-zA-Z0-9:_/-]+)[`'"]?\s+skill/gi,
    /use(?:\s+the)?\s+[`'"]?([a-zA-Z0-9:_/-]+)[`'"]?\s+skill/gi,
    /see\s+[`'"]?([a-zA-Z0-9:_/-]+)[`'"]?\s+skill/gi,
  ]

  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const name = normalizeSkillName(match[1] ?? "")
      if (name) refs.add(name)
    }
  }

  return [...refs].sort((a, b) => a.localeCompare(b))
}

export function getReferencedLoadedSkills(prompt: string, skills: SkillEntry[]): SkillEntry[] {
  return extractReferencedSkillNames(prompt)
    .map((name) => findSkillMatch(name, skills).match)
    .filter((skill): skill is SkillEntry => Boolean(skill))
}

export function findReferencedSkillByReadPath(
  prompt: string,
  readPath: string,
  skills: SkillEntry[],
): SkillEntry | undefined {
  const normalizedReadPath = path.resolve(readPath)

  return getReferencedLoadedSkills(prompt, skills)
    .find((skill) => path.resolve(skill.filePath) === normalizedReadPath)
}

export function getLatestUserTextFromEntries(entries: Array<any>): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    const message = entry?.message ?? entry
    if (message?.role !== "user") continue

    const content = Array.isArray(message?.content) ? message.content : []
    const text = content
      .filter((item: any) => item?.type === "text" && typeof item.text === "string")
      .map((item: any) => item.text.trim())
      .filter(Boolean)
      .join("\n")

    if (text) return text
  }

  return ""
}

export function isExploratoryBrainstormPrompt(prompt: string): boolean {
  const text = String(prompt || "")
  if (!text.trim()) return false

  const brainstorm = /\/skill:[^\n]*brainstorm|brainstorm/i.test(text)
  const stayExploratory = /(stay in brainstorm mode|do not code)/i.test(text)
  const avoidBroadResearch = /(do not start with broad repo|do not start with broad repository|do not start with broad repo or home-directory research)/i.test(text)
  const firstTurnConstraint = /(first either ask one clarifying question|go directly to planning|straight to planning)/i.test(text)

  return brainstorm && stayExploratory && avoidBroadResearch && firstTurnConstraint
}

export function buildBrainstormFirstTransform(prompt: string): string {
  return [
    "First-turn rule for this brainstorm request:",
    "- On your first reply, either ask exactly one clarifying question or say we should go straight to planning.",
    "- Do not use any tools before that first reply.",
    "- Do not start repo research yet.",
    "",
    prompt,
  ].join("\n")
}

export function buildInteropNoteFromPrompt(prompt: string, skills: SkillEntry[]): string | null {
  const referencedSkills = extractReferencedSkillNames(prompt)
  const hasAskUserQuestion = /\bAskUserQuestion\b/.test(prompt)
  const hasTaskSyntax = /(^|\n)\s*-?\s*Task\s+[a-z][a-z0-9-]*\(([^)]*)\)/m.test(prompt)
  const isExploratoryBrainstorm = /brainstorm/i.test(prompt)
    && /(repository research|repo scan|requirements clarity|what to build|approach(?:es)?|ask one at a time)/i.test(prompt)

  if (
    referencedSkills.length === 0
    && !hasAskUserQuestion
    && !hasTaskSyntax
    && !isExploratoryBrainstorm
  ) {
    return null
  }

  const resolvedReferences = referencedSkills.map((name) => ({
    name,
    ...findSkillMatch(name, skills),
  }))

  const lines = [
    "",
    "## Migrated skill interop",
    "The current prompt appears to come from a migrated cross-harness workflow. Apply these Pi compatibility rules:",
  ]

  if (resolvedReferences.length > 0) {
    lines.push("- When a skill says to load another skill, do not search the filesystem broadly. Prefer the resolved loaded skill paths below or use `load_skill_reference`.")
    lines.push("- If the prompt explicitly says to load a loaded skill, call `load_skill_reference` for that skill instead of using `read` on its `SKILL.md` path.")
  }
  if (hasAskUserQuestion) {
    lines.push("- `AskUserQuestion` means the Pi tool `ask_user_question`.")
  }
  if (hasTaskSyntax) {
    lines.push("- `Task agent(args)` means the Pi tool `subagent` with `agent` and `task` fields.")
    lines.push("- Common migrated agent names such as `Explore`, `Plan`, `general-purpose`, `Bash`, and namespaced Compound Engineering agents like `compound-engineering:review:security-sentinel` are supported through global Pi agent wrappers when available.")
  }
  if (isExploratoryBrainstorm) {
    lines.push("- For exploratory or brainstorm workflows, ask one clarifying question before repo research unless requirements are already explicit. Keep research bounded to a few targeted reads/searches or one tightly scoped `subagent`.")
  }

  const exactMatches = resolvedReferences.filter((entry) => entry.match)
  if (exactMatches.length > 0) {
    lines.push("", "Resolved skill references for this turn:")
    for (const entry of exactMatches) {
      lines.push(`- ${entry.name} -> ${entry.match!.filePath}`)
    }
  }

  const unresolved = resolvedReferences.filter((entry) => !entry.match && entry.suggestions.length > 0)
  if (unresolved.length > 0) {
    lines.push("", "Close loaded skill matches:")
    for (const entry of unresolved) {
      const suggestionList = entry.suggestions.map((skill) => `${skill.name} (${skill.filePath})`).join(", ")
      lines.push(`- ${entry.name} -> ${suggestionList}`)
    }
  }

  return lines.join("\n")
}

export function parseDefaultBranchRef(value: string | null | undefined): string | undefined {
  const normalized = String(value || "").trim()
  if (!normalized) return undefined

  return normalized
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    .trim() || undefined
}

export function resolveCeReviewDispatch(input: CeReviewDispatchInput): CeReviewDispatch {
  const explicitArgs = String(input.explicitArgs || "").trim()
  if (explicitArgs) {
    return {
      resolution: "explicit",
      skillArgs: explicitArgs,
      reason: `explicit target: ${explicitArgs}`,
    }
  }

  if (typeof input.prNumber === "number" && Number.isFinite(input.prNumber) && input.prNumber > 0) {
    return {
      resolution: "pr",
      skillArgs: String(input.prNumber),
      reason: `current branch PR #${input.prNumber}`,
    }
  }

  if (input.currentBranch && input.defaultBranch && input.currentBranch !== input.defaultBranch) {
    return {
      resolution: "branch",
      skillArgs: "latest",
      reason: `current branch ${input.currentBranch} vs ${input.defaultBranch}`,
    }
  }

  if (input.hasUncommittedChanges) {
    return {
      resolution: "working-tree",
      skillArgs: undefined,
      reason: "current working tree changes",
    }
  }

  return {
    resolution: "none",
    reason: "no open PR, non-default branch diff, or local changes were detected",
  }
}

export function splitFrontmatter(input: string): {
  frontmatter?: string
  body: string
} {
  const normalized = input.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---\n")) {
    return { body: normalized.trim() }
  }

  const end = normalized.indexOf("\n---\n", 4)
  if (end < 0) {
    return { body: normalized.trim() }
  }

  return {
    frontmatter: normalized.slice(4, end).trim(),
    body: normalized.slice(end + 5).trim(),
  }
}

export function parseInlineFrontmatterList(frontmatter: string | undefined, key: string): string[] {
  if (!frontmatter) return []

  const pattern = new RegExp(`^${key}:\\s*\\[(.*?)\\]\\s*$`, "m")
  const match = frontmatter.match(pattern)
  if (!match) return []

  return match[1]
    .split(",")
    .map((item) => item.trim())
    .map((item) => item.replace(/^['"]+|['"]+$/g, ""))
    .filter(Boolean)
}

export function inferExplicitReviewMode(value: string): "pr" | "branch" | "latest" | "working-tree" | "document" | "unknown" {
  const normalized = String(value || "").trim()
  if (!normalized) return "unknown"
  if (/^\d+$/.test(normalized)) return "pr"
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(normalized)) return "pr"
  if (normalized === "latest") return "latest"
  if (normalized === "working-tree" || normalized === "uncommitted") return "working-tree"
  if (/\.md$/i.test(normalized)) return "document"
  return "branch"
}

export function detectProjectTypeFromFiles(files: string[]): "rails" | "python" | "typescript" | "javascript" | "general" {
  const normalized = files.map((file) => file.toLowerCase())
  if (normalized.some((file) => file.endsWith("gemfile") || file.includes("config/routes.rb") || /\.rb$/i.test(file))) {
    return "rails"
  }
  if (normalized.some((file) => file.endsWith("pyproject.toml") || file.endsWith("requirements.txt") || /\.py$/i.test(file))) {
    return "python"
  }
  if (normalized.some((file) => file.endsWith("tsconfig.json") || /\.(ts|tsx)$/.test(file))) {
    return "typescript"
  }
  if (normalized.some((file) => file.endsWith("package.json") || /\.(js|jsx|mjs|cjs)$/.test(file))) {
    return "javascript"
  }
  return "general"
}

export function defaultReviewAgentsForProjectType(projectType: "rails" | "python" | "typescript" | "javascript" | "general"): string[] {
  switch (projectType) {
    case "rails":
      return ["kieran-rails-reviewer", "dhh-rails-reviewer", "code-simplicity-reviewer", "security-sentinel", "performance-oracle"]
    case "python":
      return ["kieran-python-reviewer", "code-simplicity-reviewer", "security-sentinel", "performance-oracle"]
    case "typescript":
      return ["kieran-typescript-reviewer", "code-simplicity-reviewer", "security-sentinel", "performance-oracle"]
    case "javascript":
      return ["code-simplicity-reviewer", "security-sentinel", "performance-oracle", "architecture-strategist"]
    default:
      return [...FALLBACK_REVIEW_AGENTS]
  }
}

export function detectConditionalReviewAgents(reviewFiles: string[]): string[] {
  const files = reviewFiles.map((file) => file.toLowerCase())
  const conditional = new Set<string>()

  const hasMigrations = files.some((file) =>
    file.includes("/migrations/")
    || file.includes("db/migrate/")
    || file.endsWith("schema.rb")
    || file.includes("backfill"),
  )

  if (hasMigrations) {
    conditional.add("schema-drift-detector")
    conditional.add("data-migration-expert")
    conditional.add("deployment-verification-agent")
  }

  if (reviewFiles.length >= 10) {
    conditional.add("architecture-strategist")
  }

  return [...conditional]
}

export function shouldUseMakerkitBoilerplateReviewer(reviewFiles: string[]): boolean {
  return reviewFiles.some((file) =>
    file.startsWith("packages/")
    || file.startsWith("tooling/")
    || file.includes("makerkit")
    || file.includes("next-supabase"),
  )
}

export function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "review-finding"
}

export function extractAssistantTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return ""
  const maybeMessage = message as { role?: string; content?: Array<{ type?: string; text?: string }> }
  if (maybeMessage.role !== "assistant" || !Array.isArray(maybeMessage.content)) return ""

  return maybeMessage.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

export function parseCeReviewFindings(reviewText: string): CeReviewFinding[] {
  const normalized = reviewText.replace(/\r\n/g, "\n")
  const matches = [...normalized.matchAll(/(?:^|\n)(\d+)\.\s*(P[1-3])\s+—\s+(.+?)(?=\n\d+\.\s*P[1-3]\s+—|\n(?:MakerKit boilerplate review|Validation|Merge recommendation):|$)/gs)]

  return matches.map((match) => {
    const block = match[0].trim()
    const priority = match[2].toLowerCase() as "p1" | "p2" | "p3"
    const title = match[3].trim()
    const evidence = (block.match(/Evidence:\s*([\s\S]*?)(?=\nImpact:|\nFix:|$)/)?.[1] ?? "").trim()
    const impact = (block.match(/Impact:\s*([\s\S]*?)(?=\nFix:|$)/)?.[1] ?? "").trim()
    const fix = (block.match(/Fix:\s*([\s\S]*?)$/)?.[1] ?? "").trim()

    return {
      priority,
      title,
      evidence,
      impact,
      fix,
    }
  }).filter((finding) => finding.title)
}

export async function createCeReviewTodoFiles(cwd: string, findings: CeReviewFinding[], reviewTarget: string): Promise<string[]> {
  if (findings.length === 0) return []

  const todosDir = path.join(cwd, "todos")
  await fs.mkdir(todosDir, { recursive: true })

  const existing = await fs.readdir(todosDir).catch(() => [])
  let nextId = existing
    .map((file) => Number.parseInt(file.slice(0, 3), 10))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0) + 1

  const created: string[] = []

  for (const finding of findings) {
    const issueId = String(nextId).padStart(3, "0")
    nextId += 1
    const fileName = `${issueId}-pending-${finding.priority}-${slugify(finding.title)}.md`
    const filePath = path.join(todosDir, fileName)
    const content = [
      "---",
      `status: pending`,
      `priority: ${finding.priority}`,
      `issue_id: ${issueId}`,
      `tags: [code-review]`,
      "---",
      "",
      `# ${finding.title}`,
      "",
      "## Problem",
      finding.impact || "Review finding detected during Compound Engineering review.",
      "",
      "## Evidence",
      finding.evidence || "See review output for details.",
      "",
      "## Suggested Fix",
      finding.fix || "Investigate and implement a targeted fix.",
      "",
      "## Acceptance Criteria",
      `- [ ] The issue described in \"${finding.title}\" is fixed`,
      `- [ ] The fix is validated against ${reviewTarget}`,
      "- [ ] Any affected tests or verification steps are updated",
      "",
      "## Notes",
      `- Created automatically from native /ce:review`,
    ].join("\n")

    await fs.writeFile(filePath, content, "utf8")
    created.push(filePath)
  }

  return created
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function execText(pi: ExtensionAPI, command: string, args: string[]): Promise<string | undefined> {
  const result = await pi.exec(command, args)
  if (result.code !== 0) return undefined

  const text = `${result.stdout || ""}${result.stderr || ""}`.trim()
  return text || undefined
}

async function execLines(pi: ExtensionAPI, command: string, args: string[]): Promise<string[]> {
  const text = await execText(pi, command, args)
  if (!text) return []
  return text.split("\n").map((line) => line.trim()).filter(Boolean)
}

async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
  const status = await execText(pi, "git", ["status", "--porcelain"])
  return Boolean(status && status.trim())
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | undefined> {
  return execText(pi, "git", ["branch", "--show-current"])
}

async function getDefaultBranch(pi: ExtensionAPI): Promise<string | undefined> {
  const remoteHead = await execText(pi, "git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
  const parsedRemoteHead = parseDefaultBranchRef(remoteHead)
  if (parsedRemoteHead) return parsedRemoteHead

  const repoDefaultBranch = parseDefaultBranchRef(
    await execText(pi, "gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]),
  )
  if (repoDefaultBranch) return repoDefaultBranch

  const candidates = ["main", "master", "trunk", "develop"]
  for (const candidate of candidates) {
    const exists = await pi.exec("git", ["rev-parse", "--verify", candidate])
    if (exists.code === 0) return candidate
  }

  return undefined
}

async function getCurrentBranchPrNumber(pi: ExtensionAPI): Promise<number | undefined> {
  const raw = await execText(pi, "gh", ["pr", "view", "--json", "number", "--jq", ".number"])
  if (!raw) return undefined

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

async function getOriginRemote(pi: ExtensionAPI): Promise<string | undefined> {
  return execText(pi, "git", ["remote", "get-url", "origin"])
}

async function resolveLatestPluginRoot(basePath: string): Promise<string | undefined> {
  if (!await pathExists(basePath)) return undefined
  if (await pathExists(path.join(basePath, "commands", "ce", "review.md"))) return basePath

  const entries = await fs.readdir(basePath, { withFileTypes: true })
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }))

  for (const version of versions) {
    const candidate = path.join(basePath, version)
    if (await pathExists(path.join(candidate, "commands", "ce", "review.md"))) {
      return candidate
    }
  }

  return undefined
}

async function resolveCePluginPaths(): Promise<CePluginPaths | undefined> {
  const candidates = [
    path.join(os.homedir(), ".claude", "plugins", "cache", "every-marketplace", "compound-engineering"),
    path.join(os.homedir(), ".claude", "plugins", "marketplaces", "every-marketplace", "plugins", "compound-engineering"),
    path.join(os.homedir(), ".cache", "checkouts", "github.com", "EveryInc", "compound-engineering-plugin"),
  ]

  for (const candidate of candidates) {
    const root = await resolveLatestPluginRoot(candidate)
    if (!root) continue

    return {
      root,
      reviewCommandPath: path.join(root, "commands", "ce", "review.md"),
      gitWorktreeSkillPath: await pathExists(path.join(root, "skills", "git-worktree", "SKILL.md"))
        ? path.join(root, "skills", "git-worktree", "SKILL.md")
        : undefined,
      setupSkillPath: await pathExists(path.join(root, "skills", "setup", "SKILL.md"))
        ? path.join(root, "skills", "setup", "SKILL.md")
        : undefined,
    }
  }

  return undefined
}

async function loadCompoundEngineeringConfig(cwd: string): Promise<CompoundEngineeringConfig | undefined> {
  const configPath = path.join(cwd, "compound-engineering.local.md")
  if (!await pathExists(configPath)) return undefined

  const content = await fs.readFile(configPath, "utf8")
  const { frontmatter, body } = splitFrontmatter(content)

  return {
    path: configPath,
    reviewAgents: parseInlineFrontmatterList(frontmatter, "review_agents"),
    planReviewAgents: parseInlineFrontmatterList(frontmatter, "plan_review_agents"),
    reviewContext: body,
  }
}

async function loadPrMetadata(pi: ExtensionAPI, ref: string): Promise<PrReviewMetadata | undefined> {
  const result = await pi.exec("gh", [
    "pr",
    "view",
    ref,
    "--json",
    "number,title,baseRefName,headRefName,url,isDraft,mergeStateStatus",
  ])

  if (result.code !== 0 || !result.stdout.trim()) return undefined

  try {
    const parsed = JSON.parse(result.stdout) as PrReviewMetadata
    return parsed
  } catch {
    return undefined
  }
}

async function loadPrFiles(pi: ExtensionAPI, ref: string): Promise<string[]> {
  return execLines(pi, "gh", ["pr", "diff", ref, "--name-only"])
}

async function loadBranchReviewFiles(
  pi: ExtensionAPI,
  defaultBranch: string | undefined,
  currentBranch: string | undefined,
  explicitArgs: string,
): Promise<string[]> {
  const normalized = explicitArgs.trim()
  const targetBranch = normalized && normalized !== "latest" ? normalized : currentBranch
  if (!defaultBranch || !targetBranch) return []

  if (currentBranch && targetBranch === currentBranch) {
    return execLines(pi, "bash", [
      "-lc",
      `git fetch origin ${defaultBranch} ${currentBranch} --quiet && git diff --name-only origin/${defaultBranch}...HEAD`,
    ])
  }

  return execLines(pi, "bash", [
    "-lc",
    `git fetch origin ${defaultBranch} ${targetBranch} --quiet && git diff --name-only origin/${defaultBranch}...origin/${targetBranch}`,
  ])
}

async function loadWorkingTreeFiles(pi: ExtensionAPI): Promise<string[]> {
  const tracked = await execLines(pi, "git", ["diff", "--name-only"])
  const staged = await execLines(pi, "git", ["diff", "--staged", "--name-only"])
  const untracked = await execLines(pi, "git", ["ls-files", "--others", "--exclude-standard"])
  return dedupeStrings([...tracked, ...staged, ...untracked])
}

async function resolveCeResourceReferences(
  skills: SkillEntry[],
  plugin: CePluginPaths | undefined,
  names: string[],
): Promise<CeResourceReference[]> {
  const references: CeResourceReference[] = []

  for (const name of dedupeStrings(names)) {
    const skillMatch = findSkillMatch(name, skills).match
    if (skillMatch) {
      references.push({
        name,
        kind: "skill",
        path: skillMatch.filePath,
      })
      continue
    }

    if (!plugin) continue

    const agentCandidates = [
      path.join(plugin.root, "agents", "review", `${name}.md`),
      path.join(plugin.root, "agents", "research", `${name}.md`),
      path.join(plugin.root, "agents", "design", `${name}.md`),
    ]

    for (const candidate of agentCandidates) {
      if (!await pathExists(candidate)) continue
      references.push({
        name,
        kind: "agent-file",
        path: candidate,
      })
      break
    }
  }

  return references
}

export function buildCeReviewLensPrompt(
  input: Pick<CeReviewPromptInput, "dispatch" | "currentBranch" | "defaultBranch" | "pr" | "reviewFiles" | "plugin" | "config">,
  reference: CeResourceReference,
): string {
  const lines = [
    `You are the Compound Engineering reviewer lens \"${reference.name}\" running inside a dedicated Pi subagent.`,
    "",
    "## Mission",
    `- Apply only the \"${reference.name}\" lens. Stay in that lane.`,
    "- Read the referenced reviewer material and CE command source before forming conclusions.",
    "- Review only the authoritative target files and the minimum surrounding code needed to validate a claim.",
    "- Ignore unrelated local working-tree noise.",
    "- Do not create todos, do not edit files, and do not delegate to more subagents.",
    "- Return concise findings only. If there are no actionable issues for this lens, respond exactly with `No issues found.`",
    "",
    "## Review target",
    `- resolution: ${input.dispatch.resolution}`,
    `- reason: ${input.dispatch.reason}`,
    `- current branch: ${input.currentBranch ?? "unknown"}`,
    `- default branch: ${input.defaultBranch ?? "unknown"}`,
  ]

  if (input.pr) {
    lines.push(`- PR: #${input.pr.number} — ${input.pr.title ?? "(untitled)"}`)
    lines.push(`- base/head: ${input.pr.baseRefName ?? "unknown"} ← ${input.pr.headRefName ?? "unknown"}`)
  }

  lines.push("", "## Reviewer material to read first")
  if (input.plugin) {
    lines.push(`- CE command: ${input.plugin.reviewCommandPath}`)
  }
  if (input.config) {
    lines.push(`- project config: ${input.config.path}`)
  }
  lines.push(`- reviewer resource (${reference.kind}): ${reference.path}`)

  lines.push("", "## Authoritative target files")
  if (input.reviewFiles.length === 0) {
    lines.push("- No target files were precomputed. Use tightly scoped git/gh commands only if absolutely necessary.")
  } else {
    for (const file of input.reviewFiles.slice(0, 120)) {
      lines.push(`- ${file}`)
    }
    if (input.reviewFiles.length > 120) {
      lines.push(`- ... ${input.reviewFiles.length - 120} more files omitted for brevity`)
    }
  }

  lines.push(
    "",
    "## Output format",
    "- Start with `Lens: <name>`",
    "- Then either `No issues found.` or up to 3 findings in this exact format:",
    "  1. P1|P2|P3 — <title>",
    "     Evidence: <path and reasoning>",
    "     Impact: <why it matters>",
    "     Fix: <targeted fix>",
    "- Keep the full response under 250 words.",
  )

  return lines.join("\n")
}

async function runCeReviewLens(
  pi: ExtensionAPI,
  cwd: string,
  prompt: string,
  reference: CeResourceReference,
): Promise<CeReviewLensResult> {
  const script = `cd ${shellEscape(cwd)} && pi --no-session -p ${shellEscape(prompt)}`
  const result = await pi.exec("bash", ["-lc", script], { timeout: DEFAULT_CE_REVIEW_SUBAGENT_TIMEOUT_MS })

  return {
    name: reference.name,
    kind: reference.kind,
    path: reference.path,
    exitCode: result.code,
    output: truncateUtf8((result.stdout || "").trim(), MAX_CE_REVIEW_SUBAGENT_OUTPUT_BYTES),
    stderr: truncateUtf8((result.stderr || "").trim(), MAX_CE_REVIEW_SUBAGENT_OUTPUT_BYTES),
  }
}

async function runCeReviewLenses(
  pi: ExtensionAPI,
  cwd: string,
  input: Pick<CeReviewPromptInput, "dispatch" | "currentBranch" | "defaultBranch" | "pr" | "reviewFiles" | "plugin" | "config">,
  references: CeResourceReference[],
): Promise<CeReviewLensResult[]> {
  const queue = references.slice()
  const results: CeReviewLensResult[] = new Array(references.length)
  const workerCount = Math.max(1, Math.min(MAX_PARALLEL_CE_REVIEW_LENSES, references.length))

  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const next = queue.shift()
      if (!next) return
      const index = references.indexOf(next)
      const prompt = buildCeReviewLensPrompt(input, next)
      results[index] = await runCeReviewLens(pi, cwd, prompt, next)
    }
  })

  await Promise.all(workers)
  return results.filter(Boolean)
}

export function formatCeReviewLensResultsForPrompt(results: CeReviewLensResult[]): string[] {
  if (results.length === 0) {
    return ["- No reviewer subagents were executed."]
  }

  const lines = [
    "The native `/ce:review` bridge already spawned reviewer subagents in parallel.",
    "Use these as first-pass analysis, then verify the highest-risk claims against the code before finalizing findings.",
  ]

  for (const result of results) {
    const status = result.exitCode === 0 ? "ok" : `error:${result.exitCode}`
    const body = result.output || result.stderr || "No output captured."
    lines.push("", `### ${result.name} (${status})`, `- resource: ${result.path}`, "```text", body, "```")
  }

  return lines
}

export function buildCeReviewPrompt(input: CeReviewPromptInput): string {
  const lines = [
    "Execute a Pi-native Compound Engineering `/ce:review`.",
    "",
    "This command intentionally mirrors the real Claude Compound Engineering review flow more closely than the migrated `workflows-review` skill.",
    "",
    "## Behavioral overrides for Pi",
    "- The resolved review target below is authoritative. Do not re-resolve the task to the current working tree just because `git status` is noisy or clean.",
    "- Focus on the PR/base diff or branch diff. Ignore unrelated local modifications unless they are explicitly part of the target files list below.",
    "- If the current branch already matches the PR head branch, stay on the current checkout. Do not waste time proposing worktrees or extra branch switching.",
    "- Use `gh` and `git` only to gather targeted review context. Prefer local file reads from the checked-out repository for actual code inspection.",
    "- Read the Compound Engineering source materials and reviewer resources listed below before producing findings.",
    "",
    "## Resolved review target",
    `- resolution: ${input.dispatch.resolution}`,
    `- reason: ${input.dispatch.reason}`,
    `- current branch: ${input.currentBranch ?? "unknown"}`,
    `- default branch: ${input.defaultBranch ?? "unknown"}`,
    `- origin remote: ${input.originRemote ?? "unknown"}`,
  ]

  if (input.pr) {
    lines.push(`- PR: #${input.pr.number} — ${input.pr.title ?? "(untitled)"}`)
    lines.push(`- PR URL: ${input.pr.url ?? "unknown"}`)
    lines.push(`- base/head: ${input.pr.baseRefName ?? "unknown"} ← ${input.pr.headRefName ?? "unknown"}`)
    lines.push(`- draft: ${input.pr.isDraft ? "yes" : "no"}`)
    lines.push(`- merge state: ${input.pr.mergeStateStatus ?? "unknown"}`)
  }

  lines.push("", "## Authoritative target files")
  if (input.reviewFiles.length === 0) {
    lines.push("- No target files were precomputed. Use scoped git/gh commands to determine review scope.")
  } else {
    for (const file of input.reviewFiles.slice(0, 120)) {
      lines.push(`- ${file}`)
    }
    if (input.reviewFiles.length > 120) {
      lines.push(`- ... ${input.reviewFiles.length - 120} more files omitted for brevity`)
    }
  }

  lines.push("", "## Compound Engineering source materials")
  if (input.plugin) {
    lines.push(`- command: ${input.plugin.reviewCommandPath}`)
    if (input.plugin.gitWorktreeSkillPath) {
      lines.push(`- git-worktree skill: ${input.plugin.gitWorktreeSkillPath}`)
    }
    if (input.plugin.setupSkillPath) {
      lines.push(`- setup skill: ${input.plugin.setupSkillPath}`)
    }
  } else {
    lines.push("- Compound Engineering plugin root was not found locally; rely on the structured instructions in this prompt.")
  }

  if (input.config) {
    lines.push(`- project config: ${input.config.path}`)
    if (input.config.reviewContext.trim()) {
      lines.push("", "## Project review context")
      lines.push(input.config.reviewContext.trim())
    }
  } else {
    lines.push("- project config: compound-engineering.local.md not found in repo root")
    lines.push("- fallback reviewer set was selected from the repository file mix")
  }

  lines.push("", "## Reviewer lenses to apply")
  if (input.references.length === 0) {
    lines.push("- No reviewer resources were resolved. Perform a strong manual review using the CE command and project context.")
  } else {
    for (const reference of input.references) {
      lines.push(`- ${reference.name} (${reference.kind}) -> ${reference.path}`)
    }
  }

  if (input.shouldUseMakerkitReviewer) {
    lines.push("- makerkit-boilerplate-reviewer (loaded Pi skill) should be used because shared packages/boilerplate files are in scope")
  }

  if (input.lensResults && input.lensResults.length > 0) {
    lines.push("", "## Parallel reviewer subagent outputs")
    lines.push(...formatCeReviewLensResultsForPrompt(input.lensResults))
  }

  lines.push(
    "",
    "## Required execution plan",
    "1. Start from the parallel reviewer subagent outputs below. Read the raw CE resources again only when needed to validate or deepen a claim.",
    "2. Confirm the actual review scope from the authoritative target files list, not from incidental local status noise.",
    "3. Inspect the most critical changed files first, then expand outward to callers/callees and surrounding code.",
    "4. If shared `packages/` or MakerKit-origin files are touched, load and use the `makerkit-boilerplate-reviewer` skill.",
    "5. Produce a CE-style review summary with:",
    "   - Target reviewed",
    "   - P1 / P2 / P3 counts",
    "   - Top 3 risks first",
    "   - Merge recommendation: ready / not ready",
    "6. If and only if you identify actionable findings, create Pi todo entries using the `todo` tool with status `pending` and tag `code-review`.",
  )

  return lines.join("\n")
}

export default function migratedSkillInterop(pi: ExtensionAPI) {
  pi.registerTool({
    name: "load_skill_reference",
    label: "Load Skill Reference",
    description: "Resolve a loaded skill by name and return its SKILL.md content. Use when migrated skills say to load another skill; prefer this over broad filesystem searches.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name to resolve, with or without a skill: prefix" }),
      includeContent: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const skills = getSkillIndex(pi, ctx.cwd)
      const query = String(params.name || "")
      const includeContent = params.includeContent ?? true
      const { match, suggestions } = findSkillMatch(query, skills)

      if (!match) {
        const suggestionText = suggestions.length > 0
          ? ` Close matches: ${suggestions.map((skill) => skill.name).join(", ")}`
          : ""

        return {
          isError: true,
          content: [{
            type: "text",
            text: `No loaded skill matched \"${query}\".${suggestionText}`,
          }],
          details: {
            query,
            suggestions: suggestions.map((skill) => ({ name: skill.name, filePath: skill.filePath })),
          },
        }
      }

      const skillContent = includeContent
        ? await fs.readFile(match.filePath, "utf8")
        : ""

      const body = includeContent
        ? `Resolved skill \"${query}\" -> ${match.filePath}\n\n${skillContent}`
        : `Resolved skill \"${query}\" -> ${match.filePath}`

      return {
        content: [{ type: "text", text: body }],
        details: {
          query,
          name: match.name,
          filePath: match.filePath,
          includeContent,
        },
      }
    },
  })

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" as const }
    if (!isExploratoryBrainstormPrompt(event.text)) return { action: "continue" as const }

    return {
      action: "transform" as const,
      text: buildBrainstormFirstTransform(event.text),
    }
  })

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("read", event)) return

    const latestUserText = getLatestUserTextFromEntries(ctx.sessionManager.getBranch() as Array<any>)
    if (!latestUserText) return

    const matchedSkill = findReferencedSkillByReadPath(
      latestUserText,
      String(event.input.path || ""),
      getSkillIndex(pi, ctx.cwd),
    )

    if (!matchedSkill) return

    return {
      block: true,
      reason: `The prompt explicitly asked to load the loaded skill "${matchedSkill.name}". Use load_skill_reference(name: "${matchedSkill.name}") instead of reading its SKILL.md path directly.`,
    }
  })

  pi.on("before_agent_start", async (event, ctx) => {
    const note = buildInteropNoteFromPrompt(event.prompt, getSkillIndex(pi, ctx.cwd))
    if (!note) return

    return {
      systemPrompt: `${event.systemPrompt}${note}`,
    }
  })
}
