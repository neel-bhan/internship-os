import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagedApp = join(projectRoot, 'dist', 'mac-arm64', 'Internship OS.app')
const defaultInstalledApp = '/Applications/Internship OS.app'
const installedApp = process.env.INTERNSHIP_OS_INSTALL_PATH ?? defaultInstalledApp
const shouldLaunch = process.env.INTERNSHIP_OS_NO_LAUNCH !== '1'
const backupApp = `${installedApp}.install-backup-${process.pid}`

if (!existsSync(packagedApp)) {
  throw new Error('Packaged app not found. Run `npm run package:mac` first.')
}

if (installedApp === defaultInstalledApp) quitInstalledApp()
rmSync(backupApp, { recursive: true, force: true })

let movedExistingApp = false
try {
  if (existsSync(installedApp)) {
    renameSync(installedApp, backupApp)
    movedExistingApp = true
  }

  run('ditto', [packagedApp, installedApp])
  const packagedHash = appArchiveHash(packagedApp)
  const installedHash = appArchiveHash(installedApp)
  if (packagedHash !== installedHash) {
    throw new Error('Installed app verification failed: app.asar hashes differ.')
  }

  rmSync(backupApp, { recursive: true, force: true })
  if (shouldLaunch) run('open', [installedApp])
  console.log(`Installed Internship OS (${installedHash.slice(0, 12)}) at ${installedApp}`)
} catch (error) {
  rmSync(installedApp, { recursive: true, force: true })
  if (movedExistingApp && existsSync(backupApp)) renameSync(backupApp, installedApp)
  throw error
}

function quitInstalledApp() {
  spawnSync('osascript', ['-e', 'tell application "Internship OS" to quit'], {
    stdio: 'ignore'
  })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = spawnSync('pgrep', ['-x', 'Internship OS'], { stdio: 'ignore' })
    if (result.status !== 0) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
  throw new Error('Internship OS did not quit within five seconds.')
}

function appArchiveHash(appPath) {
  const archive = join(appPath, 'Contents', 'Resources', 'app.asar')
  if (!existsSync(archive)) throw new Error(`Missing packaged archive: ${archive}`)
  return createHash('sha256').update(readFileSync(archive)).digest('hex')
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}.`)
  }
}
