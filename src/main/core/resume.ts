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
  RESUME_PROFILES,
  type ApplicationInput,
  type CompileResult,
  type ResumeChangeReview,
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
  private activeProfileId = RESUME_PROFILES[0].id
  private initialized = false

  constructor(
    readonly paths: AppPaths,
    private readonly defaultSourcePath: string
  ) {}

  initialize(): void {
    if (this.initialized) return

    mkdirSync(this.paths.profilesDir, { recursive: true })
    mkdirSync(dirname(this.paths.internalPdf), { recursive: true })
    mkdirSync(dirname(this.paths.publicPdf), { recursive: true })
    mkdirSync(this.paths.archivesDir, { recursive: true })

    const generalSource = this.paths.sourceFile('general-swe')
    mkdirSync(this.paths.profileDir('general-swe'), { recursive: true })
    if (!existsSync(generalSource)) {
      if (!existsSync(this.defaultSourcePath)) {
        throw new Error(`Default resume source not found: ${this.defaultSourcePath}`)
      }
      cpSync(this.defaultSourcePath, generalSource)
    }

    for (const profile of RESUME_PROFILES) {
      const profileDir = this.paths.profileDir(profile.id)
      if (!existsSync(profileDir)) cpSync(this.paths.profileDir('general-swe'), profileDir, { recursive: true })
      if (!existsSync(this.paths.sourceFile(profile.id))) cpSync(generalSource, this.paths.sourceFile(profile.id))
      mkdirSync(this.paths.historyDir(profile.id), { recursive: true })
      mkdirSync(this.paths.compileHistoryDir(profile.id), { recursive: true })
      mkdirSync(this.paths.candidatesDir(profile.id), { recursive: true })
      mkdirSync(dirname(this.paths.profilePdf(profile.id)), { recursive: true })
    }

    this.migrateLegacyGeneralProfile()
    this.activeProfileId = this.readActiveProfileId()
    this.writeActiveProfileId()
    this.syncPublishedPdf()
    this.initialized = true
  }

  getState(lastCompile?: CompileResult | null): ResumeState {
    this.initialize()
    const profile = this.activeProfile()
    const sourceFile = this.activeSourceFile()
    const profilePdf = this.activeProfilePdf()
    const hasPdf = existsSync(profilePdf)
    return {
      source: readFileSync(sourceFile, 'utf8'),
      sourcePath: sourceFile,
      pdfPath: this.paths.publicPdf,
      pdfRevision: hasPdf ? String(statSync(profilePdf).mtimeMs) : null,
      hasPdf,
      activeProfileId: profile.id,
      profileName: profile.name,
      profiles: RESUME_PROFILES.map((item) => ({ ...item })),
      lastCompile: lastCompile ?? this.readLastCompile(),
      lastChange: this.readLastChange()
    }
  }

  listProfiles(): ResumeProfile[] {
    return RESUME_PROFILES.map((profile) => ({ ...profile }))
  }

  selectProfile(profileId: string): ResumeState {
    this.initialize()
    const profile = RESUME_PROFILES.find((item) => item.id === profileId)
    if (!profile) throw new Error(`Unknown resume profile: ${profileId}`)
    this.activeProfileId = profile.id
    this.writeActiveProfileId()
    this.syncPublishedPdf()
    return this.getState()
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
    if (!existsSync(oldSource)) throw new Error('Undo snapshot is incomplete.')

    this.atomicCopy(oldSource, this.activeSourceFile())
    if (existsSync(oldPdf)) {
      this.atomicCopy(oldPdf, this.activeProfilePdf())
      this.atomicCopy(oldPdf, this.paths.internalPdf)
      this.atomicCopy(oldPdf, this.paths.publicPdf)
    }
    this.atomicWrite(this.activeChangeReviewFile(), 'null')
    renameSync(snapshotDir, join(historyDir, `undone-${latest}`))
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
      if (pages !== 1) {
        result = {
          ok: false,
          pages,
          compiler: run.compiler,
          message: `Candidate rendered as ${pages} pages. It was not promoted.`,
          errors: ['Resume must remain exactly one page. Shorten or replace content before compiling again.'],
          compiledAt: new Date().toISOString()
        }
        this.recordCompile(result, run.output)
        return this.getState(result)
      }

      if (sourceChanged) this.createUndoSnapshot()
      if (sourceChanged) this.atomicWrite(this.activeSourceFile(), source)
      this.atomicCopy(run.pdfPath, this.activeProfilePdf())
      this.atomicCopy(run.pdfPath, this.paths.internalPdf)
      this.atomicCopy(run.pdfPath, this.paths.publicPdf)

      result = {
        ok: true,
        pages,
        compiler: run.compiler,
        message: `Compiled successfully with ${run.compiler}.`,
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
    const latexmk = this.findExecutable('latexmk', ['/Library/TeX/texbin/latexmk'])
    const pdflatex = this.findExecutable('pdflatex', ['/Library/TeX/texbin/pdflatex'])

    if (!latexmk && !pdflatex) {
      return {
        ok: false,
        compiler: 'none',
        output: 'No LaTeX compiler found. Install latexmk or pdflatex.',
        pdfPath: join(buildDir, 'main.pdf')
      }
    }

    if (latexmk) {
      const output = await this.runProcess(
        latexmk,
        ['-pdf', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-outdir=${buildDir}`, 'main.tex'],
        sourceDir
      )
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

  private runProcess(command: string, args: string[], cwd: string): Promise<{ code: number; text: string }> {
    return new Promise((resolve) => {
      const process = spawn(command, args, { cwd, env: processEnv() })
      let text = ''
      process.stdout.on('data', (chunk) => (text += chunk.toString()))
      process.stderr.on('data', (chunk) => (text += chunk.toString()))
      process.on('error', (error) => resolve({ code: 1, text: `${text}\n${error.message}` }))
      process.on('close', (code) => resolve({ code: code ?? 1, text }))
    })
  }

  private findExecutable(name: string, explicitPaths: string[]): string | null {
    for (const path of explicitPaths) if (existsSync(path)) return path
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
      /(^! |\.tex:\d+:|LaTeX Error:|not found|Emergency stop|Fatal error|Overfull \\hbox)/i.test(line)
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

  private createArchive(
    input: Pick<ApplicationInput, 'company' | 'position'>,
    applicationId: string
  ): { id: string; archivePath: string; createdAt: string } {
    this.initialize()
    const profile = this.activeProfile()
    const profilePdf = this.activeProfilePdf()
    if (!existsSync(profilePdf)) throw new Error('Compile a valid one-page resume before archiving or submitting.')
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

  private readActiveProfileId(): string {
    if (!existsSync(this.paths.activeProfileFile)) return RESUME_PROFILES[0].id
    try {
      const parsed = JSON.parse(readFileSync(this.paths.activeProfileFile, 'utf8')) as { activeProfileId?: string }
      if (RESUME_PROFILES.some((profile) => profile.id === parsed.activeProfileId)) return parsed.activeProfileId!
    } catch {
      // A missing or malformed preference safely falls back to General SWE.
    }
    return RESUME_PROFILES[0].id
  }

  private writeActiveProfileId(): void {
    this.atomicWrite(this.paths.activeProfileFile, JSON.stringify({ activeProfileId: this.activeProfileId }, null, 2))
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
    return RESUME_PROFILES.find((profile) => profile.id === this.activeProfileId) ?? RESUME_PROFILES[0]
  }

  private activeProfileDir(): string {
    return this.paths.profileDir(this.activeProfileId)
  }

  private activeSourceFile(): string {
    return this.paths.sourceFile(this.activeProfileId)
  }

  private activeProfilePdf(): string {
    return this.paths.profilePdf(this.activeProfileId)
  }

  private activeHistoryDir(): string {
    return this.paths.historyDir(this.activeProfileId)
  }

  private activeCompileHistoryDir(): string {
    return this.paths.compileHistoryDir(this.activeProfileId)
  }

  private activeChangeReviewFile(): string {
    return this.paths.changeReviewFile(this.activeProfileId)
  }

  private activeCandidatesDir(): string {
    return this.paths.candidatesDir(this.activeProfileId)
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

function processEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `/Library/TeX/texbin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`
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
