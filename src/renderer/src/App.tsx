import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { xcodeDark, xcodeLight } from '@uiw/codemirror-theme-xcode'
import { indentUnit, StreamLanguage } from '@codemirror/language'
import { EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, hoverTooltip, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import * as pdfjs from 'pdfjs-dist'
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import {
  APPLICATION_STATUSES,
  type ApplicationInput,
  type CodexEditMode,
  type CodexEvent,
  type CodexState,
  type CompileResult,
  type InternshipApplication,
  type ResumeChangeReview,
  type ResumeState
} from '../../shared/types'

pdfjs.GlobalWorkerOptions.workerPort = new PdfJsWorker()

type View = 'tracker' | 'resume'
type Theme = 'light' | 'dark'
const initialTheme: Theme = (() => {
  const stored = localStorage.getItem('internship-os-theme')
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
})()

document.documentElement.dataset.theme = initialTheme
document.documentElement.style.colorScheme = initialTheme

type ChatItem = {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  approval?: { requestId: string | number }
}

type DiffRow = {
  type: 'hunk' | 'added' | 'removed' | 'context'
  text: string
  oldLine?: number
  newLine?: number
  anchorLine?: number
}

function PdfPreview({ revision }: { revision: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let renderTasks: Array<{ cancel: () => void; promise: Promise<unknown> }> = []
    let documentProxy: { destroy: () => Promise<void> } | null = null
    let resizeObserver: ResizeObserver | null = null
    let resizeTimer: number | null = null

    setError(null)
    void window.internshipOS.resume.readPdf()
      .then((data) => {
        if (!data) throw new Error('PDF file is not available')
        return pdfjs.getDocument({ data: new Uint8Array(data) }).promise
      })
      .then(async (pdfDocument) => {
      documentProxy = pdfDocument
      const pages = await Promise.all(
        Array.from({ length: pdfDocument.numPages }, (_, index) => pdfDocument.getPage(index + 1))
      )

      const render = (): void => {
        const container = containerRef.current
        const pagesElement = pagesRef.current
        if (disposed || !container || !pagesElement) return

        for (const task of renderTasks) task.cancel()
        renderTasks = []
        pagesElement.replaceChildren()
        container.classList.toggle('multi-page', pages.length > 1)
        const availableWidth = Math.max(1, container.clientWidth - 40)
        const availableHeight = Math.max(1, container.clientHeight - 40)
        const pixelRatio = window.devicePixelRatio || 1

        for (const page of pages) {
          const baseViewport = page.getViewport({ scale: 1 })
          const widthScale = availableWidth / baseViewport.width
          const scale = pages.length === 1
            ? Math.min(widthScale, availableHeight / baseViewport.height)
            : widthScale
          const viewport = page.getViewport({ scale: scale * pixelRatio })
          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          canvas.style.width = `${viewport.width / pixelRatio}px`
          canvas.style.height = `${viewport.height / pixelRatio}px`
          pagesElement.append(canvas)

          const context = canvas.getContext('2d')
          if (!context) continue
          const task = page.render({ canvas, canvasContext: context, viewport })
          renderTasks.push(task)
          void task.promise.catch((reason) => {
            if (!disposed && reason?.name !== 'RenderingCancelledException') setError('Could not render the PDF preview.')
          })
        }
      }

      render()
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimer !== null) window.clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(render, 100)
      })
      if (containerRef.current) resizeObserver.observe(containerRef.current)
      })
      .catch(() => {
        if (!disposed) setError('Could not open the PDF preview.')
      })

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      for (const task of renderTasks) task.cancel()
      if (documentProxy) void documentProxy.destroy()
    }
  }, [revision])

  return (
    <div className="pdf-preview" ref={containerRef}>
      {error ? <div className="pdf-empty">{error}</div> : <div className="pdf-pages" ref={pagesRef} />}
    </div>
  )
}

function CompileStatus({ result }: { result: CompileResult }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const statusRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setOpen(false)
  }, [result.compiledAt])

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!statusRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [open])

  if (result.ok) {
    const pages = result.pages ?? 1
    return <span className="compile-pill success" title={result.message}>{pages} page{pages === 1 ? '' : 's'} · ready</span>
  }

  const label = result.pages ? `${result.pages} pages · error` : 'Compile failed'
  return (
    <div
      ref={statusRef}
      className="compile-status"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      <button
        className="compile-pill failure"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((visible) => !visible)}
      >{label}</button>
      {open && (
        <div className="compile-popover" role="alert">
          <strong>{result.message}</strong>
          {result.errors.map((compileError) => <code key={compileError}>{compileError}</code>)}
        </div>
      )}
    </div>
  )
}

const emptyApplication: ApplicationInput = {
  company: '',
  position: '',
  dateApplied: null,
  status: 'In Progress',
  details: ''
}

const latexIndentation = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildLatexIndentDecorations(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.decorations = buildLatexIndentDecorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

const formatLatexKey = {
  key: 'Shift-Alt-f',
  run(view: EditorView): boolean {
    const formatted = formatLatexSource(view.state.doc.toString())
    if (formatted === view.state.doc.toString()) return true
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } })
    return true
  }
}

