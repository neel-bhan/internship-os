import { useEffect, useMemo, useRef, useState } from 'react'
import {
  groupCommandPaletteResults,
  nextEnabledCommandIndex,
  searchCommandPalette,
  type CommandPaletteItem,
  type CommandPaletteKind
} from './command-palette'

const RECENT_COMMANDS_KEY = 'internship-os-command-recents'
const MAX_RECENT_COMMANDS = 8

export function CommandPalette({
  open,
  items,
  onClose
}: {
  open: boolean
  items: CommandPaletteItem[]
  onClose: () => void
}): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [recentIds, setRecentIds] = useState<string[]>(readRecentCommandIds)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(
    () => searchCommandPalette(items, query, recentIds),
    [items, query, recentIds]
  )
  const groups = useMemo(() => groupCommandPaletteResults(results), [results])
  const displayItems = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const displayIndexById = useMemo(
    () => new Map(displayItems.map((item, index) => [item.id, index])),
    [displayItems]
  )

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => {
    if (!open) return
    const nextIndex = firstEnabledIndex(displayItems)
    if (activeIndex < 0 || activeIndex >= displayItems.length || displayItems[activeIndex]?.disabledReason) {
      setActiveIndex(nextIndex)
    }
  }, [activeIndex, displayItems, open])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    const optionId = commandOptionId(displayItems[activeIndex]?.id)
    if (optionId) document.getElementById(optionId)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, displayItems, open])

  if (!open) return null

  function runItem(item: CommandPaletteItem): void {
    if (item.disabledReason) return
    const nextRecentIds = [item.id, ...recentIds.filter((id) => id !== item.id)].slice(0, MAX_RECENT_COMMANDS)
    setRecentIds(nextRecentIds)
    writeRecentCommandIds(nextRecentIds)
    onClose()
    void item.run()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => nextEnabledCommandIndex(displayItems, current, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault()
      const item = displayItems[activeIndex]
      if (item) runItem(item)
    }
  }

  return (
    <div
      className="command-palette-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="command-palette-search">
          <SearchIcon />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search commands, applications, and resumes"
            aria-autocomplete="list"
            aria-controls="command-palette-results"
            aria-expanded="true"
            aria-activedescendant={activeIndex >= 0 ? commandOptionId(displayItems[activeIndex]?.id) : undefined}
            placeholder="Search commands, applications, and resumes…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
          />
          <kbd>⌘K</kbd>
        </div>
        <div className="command-palette-results" id="command-palette-results" role="listbox">
          {groups.length === 0 ? (
            <div className="command-palette-empty">
              <strong>No results</strong>
              <span>Try a company, action, resume profile, or draft.</span>
            </div>
          ) : groups.map((group) => (
            <section
              className="command-palette-group"
              role="group"
              aria-labelledby={`command-group-${group.name.replace(/\s+/g, '-').toLowerCase()}`}
              key={group.name}
            >
              <h2 id={`command-group-${group.name.replace(/\s+/g, '-').toLowerCase()}`}>{group.name}</h2>
              {group.items.map((item) => {
                const index = displayIndexById.get(item.id) ?? -1
                const active = index === activeIndex
                return (
                  <button
                    type="button"
                    role="option"
                    id={commandOptionId(item.id)}
                    aria-selected={active}
                    aria-disabled={Boolean(item.disabledReason)}
                    className={`command-palette-option ${active ? 'active' : ''} ${item.disabledReason ? 'disabled' : ''}`.trim()}
                    key={item.id}
                    onClick={() => runItem(item)}
                    onMouseEnter={() => {
                      if (!item.disabledReason) setActiveIndex(index)
                    }}
                  >
                    <CommandKindIcon kind={item.kind} />
                    <span className="command-palette-copy">
                      <strong>{item.title}</strong>
                      {(item.disabledReason || item.subtitle) && <small>{item.disabledReason ?? item.subtitle}</small>}
                    </span>
                    {item.shortcut && <kbd>{item.shortcut}</kbd>}
                  </button>
                )
              })}
            </section>
          ))}
        </div>
        <footer className="command-palette-footer">
          <span><kbd>↑↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>esc</kbd> Close</span>
        </footer>
      </section>
    </div>
  )
}

function firstEnabledIndex(items: CommandPaletteItem[]): number {
  return items.findIndex((item) => !item.disabledReason)
}

function commandOptionId(id: string | undefined): string | undefined {
  return id ? `command-option-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}` : undefined
}

function readRecentCommandIds(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT_COMMANDS) : []
  } catch {
    return []
  }
}

function writeRecentCommandIds(ids: string[]): void {
  try {
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(ids))
  } catch {
    // The palette still works when storage is unavailable.
  }
}

function SearchIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
}

function CommandKindIcon({ kind }: { kind: CommandPaletteKind }): React.JSX.Element {
  if (kind === 'application') return <span className={`command-kind-icon ${kind}`} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4h7A1.5 1.5 0 0 1 17 5.5V7" /><rect x="3.5" y="7" width="17" height="12.5" rx="2.5" /><path d="M3.5 12h17M10 12v1h4v-1" /></svg></span>
  if (kind === 'resume' || kind === 'profile' || kind === 'draft') return <span className={`command-kind-icon ${kind}`} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4v13H7z" /><path d="M14 3.5v4h4M10 12h5M10 15.5h5" /></svg></span>
  if (kind === 'assistant') return <span className={`command-kind-icon ${kind}`} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3.5c.7 4.6 3 6.8 7.5 7.5-4.5.7-6.8 3-7.5 7.5-.7-4.5-3-6.8-7.5-7.5C9 10.3 11.3 8.1 12 3.5Z" /></svg></span>
  if (kind === 'settings') return <span className={`command-kind-icon ${kind}`} aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></svg></span>
  if (kind === 'theme') return <span className={`command-kind-icon ${kind}`} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 15.4A8 8 0 0 1 8.6 4a8 8 0 1 0 11.4 11.4Z" /></svg></span>
  return <span className={`command-kind-icon ${kind}`} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>
}
