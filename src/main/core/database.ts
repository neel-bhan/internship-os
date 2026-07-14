import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { ApplicationInput, ApplicationStatus, InternshipApplication, Submission } from '../../shared/types'

interface ApplicationRow {
  id: string
  company: string
  position: string
  date_applied: string | null
  status: ApplicationStatus
  details: string
  created_at: string
  updated_at: string
}

interface SubmissionRow {
  id: string
  application_id: string
  archive_path: string
  created_at: string
}

export class ApplicationStore {
  private readonly db: Database.Database

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new Database(databasePath)
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = DELETE')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        company TEXT NOT NULL,
        position TEXT NOT NULL,
        date_applied TEXT,
        status TEXT NOT NULL CHECK (status IN ('Submitted', 'In Progress', 'Rejected')),
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        archive_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  get(id: string): InternshipApplication | null {
    const row = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as ApplicationRow | undefined
    return row ? this.mapApplication(row) : null
  }

  list(): InternshipApplication[] {
    const rows = this.db.prepare('SELECT * FROM applications ORDER BY updated_at DESC').all() as ApplicationRow[]
    return rows.map((row) => this.mapApplication(row))
  }

  save(input: ApplicationInput, submission?: { id: string; archivePath: string; createdAt: string }): InternshipApplication {
    const now = new Date().toISOString()
    const id = input.id ?? randomUUID()
    const existing = this.db.prepare('SELECT created_at FROM applications WHERE id = ?').get(id) as { created_at: string } | undefined
    const createdAt = existing?.created_at ?? now

    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO applications (id, company, position, date_applied, status, details, created_at, updated_at)
        VALUES (@id, @company, @position, @dateApplied, @status, @details, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          company = excluded.company,
          position = excluded.position,
          date_applied = excluded.date_applied,
          status = excluded.status,
          details = excluded.details,
          updated_at = excluded.updated_at
      `).run({
        id,
        company: input.company.trim(),
        position: input.position.trim(),
        dateApplied: input.dateApplied || null,
        status: input.status,
        details: input.details.trim(),
        createdAt,
        updatedAt: now
      })

      if (submission) {
        this.db.prepare(`
          INSERT INTO submissions (id, application_id, archive_path, created_at)
          VALUES (?, ?, ?, ?)
        `).run(submission.id, id, submission.archivePath, submission.createdAt)
      }
    })

    transaction()
    return this.get(id)!
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM applications WHERE id = ?').run(id)
  }

  private mapApplication(row: ApplicationRow): InternshipApplication {
    const submissions = this.db
      .prepare('SELECT * FROM submissions WHERE application_id = ? ORDER BY created_at DESC')
      .all(row.id) as SubmissionRow[]

    return {
      id: row.id,
      company: row.company,
      position: row.position,
      dateApplied: row.date_applied,
      status: row.status,
      details: row.details,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      submissions: submissions.map<Submission>((submission) => ({
        id: submission.id,
        applicationId: submission.application_id,
        archivePath: submission.archive_path,
        createdAt: submission.created_at
      }))
    }
  }
}
