import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { PDFDocument } from 'pdf-lib'
import {
  DEFAULT_RESUME_PROFILES,
  type ApplicationInput,
  type CompileResult,
  type ResumeChangeReview,
  type ResumeJobDraft,
  type ResumeProfile,
  type ResumeState
} from '../../shared/types'
import { AppPaths } from './paths'

interface CompilerRun {
  ok: boolean
  compiler: string
  output: string
  pdfPath: string
}

interface DiffOperation {
  type: 'unchanged' | 'added' | 'removed'
  text: string
  oldLine?: number
  newLine?: number
}

export class ResumeManager {
  private activeProfileId: string
  private activeJobDraftIds = new Map<string, string>()
  private initialized = false

  constructor(
    readonly paths: AppPaths,
    private readonly defaultSourcePath: string,
    private readonly profiles: ResumeProfile[] = DEFAULT_RESUME_PROFILES
  ) {
    if (profiles.length === 0) throw new Error('At least one resume profile is required.')
    this.activeProfileId = profiles[0].id
  }

  initialize(): void {
    if (this.initialized) return

    mkdirSync(this.paths.profilesDir, { recursive: true })
    mkdirSync(dirname(this.paths.internalPdf), { recursive: true })
    mkdirSync(dirname(this.paths.publicPdf), { recursive: true })
    mkdirSync(this.paths.archivesDir, { recursive: true })

    const baseProfile = this.profiles[0]
    const baseSource = this.paths.sourceFile(baseProfile.id)
    mkdirSync(this.paths.profileDir(baseProfile.id), { recursive: true })
    if (!existsSync(baseSource)) {
      if (!existsSync(this.defaultSourcePath)) {
        throw new Error(`Default resume source not found: ${this.defaultSourcePath}`)
      }
      cpSync(this.defaultSourcePath, baseSource)
    }

    for (const profile of this.profiles) {
      const profileDir = this.paths.profileDir(profile.id)
      if (!existsSync(profileDir)) cpSync(this.paths.profileDir(baseProfile.id), profileDir, { recursive: true })
      if (!existsSync(this.paths.sourceFile(profile.id))) cpSync(baseSource, this.paths.sourceFile(profile.id))
      mkdirSync(this.paths.historyDir(profile.id), { recursive: true })
      mkdirSync(this.paths.compileHistoryDir(profile.id), { recursive: true })
      mkdirSync(this.paths.candidatesDir(profile.id), { recursive: true })
      mkdirSync(dirname(this.paths.profilePdf(profile.id)), { recursive: true })
      mkdirSync(dirname(this.paths.previewPdf(profile.id)), { recursive: true })
      this.migrateSingleJobDraft(profile.id)
      for (const draft of this.listJobDrafts(profile.id)) this.ensureJobDraftDirectories(profile.id, draft.id)
    }

    this.migrateLegacyGeneralProfile()
    this.activeProfileId = this.readActiveProfileId()
    this.activeJobDraftIds = this.readActiveJobDraftIds()
    this.writeActiveProfileId()
    this.syncPublishedPdf()
    this.initialized = true
  }

  getState(lastCompile?: CompileResult | null): ResumeState {
    this.initialize()
    const profile = this.activeProfile()
    const sourceFile = this.activeSourceFile()
    const profilePdf = this.activeProfilePdf()
    const previewPdf = this.activePreviewPdf()
    const hasPdf = existsSync(profilePdf)
    const visiblePdf = existsSync(previewPdf) ? previewPdf : profilePdf
    const drafts = this.listJobDrafts(this.activeProfileId)
    const activeDraftId = this.activeJobDraftId()
    const activeDraft = drafts.find((draft) => draft.id === activeDraftId) ?? null
    return {
      source: readFileSync(sourceFile, 'utf8'),
      sourcePath: sourceFile,
      pdfPath: this.paths.publicPdf,
      pdfRevision: existsSync(visiblePdf) ? String(statSync(visiblePdf).mtimeMs) : null,
      hasPdf,
      activeProfileId: profile.id,
      profileName: profile.name,
      profiles: this.profiles.map((item) => ({ ...item })),
      jobDraft: {
        exists: drafts.length > 0,
        active: Boolean(activeDraft),
        id: activeDraft?.id ?? null,
        name: activeDraft?.name ?? null,
        drafts
      },
      lastCompile: lastCompile ?? this.readLastCompile(),
      lastChange: this.readLastChange()
    }
  }

  listProfiles(): ResumeProfile[] {
    return this.profiles.map((profile) => ({ ...profile }))
  }

  getPreviewPdfPath(): string {
    this.initialize()
    const previewPdf = this.activePreviewPdf()
    return existsSync(previewPdf) ? previewPdf : this.activeProfilePdf()
  }

  selectProfile(profileId: string): ResumeState {
    this.initialize()
    const profile = this.profiles.find((item) => item.id === profileId)
    if (!profile) throw new Error(`Unknown resume profile: ${profileId}`)
    this.activeProfileId = profile.id
    this.writeActiveProfileId()
    this.syncPublishedPdf()
    return this.getState()
  }

