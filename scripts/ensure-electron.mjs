import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)))

export function findElectronExecutable(root = defaultRoot, environment = process.env) {
  const packageDirectory = join(root, 'node_modules', 'electron')
  const pathFile = join(packageDirectory, 'path.txt')
  try {
    const relativePath = readFileSync(pathFile, 'utf8').trim()
    if (!relativePath) return null
    const executable = environment.ELECTRON_OVERRIDE_DIST_PATH
      ? join(environment.ELECTRON_OVERRIDE_DIST_PATH, relativePath)
      : join(packageDirectory, 'dist', relativePath)
    return existsSync(executable) ? executable : null
  } catch {
    return null
  }
}

export function ensureElectronInstalled(root = defaultRoot) {
  const installed = findElectronExecutable(root)
  if (installed) return installed

  const packageDirectory = join(root, 'node_modules', 'electron')
  const installer = join(packageDirectory, 'install.js')
  if (!existsSync(installer)) {
    throw new Error('Application dependencies are missing. Run `npm run setup`.')
  }

  console.log('Electron package found, but its macOS runtime is missing. Repairing Electron…')
  const environment = { ...process.env }
  delete environment.ELECTRON_OVERRIDE_DIST_PATH
  delete environment.ELECTRON_SKIP_BINARY_DOWNLOAD
  const result = spawnSync(process.execPath, [installer], {
    cwd: root,
    env: environment,
    stdio: 'inherit'
  })
  const executable = findElectronExecutable(root, environment)
  if (result.status !== 0 || !executable) {
    throw new Error('Electron could not be downloaded. Check network or proxy access to GitHub release assets, then run `npm run setup` again.')
  }

  console.log(`Electron ready: ${executable}`)
  return executable
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    ensureElectronInstalled()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
