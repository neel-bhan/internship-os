import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { AssistantImageAttachment } from '../../shared/types'

export const MAX_CHAT_IMAGES = 4
export const MAX_CHAT_IMAGE_BYTES = 15 * 1024 * 1024

export interface StoredAssistantImage {
  id: string
  name: string
  mimeType: SupportedImageMime
  path: string
}

type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

const extensionByMime: Record<SupportedImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

export function persistAssistantImages(root: string, uploads: AssistantImageAttachment[]): StoredAssistantImage[] {
  if (!Array.isArray(uploads)) throw new Error('Image attachments are invalid.')
  if (uploads.length > MAX_CHAT_IMAGES) throw new Error(`Attach up to ${MAX_CHAT_IMAGES} images at a time.`)
  if (uploads.length === 0) return []

  const attachmentRoot = join(root, 'assistant-workspace', '.attachments')
  mkdirSync(attachmentRoot, { recursive: true })

  return uploads.map((upload) => {
    if (!upload || typeof upload.dataUrl !== 'string' || typeof upload.name !== 'string') {
      throw new Error('Image attachment is invalid.')
    }
    const parsed = parseImageDataUrl(upload.dataUrl)
    if (parsed.bytes.length > MAX_CHAT_IMAGE_BYTES) {
      throw new Error(`${displayName(upload.name)} is larger than 15 MB.`)
    }

    const detectedMime = detectImageMime(parsed.bytes)
    if (!detectedMime || detectedMime !== parsed.mimeType) {
      throw new Error(`${displayName(upload.name)} is not a supported PNG, JPEG, GIF, or WebP image.`)
    }

    const id = randomUUID()
    const name = displayName(upload.name)
    const stem = safeStem(name)
    const path = join(attachmentRoot, `${id}--${stem}.${extensionByMime[detectedMime]}`)
    writeFileSync(path, parsed.bytes, { mode: 0o600 })
    return { id: upload.id || id, name, mimeType: detectedMime, path }
  })
}

export function storedImagePreview(path: string): AssistantImageAttachment | null {
  try {
    if (!existsSync(path)) return null
    const bytes = readFileSync(path)
    if (bytes.length > MAX_CHAT_IMAGE_BYTES) return null
    const mimeType = detectImageMime(bytes)
    if (!mimeType) return null
    const file = basename(path)
    const separator = file.indexOf('--')
    const storedName = separator >= 0 ? file.slice(separator + 2) : file
    const name = storedName.replace(new RegExp(`${escapeRegExp(extname(storedName))}$`), '')
    return {
      id: separator >= 0 ? file.slice(0, separator) : path,
      name,
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`
    }
  } catch {
    return null
  }
}

function parseImageDataUrl(dataUrl: string): { mimeType: SupportedImageMime; bytes: Buffer } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/)
  if (!match) throw new Error('Only PNG, JPEG, GIF, and WebP images can be attached.')
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  if (bytes.length === 0) throw new Error('The selected image is empty.')
  return { mimeType: match[1] as SupportedImageMime, bytes }
}

function detectImageMime(bytes: Buffer): SupportedImageMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function displayName(value: string): string {
  return basename(value.trim()).slice(0, 120) || 'image'
}

function safeStem(value: string): string {
  const withoutExtension = value.slice(0, Math.max(0, value.length - extname(value).length))
  return withoutExtension
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'image'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
