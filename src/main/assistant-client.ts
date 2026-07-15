import type {
  AssistantProviderId,
  CodexChatSummary,
  CodexConversation,
  CodexEditMode,
  CodexEvent,
  CodexState
} from '../shared/types'
import { AppPaths } from './core/paths'
import { CodexClient } from './codex-client'
import { ClaudeClient } from './claude-client'

export interface AssistantClient {
  setEventSink(sink: (event: CodexEvent) => void): void
  getState(): CodexState
  connect(): Promise<CodexState>
  send(text: string): Promise<void>
  setEditMode(mode: CodexEditMode): CodexState
  getProfilePath(): string
  listChats(): Promise<CodexChatSummary[]>
  openChat(threadId: string): Promise<CodexConversation>
  newChat(): Promise<CodexConversation>
  respondToApproval(requestId: string | number, decision: 'accept' | 'decline'): void
  stop(): void
}

export function createAssistantClient(
  provider: AssistantProviderId,
  workspaceRoot: string,
  paths: AppPaths,
  cliWrapperPath: string,
  editMode: CodexEditMode
): AssistantClient {
  if (provider === 'codex') return new CodexClient(workspaceRoot, paths, editMode)
  if (provider === 'claude') return new ClaudeClient(workspaceRoot, paths, cliWrapperPath, editMode)
  return new DisabledAssistantClient(editMode)
}

class DisabledAssistantClient {
  private sink: (event: CodexEvent) => void = () => undefined
  constructor(private editMode: CodexEditMode) {}
  setEventSink(sink: (event: CodexEvent) => void): void { this.sink = sink }
  getState(): CodexState {
    return { provider: 'none', providerName: 'Assistant', available: false, connected: false, authenticated: false, accountLabel: 'Disabled', threadId: null, editMode: this.editMode, error: 'Choose Codex or Claude in Settings.' }
  }
  async connect(): Promise<CodexState> { return this.getState() }
  async send(_text: string): Promise<void> { throw new Error('No assistant provider is configured.') }
  setEditMode(mode: CodexEditMode): CodexState { this.editMode = mode; return this.getState() }
  getProfilePath(): string { throw new Error('No assistant provider is configured.') }
  async listChats(): Promise<CodexChatSummary[]> { return [] }
  async openChat(_threadId: string): Promise<CodexConversation> { throw new Error('No assistant provider is configured.') }
  async newChat(): Promise<{ state: CodexState; messages: [] }> { return { state: this.getState(), messages: [] } }
  respondToApproval(_requestId: string | number, _decision: 'accept' | 'decline'): void {}
  stop(): void { this.sink = () => undefined }
}
