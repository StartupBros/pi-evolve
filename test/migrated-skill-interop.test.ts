import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildCeReviewLensPrompt,
  buildCeReviewPrompt,
  createCeReviewTodoFiles,
  buildBrainstormFirstTransform,
  buildInteropNoteFromPrompt,
  defaultReviewAgentsForProjectType,
  detectConditionalReviewAgents,
  detectProjectTypeFromFiles,
  parseCeReviewFindings,
  extractReferencedSkillNames,
  findReferencedSkillByReadPath,
  findSkillMatch,
  getLatestUserTextFromEntries,
  getReferencedLoadedSkills,
  inferExplicitReviewMode,
  isExploratoryBrainstormPrompt,
  normalizeReadPath,
  normalizeSkillName,
  parseDefaultBranchRef,
  parseInlineFrontmatterList,
  resolveCeReviewDispatch,
  scoreSkillMatch,
  shouldUseMakerkitBoilerplateReviewer,
  splitFrontmatter,
  type SkillEntry,
} from "../src/index.js"

const skills: SkillEntry[] = [
  {
    name: "brainstorming",
    commandName: "skill:brainstorming",
    filePath: "/skills/brainstorming/SKILL.md",
  },
  {
    name: "repo-research-analyst",
    commandName: "skill:repo-research-analyst",
    filePath: "/skills/repo-research-analyst/SKILL.md",
  },
]

test("normalizeSkillName normalizes prefixes and separators", () => {
  assert.equal(normalizeSkillName("skill:workflows:brainstorm"), "workflows-brainstorm")
  assert.equal(normalizeSkillName("  Brainstorming Skill  "), "brainstorming-skill")
})

test("normalizeReadPath expands home and resolves relative paths", () => {
  const home = process.env.HOME ?? "/home/test"
  assert.equal(normalizeReadPath("~/skills/demo.md", "/tmp"), `${home}/skills/demo.md`)
  assert.equal(normalizeReadPath("docs/file.md", "/repo"), "/repo/docs/file.md")
})

test("extractReferencedSkillNames finds migrated skill references", () => {
  const prompt = [
    "Load the `brainstorming` skill for techniques.",
    "See repo-research-analyst skill if needed.",
    "Use the workflows:plan skill later.",
  ].join("\n")

  assert.deepEqual(extractReferencedSkillNames(prompt), [
    "brainstorming",
    "repo-research-analyst",
    "workflows-plan",
  ])
})

test("scoreSkillMatch prefers exact matches", () => {
  assert.equal(scoreSkillMatch("brainstorming", skills[0]), 100)
  assert.ok(scoreSkillMatch("brainstorm", skills[0]) < 100)
})

test("findSkillMatch returns best match and suggestions", () => {
  const result = findSkillMatch("brainstorming", skills)
  assert.equal(result.match?.name, "brainstorming")
  assert.equal(result.suggestions[0]?.name, "brainstorming")
})

test("buildInteropNoteFromPrompt emits Pi compatibility guidance", () => {
  const prompt = [
    "# Brainstorm a Feature",
    "Load the `brainstorming` skill for detailed question techniques.",
    "Use AskUserQuestion tool to ask questions.",
    '- Task repo-research-analyst("Understand existing patterns")',
    "Ask one at a time and do repository research.",
  ].join("\n")

  const note = buildInteropNoteFromPrompt(prompt, skills)
  assert.ok(note)
  assert.match(note!, /AskUserQuestion/)
  assert.match(note!, /load_skill_reference/)
  assert.match(note!, /instead of using `read` on its `SKILL\.md` path/)
  assert.match(note!, /subagent/)
  assert.match(note!, /Explore/)
  assert.match(note!, /compound-engineering:review:security-sentinel/)
  assert.match(note!, /ask one clarifying question before repo research/i)
  assert.match(note!, /brainstorming -> \/skills\/brainstorming\/SKILL\.md/)
})

test("getReferencedLoadedSkills returns exact loaded matches from prompt", () => {
  const prompt = [
    "Load the `brainstorming` skill for techniques.",
    "See repo-research-analyst skill if needed.",
  ].join("\n")

  assert.deepEqual(
    getReferencedLoadedSkills(prompt, skills).map((skill) => skill.name),
    ["brainstorming", "repo-research-analyst"],
  )
})

