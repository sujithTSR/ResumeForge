import { useState, useEffect } from "react";
import { supabase } from "./supabase";

// ── Storage helpers (Supabase) ──────────────────────────────────
async function loadApps() {
  const { data, error } = await supabase
    .from("applications")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) { console.error("loadApps:", error); return []; }
  return data || [];
}
async function insertApp(app) {
  const { error } = await supabase.from("applications").insert(app);
  if (error) console.error("insertApp:", error);
}
async function updateApp(id, fields) {
  const { error } = await supabase.from("applications").update(fields).eq("id", id);
  if (error) console.error("updateApp:", error);
}
async function deleteAppById(id) {
  const { error } = await supabase.from("applications").delete().eq("id", id);
  if (error) console.error("deleteAppById:", error);
}
async function loadResume() {
  const { data, error } = await supabase
    .from("resumes")
    .select("content")
    .limit(1)
    .single();
  if (error) { console.error("loadResume:", error); return ""; }
  return data?.content || "";
}
async function saveResume(text) {
  const { error } = await supabase
    .from("resumes")
    .update({ content: text, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) console.error("saveResume:", error);
}

// ── AI Provider helpers ──────────────────────────────────────────
const OLLAMA_URL = "http://localhost:11434";
const OLLAMA_MODELS = [
  { id: "llama3.2",       label: "Llama 3.2",       hint: "Fast & lightweight" },
  { id: "mistral",        label: "Mistral",          hint: "Great for writing" },
  { id: "deepseek-r1:8b", label: "DeepSeek R1 8B",  hint: "Strong reasoning" },
];

async function checkOllama() {
  try {
    const res = await fetch(OLLAMA_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

async function startOllama() {
  // Attempt to launch Ollama via a sidecar fetch to its API — if the binary
  // is installed but the server isn't running, hitting /api/tags often
  // auto-starts it on macOS (Ollama.app registers as a launch agent).
  // We poll a few times to give it a moment to come up.
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

async function ensureOllamaModel(model) {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
  const data = await res.json();
  const installed = (data.models || []).map(m => m.name.split(":")[0]);
  const base = model.split(":")[0];
  if (installed.includes(base) || installed.includes(model)) return true;
  // Model not found — pull it (this streams, so we just wait for completion)
  const pull = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: model, stream: false }),
  });
  return pull.ok;
}

async function callClaude(systemPrompt, userPrompt, maxTokens = 1500) {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!apiKey) return "API key not configured. Set VITE_ANTHROPIC_API_KEY in .env";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text || "No response.";
}

async function callOllama(model, systemPrompt, userPrompt) {
  const up = await checkOllama();
  if (!up) {
    const started = await startOllama();
    if (!started) return "Ollama is not running. Please start it:\n\n  • macOS: open the Ollama app, or run `ollama serve`\n  • Linux: run `ollama serve`\n\nThen try again.";
  }
  try {
    await ensureOllamaModel(model);
  } catch {
    return `Could not pull model "${model}". Make sure Ollama is running and try again.`;
  }
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  const data = await res.json();
  return data.message?.content || "No response from Ollama.";
}

// ── Constants ────────────────────────────────────────────────────
const STATUSES = ["Wishlist", "Applied", "Phone Screen", "Interview", "Offer", "Rejected"];

const STATUS_STYLE = {
  Wishlist:       { bg: "#1e2a1e", border: "#3a5c3a", text: "#7ec87e" },
  Applied:        { bg: "#1a2233", border: "#2e4a7a", text: "#7aafff" },
  "Phone Screen": { bg: "#26201a", border: "#6b4f20", text: "#f0b060" },
  Interview:      { bg: "#1e1a2e", border: "#5a3a8a", text: "#c09af0" },
  Offer:          { bg: "#1a2622", border: "#2a6b50", text: "#5de8b8" },
  Rejected:       { bg: "#2a1a1a", border: "#6b2a2a", text: "#f07070" },
};

const AI_ACTIONS = [
  { id: "resume", label: "📄 Tailored Resume",  hint: "Rewrite resume to match this role",     color: "#5de8b8", needsResume: true  },
  { id: "cover",  label: "✍️ Cover Letter",      hint: "Generate a personalised cover letter",  color: "#c09af0", needsResume: true  },
  { id: "fit",    label: "🎯 Fit Analysis",       hint: "Score your match & surface gaps",       color: "#f0b060", needsResume: false },
  { id: "prep",   label: "🧠 Interview Prep",     hint: "5 likely questions with tips",          color: "#7aafff", needsResume: false },
  { id: "email",  label: "📧 Follow-up Email",    hint: "Draft a polished follow-up",            color: "#e8c56a", needsResume: false },
];

