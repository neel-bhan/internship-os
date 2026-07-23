import { describe, expect, it, vi } from 'vitest'
import {
  groupCommandPaletteResults,
  nextEnabledCommandIndex,
  searchCommandPalette,
  type CommandPaletteItem
} from './command-palette'

const run = vi.fn()
const items: CommandPaletteItem[] = [
  {
    id: 'resume.compile',
    title: 'Compile Without Saving',
    subtitle: 'Rebuild the resume PDF',
    group: 'Resume actions',
    kind: 'resume',
    keywords: ['latex build'],
    suggested: true,
    priority: 20,
    run
  },
  {
    id: 'application.apple',
    title: 'Apple',
    subtitle: 'Software Engineering Intern · Submitted',
    group: 'Applications',
    kind: 'application',
    keywords: ['Cupertino'],
    run
  },
  {
    id: 'profile.backend',
    title: 'Backend',
    subtitle: 'APIs, systems, data, and cloud',
    group: 'Resume profiles',
    kind: 'profile',
    disabledReason: 'Current profile',
    run
  },
  {
    id: 'navigation.tracker',
    title: 'Open Tracker',
    group: 'Navigation',
    kind: 'navigation',
    suggested: true,
    priority: 50,
    run
  }
]

describe('searchCommandPalette', () => {
  it('shows suggested and recent commands for an empty query', () => {
    expect(searchCommandPalette(items, '', ['application.apple']).map((item) => item.id)).toEqual([
      'application.apple',
      'navigation.tracker',
      'resume.compile'
    ])
  })

  it('ranks direct title matches above keyword matches', () => {
    expect(searchCommandPalette(items, 'apple').map((item) => item.id)).toEqual(['application.apple'])
    expect(searchCommandPalette(items, 'compile').map((item) => item.id)[0]).toBe('resume.compile')
  })

  it('matches application metadata and fuzzy subsequences', () => {
    expect(searchCommandPalette(items, 'cupertino').map((item) => item.id)).toEqual(['application.apple'])
    expect(searchCommandPalette(items, 'bcknd').map((item) => item.id)).toEqual(['profile.backend'])
  })

  it('requires every query token to match', () => {
    expect(searchCommandPalette(items, 'apple submitted').map((item) => item.id)).toEqual(['application.apple'])
    expect(searchCommandPalette(items, 'apple rejected')).toEqual([])
  })
})

describe('command palette helpers', () => {
  it('groups items in first-result order', () => {
    const groups = groupCommandPaletteResults([items[1], items[0], items[3]])
    expect(groups.map((group) => group.name)).toEqual(['Applications', 'Resume actions', 'Navigation'])
  })

  it('skips disabled items during keyboard navigation', () => {
    expect(nextEnabledCommandIndex(items, 1, 1)).toBe(3)
    expect(nextEnabledCommandIndex(items, 3, -1)).toBe(1)
    expect(nextEnabledCommandIndex(items, -1, -1)).toBe(3)
  })
})
