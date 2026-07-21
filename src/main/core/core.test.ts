import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterEach, describe, expect, it } from 'vitest'
import { ApplicationStore } from './database'
import { exportPdfArtifact } from './artifacts'
import { ensureCandidateExperienceBank, migrateSplitLegacyData } from './data-migration'
import { MAX_CHAT_IMAGES, persistAssistantImages, storedImagePreview } from './chat-images'
import { AppPaths } from './paths'
import { detectRequiredTexFiles, ResumeManager } from './resume'
import { SettingsStore } from './settings'
import { writeAssistantWorkspace } from './instructions'
import { createCandidateProfile, updateCandidateProfile } from './templates'
import { DEFAULT_APPLICATION_STATUS } from '../../shared/types'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ApplicationStore', () => {
  it('defaults new tracker records to Submitted', () => {
    expect(DEFAULT_APPLICATION_STATUS).toBe('Submitted')
  })

  it('stores exactly the minimal tracker fields and valid status', () => {
    const root = temporaryRoot()
    const store = new ApplicationStore(join(root, 'tracker.sqlite3'))
    const saved = store.save({
      company: 'Acme',
      position: 'SWE Intern',
      dateApplied: null,
      status: 'In Progress',
      details: 'Backend role'
    })

    expect(store.list()).toHaveLength(1)
    expect(saved).toMatchObject({ company: 'Acme', position: 'SWE Intern', status: 'In Progress', details: 'Backend role' })
    expect(saved.submissions).toEqual([])
    store.close()
  })
})

describe('PDF artifact export', () => {
  it('copies a managed PDF into the configured Downloads folder', () => {
    const root = temporaryRoot()
    const workspace = join(root, 'assistant-workspace')
    const downloads = join(root, 'Downloads')
    const source = join(workspace, '.downloads', 'cover-letter.pdf')
    mkdirSync(join(workspace, '.downloads'), { recursive: true })
    writeFileSync(source, '%PDF-1.4 test')

    const exported = exportPdfArtifact(source, workspace, downloads, 'Candidate_Cover_Letter.pdf')

    expect(exported).toBe(join(downloads, 'Candidate_Cover_Letter.pdf'))
    expect(readFileSync(exported, 'utf8')).toBe('%PDF-1.4 test')
  })

  it('rejects files outside the assistant workspace and non-PDF outputs', () => {
    const root = temporaryRoot()
    const workspace = join(root, 'assistant-workspace')
    const outside = join(root, 'outside.pdf')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(outside, '%PDF-1.4 test')

    expect(() => exportPdfArtifact(outside, workspace, join(root, 'Downloads'))).toThrow('inside the Internship OS assistant workspace')
    expect(() => exportPdfArtifact(outside, workspace, join(root, 'Downloads'), 'not-a-pdf.txt')).toThrow()
  })
})

