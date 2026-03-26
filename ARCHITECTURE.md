# Architecture

Technical deep-dive into how JobTrack AI works under the hood. For a project overview see the [README](README.md). For setup instructions see the [Setup Guide](SETUP.md).

## Tech Stack

- **Frontend:** React (no router, no component library)
- **Build:** Vite + HMR
- **Storage:** Supabase (PostgreSQL + Storage)
- **AI:** Claude API (cloud) or Ollama (local, free) — switchable from the UI
- **DOCX:** mammoth (text extraction) + pizzip/docxtemplater (format-preserving generation)

## Architecture Overview

Everything lives in a single file — `src/App.jsx` — state, API calls, storage, DOCX engine, and UI. There is no backend server. The AI is **not** a persistent agent — it's a **one-shot API call** per user action, routed to either Claude (cloud) or Ollama (local) based on the user's toggle. AI responses are cached per job in Supabase to avoid redundant calls.

For setup instructions, see the [Setup Guide](SETUP.md).

## Data Model

### `applications` table (Supabase)

| Field        | Type   | Source                    |
|--------------|--------|---------------------------|
| `id`         | bigint | `Date.now()` at creation  |
| `company`    | text   | user input                |
| `role`       | text   | user input                |
| `url`        | text   | user input (optional)     |
| `status`     | text   | one of 6 statuses         |
| `notes`      | text   | user input (optional)     |
| `jd`         | text   | job description (optional)|
| `date`       | text   | ISO date at creation      |
| `ai_results` | jsonb  | cached AI responses (see below) |
| `created_at` | timestamptz | auto                 |

### `resumes` table (Supabase — versioned)

Each save creates a **new row**, building a version history.

| Field        | Type        | Description                          |
|--------------|-------------|--------------------------------------|
| `id`         | serial      | auto-increment PK                    |
| `content`    | text        | extracted plain text (for AI context)|
| `docx_path`  | text        | Supabase Storage path to .docx file  |
| `created_at` | timestamptz | version timestamp                    |
| `updated_at` | timestamptz | last update time                     |

### `resumes` storage bucket (Supabase Storage)

DOCX files are stored with versioned filenames: `base_resume_<timestamp>.docx`. Each resume version points to its own file.

### `ai_results` JSONB structure

Cached per job, keyed by action id:

```json
{
  "resume": { "text": "formatted plain text", "json": { "summary": "...", "experience": [...], "skills": [...], "education": [...] } },
  "cover":  { "text": "Dear Hiring Team...", "json": null },
  "fit":    { "text": "Fit Score: 7/10...", "json": null },
  "prep":   { "text": "Question 1:...", "json": null },
  "email":  { "text": "Subject:...", "json": null }
}
```

The `json` field is only populated for the `resume` action (structured output for DOCX generation). Other actions store plain text only.

**Statuses:** Wishlist → Applied → Phone Screen → Interview → Offer → Rejected

## Startup Flow

```
main.jsx → renders <App /> → useEffect on mount
  ├── loadApps()        → fetches applications from Supabase, ordered by created_at desc
  └── loadAllResumes()  → fetches all resume versions from Supabase, ordered by created_at desc
        └── selects latest version as active (sets baseResume, docxPath)
```

## User Workflows

### Adding a Job

```
"+ Add Job" button → modal opens → fill form → "Add Application"
  → validates company + role are present
  → optimistic update: prepends to React state immediately
  → inserts row into Supabase applications table
  → modal closes, form resets
```

### Viewing Jobs

- **Board view** (default): 6 Kanban-style columns, one per status
- **List view**: flat filtered list; clicking a status filter chip auto-switches to list view
- Clicking any job card **selects** it and opens the **detail panel** on the right

### Updating Status

Click a status button in the detail panel → optimistic state update → Supabase update.

### Setting Base Resume

"My Resume" button in header → modal with two tabs:

**UPLOAD DOCX tab:**
```
User clicks upload area → selects .docx file
  → mammoth.extractRawText() extracts plain text
  → file uploaded to Supabase Storage (resumes bucket) with versioned filename
  → new row inserted into resumes table (content + docx_path)
  → version appears in version picker
```

**PASTE TEXT tab:**
```
User pastes resume text → clicks "Save Resume"
  → new row inserted into resumes table (content only, no docx_path)
  → version appears in version picker
```

### Resume Versioning

