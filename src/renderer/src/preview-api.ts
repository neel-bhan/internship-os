import resumeSource from '../../../main.tex?raw'
import {
  RESUME_PROFILES,
  type ApplicationInput,
  type CodexState,
  type InternshipApplication,
  type InternshipOsApi,
  type ResumeState
} from '../../shared/types'

export function installBrowserPreviewApi(): void {
  let applications: InternshipApplication[] = []
  const profileSources = new Map(RESUME_PROFILES.map((profile) => [profile.id, resumeSource]))
  let resume: ResumeState = {
    source: resumeSource,
    sourcePath: '~/Library/Application Support/Internship OS/resumes/profiles/general-swe/main.tex',
    pdfPath: '~/Downloads/Neel_Bhansali_Resume.pdf',
    pdfRevision: null,
    hasPdf: false,
    activeProfileId: 'general-swe',
    profileName: 'General SWE',
    profiles: RESUME_PROFILES,
    lastCompile: { ok: true, pages: 1, compiler: 'pdflatex', message: 'Compiled successfully with pdflatex.', errors: [], compiledAt: new Date().toISOString() },
    lastChange: {
      summary: '2 lines rewritten',
      addedLines: 2,
      removedLines: 2,
      diff: '@@ old 114 · new 114 @@\n- Built REST APIs for internal services.\n+ Built fault-tolerant .NET REST APIs with advanced error handling.\n  \\resumeItemListEnd',
      changedAt: new Date().toISOString()
    }
  }
  let codex: CodexState = { available: true, connected: false, authenticated: false, accountLabel: 'Preview', threadId: null, editMode: 'review' }

  window.internshipOS = {
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
        const profile = RESUME_PROFILES.find((item) => item.id === profileId)
        if (!profile) throw new Error(`Unknown resume profile: ${profileId}`)
        resume = {
          ...resume,
          source: profileSources.get(profile.id) ?? resumeSource,
          sourcePath: `~/Library/Application Support/Internship OS/resumes/profiles/${profile.id}/main.tex`,
          activeProfileId: profile.id,
          profileName: profile.name,
          hasPdf: false,
          pdfRevision: null,
          lastCompile: null,
          lastChange: null
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
      openProfile: async () => undefined,
      send: async () => undefined,
      respondToApproval: async () => undefined,
      onEvent: () => () => undefined
    }
  } satisfies InternshipOsApi
}