const latexEditorExtensions = [
  StreamLanguage.define(stex),
  EditorView.lineWrapping,
  EditorState.tabSize.of(2),
  indentUnit.of('  '),
  EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'off', autocomplete: 'off' }),
  keymap.of([formatLatexKey, indentWithTab]),
  latexIndentation
]

function buildLatexIndentDecorations(view: EditorView): DecorationSet {
  const lines = Array.from({ length: view.state.doc.lines }, (_, index) => view.state.doc.line(index + 1).text)
  const levels = latexIndentLevels(lines)
  const ranges: Range<Decoration>[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const actualLevel = Math.floor(leadingColumns(lines[index]) / 2)
    const visualLevel = Math.min(6, Math.max(0, levels[index] - actualLevel))
    if (visualLevel === 0) continue
    const line = view.state.doc.line(index + 1)
    ranges.push(Decoration.line({ attributes: { class: `latex-indent-${visualLevel}` } }).range(line.from))
  }
  return Decoration.set(ranges, true)
}

function formatLatexSource(source: string): string {
  const lines = source.split('\n')
  const levels = latexIndentLevels(lines)
  return lines.map((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return ''
    const existingLevel = Math.floor(leadingColumns(line) / 2)
    return `${'  '.repeat(Math.max(levels[index], existingLevel))}${trimmed}`
  }).join('\n')
}

function latexIndentLevels(lines: string[]): number[] {
  const levels: number[] = []
  let level = 0

  for (const line of lines) {
    const text = line.trimStart()
    const isComment = text.startsWith('%')
    const closesGroup = !isComment && (
      /^\\(?:resumeSubHeadingListEnd|resumeItemListEnd)\b/.test(text) ||
      /^\\end\{(?!document\})[^}]+\}/.test(text)
    )
    if (closesGroup) level = Math.max(0, level - 1)
    levels.push(level)

    const opensGroup = !isComment && (
      /^\\(?:resumeSubHeadingListStart|resumeItemListStart)\b/.test(text) ||
      /^\\begin\{(?!document\})[^}]+\}/.test(text)
    )
    if (opensGroup) level += 1
  }
  return levels
}

