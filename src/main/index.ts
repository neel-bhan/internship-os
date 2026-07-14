import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ApplicationInput, CodexEditMode } from '../shared/types'
import { ApplicationStore } from './core/database'
import { AppPaths } from './core/paths'
import { ResumeManager } from './core/resume'
import { CodexClient } from './codex-client'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

// Keep development and packaged builds on the same local-first data directory.
app.setPath('userData', join(app.getPath('appData'), 'internship-application-os'))

let mainWindow: BrowserWindow | null = null
let store: ApplicationStore
let resume: ResumeManager
let codex: CodexClient

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1050,
    minHeight: 700,
    title: 'Internship OS',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 19 },
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(currentDirectory, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const paths = new AppPaths(app.getPath('userData'), app.getPath('downloads'))
  const defaultSource = join(app.getAppPath(), 'main.tex')
  store = new ApplicationStore(paths.database)
  resume = new ResumeManager(paths, defaultSource)
  resume.initialize()
  const workspaceRoot = app.isPackaged ? join(app.getPath('home'), 'swe-applications') : app.getAppPath()
  codex = new CodexClient(existsSync(workspaceRoot) ? workspaceRoot : app.getPath('home'), paths)
  codex.setEventSink((event) => mainWindow?.webContents.send('codex:event', event))

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  codex?.stop()
  store?.close()
})

function registerIpc(): void {
  ipcMain.handle('applications:list', () => store.list())
  ipcMain.handle('applications:save', async (_event, input: ApplicationInput) => {
    validateApplication(input)
    const existing = input.id ? store.get(input.id) : null
    const applicationId = input.id ?? crypto.randomUUID()
    const normalized: ApplicationInput = {
      ...input,
      id: applicationId,
      company: input.company.trim(),
      position: input.position.trim(),
      dateApplied: input.dateApplied || (input.status === 'Submitted' ? localDate() : null),
      details: input.details.trim()
    }
    const shouldArchive = normalized.status === 'Submitted' && existing?.status !== 'Submitted'
    const submission = shouldArchive ? resume.archiveForApplication(normalized, applicationId) : undefined
    store.save(normalized, submission)
    return store.list()
  })
  ipcMain.handle('applications:remove', (_event, id: string) => {
    store.remove(id)
    return store.list()
  })

  ipcMain.handle('resume:get', () => resume.getState())
  ipcMain.handle('resume:read-pdf', () => {
    const path = resume.getPreviewPdfPath()
    if (!existsSync(path)) return null
    return Uint8Array.from(readFileSync(path)).buffer
  })
  ipcMain.handle('resume:select-profile', (_event, profileId: string) => resume.selectProfile(profileId))
  ipcMain.handle('resume:save-and-compile', (_event, source: string) => resume.saveAndCompile(source))
  ipcMain.handle('resume:compile', () => resume.compile())
  ipcMain.handle('resume:undo', () => resume.undo())
  ipcMain.handle('resume:open-pdf', async () => {
    const path = existsSync(resume.paths.publicPdf) ? resume.paths.publicPdf : resume.paths.internalPdf
    if (!existsSync(path)) throw new Error('Compile the resume first.')
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  ipcMain.handle('resume:reveal-pdf', () => {
    const path = existsSync(resume.paths.publicPdf) ? resume.paths.publicPdf : resume.paths.internalPdf
    if (!existsSync(path)) throw new Error('Compile the resume first.')
    shell.showItemInFolder(path)
  })
  ipcMain.handle('resume:archive', () => resume.archiveManual())

  ipcMain.handle('codex:get-state', () => codex.getState())
  ipcMain.handle('codex:connect', () => codex.connect())
  ipcMain.handle('codex:set-edit-mode', (_event, mode: CodexEditMode) => codex.setEditMode(mode))
  ipcMain.handle('codex:open-profile', async () => {
    const error = await shell.openPath(codex.getProfilePath())
    if (error) throw new Error(error)
  })
  ipcMain.handle('codex:send', (_event, text: string) => codex.send(text))
  ipcMain.handle(
    'codex:respond-approval',
    (_event, requestId: string | number, decision: 'accept' | 'decline') => codex.respondToApproval(requestId, decision)
  )
}

function validateApplication(input: ApplicationInput): void {
  if (!input.company.trim()) throw new Error('Company is required.')
  if (!input.position.trim()) throw new Error('Position is required.')
  if (!['Submitted', 'In Progress', 'Rejected'].includes(input.status)) throw new Error('Invalid application status.')
}

function localDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