  createJobDraft(name: string, profileId = this.activeProfileId): ResumeState {
    this.initialize()
    const trimmedName = name.trim()
    if (!trimmedName) throw new Error('Enter a company or job name for this draft.')
    if (trimmedName.length > 80) throw new Error('Job draft names must be 80 characters or fewer.')
    if (!this.profiles.some((profile) => profile.id === profileId)) throw new Error(`Unknown resume profile: ${profileId}`)

    this.activeProfileId = profileId

    const draftId = randomUUID()

    cpSync(this.paths.profileDir(this.activeProfileId), this.paths.jobDraftSourceDir(this.activeProfileId, draftId), { recursive: true })
    this.ensureJobDraftDirectories(this.activeProfileId, draftId)
    this.atomicWrite(
      this.paths.jobDraftMetadata(this.activeProfileId, draftId),
      JSON.stringify({ id: draftId, name: trimmedName, createdAt: new Date().toISOString() }, null, 2)
    )

    const templatePdf = this.paths.profilePdf(this.activeProfileId)
    if (existsSync(templatePdf)) {
      this.atomicCopy(templatePdf, this.paths.jobDraftPdf(this.activeProfileId, draftId))
      this.atomicCopy(templatePdf, this.paths.jobDraftPreviewPdf(this.activeProfileId, draftId))
    }

    this.activeJobDraftIds.set(this.activeProfileId, draftId)
    this.writeActiveProfileId()
    this.syncPublishedPdf()
    return this.getState()
  }

  selectJobDraft(draftId: string | null): ResumeState {
    this.initialize()
    if (draftId && !this.listJobDrafts(this.activeProfileId).some((draft) => draft.id === draftId)) {
      throw new Error('That job draft no longer exists.')
    }
    if (draftId) this.activeJobDraftIds.set(this.activeProfileId, draftId)
    else this.activeJobDraftIds.delete(this.activeProfileId)
    this.writeActiveProfileId()
    this.syncPublishedPdf()
    return this.getState()
  }

  discardJobDraft(draftId: string): ResumeState {
    this.initialize()
    if (!this.listJobDrafts(this.activeProfileId).some((draft) => draft.id === draftId)) {
      throw new Error('That job draft no longer exists.')
    }
    if (this.activeJobDraftId() === draftId) this.activeJobDraftIds.delete(this.activeProfileId)
    rmSync(this.paths.jobDraftDir(this.activeProfileId, draftId), { recursive: true, force: true })
    this.writeActiveProfileId()
    this.syncPublishedPdf()
    return this.getState()
  }

  async promoteActiveJobDraftToProfile(source?: string): Promise<ResumeState> {
    this.initialize()
    const draftId = this.activeJobDraftId()
    if (!draftId) throw new Error('Open a job draft before making it the main resume.')
    const draft = this.listJobDrafts(this.activeProfileId).find((item) => item.id === draftId)
    if (!draft) throw new Error('That job draft no longer exists.')

    const draftSource = source ?? readFileSync(this.paths.jobDraftSourceFile(this.activeProfileId, draftId), 'utf8')
    const compiledDraft = await this.saveAndCompile(draftSource)
    if (!compiledDraft.lastCompile?.ok) return compiledDraft

    const profileId = this.activeProfileId
    const oldMainSource = readFileSync(this.paths.sourceFile(profileId), 'utf8')
    const promotedSource = readFileSync(this.paths.jobDraftSourceFile(profileId, draftId), 'utf8')
    const draftPdf = this.paths.jobDraftPdf(profileId, draftId)
    if (!existsSync(draftPdf)) throw new Error('The draft compiled without a reusable PDF.')

    const snapshotDir = this.createProfilePromotionSnapshot(profileId, draftId)
    const promotionResult: CompileResult = {
      ...compiledDraft.lastCompile,
      message: `${draft.name} is now the ${this.activeProfile().name} main resume.`
    }

    try {
      this.replaceDirectory(this.paths.jobDraftSourceDir(profileId, draftId), this.paths.profileDir(profileId))
      this.atomicCopy(draftPdf, this.paths.profilePdf(profileId))
      this.atomicCopy(draftPdf, this.paths.previewPdf(profileId))

      this.activeJobDraftIds.delete(profileId)
      this.writeActiveProfileId()
      this.recordChangeReview(this.createChangeReview(oldMainSource, promotedSource, promotionResult.compiledAt))
      this.recordCompile(promotionResult, `Promoted job draft "${draft.name}" (${draftId}) to profile ${profileId}.`)

      rmSync(this.paths.jobDraftDir(profileId, draftId), { recursive: true, force: true })
      this.syncPublishedPdf()
      return this.getState(promotionResult)
    } catch (error) {
      this.restoreProfilePromotionSnapshot(profileId, draftId, snapshotDir)
      rmSync(snapshotDir, { recursive: true, force: true })
      throw error
    }
  }