function leadingColumns(line: string): number {
  return (line.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '  ').length
}

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>('resume')
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [agentExpanded, setAgentExpanded] = useState(false)
  const [applications, setApplications] = useState<InternshipApplication[]>([])
  const [editing, setEditing] = useState<ApplicationInput | null>(null)
  const [resume, setResume] = useState<ResumeState | null>(null)
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [codexState, setCodexState] = useState<CodexState | null>(null)
  const [chat, setChat] = useState<ChatItem[]>([])
  const [message, setMessage] = useState('')
  const [codexBusy, setCodexBusy] = useState(false)
  const [draftDialogOpen, setDraftDialogOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftProfileId, setDraftProfileId] = useState('general-swe')
  const codexInputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    localStorage.setItem('internship-os-theme', theme)
  }, [theme])

  const refresh = useCallback(async () => {
    const [nextApplications, nextResume] = await Promise.all([
      window.internshipOS.applications.list(),
      window.internshipOS.resume.get()
    ])
    setApplications(nextApplications)
    setResume(nextResume)
    setSource(nextResume.source)
  }, [])

  useEffect(() => {
    void refresh().catch(showError)
    void window.internshipOS.codex.connect().then(setCodexState).catch(showError)
    const unsubscribe = window.internshipOS.codex.onEvent(handleCodexEvent)
    return unsubscribe
  }, [refresh])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      const command = event.metaKey || event.ctrlKey
      if (event.key === 'Escape' && draftDialogOpen) {
        event.preventDefault()
        setDraftDialogOpen(false)
      } else if (command && event.key === '1') {
        event.preventDefault()
        setView('resume')
      } else if (command && event.key === '2') {
        event.preventDefault()
        setView('tracker')
      } else if (command && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setAgentExpanded(true)
        window.setTimeout(() => codexInputRef.current?.focus(), 0)
      } else if (event.key === 'Escape' && agentExpanded) {
        event.preventDefault()
        setAgentExpanded(false)
      } else if (command && event.key.toLowerCase() === 's' && view === 'resume') {
        event.preventDefault()
        void resumeAction('save')
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [agentExpanded, draftDialogOpen, view, source])

  const handleCodexEvent = useCallback(
    (event: CodexEvent) => {
      if (event.type === 'message-delta') {
        setChat((items) => {
          const last = items.at(-1)
          if (last?.role === 'assistant' && !last.approval) {
            return [...items.slice(0, -1), { ...last, text: last.text + event.text }]
          }
          return [...items, { id: crypto.randomUUID(), role: 'assistant', text: event.text }]
        })
      } else if (event.type === 'message') {
        setChat((items) => {
          const last = items.at(-1)
          if (last?.role === 'assistant' && last.text.trim() === event.text.trim()) return items
          if (last?.role === 'assistant' && event.text.endsWith(last.text)) {
            return [...items.slice(0, -1), { ...last, text: event.text }]
          }
          return [...items, { id: crypto.randomUUID(), role: 'assistant', text: event.text }]
        })
      } else if (event.type === 'command') {
        setChat((items) => [...items, { id: crypto.randomUUID(), role: 'system', text: `Running: ${event.text}` }])
      } else if (event.type === 'approval') {
        setChat((items) => [
          ...items,
          {
            id: crypto.randomUUID(),
            role: 'system',
            text: event.summary,
            approval: { requestId: event.requestId }
          }
        ])
      } else if (event.type === 'error') {
        setChat((items) => [...items, { id: crypto.randomUUID(), role: 'system', text: event.text }])
        setCodexBusy(false)
      } else if (event.type === 'turn-completed') {
        setCodexBusy(false)
        void refresh().catch(showError)
      }
    },
    [refresh]
  )

  async function saveApplication(): Promise<void> {
    if (!editing) return
    setBusy(true)
    try {
      const next = await window.internshipOS.applications.save(editing)
      setApplications(next)
      setEditing(null)
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function removeApplication(id: string): Promise<void> {
    if (!confirm('Remove this application from the tracker? Archived files will remain local.')) return
    try {
      setApplications(await window.internshipOS.applications.remove(id))
    } catch (error) {
      showError(error)
    }
  }

  async function resumeAction(action: 'save' | 'compile' | 'undo' | 'archive'): Promise<void> {
    setBusy(true)
    try {
      if (action === 'archive') {
        await window.internshipOS.resume.archive()
      } else {
        const state =
          action === 'save'
            ? await window.internshipOS.resume.saveAndCompile(source)
            : action === 'compile'
              ? await window.internshipOS.resume.compile()
              : await window.internshipOS.resume.undo()
        setResume(state)
        if (action !== 'save' || state.lastCompile?.ok) setSource(state.source)
      }
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function selectResumeProfile(profileId: string): Promise<void> {
    if (!resume || profileId === resume.activeProfileId) return
    if (source !== resume.source && !confirm('Switch profiles and discard the unsaved LaTeX changes?')) return
    setBusy(true)
    try {
      const state = await window.internshipOS.resume.selectProfile(profileId)
      setResume(state)
      setSource(state.source)
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  function openJobDraftDialog(): void {
    if (!resume) return
    if (source !== resume.source && !confirm('Create the draft from the last saved template and discard unsaved editor changes?')) return
    setDraftName('')
    setDraftProfileId(resume.activeProfileId)
    setDraftDialogOpen(true)
  }

  async function createJobDraft(): Promise<void> {
    if (!resume) return
    const name = draftName.trim()
    if (!name) return

    setBusy(true)
    try {
      const state = await window.internshipOS.resume.createJobDraft(name, draftProfileId)
      setResume(state)
      setSource(state.source)
      setDraftDialogOpen(false)
      setDraftName('')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function selectJobDraft(draftId: string | null): Promise<void> {
    if (!resume || draftId === resume.jobDraft.id) return
    if (source !== resume.source && !confirm('Switch resumes and discard unsaved editor changes?')) return
    setBusy(true)
    try {
      const state = await window.internshipOS.resume.selectJobDraft(draftId)
      setResume(state)
      setSource(state.source)
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function discardJobDraft(draftId: string, draftName: string): Promise<void> {
    if (!resume) return
    if (!confirm(`Discard the ${draftName} draft? The ${resume.profileName} template will not be changed.`)) return
    setBusy(true)
    try {
      const state = await window.internshipOS.resume.discardJobDraft(draftId)
      setResume(state)
      setSource(state.source)
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function sendMessage(): Promise<void> {
    const text = message.trim()
    if (!text || codexBusy) return
    setMessage('')
    setChat((items) => [...items, { id: crypto.randomUUID(), role: 'user', text }])
    setCodexBusy(true)
    setAgentExpanded(true)
    try {
      await window.internshipOS.codex.send(text)
    } catch (error) {
      setCodexBusy(false)
      showError(error)
    }
  }

  async function decideApproval(itemId: string, requestId: string | number, decision: 'accept' | 'decline'): Promise<void> {
    await window.internshipOS.codex.respondToApproval(requestId, decision)
    setChat((items) => items.map((item) => (item.id === itemId ? { ...item, approval: undefined, text: `${item.text} — ${decision}ed` } : item)))
  }

  async function changeEditMode(mode: CodexEditMode): Promise<void> {
    try {
      setCodexState(await window.internshipOS.codex.setEditMode(mode))
    } catch (error) {
      showError(error)
    }
  }

  function showError(error: unknown): void {
    console.error(error)
  }

  const stats = useMemo(
    () => ({
      total: applications.length,
      submitted: applications.filter((application) => application.status === 'Submitted').length,
      inProgress: applications.filter((application) => application.status === 'In Progress').length
    }),
    [applications]
  )

  return (
    <div className="app-shell">
      <main className="workspace">
        <div className="global-toolbar" aria-label="Application controls">
          <WorkspaceActions
            current={view}
            onResume={() => setView('resume')}
            onTracker={() => setView('tracker')}
          />
          <span className="toolbar-divider" />
          {view === 'resume' ? (
            <>
            <details
              className={`profile-menu ${busy || !resume ? 'disabled' : ''}`}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.removeAttribute('open')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.currentTarget.removeAttribute('open')
                  event.currentTarget.querySelector('summary')?.focus()
                }
              }}
            >
              <summary
                aria-label="Active resume profile"
                title={resume?.profiles.find((profile) => profile.id === resume.activeProfileId)?.focus ?? 'Resume profile'}
                onClick={(event) => { if (busy || !resume) event.preventDefault() }}
              >
                <span>{resume?.profileName ?? 'General SWE'}</span>
              </summary>
              <div className="profile-menu-options">
                {resume?.profiles.map((profile) => (
                  <button
                    key={profile.id}
                    className={profile.id === resume.activeProfileId ? 'selected' : ''}
                    onClick={(event) => {
                      event.currentTarget.closest('details')?.removeAttribute('open')
                      void selectResumeProfile(profile.id)
                    }}
                  >
                    <span>{profile.id === resume.activeProfileId ? '✓' : ''}</span>{profile.name}
                  </button>
                ))}
              </div>
            </details>
            <details
              className={`job-draft-menu ${busy || !resume ? 'disabled' : ''}`}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.removeAttribute('open')
              }}
            >
              <summary title="Open or create a temporary job-specific resume">
                {resume?.jobDraft.active ? `${resume.jobDraft.name} Draft` : resume?.jobDraft.drafts.length ? `Drafts (${resume.jobDraft.drafts.length})` : 'Drafts'}
              </summary>
              <div className="job-draft-menu-options">
                <button
                  className="new-draft-option"
                  onClick={(event) => {
                    event.currentTarget.closest('details')?.removeAttribute('open')
                    openJobDraftDialog()
                  }}
                ><span>＋</span>New Draft…</button>
                {resume?.jobDraft.drafts.map((draft) => (
                  <div className="draft-option-row" key={draft.id}>
                    <button
                      className={`draft-option-select ${draft.id === resume.jobDraft.id ? 'selected' : ''}`}
                      onClick={(event) => {
                        event.currentTarget.closest('details')?.removeAttribute('open')
                        void selectJobDraft(draft.id)
                      }}
                    ><span>{draft.id === resume.jobDraft.id ? '✓' : ''}</span><span>{draft.name}</span></button>
                    <button className="draft-option-delete" aria-label={`Delete ${draft.name} draft`} title={`Delete ${draft.name} draft`} onClick={() => void discardJobDraft(draft.id, draft.name)}>×</button>
                  </div>
                ))}
              </div>
            </details>
            {resume?.jobDraft.active && <button className="stop-draft-action" onClick={() => void selectJobDraft(null)} disabled={busy}>Stop Draft</button>}
            </>
          ) : (
            <div className="toolbar-title"><strong>Applications</strong><span>{stats.total} total · {stats.submitted} submitted</span></div>
          )}
          <div className="toolbar-drag-space" />
          <div className="context-actions">
            {view === 'resume' ? (
              <>
                <button onClick={() => void resumeAction('undo')} disabled={busy}>Undo</button>
                <button onClick={() => void window.internshipOS.resume.openPdf()} disabled={!resume?.hasPdf} title="Open current PDF">PDF</button>
                <button className="primary" onClick={() => void resumeAction('save')} disabled={busy}>Save & Compile</button>
                <details className="toolbar-more">
                  <summary aria-label="More resume actions" title="More resume actions">•••</summary>
                  <div className="toolbar-menu">
                    <button onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void resumeAction('compile') }} disabled={busy}>Compile without saving</button>
                    <button onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void window.internshipOS.resume.revealPdf() }} disabled={!resume?.hasPdf}>Reveal PDF in Finder</button>
                    <button onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void resumeAction('archive') }} disabled={!resume?.hasPdf}>Archive snapshot</button>
                  </div>
                </details>
              </>
            ) : (
              <button className="primary" onClick={() => setEditing({ ...emptyApplication })}>+ Add application</button>
            )}
          </div>
          <button
            className="theme-toggle"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.4A8 8 0 0 1 8.6 4a8 8 0 1 0 11.4 11.4Z" /></svg>
            )}
          </button>
        </div>
        {draftDialogOpen && resume && (
          <div
            className="draft-dialog-backdrop"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setDraftDialogOpen(false)
            }}
          >
            <form
              className="draft-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="draft-dialog-title"
              onSubmit={(event) => { event.preventDefault(); void createJobDraft() }}
            >
              <div className="draft-dialog-heading">
                <strong id="draft-dialog-title">New Job Draft</strong>
                <span>Temporary resume for one application</span>
              </div>
              <label>
                Company or job
                <input
                  autoFocus
                  maxLength={80}
                  value={draftName}
                  placeholder="Amazon"
                  onChange={(event) => setDraftName(event.target.value)}
                />
              </label>
              <label>
                Starting template
                <select value={draftProfileId} onChange={(event) => setDraftProfileId(event.target.value)}>
                  {resume.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </label>
              <div className="draft-dialog-actions">
                <button type="button" onClick={() => setDraftDialogOpen(false)}>Cancel</button>
                <button className="primary" type="submit" disabled={busy || !draftName.trim()}>Create Draft</button>
              </div>
            </form>
          </div>
        )}
        <section className="primary-panel">
          {view === 'tracker' ? (
            <Tracker
              applications={applications}
              editing={editing}
              busy={busy}
              onEdit={setEditing}
              onSave={() => void saveApplication()}
              onRemove={(id) => void removeApplication(id)}
            />
          ) : (
            <ResumeStudio
              resume={resume}
              source={source}
              theme={theme}
              onSourceChange={setSource}
            />
          )}
        </section>
        <CodexDock
          inputRef={codexInputRef}
          expanded={agentExpanded}
          context={view === 'tracker' ? 'Applications' : resume?.jobDraft.active ? `${resume.jobDraft.name} · ${resume.profileName}` : resume?.profileName ?? 'Resume'}
          state={codexState}
          items={chat}
          value={message}
          busy={codexBusy}
          onExpandedChange={setAgentExpanded}
          onValueChange={setMessage}
          onSend={() => void sendMessage()}
          onEditModeChange={(mode) => void changeEditMode(mode)}
          onOpenProfile={() => void window.internshipOS.codex.openProfile().catch(showError)}
          onReconnect={() => void window.internshipOS.codex.connect().then(setCodexState).catch(showError)}
          onApproval={(itemId, requestId, decision) => void decideApproval(itemId, requestId, decision)}
        />
      </main>
    </div>
  )
}

