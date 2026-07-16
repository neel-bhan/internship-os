import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { delimiter, dirname, join } from 'node:path'
import type { CodexActivity, CodexActivityStatus, CodexChatMessage, CodexChatSummary, CodexConversation, CodexEditMode, CodexEvent, CodexReasoningEffort, CodexState } from '../shared/types'
import { AppPaths } from './core/paths'

type EventSink = (event: CodexEvent) => void
const THREAD_INSTRUCTION_VERSION = 4

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
  private activeItems = new Map<string, any>()

  constructor(
    private readonly projectRoot: string,
    private readonly paths: AppPaths,
    initialEditMode: CodexEditMode = 'review',
    private modelSettings: { model: string; reasoningEffort: CodexReasoningEffort } = { model: 'gpt-5.6-luna', reasoningEffort: 'low' }
  ) {
    mkdirSync(this.paths.root, { recursive: true })
    this.editMode = this.readEditMode(initialEditMode)
    this.threadId = this.readStoredThreadId()
    this.knownThreadIds = new Set(this.readChatIndex())
    if (this.threadId) this.registerThread(this.threadId)
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink
  }

  getState(): CodexState {
    return {
      provider: 'codex',
      providerName: 'Codex',
      available: Boolean(this.findCodex()),
      connected: this.connected,
      authenticated: this.authenticated,
      accountLabel: this.accountLabel,
      threadId: this.threadId,
      editMode: this.editMode,
      model: this.modelSettings.model,
      reasoningEffort: this.modelSettings.reasoningEffort,
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
        clientInfo: { name: 'internship_os', title: 'Internship OS', version: '1.0.0' }
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

    const modeInstruction = this.editMode === 'auto'
      ? 'AUTO APPLY mode: complete requested resume and tracker edits end-to-end. For resume changes, use the candidate and promote workflow so compilation and one-page validation happen before promotion.'
      : 'REVIEW mode: make requested local workspace edits immediately without asking for approval, then finish by summarizing the applied changes. Use the safe candidate and promote workflow for resumes. Do not perform external, destructive, or irreversible actions.'
    const responseInstruction = 'Respond like a normal concise assistant. Never mention the active mode, approval policy, or that files were or were not changed unless an error prevented the request. Lead with the result. Format replacement content with a short descriptive Markdown heading and bullets, followed by at most one brief reason when useful. Do not preface suggestions with “I’d replace”.'
    const requestText = `[Internship OS behavior]\n${modeInstruction}\n${responseInstruction}\n\n[User request]\n${text}`

    await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: requestText }],
      model: this.modelSettings.model,
      effort: this.modelSettings.reasoningEffort,
      cwd: this.projectRoot,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.paths.root], networkAccess: false }
    })
  }

  setEditMode(mode: CodexEditMode): CodexState {
    if (mode !== 'review' && mode !== 'auto') throw new Error('Unknown Codex edit mode.')
    this.editMode = mode
    writeFileSync(this.settingsPath(), JSON.stringify({ editMode: mode }, null, 2))
    return this.getState()
  }

  async setModelSettings(model: string, reasoningEffort: CodexReasoningEffort): Promise<CodexState> {
    this.modelSettings = { model: model.trim() || 'gpt-5.6-luna', reasoningEffort }
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
      sandbox: 'workspace-write',
      personality: 'friendly',
      serviceName: 'internship_os',
      threadSource: 'internship_os',
      model: this.modelSettings.model,
      developerInstructions:
        `Operate the local Internship OS using AGENTS.md. Make requested local workspace edits without approval prompts, use the bundled command surface, rely on resume promotion for compilation and one-page validation, and never invent candidate facts. Read ${JSON.stringify(this.getProfilePath())} before requests that depend on candidate facts or change resume/tracker data; answer simple general questions directly. Persist only explicit candidate facts and corrections. Respond naturally and concisely without mentioning modes, approval policy, or whether files changed unless an error blocked the request. Use clear Markdown headings and bullets for replacement content.`
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
      this.eventSink({
        type: 'activity',
        activity: {
          id: `approval:${message.id}`,
          kind: 'system',
          title: 'Approval request declined',
          text: formatJson(message.params),
          output: '',
          status: 'failed'
        }
      })
      this.write({ id: message.id, result: { decision: 'decline' } })
      return
    }

    switch (message.method) {
      case 'item/agentMessage/delta': {
        const id = String(message.params?.itemId ?? '')
        const item = this.activeItems.get(id)
        const text = String(message.params?.delta ?? '')
        if (item?.phase === 'commentary') this.eventSink({ type: 'activity-delta', id, field: 'text', text })
        else this.eventSink({ type: 'message-delta', id, text })
        break
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/plan/delta':
        this.eventSink({ type: 'activity-delta', id: String(message.params?.itemId ?? ''), field: 'text', text: String(message.params?.delta ?? '') })
        break
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        this.eventSink({ type: 'activity-delta', id: String(message.params?.itemId ?? ''), field: 'output', text: String(message.params?.delta ?? '') })
        break
      case 'item/commandExecution/terminalInteraction':
        this.eventSink({ type: 'activity-delta', id: String(message.params?.itemId ?? ''), field: 'output', text: `\n› ${String(message.params?.stdin ?? '')}` })
        break
      case 'item/mcpToolCall/progress':
        this.eventSink({ type: 'activity-delta', id: String(message.params?.itemId ?? ''), field: 'output', text: `${String(message.params?.message ?? '')}\n` })
        break
      case 'command/exec/outputDelta':
        this.eventSink({ type: 'command-output', text: decodeOutputDelta(message.params) })
        break
      case 'turn/diff/updated':
        this.eventSink({ type: 'diff', text: String(message.params?.diff ?? '') })
        break
      case 'turn/plan/updated': {
        const turnId = String(message.params?.turnId ?? 'current')
        const explanation = String(message.params?.explanation ?? '').trim()
        const steps = (Array.isArray(message.params?.plan) ? message.params.plan : [])
          .map((step: any) => `${planStatusMark(step?.status)} ${String(step?.step ?? '')}`.trim())
          .join('\n')
        this.eventSink({
          type: 'activity',
          activity: {
            id: `plan:${turnId}`,
            kind: 'plan',
            title: 'Plan',
            text: [explanation, steps].filter(Boolean).join('\n\n'),
            output: '',
            status: steps.includes('○') || steps.includes('◐') ? 'running' : 'completed'
          }
        })
        break
      }
      case 'item/started': {
        const item = message.params?.item
        if (!item?.id) break
        this.activeItems.set(String(item.id), item)
        const activity = activityFromThreadItem(item, 'running')
        if (activity) this.eventSink({ type: 'activity', activity })
        break
      }
      case 'item/completed': {
        const item = message.params?.item
        if (!item?.id) break
        this.activeItems.delete(String(item.id))
        if (item?.type === 'agentMessage' && item.text && item.phase !== 'commentary') {
          this.eventSink({ type: 'message', id: String(item.id), text: String(item.text) })
        } else {
          const activity = activityFromThreadItem(item, activityStatus(item.status, 'completed'))
          if (activity) this.eventSink({ type: 'activity', activity })
        }
        break
      }
      case 'warning':
      case 'guardianWarning':
      case 'deprecationNotice':
      case 'configWarning':
      case 'model/rerouted':
        this.eventSink({
          type: 'activity',
          activity: {
            id: `${message.method}:${Date.now()}`,
            kind: 'system',
            title: notificationTitle(message.method),
            text: notificationText(message.params),
            output: '',
            status: 'completed'
          }
        })
        break
      case 'thread/compacted':
        this.eventSink({
          type: 'activity',
          activity: { id: `compaction:${Date.now()}`, kind: 'system', title: 'Context compacted', text: 'Codex compacted earlier context to continue working.', output: '', status: 'completed' }
        })
        break
      case 'turn/completed': {
        const completedStatus: CodexActivityStatus = message.params?.turn?.status === 'completed' ? 'completed' : 'failed'
        for (const item of this.activeItems.values()) {
          const activity = activityFromThreadItem(item, completedStatus)
          if (activity) this.eventSink({ type: 'activity', activity })
        }
        this.activeItems.clear()
        const turnError = message.params?.turn?.error?.message
        if (turnError) this.eventSink({ type: 'error', text: String(turnError) })
        this.eventSink({ type: 'turn-completed' })
        break
      }
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
      '/usr/local/bin/codex',
      ...String(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, 'codex'))
    ].filter(Boolean) as string[]
    return candidates.find(existsSync) ?? null
  }

  private settingsPath(): string {
    return join(this.paths.root, 'codex-settings.json')
  }

  private readEditMode(fallback: CodexEditMode): CodexEditMode {
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath(), 'utf8')) as { editMode?: CodexEditMode }
      return parsed.editMode === 'auto' ? 'auto' : 'review'
    } catch {
      return fallback
    }
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

