# JobTrack AI

A job application tracker with built-in AI that writes your resumes, cover letters, and interview prep — tailored to every role you apply for.

Stop juggling spreadsheets and ChatGPT tabs. Add a job, paste the description, and let AI do the rest.

---

## What It Does

You track your job applications on a Kanban board. For each job, the AI can:

- **Tailor your resume** — rewrites your base resume to match the job description, ATS-optimized, and exports as a DOCX preserving your original formatting
- **Write a cover letter** — generates a compelling, personalized cover letter in a proven 4-paragraph structure
- **Analyze your fit** — scores your match out of 10, surfaces your top strengths, and flags gaps with actionable fixes
- **Prep you for interviews** — generates 5 likely questions with STAR-framework answer guides
- **Draft a follow-up email** — writes a polished follow-up to send after applying

All from one place. No copy-pasting between tools.

---

## How It Works

1. **Upload your base resume** (.docx or plain text) — the AI never modifies your original
2. **Add job applications** with the company, role, and job description
3. **Click any AI action** on a job card — get tailored output in seconds
4. **Copy the result** or **download as DOCX** with your original formatting preserved

Your data is stored in Supabase (free tier), so it persists across sessions and devices. AI responses are cached per job — click again and it loads instantly without burning another API call.

---

## Choose Your AI

Switch between two AI backends with a toggle in the header:

| | Claude (Cloud) | Ollama (Local) |
|---|---|---|
| **Cost** | Pay-per-use (API key) | Completely free |
| **Speed** | Fast | Depends on your hardware |
| **Privacy** | Data sent to Anthropic | Everything stays on your machine |
| **Models** | Claude Sonnet 4 | Llama 3.2, Mistral, DeepSeek R1 |
| **Setup** | Just an API key | Install Ollama + pull a model |

No vendor lock-in. Use Claude when you want the best output, Ollama when you want it free and private.

---

## Quick Start

**This takes 5–10 minutes.** No backend to deploy, no Docker, no CI.

```bash
git clone <your-repo-url>
cd tracker
npm install
```

Create a `.env` file:

```
VITE_SUPABASE_URL=https://your-ref.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...your-key
VITE_ANTHROPIC_API_KEY=sk-ant-...your-key   # optional if using Ollama
```

```bash
npm run dev
```

> **Need the full walkthrough?** See the [Setup Guide](SETUP.md) — covers Supabase table creation, API keys, Ollama install, and troubleshooting.

---

## Screenshots

*Coming soon*

---

## Features at a Glance

- **Kanban board** — drag-free, click-to-move status management (Wishlist → Applied → Phone Screen → Interview → Offer → Rejected)
- **List view** — filterable flat list for quick scanning
- **AI-powered actions** — 5 one-click AI tools per job application
- **DOCX resume upload** — upload your .docx, get tailored resumes back in the same format (fonts, margins, bullet styles preserved)
- **Resume versioning** — every save creates a timestamped version, switch between them anytime, delete old ones
- **AI response caching** — results stored per job in Supabase, instant reload on subsequent clicks, regenerate when needed
- **ATS-optimized output** — prompts engineered for keyword mirroring, standard headings, and human-like tone
- **Copy to clipboard** — one click to copy any AI output
- **Download DOCX** — one click to download a tailored resume as a .docx file
- **Provider toggle** — switch between Claude and Ollama mid-session
- **Auto model pull** — Ollama models download automatically on first use
- **Persistent storage** — Supabase-backed (PostgreSQL + Storage), works across devices
- **Dark theme** — easy on the eyes during late-night application sessions
- **Zero dependencies on external UI libraries** — pure React, fast and lightweight

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Vite |
| Database | Supabase (PostgreSQL + Storage) |
| AI (cloud) | Claude Sonnet 4 via Anthropic API |
| AI (local) | Ollama (Llama 3.2 / Mistral / DeepSeek R1) |
| DOCX engine | mammoth (extract) + pizzip/docxtemplater (generate) |
| Styling | Inline styles, zero CSS frameworks |
| Auth | None (single-user, RLS open) |

---

## Documentation

| Doc | What's in it |
|-----|-------------|
| [Setup Guide](SETUP.md) | Step-by-step install, Supabase config, API keys, Ollama setup, troubleshooting |
| [Architecture](ARCHITECTURE.md) | Data model, AI workflow internals, system prompts, data flow diagrams |

---

## Roadmap

- [ ] Authentication (Supabase Auth)
- [ ] Multi-device sync
- [ ] Drag-and-drop Kanban
- [x] ~~PDF resume export~~ DOCX export (shipped)
- [ ] PDF export from DOCX
- [ ] Browser extension to auto-import job listings
- [ ] Salary tracking and negotiation prep

---

## Contributing

PRs welcome. The entire app lives in `src/App.jsx` — read the [Architecture doc](ARCHITECTURE.md) to understand how it's structured before diving in.

---

## License

MIT
