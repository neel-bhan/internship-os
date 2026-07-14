import { contextBridge, ipcRenderer } from 'electron'
import type { ApplicationInput, CodexEditMode, CodexEvent, InternshipOsApi } from '../shared/types'

const api: InternshipOsApi = {
  applications: {
    list: () => ipcRenderer.invoke('applications:list'),
    save: (input: ApplicationInput) => ipcRenderer.invoke('applications:save', input),
    remove: (id: string) => ipcRenderer.invoke('applications:remove', id)
  },
  resume: {
    get: () => ipcRenderer.invoke('resume:get'),
    readPdf: () => ipcRenderer.invoke('resume:read-pdf'),
    selectProfile: (profileId: string) => ipcRenderer.invoke('resume:select-profile', profileId),
    saveAndCompile: (source: string) => ipcRenderer.invoke('resume:save-and-compile', source),
    compile: () => ipcRenderer.invoke('resume:compile'),
    undo: () => ipcRenderer.invoke('resume:undo'),
    openPdf: () => ipcRenderer.invoke('resume:open-pdf'),
    revealPdf: () => ipcRenderer.invoke('resume:reveal-pdf'),
    archive: () => ipcRenderer.invoke('resume:archive')
  },
  codex: {
    getState: () => ipcRenderer.invoke('codex:get-state'),
    connect: () => ipcRenderer.invoke('codex:connect'),
    setEditMode: (mode: CodexEditMode) => ipcRenderer.invoke('codex:set-edit-mode', mode),
    openProfile: () => ipcRenderer.invoke('codex:open-profile'),
    send: (text: string) => ipcRenderer.invoke('codex:send', text),
    respondToApproval: (requestId, decision) => ipcRenderer.invoke('codex:respond-approval', requestId, decision),
    onEvent: (callback: (event: CodexEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: CodexEvent): void => callback(event)
      ipcRenderer.on('codex:event', listener)
      return () => ipcRenderer.removeListener('codex:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('internshipOS', api)
