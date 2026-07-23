import type { InternshipApplication, ResumeState } from '../../shared/types'
import type { CommandPaletteItem } from './command-palette'

export interface AppCommandActions {
  showResume: () => void
  showTracker: () => void
  openSettings: () => void
  openStats: () => void
  toggleTheme: () => void
  openAssistant: () => void
  startNewChat: () => void | Promise<void>
  saveAndCompile: () => void | Promise<void>
  compile: () => void | Promise<void>
  undo: () => void | Promise<void>
  openPdf: () => void | Promise<void>
  revealPdf: () => void | Promise<void>
  archiveResume: () => void | Promise<void>
  createDraft: () => void
  selectProfile: (profileId: string) => void | Promise<void>
  selectDraft: (draftId: string | null) => void | Promise<void>
  promoteDraft: () => void | Promise<void>
  addApplication: () => void
  showApplication: (applicationId: string) => void
}

export interface AppCommandContext {
  applications: InternshipApplication[]
  resume: ResumeState | null
  busy: boolean
  theme: 'light' | 'dark'
  assistantName: string
  assistantConfigured: boolean
  assistantReady: boolean
  assistantBusy: boolean
  actions: AppCommandActions
}

export function createAppCommands(context: AppCommandContext): CommandPaletteItem[] {
  const { actions, applications, resume } = context
  const busyReason = context.busy ? 'Another action is still running' : undefined
  const resumeActionReason = busyReason ?? (resume ? undefined : 'Resume is still loading')
  const pdfReason = context.busy
    ? busyReason
    : !resume
      ? 'Resume is still loading'
      : resume.hasPdf
        ? undefined
        : 'Compile the resume first'

  const commands: CommandPaletteItem[] = [
    {
      id: 'navigation.resume',
      title: 'Open Resume',
      subtitle: 'Resume editor and PDF preview',
      group: 'Navigation',
      kind: 'navigation',
      keywords: ['editor', 'latex', 'pdf'],
      shortcut: '⌘1',
      suggested: true,
      priority: 100,
      run: actions.showResume
    },
    {
      id: 'navigation.tracker',
      title: 'Open Tracker',
      subtitle: `${applications.length} application${applications.length === 1 ? '' : 's'}`,
      group: 'Navigation',
      kind: 'navigation',
      keywords: ['applications', 'jobs'],
      shortcut: '⌘2',
      suggested: true,
      priority: 95,
      run: actions.showTracker
    },
    {
      id: 'application.add',
      title: 'Add Application',
      subtitle: 'Create a new tracker entry',
      group: 'Applications',
      kind: 'application',
      keywords: ['new job company position'],
      suggested: true,
      priority: 90,
      run: actions.addApplication
    },
    {
      id: 'resume.save-compile',
      title: 'Save & Compile Resume',
      subtitle: resume?.profileName ?? 'Current resume profile',
      group: 'Resume actions',
      kind: 'resume',
      keywords: ['save build pdf latex'],
      shortcut: '⌘S',
      disabledReason: resumeActionReason,
      suggested: true,
      priority: 85,
      run: actions.saveAndCompile
    },
    {
      id: 'assistant.open',
      title: context.assistantConfigured ? `Open ${context.assistantName}` : 'Set Up Assistant',
      subtitle: context.assistantConfigured ? 'Open the AI conversation' : 'Choose Codex or Claude in Settings',
      group: 'Assistant',
      kind: 'assistant',
      keywords: ['ai chat help codex claude'],
      shortcut: '⌥Space',
      suggested: true,
      priority: 80,
      run: actions.openAssistant
    },
    {
      id: 'navigation.settings',
      title: 'Open Settings',
      subtitle: 'Identity, resume formats, and assistant',
      group: 'Preferences',
      kind: 'settings',
      keywords: ['preferences profile configuration'],
      suggested: true,
      priority: 45,
      run: actions.openSettings
    },
    {
      id: 'navigation.stats',
      title: 'View Application Stats',
      subtitle: 'Submission totals and activity',
      group: 'Applications',
      kind: 'application',
      keywords: ['analytics chart heatmap'],
      priority: 40,
      run: actions.openStats
    },
    {
      id: 'preference.theme',
      title: `Switch to ${context.theme === 'dark' ? 'Light' : 'Dark'} Mode`,
      subtitle: 'Change the app appearance',
      group: 'Preferences',
      kind: 'theme',
      keywords: ['theme appearance color'],
      priority: 30,
      run: actions.toggleTheme
    },
    {
      id: 'resume.compile',
      title: 'Compile Without Saving',
      subtitle: 'Rebuild the current resume PDF',
      group: 'Resume actions',
      kind: 'resume',
      keywords: ['build pdf latex'],
      disabledReason: resumeActionReason,
      priority: 60,
      run: actions.compile
    },
    {
      id: 'resume.undo',
      title: 'Undo Resume Change',
      subtitle: 'Restore the previous saved resume state',
      group: 'Resume actions',
      kind: 'resume',
      keywords: ['revert restore'],
      disabledReason: resumeActionReason,
      priority: 55,
      run: actions.undo
    },
    {
      id: 'resume.open-pdf',
      title: 'Open Resume PDF',
      subtitle: 'Open the compiled PDF',
      group: 'Resume actions',
      kind: 'resume',
      keywords: ['view preview'],
      disabledReason: pdfReason,
      priority: 50,
      run: actions.openPdf
    },
    {
      id: 'resume.reveal-pdf',
      title: 'Reveal Resume PDF in Finder',
      subtitle: 'Show the compiled file on disk',
      group: 'Resume actions',
      kind: 'resume',
      keywords: ['file folder locate'],
      disabledReason: pdfReason,
      priority: 45,
      run: actions.revealPdf
    },
    {
      id: 'resume.archive',
      title: 'Archive Resume Snapshot',
      subtitle: 'Preserve the current compiled resume',
      group: 'Resume actions',
      kind: 'resume',
      keywords: ['save copy backup'],
      disabledReason: pdfReason,
      priority: 40,
      run: actions.archiveResume
    },
    {
      id: 'draft.create',
      title: 'Create Job Draft',
      subtitle: 'Start a temporary job-specific resume',
      group: 'Drafts',
      kind: 'draft',
      keywords: ['new tailored resume'],
      disabledReason: resumeActionReason,
      priority: 55,
      run: actions.createDraft
    }
  ]

  if (context.assistantConfigured) {
    commands.push({
      id: 'assistant.new-chat',
      title: `Start New ${context.assistantName} Chat`,
      subtitle: 'Begin a fresh Internship OS conversation',
      group: 'Assistant',
      kind: 'assistant',
      keywords: ['ai conversation clear'],
      disabledReason: context.assistantReady
        ? context.assistantBusy
          ? `${context.assistantName} is still working`
          : undefined
        : `Connect ${context.assistantName} first`,
      priority: 45,
      run: actions.startNewChat
    })
  }

  for (const application of applications) {
    commands.push({
      id: `application.${application.id}`,
      title: application.company,
      subtitle: [application.position, application.status, application.dateApplied].filter(Boolean).join(' · '),
      group: 'Applications',
      kind: 'application',
      keywords: [application.position, application.status, application.details, application.dateApplied ?? ''],
      run: () => actions.showApplication(application.id)
    })
  }

  for (const profile of resume?.profiles ?? []) {
    commands.push({
      id: `profile.${profile.id}`,
      title: profile.name,
      subtitle: profile.id === resume?.activeProfileId ? `Current profile · ${profile.focus}` : profile.focus,
      group: 'Resume profiles',
      kind: 'profile',
      keywords: ['resume format template', profile.focus],
      disabledReason: profile.id === resume?.activeProfileId ? 'Current profile' : busyReason,
      run: () => actions.selectProfile(profile.id)
    })
  }

  for (const draft of resume?.jobDraft.drafts ?? []) {
    commands.push({
      id: `draft.${draft.id}`,
      title: draft.name,
      subtitle: draft.id === resume?.jobDraft.id ? 'Current job draft' : `Job draft · ${formatCreatedAt(draft.createdAt)}`,
      group: 'Drafts',
      kind: 'draft',
      keywords: ['tailored resume'],
      disabledReason: draft.id === resume?.jobDraft.id ? 'Current draft' : busyReason,
      run: () => actions.selectDraft(draft.id)
    })
  }

  if (resume?.jobDraft.active) {
    commands.push(
      {
        id: 'draft.stop',
        title: 'Return to Main Resume',
        subtitle: `Leave ${resume.jobDraft.name ?? 'the current draft'}`,
        group: 'Drafts',
        kind: 'draft',
        keywords: ['stop close exit template'],
        disabledReason: busyReason,
        run: () => actions.selectDraft(null)
      },
      {
        id: 'draft.promote',
        title: 'Make Draft the Main Resume',
        subtitle: 'Promote the current draft with an undo snapshot',
        group: 'Drafts',
        kind: 'draft',
        keywords: ['promote replace'],
        disabledReason: busyReason,
        run: actions.promoteDraft
      }
    )
  }

  return commands
}

function formatCreatedAt(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Saved draft'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
