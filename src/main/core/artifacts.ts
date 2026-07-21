import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

export function exportPdfArtifact(
  sourcePath: string,
  workspaceRoot: string,
  downloadsRoot: string,
  requestedName?: string
): string {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error(`PDF not found: ${sourcePath}`)

  const workspace = realpathSync(workspaceRoot)
  const source = realpathSync(sourcePath)
  const sourceRelative = relative(workspace, source)
  if (sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) {
    throw new Error('Only PDFs created inside the Internship OS assistant workspace can be exported.')
  }
  if (extname(source).toLowerCase() !== '.pdf') throw new Error('Only PDF files can be exported to Downloads.')

  const outputName = requestedName?.trim() || basename(source)
  if (!outputName || basename(outputName) !== outputName || extname(outputName).toLowerCase() !== '.pdf') {
    throw new Error('The exported filename must be a plain .pdf filename.')
  }

  const destinationRoot = resolve(downloadsRoot)
  mkdirSync(destinationRoot, { recursive: true })
  const destination = join(destinationRoot, outputName)
  const temporaryDestination = join(destinationRoot, `.${outputName}.${randomUUID()}.tmp`)
  try {
    copyFileSync(source, temporaryDestination)
    renameSync(temporaryDestination, destination)
  } finally {
    rmSync(temporaryDestination, { force: true })
  }
  return destination
}