  async compile(): Promise<ResumeState> {
    this.initialize()
    return this.compileCandidate(readFileSync(this.activeSourceFile(), 'utf8'), false)
  }

  async saveAndCompile(source: string): Promise<ResumeState> {
    this.initialize()
    if (!source.trim()) throw new Error('Resume source cannot be empty.')
    return this.compileCandidate(source, source !== readFileSync(this.activeSourceFile(), 'utf8'))
  }

  prepareCandidate(): string {
    this.initialize()
    const candidate = join(this.activeCandidatesDir(), `candidate-${Date.now()}-${randomUUID().slice(0, 8)}.tex`)
    cpSync(this.activeSourceFile(), candidate)
    return candidate
  }

  async compileCandidateFile(candidatePath: string): Promise<ResumeState> {
    const resolved = statSync(candidatePath).isFile() ? candidatePath : join(candidatePath, 'main.tex')
    const state = await this.saveAndCompile(readFileSync(resolved, 'utf8'))
    if (state.lastCompile?.ok && resolved.startsWith(`${this.activeCandidatesDir()}/`)) rmSync(resolved, { force: true })
    return state
  }

  undo(): ResumeState {
    this.initialize()
    const historyDir = this.activeHistoryDir()
    const snapshots = readdirSync(historyDir)
      .filter((name) => !name.startsWith('undone-'))
      .sort()
      .reverse()

    const latest = snapshots[0]
    if (!latest) throw new Error('Nothing to undo.')
    const snapshotDir = join(historyDir, latest)
    const oldSource = join(snapshotDir, 'main.tex')
    const oldPdf = join(snapshotDir, 'current.pdf')
    const promotionMetadata = join(snapshotDir, 'promotion.json')
    if (!existsSync(oldSource)) throw new Error('Undo snapshot is incomplete.')

    const snapshotSource = join(snapshotDir, 'source')
    if (existsSync(snapshotSource)) this.replaceDirectory(snapshotSource, this.activeProfileDir())
    else this.atomicCopy(oldSource, this.activeSourceFile())
    if (existsSync(oldPdf)) {
      this.atomicCopy(oldPdf, this.activeProfilePdf())
      this.atomicCopy(oldPdf, this.activePreviewPdf())
      this.atomicCopy(oldPdf, this.paths.internalPdf)
      this.atomicCopy(oldPdf, this.paths.publicPdf)
    } else if (existsSync(promotionMetadata)) {
      rmSync(this.activeProfilePdf(), { force: true })
      rmSync(this.activePreviewPdf(), { force: true })
    }
    this.atomicWrite(this.activeChangeReviewFile(), 'null')

    if (existsSync(promotionMetadata)) {
      const promotion = JSON.parse(readFileSync(promotionMetadata, 'utf8')) as { draftId?: string }
      const archivedDraft = join(snapshotDir, 'promoted-draft')
      if (promotion.draftId && existsSync(archivedDraft)) {
        const restoredDraft = this.paths.jobDraftDir(this.activeProfileId, promotion.draftId)
        if (!existsSync(restoredDraft)) cpSync(archivedDraft, restoredDraft, { recursive: true })
        this.activeJobDraftIds.set(this.activeProfileId, promotion.draftId)
        this.writeActiveProfileId()
      }
    }
    renameSync(snapshotDir, join(historyDir, `undone-${latest}`))
    this.syncPublishedPdf()
    return this.getState()
  }

  archiveManual(): string {
    return this.createArchive({ company: 'Manual', position: 'Resume snapshot' }, `manual-${randomUUID()}`)
      .archivePath
  }

  archiveForApplication(input: ApplicationInput, applicationId: string): { id: string; archivePath: string; createdAt: string } {
    return this.createArchive(input, applicationId)
  }

  private async compileCandidate(source: string, sourceChanged: boolean): Promise<ResumeState> {
    this.initialize()
    const previousSource = readFileSync(this.activeSourceFile(), 'utf8')
    const workRoot = join(tmpdir(), `internship-os-${randomUUID()}`)
    const sourceDir = join(workRoot, 'source')
    const buildDir = join(workRoot, 'build')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(buildDir, { recursive: true })
    cpSync(this.activeProfileDir(), sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'main.tex'), source)