export function activityFromThreadItem(item: any, status: CodexActivityStatus): CodexActivity | null {
  if (!item?.id || !item?.type) return null
  const id = String(item.id)

  switch (item.type) {
    case 'agentMessage':
      return item.phase === 'commentary'
        ? { id, kind: 'commentary', title: 'Codex update', text: String(item.text ?? ''), output: '', status }
        : null
    case 'reasoning':
      return { id, kind: 'reasoning', title: 'Reasoning', text: stringList(item.summary).join('\n\n'), output: '', status }
    case 'plan':
      return { id, kind: 'plan', title: 'Plan', text: String(item.text ?? ''), output: '', status }
    case 'commandExecution':
      return {
        id,
        kind: 'command',
        title: commandTitle(item),
        text: String(item.command ?? ''),
        output: String(item.aggregatedOutput ?? ''),
        detail: String(item.cwd ?? ''),
        status: activityStatus(item.status, status),
        durationMs: finiteNumber(item.durationMs),
        exitCode: finiteNumber(item.exitCode)
      }
    case 'fileChange':
      return {
        id,
        kind: 'file',
        title: fileChangeTitle(item.changes),
        text: (Array.isArray(item.changes) ? item.changes : []).map((change: any) => `${String(change?.kind ?? 'update')} ${String(change?.path ?? '')}`.trim()).join('\n'),
        output: '',
        status: activityStatus(item.status, status)
      }
    case 'mcpToolCall':
      return {
        id,
        kind: 'tool',
        title: `${String(item.server ?? 'MCP')} · ${String(item.tool ?? 'tool')}`,
        text: formatJson(item.arguments),
        output: item.error?.message ? String(item.error.message) : formatToolResult(item.result),
        status: activityStatus(item.status, status),
        durationMs: finiteNumber(item.durationMs)
      }
    case 'dynamicToolCall':
      return {
        id,
        kind: 'tool',
        title: [item.namespace, item.tool].filter(Boolean).map(String).join(' · ') || 'Tool',
        text: formatJson(item.arguments),
        output: formatDynamicToolOutput(item.contentItems),
        status: item.success === false ? 'failed' : activityStatus(item.status, status),
        durationMs: finiteNumber(item.durationMs)
      }
    case 'collabAgentToolCall':
      return {
        id,
        kind: 'tool',
        title: `Agent · ${friendlyToken(item.tool)}`,
        text: String(item.prompt ?? ''),
        output: item.receiverThreadIds?.length ? `Threads: ${item.receiverThreadIds.join(', ')}` : '',
        status: activityStatus(item.status, status)
      }
    case 'subAgentActivity':
      return { id, kind: 'tool', title: `Agent ${friendlyToken(item.kind)}`, text: String(item.agentPath ?? item.agentThreadId ?? ''), output: '', status }
    case 'webSearch':
      return { id, kind: 'search', title: webSearchTitle(item.action), text: webSearchText(item), output: '', status }
    case 'imageView':
      return { id, kind: 'image', title: 'Viewed image', text: String(item.path ?? ''), output: '', status }
    case 'imageGeneration':
      return { id, kind: 'image', title: 'Generated image', text: String(item.revisedPrompt ?? ''), output: String(item.savedPath ?? item.result ?? ''), status: activityStatus(item.status, status) }
    case 'sleep':
      return { id, kind: 'system', title: 'Waiting', text: `${Number(item.durationMs ?? 0)} ms`, output: '', status }
    case 'enteredReviewMode':
      return { id, kind: 'system', title: 'Entered review mode', text: String(item.review ?? ''), output: '', status }
    case 'exitedReviewMode':
      return { id, kind: 'system', title: 'Exited review mode', text: String(item.review ?? ''), output: '', status }
    case 'contextCompaction':
      return { id, kind: 'system', title: 'Context compacted', text: 'Codex compacted earlier context to continue working.', output: '', status }
    default:
      return null
  }
}

