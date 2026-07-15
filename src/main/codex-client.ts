import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import type { CodexChatMessage, CodexChatSummary, CodexConversation, CodexEditMode, CodexEvent, CodexState } from '../shared/types'
import { AppPaths } from './core/paths'

type EventSink = (event: CodexEvent) => void
const THREAD_INSTRUCTION_VERSION = 2

interface RpcMessage {
  id?: string | number
  method?: string
  params?: Record<string, any>
  result?: any
  error?: { message?: string }
}

export class CodexClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private requestId = 1
  private pending = new Map<string | number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private threadId: string | null = null
  private connected = false
  private authenticated = false
  private accountLabel = 'Not connected'
  private editMode: CodexEditMode = 'review'
  private error: string | undefined
  private eventSink: EventSink = () => undefined
  private knownThreadIds = new Set<string>()

  constructor(
    private readonly projectRoot: string,
    private readonly paths: AppPaths
  ) {
    mkdirSync(this.paths.root, { recursive: true })
    this.ensureCandidateProfile()
    this.editMode = this.readEditMode()
    this.threadId = this.readStoredThreadId()
    this.knownThreadIds = new Set(this.readChatIndex())
    if (this.threadId) this.registerThread(this.threadId)
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink
  }

  getState(): CodexState {
    return {
      available: Boolean(this.findCodex()),
      connected: this.connected,
      authenticated: this.authenticated,
      accountLabel: this.accountLabel,
      threadId: this.threadId,
      editMode: this.editMode,
      error: this.error
    }
  }

  async connect(): Promise<CodexState> {
    if (this.connected && this.process) return this.getState()
    const executable = this.findCodex()
    if (!executable) {
      this.error = 'Codex is not installed. Install Codex, then run `codex login`.'
      return this.getState()
    }

    this.eventSink({ type: 'status', text: 'Starting local Codex…' })
    this.process = spawn(executable, ['app-server'], {
      cwd: this.projectRoot,
      env: {
        ...process.env,
        INTERNSHIP_OS_HOME: this.paths.root,
        INTERNSHIP_OS_DOWNLOADS: dirname(this.paths.publicPdf)
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const lines = createInterface({ input: this.process.stdout })
    lines.on('line', (line) => this.handleLine(line))
    this.process.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (text) this.eventSink({ type: 'status', text })
    })
    this.process.on('error', (error) => {
      this.connected = false
      this.authenticated = false
      this.process = null
      this.error = `Could not start Codex: ${error.message}`
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      this.eventSink({ type: 'error', text: this.error })
    })
    this.process.on('exit', (code) => {
      this.connected = false
      this.process = null
      const error = new Error(`Codex exited${code == null ? '' : ` with code ${code}`}.`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      this.eventSink({ type: 'error', text: error.message })
    })

    try {
      await this.request('initialize', {
        clientInfo: { name: 'internship_os', title: 'Internship OS', version: '0.1.0' }
      })
      this.notify('initialized', {})
      this.connected = true
      const auth = await this.request('account/read', { refreshToken: false })
      this.authenticated = Boolean(auth?.account)
      this.accountLabel = auth?.account?.email ?? auth?.account?.type ?? (this.authenticated ? 'ChatGPT' : 'Signed out')
      if (!this.authenticated) {
        this.error = 'Sign in by running `codex login`, then reconnect.'
      } else {
        this.error = undefined
        if (this.threadId) {
          try {
            await this.request('thread/resume', { threadId: this.threadId })
          } catch {
            this.threadId = null
          }
        }
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    return this.getState()
  }

  async send(text: string): Promise<void> {
    if (!text.trim()) return
    const state = await this.connect()
    if (!state.authenticated) throw new Error(state.error ?? 'Codex is not authenticated.')
    const isFirstMessage = !this.threadId
    if (!this.threadId) await this.startThread()
    if (isFirstMessage && this.threadId) {
      await this.request('thread/name/set', { threadId: this.threadId, name: chatTitle(text) }).catch(() => undefined)
    }

    const profilePath = this.getProfilePath()
    const modeInstruction = this.editMode === 'auto'
      ? 'AUTO APPLY mode: complete requested resume and tracker edits end-to-end. For resume changes, use the candidate and promote workflow so compilation and one-page validation happen before promotion.'
      : 'REVIEW FIRST mode: do not modify resumes, candidates, application records, tracker data, or other project files. Inspect freely and return a concrete proposed change. The only file you may update is the durable candidate profile when the user supplies a new verified fact.'
    const requestText = `[Internship OS persistent context]\nRead ${JSON.stringify(profilePath)} before answering. Treat it as the durable source of verified candidate facts across chats. If this user message contains a new explicit fact, correction, durable preference, or constraint about the candidate, update that profile concisely. Never store claims inferred from a job description, AI output, or assumption. Never weaken or remove an existing fact without an explicit correction. Use the draft-list, draft-create, draft-select, draft-stop, and draft-delete commands documented in AGENTS.md whenever the user asks to manage temporary job drafts.\n\n${modeInstruction}\n\n[User request]\n${text}`

    await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: requestText }],
      cwd: this.projectRoot,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' }
    })
  }

  setEditMode(mode: CodexEditMode): CodexState {
    if (mode !== 'review' && mode !== 'auto') throw new Error('Unknown Codex edit mode.')
    this.editMode = mode
    writeFileSync(this.settingsPath(), JSON.stringify({ editMode: mode }, null, 2))
    return this.getState()
  }

  getProfilePath(): string {
    return join(this.paths.root, 'candidate-profile.md')
  }

  async listChats(): Promise<CodexChatSummary[]> {
    await this.requireAuthenticatedConnection()
    const result = await this.request('thread/list', {
      cwd: this.projectRoot,
      archived: false,
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc'
    })
    return (Array.isArray(result?.data) ? result.data : [])
      .filter((thread: any) => thread?.id && (thread.threadSource === 'internship_os' || this.knownThreadIds.has(String(thread.id))))
      .map((thread: any) => {
        const preview = extractUserRequest(String(thread.preview ?? '')).trim()
        return {
          id: String(thread.id),
          title: String(thread.name ?? '').trim() || chatTitle(preview),
          preview: preview.replace(/\s+/g, ' ').slice(0, 140),
          updatedAt: Number(thread.updatedAt ?? thread.createdAt ?? 0)
        }
      })
  }

  async openChat(threadId: string): Promise<CodexConversation> {
    await this.requireAuthenticatedConnection()
    const result = await this.request('thread/resume', { threadId })
    this.threadId = String(result?.thread?.id ?? threadId)
    this.registerThread(this.threadId)
    this.storeThreadId(this.threadId)
    return { state: this.getState(), messages: messagesFromThread(result?.thread) }
  }

  async newChat(): Promise<CodexConversation> {
    await this.requireAuthenticatedConnection()
    this.threadId = null
    this.storeThreadId(null)
    return { state: this.getState(), messages: [] }
  }

  respondToApproval(requestId: string | number, decision: 'accept' | 'decline'): void {
    this.write({ id: requestId, result: { decision } })
  }

  stop(): void {
    this.process?.kill()
    this.process = null
    this.connected = false
  }

  private async requireAuthenticatedConnection(): Promise<void> {
    const state = await this.connect()
    if (!state.authenticated) throw new Error(state.error ?? 'Codex is not authenticated.')
  }

  private async startThread(): Promise<void> {
    const result = await this.request('thread/start', {
      cwd: this.projectRoot,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      personality: 'friendly',
      serviceName: 'internship_os',
      threadSource: 'internship_os',
      developerInstructions:
        'Operate the local Internship OS using AGENTS.md. Complete clear requests end-to-end in one turn with no progress narration, permission questions, duplicate commands, or extra PDF rendering. Use the documented resume draft commands to list, create, select, stop, or delete job drafts when requested. Use candidate resume files, rely on resume promote for compilation and one-page validation, and never invent facts. When facts are missing, use clearly labeled TODO placeholders only when that preserves the user’s requested structure; otherwise ask one concise question in normal chat.'
    })
    const threadId = String(result.thread.id)
    this.threadId = threadId
    this.registerThread(threadId)
    this.storeThreadId(threadId)
  }

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.requestId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.write({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params })
  }

  private write(message: Record<string, unknown>): void {
    if (!this.process?.stdin.writable) throw new Error('Codex is not connected.')
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      this.eventSink({ type: 'status', text: line })
      return
    }

    if (message.id != null && !message.method && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex request failed.'))
      else pending.resolve(message.result)
      return
    }

    if (message.id != null && message.method?.endsWith('requestApproval')) {
      this.write({ id: message.id, result: { decision: 'accept' } })
      return
    }

    switch (message.method) {
      case 'item/agentMessage/delta':
        break
      case 'item/commandExecution/outputDelta':
      case 'command/exec/outputDelta':
        this.eventSink({ type: 'command-output', text: String(message.params?.delta ?? '') })
        break
      case 'turn/diff/updated':
        this.eventSink({ type: 'diff', text: String(message.params?.diff ?? '') })
        break
      case 'item/started': {
        break
      }
      case 'item/completed': {
        const item = message.params?.item
        if (item?.type === 'agentMessage' && item.text && item.phase !== 'commentary') {
          this.eventSink({ type: 'message', text: String(item.text) })
        }
        break
      }
      case 'turn/completed':
        this.eventSink({ type: 'turn-completed' })
        break
      case 'error':
        this.eventSink({ type: 'error', text: String(message.params?.message ?? 'Codex error') })
        break
    }
  }

  private findCodex(): string | null {
    const candidates = [
      process.env.CODEX_PATH,
      '/Applications/Codex.app/Contents/Resources/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex'
    ].filter(Boolean) as string[]
    return candidates.find(existsSync) ?? null
  }

  private settingsPath(): string {
    return join(this.paths.root, 'codex-settings.json')
  }

  private readEditMode(): CodexEditMode {
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath(), 'utf8')) as { editMode?: CodexEditMode }
      return parsed.editMode === 'auto' ? 'auto' : 'review'
    } catch {
      return 'review'
    }
  }

  private ensureCandidateProfile(): void {
    const path = this.getProfilePath()
    if (!existsSync(path)) writeFileSync(path, initialCandidateProfile())
  }

  private readStoredThreadId(): string | null {
    const path = join(this.paths.root, 'codex-thread.json')
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8')) as { threadId?: string; instructionVersion?: number }
      return stored.instructionVersion === THREAD_INSTRUCTION_VERSION ? stored.threadId ?? null : null
    } catch {
      return null
    }
  }

  private storeThreadId(threadId: string | null): void {
    writeFileSync(
      join(this.paths.root, 'codex-thread.json'),
      JSON.stringify({ threadId, instructionVersion: THREAD_INSTRUCTION_VERSION })
    )
  }

  private chatIndexPath(): string {
    return join(this.paths.root, 'codex-chats.json')
  }

  private readChatIndex(): string[] {
    try {
      const parsed = JSON.parse(readFileSync(this.chatIndexPath(), 'utf8')) as { threadIds?: unknown }
      return Array.isArray(parsed.threadIds) ? parsed.threadIds.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  private registerThread(threadId: string): void {
    if (this.knownThreadIds.has(threadId)) return
    this.knownThreadIds.add(threadId)
    writeFileSync(this.chatIndexPath(), JSON.stringify({ threadIds: [...this.knownThreadIds] }, null, 2))
  }
}

function extractUserRequest(text: string): string {
  const marker = '\n[User request]\n'
  const index = text.lastIndexOf(marker)
  return index >= 0 ? text.slice(index + marker.length) : text
}

function chatTitle(text: string): string {
  const title = extractUserRequest(text).trim().split(/\r?\n/, 1)[0].replace(/\s+/g, ' ')
  return title ? title.slice(0, 64) : 'New chat'
}

function messagesFromThread(thread: any): CodexChatMessage[] {
  const turns = Array.isArray(thread?.turns) ? [...thread.turns] : []
  turns.sort((left, right) => Number(left?.startedAt ?? 0) - Number(right?.startedAt ?? 0))
  const messages: CodexChatMessage[] = []

  for (const turn of turns) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item?.type === 'userMessage') {
        const text = (Array.isArray(item.content) ? item.content : [])
          .filter((content: any) => content?.type === 'text' && content.text)
          .map((content: any) => String(content.text))
          .join('\n')
        const request = extractUserRequest(text).trim()
        if (request) messages.push({ id: String(item.id), role: 'user', text: request })
      } else if (item?.type === 'agentMessage' && item.text && item.phase !== 'commentary') {
        messages.push({ id: String(item.id), role: 'assistant', text: String(item.text) })
      }
    }
  }
  return messages
}

