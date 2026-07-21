import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'

interface ManagedSkillManifest {
  upstream: string
  commit: string
  skillFilesUnmodified: true
  skillFileSha256: Record<string, string>
  included: string[]
  excluded: string[]
}

const providerSkillRoots = [
  ['.agents', 'skills'],
  ['.claude', 'skills']
] as const

export function installManagedSkills(workspaceRoot: string, sourceRoot: string): ManagedSkillManifest {
  const manifestPath = join(sourceRoot, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`Managed resume skill manifest not found: ${manifestPath}`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManagedSkillManifest
  validateManifest(manifest)

  for (const rootParts of providerSkillRoots) {
    const providerRoot = join(workspaceRoot, ...rootParts)
    mkdirSync(providerRoot, { recursive: true })
    for (const skillName of manifest.included) {
      const source = join(sourceRoot, 'skills', skillName)
      const skillPath = join(source, 'SKILL.md')
      if (!existsSync(skillPath)) {
        throw new Error(`Managed resume skill is incomplete: ${skillName}`)
      }
      const digest = createHash('sha256').update(readFileSync(skillPath)).digest('hex')
      if (digest !== manifest.skillFileSha256[skillName]) {
        throw new Error(`Managed resume skill differs from pinned upstream content: ${skillName}`)
      }
      replaceDirectory(source, join(providerRoot, skillName))
    }
  }

  atomicWrite(
    join(workspaceRoot, '.internship-os-skills.json'),
    `${JSON.stringify({ ...manifest, installedAt: new Date().toISOString() }, null, 2)}\n`
  )
  return manifest
}

function validateManifest(manifest: ManagedSkillManifest): void {
  if (!manifest.upstream || !/^[a-f0-9]{40}$/.test(manifest.commit)) {
    throw new Error('Managed resume skill manifest has invalid upstream metadata.')
  }
  if (manifest.skillFilesUnmodified !== true || !manifest.skillFileSha256) {
    throw new Error('Managed resume skills must retain their unchanged upstream content.')
  }
  if (!Array.isArray(manifest.included) || manifest.included.length === 0 || !Array.isArray(manifest.excluded)) {
    throw new Error('Managed resume skill manifest must list included and excluded skills.')
  }
  const names = [...manifest.included, ...manifest.excluded]
  if (names.some((name) => basename(name) !== name || !/^[a-z0-9-]+$/.test(name))) {
    throw new Error('Managed resume skill manifest contains an invalid skill name.')
  }
  if (new Set(names).size !== names.length) {
    throw new Error('Managed resume skill manifest contains duplicate skills.')
  }
  if (manifest.included.some((name) => !/^[a-f0-9]{64}$/.test(manifest.skillFileSha256[name] ?? ''))) {
    throw new Error('Managed resume skill manifest contains an invalid upstream file checksum.')
  }
}

function replaceDirectory(source: string, destination: string): void {
  const temporary = `${destination}.tmp-${process.pid}`
  rmSync(temporary, { recursive: true, force: true })
  copyDirectory(source, temporary)
  rmSync(destination, { recursive: true, force: true })
  renameSync(temporary, destination)
}

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source)) {
    const sourcePath = join(source, entry)
    const destinationPath = join(destination, entry)
    if (statSync(sourcePath).isDirectory()) copyDirectory(sourcePath, destinationPath)
    else copyFileSync(sourcePath, destinationPath)
  }
}

function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, value)
  renameSync(temporary, path)
}