    let result: CompileResult
    try {
      const run = await this.runCompiler(sourceDir, buildDir)
      if (!run.ok) {
        result = {
          ok: false,
          compiler: run.compiler,
          message: 'Compilation failed. The last good PDF was preserved.',
          errors: this.parseCompilerErrors(run.output),
          compiledAt: new Date().toISOString()
        }
        this.recordCompile(result, run.output)
        return this.getState(result)
      }

      const bytes = readFileSync(run.pdfPath)
      const pdf = await PDFDocument.load(bytes)
      const pages = pdf.getPageCount()
      this.atomicCopy(run.pdfPath, this.activePreviewPdf())

      if (sourceChanged) this.createUndoSnapshot()
      if (sourceChanged) this.atomicWrite(this.activeSourceFile(), source)
      this.atomicCopy(run.pdfPath, this.activeProfilePdf())
      this.atomicCopy(run.pdfPath, this.paths.internalPdf)
      this.atomicCopy(run.pdfPath, this.paths.publicPdf)

      result = {
        ok: true,
        pages,
        compiler: run.compiler,
        message: `Compiled successfully with ${run.compiler} (${pages} page${pages === 1 ? '' : 's'}).`,
        errors: [],
        compiledAt: new Date().toISOString()
      }
      if (sourceChanged) this.recordChangeReview(this.createChangeReview(previousSource, source, result.compiledAt))
      this.recordCompile(result, run.output)
      return this.getState(result)
    } finally {
      rmSync(workRoot, { recursive: true, force: true })
    }
  }

  private async runCompiler(sourceDir: string, buildDir: string): Promise<CompilerRun> {
    const localTexBin = process.env.INTERNSHIP_OS_TEX_BIN ?? join(dirname(this.defaultSourcePath), '.tools', 'tinytex', 'TinyTeX', 'bin', 'universal-darwin')
    const latexmk = this.findExecutable('latexmk', [join(localTexBin, 'latexmk'), '/Library/TeX/texbin/latexmk'])
    const pdflatex = this.findExecutable('pdflatex', [join(localTexBin, 'pdflatex'), '/Library/TeX/texbin/pdflatex'])

    if (!latexmk && !pdflatex) {
      return {
        ok: false,
        compiler: 'none',
        output: 'No LaTeX compiler found. Run `npm run setup` or install latexmk/pdflatex.',
        pdfPath: join(buildDir, 'main.pdf')
      }
    }

    if (latexmk) {
      const args = ['-pdf', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-outdir=${buildDir}`, 'main.tex']
      let output = await this.runProcess(latexmk, args, sourceDir)
      for (let attempt = 0; output.code !== 0 && attempt < 8; attempt += 1) {
        const installed = await this.installMissingLocalPackages(output.text, dirname(latexmk), sourceDir)
        if (!installed) break
        output = await this.runProcess(latexmk, args, sourceDir)
      }
      return {
        ok: output.code === 0 && existsSync(join(buildDir, 'main.pdf')),
        compiler: 'latexmk',
        output: output.text,
        pdfPath: join(buildDir, 'main.pdf')
      }
    }

    const args = ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-output-directory=${buildDir}`, 'main.tex']
    const first = await this.runProcess(pdflatex!, args, sourceDir)
    let text = first.text
    let code = first.code
    if (first.code === 0) {
      const second = await this.runProcess(pdflatex!, args, sourceDir)
      text += `\n${second.text}`
      code = second.code
    }
    return {
      ok: code === 0 && existsSync(join(buildDir, 'main.pdf')),
      compiler: 'pdflatex',
      output: text,
      pdfPath: join(buildDir, 'main.pdf')
    }
  }

  private async installMissingLocalPackages(output: string, compilerDirectory: string, cwd: string): Promise<boolean> {
    const tlmgr = join(compilerDirectory, 'tlmgr')
    if (!compilerDirectory.includes(`${join('.tools', 'tinytex')}`) || !existsSync(tlmgr)) return false

    const missingFiles = detectRequiredTexFiles(output)
    if (missingFiles.length === 0) return false

    let installed = false
    for (const file of missingFiles) {
      const search = await this.runProcess(tlmgr, ['search', '--global', '--file', `/${file}`], cwd)
      if (search.code !== 0) continue
      const packageName = search.text.match(/^([a-zA-Z0-9_.+-]+):\s*$/m)?.[1]
      if (!packageName) continue
      const install = await this.runProcess(tlmgr, ['install', packageName], cwd)
      if (install.code === 0) installed = true
    }
    return installed
  }

  private runProcess(command: string, args: string[], cwd: string): Promise<{ code: number; text: string }> {
    return new Promise((resolve) => {
      const process = spawn(command, args, { cwd, env: processEnv(dirname(command)) })
      let text = ''
      process.stdout.on('data', (chunk) => (text += chunk.toString()))
      process.stderr.on('data', (chunk) => (text += chunk.toString()))
      process.on('error', (error) => resolve({ code: 1, text: `${text}\n${error.message}` }))
      process.on('close', (code) => resolve({ code: code ?? 1, text }))
    })
  }

  private findExecutable(name: string, explicitPaths: string[]): string | null {
    for (const path of explicitPaths) if (path && existsSync(path)) return path
    const pathDirs = (process.env.PATH ?? '').split(':')
    for (const directory of pathDirs) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  private parseCompilerErrors(output: string): string[] {
    const lines = output.split(/\r?\n/)
    const useful = lines.filter((line) =>
      /(^! |\.tex:\d+:|(?:LaTeX|Package\s+\S+) Error:|not found|Emergency stop|Fatal error|Overfull \\hbox)/i.test(line)
    )
    return [...new Set(useful.map((line) => line.trim()).filter(Boolean))].slice(0, 10).length
      ? [...new Set(useful.map((line) => line.trim()).filter(Boolean))].slice(0, 10)
      : ['Compilation failed. Open the source and retry after checking required LaTeX packages.']
  }

  private createUndoSnapshot(): void {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    const directory = join(this.activeHistoryDir(), id)
    mkdirSync(directory, { recursive: false })
    cpSync(this.activeSourceFile(), join(directory, 'main.tex'))
    if (existsSync(this.activeProfilePdf())) cpSync(this.activeProfilePdf(), join(directory, 'current.pdf'))
  }

  private createProfilePromotionSnapshot(profileId: string, draftId: string): string {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    const directory = join(this.paths.historyDir(profileId), id)
    mkdirSync(directory, { recursive: false })
    cpSync(this.paths.profileDir(profileId), join(directory, 'source'), { recursive: true })
    cpSync(this.paths.sourceFile(profileId), join(directory, 'main.tex'))
    if (existsSync(this.paths.profilePdf(profileId))) cpSync(this.paths.profilePdf(profileId), join(directory, 'current.pdf'))
    cpSync(this.paths.jobDraftDir(profileId, draftId), join(directory, 'promoted-draft'), { recursive: true })
    this.atomicWrite(join(directory, 'promotion.json'), JSON.stringify({ version: 1, draftId }, null, 2))
    return directory
  }

  private restoreProfilePromotionSnapshot(profileId: string, draftId: string, snapshotDir: string): void {
    const oldSource = join(snapshotDir, 'source')
    if (existsSync(oldSource)) this.replaceDirectory(oldSource, this.paths.profileDir(profileId))
    const oldPdf = join(snapshotDir, 'current.pdf')
    if (existsSync(oldPdf)) {
      this.atomicCopy(oldPdf, this.paths.profilePdf(profileId))
      this.atomicCopy(oldPdf, this.paths.previewPdf(profileId))
    } else {
      rmSync(this.paths.profilePdf(profileId), { force: true })
      rmSync(this.paths.previewPdf(profileId), { force: true })
    }
    this.atomicWrite(this.paths.changeReviewFile(profileId), 'null')
    const archivedDraft = join(snapshotDir, 'promoted-draft')
    if (!existsSync(this.paths.jobDraftDir(profileId, draftId)) && existsSync(archivedDraft)) {
      cpSync(archivedDraft, this.paths.jobDraftDir(profileId, draftId), { recursive: true })
    }
    this.activeJobDraftIds.set(profileId, draftId)
    this.writeActiveProfileId()
    this.syncPublishedPdf()
  }

  private replaceDirectory(source: string, destination: string): void {
    const parent = dirname(destination)
    mkdirSync(parent, { recursive: true })
    const incoming = join(parent, `.${basename(destination)}.${randomUUID()}.incoming`)
    const previous = join(parent, `.${basename(destination)}.${randomUUID()}.previous`)
    cpSync(source, incoming, { recursive: true })
    try {
      if (existsSync(destination)) renameSync(destination, previous)
      renameSync(incoming, destination)
      rmSync(previous, { recursive: true, force: true })
    } catch (error) {
      rmSync(incoming, { recursive: true, force: true })
      if (!existsSync(destination) && existsSync(previous)) renameSync(previous, destination)
      throw error
    }
  }

  private createArchive(
    input: Pick<ApplicationInput, 'company' | 'position'>,
    applicationId: string
  ): { id: string; archivePath: string; createdAt: string } {
    this.initialize()
    const profile = this.activeProfile()
    const profilePdf = this.activeProfilePdf()
    if (!existsSync(profilePdf)) throw new Error('Compile a valid resume before archiving or submitting.')
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const archivePath = join(this.paths.archivesDir, applicationId, `${createdAt.replace(/[:.]/g, '-')}-${id.slice(0, 8)}`)
    const sourceArchive = join(archivePath, 'source')
    mkdirSync(sourceArchive, { recursive: true })
    cpSync(this.activeProfileDir(), sourceArchive, { recursive: true })
    cpSync(profilePdf, join(archivePath, 'resume.pdf'))

    const sourceFiles = this.listFiles(sourceArchive).map((path) => ({
      path: relative(sourceArchive, path),
      sha256: this.hashFile(path)
    }))
    writeFileSync(
      join(archivePath, 'manifest.json'),
      JSON.stringify(
        {
          archiveVersion: 1,
          submissionId: id,
          applicationId,
          company: input.company,
          position: input.position,
          profileId: profile.id,
          profile: profile.name,
          jobDraft: this.isJobDraftActive() ? { name: this.readJobDraftName() } : null,
          createdAt,
          pdfSha256: this.hashFile(join(archivePath, 'resume.pdf')),
          sourceFiles
        },
        null,
        2
      )
    )
    return { id, archivePath, createdAt }
  }

  private listFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name)
      return statSync(path).isDirectory() ? this.listFiles(path) : [path]
    })
  }

  private hashFile(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  }

  private recordCompile(result: CompileResult, rawOutput: string): void {
    const id = `${result.compiledAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    writeFileSync(join(this.activeCompileHistoryDir(), `${id}.json`), JSON.stringify({ ...result, rawOutput }, null, 2))
  }

  private readLastCompile(): CompileResult | null {
    const compileHistoryDir = this.activeCompileHistoryDir()
    if (!existsSync(compileHistoryDir)) return null
    const latest = readdirSync(compileHistoryDir).filter((name) => name.endsWith('.json')).sort().reverse()[0]
    if (!latest) return null
    try {
      const parsed = JSON.parse(readFileSync(join(compileHistoryDir, latest), 'utf8')) as CompileResult
      return {
        ok: parsed.ok,
        pages: parsed.pages,
        compiler: parsed.compiler,
        message: parsed.message,
        errors: parsed.errors,
        compiledAt: parsed.compiledAt
      }
    } catch {
      return null
    }
  }

  private createChangeReview(previousSource: string, nextSource: string, changedAt: string): ResumeChangeReview {
    const operations = diffLines(previousSource, nextSource)
    const addedLines = operations.filter((operation) => operation.type === 'added').length
    const removedLines = operations.filter((operation) => operation.type === 'removed').length
    const rewrittenLines = Math.min(addedLines, removedLines)
    const additions = addedLines - rewrittenLines
    const removals = removedLines - rewrittenLines
    const parts: string[] = []
    if (rewrittenLines) parts.push(`${rewrittenLines} line${rewrittenLines === 1 ? '' : 's'} rewritten`)
    if (additions) parts.push(`${additions} added`)
    if (removals) parts.push(`${removals} removed`)

    return {
      summary: parts.join(' · ') || 'Formatting-only change',
      addedLines,
      removedLines,
      diff: formatCompactDiff(operations),
      changedAt
    }
  }

  private recordChangeReview(review: ResumeChangeReview): void {
    this.atomicWrite(this.activeChangeReviewFile(), JSON.stringify(review, null, 2))
  }

  private readLastChange(): ResumeChangeReview | null {
    const reviewFile = this.activeChangeReviewFile()
    if (existsSync(reviewFile)) {
      try {
        return JSON.parse(readFileSync(reviewFile, 'utf8')) as ResumeChangeReview | null
      } catch {
        return null
      }
    }

    const latestSnapshot = readdirSync(this.activeHistoryDir())
      .filter((name) => !name.startsWith('undone-'))
      .sort()
      .reverse()[0]
    if (!latestSnapshot) return null
    const previousSource = join(this.activeHistoryDir(), latestSnapshot, 'main.tex')
    if (!existsSync(previousSource)) return null
    const previous = readFileSync(previousSource, 'utf8')
    const current = readFileSync(this.activeSourceFile(), 'utf8')
    if (previous === current) return null
    return this.createChangeReview(previous, current, statSync(this.activeSourceFile()).mtime.toISOString())
  }

  private migrateLegacyGeneralProfile(): void {
    if (!this.profiles.some((profile) => profile.id === 'general-swe')) return
    const generalPdf = this.paths.profilePdf('general-swe')
    if (existsSync(this.paths.internalPdf) && !existsSync(generalPdf)) this.atomicCopy(this.paths.internalPdf, generalPdf)

    const legacySnapshots = join(this.paths.resumeRoot, 'history', 'snapshots')
    const generalSnapshots = this.paths.historyDir('general-swe')
    if (existsSync(legacySnapshots) && readdirSync(generalSnapshots).length === 0) {
      cpSync(legacySnapshots, generalSnapshots, { recursive: true })
    }

    const legacyCompiles = join(this.paths.resumeRoot, 'history', 'compiles')
    const generalCompiles = this.paths.compileHistoryDir('general-swe')
    if (existsSync(legacyCompiles) && readdirSync(generalCompiles).length === 0) {
      cpSync(legacyCompiles, generalCompiles, { recursive: true })
    }
  }

  private migrateSingleJobDraft(profileId: string): void {
    const root = this.paths.jobDraftRoot(profileId)
    const legacySource = join(root, 'source', 'main.tex')
    if (!existsSync(legacySource)) return

    let metadata: { name?: string; createdAt?: string } = {}
    const legacyMetadata = join(root, 'draft.json')
    if (existsSync(legacyMetadata)) {
      try {
        metadata = JSON.parse(readFileSync(legacyMetadata, 'utf8')) as typeof metadata
      } catch {
        metadata = {}
      }
    }

    const draftId = randomUUID()
    const destination = this.paths.jobDraftDir(profileId, draftId)
    mkdirSync(destination, { recursive: true })
    for (const name of ['source', 'history', 'candidates', 'current.pdf', 'latest-preview.pdf', 'draft.json']) {
      const path = join(root, name)
      if (existsSync(path)) renameSync(path, join(destination, name))
    }
    this.atomicWrite(
      this.paths.jobDraftMetadata(profileId, draftId),
      JSON.stringify({
        id: draftId,
        name: metadata.name?.trim() || 'Job Draft',
        createdAt: metadata.createdAt ?? new Date().toISOString()
      }, null, 2)
    )
  }

  private readActiveProfileId(): string {
    if (!existsSync(this.paths.activeProfileFile)) return this.profiles[0].id
    try {
      const parsed = JSON.parse(readFileSync(this.paths.activeProfileFile, 'utf8')) as { activeProfileId?: string }
      if (this.profiles.some((profile) => profile.id === parsed.activeProfileId)) return parsed.activeProfileId!
    } catch {
      // A missing or malformed preference safely falls back to the first configured profile.
    }
    return this.profiles[0].id
  }

  private readActiveJobDraftIds(): Map<string, string> {
    const active = new Map<string, string>()
    if (!existsSync(this.paths.activeProfileFile)) return active
    try {
      const parsed = JSON.parse(readFileSync(this.paths.activeProfileFile, 'utf8')) as {
        activeJobDraftIds?: Record<string, string>
        activeJobDraftProfiles?: string[]
      }
      for (const profile of this.profiles) {
        const drafts = this.listJobDrafts(profile.id)
        const requestedId = parsed.activeJobDraftIds?.[profile.id]
        if (requestedId && drafts.some((draft) => draft.id === requestedId)) active.set(profile.id, requestedId)
        else if (parsed.activeJobDraftProfiles?.includes(profile.id) && drafts[0]) active.set(profile.id, drafts[0].id)
      }
    } catch {
      return active
    }
    return active
  }

  private writeActiveProfileId(): void {
    this.atomicWrite(
      this.paths.activeProfileFile,
      JSON.stringify({ activeProfileId: this.activeProfileId, activeJobDraftIds: Object.fromEntries(this.activeJobDraftIds) }, null, 2)
    )
  }

  private syncPublishedPdf(): void {
    const profilePdf = this.activeProfilePdf()
    if (existsSync(profilePdf)) {
      this.atomicCopy(profilePdf, this.paths.internalPdf)
      this.atomicCopy(profilePdf, this.paths.publicPdf)
      return
    }
    rmSync(this.paths.internalPdf, { force: true })
    rmSync(this.paths.publicPdf, { force: true })
  }

  private activeProfile(): ResumeProfile {
    return this.profiles.find((profile) => profile.id === this.activeProfileId) ?? this.profiles[0]
  }

  private activeProfileDir(): string {
    const draftId = this.activeJobDraftId()
    return draftId
      ? this.paths.jobDraftSourceDir(this.activeProfileId, draftId)
      : this.paths.profileDir(this.activeProfileId)
  }

  private activeSourceFile(): string {
    const draftId = this.activeJobDraftId()
    return draftId
      ? this.paths.jobDraftSourceFile(this.activeProfileId, draftId)
      : this.paths.sourceFile(this.activeProfileId)
  }

  private activeProfilePdf(): string {
    const draftId = this.activeJobDraftId()
    return draftId
      ? this.paths.jobDraftPdf(this.activeProfileId, draftId)
      : this.paths.profilePdf(this.activeProfileId)
  }

  private activePreviewPdf(): string {
    const draftId = this.activeJobDraftId()
    return draftId
      ? this.paths.jobDraftPreviewPdf(this.activeProfileId, draftId)
      : this.paths.previewPdf(this.activeProfileId)
  }

  private activeHistoryDir(): string {
    const draftId = this.activeJobDraftId()
    return draftId
      ? this.paths.jobDraftHistoryDir(this.activeProfileId, draftId)
      : this.paths.historyDir(this.activeProfileId)
  }

  private activeCompileHistoryDir(): string {
    const draftId = this.activeJobDraftId()
    return draftId
      ? this.paths.jobDraftCompileHistoryDir(this.activeProfileId, draftId)
      : this.paths.compileHistoryDir(this.activeProfileId)
  }

  private activeChangeReviewFile(): string {
    const draftId = this.activeJobDraftId()
    return draftId
      ? this.paths.jobDraftChangeReviewFile(this.activeProfileId, draftId)
      : this.paths.changeReviewFile(this.activeProfileId)
  }

  private activeCandidatesDir(): string {
    const draftId = this.activeJobDraftId()
    return draftId
      ? this.paths.jobDraftCandidatesDir(this.activeProfileId, draftId)
      : this.paths.candidatesDir(this.activeProfileId)
  }

  private jobDraftExists(): boolean {
    return this.listJobDrafts(this.activeProfileId).length > 0
  }

  private isJobDraftActive(): boolean {
    return this.activeJobDraftId() !== null
  }

  private readJobDraftName(): string | null {
    const draftId = this.activeJobDraftId()
    return this.listJobDrafts(this.activeProfileId).find((draft) => draft.id === draftId)?.name ?? null
  }

  private activeJobDraftId(): string | null {
    const draftId = this.activeJobDraftIds.get(this.activeProfileId)
    return draftId && existsSync(this.paths.jobDraftSourceFile(this.activeProfileId, draftId)) ? draftId : null
  }

  private listJobDrafts(profileId: string): ResumeJobDraft[] {
    const root = this.paths.jobDraftRoot(profileId)
    if (!existsSync(root)) return []
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(this.paths.jobDraftSourceFile(profileId, entry.name)))
      .map((entry) => {
        const metadataPath = this.paths.jobDraftMetadata(profileId, entry.name)
        let metadata: { name?: string; createdAt?: string } = {}
        if (existsSync(metadataPath)) {
          try {
            metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as typeof metadata
          } catch {
            metadata = {}
          }
        }
        return {
          id: entry.name,
          name: metadata.name?.trim() || 'Job Draft',
          createdAt: metadata.createdAt ?? statSync(this.paths.jobDraftDir(profileId, entry.name)).mtime.toISOString()
        }
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  private ensureJobDraftDirectories(profileId: string, draftId: string): void {
    mkdirSync(this.paths.jobDraftHistoryDir(profileId, draftId), { recursive: true })
    mkdirSync(this.paths.jobDraftCompileHistoryDir(profileId, draftId), { recursive: true })
    mkdirSync(this.paths.jobDraftCandidatesDir(profileId, draftId), { recursive: true })
  }

  private atomicWrite(destination: string, contents: string): void {
    const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
    writeFileSync(temporary, contents)
    renameSync(temporary, destination)
  }

  private atomicCopy(source: string, destination: string): void {
    mkdirSync(dirname(destination), { recursive: true })
    const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
    cpSync(source, temporary)
    renameSync(temporary, destination)
  }
}

export function detectRequiredTexFiles(output: string): string[] {
  const missingFiles = [...output.matchAll(/File\s+[`']([^`']+\.(?:sty|cls|def|ldf|fd))[`']\s+not found/gi)]
    .map((match) => match[1])
  const babelLanguages = [...output.matchAll(/Package\s+babel\s+Error:\s+Unknown option\s+[`']([^`']+)[`']/gi)]
    .map((match) => `${match[1]}.ldf`)
  return [...new Set([...missingFiles, ...babelLanguages])].slice(0, 10)
}

function processEnv(compilerDirectory?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${compilerDirectory ? `${compilerDirectory}:` : ''}/Library/TeX/texbin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`
  }
}

