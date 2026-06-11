#!/usr/bin/env node
/**
 * Symlink skills/mymem → ~/.claude/skills/mymem so Claude Code picks the skill
 * up. Idempotent: re-running reports the existing link; a link pointing
 * elsewhere is retargeted; a real directory is never clobbered.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'mymem')
const targetDir = join(homedir(), '.claude', 'skills')
const target = join(targetDir, 'mymem')

if (!existsSync(join(source, 'SKILL.md'))) {
  console.error(`source skill missing: ${source}/SKILL.md`)
  process.exit(1)
}
mkdirSync(targetDir, { recursive: true })

let stat = null
try {
  stat = lstatSync(target)
} catch {
  // target does not exist yet
}

if (stat?.isSymbolicLink()) {
  const current = resolve(dirname(target), readlinkSync(target))
  if (current === source) {
    console.log(`already installed: ${target} -> ${source}`)
    process.exit(0)
  }
  unlinkSync(target)
  symlinkSync(source, target)
  console.log(`retargeted: ${target} -> ${source} (was ${current})`)
} else if (stat) {
  console.error(`refusing to replace non-symlink at ${target} — remove it manually and re-run`)
  process.exit(1)
} else {
  symlinkSync(source, target)
  console.log(`installed: ${target} -> ${source}`)
}