function Icon({ name }: { name: 'resume' | 'tracker' | 'codex' }): React.JSX.Element {
  if (name === 'resume') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l3 3v14H7z" /><path d="M14 3.5v3h3M9.5 11h5M9.5 14h5M9.5 17h3.5" /></svg>
  }
  if (name === 'tracker') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 12h8M8 15h5" /></svg>
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5c.7 4.6 3 6.8 7.5 7.5-4.5.7-6.8 3-7.5 7.5-.7-4.5-3-6.8-7.5-7.5C9 10.3 11.3 8.1 12 3.5Z" /></svg>
}

function Tracker(props: {
  applications: InternshipApplication[]
  editing: ApplicationInput | null
  busy: boolean
  onEdit: (application: ApplicationInput | null) => void
  onSave: () => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  const { applications, editing, busy, onEdit, onSave, onRemove } = props
  return (
    <div className="page tracker-page">
      {editing && (
        <div className="editor-card">
          <div className="form-grid">
            <label>Company<input value={editing.company} autoFocus onChange={(event) => onEdit({ ...editing, company: event.target.value })} /></label>
            <label>Position<input value={editing.position} onChange={(event) => onEdit({ ...editing, position: event.target.value })} /></label>
            <label>Date Applied<input type="date" value={editing.dateApplied ?? ''} onChange={(event) => onEdit({ ...editing, dateApplied: event.target.value || null })} /></label>
            <label>Status<select value={editing.status} onChange={(event) => onEdit({ ...editing, status: event.target.value as ApplicationInput['status'] })}>{APPLICATION_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
            <label className="details-field">Details<textarea value={editing.details} placeholder="URL, location, stage, or notes" onChange={(event) => onEdit({ ...editing, details: event.target.value })} /></label>
          </div>
          <div className="form-actions"><button className="ghost" onClick={() => onEdit(null)}>Cancel</button><button className="primary" disabled={busy} onClick={onSave}>Save</button></div>
        </div>
      )}

      <div className="table-card">
        <table>
          <thead><tr><th>Company</th><th>Position</th><th>Date Applied</th><th>Application Status</th><th>Details</th><th /></tr></thead>
          <tbody>
            {applications.length === 0 ? (
              <tr><td colSpan={6} className="empty">No applications yet. Add one manually or ask Codex.</td></tr>
            ) : applications.map((application) => (
              <tr key={application.id} onDoubleClick={() => onEdit(application)}>
                <td><strong>{application.company}</strong></td>
                <td>{application.position}</td>
                <td>{application.dateApplied || '—'}</td>
                <td><span className={`status ${application.status.toLowerCase().replace(' ', '-')}`}>{application.status}</span></td>
                <td className="details-cell"><span>{application.details || '—'}</span>{application.submissions.length > 0 && <small>{application.submissions.length} resume snapshot{application.submissions.length === 1 ? '' : 's'}</small>}</td>
                <td className="row-actions"><button onClick={() => onEdit(application)}>Edit</button><button onClick={() => onRemove(application.id)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function parseCompactDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine: number | undefined
  let newLine: number | undefined

  for (const line of diff.split('\n')) {
    const header = line.match(/^@@ old (\d+|—) · new (\d+|—) @@$/)
    if (header) {
      oldLine = header[1] === '—' ? undefined : Number(header[1])
      newLine = header[2] === '—' ? undefined : Number(header[2])
      rows.push({ type: 'hunk', text: `Lines ${header[1]} → ${header[2]}` })
      continue
    }
    if (!line && rows.at(-1)?.type === 'hunk') continue
    if (!line) continue

    const marker = line[0]
    const text = /^[+\- ] /.test(line) ? line.slice(2) : line
    if (marker === '+') {
      rows.push({ type: 'added', text, newLine })
      if (newLine != null) newLine += 1
    } else if (marker === '-') {
      rows.push({ type: 'removed', text, oldLine, anchorLine: newLine })
      if (oldLine != null) oldLine += 1
    } else {
      rows.push({ type: 'context', text, oldLine, newLine })
      if (oldLine != null) oldLine += 1
      if (newLine != null) newLine += 1
    }
  }
  return rows
}

function inlineDiffExtension(review: ResumeChangeReview): Extension {
  const rows = parseCompactDiff(review.diff)
  const decorations = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildInlineDiffDecorations(view, rows)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) this.decorations = buildInlineDiffDecorations(update.view, rows)
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
  const previousVersionTooltip = hoverTooltip((view, position) => {
    const currentLine = view.state.doc.lineAt(position)
    const removed = resolvedRemovedGroups(view, rows).get(currentLine.number)
    if (!removed?.length) return null
    return {
      pos: currentLine.from,
      end: currentLine.to,
      above: true,
      create: () => {
        const tooltip = document.createElement('div')
        tooltip.className = 'cm-inline-diff-tooltip'
        const heading = document.createElement('div')
        heading.className = 'cm-inline-diff-heading'
        heading.textContent = 'Previous version'
        tooltip.append(heading)
        for (const row of removed) {
          const line = document.createElement('div')
          line.className = 'cm-inline-diff-previous-line'
          const number = document.createElement('span')
          number.textContent = row.oldLine == null ? '' : String(row.oldLine)
          const marker = document.createElement('span')
          marker.textContent = '−'
          const code = document.createElement('code')
          code.textContent = row.text || ' '
          line.append(number, marker, code)
          tooltip.append(line)
        }
        return { dom: tooltip }
      }
    }
  })
  return [decorations, previousVersionTooltip]
}

function buildInlineDiffDecorations(view: EditorView, rows: DiffRow[]): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const lines = new Map<number, Set<string>>()

  for (const row of rows) {
    if (row.type === 'added' && row.newLine != null) {
      const lineNumber = locateDiffLine(view, row.newLine, row.text)
      if (lineNumber != null) lines.set(lineNumber, new Set([...(lines.get(lineNumber) ?? []), 'cm-diff-added-line']))
    }
  }

  for (const lineNumber of resolvedRemovedGroups(view, rows).keys()) {
    const classes = lines.get(lineNumber) ?? new Set<string>()
    classes.add(classes.has('cm-diff-added-line') ? 'cm-diff-has-previous' : 'cm-diff-deletion-anchor')
    lines.set(lineNumber, classes)
  }

  for (const [lineNumber, classes] of lines) {
    const line = view.state.doc.line(lineNumber)
    ranges.push(Decoration.line({ attributes: { class: [...classes].join(' ') } }).range(line.from))
  }
  return Decoration.set(ranges, true)
}

function resolvedRemovedGroups(view: EditorView, rows: DiffRow[]): Map<number, DiffRow[]> {
  const groups = new Map<number, DiffRow[]>()
  const addedByExpectedLine = new Map(rows.filter((row) => row.type === 'added' && row.newLine != null).map((row) => [row.newLine!, row]))
  for (const row of rows) {
    if (row.type !== 'removed') continue
    const expected = Math.max(1, row.anchorLine ?? 1)
    const added = addedByExpectedLine.get(expected)
    const resolved = added ? locateDiffLine(view, expected, added.text) : Math.min(view.state.doc.lines, expected)
    if (resolved != null) groups.set(resolved, [...(groups.get(resolved) ?? []), row])
  }
  return groups
}

function locateDiffLine(view: EditorView, expected: number, text: string): number | null {
  const document = view.state.doc
  const clamped = Math.min(document.lines, Math.max(1, expected))
  if (document.line(clamped).text === text) return clamped
  for (let distance = 1; distance <= 4; distance += 1) {
    const before = clamped - distance
    const after = clamped + distance
    if (before >= 1 && document.line(before).text === text) return before
    if (after <= document.lines && document.line(after).text === text) return after
  }
  return expected >= 1 && expected <= document.lines ? expected : null
}

function ResumeStudio(props: {
  resume: ResumeState | null
  source: string
  theme: Theme
  onSourceChange: (value: string) => void
}): React.JSX.Element {
  const { resume, source, theme, onSourceChange } = props
  const [diffOpen, setDiffOpen] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const [resizing, setResizing] = useState(false)
  const [editorShare, setEditorShare] = useState(() => {
    const stored = Number(localStorage.getItem('resume-editor-share'))
    return Number.isFinite(stored) && stored >= 25 && stored <= 75 ? stored : 50
  })
  const editorShareRef = useRef(editorShare)

  useEffect(() => {
    setDiffOpen(false)
  }, [resume?.activeProfileId, resume?.lastChange?.changedAt])

  useEffect(() => {
    editorShareRef.current = editorShare
    localStorage.setItem('resume-editor-share', String(editorShare))
  }, [editorShare])

  const editorExtensions = useMemo(
    () => resume?.lastChange && diffOpen
      ? [...latexEditorExtensions, inlineDiffExtension(resume.lastChange)]
      : latexEditorExtensions,
    [diffOpen, resume?.lastChange?.changedAt, resume?.lastChange?.diff]
  )

  function shareAt(clientX: number): number {
    const bounds = gridRef.current?.getBoundingClientRect()
    if (!bounds) return editorShareRef.current
    return Math.min(75, Math.max(25, ((clientX - bounds.left) / bounds.width) * 100))
  }

  function previewEditorShare(clientX: number, separator: HTMLDivElement): number {
    const share = shareAt(clientX)
    editorShareRef.current = share
    gridRef.current?.style.setProperty('grid-template-columns', `minmax(250px, ${share}%) 7px minmax(250px, 1fr)`)
    separator.setAttribute('aria-valuenow', String(Math.round(share)))
    return share
  }

  function finishResize(share = editorShareRef.current): void {
    setResizing(false)
    setEditorShare(share)
  }

  function nudgeEditorShare(delta: number): void {
    setEditorShare((current) => {
      return Math.min(75, Math.max(25, current + delta))
    })
  }

  return (
    <div className="page resume-page">
      <div
        ref={gridRef}
        className={`resume-grid ${resizing ? 'resizing' : ''}`}
        style={{ gridTemplateColumns: `minmax(250px, ${editorShare}%) 7px minmax(250px, 1fr)` }}
      >
        <div className="source-pane">
          <div className="pane-label">
            <span className="pane-title">main.tex</span>
            <div className="pane-label-actions">
              {resume?.lastChange && (
                <button
                  className={`change-review-chip ${diffOpen ? 'active' : ''}`}
                  title={`Last change: ${resume.lastChange.summary}`}
                  onClick={() => setDiffOpen((open) => !open)}
                >
                  <span>Last change</span>
                  <strong>{resume.lastChange.summary}</strong>
                  <em>{diffOpen ? 'Hide' : 'Diff'}</em>
                </button>
              )}
              <button title="Format LaTeX indentation (⌥⇧F)" onClick={() => onSourceChange(formatLatexSource(source))}>Format</button>
            </div>
          </div>
          <div className="latex-editor">
            <CodeMirror
              value={source}
              height="100%"
              theme={theme === 'dark' ? xcodeDark : xcodeLight}
              extensions={editorExtensions}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLineGutter: true,
                highlightSelectionMatches: true,
                autocompletion: false,
                bracketMatching: true,
                closeBrackets: true,
                indentOnInput: true,
                searchKeymap: true
              }}
              onChange={onSourceChange}
            />
          </div>
        </div>
        <div
          className="pane-resizer"
          role="separator"
          aria-label="Resize LaTeX editor and PDF preview"
          aria-orientation="vertical"
          aria-valuemin={25}
          aria-valuemax={75}
          aria-valuenow={Math.round(editorShare)}
          tabIndex={0}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            setResizing(true)
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              previewEditorShare(event.clientX, event.currentTarget)
            }
          }}
          onPointerUp={(event) => {
            const share = previewEditorShare(event.clientX, event.currentTarget)
            event.currentTarget.releasePointerCapture(event.pointerId)
            finishResize(share)
          }}
          onPointerCancel={() => finishResize()}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); nudgeEditorShare(-2) }
            if (event.key === 'ArrowRight') { event.preventDefault(); nudgeEditorShare(2) }
          }}
        ><span /></div>
        <div className="pdf-pane">
          <div className="pane-label">
            <span className="pane-title">Preview</span>
            <div className="pane-label-actions">
              {resume?.lastCompile && (
                <CompileStatus result={resume.lastCompile} />
              )}
              <button onClick={() => void window.internshipOS.resume.revealPdf()}>Reveal file</button>
            </div>
          </div>
          {resume?.pdfRevision ? <PdfPreview revision={resume.pdfRevision} /> : <div className="pdf-empty">Compile successfully to create the one-page preview.</div>}
        </div>
      </div>
    </div>
  )
}

