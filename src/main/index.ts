import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApplicationInput, AssistantProviderId, CodexEditMode, OnboardingInput, SettingsInput, ToolCheck } from '../shared/types'
import { ApplicationStore } from './core/database'
import { AppPaths } from './core/paths'
import { ResumeManager } from './core/resume'
import { SettingsStore } from './core/settings'
import { createCandidateProfile, createStarterResume, updateCandidateProfile } from './core/templates'
import { writeAssistantWorkspace } from './core/instructions'
import { createAssistantClient, type AssistantClient } from './assistant-client'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const configuredRoot = process.env.INTERNSHIP_OS_HOME
const canonicalRoot = join(app.getPath('appData'), 'Internship OS')
const splitLegacyRoot = join(app.getPath('appData'), 'internship-application-os')
const dataRoot = configuredRoot ?? (existsSync(canonicalRoot) ? canonicalRoot : existsSync(splitLegacyRoot) ? splitLegacyRoot : canonicalRoot)
const repositoryTexBin = join(app.getAppPath(), '.tools', 'tinytex', 'TinyTeX', 'bin', 'universal-darwin')
if (!process.env.INTERNSHIP_OS_TEX_BIN && existsSync(join(repositoryTexBin, 'latexmk'))) process.env.INTERNSHIP_OS_TEX_BIN = repositoryTexBin
app.setPath('userData', dataRoot)

let mainWindow: BrowserWindow | null = null
let settingsStore: SettingsStore
let paths: AppPaths | null = null
let store: ApplicationStore | null = null
let resume: ResumeManager | null = null
let assistant: AssistantClient | null = null
let cliWrapperPath = ''

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 950,
    minHeight: 680,
    title: 'Internship OS',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 19 },
    backgroundColor: '#1c1c1e',
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = window
  window.once('closed', () => { if (mainWindow === window) mainWindow = null })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(currentDirectory, '../renderer/index.html'))
}

