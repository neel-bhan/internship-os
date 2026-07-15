# Internship OS

Local-first macOS workspace for internship applications, LaTeX resume profiles, job-specific drafts, and optional Codex or Claude assistance.

## Run

```bash
npm install
npm run dev
```

Use `npm run dev:fresh` for a disposable first-run workspace. Normal `npm run dev` keeps your usual local data.

Onboarding collects a candidate name and optional links, creates the selected resume profiles, imports an optional `.tex` resume, checks LaTeX and assistant tools, and generates private `AGENTS.md` / `CLAUDE.md` instructions in the local app-data workspace.

## Verify and package

```bash
npm test
npm run build
npm run package:mac
```

The app stores personal data under macOS Application Support and exports the active PDF to Downloads. No personal resume content ships in the repository or packaged app.
