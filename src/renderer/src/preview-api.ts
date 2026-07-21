import resumeSource from '../../../main.tex?raw'
import {
  RESUME_PROFILES,
  type ApplicationInput,
  type CodexEvent,
  type CodexState,
  type InternshipApplication,
  type InternshipOsApi,
  type ResumeState,
  type UserSettings
} from '../../shared/types'

function localDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function installBrowserPreviewApi(): void {
  let applications: InternshipApplication[] = []
  const profileSources = new Map(RESUME_PROFILES.map((profile) => [profile.id, resumeSource]))
  let previewSettings: UserSettings = {
    version: 1,
    onboardingComplete: true,
    identity: { fullName: 'Preview User', email: '', phone: '', portfolio: '', github: '', linkedin: '' },
    exportFilename: 'Preview_User_Resume.pdf',
    resumeProfiles: RESUME_PROFILES,
    assistantProvider: 'codex',
    editMode: 'review',
    codexModel: 'gpt-5.6-luna',
    codexReasoningEffort: 'low'
  }
  let resume: ResumeState = {
    source: resumeSource,
    sourcePath: '~/Library/Application Support/Internship OS/resumes/profiles/general-swe/main.tex',
    pdfPath: '~/Downloads/Preview_User_Resume.pdf',
    pdfRevision: null,
    hasPdf: false,
    activeProfileId: 'general-swe',
    profileName: 'General SWE',
    profiles: RESUME_PROFILES,
    jobDraft: { exists: false, active: false, id: null, name: null, drafts: [] },
    lastCompile: { ok: true, pages: 1, compiler: 'pdflatex', message: 'Compiled successfully with pdflatex.', errors: [], compiledAt: new Date().toISOString() },
    lastChange: {
      summary: '2 lines rewritten',
      addedLines: 2,
      removedLines: 2,
      diff: '@@ old 28 · new 28 @@\n-   \\item Built REST APIs for internal services.\n+   \\item Replace this text with a verified accomplishment.\n    \\item Keep every claim factual, specific, and concise.',
      changedAt: new Date().toISOString()
    }
  }
  let codexEventSink: (event: CodexEvent) => void = () => undefined
  let codex: CodexState = { provider: 'codex', providerName: 'Codex', available: true, connected: true, authenticated: true, accountLabel: 'preview@example.com', threadId: 'preview-chat', editMode: 'review', model: previewSettings.codexModel, reasoningEffort: previewSettings.codexReasoningEffort }

  window.internshipOS = {
    onboarding: {
      getState: async () => ({
        settings: previewSettings,
        tools: [],
        legacyDataDetected: false,
        freshWorkspace: false
      }),
      refreshTools: async () => [],
      chooseResumeFile: async () => null,
      openAssistantSetup: async () => undefined,
      complete: async (input) => ({ settings: { version: 1, onboardingComplete: true, ...input, codexModel: input.codexModel ?? 'gpt-5.6-luna', codexReasoningEffort: input.codexReasoningEffort ?? 'low' }, tools: [], legacyDataDetected: false, freshWorkspace: false })
    },
    settings: {
      get: async () => ({
        settings: previewSettings,
        tools: [],
        legacyDataDetected: false,
        freshWorkspace: false
      }),
      save: async (input) => {
        previewSettings = { version: 1, onboardingComplete: true, ...input, codexModel: input.codexModel ?? 'gpt-5.6-luna', codexReasoningEffort: input.codexReasoningEffort ?? 'low' }
        for (const profile of input.resumeProfiles) if (!profileSources.has(profile.id)) profileSources.set(profile.id, resume.source)
        const activeProfile = input.resumeProfiles.find((profile) => profile.id === resume.activeProfileId) ?? input.resumeProfiles[0]
        resume = {
          ...resume,
          source: profileSources.get(activeProfile.id) ?? resumeSource,
          activeProfileId: activeProfile.id,
          profileName: activeProfile.name,
          profiles: input.resumeProfiles
        }
        codex = { ...codex, provider: input.assistantProvider, providerName: input.assistantProvider === 'claude' ? 'Claude' : input.assistantProvider === 'codex' ? 'Codex' : 'No assistant', editMode: input.editMode, model: previewSettings.codexModel, reasoningEffort: previewSettings.codexReasoningEffort }
        return { settings: previewSettings, tools: [], legacyDataDetected: false, freshWorkspace: false }
      },
      refreshTools: async () => [],
      openAssistantSetup: async () => undefined
    },
    applications: {
      list: async () => applications,
      save: async (input: ApplicationInput) => {
        const now = new Date().toISOString()
        const existing = input.id ? applications.find((application) => application.id === input.id) : undefined
        const item: InternshipApplication = {
          ...input,
          id: input.id ?? crypto.randomUUID(),
          dateApplied: input.dateApplied || (input.status === 'Submitted' ? localDate() : null),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          submissions: existing?.submissions ?? []
        }
        applications = [item, ...applications.filter((application) => application.id !== item.id)]
        return applications
      },
      remove: async (id: string) => (applications = applications.filter((application) => application.id !== id))
    },
    resume: {
      get: async () => resume,
      readPdf: async () => null,
      selectProfile: async (profileId: string) => {
        const profile = resume.profiles.find((item) => item.id === profileId)
        if (!profile) throw new Error(`Unknown resume profile: ${profileId}`)
        resume = {
          ...resume,
          source: profileSources.get(profile.id) ?? resumeSource,
          sourcePath: `~/Library/Application Support/Internship OS/resumes/profiles/${profile.id}/main.tex`,
          activeProfileId: profile.id,
          profileName: profile.name,
          hasPdf: false,
          pdfRevision: null,
          jobDraft: { exists: false, active: false, id: null, name: null, drafts: [] },
          lastCompile: null,
          lastChange: null
        }
        return resume
      },
      createJobDraft: async (name: string, profileId?: string) => {
        const profile = resume.profiles.find((item) => item.id === profileId) ?? resume.profiles.find((item) => item.id === resume.activeProfileId)!
        const draft = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() }
        resume = { ...resume, activeProfileId: profile.id, profileName: profile.name, jobDraft: { exists: true, active: true, id: draft.id, name, drafts: [draft, ...resume.jobDraft.drafts] } }
        return resume
      },
      selectJobDraft: async (draftId: string | null) => {
        const draft = resume.jobDraft.drafts.find((item) => item.id === draftId) ?? null
        resume = { ...resume, jobDraft: { ...resume.jobDraft, active: Boolean(draft), id: draft?.id ?? null, name: draft?.name ?? null } }
        return resume
      },
      discardJobDraft: async (draftId: string) => {
        const drafts = resume.jobDraft.drafts.filter((draft) => draft.id !== draftId)
        const removedActive = resume.jobDraft.id === draftId
        resume = { ...resume, jobDraft: { exists: drafts.length > 0, active: removedActive ? false : resume.jobDraft.active, id: removedActive ? null : resume.jobDraft.id, name: removedActive ? null : resume.jobDraft.name, drafts } }
        return resume
      },
      promoteJobDraft: async (source?: string) => {
        const promotedSource = source ?? resume.source
        const drafts = resume.jobDraft.drafts.filter((draft) => draft.id !== resume.jobDraft.id)
        profileSources.set(resume.activeProfileId, promotedSource)
        resume = {
          ...resume,
          source: promotedSource,
          jobDraft: { exists: drafts.length > 0, active: false, id: null, name: null, drafts },
          lastCompile: { ok: true, pages: 1, compiler: 'pdflatex', message: `${resume.jobDraft.name ?? 'Draft'} is now the ${resume.profileName} main resume.`, errors: [], compiledAt: new Date().toISOString() }
        }
        return resume
      },
      saveAndCompile: async (source: string) => {
        const changedAt = new Date().toISOString()
        profileSources.set(resume.activeProfileId, source)
        resume = {
          ...resume,
          source,
          lastChange: source === resume.source ? resume.lastChange : {
            summary: '1 line rewritten',
            addedLines: 1,
            removedLines: 1,
            diff: '- Previous line\n+ Updated line',
            changedAt
          }
        }
        return resume
      },
      compile: async () => resume,
      undo: async () => resume,
      openPdf: async () => undefined,
      revealPdf: async () => undefined,
      archive: async () => '~/Library/Application Support/Internship OS/archives/manual'
    },
    codex: {
      getState: async () => codex,
      connect: async () => codex,
      setEditMode: async (editMode) => (codex = { ...codex, editMode }),
      setModelSettings: async (model, reasoningEffort) => {
        previewSettings = { ...previewSettings, codexModel: model, codexReasoningEffort: reasoningEffort }
        return (codex = { ...codex, model, reasoningEffort })
      },
      openProfile: async () => undefined,
      listChats: async () => [],
      openChat: async (threadId: string) => ({ state: (codex = { ...codex, threadId }), messages: [] }),
      newChat: async () => ({ state: (codex = { ...codex, threadId: null }), messages: [] }),
      send: async () => {
        queueMicrotask(() => {
          codexEventSink({ type: 'activity', activity: { id: 'preview-commentary', kind: 'commentary', title: 'Codex update', text: 'I’m checking the active resume and preparing the requested change.', output: '', status: 'completed' } })
          codexEventSink({ type: 'activity', activity: { id: 'preview-command', kind: 'command', title: 'Ran command', text: 'internship-os resume prepare', output: 'Prepared candidate source.\nCompiled successfully: 1 page.', detail: '~/Library/Application Support/Internship OS/assistant-workspace', status: 'completed', durationMs: 842, exitCode: 0 } })
          codexEventSink({ type: 'activity', activity: { id: 'preview-file', kind: 'file', title: 'Changed 1 file', text: 'update resume-candidate/main.tex', output: '', status: 'completed' } })
          codexEventSink({ type: 'diff', text: 'diff --git a/resume.tex b/resume.tex\n--- a/resume.tex\n+++ b/resume.tex\n@@ -12,1 +12,1 @@\n-Old resume bullet\n+Updated resume bullet' })
          codexEventSink({ type: 'message', text: '### Replacement\n\n**AIFA (AI For All)**\n\n- Created AI-focused educational modules and led interactive workshops.\n- Organized hackathons for 200+ students with $2,000+ in prizes.\n\n### Why this works\n\nThe wording is direct and keeps the verified impact visible.' })
          codexEventSink({ type: 'turn-completed' })
        })
      },
      interrupt: async () => {
        queueMicrotask(() => codexEventSink({ type: 'turn-completed' }))
      },
      respondToApproval: async () => undefined,
      onEvent: (callback) => {
        codexEventSink = callback
        return () => { codexEventSink = () => undefined }
      }
    }
  } satisfies InternshipOsApi
}
