import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CodexClient, codexExecutableCandidates, findCodexExecutable } from '../src/main/codex-client'
import { AppPaths } from '../src/main/core/paths'
import { SettingsStore } from '../src/main/core/settings'

type Check = { label: string; ok: boolean; detail: string }
const checks: Check[] = []
const add = (label: string, ok: boolean, detail: string): void => { checks.push({ label, ok, detail }) }

add('Platform', process.platform === 'darwin', `${process.platform}-${process.arch}`)
add('Node.js', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node)
add('Dependencies', existsSync(resolve('node_modules', 'electron', 'package.json')), existsSync(resolve('node_modules')) ? 'installed' : 'missing; run npm run setup')

const latex = ['latexmk', 'pdflatex'].map((name) => resolve('.tools', 'tinytex', 'TinyTeX', 'bin', 'universal-darwin', name))
add('Local LaTeX', latex.every(existsSync), latex.every(existsSync) ? 'repository toolchain found' : 'missing; run npm run setup')

const freshRoot = mkdtempSync(join(tmpdir(), 'internship-os-doctor.'))
try {
  const fresh = new SettingsStore(join(freshRoot, 'data')).get()
  add('Fresh onboarding', !fresh.onboardingComplete, fresh.onboardingComplete ? 'unexpectedly marked complete' : 'starts at Welcome')
} finally {
  rmSync(freshRoot, { recursive: true, force: true })
}

const codex = findCodexExecutable()
if (!codex) {
  const searched = codexExecutableCandidates().slice(0, 8).join(', ')
  add('Codex executable', false, `not found (searched ${searched})`)
  add('Codex authentication', false, 'install Codex, then run codex login')
  add('Codex app-server', false, 'not testable until Codex is installed')
} else {
  const version = spawnSync(codex, ['--version'], { encoding: 'utf8', timeout: 5000 })
  const login = spawnSync(codex, ['login', 'status'], { encoding: 'utf8', timeout: 5000 })
  const appServer = spawnSync(codex, ['app-server', '--help'], { encoding: 'utf8', timeout: 5000 })
  add('Codex executable', version.status === 0, `${codex}${version.stdout.trim() ? ` · ${version.stdout.trim()}` : ''}`)
  add('Codex authentication', login.status === 0, login.status === 0 ? login.stdout.trim() || 'signed in' : 'not signed in; run codex login (or codex login --device-auth)')
  add('Codex app-server', appServer.status === 0, appServer.status === 0 ? 'supported' : 'unsupported; update Codex')
  if (login.status === 0 && appServer.status === 0) {
    const handshakeRoot = mkdtempSync(join(tmpdir(), 'internship-os-codex-doctor.'))
    const workspace = join(handshakeRoot, 'assistant-workspace')
    mkdirSync(workspace, { recursive: true })
    const client = new CodexClient(workspace, new AppPaths(join(handshakeRoot, 'data'), join(handshakeRoot, 'downloads')))
    try {
      const state = await Promise.race([
        client.connect(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('timed out after 10 seconds')), 10_000))
      ])
      add('Internship OS handshake', state.connected && state.authenticated, state.connected && state.authenticated ? `connected as ${state.accountLabel}` : state.error ?? 'connection failed')
    } catch (error) {
      add('Internship OS handshake', false, error instanceof Error ? error.message : String(error))
    } finally {
      client.stop()
      rmSync(handshakeRoot, { recursive: true, force: true })
    }
  }
}

const width = Math.max(...checks.map((check) => check.label.length))
console.log('Internship OS doctor\n')
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.label.padEnd(width)}  ${check.detail}`)
console.log('\nFor a clean UI test, run npm run dev:fresh and confirm the window displays “Fresh test”.')
if (checks.some((check) => !check.ok)) process.exitCode = 1
