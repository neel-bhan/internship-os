import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CandidateIdentity, ResumeProfile } from '../../shared/types'
import { CANDIDATE_BANK_GUIDANCE_START, createCandidateProfile, updateCandidateProfile } from './templates'

const SPLIT_ROOT_MIGRATION = 'split-root-v1'
const CANDIDATE_EXPERIENCE_BANK_MIGRATION = 'candidate-experience-bank-v1'
const USER_DATA_ENTRIES = [
  'settings.json',
  'candidate-profile.md',
  'internship-os.sqlite3',
  'internship-os.sqlite3-journal',
  'internship-os.sqlite3-shm',
  'internship-os.sqlite3-wal',
  'resumes',
  'archives',
  'codex-settings.json',
  'codex-thread.json',
  'codex-chats.json',
  'claude-chats.json'
] as const

interface MigrationState {
  version: 1
  source: string
  completed: boolean
}

/**
 * Copies durable data from the app's former data root into the canonical root.
 * Existing canonical data always wins, and the legacy root is never changed.
 */
export function migrateSplitLegacyData(target: string, source: string): void {
  if (target === source || !hasUserData(source)) return

  const backupRoot = join(target, 'migration-backups', SPLIT_ROOT_MIGRATION)
  const statePath = join(backupRoot, 'migration.json')
  const state = readMigrationState(statePath)

  if (state?.completed) return
  if (!state && hasUserData(target)) return

  mkdirSync(backupRoot, { recursive: true })
  copyMissingUserData(source, backupRoot)
  atomicWrite(statePath, JSON.stringify({ version: 1, source, completed: false } satisfies MigrationState, null, 2))

  copyMissingUserData(backupRoot, target)
  atomicWrite(statePath, JSON.stringify({ version: 1, source, completed: true } satisfies MigrationState, null, 2))
}

export function hasUserData(root: string): boolean {
  return USER_DATA_ENTRIES.some((name) => existsSync(join(root, name)))
}

/**
 * Creates the candidate experience bank or upgrades the managed header and
 * guidance while preserving all user-authored sections. The first legacy
 * version is backed up before replacement.
 */
export function ensureCandidateExperienceBank(
  root: string,
  identity: CandidateIdentity,
  profiles: ResumeProfile[]
): string {
  const profilePath = join(root, 'candidate-profile.md')
  mkdirSync(root, { recursive: true })
  if (!existsSync(profilePath)) {
    atomicWrite(profilePath, createCandidateProfile(identity, profiles))
    return profilePath
  }

  const current = readFileSync(profilePath, 'utf8')
  const updated = updateCandidateProfile(current, identity, profiles)
  if (updated === current) return profilePath

  if (!current.includes(CANDIDATE_BANK_GUIDANCE_START)) {
    const backupRoot = join(root, 'migration-backups', CANDIDATE_EXPERIENCE_BANK_MIGRATION)
    const backupPath = join(backupRoot, 'candidate-profile.md')
    mkdirSync(backupRoot, { recursive: true })
    if (!existsSync(backupPath)) writeFileSync(backupPath, current)
  }
  atomicWrite(profilePath, updated)
  return profilePath
}

function copyMissingUserData(source: string, target: string): void {
  for (const name of USER_DATA_ENTRIES) {
    const from = join(source, name)
    if (existsSync(from)) copyWithoutOverwrite(from, join(target, name))
  }
}

function copyWithoutOverwrite(source: string, target: string): void {
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
    return
  }

  if (!lstatSync(source).isDirectory() || !lstatSync(target).isDirectory()) return
  for (const entry of readdirSync(source)) copyWithoutOverwrite(join(source, entry), join(target, entry))
}

function readMigrationState(path: string): MigrationState | null {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as MigrationState
    return state.version === 1 && typeof state.completed === 'boolean' ? state : null
  } catch {
    return null
  }
}

function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, value)
  renameSync(temporary, path)
}
