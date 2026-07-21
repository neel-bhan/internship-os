import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const UPSTREAM = 'https://github.com/Paramchoudhary/ResumeSkills'
const COMMIT = '74ae19e7c62b0516d1c298328e5544976c12da5d'
const ARCHIVE_SHA256 = '32fc24d1c0d3ce819bcd24ff7ceea3ea1d932cfafe6c4eda7de338b2d1f215e9'
const EXCLUDED = [
  'resume-version-manager',
  'salary-negotiation-prep',
  'offer-comparison-analyzer',
  'cold-email-writer'
]
const INCLUDED = [
  'academic-cv-builder',
  'application-form-filler',
  'career-changer-translator',
  'cover-letter-generator',
  'creative-portfolio-resume',
  'executive-resume-writer',
  'interview-prep-generator',
  'job-description-analyzer',
  'linkedin-profile-optimizer',
  'portfolio-case-study-writer',
  'reference-list-builder',
  'resume-ats-optimizer',
  'resume-bullet-writer',
  'resume-formatter',
  'resume-quantifier',
  'resume-section-builder',
  'resume-tailor',
  'tech-resume-optimizer'
]

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const destination = join(root, 'resources', 'resume-skills')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'internship-os-resume-skills-'))
const archivePath = join(temporaryRoot, 'resume-skills.tar.gz')
const extractedRoot = join(temporaryRoot, `ResumeSkills-${COMMIT}`)
const stagedDestination = `${destination}.tmp-${process.pid}`

try {
  const response = await fetch(`${UPSTREAM}/archive/${COMMIT}.tar.gz`)
  if (!response.ok) throw new Error(`ResumeSkills download failed: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest !== ARCHIVE_SHA256) throw new Error('ResumeSkills archive checksum did not match.')
  writeFileSync(archivePath, archive)

  const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', temporaryRoot], { stdio: 'inherit' })
  if (extracted.status !== 0) throw new Error('Could not extract the ResumeSkills archive.')

  rmSync(stagedDestination, { recursive: true, force: true })
  mkdirSync(join(stagedDestination, 'skills'), { recursive: true })
  const skillFileSha256 = {}
  for (const skillName of INCLUDED) {
    const source = join(extractedRoot, 'skills', skillName)
    const target = join(stagedDestination, 'skills', skillName)
    cpSync(source, target, { recursive: true })
    const sourceSkill = readFileSync(join(source, 'SKILL.md'))
    const vendoredSkill = readFileSync(join(target, 'SKILL.md'))
    if (!sourceSkill.equals(vendoredSkill)) {
      throw new Error(`Vendored skill differs from upstream: ${skillName}`)
    }
    skillFileSha256[skillName] = createHash('sha256').update(vendoredSkill).digest('hex')
  }

  cpSync(join(extractedRoot, 'LICENSE'), join(stagedDestination, 'LICENSE'))
  writeFileSync(
    join(stagedDestination, 'manifest.json'),
    `${JSON.stringify({
      upstream: UPSTREAM,
      commit: COMMIT,
      archiveSha256: ARCHIVE_SHA256,
      skillFilesUnmodified: true,
      skillFileSha256,
      included: INCLUDED,
      excluded: EXCLUDED
    }, null, 2)}\n`
  )

  rmSync(destination, { recursive: true, force: true })
  renameSync(stagedDestination, destination)
  console.log(`Vendored ${INCLUDED.length} ResumeSkills from ${COMMIT}.`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
  rmSync(stagedDestination, { recursive: true, force: true })
}
