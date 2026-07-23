import { describe, expect, it, vi } from 'vitest'
import type { ResumeState } from '../../shared/types'
import { createAppCommands, type AppCommandActions, type AppCommandContext } from './app-commands'

const action = vi.fn()
const actions: AppCommandActions = {
  showResume: action,
  showTracker: action,
  openSettings: action,
  openStats: action,
  toggleTheme: action,
  openAssistant: action,
  startNewChat: action,
  saveAndCompile: action,
  compile: action,
  undo: action,
  openPdf: action,
  revealPdf: action,
  archiveResume: action,
  createDraft: action,
  selectProfile: action,
  selectDraft: action,
  promoteDraft: action,
  addApplication: action,
  showApplication: action
}

const resume: ResumeState = {
  source: '',
  sourcePath: '',
  pdfPath: '',
  pdfRevision: null,
  hasPdf: false,
  activeProfileId: 'general-swe',
  profileName: 'General SWE',
  profiles: [
    { id: 'general-swe', name: 'General SWE', focus: 'Balanced software engineering' },
    { id: 'backend', name: 'Backend', focus: 'APIs and systems' }
  ],
  jobDraft: {
    exists: true,
    active: true,
    id: 'apple-draft',
    name: 'Apple',
    drafts: [{ id: 'apple-draft', name: 'Apple', createdAt: '2026-07-20T12:00:00.000Z' }]
  },
  lastCompile: null,
  lastChange: null
}

const context: AppCommandContext = {
  applications: [{
    id: 'apple-application',
    company: 'Apple',
    position: 'Software Engineering Intern',
    dateApplied: '2026-07-21',
    status: 'Submitted',
    details: 'Cupertino',
    createdAt: '2026-07-21T12:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z',
    submissions: []
  }],
  resume,
  busy: false,
  theme: 'dark',
  assistantName: 'Codex',
  assistantConfigured: true,
  assistantReady: true,
  assistantBusy: false,
  actions
}

describe('createAppCommands', () => {
  it('builds searchable commands from current application data', () => {
    const application = createAppCommands(context).find((item) => item.id === 'application.apple-application')
    expect(application).toMatchObject({
      title: 'Apple',
      subtitle: 'Software Engineering Intern · Submitted · 2026-07-21',
      keywords: ['Software Engineering Intern', 'Submitted', 'Cupertino', '2026-07-21']
    })
  })

  it('explains why unavailable actions cannot run', () => {
    const commands = createAppCommands(context)
    expect(commands.find((item) => item.id === 'resume.open-pdf')?.disabledReason).toBe('Compile the resume first')
    expect(commands.find((item) => item.id === 'profile.general-swe')?.disabledReason).toBe('Current profile')
    expect(commands.find((item) => item.id === 'draft.apple-draft')?.disabledReason).toBe('Current draft')
  })

  it('exposes contextual draft and assistant actions only when applicable', () => {
    const activeCommands = createAppCommands(context).map((item) => item.id)
    expect(activeCommands).toContain('draft.promote')
    expect(activeCommands).toContain('assistant.new-chat')

    const inactiveCommands = createAppCommands({
      ...context,
      assistantConfigured: false,
      resume: { ...resume, jobDraft: { exists: false, active: false, id: null, name: null, drafts: [] } }
    }).map((item) => item.id)
    expect(inactiveCommands).not.toContain('draft.promote')
    expect(inactiveCommands).not.toContain('assistant.new-chat')
  })
})