const SYSTEM_PROMPTS = {
  resume: `You are an elite resume strategist with deep ATS expertise. Given a candidate's base resume and a job description, produce a fully rewritten, tailored resume.

Rules:
- NEVER invent experience, roles, or qualifications not present in the base resume
- Reorder sections and bullet points so the most relevant experience appears first
- Reframe existing bullets using the JD's exact keywords and action language
- Strengthen every bullet with strong verbs and quantified impact (estimate ranges if exact numbers aren't given)
- Add a concise "Professional Summary" (2–3 sentences) at the top, targeted to this specific role and company
- Structure clearly: Summary → Experience → Skills → Education
- Output clean plain-text — no markdown symbols, just headings and bullets with dashes`,

  cover: `You are a master cover letter writer. Produce a compelling, tailored cover letter (~260 words, 4 paragraphs).

Structure:
1. Hook (1 sentence): Open with genuine enthusiasm + a specific reason you want THIS company and role
2. Fit (2–3 sentences): Connect 2–3 concrete achievements from the resume directly to the JD's top needs
3. Value-add (2 sentences): Articulate what you uniquely bring that other candidates likely won't
4. Close (1–2 sentences): Confident, warm call-to-action with availability

Tone: professional, warm, specific — never generic or sycophantic. Address the hiring manager as "Hiring Team" if no name is given.`,

  fit:   "You are a senior recruiter. Analyse the resume against the job description. Output: (1) Fit Score /10 with one-line rationale. (2) ✅ Top 3 Strengths with specific evidence from the resume. (3) ⚠️ Top 3 Gaps with a concrete action to close each. Be direct and brutally honest.",
  prep:  "You are an expert interview coach. Generate 5 likely interview questions for this exact role. For each: state the question, identify what the interviewer is really probing, and give a 3-bullet STAR-framework answer guide.",
  email: "You are a career coach. Write a brief (3–4 sentence), professional follow-up email to send 5 business days after applying. Re-express genuine interest, name something specific about the company, and end with a clear next-step ask.",
};

