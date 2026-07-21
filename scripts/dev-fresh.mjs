import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'internship-os-fresh.'))
const dataRoot = join(root, 'data')
const downloadsRoot = join(root, 'downloads')
const cli = resolve('node_modules', 'electron-vite', 'bin', 'electron-vite.js')

console.log('Starting a disposable first-run test.')
console.log(`Fresh data: ${dataRoot}`)
console.log('This window should show Welcome and a “Fresh test” badge. Your normal Internship OS data is not used.\n')

const child = spawn(process.execPath, [cli, 'dev'], {
  cwd: resolve('.'),
  stdio: 'inherit',
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    INTERNSHIP_OS_HOME: dataRoot,
    INTERNSHIP_OS_DOWNLOADS: downloadsRoot,
    INTERNSHIP_OS_FRESH: '1',
    INTERNSHIP_OS_LAUNCHER_PID: String(process.pid)
  }
})

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  rmSync(root, { recursive: true, force: true })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (process.platform === 'win32') child.kill(signal)
    else if (child.pid) {
      try { process.kill(-child.pid, signal) } catch { /* The development process already exited. */ }
    }
    cleanup()
    process.exit(0)
  })
}
process.on('exit', cleanup)

child.on('exit', (code, signal) => {
  cleanup()
  process.exitCode = signal ? 0 : code ?? 1
})