function activityStatus(value: unknown, fallback: CodexActivityStatus): CodexActivityStatus {
  const status = String(value ?? '')
  if (status === 'failed' || status === 'declined') return 'failed'
  if (status === 'completed') return 'completed'
  if (status === 'inProgress' || status === 'in_progress') return 'running'
  return fallback
}

function commandTitle(item: any): string {
  const actions = Array.isArray(item?.commandActions) ? item.commandActions : []
  const first = actions[0]
  if (first?.type === 'read') return `Read ${String(first.name ?? 'file')}`
  if (first?.type === 'listFiles') return 'Listed files'
  if (first?.type === 'search') return 'Searched files'
  return 'Ran command'
}

function fileChangeTitle(changes: unknown): string {
  const count = Array.isArray(changes) ? changes.length : 0
  return count === 1 ? 'Changed 1 file' : `Changed ${count} files`
}

function webSearchTitle(action: any): string {
  if (action?.type === 'open_page') return 'Opened web page'
  if (action?.type === 'find_in_page') return 'Searched web page'
  return 'Searched the web'
}

function webSearchText(item: any): string {
  const action = item?.action
  if (action?.type === 'open_page') return String(action.url ?? item.query ?? '')
  if (action?.type === 'find_in_page') return [action.url, action.pattern].filter(Boolean).join('\n')
  if (Array.isArray(action?.queries)) return action.queries.map(String).join('\n')
  return String(action?.query ?? item?.query ?? '')
}

