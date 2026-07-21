import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { delimiter, dirname, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { CodexChatSummary, CodexConversation, CodexEditMode, CodexEvent, CodexReasoningEffort, CodexState } from '../shared/types'
import { storedImagePreview, type StoredAssistantImage } from './core/chat-images'
import { AppPaths } from './core/paths'

type EventSink = (event: CodexEvent) => void
type StoredChat = {
  id: string
  title: string
  updatedAt: number
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; imagePaths?: string[] }>
}

export function claudeTurnModeInstruction(mode: CodexEditMode): string {
  return mode === 'auto'
    ? 'AUTO APPLY mode. Complete requested changes through the bundled Internship OS command surface and verify the result. Maintain the candidate experience bank from clear user-supplied additions, corrections, preferences, and removals without separate approval. Immediately export user-requested cover-letter PDFs to the configured Downloads folder with the Internship OS artifact command.'
    : "REVIEW FIRST mode. When the user explicitly asks to add, update, or remove an application tracker record, perform that tracker operation immediately through the Internship OS command surface and report the result without separate approval. Candidate experience-bank maintenance supported by the user's current statements is also pre-authorized: apply clear additions, corrections, preferences, and removals immediately. A user-requested cover-letter PDF and its immediate export to the configured Downloads folder through the Internship OS artifact command are also pre-authorized. For resumes, instruction files, and all other persistent edits, inspect and present the exact proposed changes or diff, then wait for the user's explicit approval."
}