function WorkspaceActions(props: {
  current: View
  onResume: () => void
  onTracker: () => void
}): React.JSX.Element {
  return (
    <div className="workspace-actions" role="navigation" aria-label="Workspace">
      <button className={props.current === 'resume' ? 'active' : ''} onClick={props.onResume} title="Resume (⌘1)">
        <Icon name="resume" /><span>Resume</span><kbd className="toolbar-shortcut">⌘1</kbd>
      </button>
      <button className={props.current === 'tracker' ? 'active' : ''} onClick={props.onTracker} title="Tracker (⌘2)">
        <Icon name="tracker" /><span>Tracker</span><kbd className="toolbar-shortcut">⌘2</kbd>
      </button>
    </div>
  )
}

function CodexDock(props: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  expanded: boolean
  context: string
  state: CodexState | null
  items: ChatItem[]
  value: string
  busy: boolean
  onExpandedChange: (expanded: boolean) => void
  onValueChange: (value: string) => void
  onSend: () => void
  onEditModeChange: (mode: CodexEditMode) => void
  onOpenProfile: () => void
  onReconnect: () => void
  onApproval: (itemId: string, requestId: string | number, decision: 'accept' | 'decline') => void
}): React.JSX.Element {
  const { inputRef, expanded, context, state, items, value, busy, onExpandedChange, onValueChange, onSend, onEditModeChange, onOpenProfile, onReconnect, onApproval } = props
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (expanded) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [items, busy, expanded])

  const mode = state?.editMode ?? 'review'
  const status = !state?.authenticated ? 'Offline' : busy ? 'Working' : 'Ready'

  function send(): void {
    if (!value.trim() || busy || !state?.authenticated) return
    onExpandedChange(true)
    onSend()
  }

  return (
    <div className={`codex-layer ${expanded ? 'expanded' : ''}`}>
      {expanded && (
        <section className="codex-overlay" aria-label="Codex conversation">
          <header className="codex-overlay-header">
            <div className="agent-identity">
              <span className="agent-mark"><Icon name="codex" /></span>
              <div><strong>Codex</strong><span>{context}</span></div>
            </div>
            <div className="agent-header-actions">
              <button className="profile-button" onClick={onOpenProfile} title="Open the durable local candidate profile">Profile</button>
              <div className="edit-mode-switch" role="group" aria-label="Codex edit mode">
                <button disabled={busy} className={mode === 'review' ? 'active' : ''} onClick={() => onEditModeChange('review')} title="Codex proposes changes but does not apply them">Review First</button>
                <button disabled={busy} className={mode === 'auto' ? 'active auto' : ''} onClick={() => onEditModeChange('auto')} title="Codex applies requested changes and compiles automatically">Auto Apply</button>
              </div>
              <span className={`agent-status ${!state?.authenticated ? 'offline' : busy ? 'working' : ''}`}><i />{status}</span>
              <button className="codex-collapse" aria-label="Collapse Codex" title="Collapse Codex (Esc)" onClick={() => onExpandedChange(false)}>⌄</button>
            </div>
          </header>
          <div className="codex-overlay-feed">
            <div className="codex-feed-inner">
              {items.length === 0 && <div className="agent-empty"><span className="agent-mark large"><Icon name="codex" /></span><p>Ask Codex to tailor this resume or manage an application.</p></div>}
              {items.map((item) => (
                <article key={item.id} className={`agent-message ${item.role}`}>
                  <div className="agent-message-role">{item.role === 'user' ? 'You' : item.role === 'assistant' ? 'Codex' : 'Activity'}</div>
                  <div className="agent-message-body"><p>{item.text}</p>{item.approval && <div className="approval-actions"><button onClick={() => onApproval(item.id, item.approval!.requestId, 'decline')}>Decline</button><button className="primary" onClick={() => onApproval(item.id, item.approval!.requestId, 'accept')}>Allow</button></div>}</div>
                </article>
              ))}
              {busy && <div className="agent-thinking"><span className="agent-mark"><Icon name="codex" /></span><div className="thinking"><span /><span /><span /></div></div>}
              <div ref={endRef} />
            </div>
          </div>
          {!state?.authenticated && <div className="connect-card codex-connect-card"><p>{state?.error ?? 'Codex login is required.'}</p><button onClick={onReconnect}>Reconnect</button></div>}
        </section>
      )}
      <div className="codex-dock">
        <button className="codex-dock-toggle" aria-label={expanded ? 'Collapse Codex' : 'Expand Codex'} title={`${expanded ? 'Collapse' : 'Open'} Codex (⌘K)`} onClick={() => onExpandedChange(!expanded)}><Icon name="codex" /></button>
        <span className="codex-context" title={context}>{context}</span>
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          placeholder="Ask Codex…"
          aria-label="Message Codex"
          onFocus={() => onExpandedChange(true)}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div className="edit-mode-switch compact" role="group" aria-label="Codex edit mode">
          <button disabled={busy} className={mode === 'review' ? 'active' : ''} onClick={() => onEditModeChange('review')} title="Review changes before applying">Review</button>
          <button disabled={busy} className={mode === 'auto' ? 'active auto' : ''} onClick={() => onEditModeChange('auto')} title="Apply and compile automatically">Auto</button>
        </div>
        <button className={`codex-dock-status ${!state?.authenticated ? 'offline' : busy ? 'working' : ''}`} aria-label={`Codex is ${status}`} title={status} onClick={() => onExpandedChange(true)}><i /></button>
        <button className="codex-send" aria-label="Send message" disabled={!value.trim() || busy || !state?.authenticated} onClick={send}>↑</button>
      </div>
    </div>
  )
}
