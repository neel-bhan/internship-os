# Internship OS

A minimal local desktop app for SWE internship applications, LaTeX resume editing, and exact submission archives.

## Run

```bash
npm install
npm run dev
```

The app uses the locally installed Codex CLI. Sign in once if needed:

```bash
codex login
```

Keyboard shortcuts: `⌘1` Resume, `⌘2` Tracker, `⌘K` Codex, `⌘S` save and compile, `⌘Enter` send to Codex, and `Esc` close Codex.

Tracker data, resume sources, compile history, and archives are stored under the app's local Electron data directory. The upload-ready PDF is written to:

```text
~/Downloads/Neel_Bhansali_Resume.pdf
```

## Checks

```bash
npm test
npm run build
```