test("findReferencedSkillByReadPath matches direct reads of referenced skill files", () => {
  const prompt = "Load the `brainstorming` skill before you continue."

  assert.equal(
    findReferencedSkillByReadPath(prompt, "/skills/brainstorming/SKILL.md", skills)?.name,
    "brainstorming",
  )
  assert.equal(
    findReferencedSkillByReadPath(prompt, "/skills/repo-research-analyst/SKILL.md", skills),
    undefined,
  )
})

test("getLatestUserTextFromEntries finds the last user message text", () => {
  const entries = [
    { message: { role: "user", content: [{ type: "text", text: "first" }] } },
    { message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
    { message: { role: "user", content: [{ type: "text", text: "second" }] } },
  ]

  assert.equal(getLatestUserTextFromEntries(entries), "second")
})

test("buildInteropNoteFromPrompt returns null for ordinary prompts", () => {
  const note = buildInteropNoteFromPrompt("Write a changelog for the last release.", skills)
  assert.equal(note, null)
})

test("isExploratoryBrainstormPrompt detects brainstorm-first migrated prompts", () => {
  const prompt = [
    "Use /skill:workflows-brainstorm to explore this idea.",
    "- stay in brainstorm mode",
    "- do not code",
    "- do not start with broad repo or home-directory research",
    "- first either ask one clarifying question or suggest whether this should go directly to planning",
  ].join("\n")

  assert.equal(isExploratoryBrainstormPrompt(prompt), true)
  assert.equal(isExploratoryBrainstormPrompt("Fix this failing test and run the suite."), false)
})

test("buildBrainstormFirstTransform prepends a no-tools first-turn rule", () => {
  const prompt = "Use /skill:workflows-brainstorm to explore this idea."
  const transformed = buildBrainstormFirstTransform(prompt)

  assert.match(transformed, /First-turn rule for this brainstorm request:/)
  assert.match(transformed, /Do not use any tools before that first reply\./)
  assert.match(transformed, /Use \/skill:workflows-brainstorm to explore this idea\./)
})

test("parseDefaultBranchRef normalizes remote refs", () => {
  assert.equal(parseDefaultBranchRef("origin/main"), "main")
  assert.equal(parseDefaultBranchRef("refs/remotes/origin/trunk"), "trunk")
  assert.equal(parseDefaultBranchRef("refs/heads/master"), "master")
  assert.equal(parseDefaultBranchRef(""), undefined)
})

test("resolveCeReviewDispatch prefers explicit targets first", () => {
  assert.deepEqual(
    resolveCeReviewDispatch({
      explicitArgs: "173",
      prNumber: 42,
      currentBranch: "feat/demo",
      defaultBranch: "main",
      hasUncommittedChanges: true,
    }),
    {
      resolution: "explicit",
      skillArgs: "173",
      reason: "explicit target: 173",
    },
  )
})

test("resolveCeReviewDispatch routes empty args to current branch PR", () => {
  assert.deepEqual(
    resolveCeReviewDispatch({
      prNumber: 173,
      currentBranch: "feat/google-calendar-sync",
      defaultBranch: "main",
      hasUncommittedChanges: false,
    }),
    {
      resolution: "pr",
      skillArgs: "173",
      reason: "current branch PR #173",
    },
  )
})

test("resolveCeReviewDispatch falls back to branch diff then working tree", () => {
  assert.deepEqual(
    resolveCeReviewDispatch({
      currentBranch: "feat/google-calendar-sync",
      defaultBranch: "main",
      hasUncommittedChanges: false,
    }),
    {
      resolution: "branch",
      skillArgs: "latest",
      reason: "current branch feat/google-calendar-sync vs main",
    },
  )

  assert.deepEqual(
    resolveCeReviewDispatch({
      currentBranch: "main",
      defaultBranch: "main",
      hasUncommittedChanges: true,
    }),
    {
      resolution: "working-tree",
      skillArgs: undefined,
      reason: "current working tree changes",
    },
  )
})

test("resolveCeReviewDispatch returns none when there is nothing reviewable", () => {
  assert.deepEqual(
    resolveCeReviewDispatch({
      currentBranch: "main",
      defaultBranch: "main",
      hasUncommittedChanges: false,
    }),
    {
      resolution: "none",
      reason: "no open PR, non-default branch diff, or local changes were detected",
    },
  )
})

test("splitFrontmatter and inline list parsing extract CE config", () => {
  const source = [
    "---",
    "review_agents: [kieran-typescript-reviewer, security-sentinel]",
    "plan_review_agents: [kieran-typescript-reviewer]",
    "---",
    "",
    "# Review Context",
    "Use full repository context before flagging anything.",
  ].join("\n")

  const { frontmatter, body } = splitFrontmatter(source)
  assert.ok(frontmatter)
  assert.deepEqual(parseInlineFrontmatterList(frontmatter, "review_agents"), [
    "kieran-typescript-reviewer",
    "security-sentinel",
  ])
  assert.equal(body, "# Review Context\nUse full repository context before flagging anything.")
})

test("inferExplicitReviewMode recognizes PRs, latest, working tree, and branches", () => {
  assert.equal(inferExplicitReviewMode("173"), "pr")
  assert.equal(inferExplicitReviewMode("https://github.com/org/repo/pull/173"), "pr")
  assert.equal(inferExplicitReviewMode("latest"), "latest")
  assert.equal(inferExplicitReviewMode("uncommitted"), "working-tree")
  assert.equal(inferExplicitReviewMode("feat/demo"), "branch")
  assert.equal(inferExplicitReviewMode("notes.md"), "document")
})

test("detectProjectTypeFromFiles and defaults mirror CE setup intent", () => {
  assert.equal(detectProjectTypeFromFiles(["tsconfig.json", "src/index.ts"]), "typescript")
  assert.equal(detectProjectTypeFromFiles(["Gemfile", "config/routes.rb"]), "rails")
  assert.deepEqual(defaultReviewAgentsForProjectType("typescript"), [
    "kieran-typescript-reviewer",
    "code-simplicity-reviewer",
    "security-sentinel",
    "performance-oracle",
  ])
})

test("conditional reviewer heuristics pick migration and architecture reviewers", () => {
  assert.deepEqual(
    detectConditionalReviewAgents([
      "apps/startupbros/supabase/migrations/20260310161000_add_google_calendar_distribution.sql",
      ...Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts`),
    ]),
    [
      "schema-drift-detector",
      "data-migration-expert",
      "deployment-verification-agent",
      "architecture-strategist",
    ],
  )
})

test("makerkit reviewer heuristic triggers for shared package changes", () => {
  assert.equal(shouldUseMakerkitBoilerplateReviewer(["packages/ui/src/button.tsx"]), true)
  assert.equal(shouldUseMakerkitBoilerplateReviewer(["apps/web/app/page.tsx"]), false)
})

test("buildCeReviewLensPrompt tells subagents to read reviewer material and stay in lane", () => {
  const prompt = buildCeReviewLensPrompt({
    dispatch: {
      resolution: "pr",
      reason: "current branch PR #173",
    },
    currentBranch: "feat/startupbros-google-calendar-sync",
    defaultBranch: "main",
    pr: {
      number: 173,
      title: "feat: add Google Calendar sync and invite delivery",
      baseRefName: "main",
      headRefName: "feat/startupbros-google-calendar-sync",
    },
    reviewFiles: [
      "apps/startupbros/lib/server/google-calendar/google-calendar-sync.service.ts",
    ],
    plugin: {
      root: "/plugin",
      reviewCommandPath: "/plugin/commands/ce/review.md",
      gitWorktreeSkillPath: "/plugin/skills/git-worktree/SKILL.md",
      setupSkillPath: "/plugin/skills/setup/SKILL.md",
    },
    config: {
      path: "/repo/compound-engineering.local.md",
      reviewAgents: ["kieran-typescript-reviewer"],
      planReviewAgents: ["kieran-typescript-reviewer"],
      reviewContext: "- Built on MakerKit boilerplate",
    },
  }, {
    name: "kieran-typescript-reviewer",
    kind: "agent-file",
    path: "/plugin/agents/review/kieran-typescript-reviewer.md",
  })

  assert.match(prompt, /dedicated Pi subagent/i)
  assert.match(prompt, /reviewer material to read first/i)
  assert.match(prompt, /reviewer resource \(agent-file\): \/plugin\/agents\/review\/kieran-typescript-reviewer\.md/)
  assert.match(prompt, /do not delegate to more subagents/i)
  assert.match(prompt, /No issues found\./)
})

test("buildCeReviewPrompt emphasizes authoritative PR scope and CE resources", () => {
  const prompt = buildCeReviewPrompt({
    dispatch: {
      resolution: "pr",
      skillArgs: "173",
      reason: "current branch PR #173",
    },
    currentBranch: "feat/startupbros-google-calendar-sync",
    defaultBranch: "main",
    originRemote: "git@github.com:StartupBros-com/pushbot.git",
    pr: {
      number: 173,
      title: "feat: add Google Calendar sync and invite delivery",
      url: "https://github.com/StartupBros-com/pushbot/pull/173",
      baseRefName: "main",
      headRefName: "feat/startupbros-google-calendar-sync",
      isDraft: false,
      mergeStateStatus: "UNSTABLE",
    },
    reviewFiles: [
      "apps/startupbros/lib/server/google-calendar/google-calendar-sync.service.ts",
      "packages/mailers/resend/src/index.ts",
    ],
    plugin: {
      root: "/plugin",
      reviewCommandPath: "/plugin/commands/ce/review.md",
      gitWorktreeSkillPath: "/plugin/skills/git-worktree/SKILL.md",
      setupSkillPath: "/plugin/skills/setup/SKILL.md",
    },
    config: {
      path: "/repo/compound-engineering.local.md",
      reviewAgents: ["kieran-typescript-reviewer", "makerkit-boilerplate-reviewer"],
      planReviewAgents: ["kieran-typescript-reviewer"],
      reviewContext: "- Built on MakerKit boilerplate",
    },
    references: [
      { name: "kieran-typescript-reviewer", kind: "agent-file", path: "/plugin/agents/review/kieran-typescript-reviewer.md" },
      { name: "makerkit-boilerplate-reviewer", kind: "skill", path: "/skills/makerkit-boilerplate-reviewer/SKILL.md" },
    ],
    lensResults: [
      {
        name: "kieran-typescript-reviewer",
        kind: "agent-file",
        path: "/plugin/agents/review/kieran-typescript-reviewer.md",
        exitCode: 0,
        output: [
          "Lens: kieran-typescript-reviewer",
          "1. P1 — Type mismatch in calendar sync state transition",
          "Evidence: apps/startupbros/lib/server/google-calendar/google-calendar-sync.service.ts",
          "Impact: sync jobs can silently fail",
          "Fix: narrow the persisted job status union before writing",
        ].join("\n"),
        stderr: "",
      },
    ],
    shouldUseMakerkitReviewer: true,
  })

  assert.match(prompt, /The resolved review target below is authoritative/i)
  assert.match(prompt, /PR: #173/i)
  assert.match(prompt, /command: \/plugin\/commands\/ce\/review\.md/)
  assert.match(prompt, /Parallel reviewer subagent outputs/i)
  assert.match(prompt, /kieran-typescript-reviewer \(ok\)/i)
  assert.match(prompt, /makerkit-boilerplate-reviewer/i)
  assert.match(prompt, /create Pi todo entries/i)
})

test("parseCeReviewFindings extracts structured findings from CE-style review output", () => {
  const findings = parseCeReviewFindings([
    "Target reviewed: PR #173 — feat: add Google Calendar sync and invite delivery",
    "",
    "1. P1 — Auto-published recurring events skip the new calendar/invite delivery flow",
    "Evidence: apps/startupbros/app/api/cron/generate-recurring-events/_lib/generate-recurring-events.ts:93-94 inserts generated events directly as published.",
    "Impact: recurring events do not appear in connected Google Calendars and do not send ICS invite emails.",
    "Fix: after inserting auto-published events, run the same publish side effects as publishEventAction.",
    "",
    "2. P2 — Re-queueing during an active Google sync can be lost",
    "Evidence: enqueue keeps syncing rows as syncing while markSyncCompleted later overwrites the row.",
    "Impact: a second sync request can be dropped until some unrelated future change re-enqueues it.",
    "Fix: preserve a needs-another-pass state or make the success update conditional.",
    "",
    "Merge recommendation: not ready",
  ].join("\n"))

  assert.equal(findings.length, 2)
  assert.equal(findings[0]?.priority, "p1")
  assert.match(findings[0]?.title || "", /Auto-published recurring events/)
  assert.match(findings[1]?.fix || "", /needs-another-pass/i)
})

test("createCeReviewTodoFiles writes CE-style markdown todos", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-evolve-review-"))
  try {
    const created = await createCeReviewTodoFiles(tempDir, [
      {
        priority: "p1",
        title: "Auto-published recurring events skip invite delivery",
        evidence: "events are inserted directly as published",
        impact: "members miss invites",
        fix: "run publish side effects after inserting recurring events",
      },
    ], "PR #173")

    assert.equal(created.length, 1)
    const relative = path.relative(tempDir, created[0]!)
    assert.match(relative, /^todos\/001-pending-p1-/)
    const content = await fs.readFile(created[0]!, "utf8")
    assert.match(content, /status: pending/)
    assert.match(content, /priority: p1/)
    assert.match(content, /Created automatically from native \/ce:review/)
    assert.match(content, /validated against PR #173/)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})
