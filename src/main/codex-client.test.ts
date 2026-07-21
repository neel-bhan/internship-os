import { describe, expect, it } from 'vitest'
import { activityFromThreadItem, CODEX_APP_SERVER_ARGS, codexExecutableCandidates, codexTurnInput, codexTurnModeInstruction, codexWorkspaceSandboxPolicy, resolvePluginInstallTarget } from './codex-client'
import { claudeTurnModeInstruction } from './claude-client'

describe('Codex research configuration', () => {
  it('keeps command network access and live web search enabled', () => {
    expect(CODEX_APP_SERVER_ARGS).toContain('sandbox_workspace_write.network_access=true')
    expect(CODEX_APP_SERVER_ARGS).toContain('web_search="live"')
    expect(codexWorkspaceSandboxPolicy('/workspace', '/Users/test/Downloads')).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/workspace', '/Users/test/Downloads'],
      networkAccess: true
    })
  })
})

describe('Codex installation discovery', () => {
  it('checks the official standalone install directory and common user-level package managers', () => {
    const candidates = codexExecutableCandidates({ HOME: '/Users/friend', PATH: '/custom/bin' })
    expect(candidates).toContain('/Users/friend/.local/bin/codex')
    expect(candidates).toContain('/Users/friend/.volta/bin/codex')
    expect(candidates).toContain('/Users/friend/.npm-global/bin/codex')
    expect(candidates).toContain('/custom/bin/codex')
  })
})

describe('Codex multimodal input', () => {
  it('sends managed images through the native localImage turn input', () => {
    expect(codexTurnInput('Review this screenshot', [{
      id: 'image-1',
      name: 'Screenshot.png',
      mimeType: 'image/png',
      path: '/workspace/.attachments/image.png'
    }])).toEqual([
      { type: 'text', text: 'Review this screenshot', text_elements: [] },
      { type: 'localImage', path: '/workspace/.attachments/image.png', detail: 'auto' }
    ])
  })
})

describe('assistant review behavior', () => {
  it('pre-authorizes tracker and candidate-bank maintenance while preserving review for other edits', () => {
    for (const instruction of [codexTurnModeInstruction('review'), claudeTurnModeInstruction('review')]) {
      expect(instruction).toContain('application tracker record')
      expect(instruction).toContain('Candidate experience-bank maintenance')
      expect(instruction).toContain('additions, corrections, preferences, and removals')
      expect(instruction).toContain('immediately')
      expect(instruction).toContain('separate approval')
      expect(instruction).toContain("wait for the user's explicit approval")
      expect(instruction).toContain('cover-letter PDF')
      expect(instruction).toContain('Downloads folder')
    }
  })
})

describe('Codex plugin requests', () => {
  it('resolves recommended remote ids against the current marketplace catalog', () => {
    expect(resolvePluginInstallTarget('github@openai-curated-remote', {
      marketplaces: [{
        name: 'openai-curated',
        plugins: [{ id: 'github@openai-curated', name: 'github' }]
      }]
    })).toEqual({
      pluginName: 'github',
      remoteMarketplaceName: 'openai-curated',
      pluginId: 'github@openai-curated'
    })
  })

  it('normalizes remote marketplace ids when catalog lookup is unavailable', () => {
    expect(resolvePluginInstallTarget('github@openai-curated-remote', {})).toEqual({
      pluginName: 'github',
      remoteMarketplaceName: 'openai-curated',
      pluginId: 'github@openai-curated'
    })
  })
})

describe('Codex activity normalization', () => {
  it('keeps command output and completion metadata', () => {
    expect(activityFromThreadItem({
      id: 'command-1',
      type: 'commandExecution',
      command: 'internship-os resume state',
      cwd: '/assistant-workspace',
      commandActions: [{ type: 'read', name: 'resume state' }],
      aggregatedOutput: 'General SWE\n',
      status: 'completed',
      exitCode: 0,
      durationMs: 125
    }, 'completed')).toMatchObject({
      id: 'command-1',
      kind: 'command',
      title: 'Read resume state',
      output: 'General SWE\n',
      status: 'completed',
      exitCode: 0,
      durationMs: 125
    })
  })

  it('does not invent command completion metadata while running', () => {
    expect(activityFromThreadItem({
      id: 'command-2',
      type: 'commandExecution',
      command: 'internship-os application list',
      cwd: '/assistant-workspace',
      commandActions: [],
      aggregatedOutput: null,
      status: 'inProgress',
      exitCode: null,
      durationMs: null
    }, 'running')).toEqual({
      id: 'command-2',
      kind: 'command',
      title: 'Ran command',
      text: 'internship-os application list',
      output: '',
      detail: '/assistant-workspace',
      status: 'running',
      durationMs: undefined,
      exitCode: undefined
    })
  })

  it('exposes commentary and MCP tool results', () => {
    expect(activityFromThreadItem({ id: 'update-1', type: 'agentMessage', phase: 'commentary', text: 'Checking the resume.' }, 'completed')).toMatchObject({ kind: 'commentary', text: 'Checking the resume.' })
    expect(activityFromThreadItem({
      id: 'tool-1',
      type: 'mcpToolCall',
      server: 'local',
      tool: 'resume_state',
      arguments: { profile: 'general' },
      result: { content: [{ type: 'text', text: 'One page' }], structuredContent: null },
      status: 'completed',
      durationMs: 20
    }, 'completed')).toMatchObject({ kind: 'tool', title: 'local · resume_state', output: 'One page', status: 'completed' })
  })
})
