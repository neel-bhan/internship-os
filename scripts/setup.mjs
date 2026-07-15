import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const VERSION = '2026.07'
const ARCHIVE = `TinyTeX-1-darwin-v${VERSION}.tar.xz`
const SHA256 = '56174847329fb350d4b24fe2e4839c1e0bf8ca643278de83fe9cc3851a15e8a0'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const nodeMajor = Number(process.versions.node.split('.')[0])

if (nodeMajor < 20) {
  console.error(`Node.js 20 or newer is required. Detected ${process.versions.node}.`)
  process.exit(1)
}
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  console.error(`Setup currently supports Apple Silicon and Intel macOS. Detected ${process.platform}-${process.arch}.`)
  process.exit(1)
}

run('npm', ['install'], 'Installing application dependencies')

const toolDirectory = join(root, '.tools', 'tinytex')
const distribution = join(toolDirectory, 'TinyTeX')
const binDirectory = join(distribution, 'bin', 'universal-darwin')
const latexmk = join(binDirectory, 'latexmk')
const pdflatex = join(binDirectory, 'pdflatex')
const kpsewhich = join(binDirectory, 'kpsewhich')
const tlmgr = join(binDirectory, 'tlmgr')
const marker = join(toolDirectory, '.internship-os-version')
mkdirSync(toolDirectory, { recursive: true })

if (!isExpectedInstallation()) {
  rmSync(toolDirectory, { recursive: true, force: true })
  mkdirSync(toolDirectory, { recursive: true })
  const archivePath = join(toolDirectory, ARCHIVE)
  const url = `https://github.com/rstudio/tinytex-releases/releases/download/v${VERSION}/${ARCHIVE}`
  console.log(`Downloading repository-local TinyTeX ${VERSION}…`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`TinyTeX download failed: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest !== SHA256) throw new Error('TinyTeX download checksum did not match.')
  writeFileSync(archivePath, archive)
  const extracted = spawnSync('tar', ['-xJf', archivePath, '-C', toolDirectory], { stdio: 'inherit' })
  rmSync(archivePath, { force: true })
  if (extracted.status !== 0 || !existsSync(latexmk) || !existsSync(pdflatex)) {
    throw new Error('Could not extract the TinyTeX toolchain.')
  }
  chmodSync(latexmk, 0o755)
  chmodSync(pdflatex, 0o755)
}

ensureStarterPackages()
console.log(`LaTeX ready: ${firstLine(spawn(latexmk, ['-v']).stdout)}`)

const warmDirectory = mkdtempSync(join(tmpdir(), 'internship-os-latex-'))
try {
  const result = spawn(latexmk, [
    '-pdf',
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-file-line-error',
    `-outdir=${warmDirectory}`,
    join(root, 'main.tex')
  ])
  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error('The local pdfLaTeX toolchain could not compile the starter resume.')
  }
} finally {
  rmSync(warmDirectory, { recursive: true, force: true })
}

writeFileSync(marker, VERSION)
console.log('\nSetup complete. Run `npm run dev:fresh` for an isolated test workspace.')

function spawn(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH ?? ''}` }
  })
}

function run(command, args, label) {
  console.log(`${label}…`)
  const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function isExpectedInstallation() {
  try {
    return existsSync(latexmk) && existsSync(pdflatex) && readFileSync(marker, 'utf8').trim() === VERSION
  } catch {
    return false
  }
}

function ensureStarterPackages() {
  const packages = [
    { file: 'fullpage.sty', package: 'preprint' },
    { file: 'enumitem.sty', package: 'enumitem' },
    { file: 'titlesec.sty', package: 'titlesec' },
    { file: 'hyperref.sty', package: 'hyperref' },
    { file: 'marvosym.sty', package: 'marvosym' },
    { file: 'fancyhdr.sty', package: 'fancyhdr' },
    { file: 'babel.sty', package: 'babel' },
    { file: 'english.ldf', package: 'babel-english' }
  ]
  const missing = packages.filter(({ file }) => spawn(kpsewhich, [file]).status !== 0)
  if (missing.length === 0) return

  console.log('Installing starter resume LaTeX packages…')
  const update = spawn(tlmgr, ['update', '--self'])
  if (update.status !== 0) {
    process.stderr.write(update.stdout)
    process.stderr.write(update.stderr)
    throw new Error('Could not update the local TinyTeX package manager.')
  }
  for (const packageName of [...new Set(missing.map((item) => item.package))]) {
    const install = spawn(tlmgr, ['install', packageName])
    if (install.status !== 0) {
      process.stderr.write(install.stdout)
      process.stderr.write(install.stderr)
      throw new Error(`Could not install the local LaTeX package ${packageName}.`)
    }
  }
}

function firstLine(value) {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'latexmk'
}