function formatToolResult(result: any): string {
  if (!result) return ''
  const content = (Array.isArray(result.content) ? result.content : []).map((item: any) => {
    if (typeof item === 'string') return item
    if (item?.type === 'text' && item.text) return String(item.text)
    if (item?.type === 'image' || item?.type === 'image_url') return '[image output]'
    return formatJson(item)
  }).filter(Boolean)
  if (result.structuredContent != null) content.push(formatJson(result.structuredContent))
  return content.join('\n')
}

function formatDynamicToolOutput(items: unknown): string {
  return (Array.isArray(items) ? items : []).map((item: any) => item?.type === 'inputText' ? String(item.text ?? '') : item?.type === 'inputImage' ? '[image output]' : formatJson(item)).filter(Boolean).join('\n')
}

function formatJson(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function finiteNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function friendlyToken(value: unknown): string {
  return String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
}

function planStatusMark(status: unknown): string {
  if (status === 'completed') return '✓'
  if (status === 'inProgress') return '◐'
  return '○'
}

function decodeOutputDelta(params: Record<string, any> | undefined): string {
  if (typeof params?.delta === 'string') return params.delta
  if (typeof params?.deltaBase64 === 'string') {
    try { return Buffer.from(params.deltaBase64, 'base64').toString('utf8') } catch { return '' }
  }
  return ''
}

function notificationTitle(method: string | undefined): string {
  if (method === 'model/rerouted') return 'Model rerouted'
  if (method === 'deprecationNotice') return 'Deprecation notice'
  if (method === 'configWarning') return 'Configuration warning'
  return 'Warning'
}

function notificationText(params: Record<string, any> | undefined): string {
  return String(params?.message ?? params?.text ?? params?.reason ?? formatJson(params))
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
      } else {
        const activity = activityFromThreadItem(item, activityStatus(item?.status, 'completed'))
        if (activity) messages.push({ id: activity.id, role: 'activity', text: activity.text, activity })
      }

      if (item?.type === 'fileChange') {
        const diff = fileChangesToDiff(item.changes)
        if (diff) messages.push({ id: `${String(item.id)}:diff`, role: 'diff', text: diff })
      }
    }
  }
  return messages
}

function fileChangesToDiff(changes: unknown): string {
  if (!Array.isArray(changes)) return ''
  return changes
    .filter((change: any) => change?.path && change?.diff)
    .map((change: any) => {
      const path = String(change.path)
      const diff = String(change.diff)
      return diff.startsWith('diff --git') ? diff : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${diff}`
    })
    .join('\n')
}
