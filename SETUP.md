# Setup Guide

Get JobTrack AI running locally in **5–10 minutes**. No backend to deploy, no Docker, no CI — just clone, configure, and go.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+ installed
- A free [Supabase](https://supabase.com) account
- An [Anthropic API key](https://console.anthropic.com/) (for Claude mode)
- *(Optional)* [Ollama](https://ollama.com) installed (for free local AI mode)

---

## Step 1 — Clone & Install

```bash
git clone <your-repo-url>
cd tracker
npm install
```

---

## Step 2 — Set Up Supabase (free tier works)

### 2a. Create a project

1. Go to [supabase.com](https://supabase.com) → sign in → **New Project**
2. Name it anything (e.g. `tracker-app`), set a database password, pick a region
3. Wait ~2 minutes for it to provision

### 2b. Create the tables

Go to **SQL Editor** in the Supabase dashboard and run:

```sql
-- Job applications
create table applications (
  id          bigint primary key,
  company     text not null,
  role        text not null,
  url         text default '',
  status      text not null default 'Wishlist',
  notes       text default '',
  jd          text default '',
  date        text not null,
  created_at  timestamptz default now()
);

-- Base resume (single row)
create table resumes (
  id         serial primary key,
  content    text not null default '',
  updated_at timestamptz default now()
);

-- Seed an empty resume row
insert into resumes (content) values ('');
```

### 2c. Enable Row Level Security

Run this in the same SQL Editor:

```sql
alter table applications enable row level security;
alter table resumes enable row level security;

create policy "Allow all on applications" on applications
  for all using (true) with check (true);

create policy "Allow all on resumes" on resumes
  for all using (true) with check (true);
```

> This allows public access for a single-user setup. If you add auth later, replace `(true)` with `(auth.uid() = user_id)`.

### 2d. Grab your keys

Go to **Project Settings → API** and copy:

- **Project URL** — `https://xxxxxxxx.supabase.co`
- **anon public key** — starts with `eyJ...`

---

## Step 3 — Set Up Claude API Key

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Navigate to **API Keys** → **Create Key**
3. Copy the key (starts with `sk-ant-...`)

> You can skip this if you only plan to use Ollama (free local mode).

---

## Step 4 — Configure Environment

Create a `.env` file in the project root. You can copy the example to get started:

```bash
cp .env.example .env
```

Then fill in your values. Here's what a completed `.env` looks like:

```
# Supabase (required)
VITE_SUPABASE_URL=https://abcdefghijk.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoaWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MTE1MDAwMDAsImV4cCI6MjAyNzA3NjAwMH0.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Claude API (optional — skip if using Ollama only)
VITE_ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-xxxxxxxxxx
```

| Variable | Required? | Where to find it |
|----------|-----------|------------------|
| `VITE_SUPABASE_URL` | Yes | Supabase → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Yes | Same page → Project API keys → `anon` `public` |
| `VITE_ANTHROPIC_API_KEY` | Only for Claude mode | [console.anthropic.com](https://console.anthropic.com/) → API Keys |

---

## Step 5 — Run

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) — you're done.

---

## Optional — Ollama (Free Local AI)

If you'd rather not pay for Claude API calls, the app has a built-in Ollama toggle.

### Install Ollama

- **macOS:** Download from [ollama.com](https://ollama.com) or `brew install ollama`
- **Linux:** `curl -fsSL https://ollama.com/install.sh | sh`
- **Windows:** Download from [ollama.com](https://ollama.com)

### Pull models

```bash
ollama pull llama3.2        # fast, lightweight
ollama pull mistral         # great for writing tasks
ollama pull deepseek-r1:8b  # strong reasoning
```

### Use it

1. Make sure Ollama is running (`ollama serve` or open the app)
2. In JobTrack, click the **OLLAMA** toggle in the header
3. Pick a model from the dropdown — that's it

> The app will try to auto-start Ollama and auto-pull missing models, but pre-pulling avoids the wait.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Blank page / network errors | Make sure `.env` values are correct and you restarted `npm run dev` after editing `.env` |
| "API key not configured" | Add `VITE_ANTHROPIC_API_KEY` to `.env` (or switch to Ollama mode) |
| Supabase table errors | Make sure you ran both SQL blocks (tables + RLS policies) |
| Ollama status dot is red | Run `ollama serve` in a terminal, or open the Ollama app |
| Ollama model slow on first use | The model is being downloaded (~2–5 GB). Subsequent runs are instant |
| CORS errors with Ollama | Ollama allows `localhost` by default. If you changed the origin, set `OLLAMA_ORIGINS=*` |

---

## Project Structure

```
tracker/
├── .env                  ← your API keys (not committed)
├── src/
│   ├── main.jsx          ← entry point
│   ├── App.jsx           ← entire app (state, UI, AI calls)
│   └── supabase.js       ← Supabase client init
├── package.json
└── vite.config.js
```

That's it — no hidden configs, no backend servers, no build pipelines. Just a React app with AI superpowers.
