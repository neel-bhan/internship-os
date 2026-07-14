import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApplicationStore } from './database'
import { AppPaths } from './paths'
import { ResumeManager } from './resume'

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
    expect(amazonDraft.jobDraft).toEqual({ exists: true, active: true, name: 'Amazon' })
    const compiledDraft = await manager.saveAndCompile(onePageLatex('Amazon-specific line'))
    expect(compiledDraft.lastCompile?.ok).toBe(true)
    expect(readFileSync(paths.jobDraftSourceFile('general-swe'), 'utf8')).toContain('Amazon-specific line')
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

    const templateAgain = manager.setJobDraftActive(false)
    expect(templateAgain.source).toContain('Updated line')
    expect(templateAgain.jobDraft).toEqual({ exists: true, active: false, name: 'Amazon' })
    expect(manager.setJobDraftActive(true).source).toContain('Amazon-specific line')
    expect(manager.discardJobDraft().jobDraft).toEqual({ exists: false, active: false, name: null })
    expect(manager.getState().source).toContain('Updated line')

    manager.selectProfile('backend')
    manager.createJobDraft('Stripe')
    const restartedManager = new ResumeManager(paths, defaultSource)
    expect(restartedManager.getState()).toMatchObject({
      activeProfileId: 'backend',
      profileName: 'Backend',
      jobDraft: { exists: true, active: true, name: 'Stripe' }
    })
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