Every save (text or DOCX) creates a new row in the `resumes` table. The resume modal shows a version picker with timestamps when 2+ versions exist. Users can:
- Switch between versions (instantly loads that version's content and DOCX template)
- Delete any version (removes the DB row + DOCX file from Storage)

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
| Tailored Resume | `resume` | Yes           | 3000                |
| Cover Letter    | `cover`  | Yes           | 1200                |
| Fit Analysis    | `fit`    | No            | 1200                |
| Interview Prep  | `prep`   | No            | 1200                |
| Follow-up Email | `email`  | No            | 1200                |

### `runAI(action, forceRegenerate)` — what happens when you click an AI button

```
User selects a job → clicks an AI action button
  │
  ├── Guard: if action needs resume and none is set → shows warning, returns
  │
  ├── Check cache: selected.ai_results[action]
  │     If cached AND not forceRegenerate → load from cache instantly, return
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
        │
        ├── if action == "resume" → parseResumeJson(text)
        │     Extracts JSON from response (handles markdown fences, preamble)
        │     Formats as plain text for display via formatResumeJsonAsText()
        │
        └── Persist result to Supabase: updateApp(id, { ai_results: { ...existing, [action]: { text, json } } })
```

The **REGENERATE** button calls `runAI(action, true)` to bypass the cache and make a fresh API call, overwriting the stored result.

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

The same system prompts are used for both Claude and Ollama. All prompts include **ATS rules** (no tables, keyword mirroring, standard headings) and **human-tone rules** (banned AI phrases like "leverage", "utilize", "synergy"; varied sentence structure).

1. **`resume`** — "elite resume strategist with ATS and human-readability expertise." Outputs **structured JSON** (`{ summary, experience, skills, education }`). Never invents experience, mirrors JD keywords, quantifies impact.
2. **`cover`** — "master cover letter writer." Strict 4-paragraph structure (Hook → Fit → Value-add → Close), ~260 words. Must mirror 3–5 JD phrases naturally.
3. **`fit`** — "senior recruiter who has screened 10,000+ resumes." Fit Score /10, Top 3 Strengths, Top 3 Gaps with actions, ATS Risk Flags. Brutally honest.
4. **`prep`** — "expert interview coach who has conducted 5,000+ interviews." 5 questions (behavioral + technical + culture-fit) with STAR answer guides and common mistakes.
5. **`email`** — "career coach." 3–4 sentence follow-up. Bans generic openers like "I hope this finds you well."

### After the API returns

- **Success** → response text rendered in the detail panel's output box
  - **COPY** button copies text to clipboard
  - **REGENERATE** button forces a fresh AI call (bypasses cache)
  - **DOWNLOAD DOCX** button (resume action only, when DOCX template exists) generates a tailored .docx file
- **Result is cached** in `applications.ai_results` — subsequent clicks load instantly
- **Error** → shows "Error contacting AI. Please try again."

### DOCX Generation Flow

When the user clicks **DOWNLOAD DOCX** after running a resume action:

```
handleDownloadDocx()
  │
  ├── downloadDocxTemplate(docxPath)
  │     Downloads the original .docx from Supabase Storage
  │
  ├── generateTailoredDocx(templateBuffer, resumeJson)
  │     1. Opens .docx as ZIP via PizZip
  │     2. Parses word/document.xml
  │     3. Identifies sections by heading styles or bold paragraphs
  │     4. Maps AI JSON sections to document sections:
  │        SUMMARY → summary, EXPERIENCE → experience[], SKILLS → skills[], EDUCATION → education[]
  │     5. Replaces content paragraph-by-paragraph, preserving:
  │        - Run properties (fonts, sizes, colors, bold/italic)
  │        - Paragraph properties (spacing, indentation, alignment)
  │        - Document properties (margins, page size, headers/footers)
  │     6. Serializes modified XML back into the ZIP
  │     7. Returns as Blob
  │
  └── saveAs(blob, "Resume_Company_Role.docx")
        Triggers browser download via file-saver
```

## Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                         Supabase                              │
│  applications table    resumes table    resumes storage bucket│
│  (jobs + ai_results)   (versioned)      (.docx files)        │
└──────┬──────────────────────┬──────────────────┬─────────────┘
       │ load on mount        │ load on mount    │ download
       ▼                      ▼                  │ on demand
┌──────────────────────────────────────────────────────────────┐
│                  React State (JobTracker)                      │
│  apps[]  baseResume  resumeVersions[]  activeResumeId        │
│  selected  aiResult { text, json }  docxPath                 │
│  aiProvider  ollamaModel  ollamaStatus                       │
└────┬──────────┬──────────────────┬───────────────────────────┘
     │          │                  │
     │          │         User clicks AI action
     │          │                  │
     │          │                  ▼
     │          │        ┌──────────────────┐
     │          │        │    runAI()        │
     │          │        │  check cache     │──→ cached? → instant load
     │          │        │  build context    │
     │          │        └────────┬─────────┘
     │          │                 │ (cache miss or regenerate)
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
     │          │                │
     │          │                ├── save to ai_results (Supabase)
     │          │                ▼
     │          │         aiResult.text + json
     │          │         rendered in UI
     │          │                │
     │          │                ├── [COPY] → clipboard
     │          │                ├── [REGENERATE] → runAI(action, true)
     │          │                └── [DOWNLOAD DOCX] (resume only)
     │          │                       │
     │          │                       ├── download base .docx ◄─┐
     │          │                       ├── generateTailoredDocx() │ Supabase
     │          │                       └── saveAs() → browser    │ Storage
     ▼          ▼
  Board/List   Resume Modal
    Views       (upload docx / paste text / version picker)
```

### localStorage (still used for)

| Key | Value |
|-----|-------|
| `job_tracker_provider` | `"claude"` or `"ollama"` |
| `job_tracker_ollama_model` | e.g. `"llama3.2"` |

Only AI provider preferences are in localStorage. All application data is in Supabase.

## What This App Is NOT

- **Not an agent loop** — the AI (Claude or Ollama) is called once per button click, returns text, done. No tool use, no multi-turn conversation. Results are cached in Supabase for reuse.
- **Not a backend app** — everything runs in the browser. Supabase handles persistence, Ollama runs as a separate local process.
- **Not using the Anthropic SDK** — it's raw `fetch()` calls to the REST APIs (Anthropic or Ollama).
- **Not using a DOCX templating language** — the DOCX engine does direct XML manipulation on the original file, no `{placeholder}` tags needed.

It's a **CRUD app with AI-powered text generation and DOCX processing** bolted onto the detail view of each job application.
