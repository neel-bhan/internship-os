import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { delimiter, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { CodexChatSummary, CodexConversation, CodexEditMode, CodexEvent, CodexState } from '../shared/types'
import { AppPaths } from './core/paths'

type EventSink = (event: CodexEvent) => void
type StoredChat = { id: string; title: string; updatedAt: number; messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }> }

export class ClaudeClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private eventSink: EventSink = () => undefined
  private editMode: CodexEditMode
  private threadId: string | null = null
  private error: string | undefined
  private chats: StoredChat[]

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

  async send(text: string): Promise<void> {
    const executable = this.findClaude()
    if (!executable) throw new Error('Claude Code is not installed.')
    const state = this.getState()
    if (!state.authenticated) throw new Error(state.error ?? 'Claude is not authenticated.')
    if (this.process) throw new Error('Claude is already working.')

    const chat = this.ensureChat(text)
    chat.messages.push({ id: randomUUID(), role: 'user', text })
    chat.updatedAt = Date.now()
    this.writeChats()

    const modeInstruction = this.editMode === 'auto'
      ? 'AUTO APPLY mode. Complete requested changes through the bundled Internship OS command surface and verify the result.'
      : 'REVIEW FIRST mode. Inspect and propose changes, but do not modify resumes, applications, tracker data, or workspace files.'
    const prompt = `[Internship OS]\nRead AGENTS.md and ${JSON.stringify(join(this.paths.root, 'candidate-profile.md'))}. ${modeInstruction}\n\n[User request]\n${text}`
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', this.editMode === 'auto' ? 'acceptEdits' : 'plan',
      '--add-dir', this.paths.root,
      '--allowedTools', `Read,Edit,Write,Bash(${this.cliWrapperPath} *)`
    ]
    if (chat.messages.length > 1) args.push('--resume', chat.id)
    else args.push('--session-id', chat.id)

    this.process = spawn(executable, args, { cwd: this.projectRoot, env: { ...process.env, INTERNSHIP_OS_HOME: this.paths.root } })
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
      if (code === 0) {
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
    return { state: this.getState(), messages: chat.messages }
  }

  async newChat(): Promise<CodexConversation> {
    this.threadId = null
    return { state: this.getState(), messages: [] }
  }

  respondToApproval(_requestId: string | number, _decision: 'accept' | 'decline'): void {}

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
