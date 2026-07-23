export type CommandPaletteGroup =
  | 'Navigation'
  | 'Resume actions'
  | 'Applications'
  | 'Resume profiles'
  | 'Drafts'
  | 'Assistant'
  | 'Preferences'

export type CommandPaletteKind =
  | 'navigation'
  | 'resume'
  | 'application'
  | 'profile'
  | 'draft'
  | 'assistant'
  | 'settings'
  | 'theme'

export interface CommandPaletteItem {
  id: string
  title: string
  subtitle?: string
  group: CommandPaletteGroup
  kind: CommandPaletteKind
  keywords?: string[]
  shortcut?: string
  disabledReason?: string
  suggested?: boolean
  priority?: number
  run: () => void | Promise<void>
}

export interface CommandPaletteGroupResult {
  name: CommandPaletteGroup
  items: CommandPaletteItem[]
}

const DEFAULT_RESULT_LIMIT = 18

export function searchCommandPalette(
  items: CommandPaletteItem[],
  query: string,
  recentIds: string[] = [],
  limit = DEFAULT_RESULT_LIMIT
): CommandPaletteItem[] {
  const normalizedQuery = normalizeSearchText(query)
  const recentRank = new Map(recentIds.map((id, index) => [id, recentIds.length - index]))

  if (!normalizedQuery) {
    return items
      .filter((item) => item.suggested || recentRank.has(item.id))
      .sort((left, right) => {
        const recentDifference = (recentRank.get(right.id) ?? 0) - (recentRank.get(left.id) ?? 0)
        if (recentDifference !== 0) return recentDifference
        const priorityDifference = (right.priority ?? 0) - (left.priority ?? 0)
        if (priorityDifference !== 0) return priorityDifference
        return left.title.localeCompare(right.title)
      })
      .slice(0, limit)
  }

  const tokens = normalizedQuery.split(' ').filter(Boolean)
  return items
    .map((item) => ({ item, score: scoreCommand(item, normalizedQuery, tokens, recentRank.get(item.id) ?? 0) }))
    .filter((result) => result.score >= 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return left.item.title.localeCompare(right.item.title)
    })
    .slice(0, limit)
    .map((result) => result.item)
}

export function groupCommandPaletteResults(items: CommandPaletteItem[]): CommandPaletteGroupResult[] {
  const groups = new Map<CommandPaletteGroup, CommandPaletteItem[]>()
  for (const item of items) {
    const group = groups.get(item.group)
    if (group) group.push(item)
    else groups.set(item.group, [item])
  }
  return [...groups].map(([name, groupItems]) => ({ name, items: groupItems }))
}

export function nextEnabledCommandIndex(
  items: CommandPaletteItem[],
  currentIndex: number,
  direction: 1 | -1
): number {
  if (items.length === 0) return -1
  const startIndex = currentIndex >= 0 ? currentIndex : direction === 1 ? -1 : 0
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (startIndex + direction * offset + items.length) % items.length
    if (!items[index].disabledReason) return index
  }
  return -1
}

function scoreCommand(
  item: CommandPaletteItem,
  query: string,
  tokens: string[],
  recentRank: number
): number {
  const title = normalizeSearchText(item.title)
  const subtitle = normalizeSearchText(item.subtitle ?? '')
  const keywords = normalizeSearchText(item.keywords?.join(' ') ?? '')
  const group = normalizeSearchText(item.group)
  const searchable = `${title} ${subtitle} ${keywords} ${group}`.trim()

  let score = 0
  if (title === query) score += 1_200
  else if (title.startsWith(query)) score += 850
  else if (title.split(' ').some((word) => word.startsWith(query))) score += 650
  else if (title.includes(query)) score += 500
  else if (subtitle.includes(query)) score += 320
  else if (keywords.includes(query)) score += 260

  for (const token of tokens) {
    const tokenScore = scoreToken(token, title, subtitle, keywords, group, searchable)
    if (tokenScore < 0) return -1
    score += tokenScore
  }

  score += Math.min(recentRank, 8) * 8
  score += item.priority ?? 0
  return score
}

function scoreToken(
  token: string,
  title: string,
  subtitle: string,
  keywords: string,
  group: string,
  searchable: string
): number {
  if (title.startsWith(token)) return 180
  if (title.split(' ').some((word) => word.startsWith(token))) return 145
  if (title.includes(token)) return 115
  if (subtitle.includes(token)) return 80
  if (keywords.includes(token)) return 65
  if (group.includes(token)) return 50
  return searchable.split(' ').some((word) => isSubsequence(token, word)) ? 15 : -1
}

function isSubsequence(query: string, text: string): boolean {
  let queryIndex = 0
  for (const character of text) {
    if (character === query[queryIndex]) queryIndex += 1
    if (queryIndex === query.length) return true
  }
  return query.length === 0
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9+#./-]+/g, ' ')
    .trim()
}
