# Internship OS

Local-first macOS workspace for internship applications, LaTeX resume profiles, job-specific drafts, and optional Codex or Claude assistance.

## Run

```bash
git clone https://github.com/neel-bhan/internship-os.git
cd internship-os
npm run setup
npm run dev:fresh
```

The setup command installs npm dependencies, downloads a verified repository-local TinyTeX pdfLaTeX toolchain for Apple Silicon or Intel macOS, and verifies resume compilation. Resumes compile with their native engine and are never rewritten for compatibility. It requires Node.js 20 or newer. Use `npm run dev:fresh` for a disposable first-run workspace; normal `npm run dev` keeps your usual local data.

Onboarding collects a candidate name and optional links, creates the selected resume profiles, imports an optional `.tex` resume, checks LaTeX and assistant tools, and generates private `AGENTS.md` / `CLAUDE.md` instructions in the local app-data workspace.

After onboarding, the Settings button can update identity, PDF filename, assistant behavior, Codex model and reasoning speed, and resume formats. Codex defaults to the faster `gpt-5.6-luna` model with low reasoning for everyday prompts. Removing a format is non-destructive; re-adding the same format restores its existing local files.

## Verify and package

```bash
npm test
npm run build
npm run package:mac
```

The app stores personal data under macOS Application Support and exports the active PDF to Downloads. No personal resume content ships in the repository or packaged app.