describe('ResumeManager', () => {
  it('detects missing packages and Babel language modules', () => {
    expect(detectRequiredTexFiles(`
      LaTeX Error: File \`fancyhdr.sty' not found.
      Package babel Error: Unknown option 'english'.
    `)).toEqual(['fancyhdr.sty', 'english.ldf'])
  })

  it('promotes successful PDFs regardless of page count and archives exact source', async () => {
    const root = temporaryRoot()
    const downloads = join(root, 'downloads')
    const defaultSource = join(root, 'default.tex')
    writeFileSync(defaultSource, onePageLatex('Original line'))
    const paths = new AppPaths(join(root, 'data'), downloads)
    const manager = new ResumeManager(paths, defaultSource)

    const first = await manager.compile()
    expect(first.lastCompile?.ok).toBe(true)
    expect(first.lastCompile?.pages).toBe(1)
    expect(existsSync(paths.internalPdf)).toBe(true)
    expect(existsSync(paths.publicPdf)).toBe(true)
    const promotedTwoPage = await manager.saveAndCompile(onePageLatex('Two pages', '\\newpage Second page'))
    expect(promotedTwoPage.lastCompile?.ok).toBe(true)
    expect(promotedTwoPage.lastCompile?.pages).toBe(2)
    expect(existsSync(paths.previewPdf('general-swe'))).toBe(true)
    expect(readFileSync(paths.internalPdf)).toEqual(readFileSync(paths.previewPdf('general-swe')))
    expect(readFileSync(paths.sourceFile('general-swe'), 'utf8')).toContain('Two pages')
    const twoPageArchive = manager.archiveForApplication(
      { company: 'Two Page Co', position: 'SWE Intern', status: 'Submitted', dateApplied: '2026-07-13', details: '' },
      'two-page-application'
    )
    expect(
      (await PDFDocument.load(readFileSync(join(twoPageArchive.archivePath, 'resume.pdf')))).getPageCount()
    ).toBe(2)
    expect(readFileSync(join(twoPageArchive.archivePath, 'source', 'main.tex'), 'utf8')).toContain('Two pages')

    const promoted = await manager.saveAndCompile(onePageLatex('Updated line'))
    expect(promoted.lastCompile?.ok).toBe(true)
    expect(promoted.lastChange).toMatchObject({ summary: '2 lines rewritten', addedLines: 2, removedLines: 2 })
    expect(promoted.lastChange?.diff).toContain('- Two pages')
    expect(promoted.lastChange?.diff).toContain('+ Updated line')
    expect(readFileSync(paths.sourceFile('general-swe'), 'utf8')).toContain('Updated line')

    const archive = manager.archiveForApplication(
      { company: 'Acme', position: 'SWE Intern', status: 'Submitted', dateApplied: '2026-07-13', details: '' },
      'application-1'
    )
    expect(existsSync(join(archive.archivePath, 'resume.pdf'))).toBe(true)
    expect(readFileSync(join(archive.archivePath, 'source', 'main.tex'), 'utf8')).toContain('Updated line')
    expect(JSON.parse(readFileSync(join(archive.archivePath, 'manifest.json'), 'utf8'))).toMatchObject({
      applicationId: 'application-1',
      company: 'Acme',
      position: 'SWE Intern',
      profileId: 'general-swe',
      profile: 'General SWE'
    })

    const backend = manager.selectProfile('backend')
    expect(backend.profileName).toBe('Backend')
    expect(backend.profiles).toHaveLength(5)
    expect(backend.source).toContain('Original line')
    expect(backend.hasPdf).toBe(false)

    const compiledBackend = await manager.saveAndCompile(onePageLatex('Backend line'))
    expect(compiledBackend.lastCompile?.ok).toBe(true)
    expect(readFileSync(paths.sourceFile('backend'), 'utf8')).toContain('Backend line')
    expect(readFileSync(paths.sourceFile('general-swe'), 'utf8')).toContain('Updated line')

    const restoredGeneral = manager.selectProfile('general-swe')
    expect(restoredGeneral.source).toContain('Updated line')
    expect(restoredGeneral.hasPdf).toBe(true)

    const amazonDraft = manager.createJobDraft('Amazon')
    expect(amazonDraft.jobDraft).toMatchObject({ exists: true, active: true, name: 'Amazon' })
    expect(amazonDraft.jobDraft.drafts).toHaveLength(1)
    const amazonDraftId = amazonDraft.jobDraft.id!
    const compiledDraft = await manager.saveAndCompile(onePageLatex('Amazon-specific line'))
    expect(compiledDraft.lastCompile?.ok).toBe(true)
    expect(readFileSync(paths.jobDraftSourceFile('general-swe', amazonDraftId), 'utf8')).toContain('Amazon-specific line')
    expect(readFileSync(paths.sourceFile('general-swe'), 'utf8')).toContain('Updated line')

    const draftArchive = manager.archiveForApplication(
      { company: 'Amazon', position: 'SWE Intern', status: 'Submitted', dateApplied: '2026-07-14', details: '' },
      'application-amazon'
    )
    expect(readFileSync(join(draftArchive.archivePath, 'source', 'main.tex'), 'utf8')).toContain('Amazon-specific line')
    expect(JSON.parse(readFileSync(join(draftArchive.archivePath, 'manifest.json'), 'utf8'))).toMatchObject({
      applicationId: 'application-amazon',
      jobDraft: { name: 'Amazon' }
    })

    const googleDraft = manager.createJobDraft('Google')
    expect(googleDraft.jobDraft.drafts).toHaveLength(2)
    expect(googleDraft.source).toContain('Updated line')
    expect(googleDraft.source).not.toContain('Amazon-specific line')

    const templateAgain = manager.selectJobDraft(null)
    expect(templateAgain.source).toContain('Updated line')
    expect(templateAgain.jobDraft).toMatchObject({ exists: true, active: false, id: null, name: null })
    expect(manager.selectJobDraft(amazonDraftId).source).toContain('Amazon-specific line')
    expect(manager.discardJobDraft(amazonDraftId).jobDraft).toMatchObject({ exists: true, active: false, id: null })
    expect(manager.discardJobDraft(googleDraft.jobDraft.id!).jobDraft).toMatchObject({ exists: false, active: false, id: null, name: null })
    expect(manager.getState().source).toContain('Updated line')

    const stripeDraft = manager.createJobDraft('Stripe', 'backend')
    expect(stripeDraft).toMatchObject({ activeProfileId: 'backend', profileName: 'Backend' })
    const restartedManager = new ResumeManager(paths, defaultSource)
    expect(restartedManager.getState()).toMatchObject({
      activeProfileId: 'backend',
      profileName: 'Backend',
      jobDraft: { exists: true, active: true, name: 'Stripe' }
    })

    const promotedStripe = await restartedManager.promoteActiveJobDraftToProfile(onePageLatex('Stripe becomes the main backend resume'))
    expect(promotedStripe).toMatchObject({
      activeProfileId: 'backend',
      profileName: 'Backend',
      jobDraft: { exists: false, active: false, id: null, name: null },
      lastCompile: { ok: true, pages: 1 }
    })
    expect(promotedStripe.source).toContain('Stripe becomes the main backend resume')
    expect(readFileSync(paths.sourceFile('backend'), 'utf8')).toContain('Stripe becomes the main backend resume')
    expect(readFileSync(paths.sourceFile('general-swe'), 'utf8')).toContain('Updated line')
    expect(existsSync(paths.jobDraftDir('backend', stripeDraft.jobDraft.id!))).toBe(false)
    expect(readFileSync(paths.profilePdf('backend'))).toEqual(readFileSync(paths.publicPdf))

    const undonePromotion = restartedManager.undo()
    expect(undonePromotion).toMatchObject({
      activeProfileId: 'backend',
      jobDraft: { exists: true, active: true, name: 'Stripe' }
    })
    expect(undonePromotion.source).toContain('Stripe becomes the main backend resume')
    expect(readFileSync(paths.sourceFile('backend'), 'utf8')).toContain('Backend line')
    expect(readFileSync(paths.jobDraftSourceFile('backend', stripeDraft.jobDraft.id!), 'utf8')).toContain('Stripe becomes the main backend resume')
    expect(restartedManager.selectJobDraft(null).source).toContain('Backend line')
  })

  it('migrates an existing single job draft into the multi-draft layout', () => {
    const root = temporaryRoot()
    const defaultSource = join(root, 'default.tex')
    writeFileSync(defaultSource, onePageLatex('Template line'))
    const paths = new AppPaths(join(root, 'data'), join(root, 'downloads'))
    const legacyDraftRoot = paths.jobDraftRoot('general-swe')
    mkdirSync(join(legacyDraftRoot, 'source'), { recursive: true })
    writeFileSync(join(legacyDraftRoot, 'source', 'main.tex'), onePageLatex('Legacy Amazon line'))
    writeFileSync(join(legacyDraftRoot, 'draft.json'), JSON.stringify({ name: 'Amazon', createdAt: '2026-07-14T12:00:00.000Z' }))
    mkdirSync(paths.resumeRoot, { recursive: true })
    writeFileSync(paths.activeProfileFile, JSON.stringify({ activeProfileId: 'general-swe', activeJobDraftProfiles: ['general-swe'] }))

    const state = new ResumeManager(paths, defaultSource).getState()
    expect(state.source).toContain('Legacy Amazon line')
    expect(state.jobDraft).toMatchObject({ exists: true, active: true, name: 'Amazon' })
    expect(state.jobDraft.drafts).toHaveLength(1)
    expect(existsSync(paths.jobDraftSourceFile('general-swe', state.jobDraft.id!))).toBe(true)
    expect(existsSync(join(legacyDraftRoot, 'source', 'main.tex'))).toBe(false)
  })
})