function diffLines(previousSource: string, nextSource: string): DiffOperation[] {
  const previous = previousSource.split('\n')
  const next = nextSource.split('\n')
  const lengths = Array.from({ length: previous.length + 1 }, () => new Uint16Array(next.length + 1))

  for (let oldIndex = previous.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = next.length - 1; newIndex >= 0; newIndex -= 1) {
      lengths[oldIndex][newIndex] = previous[oldIndex] === next[newIndex]
        ? lengths[oldIndex + 1][newIndex + 1] + 1
        : Math.max(lengths[oldIndex + 1][newIndex], lengths[oldIndex][newIndex + 1])
    }
  }

  const operations: DiffOperation[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < previous.length || newIndex < next.length) {
    if (oldIndex < previous.length && newIndex < next.length && previous[oldIndex] === next[newIndex]) {
      operations.push({ type: 'unchanged', text: previous[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 })
      oldIndex += 1
      newIndex += 1
    } else if (
      oldIndex < previous.length &&
      (newIndex >= next.length || lengths[oldIndex + 1][newIndex] >= lengths[oldIndex][newIndex + 1])
    ) {
      operations.push({ type: 'removed', text: previous[oldIndex], oldLine: oldIndex + 1 })
      oldIndex += 1
    } else {
      operations.push({ type: 'added', text: next[newIndex], newLine: newIndex + 1 })
      newIndex += 1
    }
  }
  return operations
}

function formatCompactDiff(operations: DiffOperation[]): string {
  const changedIndexes = operations
    .map((operation, index) => (operation.type === 'unchanged' ? -1 : index))
    .filter((index) => index >= 0)
  if (changedIndexes.length === 0) return 'No line-level changes.'

  const ranges: Array<{ start: number; end: number }> = []
  for (const index of changedIndexes) {
    const start = Math.max(0, index - 2)
    const end = Math.min(operations.length - 1, index + 2)
    const previousRange = ranges.at(-1)
    if (previousRange && start <= previousRange.end + 1) previousRange.end = Math.max(previousRange.end, end)
    else ranges.push({ start, end })
  }

  return ranges.map(({ start, end }) => {
    const first = operations[start]
    const header = `@@ old ${first.oldLine ?? '—'} · new ${first.newLine ?? '—'} @@`
    const lines = operations.slice(start, end + 1).map((operation) => {
      const prefix = operation.type === 'added' ? '+' : operation.type === 'removed' ? '-' : ' '
      return `${prefix} ${operation.text}`
    })
    return [header, ...lines].join('\n')
  }).join('\n\n')
}
