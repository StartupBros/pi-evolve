import test from "node:test"
import assert from "node:assert/strict"
import {
  buildInteropNoteFromPrompt,
  extractReferencedSkillNames,
  findSkillMatch,
  normalizeReadPath,
  normalizeSkillName,
  scoreSkillMatch,
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
    "- Task repo-research-analyst(\"Understand existing patterns\")",
    "Ask one at a time and do repository research.",
  ].join("\n")

  const note = buildInteropNoteFromPrompt(prompt, skills)
  assert.ok(note)
  assert.match(note!, /AskUserQuestion/)
  assert.match(note!, /load_skill_reference/)
  assert.match(note!, /subagent/)
  assert.match(note!, /ask one clarifying question before repo research/i)
  assert.match(note!, /brainstorming -> \/skills\/brainstorming\/SKILL\.md/)
})

test("buildInteropNoteFromPrompt returns null for ordinary prompts", () => {
  const note = buildInteropNoteFromPrompt("Write a changelog for the last release.", skills)
  assert.equal(note, null)
})
