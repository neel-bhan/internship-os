import { homedir } from 'node:os'
import { join } from 'node:path'

export class AppPaths {
  readonly root: string
  readonly database: string
  readonly resumeRoot: string
  readonly profilesDir: string
  readonly activeProfileFile: string
  readonly internalPdf: string
  readonly publicPdf: string
  readonly archivesDir: string

  constructor(root?: string, downloadsDir?: string) {
    this.root = root ?? process.env.INTERNSHIP_OS_HOME ?? join(homedir(), 'Library', 'Application Support', 'Internship OS')
    const downloads = downloadsDir ?? process.env.INTERNSHIP_OS_DOWNLOADS ?? join(homedir(), 'Downloads')
    this.database = join(this.root, 'internship-os.sqlite3')
    this.resumeRoot = join(this.root, 'resumes')
    this.profilesDir = join(this.resumeRoot, 'profiles')
    this.activeProfileFile = join(this.resumeRoot, 'active-profile.json')
    this.internalPdf = join(this.resumeRoot, 'active', 'current.pdf')
    this.publicPdf = join(downloads, 'Neel_Bhansali_Resume.pdf')
    this.archivesDir = join(this.root, 'archives')
  }

  profileDir(profileId: string): string {
    return join(this.profilesDir, profileId)
  }

  sourceFile(profileId: string): string {
    return join(this.profileDir(profileId), 'main.tex')
  }

  profilePdf(profileId: string): string {
    return join(this.resumeRoot, 'compiled', profileId, 'current.pdf')
  }

  previewPdf(profileId: string): string {
    return join(this.resumeRoot, 'previews', profileId, 'latest.pdf')
  }

  jobDraftDir(profileId: string): string {
    return join(this.resumeRoot, 'job-drafts', profileId)
  }

  jobDraftSourceDir(profileId: string): string {
    return join(this.jobDraftDir(profileId), 'source')
  }

  jobDraftSourceFile(profileId: string): string {
    return join(this.jobDraftSourceDir(profileId), 'main.tex')
  }

  jobDraftPdf(profileId: string): string {
    return join(this.jobDraftDir(profileId), 'current.pdf')
  }

  jobDraftPreviewPdf(profileId: string): string {
    return join(this.jobDraftDir(profileId), 'latest-preview.pdf')
  }

  jobDraftMetadata(profileId: string): string {
    return join(this.jobDraftDir(profileId), 'draft.json')
  }

  jobDraftHistoryDir(profileId: string): string {
    return join(this.jobDraftDir(profileId), 'history', 'snapshots')
  }

  jobDraftCompileHistoryDir(profileId: string): string {
    return join(this.jobDraftDir(profileId), 'history', 'compiles')
  }

  jobDraftChangeReviewFile(profileId: string): string {
    return join(this.jobDraftDir(profileId), 'history', 'last-change.json')
  }

  jobDraftCandidatesDir(profileId: string): string {
    return join(this.jobDraftDir(profileId), 'candidates')
  }

  historyDir(profileId: string): string {
    return join(this.resumeRoot, 'history', profileId, 'snapshots')
  }

  compileHistoryDir(profileId: string): string {
    return join(this.resumeRoot, 'history', profileId, 'compiles')
  }

  changeReviewFile(profileId: string): string {
    return join(this.resumeRoot, 'history', profileId, 'last-change.json')
  }

  candidatesDir(profileId: string): string {
    return join(this.resumeRoot, 'candidates', profileId)
  }
}