export class ClaudeClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private eventSink: EventSink = () => undefined
  private editMode: CodexEditMode
  private threadId: string | null = null
  private error: string | undefined
  private chats: StoredChat[]
  private interrupted = false

  constructor(
    private readonly projectRoot: string,
    private readonly paths: AppPaths,
    private readonly cliWrapperPath: string,
    initialEditMode: CodexEditMode = 'review'
  ) {
    this.editMode = initialEditMode
    this.chats = this.readChats()
    this.threadId = this.chats[0]?.id ?? null
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink
  }

  getState(): CodexState {
    const executable = this.findClaude()
    const auth = executable ? claudeAuth(executable) : { authenticated: false, label: 'Not connected' }
    return {
      provider: 'claude',
      providerName: 'Claude',
      available: Boolean(executable),
      connected: Boolean(executable),
      authenticated: auth.authenticated,
      accountLabel: auth.label,
      threadId: this.threadId,
      editMode: this.editMode,
      error: this.error ?? (!executable ? 'Claude Code is not installed.' : !auth.authenticated ? 'Sign in by running `claude`, then reconnect.' : undefined)
    }
  }

  async connect(): Promise<CodexState> {
    return this.getState()
  }

  async send(text: string, images: StoredAssistantImage[] = []): Promise<void> {
    if (!text.trim() && images.length === 0) return
    const executable = this.findClaude()
    if (!executable) throw new Error('Claude Code is not installed.')
    const state = this.getState()
    if (!state.authenticated) throw new Error(state.error ?? 'Claude is not authenticated.')
    if (this.process) throw new Error('Claude is already working.')

    const chat = this.ensureChat(text.trim() || `Image: ${images[0]?.name ?? 'attachment'}`)
    chat.messages.push({ id: randomUUID(), role: 'user', text, imagePaths: images.map((image) => image.path) })
    chat.updatedAt = Date.now()
    this.writeChats()

    const modeInstruction = claudeTurnModeInstruction(this.editMode)
    const responseInstruction = 'Respond naturally and concisely. Lead with the result. Do not discuss internal modes or approval policy unless the user asks or an error blocks the request.'
    const attachmentPrompt = images.length > 0
      ? `\n\n[Attached images]\n${images.map((image) => `- ${JSON.stringify(image.path)} (${image.name})`).join('\n')}\nRead and inspect every attached image before responding.`
      : ''
    const prompt = `[Internship OS]\nRead AGENTS.md and ${JSON.stringify(join(this.paths.root, 'candidate-profile.md'))}. ${modeInstruction} ${responseInstruction}\n\n[User request]\n${text || 'Review the attached image(s).'}${attachmentPrompt}`
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--add-dir', this.paths.root,
      '--add-dir', dirname(this.paths.publicPdf),
      '--allowedTools', `Read,Edit,Write,WebSearch,WebFetch,Bash(${this.cliWrapperPath} *)`
    ]
    if (chat.messages.length > 1) args.push('--resume', chat.id)
    else args.push('--session-id', chat.id)

    this.interrupted = false
    this.process = spawn(executable, args, { cwd: this.projectRoot, env: { ...process.env, INTERNSHIP_OS_HOME: this.paths.root, INTERNSHIP_OS_PUBLIC_DOWNLOADS: dirname(this.paths.publicPdf) } })
    let finalText = ''
    let buffer = ''
    this.process.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const parsed = parseClaudeLine(line)
        if (parsed) finalText = parsed
      }
    })
    this.process.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim()
      if (message) this.eventSink({ type: 'status', text: message })
    })
    this.process.on('exit', (code) => {
      this.process = null
      if (buffer.trim()) {
        const parsed = parseClaudeLine(buffer)
        if (parsed) finalText = parsed
      }
      if (this.interrupted) {
        this.interrupted = false
        this.eventSink({
          type: 'activity',
          activity: { id: `interrupt:${chat.id}`, kind: 'system', title: 'Stopped', text: 'The current Claude turn was interrupted.', output: '', status: 'completed' }
        })
        this.eventSink({ type: 'turn-completed' })
      } else if (code === 0) {
        if (finalText) {
          chat.messages.push({ id: randomUUID(), role: 'assistant', text: finalText })
          chat.updatedAt = Date.now()
          this.writeChats()
          this.eventSink({ type: 'message', text: finalText })
        }
        this.eventSink({ type: 'turn-completed' })
      } else {
        this.eventSink({ type: 'error', text: `Claude exited with code ${code ?? 'unknown'}.` })
      }
    })

    function parseClaudeLine(line: string): string | null {
      try {
        const message = JSON.parse(line) as any
        if (message.type === 'result' && typeof message.result === 'string') return message.result
        if (message.type === 'assistant') {
          const text = (message.message?.content ?? []).filter((item: any) => item?.type === 'text').map((item: any) => item.text).join('\n')
          return text || null
        }
      } catch {
        return null
      }
      return null
    }
  }

  setEditMode(mode: CodexEditMode): CodexState {
    this.editMode = mode
    return this.getState()
  }

  async setModelSettings(_model: string, _reasoningEffort: CodexReasoningEffort): Promise<CodexState> {
    return this.getState()
  }

  getProfilePath(): string {
    return join(this.paths.root, 'candidate-profile.md')
  }

  async listChats(): Promise<CodexChatSummary[]> {
    return this.chats.map((chat) => ({ id: chat.id, title: chat.title, preview: chat.messages[0]?.text ?? '', updatedAt: chat.updatedAt / 1000 }))
  }

  async openChat(threadId: string): Promise<CodexConversation> {
    const chat = this.chats.find((item) => item.id === threadId)
    if (!chat) throw new Error('Claude conversation not found.')
    this.threadId = chat.id
    return {
      state: this.getState(),
      messages: chat.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        images: message.imagePaths?.map(storedImagePreview).filter((image) => image !== null)
      }))
    }
  }

  async newChat(): Promise<CodexConversation> {
    this.threadId = null
    return { state: this.getState(), messages: [] }
  }

  respondToApproval(_requestId: string | number, _decision: 'accept' | 'decline'): void {}

  async interrupt(): Promise<void> {
    if (!this.process) {
      this.eventSink({ type: 'turn-completed' })
      return
    }
    this.interrupted = true
    this.process.kill('SIGTERM')
  }

  stop(): void {
    this.process?.kill()
    this.process = null
  }

  private ensureChat(text: string): StoredChat {
    let chat = this.threadId ? this.chats.find((item) => item.id === this.threadId) : undefined
    if (!chat) {
      chat = { id: randomUUID(), title: text.trim().split(/\r?\n/, 1)[0].slice(0, 64) || 'New chat', updatedAt: Date.now(), messages: [] }
      this.chats.unshift(chat)
      this.threadId = chat.id
    }
    return chat
  }

  private chatsPath(): string {
    return join(this.paths.root, 'claude-chats.json')
  }

  private readChats(): StoredChat[] {
    try {
      const parsed = JSON.parse(readFileSync(this.chatsPath(), 'utf8')) as StoredChat[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private writeChats(): void {
    writeFileSync(this.chatsPath(), JSON.stringify(this.chats, null, 2))
  }

  private findClaude(): string | null {
    const candidates = [
      process.env.CLAUDE_PATH,
      join(process.env.HOME ?? '', '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      ...String(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, 'claude'))
    ].filter(Boolean) as string[]
    return candidates.find(existsSync) ?? null
  }
}

function claudeAuth(executable: string): { authenticated: boolean; label: string } {
  try {
    const result = spawnSync(executable, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 5000 })
    const parsed = JSON.parse(result.stdout || '{}') as { loggedIn?: boolean; authMethod?: string }
    return { authenticated: Boolean(parsed.loggedIn), label: parsed.loggedIn ? parsed.authMethod || 'Claude' : 'Signed out' }
  } catch {
    return { authenticated: false, label: 'Signed out' }
  }
}