describe('chat image attachments', () => {
  const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

  it('validates and stores images inside the managed assistant workspace', () => {
    const root = temporaryRoot()
    const [stored] = persistAssistantImages(root, [{ id: 'preview-1', name: 'Screenshot.png', dataUrl: pngDataUrl }])

    expect(stored.name).toBe('Screenshot.png')
    expect(stored.mimeType).toBe('image/png')
    expect(stored.path).toContain(join(root, 'assistant-workspace', '.attachments'))
    expect(existsSync(stored.path)).toBe(true)
    expect(storedImagePreview(stored.path)).toMatchObject({
      id: expect.any(String),
      name: 'Screenshot',
      dataUrl: pngDataUrl
    })
  })

  it('rejects spoofed formats and excessive attachment counts', () => {
    const root = temporaryRoot()
    expect(() => persistAssistantImages(root, [{
      id: 'spoofed',
      name: 'not-really-a-jpeg.jpg',
      dataUrl: pngDataUrl.replace('image/png', 'image/jpeg')
    }])).toThrow('not a supported')
    expect(() => persistAssistantImages(root, Array.from({ length: MAX_CHAT_IMAGES + 1 }, (_, index) => ({
      id: String(index),
      name: `${index}.png`,
      dataUrl: pngDataUrl
    })))).toThrow(`up to ${MAX_CHAT_IMAGES}`)
  })
})

