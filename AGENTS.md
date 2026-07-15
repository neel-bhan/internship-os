# Internship OS contributor instructions

Internship OS is a local-first internship application manager. Keep changes focused on resumes, applications, onboarding, and local assistant integration.

## Development commands

```bash
npm run setup
npm run dev
npm run dev:fresh
npm test
npm run build
npm run ios -- application list
npm run ios -- resume state
```

`npm run setup` is the supported first-run path for repository testers. It installs dependencies, downloads the pinned repository-local TinyTeX pdfLaTeX toolchain into ignored `.tools/`, verifies its checksum, and compiles the generic starter resume. Do not require a global LaTeX installation or rewrite resume sources for another TeX engine.

Never edit the SQLite database or managed resume folders directly. Use the CLI command surface for runtime data operations.

## Product constraints

- Tracker fields remain Company, Position, Date Applied, Application Status, and Details.
- Valid statuses are exactly `Submitted`, `In Progress`, and `Rejected`.
- The app must not ship candidate names, contact details, resumes, profile choices, absolute paths, or assistant credentials.
- Runtime resume profiles come from user settings. Do not assume fixed profile IDs.
- Preserve existing local data through versioned, backed-up migrations.
- New installations must complete onboarding before entering the workspace.
- `npm run dev` uses the normal local profile. `npm run dev:fresh` must use isolated disposable data and downloads.

## Resume safety

- Never invent candidate facts.
- Keep promoted resumes readable and exactly one page.
- Never edit a canonical resume directly. Prepare a candidate and promote it through the CLI.
- Application submission must archive the exact active PDF and source.

## Assistant safety

- Generate both `AGENTS.md` and `CLAUDE.md` in the managed assistant workspace.
- Assistants must use the bundled Internship OS CLI, not source-repository commands.
- Review mode must not change runtime data.
- Auto mode remains scoped to the managed workspace and uses explicit approval handling.
- Never automatically approve arbitrary filesystem or shell access.
- Never collect or persist provider API keys in the renderer or application settings.

## Verification

- Run tests and the production build after changes.
- Use isolated Electron end-to-end tests for onboarding and migrations.
- Verify both normal and fresh launch modes.
