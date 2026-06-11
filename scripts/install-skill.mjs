#!/usr/bin/env node
/**
 * Install the mymem agent skill for local coding agents (idempotent).
 *
 * Skill locations, verified against each tool's current docs:
 *   claude    ~/.claude/skills/mymem            https://code.claude.com/docs/en/skills
 *   codex     ~/.agents/skills/mymem            https://developers.openai.com/codex/skills (user scope; symlinks supported)
 *   pi        ~/.pi/agent/skills/mymem          https://github.com/earendil-works/pi → packages/coding-agent/docs/skills.md
 *   opencode  ~/.config/opencode/skills/mymem   https://opencode.ai/docs/skills/
 *
 * pi and opencode also read the shared ~/.agents/skills directory, and
 * opencode additionally reads ~/.claude/skills — when the skill is already
 * reachable through one of those, the installer reports it instead of
 * creating a duplicate registration.
 *
 * Usage:
 *   node scripts/install-skill.mjs                  # every detected agent (config dir exists)
 *   node scripts/install-skill.mjs --agent codex    # force a specific agent
 *   node scripts/install-skill.mjs --agent all      # same as the default
 *
 * Idempotent: re-running reports existing links; a link pointing elsewhere is
 * retargeted; a real directory is never clobbered.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = homedir()
const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, '.config')
const codexHome = process.env.CODEX_HOME || join(home, '.codex')
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'mymem')

// Order matters: the shared dirs (~/.claude/skills, ~/.agents/skills) are
// populated by claude/codex first so pi/opencode can report "already".
const AGENTS = [
  {
    id: 'claude',
    configDir: join(home, '.claude'),
    target: join(home, '.claude', 'skills', 'mymem'),
    alsoReads: [],
  },
  {
    id: 'codex',
    configDir: codexHome,
    target: join(home, '.agents', 'skills', 'mymem'),
    alsoReads: [],
  },
  {
    id: 'pi',
    configDir: join(home, '.pi'),
    target: join(home, '.pi', 'agent', 'skills', 'mymem'),
    alsoReads: [{ path: join(home, '.agents', 'skills', 'mymem'), reason: 'pi reads ~/.agents/skills' }],
  },
  {
    id: 'opencode',
    configDir: join(xdgConfig, 'opencode'),
    target: join(xdgConfig, 'opencode', 'skills', 'mymem'),
    alsoReads: [
      { path: join(home, '.claude', 'skills', 'mymem'), reason: 'opencode reads ~/.claude/skills' },
      { path: join(home, '.agents', 'skills', 'mymem'), reason: 'opencode reads ~/.agents/skills' },
    ],
  },
]

const VALID = [...AGENTS.map((a) => a.id), 'all']

function usage() {
  console.log('usage: node scripts/install-skill.mjs [--agent claude|codex|pi|opencode|all]')
  console.log('default: install for every agent whose config dir exists')
}

const args = process.argv.slice(2)
let requested = null
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--help' || arg === '-h') {
    usage()
    process.exit(0)
  } else if (arg === '--agent') {
    requested = args[++i]
  } else if (arg.startsWith('--agent=')) {
    requested = arg.slice('--agent='.length)
  } else {
    console.error(`unknown argument: ${arg}`)
    usage()
    process.exit(1)
  }
}

const names = requested ? requested.split(',').map((s) => s.trim()).filter(Boolean) : ['all']
for (const name of names) {
  if (!VALID.includes(name)) {
    console.error(`unknown agent: ${name} (expected ${VALID.join('|')})`)
    process.exit(1)
  }
}
const installAll = names.includes('all')
const forced = installAll ? new Set() : new Set(names)

if (!existsSync(join(source, 'SKILL.md'))) {
  console.error(`source skill missing: ${source}/SKILL.md`)
  process.exit(1)
}

const tilde = (p) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p)

function pointsAtSource(path) {
  try {
    return realpathSync(path) === realpathSync(source)
  } catch {
    return false
  }
}

/** Symlink source → target. Returns a status line fragment. */
function linkSkill(target) {
  mkdirSync(dirname(target), { recursive: true })
  let stat = null
  try {
    stat = lstatSync(target)
  } catch {
    // target does not exist yet
  }
  if (stat?.isSymbolicLink()) {
    const current = resolve(dirname(target), readlinkSync(target))
    if (current === source || pointsAtSource(target)) {
      return { ok: true, line: `already installed: ${tilde(target)} -> ${tilde(source)}` }
    }
    unlinkSync(target)
    symlinkSync(source, target)
    return { ok: true, line: `retargeted: ${tilde(target)} -> ${tilde(source)} (was ${tilde(current)})` }
  }
  if (stat) {
    if (pointsAtSource(target)) {
      return { ok: true, line: `already installed: ${tilde(target)} (copy/dir resolving to source)` }
    }
    return { ok: false, line: `error: refusing to replace non-symlink at ${tilde(target)} — remove it manually and re-run` }
  }
  symlinkSync(source, target)
  return { ok: true, line: `installed: ${tilde(target)} -> ${tilde(source)}` }
}

console.log(`mymem skill source: ${source}\n`)

let failed = false
for (const agent of AGENTS) {
  if (!installAll && !forced.has(agent.id)) continue

  const label = agent.id.padEnd(9)
  const detected = existsSync(agent.configDir)

  if (!detected && !forced.has(agent.id)) {
    console.log(`${label} skipped: ${agent.id} not found (no ${tilde(agent.configDir)})`)
    continue
  }

  // Already reachable through a shared discovery dir this tool also scans?
  const covered = agent.alsoReads.find(({ path }) => pointsAtSource(path))
  if (covered) {
    console.log(`${label} already: covered by ${tilde(covered.path)} (${covered.reason})`)
    continue
  }

  const note = !detected ? ` (note: ${tilde(agent.configDir)} not found — installed anyway as requested)` : ''
  const result = linkSkill(agent.target)
  console.log(`${label} ${result.line}${note}`)
  if (!result.ok) failed = true
}

process.exit(failed ? 1 : 0)