describe('first-run setup', () => {
  it('backs up and migrates legacy user data without overwriting canonical data', () => {
    const root = temporaryRoot()
    const legacy = join(root, 'internship-application-os')
    const canonical = join(root, 'Internship OS')
    mkdirSync(join(legacy, 'resumes', 'profiles', 'general-swe'), { recursive: true })
    mkdirSync(join(legacy, 'archives', 'application-1'), { recursive: true })
    writeFileSync(join(legacy, 'internship-os.sqlite3'), 'legacy tracker')
    writeFileSync(join(legacy, 'resumes', 'profiles', 'general-swe', 'main.tex'), 'legacy resume')
    writeFileSync(join(legacy, 'archives', 'application-1', 'resume.pdf'), 'legacy archive')

    migrateSplitLegacyData(canonical, legacy)

    expect(readFileSync(join(canonical, 'internship-os.sqlite3'), 'utf8')).toBe('legacy tracker')
    expect(readFileSync(join(canonical, 'resumes', 'profiles', 'general-swe', 'main.tex'), 'utf8')).toBe('legacy resume')
    expect(readFileSync(join(canonical, 'archives', 'application-1', 'resume.pdf'), 'utf8')).toBe('legacy archive')
    expect(readFileSync(join(canonical, 'migration-backups', 'split-root-v1', 'internship-os.sqlite3'), 'utf8')).toBe('legacy tracker')
    expect(JSON.parse(readFileSync(join(canonical, 'migration-backups', 'split-root-v1', 'migration.json'), 'utf8'))).toMatchObject({
      version: 1,
      source: legacy,
      completed: true
    })
    expect(readFileSync(join(legacy, 'internship-os.sqlite3'), 'utf8')).toBe('legacy tracker')

    writeFileSync(join(legacy, 'internship-os.sqlite3'), 'changed legacy tracker')
    migrateSplitLegacyData(canonical, legacy)
    expect(readFileSync(join(canonical, 'internship-os.sqlite3'), 'utf8')).toBe('legacy tracker')
  })

  it('does not mix legacy data into a canonical profile that already has user data', () => {
    const root = temporaryRoot()
    const legacy = join(root, 'internship-application-os')
    const canonical = join(root, 'Internship OS')
    mkdirSync(join(legacy, 'resumes'), { recursive: true })
    mkdirSync(join(canonical, 'resumes'), { recursive: true })
    writeFileSync(join(legacy, 'internship-os.sqlite3'), 'legacy tracker')
    writeFileSync(join(legacy, 'resumes', 'legacy.tex'), 'legacy resume')
    writeFileSync(join(canonical, 'internship-os.sqlite3'), 'current tracker')
    writeFileSync(join(canonical, 'resumes', 'current.tex'), 'current resume')

    migrateSplitLegacyData(canonical, legacy)

    expect(readFileSync(join(canonical, 'internship-os.sqlite3'), 'utf8')).toBe('current tracker')
    expect(readFileSync(join(canonical, 'resumes', 'current.tex'), 'utf8')).toBe('current resume')
    expect(existsSync(join(canonical, 'resumes', 'legacy.tex'))).toBe(false)
    expect(existsSync(join(canonical, 'migration-backups'))).toBe(false)
  })

  it('persists generic settings and creates provider instructions without personal defaults', () => {
    const root = temporaryRoot()
    const settings = new SettingsStore(root)
    expect(settings.get().onboardingComplete).toBe(false)

    const saved = settings.complete({
      identity: { fullName: 'Test Candidate', email: 'test@example.com', phone: '', portfolio: '', github: '', linkedin: '' },
      exportFilename: '',
      resumeProfiles: [{ id: 'quant', name: 'Quant', focus: 'Algorithms and data' }],
      assistantProvider: 'claude',
      editMode: 'review'
    })
    expect(saved).toMatchObject({
      onboardingComplete: true,
      exportFilename: 'Test_Candidate_Resume.pdf',
      assistantProvider: 'claude',
      codexModel: 'gpt-5.6-luna',
      codexReasoningEffort: 'low'
    })
    expect(settings.updateCodexSettings('gpt-5.6-sol', 'high')).toMatchObject({
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'high'
    })

    const workspace = join(root, 'assistant-workspace')
    const runtime = {
      electronPath: '/Applications/Internship OS.app/Contents/MacOS/Internship OS',
      cliPath: '/app/cli.js',
      appRoot: root,
      downloadsRoot: join(root, 'downloads'),
      publicDownloadsRoot: join(root, 'public-downloads'),
      defaultResumePath: '/app/main.tex',
      skillsSourcePath: join(process.cwd(), 'resources', 'resume-skills'),
      assistantToolsSourcePath: join(process.cwd(), 'resources', 'assistant-tools')
    }
    const wrapper = writeAssistantWorkspace(workspace, saved.resumeProfiles, runtime)
    expect(existsSync(wrapper)).toBe(true)
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const instructions = readFileSync(join(workspace, name), 'utf8')
      expect(instructions).toContain('`quant` — Quant')
      expect(instructions).toContain('## Personal context and writing authority')
      expect(instructions).toContain('## Runtime workflow')
      expect(instructions).toContain('## App diagnostics')
      expect(instructions).toContain("wait for the user's explicit approval")
      expect(instructions).toContain('application tracker record is pre-authorized')
      expect(instructions).toContain('without asking for separate approval')
      expect(instructions).toContain('active experience bank')
      expect(instructions).toContain('do not resurrect it')
      expect(instructions).toContain('do not blend them')
      expect(instructions).toContain('available, not mandatory')
      expect(instructions).toContain('Do not repeatedly default to the same older')
      expect(instructions).toContain('Candidate experience-bank maintenance')
      expect(instructions).toContain('primary authority for resume wording, structure, and content strategy')
      expect(instructions).toContain('New tracker records default to `Submitted` with the current local date')
      expect(instructions).toContain('artifact export-pdf')
      expect(instructions).toContain('Final cover letters')
      expect(instructions).toContain('application add --company "Company" --position "Position" --details "Notes"')
      expect(instructions).not.toContain('application add --company "Company" --position "Position" --status "In Progress"')
      expect(instructions).not.toContain('Do not invent candidate facts')
      expect(instructions).not.toContain('truthfulness')
      expect(instructions).not.toContain('application-ready resume until the user confirms')
      expect(instructions).not.toContain('action + system + concrete mechanisms + outcome')
      expect(instructions).not.toContain('## Resume positioning and technical language')
      expect(instructions).not.toContain('technically dense')
      expect(instructions).not.toContain('Neel')
    }

    const agentsPath = join(workspace, 'AGENTS.md')
    writeFileSync(agentsPath, `${readFileSync(agentsPath, 'utf8')}\n## Local custom rule\n- Preserve this backup.\n`)
    writeAssistantWorkspace(workspace, saved.resumeProfiles, runtime)

    const backups = readdirSync(join(workspace, 'instruction-backups'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(workspace, 'instruction-backups', backups[0], 'AGENTS.md'), 'utf8')).toContain('Preserve this backup.')
    expect(readFileSync(agentsPath, 'utf8')).toContain('## Runtime workflow')
    expect(readFileSync(join(workspace, 'CLAUDE.md'), 'utf8')).toBe(readFileSync(agentsPath, 'utf8'))

    const managedSkills = JSON.parse(readFileSync(join(workspace, '.internship-os-skills.json'), 'utf8')) as {
      commit: string
      skillFilesUnmodified: boolean
      skillFileSha256: Record<string, string>
      included: string[]
      excluded: string[]
    }
    expect(managedSkills.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(managedSkills.skillFilesUnmodified).toBe(true)
    expect(Object.keys(managedSkills.skillFileSha256)).toHaveLength(18)
    expect(managedSkills.included).toHaveLength(18)
    expect(managedSkills.excluded).toEqual([
      'resume-version-manager',
      'salary-negotiation-prep',
      'offer-comparison-analyzer',
      'cold-email-writer'
    ])
    for (const providerRoot of ['.agents', '.claude']) {
      const installedSkill = readFileSync(join(workspace, providerRoot, 'skills', 'resume-tailor', 'SKILL.md'), 'utf8')
      const vendoredSkill = readFileSync(join(runtime.skillsSourcePath, 'skills', 'resume-tailor', 'SKILL.md'), 'utf8')
      expect(installedSkill).toBe(vendoredSkill)
      expect(installedSkill).not.toContain('## Internship OS integration')
      expect(existsSync(join(workspace, providerRoot, 'skills', 'resume-version-manager'))).toBe(false)
    }

    mkdirSync(join(workspace, '.agents', 'skills', 'local-custom'), { recursive: true })
    writeFileSync(join(workspace, '.agents', 'skills', 'local-custom', 'SKILL.md'), 'custom')
    writeAssistantWorkspace(workspace, saved.resumeProfiles, runtime)
    expect(readFileSync(join(workspace, '.agents', 'skills', 'local-custom', 'SKILL.md'), 'utf8')).toBe('custom')
    expect(readFileSync(wrapper, 'utf8')).toContain("grep -Fv 'task_name_for_pid: (os/kern) failure (5)'")
    expect(readFileSync(wrapper, 'utf8')).toContain(join(root, 'downloads'))
    expect(readFileSync(join(workspace, 'bin', 'resume-update-all.py'), 'utf8')).toContain('discover_profiles')
  })

  it('supports custom profile IDs without requiring general-swe', () => {
    const root = temporaryRoot()
    const defaultSource = join(root, 'default.tex')
    writeFileSync(defaultSource, onePageLatex('Custom template'))
    const manager = new ResumeManager(
      new AppPaths(join(root, 'data'), join(root, 'downloads')),
      defaultSource,
      [{ id: 'research', name: 'Research', focus: 'Research engineering' }]
    )
    expect(manager.getState()).toMatchObject({ activeProfileId: 'research', profileName: 'Research' })
  })

  it('updates settings sections without changing candidate experience', () => {
    const original = createCandidateProfile(
      { fullName: 'First Name', email: 'first@example.com', phone: '', portfolio: '', github: '', linkedin: '' },
      [{ id: 'general-swe', name: 'General SWE', focus: 'Balanced software engineering' }]
    ).replace(
      '- Add roles, responsibilities, accomplishments, outcomes, and technologies here.',
      '- Built a project with TypeScript.\n- Prefers backend internships.'
    )

    const updated = updateCandidateProfile(
      original,
      { fullName: 'Updated Name', email: 'updated@example.com', phone: '555-0100', portfolio: 'example.dev', github: 'github.com/example', linkedin: 'linkedin.com/in/example' },
      [
        { id: 'quant', name: 'Quant', focus: 'Algorithms and reliability' },
        { id: 'security', name: 'Security', focus: 'Security engineering' }
      ]
    )

    expect(updated).toContain('# Updated Name — Candidate Experience Bank')
    expect(updated).toContain('- Email: updated@example.com')
    expect(updated).toContain('- Quant: Algorithms and reliability')
    expect(updated).toContain('- Security: Security engineering')
    expect(updated).toContain('- Built a project with TypeScript.')
    expect(updated).toContain('- Prefers backend internships.')
    expect(updated).not.toContain('first@example.com')
    expect(updateCandidateProfile(updated, {
      fullName: 'Updated Name',
      email: 'updated@example.com',
      phone: '555-0100',
      portfolio: 'example.dev',
      github: 'github.com/example',
      linkedin: 'linkedin.com/in/example'
    }, [
      { id: 'quant', name: 'Quant', focus: 'Algorithms and reliability' },
      { id: 'security', name: 'Security', focus: 'Security engineering' }
    ])).toBe(updated)
  })

  it('backs up and upgrades a legacy candidate profile without losing user-authored sections', () => {
    const root = temporaryRoot()
    const legacy = `# First Name — Durable Candidate Profile

This profile is the source of verified candidate facts. Never infer anything.

## Identity and links

- Name: First Name
- Email: first@example.com

## Resume profiles

- General SWE: Balanced software engineering

## Experience

- DraftKings CMS used Python.

## Projects

- Built a project with TypeScript.
`
    writeFileSync(join(root, 'candidate-profile.md'), legacy)

    const profilePath = ensureCandidateExperienceBank(
      root,
      { fullName: 'Updated Name', email: 'updated@example.com', phone: '', portfolio: '', github: '', linkedin: '' },
      [{ id: 'backend', name: 'Backend', focus: 'Backend systems' }]
    )
    const migrated = readFileSync(profilePath, 'utf8')

    expect(migrated).toContain('# Updated Name — Candidate Experience Bank')
    expect(migrated).toContain('active experience bank')
    expect(migrated).toContain('A correction replaces conflicting details')
    expect(migrated).toContain('- DraftKings CMS used Python.')
    expect(migrated).toContain('- Built a project with TypeScript.')
    expect(migrated).not.toContain('source of verified candidate facts')
    expect(readFileSync(join(root, 'migration-backups', 'candidate-experience-bank-v1', 'candidate-profile.md'), 'utf8')).toBe(legacy)

    ensureCandidateExperienceBank(
      root,
      { fullName: 'Updated Name', email: 'updated@example.com', phone: '', portfolio: '', github: '', linkedin: '' },
      [{ id: 'backend', name: 'Backend', focus: 'Backend systems' }]
    )
    expect(readFileSync(profilePath, 'utf8')).toBe(migrated)
  })
})

function temporaryRoot(): string {
  const root = join(tmpdir(), `internship-os-test-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  temporaryRoots.push(root)
  return root
}

function onePageLatex(line: string, suffix = ''): string {
  return `\\documentclass[11pt]{article}
\\begin{document}
${line}
${suffix}
\\end{document}
`
}
