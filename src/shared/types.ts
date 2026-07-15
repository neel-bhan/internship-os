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

export const DEFAULT_RESUME_PROFILES: ResumeProfile[] = [
  { id: 'general-swe', name: 'General SWE', focus: 'Balanced software engineering' },
  { id: 'backend', name: 'Backend', focus: 'APIs, systems, data, and cloud' },
  { id: 'full-stack', name: 'Full Stack', focus: 'End-to-end frontend and backend work' },
  { id: 'ai-ml', name: 'AI / ML', focus: 'Machine learning and AI systems' },
  { id: 'quant', name: 'Quant', focus: 'Python, data, algorithms, and reliability' }
]

// Kept as a compatibility alias for the browser preview and existing imports.
export const RESUME_PROFILES = DEFAULT_RESUME_PROFILES

export type AssistantProviderId = 'codex' | 'claude' | 'none'
export type CodexReasoningEffort = 'low' | 'medium' | 'high'

export const CODEX_MODEL_OPTIONS = [
  { id: 'gpt-5.6-luna', name: 'Fast', description: 'Fast everyday agentic work' },
  { id: 'gpt-5.6-terra', name: 'Balanced', description: 'Balanced everyday agentic work' },
  { id: 'gpt-5.6-sol', name: 'Frontier', description: 'Deepest current agentic coding model' },
  { id: 'gpt-5.5', name: 'Complex work', description: 'Complex coding and research' },
  { id: 'gpt-5.4', name: 'Everyday', description: 'Strong everyday coding model' },
  { id: 'gpt-5.4-mini', name: 'Light', description: 'Small and fast for simple work' }
] as const

export interface CandidateIdentity {
  fullName: string
  email: string
  phone: string
  portfolio: string
  github: string
  linkedin: string
}

export interface UserSettings {
  version: number
  onboardingComplete: boolean
  identity: CandidateIdentity
  exportFilename: string
  resumeProfiles: ResumeProfile[]
  assistantProvider: AssistantProviderId
  editMode: CodexEditMode
  codexModel: string
  codexReasoningEffort: CodexReasoningEffort
}

export interface ToolCheck {
  id: 'codex' | 'claude' | 'latex'
  available: boolean
  executable: string | null
  version: string | null
  authenticated?: boolean
  message: string
}

export interface OnboardingState {
  settings: UserSettings
  tools: ToolCheck[]
  legacyDataDetected: boolean
}

export interface OnboardingInput {
  identity: CandidateIdentity
  exportFilename: string
  resumeProfiles: ResumeProfile[]
  assistantProvider: AssistantProviderId
  editMode: CodexEditMode
  codexModel?: string
  codexReasoningEffort?: CodexReasoningEffort
  resumeSource?: string
}

export type SettingsInput = Omit<OnboardingInput, 'resumeSource'>

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
  id: string | null
  name: string | null
  drafts: ResumeJobDraft[]
}

export interface ResumeJobDraft {
  id: string
  name: string
  createdAt: string
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
  provider: AssistantProviderId
  providerName: string
  available: boolean
  connected: boolean
  authenticated: boolean
  accountLabel: string
  threadId: string | null
  editMode: CodexEditMode
  model?: string
  reasoningEffort?: CodexReasoningEffort
  error?: string
}

export interface CodexChatSummary {
  id: string
  title: string
  preview: string
  updatedAt: number
}

export interface CodexChatMessage {
  id: string
  role: 'user' | 'assistant' | 'diff'
  text: string
}

export interface CodexConversation {
  state: CodexState
  messages: CodexChatMessage[]
}

export interface InternshipOsApi {
  onboarding: {
    getState(): Promise<OnboardingState>
    refreshTools(): Promise<ToolCheck[]>
    chooseResumeFile(): Promise<{ name: string; source: string } | null>
    openAssistantSetup(provider: Exclude<AssistantProviderId, 'none'>): Promise<void>
    complete(input: OnboardingInput): Promise<OnboardingState>
  }
  settings: {
    get(): Promise<OnboardingState>
    save(input: SettingsInput): Promise<OnboardingState>
    refreshTools(): Promise<ToolCheck[]>
    openAssistantSetup(provider: Exclude<AssistantProviderId, 'none'>): Promise<void>
  }
  applications: {
    list(): Promise<InternshipApplication[]>
    save(input: ApplicationInput): Promise<InternshipApplication[]>
    remove(id: string): Promise<InternshipApplication[]>
  }
  resume: {
    get(): Promise<ResumeState>
    readPdf(): Promise<ArrayBuffer | null>
    selectProfile(profileId: string): Promise<ResumeState>
    createJobDraft(name: string, profileId?: string): Promise<ResumeState>
    selectJobDraft(draftId: string | null): Promise<ResumeState>
    discardJobDraft(draftId: string): Promise<ResumeState>
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
    setModelSettings(model: string, reasoningEffort: CodexReasoningEffort): Promise<CodexState>
    openProfile(): Promise<void>
    listChats(): Promise<CodexChatSummary[]>
    openChat(threadId: string): Promise<CodexConversation>
    newChat(): Promise<CodexConversation>
    send(text: string): Promise<void>
    respondToApproval(requestId: string | number, decision: 'accept' | 'decline'): Promise<void>
    onEvent(callback: (event: CodexEvent) => void): () => void
  }
}
