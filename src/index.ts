import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

export type SkillEntry = {
  name: string
  commandName: string
  filePath: string
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
  }
  if (hasAskUserQuestion) {
    lines.push("- `AskUserQuestion` means the Pi tool `ask_user_question`.")
  }
  if (hasTaskSyntax) {
    lines.push("- `Task agent(args)` means the Pi tool `subagent` with `agent` and `task` fields.")
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

  pi.on("before_agent_start", async (event, ctx) => {
    const note = buildInteropNoteFromPrompt(event.prompt, getSkillIndex(pi, ctx.cwd))
    if (!note) return

    return {
      systemPrompt: `${event.systemPrompt}${note}`,
    }
  })
}
