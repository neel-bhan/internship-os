import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ApplicationStore } from '../main/core/database'
import { AppPaths } from '../main/core/paths'
import { ResumeManager } from '../main/core/resume'
import type { ApplicationInput, ApplicationStatus } from '../shared/types'

const args = process.argv.slice(2)
const [area, action] = args
const flags = parseFlags(args.slice(2))
const paths = new AppPaths()
const defaultSource = findDefaultSource()
const store = new ApplicationStore(paths.database)
const resume = new ResumeManager(paths, defaultSource)
resume.initialize()

try {
  if (area === 'application') await applicationCommand(action, flags)
  else if (area === 'resume') await resumeCommand(action, flags)
  else usage()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  store.close()
}

async function applicationCommand(actionName: string | undefined, values: Record<string, string>): Promise<void> {
  if (actionName === 'list') return output(store.list())
  if (actionName === 'delete') {
    requireFlag(values, 'id')
    store.remove(values.id)
    return output({ ok: true })
  }

  if (actionName !== 'add' && actionName !== 'update') return usage()
  const existing = actionName === 'update' ? store.get(requireFlag(values, 'id')) : null
  if (actionName === 'update' && !existing) throw new Error(`Application not found: ${values.id}`)

  const status = (values.status ?? existing?.status ?? 'In Progress') as ApplicationStatus
  if (!['Submitted', 'In Progress', 'Rejected'].includes(status)) {
    throw new Error('Status must be Submitted, In Progress, or Rejected.')
  }

  const input: ApplicationInput = {
    id: existing?.id,
    company: values.company ?? existing?.company ?? '',
    position: values.position ?? existing?.position ?? '',
    dateApplied: values['date-applied'] ?? existing?.dateApplied ?? null,
    status,
    details: values.details ?? existing?.details ?? ''
  }
  if (!input.company || !input.position) throw new Error('Company and position are required.')
  if (status === 'Submitted' && !input.dateApplied) input.dateApplied = localDate()

  const shouldArchive = status === 'Submitted' && existing?.status !== 'Submitted'
  const applicationId = input.id ?? crypto.randomUUID()
  input.id = applicationId
  const submission = shouldArchive ? resume.archiveForApplication(input, applicationId) : undefined
  output(store.save(input, submission))
}

async function resumeCommand(actionName: string | undefined, values: Record<string, string>): Promise<void> {
  if (actionName === 'state') return output(resume.getState())
  if (actionName === 'profiles') return output(resume.listProfiles())
  if (actionName === 'select') return output(resume.selectProfile(requireFlag(values, 'profile')))
  if (actionName === 'prepare') return output({ candidatePath: resume.prepareCandidate() })
  if (actionName === 'promote') {
    const path = resolve(requireFlag(values, 'path'))
    return output(await resume.compileCandidateFile(path))
  }
  if (actionName === 'compile') return output(await resume.compile())
  if (actionName === 'undo') return output(resume.undo())
  if (actionName === 'archive') return output({ archivePath: resume.archiveManual() })
  usage()
}

function parseFlags(tokens: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const value = tokens[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`)
    result[name] = value
    index += 1
  }
  return result
}

function requireFlag(values: Record<string, string>, name: string): string {
  const value = values[name]
  if (!value) throw new Error(`--${name} is required.`)
  return value
}

function findDefaultSource(): string {
  const candidates = [resolve('main.tex'), resolve(process.env.INIT_CWD ?? '', 'main.tex')]
  return candidates.find(existsSync) ?? candidates[0]
}

function localDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function output(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function usage(): never {
  throw new Error(`Usage:
  npm run ios -- application list
  npm run ios -- application add --company NAME --position ROLE [--status STATUS] [--date-applied YYYY-MM-DD] [--details TEXT]
  npm run ios -- application update --id ID [fields]
  npm run ios -- application delete --id ID
  npm run ios -- resume state|profiles|prepare|compile|undo|archive
  npm run ios -- resume select --profile general-swe|backend|full-stack|ai-ml|quant
  npm run ios -- resume promote --path CANDIDATE_TEX`)
}
