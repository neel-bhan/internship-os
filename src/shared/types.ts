export const APPLICATION_STATUSES = ['Submitted', 'In Progress', 'Rejected'] as const

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

export interface InternshipApplication {
  id: string
  company: string
  position: string
  dateApplied: string | null
  status: ApplicationStatus
  details: string
  createdAt: string
  updatedAt: string
  submissions: Submission[]
}

export interface ApplicationInput {
  id?: string
  company: string
  position: string
  dateApplied: string | null
  status: ApplicationStatus
  details: string
}

export interface Submission {
  id: string
  applicationId: string
  archivePath: string
  createdAt: string
}

export interface ResumeProfile {
  id: string
  name: string
  focus: string
}

export const RESUME_PROFILES: ResumeProfile[] = [
  { id: 'general-swe', name: 'General SWE', focus: 'Balanced software engineering' },
  { id: 'backend', name: 'Backend', focus: 'APIs, systems, data, and cloud' },
  { id: 'full-stack', name: 'Full Stack', focus: 'End-to-end frontend and backend work' },
  { id: 'ai-ml', name: 'AI / ML', focus: 'Machine learning and AI systems' },
  { id: 'quant', name: 'Quant', focus: 'Python, data, algorithms, and reliability' }
]

export interface ResumeState {
  source: string
  sourcePath: string
  pdfPath: string
  pdfRevision: string | null
  hasPdf: boolean
  activeProfileId: string
  profileName: string
  profiles: ResumeProfile[]
  jobDraft: ResumeJobDraftState
  lastCompile: CompileResult | null
  lastChange: ResumeChangeReview | null
}

export interface ResumeJobDraftState {
  exists: boolean
  active: boolean
  name: string | null
}

export interface ResumeChangeReview {
  summary: string
  addedLines: number
  removedLines: number
  diff: string
  changedAt: string
}

export interface CompileResult {
  ok: boolean
  pages?: number
  compiler?: string
  message: string
  errors: string[]
  compiledAt: string
}

export type CodexEvent =
  | { type: 'status'; text: string }
  | { type: 'message-delta'; text: string }
  | { type: 'message'; text: string }
  | { type: 'command'; text: string }
  | { type: 'command-output'; text: string }
  | { type: 'diff'; text: string }
  | { type: 'turn-completed' }
  | { type: 'error'; text: string }
  | { type: 'approval'; requestId: string | number; method: string; summary: string }

export type CodexEditMode = 'review' | 'auto'

export interface CodexState {
  available: boolean
  connected: boolean
  authenticated: boolean
  accountLabel: string
  threadId: string | null
  editMode: CodexEditMode
  error?: string
}

export interface InternshipOsApi {
  applications: {
    list(): Promise<InternshipApplication[]>
    save(input: ApplicationInput): Promise<InternshipApplication[]>
    remove(id: string): Promise<InternshipApplication[]>
  }
  resume: {
    get(): Promise<ResumeState>
    readPdf(): Promise<ArrayBuffer | null>
    selectProfile(profileId: string): Promise<ResumeState>
    createJobDraft(name: string, replace?: boolean): Promise<ResumeState>
    setJobDraftActive(active: boolean): Promise<ResumeState>
    discardJobDraft(): Promise<ResumeState>
    saveAndCompile(source: string): Promise<ResumeState>
    compile(): Promise<ResumeState>
    undo(): Promise<ResumeState>
    openPdf(): Promise<void>
    revealPdf(): Promise<void>
    archive(): Promise<string>
  }
  codex: {
    getState(): Promise<CodexState>
    connect(): Promise<CodexState>
    setEditMode(mode: CodexEditMode): Promise<CodexState>
    openProfile(): Promise<void>
    send(text: string): Promise<void>
    respondToApproval(requestId: string | number, decision: 'accept' | 'decline'): Promise<void>
    onEvent(callback: (event: CodexEvent) => void): () => void
  }
}