app.whenReady().then(() => {
  if (!configuredRoot && dataRoot === canonicalRoot) migrateSplitLegacyData(canonicalRoot, splitLegacyRoot)
  settingsStore = new SettingsStore(dataRoot)
  if (settingsStore.get().onboardingComplete) initializeRuntime()
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => shutdownRuntime())

function initializeRuntime(seedSource?: string): void {
  shutdownRuntime()
  const settings = settingsStore.get()
  const downloadsRoot = process.env.INTERNSHIP_OS_DOWNLOADS ?? app.getPath('downloads')
  paths = new AppPaths(dataRoot, downloadsRoot, settings.exportFilename)
  const defaultSource = join(app.getAppPath(), 'main.tex')

  if (seedSource) {
    const firstProfile = settings.resumeProfiles[0]
    mkdirSync(paths.profileDir(firstProfile.id), { recursive: true })
    writeFileSync(paths.sourceFile(firstProfile.id), seedSource)
  }

  const candidateProfile = join(paths.root, 'candidate-profile.md')
  if (!existsSync(candidateProfile)) writeFileSync(candidateProfile, createCandidateProfile(settings.identity, settings.resumeProfiles))

  const workspaceRoot = join(paths.root, 'assistant-workspace')
  const cliPath = join(currentDirectory, 'cli.js')
  cliWrapperPath = writeAssistantWorkspace(workspaceRoot, settings.resumeProfiles, {
    electronPath: process.execPath,
    cliPath,
    appRoot: paths.root,
    downloadsRoot,
    defaultResumePath: defaultSource,
    texBinPath: process.env.INTERNSHIP_OS_TEX_BIN
  })

  store = new ApplicationStore(paths.database)
  resume = new ResumeManager(paths, defaultSource, settings.resumeProfiles)
  resume.initialize()
  assistant = createAssistantClient(settings.assistantProvider, workspaceRoot, paths, cliWrapperPath, settings.editMode, {
    model: settings.codexModel,
    reasoningEffort: settings.codexReasoningEffort
  })
  assistant.setEventSink((event) => {
    const window = mainWindow
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    try { window.webContents.send('codex:event', event) } catch { /* Window may be closing. */ }
  })
}

function shutdownRuntime(): void {
  assistant?.stop()
  store?.close()
  assistant = null
  store = null
  resume = null
}

function registerIpc(): void {
  ipcMain.handle('onboarding:get-state', () => ({ settings: settingsStore.get(), tools: checkTools(), legacyDataDetected: settingsStore.legacyDataDetected }))
  ipcMain.handle('onboarding:refresh-tools', () => checkTools())
  ipcMain.handle('onboarding:choose-resume-file', async () => {
    const result = await dialog.showOpenDialog({ title: 'Import LaTeX Resume', properties: ['openFile'], filters: [{ name: 'LaTeX', extensions: ['tex'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return { name: result.filePaths[0].split('/').at(-1) ?? 'main.tex', source: readFileSync(result.filePaths[0], 'utf8') }
  })
  ipcMain.handle('onboarding:open-assistant-setup', (_event, provider: Exclude<AssistantProviderId, 'none'>) => openAssistantSetup(provider))
  ipcMain.handle('onboarding:complete', (_event, input: OnboardingInput) => {
    const wasComplete = settingsStore.get().onboardingComplete
    const settings = settingsStore.complete(input)
    const source = input.resumeSource?.trim() || createStarterResume(settings.identity)
    initializeRuntime(wasComplete ? undefined : source)
    return { settings, tools: checkTools(), legacyDataDetected: settingsStore.legacyDataDetected }
  })
  ipcMain.handle('settings:get', () => ({ settings: settingsStore.get(), tools: checkTools(), legacyDataDetected: settingsStore.legacyDataDetected }))
  ipcMain.handle('settings:save', (_event, input: SettingsInput) => saveUserSettings(input))

  ipcMain.handle('applications:list', () => requireStore().list())
  ipcMain.handle('applications:save', async (_event, input: ApplicationInput) => {
    validateApplication(input)
    const activeStore = requireStore()
    const activeResume = requireResume()
    const existing = input.id ? activeStore.get(input.id) : null
    const applicationId = input.id ?? crypto.randomUUID()
    const normalized: ApplicationInput = {
      ...input,
      id: applicationId,
      company: input.company.trim(),
      position: input.position.trim(),
      dateApplied: input.dateApplied || (input.status === 'Submitted' ? localDate() : null),
      details: input.details.trim()
    }
    const submission = normalized.status === 'Submitted' && existing?.status !== 'Submitted'
      ? activeResume.archiveForApplication(normalized, applicationId)
      : undefined
    activeStore.save(normalized, submission)
    return activeStore.list()
  })
  ipcMain.handle('applications:remove', (_event, id: string) => { requireStore().remove(id); return requireStore().list() })

  ipcMain.handle('resume:get', () => requireResume().getState())
  ipcMain.handle('resume:read-pdf', () => {
    const path = requireResume().getPreviewPdfPath()
    return existsSync(path) ? Uint8Array.from(readFileSync(path)).buffer : null
  })
  ipcMain.handle('resume:select-profile', (_event, profileId: string) => requireResume().selectProfile(profileId))
  ipcMain.handle('resume:create-job-draft', (_event, name: string, profileId?: string) => requireResume().createJobDraft(name, profileId))
  ipcMain.handle('resume:select-job-draft', (_event, draftId: string | null) => requireResume().selectJobDraft(draftId))
  ipcMain.handle('resume:discard-job-draft', (_event, draftId: string) => requireResume().discardJobDraft(draftId))
  ipcMain.handle('resume:save-and-compile', (_event, source: string) => requireResume().saveAndCompile(source))
  ipcMain.handle('resume:compile', () => requireResume().compile())
  ipcMain.handle('resume:undo', () => requireResume().undo())
  ipcMain.handle('resume:open-pdf', async () => openResumePdf(false))
  ipcMain.handle('resume:reveal-pdf', () => openResumePdf(true))
  ipcMain.handle('resume:archive', () => requireResume().archiveManual())

  ipcMain.handle('codex:get-state', () => requireAssistant().getState())
  ipcMain.handle('codex:connect', () => requireAssistant().connect())
  ipcMain.handle('codex:set-edit-mode', (_event, mode: CodexEditMode) => {
    settingsStore.updateEditMode(mode)
    return requireAssistant().setEditMode(mode)
  })
  ipcMain.handle('codex:open-profile', async () => {
    const error = await shell.openPath(requireAssistant().getProfilePath())
    if (error) throw new Error(error)
  })
  ipcMain.handle('codex:list-chats', () => requireAssistant().listChats())
  ipcMain.handle('codex:open-chat', (_event, threadId: string) => requireAssistant().openChat(threadId))
  ipcMain.handle('codex:new-chat', () => requireAssistant().newChat())
  ipcMain.handle('codex:send', (_event, text: string) => requireAssistant().send(text))
  ipcMain.handle('codex:respond-approval', (_event, requestId: string | number, decision: 'accept' | 'decline') => requireAssistant().respondToApproval(requestId, decision))
}

function saveUserSettings(input: SettingsInput): { settings: ReturnType<SettingsStore['get']>; tools: ToolCheck[]; legacyDataDetected: boolean } {
  const previous = settingsStore.get()
  const activePaths = paths
  const activeResume = resume
  const activeState = activeResume?.getState()
  const baseSource = activePaths && activeState && existsSync(activePaths.sourceFile(activeState.activeProfileId))
    ? readFileSync(activePaths.sourceFile(activeState.activeProfileId), 'utf8')
    : null
  const settings = settingsStore.complete(input)

  if (activePaths && baseSource) {
    const previousIds = new Set(previous.resumeProfiles.map((profile) => profile.id))
    for (const profile of settings.resumeProfiles) {
      if (previousIds.has(profile.id) || existsSync(activePaths.sourceFile(profile.id))) continue
      mkdirSync(activePaths.profileDir(profile.id), { recursive: true })
      writeFileSync(activePaths.sourceFile(profile.id), baseSource)
    }
  }

  const candidateProfile = join(dataRoot, 'candidate-profile.md')
  if (existsSync(candidateProfile)) {
    writeFileSync(candidateProfile, updateCandidateProfile(readFileSync(candidateProfile, 'utf8'), settings.identity, settings.resumeProfiles))
  }
  initializeRuntime()
  return { settings, tools: checkTools(), legacyDataDetected: settingsStore.legacyDataDetected }
}

function checkTools(): ToolCheck[] {
  return [checkTool('codex'), checkTool('claude'), checkLatex()]
}

function checkTool(id: 'codex' | 'claude'): ToolCheck {
  const executable = findExecutable(id)
  if (!executable) return { id, available: false, executable: null, version: null, authenticated: false, message: `${id === 'codex' ? 'Codex' : 'Claude Code'} is not installed.` }
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout.trim() || null
  if (id === 'codex') {
    const status = spawnSync(executable, ['login', 'status'], { encoding: 'utf8', timeout: 5000 })
    const authenticated = status.status === 0
    return { id, available: true, executable, version, authenticated, message: authenticated ? 'Codex is ready.' : 'Run Codex login to continue.' }
  }
  try {
    const status = spawnSync(executable, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 5000 })
    const authenticated = Boolean(JSON.parse(status.stdout || '{}').loggedIn)
    return { id, available: true, executable, version, authenticated, message: authenticated ? 'Claude is ready.' : 'Run Claude to sign in.' }
  } catch {
    return { id, available: true, executable, version, authenticated: false, message: 'Run Claude to sign in.' }
  }
}

function checkLatex(): ToolCheck {
  for (const command of ['latexmk', 'pdflatex']) {
    const executable = findExecutable(command)
    if (executable) return { id: 'latex', available: true, executable, version: command, message: `${command} is ready.` }
  }
  return { id: 'latex', available: false, executable: null, version: null, message: 'Run `npm run setup` to install the local LaTeX toolchain.' }
}

function findExecutable(command: string): string | null {
  const direct = command === 'codex'
    ? '/Applications/Codex.app/Contents/Resources/codex'
    : command === 'claude'
      ? join(app.getPath('home'), '.local', 'bin', 'claude')
      : command === 'latexmk' || command === 'pdflatex'
        ? join(process.env.INTERNSHIP_OS_TEX_BIN ?? repositoryTexBin, command)
        : null
  if (direct && existsSync(direct)) return direct
  const result = spawnSync('/usr/bin/which', [command], { encoding: 'utf8', env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin` } })
  return result.status === 0 ? result.stdout.trim() || null : null
}

async function openAssistantSetup(provider: Exclude<AssistantProviderId, 'none'>): Promise<void> {
  const executable = findExecutable(provider)
  const documentation = provider === 'codex' ? 'https://developers.openai.com/codex/cli' : 'https://docs.anthropic.com/en/docs/claude-code/getting-started'
  if (!executable) {
    await shell.openExternal(documentation)
    return
  }
  if (process.platform === 'darwin') {
    const setupPath = join(tmpdir(), `internship-os-${provider}-setup-${crypto.randomUUID()}.command`)
    const loginCommand = provider === 'codex'
      ? `${quoteShell(executable)} login`
      : `${quoteShell(executable)} auth login`
    const providerName = provider === 'codex' ? 'Codex' : 'Claude'
    writeFileSync(setupPath, `#!/bin/zsh
rm -f ${quoteShell(setupPath)}
echo "Starting ${providerName} sign-in…"
${loginCommand}
result=$?
echo
if [ $result -eq 0 ]; then
  echo "${providerName} sign-in finished. Return to Internship OS and click Check again."
else
  echo "${providerName} sign-in failed with exit code $result."
fi
echo "Press any key to close this window."
read -k 1
exit $result
`)
    chmodSync(setupPath, 0o700)
    const error = await shell.openPath(setupPath)
    if (error) throw new Error(`Could not open ${providerName} setup: ${error}`)
  } else {
    await shell.openExternal(documentation)
  }
}

async function openResumePdf(reveal: boolean): Promise<void> {
  const activeResume = requireResume()
  const path = existsSync(activeResume.paths.publicPdf) ? activeResume.paths.publicPdf : activeResume.paths.internalPdf
  if (!existsSync(path)) throw new Error('Compile the resume first.')
  if (reveal) shell.showItemInFolder(path)
  else {
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  }
}

function requireStore(): ApplicationStore { if (!store) throw new Error('Complete onboarding first.'); return store }
function requireResume(): ResumeManager { if (!resume) throw new Error('Complete onboarding first.'); return resume }
function requireAssistant(): AssistantClient { if (!assistant) throw new Error('Complete onboarding first.'); return assistant }

function validateApplication(input: ApplicationInput): void {
  if (!input.company.trim()) throw new Error('Company is required.')
  if (!input.position.trim()) throw new Error('Position is required.')
  if (!['Submitted', 'In Progress', 'Rejected'].includes(input.status)) throw new Error('Invalid application status.')
}

function localDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function migrateSplitLegacyData(target: string, source: string): void {
  if (!existsSync(source) || target === source) return
  mkdirSync(target, { recursive: true })
  for (const name of ['candidate-profile.md', 'codex-settings.json', 'codex-thread.json', 'codex-chats.json']) {
    const from = join(source, name)
    const to = join(target, name)
    if (existsSync(from) && !existsSync(to)) cpSync(from, to)
  }
}

function quoteShell(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'` }
