# Architecture

Technical deep-dive into how JobTrack AI works under the hood. For a project overview see the [README](README.md). For setup instructions see the [Setup Guide](SETUP.md).

## Tech Stack

- **Frontend:** React (no router, no component library)
- **Build:** Vite + HMR
- **Storage:** Supabase (PostgreSQL)
- **AI:** Claude API (cloud) or Ollama (local, free) — switchable from the UI

## Setup

```bash
npm install
```

Create a `.env` file in the project root (only needed for Claude mode):

```
VITE_ANTHROPIC_API_KEY=your-api-key-here
```

### Ollama Setup (optional, for free local AI)

Install Ollama from [ollama.com](https://ollama.com), then pull the models you want:

```bash
ollama pull llama3.2        # fast, lightweight
ollama pull mistral         # great for writing tasks
ollama pull deepseek-r1:8b  # strong reasoning
```

> The app will auto-pull a model on first use if it's not installed, but pre-pulling avoids the wait.

```bash
npm run dev
```

## Architecture Overview

Everything lives in a single file — `src/App.jsx` — state, API calls, storage, and UI. There is no backend server. The AI is **not** a persistent agent — it's a **one-shot API call** per user action, routed to either Claude (cloud) or Ollama (local) based on the user's toggle.

## Data Model

Each job application is a plain object stored in `localStorage` under `"job_tracker_apps"`:

| Field     | Type   | Source                    |
|-----------|--------|---------------------------|
| `id`      | number | `Date.now()` at creation  |
| `company` | string | user input                |
| `role`    | string | user input                |
| `url`     | string | user input (optional)     |
| `status`  | string | one of 6 statuses         |
| `notes`   | string | user input (optional)     |
| `jd`      | string | job description (optional)|
| `date`    | string | ISO date at creation      |

The **base resume** is stored separately under `"job_tracker_resume"` as plain text.

**Statuses:** Wishlist → Applied → Phone Screen → Interview → Offer → Rejected

## Startup Flow

```
main.jsx → renders <App /> → useEffect on mount
  ├── loadApps()   → reads "job_tracker_apps" from localStorage
  └── loadResume() → reads "job_tracker_resume" from localStorage
```

## User Workflows

### Adding a Job

```
"+ Add Job" button → modal opens → fill form → "Add Application"
  → validates company + role are present
  → prepends new object to apps array
  → saves to React state + localStorage
  → modal closes, form resets
```

### Viewing Jobs

- **Board view** (default): 6 Kanban-style columns, one per status
- **List view**: flat filtered list; clicking a status filter chip auto-switches to list view
- Clicking any job card **selects** it and opens the **detail panel** on the right

### Updating Status

Click a status button in the detail panel → updates the job in state + localStorage.

### Setting Base Resume

"My Resume" button in header → modal with textarea → paste resume → "Save Resume" → persisted to localStorage.

## AI Provider Toggle

The app supports two AI backends, switchable via a **CLAUDE / OLLAMA** toggle in the header:

| Provider | Cost | Where it runs | Model |
|----------|------|---------------|-------|
| **Claude** | Paid (API key) | Anthropic cloud | `claude-sonnet-4-20250514` |
| **Ollama** | Free | Your machine (`localhost:11434`) | User's choice (see below) |

### Ollama Models

When Ollama is selected, a dropdown lets you pick:

| Model | ID | Best for |
|-------|----|----------|
| Llama 3.2 | `llama3.2` | Fast, lightweight general use |
| Mistral | `mistral` | Writing tasks (cover letters, emails) |
| DeepSeek R1 8B | `deepseek-r1:8b` | Strong reasoning (fit analysis, prep) |

### Provider state in localStorage

| Key | Value |
|-----|-------|
| `job_tracker_provider` | `"claude"` or `"ollama"` |
| `job_tracker_ollama_model` | e.g. `"llama3.2"` |

### Ollama health indicator

When Ollama mode is active, a colored dot appears next to the model dropdown:
- **Green** — Ollama is running
- **Red** — Ollama not detected
- **Amber** — Checking status

Status is checked on toggle and polled every 15 seconds.

## AI Workflow

There are **5 AI actions**, each triggered by a button in the detail panel of a selected job:

| Action          | ID       | Needs Resume? | Max Tokens (Claude) |
|-----------------|----------|---------------|---------------------|
| Tailored Resume | `resume` | Yes           | 2200                |
| Cover Letter    | `cover`  | Yes           | 1200                |
| Fit Analysis    | `fit`    | No            | 1200                |
| Interview Prep  | `prep`   | No            | 1200                |
| Follow-up Email | `email`  | No            | 1200                |

### `runAI(action)` — what happens when you click an AI button

```
User selects a job → clicks an AI action button
  │
  ├── Guard: if action needs resume and none is set → shows warning, returns
  │
  ├── Sets loading state (triggers shimmer animation)
  │
  ├── Builds context string by concatenating:
  │     • Role + Company
  │     • Job Description (from the job's jd field)
  │     • Base Resume (if set)
  │     • Notes (if any)
  │   separated by "---" dividers
  │
  ├── if provider == "claude"  → callClaude(systemPrompt, context, maxTokens)
  └── if provider == "ollama"  → callOllama(ollamaModel, systemPrompt, context)
```

### `callClaude()` — Anthropic cloud path

```
callClaude(systemPrompt, userPrompt, maxTokens)
  │
  ├── Reads API key from import.meta.env.VITE_ANTHROPIC_API_KEY
  │   (injected by Vite at build time from .env)
  │
  ├── If no key → returns error string (no network call)
  │
  └── POST https://api.anthropic.com/v1/messages
        Headers:
          x-api-key: <key>
          anthropic-version: 2023-06-01
          anthropic-dangerous-direct-browser-access: true
        Body:
          model: claude-sonnet-4-20250514
          max_tokens: 1200 or 2200
          system: <one of 5 specialized system prompts>
          messages: [{ role: "user", content: <context> }]

        Response: extracts data.content[0].text
```

The `anthropic-dangerous-direct-browser-access` header is required because the call is made directly from the browser with no backend proxy.

### `callOllama()` — local Ollama path

```
callOllama(model, systemPrompt, userPrompt)
  │
  ├── checkOllama()
  │     Pings http://localhost:11434 with 2s timeout
  │
  ├── If offline → startOllama()
  │     Hits /api/tags up to 6 times (1.5s apart)
  │     On macOS, Ollama.app's launch agent auto-starts the server
  │     If still offline → returns error with manual start instructions
  │
  ├── ensureOllamaModel(model)
  │     GET /api/tags → checks if model is already pulled
  │     If missing → POST /api/pull { name: model, stream: false }
  │     (blocks until download completes — first run may take minutes)
  │
  └── POST http://localhost:11434/api/chat
        Body:
          model: <selected model>
          stream: false
          messages: [
            { role: "system", content: <system prompt> },
            { role: "user",   content: <context> }
          ]

        Response: extracts data.message.content
```

### The 5 System Prompts

The same system prompts are used for both Claude and Ollama. Each gives the AI a distinct persona and strict output format:

1. **`resume`** — "elite resume strategist with ATS expertise." Never invents experience, reorders for relevance, uses JD keywords, quantifies impact, outputs plain text.
2. **`cover`** — "master cover letter writer." Strict 4-paragraph structure (Hook → Fit → Value-add → Close), ~260 words.
3. **`fit`** — "senior recruiter." Outputs Fit Score /10, Top 3 Strengths, Top 3 Gaps with actions. Brutally honest.
4. **`prep`** — "expert interview coach." 5 questions with STAR-framework answer guides.
5. **`email`** — "career coach." 3–4 sentence follow-up email.

### After the API returns

- **Success** → response text rendered in the detail panel's output box. A "COPY" button copies it to clipboard.
- **Error** → shows "Error contacting AI. Please try again."

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│                      localStorage                        │
│  job_tracker_apps  job_tracker_resume                    │
│  job_tracker_provider  job_tracker_ollama_model          │
└──────────┬──────────────────────┬────────────────────────┘
           │ load on mount        │ load on mount
           ▼                      ▼
┌──────────────────────────────────────────────────────────┐
│               React State (JobTracker)                    │
│  apps[]  baseResume  selected  aiResult  form            │
│  aiProvider  ollamaModel  ollamaStatus                   │
└────┬──────────┬──────────────────┬───────────────────────┘
     │          │                  │
     │          │         User clicks AI action
     │          │                  │
     │          │                  ▼
     │          │        ┌─────────────────┐
     │          │        │    runAI()       │
     │          │        │  builds context  │
     │          │        │  from selected   │
     │          │        │  job + resume    │
     │          │        └────────┬────────┘
     │          │                 │
     │          │        ┌───────┴────────┐
     │          │        ▼                ▼
     │          │  ┌───────────┐   ┌──────────────┐
     │          │  │ callClaude│   │ callOllama   │
     │          │  │ POST      │   │ check/start  │
     │          │  │ /v1/msgs  │   │ ensure model │
     │          │  └─────┬─────┘   │ POST /api/   │
     │          │        │         │   chat       │
     │          │        │         └──────┬───────┘
     │          │        │    Anthropic   │ localhost
     │          │        │    API         │ :11434
     │          │        └───────┬────────┘
     │          │                ▼
     │          │         aiResult.text
     │          │         rendered in UI
     ▼          ▼
  Board/List   Resume Modal
    Views       (edit & save)
```

## What This App Is NOT

- **Not an agent loop** — the AI (Claude or Ollama) is called once per button click, returns text, done. No tool use, no memory, no multi-turn conversation.
- **Not a backend app** — everything runs in the browser. No server, no database, no auth. Ollama runs as a separate local process, not as part of this app.
- **Not using the Anthropic SDK** — it's raw `fetch()` calls to the REST APIs (Anthropic or Ollama).

It's a **CRUD app with AI-powered text generation** bolted onto the detail view of each job application.
