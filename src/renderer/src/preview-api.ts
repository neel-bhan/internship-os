import resumeSource from '../../../main.tex?raw'
import {
  RESUME_PROFILES,
  type ApplicationInput,
  type CodexState,
  type InternshipApplication,
  type InternshipOsApi,
  type ResumeState,
  type UserSettings
} from '../../shared/types'

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
    editMode: 'review'
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
      diff: '@@ old 114 · new 114 @@\n- Built REST APIs for internal services.\n+ Built fault-tolerant .NET REST APIs with advanced error handling.\n  \\resumeItemListEnd',
      changedAt: new Date().toISOString()
    }
  }
  let codex: CodexState = { provider: 'codex', providerName: 'Codex', available: true, connected: false, authenticated: false, accountLabel: 'Preview', threadId: null, editMode: 'review' }

  window.internshipOS = {
    onboarding: {
      getState: async () => ({
        settings: previewSettings,
        tools: [],
        legacyDataDetected: false
      }),
      refreshTools: async () => [],
      chooseResumeFile: async () => null,
      openAssistantSetup: async () => undefined,
      complete: async (input) => ({ settings: { version: 1, onboardingComplete: true, ...input }, tools: [], legacyDataDetected: false })
    },
    settings: {
      get: async () => ({
        settings: previewSettings,
        tools: [],
        legacyDataDetected: false
      }),
      save: async (input) => {
        previewSettings = { version: 1, onboardingComplete: true, ...input }
        for (const profile of input.resumeProfiles) if (!profileSources.has(profile.id)) profileSources.set(profile.id, resume.source)
        const activeProfile = input.resumeProfiles.find((profile) => profile.id === resume.activeProfileId) ?? input.resumeProfiles[0]
        resume = {
          ...resume,
          source: profileSources.get(activeProfile.id) ?? resumeSource,
          activeProfileId: activeProfile.id,
          profileName: activeProfile.name,
          profiles: input.resumeProfiles
        }
        codex = { ...codex, provider: input.assistantProvider, providerName: input.assistantProvider === 'claude' ? 'Claude' : input.assistantProvider === 'codex' ? 'Codex' : 'No assistant', editMode: input.editMode }
        return { settings: previewSettings, tools: [], legacyDataDetected: false }
      },
      refreshTools: async () => [],
      openAssistantSetup: async () => undefined
    },
    applications: {
      list: async () => applications,
      save: async (input: ApplicationInput) => {
        const now = new Date().toISOString()
        const item: InternshipApplication = { ...input, id: input.id ?? crypto.randomUUID(), createdAt: now, updatedAt: now, submissions: [] }
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
      openProfile: async () => undefined,
      listChats: async () => [],
      openChat: async (threadId: string) => ({ state: (codex = { ...codex, threadId }), messages: [] }),
      newChat: async () => ({ state: (codex = { ...codex, threadId: null }), messages: [] }),
      send: async () => undefined,
      respondToApproval: async () => undefined,
      onEvent: () => () => undefined
    }
  } satisfies InternshipOsApi
}