// ── Main App ─────────────────────────────────────────────────────
export default function JobTracker() {
  const [apps, setApps]                       = useState([]);
  const [baseResume, setBaseResume]           = useState("");
  const [resumeDraft, setResumeDraft]         = useState("");
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [view, setView]                       = useState("board");
  const [showForm, setShowForm]               = useState(false);
  const [selected, setSelected]               = useState(null);
  const [aiResult, setAiResult]               = useState({ action: null, text: "", loading: false });
  const [copied, setCopied]                   = useState(false);
  const [filterStatus, setFilterStatus]       = useState("All");
  const [form, setForm]                       = useState({ company: "", role: "", url: "", status: "Wishlist", notes: "", jd: "" });
  const [aiProvider, setAiProvider]           = useState(() => localStorage.getItem("job_tracker_provider") || "claude");
  const [ollamaModel, setOllamaModel]         = useState(() => localStorage.getItem("job_tracker_ollama_model") || "llama3.2");
  const [ollamaStatus, setOllamaStatus]       = useState("unknown"); // "unknown" | "checking" | "online" | "offline"

  useEffect(() => {
    loadApps().then(setApps);
    loadResume().then(r => { setBaseResume(r); setResumeDraft(r); });
  }, []);

  // Persist provider selection
  useEffect(() => { localStorage.setItem("job_tracker_provider", aiProvider); }, [aiProvider]);
  useEffect(() => { localStorage.setItem("job_tracker_ollama_model", ollamaModel); }, [ollamaModel]);

  // Check Ollama status when provider switches to ollama, and periodically
  useEffect(() => {
    if (aiProvider !== "ollama") { setOllamaStatus("unknown"); return; }
    let cancelled = false;
    const check = async () => {
      setOllamaStatus("checking");
      const up = await checkOllama();
      if (!cancelled) setOllamaStatus(up ? "online" : "offline");
    };
    check();
    const interval = setInterval(check, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [aiProvider]);

  const persistResume = r => { setBaseResume(r); saveResume(r); };

  const retryOllama = async () => {
    setOllamaStatus("checking");
    const started = await startOllama();
    setOllamaStatus(started ? "online" : "offline");
  };

  const addApp = async () => {
    if (!form.company || !form.role) return;
    const newApp = { ...form, id: Date.now(), date: new Date().toISOString().slice(0, 10) };
    setApps(prev => [newApp, ...prev]);
    setForm({ company: "", role: "", url: "", status: "Wishlist", notes: "", jd: "" });
    setShowForm(false);
    await insertApp(newApp);
  };

  const updateStatus = async (id, status) => {
    setApps(prev => prev.map(a => a.id === id ? { ...a, status } : a));
    if (selected?.id === id) setSelected({ ...selected, status });
    await updateApp(id, { status });
  };

  const deleteApp = async (id) => {
    setApps(prev => prev.filter(a => a.id !== id));
    if (selected?.id === id) setSelected(null);
    await deleteAppById(id);
  };

  const runAI = async action => {
    if (!selected) return;
    const actionDef = AI_ACTIONS.find(a => a.id === action);
    if (actionDef?.needsResume && !baseResume.trim()) {
      setAiResult({ action, text: '⚠️  Please set your base resume first — click "My Resume" in the header.', loading: false });
      return;
    }
    setAiResult({ action, text: "", loading: true });
    setCopied(false);
    const context = [
      `Role: ${selected.role} at ${selected.company}`,
      `Job Description:\n${selected.jd || "Not provided"}`,
      baseResume ? `Candidate Resume:\n${baseResume}` : "",
      selected.notes ? `Notes: ${selected.notes}` : "",
    ].filter(Boolean).join("\n\n---\n\n");
    const maxTok = action === "resume" ? 2200 : 1200;
    try {
      const text = aiProvider === "ollama"
        ? await callOllama(ollamaModel, SYSTEM_PROMPTS[action], context)
        : await callClaude(SYSTEM_PROMPTS[action], context, maxTok);
      setAiResult({ action, text, loading: false });
    } catch {
      setAiResult({ action, text: "Error contacting AI. Please try again.", loading: false });
    }
  };

  const copyResult = () => {
    navigator.clipboard.writeText(aiResult.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const filtered      = filterStatus === "All" ? apps : apps.filter(a => a.status === filterStatus);
  const boardCols     = STATUSES.map(s => ({ status: s, items: apps.filter(a => a.status === s) }));
  const resumeSet     = baseResume.trim().length > 0;
  const activeAction  = AI_ACTIONS.find(a => a.id === aiResult.action);
  const wordCount     = resumeDraft.trim() ? resumeDraft.trim().split(/\s+/).length : 0;
  const stats = {
    total:  apps.length,
    active: apps.filter(a => !["Rejected", "Wishlist"].includes(a.status)).length,
    offers: apps.filter(a => a.status === "Offer").length,
  };

  return (
    <div style={{ fontFamily: "'DM Mono', monospace", background: "#0d0f14", minHeight: "100vh", color: "#c8cdd8" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Instrument+Serif:ital@0;1&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #0d0f14; }
        ::-webkit-scrollbar-thumb { background: #2a2f3d; border-radius: 2px; }
        input, textarea, select { font-family: inherit; }
        .btn { cursor: pointer; border: none; outline: none; transition: all 0.15s; }
        .btn:hover { opacity: 0.85; }
        .card { background: #12151c; border: 1px solid #1e2330; border-radius: 8px; }
        .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
        .inp { background: #0d0f14; border: 1px solid #1e2330; border-radius: 6px; color: #c8cdd8; padding: 8px 12px; width: 100%; font-size: 13px; }
        .inp:focus { outline: none; border-color: #e8c56a; }
        .inp::placeholder { color: #2a2f3d; }
        .board-col { min-width: 210px; max-width: 210px; }
        .job-card { cursor: pointer; transition: all 0.15s; }
        .job-card:hover { border-color: #2a2f3d !important; transform: translateY(-1px); }
        .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.78); z-index: 50; display: flex; align-items: center; justify-content: center; padding: 16px; }
        .modal { background: #12151c; border: 1px solid #1e2330; border-radius: 12px; padding: 26px; width: 640px; max-width: 100%; max-height: 92vh; overflow-y: auto; }
        .ai-btn { background: #0f1118; border: 1px solid #1a1e2a; border-radius: 6px; color: #5a6080; padding: 9px 11px; font-size: 11px; cursor: pointer; transition: all 0.15s; text-align: left; position: relative; font-family: inherit; }
        .ai-btn:hover { border-color: #2a2f3d; color: #a0a8be; background: #12151c; }
        .ai-result { background: #080a0f; border: 1px solid #1a1e2a; border-radius: 8px; padding: 16px; font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-y: auto; color: #a8b0c0; }
        .shimmer { background: linear-gradient(90deg, #141720 25%, #1e2235 50%, #141720 75%); background-size: 200%; animation: shimmer 1.4s infinite; border-radius: 3px; }
        @keyframes shimmer { 0%{background-position:200%} 100%{background-position:-200%} }
        .copy-btn { background: #141720; border: 1px solid #1e2330; border-radius: 4px; color: #5a6080; padding: 3px 10px; font-size: 10px; cursor: pointer; font-family: inherit; transition: all 0.15s; letter-spacing: 0.5px; }
        .copy-btn:hover { border-color: #e8c56a88; color: #e8c56a; }
        .lbl { font-size: 9px; letter-spacing: 2px; color: #2a2f3d; margin-bottom: 7px; display: block; }
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ borderBottom: "1px solid #1a1e2a", padding: "13px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: 21, color: "#e8c56a", fontStyle: "italic" }}>JobTrack</span>
          <span style={{ fontSize: 9, color: "#2a2f3d", letterSpacing: 2.5 }}>AI WORKFLOW</span>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* Stats */}
          {[["TOTAL", stats.total, "#c8cdd8"], ["ACTIVE", stats.active, "#7aafff"], ["OFFERS", stats.offers, "#5de8b8"]].map(([l, v, c]) => (
            <div key={l} style={{ textAlign: "center", minWidth: 36 }}>
              <div style={{ fontSize: 16, fontWeight: 500, color: c, lineHeight: 1 }}>{v}</div>
              <div style={{ fontSize: 8, color: "#2a2f3d", letterSpacing: 1.5, marginTop: 2 }}>{l}</div>
            </div>
          ))}

          <div style={{ width: 1, height: 28, background: "#1a1e2a", margin: "0 4px" }} />

          {/* AI Provider toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ display: "flex", background: "#0f1118", border: "1px solid #1a1e2a", borderRadius: 6, overflow: "hidden" }}>
              {["claude", "ollama"].map(p => (
                <button key={p} className="btn" onClick={() => setAiProvider(p)}
                  style={{ padding: "5px 10px", fontSize: 9, letterSpacing: 1,
                    background: aiProvider === p ? "#1a1e2a" : "transparent",
                    color: aiProvider === p ? (p === "claude" ? "#c09af0" : "#5de8b8") : "#2a2f3d" }}>
                  {p === "claude" ? "CLAUDE" : "OLLAMA"}
                </button>
              ))}
            </div>
            {aiProvider === "ollama" && (
              <>
                <select className="inp" value={ollamaModel} onChange={e => setOllamaModel(e.target.value)}
                  style={{ width: "auto", padding: "4px 8px", fontSize: 10, background: "#0f1118", border: "1px solid #1a1e2a", borderRadius: 6 }}>
                  {OLLAMA_MODELS.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <span title={ollamaStatus === "online" ? "Ollama running" : ollamaStatus === "offline" ? "Ollama not detected" : "Checking…"}
                  style={{ width: 7, height: 7, borderRadius: "50%", display: "inline-block",
                    background: ollamaStatus === "online" ? "#5de8b8" : ollamaStatus === "offline" ? "#f07070" : "#f0b060",
                    boxShadow: `0 0 6px ${ollamaStatus === "online" ? "#5de8b8" : ollamaStatus === "offline" ? "#f07070" : "#f0b060"}` }} />
              </>
            )}
          </div>

          <div style={{ width: 1, height: 28, background: "#1a1e2a", margin: "0 4px" }} />

          {/* My Resume button */}
          <button className="btn" onClick={() => { setResumeDraft(baseResume); setShowResumeModal(true); }}
            style={{ display: "flex", alignItems: "center", gap: 6, background: resumeSet ? "#111a11" : "#18120a",
              border: `1px solid ${resumeSet ? "#2a4a2a" : "#3a2a10"}`, borderRadius: 6,
              padding: "5px 11px", fontSize: 10, color: resumeSet ? "#6ec86e" : "#d0a050", letterSpacing: 0.5 }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: resumeSet ? "#6ec86e" : "#d0a050", display: "inline-block" }} />
            {resumeSet ? "Resume ✓" : "Set Resume ↑"}
          </button>

          {/* View toggle */}
          <div style={{ display: "flex", background: "#0f1118", border: "1px solid #1a1e2a", borderRadius: 6, overflow: "hidden" }}>
            {["board", "list"].map(v => (
              <button key={v} className="btn" onClick={() => setView(v)}
                style={{ padding: "5px 11px", fontSize: 9, letterSpacing: 1.5,
                  background: view === v ? "#1a1e2a" : "transparent",
                  color: view === v ? "#e8c56a" : "#2a2f3d" }}>
                {v.toUpperCase()}
              </button>
            ))}
          </div>

          <button className="btn" onClick={() => setShowForm(true)}
            style={{ background: "#e8c56a", color: "#0a0b0f", borderRadius: 6, padding: "6px 15px", fontSize: 11, fontWeight: 500, letterSpacing: 0.3 }}>
            + Add Job
          </button>
        </div>
      </div>

      {/* ── OLLAMA OFFLINE BANNER ── */}
      {aiProvider === "ollama" && ollamaStatus === "offline" && (
        <div style={{ background: "#1a0e0e", borderBottom: "1px solid #3a1515", padding: "10px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 12, color: "#f07070", lineHeight: 1.5 }}>
            <strong>Ollama is not running.</strong>{" "}
            <span style={{ color: "#a05050" }}>
              Open the Ollama app, or run <code style={{ background: "#2a1010", padding: "2px 6px", borderRadius: 3, fontSize: 11 }}>ollama serve</code> in a terminal.
            </span>
          </div>
          <button className="btn" onClick={retryOllama}
            style={{ padding: "5px 14px", fontSize: 10, letterSpacing: 0.5, background: "#2a1515", border: "1px solid #4a2020", borderRadius: 6, color: "#f07070" }}>
            Retry
          </button>
        </div>
      )}

      {/* ── BODY ── */}
      <div style={{ display: "flex", height: "calc(100vh - 56px)" }}>

        {/* Main area */}
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {/* Filter chips */}
          <div style={{ display: "flex", gap: 5, marginBottom: 16, flexWrap: "wrap" }}>
            {["All", ...STATUSES].map(s => {
              const st = STATUS_STYLE[s];
              const active = filterStatus === s;
              return (
                <button key={s} className="btn" onClick={() => { setFilterStatus(s); if (s !== "All") setView("list"); }}
                  style={{ padding: "3px 10px", borderRadius: 20, fontSize: 9, letterSpacing: 0.8,
                    border: `1px solid ${active && st ? st.border : "#1a1e2a"}`,
                    background: active && st ? st.bg : "transparent",
                    color: active && st ? st.text : "#2a2f3d" }}>
                  {s}{s !== "All" && <span style={{ marginLeft: 4, opacity: 0.5 }}>{apps.filter(a => a.status === s).length}</span>}
                </button>
              );
            })}
          </div>

          {/* Board */}
          {view === "board" && (
            <div style={{ display: "flex", gap: 11, overflowX: "auto", paddingBottom: 10 }}>
              {boardCols.map(col => {
                const st = STATUS_STYLE[col.status];
                return (
                  <div key={col.status} className="board-col">
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 8, letterSpacing: 2, color: st.text }}>{col.status.toUpperCase()}</span>
                      <span style={{ fontSize: 9, color: "#2a2f3d" }}>{col.items.length}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {col.items.map(app => (
                        <JobCard key={app.id} app={app} isSelected={selected?.id === app.id}
                          onClick={() => { setSelected(app); setAiResult({ action: null, text: "", loading: false }); }} />
                      ))}
                      {col.items.length === 0 && (
                        <div style={{ border: "1px dashed #141720", borderRadius: 7, padding: "20px 10px", textAlign: "center", fontSize: 9, color: "#1a1e2a" }}>empty</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* List */}
          {view === "list" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {filtered.length === 0 && <div style={{ textAlign: "center", padding: 48, color: "#2a2f3d", fontSize: 12 }}>No applications found.</div>}
              {filtered.map(app => (
                <div key={app.id} className="card job-card" onClick={() => { setSelected(app); setAiResult({ action: null, text: "", loading: false }); }}
                  style={{ padding: "10px 15px", display: "flex", alignItems: "center", gap: 14,
                    border: selected?.id === app.id ? "1px solid #e8c56a33" : "1px solid #1a1e2a" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, fontSize: 13, color: "#dce0ee" }}>{app.role}</div>
                    <div style={{ fontSize: 11, color: "#3a4055", marginTop: 2 }}>{app.company} · {app.date}</div>
                  </div>
                  <StatusBadge status={app.status} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── DETAIL PANEL ── */}
        {selected && (
          <div style={{ width: 390, borderLeft: "1px solid #1a1e2a", overflow: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Title */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 18, color: "#e8e4d0", fontStyle: "italic", lineHeight: 1.25 }}>{selected.role}</div>
                <div style={{ fontSize: 11, color: "#3a4055", marginTop: 3 }}>{selected.company} · {selected.date}</div>
              </div>
              <button className="btn" onClick={() => setSelected(null)} style={{ color: "#2a2f3d", fontSize: 18, background: "none" }}>×</button>
            </div>

            {/* Status */}
            <div>
              <span className="lbl">STATUS</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {STATUSES.map(s => {
                  const st = STATUS_STYLE[s];
                  const active = selected.status === s;
                  return (
                    <button key={s} className="btn" onClick={() => updateStatus(selected.id, s)}
                      style={{ padding: "3px 8px", borderRadius: 4, fontSize: 10,
                        border: `1px solid ${active ? st.border : "#1a1e2a"}`,
                        background: active ? st.bg : "transparent",
                        color: active ? st.text : "#2a2f3d" }}>
                      {s}
                    </button>
                  );
                })}
              </div>
            </div>

            {selected.notes && (
              <div>
                <span className="lbl">NOTES</span>
                <div style={{ fontSize: 11.5, color: "#5a6080", lineHeight: 1.65 }}>{selected.notes}</div>
              </div>
            )}

            {selected.url && (
              <a href={selected.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#5a9ae0", textDecoration: "none" }}>🔗 View Listing →</a>
            )}

            {/* Resume warning */}
            {!resumeSet && (
              <div style={{ background: "#130f08", border: "1px solid #3a2808", borderRadius: 6, padding: "9px 12px", fontSize: 11, color: "#c09050", lineHeight: 1.5 }}>
                ⚠️ <strong>Base resume not set.</strong> Add your resume to unlock Tailored Resume & Cover Letter.{" "}
                <span style={{ color: "#e8c56a", textDecoration: "underline", cursor: "pointer" }}
                  onClick={() => { setResumeDraft(""); setShowResumeModal(true); }}>
                  Set it now →
                </span>
              </div>
            )}

            {/* JD warning */}
            {!selected.jd && (
              <div style={{ background: "#080f13", border: "1px solid #0e2a3a", borderRadius: 6, padding: "9px 12px", fontSize: 11, color: "#5090b0", lineHeight: 1.5 }}>
                💡 No job description saved for this role. AI results will be generic without it.
              </div>
            )}

            {/* AI Actions */}
            <div>
              <span className="lbl">AI WORKFLOW</span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {AI_ACTIONS.map(a => {
                  const isActive  = aiResult.action === a.id;
                  const locked    = a.needsResume && !resumeSet;
                  return (
                    <button key={a.id} className="ai-btn" onClick={() => !locked && runAI(a.id)}
                      title={locked ? "Set your base resume first" : a.hint}
                      style={{
                        borderColor: isActive ? a.color + "66" : undefined,
                        background:  isActive ? "#0f1320" : undefined,
                        opacity:     locked ? 0.35 : 1,
                        cursor:      locked ? "not-allowed" : "pointer",
                      }}>
                      <div style={{ color: isActive ? a.color : "#8090a8", fontSize: 12, marginBottom: 3 }}>{a.label}</div>
                      <div style={{ fontSize: 9, color: "#2a2f3d", lineHeight: 1.5 }}>{a.hint}</div>
                      {a.needsResume && <div style={{ fontSize: 8, color: "#2a3a28", marginTop: 2 }}>requires resume</div>}
                      {isActive && <div style={{ position: "absolute", top: 7, right: 7, width: 5, height: 5, borderRadius: "50%", background: a.color, boxShadow: `0 0 6px ${a.color}` }} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* AI Output */}
            {(aiResult.loading || aiResult.text) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 9, letterSpacing: 2, color: (activeAction?.color || "#e8c56a") + "88" }}>
                    {activeAction?.label?.toUpperCase() || "OUTPUT"}
                  </span>
                  {!aiResult.loading && aiResult.text && (
                    <button className="copy-btn" onClick={copyResult}>{copied ? "✓ COPIED" : "COPY"}</button>
                  )}
                </div>

                {aiResult.loading ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 0" }}>
                    {[95, 80, 88, 65, 92, 55, 75].map((w, i) => (
                      <div key={i} className="shimmer" style={{ height: 11, width: `${w}%` }} />
                    ))}
                    <div style={{ fontSize: 9, color: "#2a2f3d", marginTop: 4, letterSpacing: 1 }}>
                      {aiProvider === "ollama" ? `GENERATING WITH ${ollamaModel.toUpperCase()}…` : "GENERATING WITH CLAUDE…"}
                    </div>
                  </div>
                ) : (
                  <div className="ai-result" style={{ maxHeight: aiResult.action === "resume" ? 500 : 340 }}>
                    {aiResult.text}
                  </div>
                )}
              </div>
            )}

            {/* Delete */}
            <button className="btn" onClick={() => deleteApp(selected.id)}
              style={{ marginTop: "auto", padding: "7px", background: "none", border: "1px solid #1e1010", borderRadius: 6, color: "#4a2020", fontSize: 10, letterSpacing: 1 }}>
              DELETE APPLICATION
            </button>
          </div>
        )}
      </div>

      {/* ── BASE RESUME MODAL ── */}
      {showResumeModal && (
        <div className="overlay" onClick={e => e.target === e.currentTarget && setShowResumeModal(false)}>
          <div className="modal" style={{ width: 700 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
              <div>
                <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 20, color: "#e8c56a", fontStyle: "italic" }}>My Base Resume</div>
                <div style={{ fontSize: 11, color: "#3a4055", marginTop: 4, lineHeight: 1.6 }}>
                  Paste your full resume below. The AI will tailor a variation for each job you apply to — your original is never modified.
                </div>
              </div>
              <button className="btn" onClick={() => setShowResumeModal(false)} style={{ color: "#2a2f3d", fontSize: 20, background: "none", marginLeft: 12 }}>×</button>
            </div>

            {/* Tips */}
            <div style={{ margin: "14px 0", padding: "10px 14px", background: "#0e150e", border: "1px solid #2a4a2a66", borderRadius: 6, fontSize: 11, color: "#6ec87e", lineHeight: 1.7 }}>
              <strong>Tips for best AI output:</strong> Include your full work history with bullet points, key skills, education, and any relevant projects. The richer your base resume, the better the tailored output. Plain text works perfectly.
            </div>

            <textarea className="inp" rows={20} value={resumeDraft} onChange={e => setResumeDraft(e.target.value)}
              style={{ resize: "vertical", lineHeight: 1.7, fontSize: 12, fontFamily: "inherit" }}
              placeholder={`JANE DOE
jane@email.com  |  linkedin.com/in/janedoe  |  github.com/janedoe

SUMMARY
Full-stack engineer with 5 years building scalable web applications...

EXPERIENCE
Senior Software Engineer — Acme Corp  (Jan 2022 – Present)
• Led migration of monolith to microservices, reducing latency by 40%
• Mentored team of 4 junior engineers across 3 product lines
• Shipped 12 features used by 500K+ monthly active users

Software Engineer — Startup Inc  (Jun 2019 – Dec 2021)
• Built real-time dashboard in React + Node.js from 0 to 50K users
• Reduced CI/CD pipeline duration from 18 min to 4 min

SKILLS
Languages: TypeScript, Python, Go
Frameworks: React, Next.js, Node.js, FastAPI
Cloud: AWS (EC2, RDS, Lambda), Docker, Kubernetes

EDUCATION
B.Sc. Computer Science — State University, 2019`} />

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
              <div style={{ flex: 1, fontSize: 10, color: "#2a2f3d" }}>
                {wordCount > 0 ? `${wordCount} words · ready to power AI tailoring` : "Paste your resume above"}
              </div>
              <button className="btn" onClick={() => setShowResumeModal(false)}
                style={{ padding: "7px 16px", background: "none", border: "1px solid #1a1e2a", borderRadius: 6, color: "#4a5070", fontSize: 11 }}>
                Cancel
              </button>
              <button className="btn" onClick={() => { persistResume(resumeDraft); setShowResumeModal(false); }}
                style={{ padding: "7px 20px", background: "#e8c56a", borderRadius: 6, color: "#0a0b0f", fontSize: 11, fontWeight: 500 }}>
                Save Resume
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ADD JOB MODAL ── */}
      {showForm && (
        <div className="overlay" onClick={e => e.target === e.currentTarget && setShowForm(false)}>
          <div className="modal">
            <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 20, color: "#e8c56a", fontStyle: "italic", marginBottom: 18 }}>New Application</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 9, letterSpacing: 1.5, color: "#2a2f3d", display: "block", marginBottom: 5 }}>COMPANY *</label>
                  <input className="inp" value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} placeholder="Acme Corp" />
                </div>
                <div>
                  <label style={{ fontSize: 9, letterSpacing: 1.5, color: "#2a2f3d", display: "block", marginBottom: 5 }}>ROLE *</label>
                  <input className="inp" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} placeholder="Senior Engineer" />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 9, letterSpacing: 1.5, color: "#2a2f3d", display: "block", marginBottom: 5 }}>STATUS</label>
                  <select className="inp" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 9, letterSpacing: 1.5, color: "#2a2f3d", display: "block", marginBottom: 5 }}>JOB URL</label>
                  <input className="inp" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} placeholder="https://..." />
                </div>
              </div>
              <div>
                <label style={{ fontSize: 9, letterSpacing: 1.5, color: "#2a2f3d", display: "block", marginBottom: 5 }}>
                  JOB DESCRIPTION <span style={{ color: "#5de8b866", fontSize: 9 }}>★ drives resume tailoring + cover letter</span>
                </label>
                <textarea className="inp" rows={7} value={form.jd} onChange={e => setForm({ ...form, jd: e.target.value })}
                  placeholder="Paste the full job description here. This is what the AI uses to tailor your resume and write your cover letter…" style={{ resize: "vertical" }} />
              </div>
              <div>
                <label style={{ fontSize: 9, letterSpacing: 1.5, color: "#2a2f3d", display: "block", marginBottom: 5 }}>NOTES</label>
                <textarea className="inp" rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                  placeholder="Referral source, salary range, recruiter name…" style={{ resize: "vertical" }} />
              </div>
              {!resumeSet && (
                <div style={{ background: "#130f08", border: "1px solid #3a2808", borderRadius: 6, padding: "9px 12px", fontSize: 11, color: "#c09050" }}>
                  ⚠️ Base resume not set — AI resume tailoring won't work.{" "}
                  <span style={{ color: "#e8c56a", textDecoration: "underline", cursor: "pointer" }}
                    onClick={() => { setResumeDraft(""); setShowResumeModal(true); }}>
                    Add it now →
                  </span>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                <button className="btn" onClick={() => setShowForm(false)}
                  style={{ padding: "7px 16px", background: "none", border: "1px solid #1a1e2a", borderRadius: 6, color: "#4a5070", fontSize: 11 }}>
                  Cancel
                </button>
                <button className="btn" onClick={addApp}
                  style={{ padding: "7px 20px", background: "#e8c56a", borderRadius: 6, color: "#0a0b0f", fontSize: 11, fontWeight: 500 }}>
                  Add Application
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────
function JobCard({ app, onClick, isSelected }) {
  const st = STATUS_STYLE[app.status];
  return (
    <div className="card job-card" onClick={onClick}
      style={{ padding: "10px", border: isSelected ? "1px solid #e8c56a2a" : "1px solid #1a1e2a" }}>
      <div style={{ fontSize: 12.5, fontWeight: 500, color: "#dce0ee", marginBottom: 3, lineHeight: 1.3 }}>{app.role}</div>
      <div style={{ fontSize: 10.5, color: "#3a4055", marginBottom: 7 }}>{app.company}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <StatusBadge status={app.status} />
        <span style={{ fontSize: 9, color: "#1e2230" }}>{app.date}</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const st = STATUS_STYLE[status];
  return (
    <span className="tag" style={{ background: st.bg, border: `1px solid ${st.border}`, color: st.text }}>
      {status}
    </span>
  );
}