function initialCandidateProfile(): string {
  return `# Neel Bhansali — Durable Candidate Profile

This local file is the source of verified candidate facts shared across Internship OS chats. Add only facts Neel explicitly supplies or facts already present in a verified resume. Never infer claims from job descriptions or AI suggestions.

## Goal and constraints

- Primary workflow: optimize applications for software engineering internships.
- Resume must remain readable and exactly one page.
- Never invent experience, metrics, dates, skills, credentials, employers, projects, or claims.
- Ask before changing resume spacing, margins, font size, section count, bullet count, or rendered line count.

## Identity and links

- Name: Neel Bhansali
- Portfolio: https://neelbhansali.com
- GitHub: https://github.com/neel-bhan
- LinkedIn: https://www.linkedin.com/in/neel-bhansali-506a42265/
- Email: neelbh99@gmail.com
- Phone: 817-659-4024

## Education

- University of Wisconsin–Madison, Madison, Wisconsin
- Bachelor of Science in Computer Science and Data Science
- GPA: 3.73
- Expected graduation: 2028

## Experience

### DraftKings — Software Engineer Intern
- Boston, MA · June 2026–August 2026
- Built a .NET service for a server-driven UI platform to validate, version, and serve dynamic CMS templates.
- Developed a drag-and-drop Template Builder that converts visual layouts into schema-valid JSON, validates templates upfront, persists version history, and feeds the live rendering pipeline.
- Implemented a Claude-powered agentic workflow to generate validated CMS templates from prompts.

### Represented Collective — Software Engineer Intern
- Madison, WI · September 2025–Present
- Developed a HIPAA-compliant mobile health application for asthma patients using React Native and Expo.
- Engineered an Express.js, Prisma, and PostgreSQL backend, containerized with Docker and deployed on AWS ECS/RDS, with JWT access control, audit logging, and strict validation pipelines.
- Implemented symptom tracking, medication adherence logging, and analytics dashboards.

### Mini Orange — Software Engineer Intern
- Dallas, TX · June 2025–August 2025
- Designed features for a secure web-based Active Directory management platform covering user, group, and OU administration, audit logging, and MFA-enabled self-service password resets.
- Created a React frontend with dynamic forms, organizational management modules, and configurable CAPTCHA.
- Built fault-tolerant .NET REST APIs with advanced error handling and monitoring pipelines.

### University of Texas at Dallas — Research Assistant
- Richardson, TX · May 2022–July 2022
- Worked with neural networks, CNNs, LSTMs, SVMs, reinforcement learning, and decision trees.
- Developed a machine-learning face recognition system for university security infrastructure.
- Performed data cleaning, feature engineering, and hyperparameter tuning with PyTorch.

## Projects and leadership

### College Resale Platform
- May 2025–August 2025
- University-exclusive textbook and sports-ticket marketplace with school-email verification, geolocation search, and scraped campus sporting events.
- Stack includes React, TypeScript, Vite, Tailwind CSS, Node.js, Express.js, PostgreSQL, JWT, REST APIs, AWS S3/RDS/ECS/Fargate/VPC, and WebSockets.
- Includes real-time bidding chat and notifications.

### Agentic Portfolio Updater
- August 2025–Present
- Agentic AI pipeline that detects GitHub repositories through webhooks, generates summaries with the OpenAI API, and submits pull requests to a Next.js/React portfolio.
- Uses structured JSON/YAML project schemas, automated stack detection and tagging, README image parsing, AWS SQS/Lambda/S3, GitHub Actions, rollback support, and PR validation.

### AIFA (AI FOR ALL)
- September 2022–Present
- Developed AI educational modules and facilitated workshops.
- Organized hackathons with 200+ students, $2,000+ in prizes, and sponsors including Google, GitHub, and Keurig.

## Verified skills

- Languages: Java, Python, JavaScript, TypeScript, C#, SQL
- Cloud: AWS Lambda, S3, ECS, RDS, VPC, Fargate
- Frameworks and libraries: React, React Native, Expo, Node.js, Express, Tailwind CSS, PyTorch, Pandas, NumPy, Prisma
- Data and infrastructure: PostgreSQL, MongoDB, Docker, Git, GitHub Actions, REST APIs, WebSockets, JWT
- AI tooling: OpenAI API, Claude-powered agentic workflows

## Durable preferences and new verified facts

- Add future facts, corrections, target-role preferences, and constraints here with the date learned.
`
}
