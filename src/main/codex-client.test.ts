import { describe, expect, it } from 'vitest'
import { activityFromThreadItem } from './codex-client'

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
