import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApplicationStore } from './database'
import { AppPaths } from './paths'
import { detectRequiredTexFiles, ResumeManager } from './resume'
import { SettingsStore } from './settings'
import { writeAssistantWorkspace } from './instructions'
import { createCandidateProfile, updateCandidateProfile } from './templates'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ApplicationStore', () => {
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

describe('ResumeManager', () => {
  it('detects missing packages and Babel language modules', () => {
    expect(detectRequiredTexFiles(`
      LaTeX Error: File \`fancyhdr.sty' not found.
      Package babel Error: Unknown option 'english'.
    `)).toEqual(['fancyhdr.sty', 'english.ldf'])
  })

  it('promotes only a successful one-page PDF and archives exact source', async () => {
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
    const lastGoodPdf = readFileSync(paths.internalPdf)

    const rejected = await manager.saveAndCompile(onePageLatex('Two pages', '\\newpage Second page'))
    expect(rejected.lastCompile?.ok).toBe(false)
    expect(rejected.lastCompile?.pages).toBe(2)
    expect(existsSync(paths.previewPdf('general-swe'))).toBe(true)
    expect(readFileSync(paths.previewPdf('general-swe'))).not.toEqual(lastGoodPdf)
    expect(readFileSync(paths.internalPdf)).toEqual(lastGoodPdf)
    expect(readFileSync(paths.sourceFile('general-swe'), 'utf8')).toContain('Original line')

    const promoted = await manager.saveAndCompile(onePageLatex('Updated line'))
    expect(promoted.lastCompile?.ok).toBe(true)
    expect(promoted.lastChange).toMatchObject({ summary: '1 line rewritten', addedLines: 1, removedLines: 1 })
    expect(promoted.lastChange?.diff).toContain('- Original line')
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

describe('first-run setup', () => {
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
    expect(saved).toMatchObject({ onboardingComplete: true, exportFilename: 'Test_Candidate_Resume.pdf', assistantProvider: 'claude' })

    const workspace = join(root, 'assistant-workspace')
    const wrapper = writeAssistantWorkspace(workspace, saved.resumeProfiles, {
      electronPath: '/Applications/Internship OS.app/Contents/MacOS/Internship OS',
      cliPath: '/app/cli.js',
      appRoot: root,
      downloadsRoot: join(root, 'downloads'),
      defaultResumePath: '/app/main.tex'
    })
    expect(existsSync(wrapper)).toBe(true)
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toContain('`quant` — Quant')
    expect(readFileSync(join(workspace, 'CLAUDE.md'), 'utf8')).toContain('Never invent experience')
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).not.toContain('Neel')
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

  it('updates settings sections without changing verified candidate facts', () => {
    const original = createCandidateProfile(
      { fullName: 'First Name', email: 'first@example.com', phone: '', portfolio: '', github: '', linkedin: '' },
      [{ id: 'general-swe', name: 'General SWE', focus: 'Balanced software engineering' }]
    ).replace(
      '- Add verified education, experience, project, skill, preference, and constraint facts here.',
      '- Built a verified project with TypeScript.\n- Prefers backend internships.'
    )

    const updated = updateCandidateProfile(
      original,
      { fullName: 'Updated Name', email: 'updated@example.com', phone: '555-0100', portfolio: 'example.dev', github: 'github.com/example', linkedin: 'linkedin.com/in/example' },
      [
        { id: 'quant', name: 'Quant', focus: 'Algorithms and reliability' },
        { id: 'security', name: 'Security', focus: 'Security engineering' }
      ]
    )

    expect(updated).toContain('# Updated Name — Durable Candidate Profile')
    expect(updated).toContain('- Email: updated@example.com')
    expect(updated).toContain('- Quant: Algorithms and reliability')
    expect(updated).toContain('- Security: Security engineering')
    expect(updated).toContain('- Built a verified project with TypeScript.')
    expect(updated).toContain('- Prefers backend internships.')
    expect(updated).not.toContain('first@example.com')
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
