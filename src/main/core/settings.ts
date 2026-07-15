import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_RESUME_PROFILES,
  type CandidateIdentity,
  type OnboardingInput,
  type ResumeProfile,
  type UserSettings
} from '../../shared/types'

export const SETTINGS_VERSION = 1

const emptyIdentity: CandidateIdentity = {
  fullName: '',
  email: '',
  phone: '',
  portfolio: '',
  github: '',
  linkedin: ''
}

export class SettingsStore {
  readonly path: string
  readonly legacyDataDetected: boolean
  private settings: UserSettings

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true })
    this.path = join(root, 'settings.json')
    this.legacyDataDetected = this.detectLegacyData()
    this.settings = this.read() ?? (this.legacyDataDetected ? this.migrateLegacy() : defaultSettings())
    if (this.legacyDataDetected && !existsSync(this.path)) this.write(this.settings)
  }

  get(): UserSettings {
    return structuredClone(this.settings)
  }

  complete(input: OnboardingInput): UserSettings {
    const fullName = input.identity.fullName.trim()
    if (!fullName) throw new Error('Name is required.')
    if (input.resumeProfiles.length === 0) throw new Error('Select at least one resume profile.')

    const ids = new Set<string>()
    const profiles = input.resumeProfiles.map((profile) => {
      const id = slugifyProfileId(profile.id || profile.name)
      if (!id || ids.has(id)) throw new Error('Resume profile names must be unique.')
      ids.add(id)
      return { id, name: profile.name.trim(), focus: profile.focus.trim() }
    })
    if (profiles.some((profile) => !profile.name)) throw new Error('Every resume profile needs a name.')

    this.settings = {
      version: SETTINGS_VERSION,
      onboardingComplete: true,
      identity: mapIdentity(input.identity),
      exportFilename: sanitizeExportFilename(input.exportFilename, fullName),
      resumeProfiles: profiles,
      assistantProvider: input.assistantProvider,
      editMode: input.editMode
    }
    this.write(this.settings)
    return this.get()
  }

  updateEditMode(editMode: 'review' | 'auto'): UserSettings {
    this.settings = { ...this.settings, editMode }
    this.write(this.settings)
    return this.get()
  }

  private read(): UserSettings | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as UserSettings
      if (parsed.version !== SETTINGS_VERSION || !Array.isArray(parsed.resumeProfiles)) return null
      return {
        ...defaultSettings(),
        ...parsed,
        identity: { ...emptyIdentity, ...parsed.identity },
        exportFilename: sanitizeExportFilename(parsed.exportFilename, parsed.identity?.fullName || 'Candidate')
      }
    } catch {
      return null
    }
  }

  private write(settings: UserSettings): void {
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(settings, null, 2))
    renameSync(temporary, this.path)
  }

  private detectLegacyData(): boolean {
    const profileRoot = join(this.root, 'resumes', 'profiles')
    return existsSync(join(this.root, 'candidate-profile.md')) ||
      existsSync(join(this.root, 'internship-os.sqlite3')) ||
      (existsSync(profileRoot) && readdirSync(profileRoot, { withFileTypes: true }).some((entry) => entry.isDirectory()))
  }

  private migrateLegacy(): UserSettings {
    const identity = this.readLegacyIdentity()
    const profileRoot = join(this.root, 'resumes', 'profiles')
    const existingIds = existsSync(profileRoot)
      ? readdirSync(profileRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : []
    const resumeProfiles = existingIds.length > 0
      ? existingIds.map((id) => DEFAULT_RESUME_PROFILES.find((profile) => profile.id === id) ?? {
        id,
        name: titleCase(id),
        focus: 'Custom resume profile'
      })
      : DEFAULT_RESUME_PROFILES

    return {
      version: SETTINGS_VERSION,
      onboardingComplete: true,
      identity,
      exportFilename: sanitizeExportFilename('', identity.fullName || 'Candidate'),
      resumeProfiles,
      assistantProvider: 'codex',
      editMode: this.readLegacyEditMode()
    }
  }

  private readLegacyIdentity(): CandidateIdentity {
    const path = join(this.root, 'candidate-profile.md')
    if (!existsSync(path)) return { ...emptyIdentity }
    const source = readFileSync(path, 'utf8')
    const value = (label: string): string => source.match(new RegExp(`^- ${label}:\\s*(.+)$`, 'mi'))?.[1]?.trim() ?? ''
    const heading = source.match(/^#\s+(.+?)\s+[—-]\s+Durable Candidate Profile/m)?.[1]?.trim() ?? ''
    return {
      fullName: value('Name') || heading,
      email: value('Email'),
      phone: value('Phone'),
      portfolio: value('Portfolio'),
      github: value('GitHub'),
      linkedin: value('LinkedIn')
    }
  }

  private readLegacyEditMode(): 'review' | 'auto' {
    try {
      const parsed = JSON.parse(readFileSync(join(this.root, 'codex-settings.json'), 'utf8')) as { editMode?: string }
      return parsed.editMode === 'auto' ? 'auto' : 'review'
    } catch {
      return 'review'
    }
  }
}

export function defaultSettings(): UserSettings {
  return {
    version: SETTINGS_VERSION,
    onboardingComplete: false,
    identity: { ...emptyIdentity },
    exportFilename: 'Candidate_Resume.pdf',
    resumeProfiles: [DEFAULT_RESUME_PROFILES[0]],
    assistantProvider: 'none',
    editMode: 'review'
  }
}

export function sanitizeExportFilename(value: string, fullName: string): string {
  const fallback = `${fullName.trim() || 'Candidate'}_Resume`
  const base = (value.trim() || fallback)
    .replace(/\.pdf$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Candidate_Resume'
  return `${base}.pdf`
}

export function slugifyProfileId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

function mapIdentity(identity: CandidateIdentity): CandidateIdentity {
  return Object.fromEntries(Object.entries(identity).map(([key, value]) => [key, value.trim()])) as unknown as CandidateIdentity
}

function titleCase(value: string): string {
  return value.split(/[-_]/).filter(Boolean).map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`).join(' ')
}
