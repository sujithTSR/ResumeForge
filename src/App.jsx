import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase";
import mammoth from "mammoth";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { saveAs } from "file-saver";

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
async function loadAllResumes() {
  const { data, error } = await supabase
    .from("resumes")
    .select("id, content, docx_path, created_at")
    .order("created_at", { ascending: false });
  if (error) { console.error("loadAllResumes:", error); return []; }
  return (data || []).map(r => ({
    id: r.id,
    content: r.content || "",
    docxPath: r.docx_path || "",
    createdAt: r.created_at,
  }));
}
async function saveResume(text, docxPath = "") {
  const { data, error } = await supabase
    .from("resumes")
    .insert({ content: text, docx_path: docxPath, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .select("id, created_at")
    .single();
  if (error) { console.error("saveResume:", error); return null; }
  return { id: data.id, createdAt: data.created_at };
}
async function deleteResumeById(id, docxPath) {
  if (docxPath) {
    await supabase.storage.from("resumes").remove([docxPath]);
  }
  const { error } = await supabase.from("resumes").delete().eq("id", id);
  if (error) console.error("deleteResume:", error);
}

// ── DOCX helpers ────────────────────────────────────────────────
async function uploadDocx(file) {
  const ts = Date.now();
  const path = `base_resume_${ts}.docx`;
  const { error } = await supabase.storage
    .from("resumes")
    .upload(path, file, { contentType: file.type });
  if (error) { console.error("uploadDocx:", error); return null; }
  return path;
}
async function downloadDocxTemplate(path) {
  const { data, error } = await supabase.storage
    .from("resumes")
    .download(path);
  if (error) { console.error("downloadDocx:", error); return null; }
  return await data.arrayBuffer();
}
async function extractTextFromDocx(arrayBuffer) {
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value || "";
}

function formatResumeJsonAsText(json) {
  const lines = [];
  if (json.summary) { lines.push("PROFESSIONAL SUMMARY", json.summary, ""); }
  if (json.experience) {
    lines.push("EXPERIENCE");
    json.experience.forEach(e => {
      lines.push(`${e.title} — ${e.company}  (${e.dates || ""})`);
      (e.bullets || []).forEach(b => lines.push(`  • ${b}`));
      lines.push("");
    });
  }
  if (json.skills) { lines.push("SKILLS", json.skills.join("  |  "), ""); }
  if (json.education) {
    lines.push("EDUCATION");
    json.education.forEach(e => lines.push(`${e.degree} — ${e.institution}  (${e.year || ""})`));
    lines.push("");
  }
  if (json.certifications) { lines.push("CERTIFICATIONS", ...json.certifications, ""); }
  return lines.join("\n");
}

function parseResumeJson(text) {
  // Try to extract JSON from AI response (may have markdown fences or preamble)
  try { return JSON.parse(text); } catch { /* not pure JSON */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* bad JSON */ } }
  return null;
}

function generateTailoredDocx(templateBuffer, resumeJson) {
  const zip = new PizZip(templateBuffer);
  const xml = zip.file("word/document.xml").asText();
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  const nsURI = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const body = doc.getElementsByTagNameNS(nsURI, "body")[0];
  const paragraphs = body.getElementsByTagNameNS(nsURI, "p");

  // Build section map: find heading paragraphs and their content ranges
  const sections = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const pPr = p.getElementsByTagNameNS(nsURI, "pPr")[0];
    const pStyle = pPr?.getElementsByTagNameNS(nsURI, "pStyle")[0];
    const styleVal = pStyle?.getAttribute("w:val") || "";
    const isHeading = /heading/i.test(styleVal) || /Title/i.test(styleVal);
    // Also detect bold-only paragraphs as pseudo-headings
    const runs = p.getElementsByTagNameNS(nsURI, "r");
    const allText = Array.from(runs).map(r => {
      const t = r.getElementsByTagNameNS(nsURI, "t")[0];
      return t?.textContent || "";
    }).join("").trim();
    const isBoldHeading = !isHeading && allText.length > 0 && allText.length < 60 && runs.length > 0 &&
      Array.from(runs).every(r => {
        const rPr = r.getElementsByTagNameNS(nsURI, "rPr")[0];
        return rPr?.getElementsByTagNameNS(nsURI, "b")[0] != null;
      });

    if ((isHeading || isBoldHeading) && allText) {
      sections.push({ heading: allText.toUpperCase(), index: i, contentStart: i + 1, contentEnd: null });
    }
  }
  // Set content end for each section
  for (let i = 0; i < sections.length; i++) {
    sections[i].contentEnd = (i + 1 < sections.length) ? sections[i + 1].index : paragraphs.length;
  }

  // Helper: set all text in a paragraph while preserving the first run's formatting
  const setParagraphText = (p, text) => {
    const runs = p.getElementsByTagNameNS(nsURI, "r");
    if (runs.length === 0) return;
    // Keep first run's rPr, set its text, remove all other runs
    const firstRun = runs[0];
    const t = firstRun.getElementsByTagNameNS(nsURI, "t")[0];
    if (t) { t.textContent = text; t.setAttribute("xml:space", "preserve"); }
    for (let i = runs.length - 1; i > 0; i--) runs[i].parentNode.removeChild(runs[i]);
  };

  // Helper: clone a paragraph with new text, preserving style
  const cloneParagraphWithText = (templateP, text) => {
    const clone = templateP.cloneNode(true);
    setParagraphText(clone, text);
    return clone;
  };

  // Map AI JSON sections to document sections
  const sectionMap = {
    "SUMMARY": resumeJson.summary,
    "PROFESSIONAL SUMMARY": resumeJson.summary,
    "PROFILE": resumeJson.summary,
    "EXPERIENCE": resumeJson.experience,
    "WORK EXPERIENCE": resumeJson.experience,
    "EMPLOYMENT": resumeJson.experience,
    "SKILLS": resumeJson.skills,
    "TECHNICAL SKILLS": resumeJson.skills,
    "CORE COMPETENCIES": resumeJson.skills,
    "EDUCATION": resumeJson.education,
    "CERTIFICATIONS": resumeJson.certifications,
  };

  // Process each section in reverse order (so indices stay valid)
  for (let s = sections.length - 1; s >= 0; s--) {
    const sec = sections[s];
    const newContent = sectionMap[sec.heading];
    if (!newContent) continue;

    // Get a template paragraph from this section for cloning style
    const templateP = (sec.contentStart < sec.contentEnd) ? paragraphs[sec.contentStart] : null;
    if (!templateP) continue;

    // Remove old content paragraphs
    const toRemove = [];
    for (let i = sec.contentStart; i < sec.contentEnd; i++) toRemove.push(paragraphs[i]);
    toRemove.forEach(p => p.parentNode.removeChild(p));

    // Insert new content — use heading's nextSibling since the paragraphs collection is live
    const headingP = paragraphs[sec.index] || body.lastChild;
    let insertPoint = headingP.nextSibling;

    if (typeof newContent === "string") {
      // Summary: single paragraph
      const newP = cloneParagraphWithText(templateP, newContent);
      body.insertBefore(newP, insertPoint);
    } else if (Array.isArray(newContent) && typeof newContent[0] === "string") {
      // Skills: array of strings
      const joined = newContent.join("  |  ");
      const newP = cloneParagraphWithText(templateP, joined);
      body.insertBefore(newP, insertPoint);
    } else if (Array.isArray(newContent)) {
      // Experience or Education: array of objects
      newContent.forEach(item => {
        if (item.company || item.title || item.institution || item.degree) {
          const header = item.company
            ? `${item.title} — ${item.company}  (${item.dates || ""})`
            : `${item.degree} — ${item.institution}  (${item.year || ""})`;
          const headerP = cloneParagraphWithText(templateP, header);
          body.insertBefore(headerP, insertPoint);
          insertPoint = headerP.nextSibling;
        }
        if (item.bullets) {
          item.bullets.forEach(bullet => {
            const bulletP = cloneParagraphWithText(templateP, `• ${bullet}`);
            body.insertBefore(bulletP, insertPoint);
            insertPoint = bulletP.nextSibling;
          });
        }
      });
    }
  }

  // Serialize back
  const serializer = new XMLSerializer();
  const newXml = serializer.serializeToString(doc);
  zip.file("word/document.xml", newXml);
  return zip.generate({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
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
  resume: `You are an elite resume strategist with deep ATS and human-readability expertise. Given a candidate's base resume and a job description, produce a fully rewritten, tailored resume as structured JSON.

ATS Rules (critical):
- Use standard section headings ONLY: "Summary", "Experience", "Skills", "Education", "Certifications"
- No tables, columns, graphics, icons, or special characters
- Mirror exact keywords and phrases from the job description naturally in bullet points
- Spell out abbreviations on first use (e.g. "Search Engine Optimization (SEO)")
- Every bullet must start with a strong past-tense action verb

Human-Tone Rules:
- Write like a confident professional, not a robot
- NEVER use these words: leverage, utilize, spearhead, synergy, passionate, dynamic, results-driven, self-starter
- Vary sentence length and structure — not every bullet should follow the same pattern
- Be specific: numbers, tools, team sizes, timelines — vague claims get ignored
- Quantify impact with ranges if exact numbers aren't available (e.g. "~30%", "50K+")

Content Rules:
- NEVER invent experience, roles, or qualifications not present in the base resume
- Reorder sections and bullets so the most relevant experience appears first
- Add a concise Professional Summary (2–3 sentences) targeted to this specific role

Output ONLY valid JSON with this exact structure (no markdown, no explanation, no text outside the JSON):
{
  "summary": "2-3 sentence professional summary",
  "experience": [
    { "company": "Company Name", "title": "Job Title", "dates": "Start – End", "bullets": ["bullet 1", "bullet 2"] }
  ],
  "skills": ["Skill 1", "Skill 2", "Skill 3"],
  "education": [
    { "institution": "School Name", "degree": "Degree", "year": "Year" }
  ]
}`,

  cover: `You are a master cover letter writer. Produce a compelling, tailored cover letter (~260 words, 4 paragraphs).

Structure:
1. Hook (1 sentence): Open with genuine enthusiasm + a specific reason you want THIS company and role
2. Fit (2–3 sentences): Connect 2–3 concrete achievements from the resume directly to the JD's top needs
3. Value-add (2 sentences): Articulate what you uniquely bring that other candidates likely won't
4. Close (1–2 sentences): Confident, warm call-to-action with availability

ATS & Tone Rules:
- Mirror 3–5 key phrases from the job description naturally in the letter
- Write in first person as the candidate — warm, confident, specific
- NEVER use: "I am excited to apply", "I believe I would be a great fit", "leverage", "utilize", "synergy", "dynamic"
- Sound like a real human wrote this, not an AI. Vary sentence rhythm. Be conversational but professional.
- Address the hiring manager as "Hiring Team" if no name is given.`,

  fit: `You are a senior recruiter who has screened 10,000+ resumes. Analyse the resume against the job description with brutal honesty.

Output format:
(1) Fit Score /10 with one-line rationale
(2) Top 3 Strengths — cite specific evidence from the resume, not vague praise
(3) Top 3 Gaps — each with a concrete, actionable fix the candidate can do this week
(4) ATS Risk Flags — missing keywords from the JD that the resume should include

Be direct. No flattery. The candidate needs truth, not encouragement.`,

  prep: `You are an expert interview coach who has conducted 5,000+ interviews. Generate 5 likely interview questions for this exact role.

For each question:
- State the question exactly as an interviewer would ask it
- "What they're really asking" — the underlying competency being tested
- 3-bullet STAR answer guide using specific details from the candidate's resume
- One common mistake to avoid

Make questions specific to this company and role, not generic. Include at least one behavioral, one technical, and one culture-fit question.`,

  email: `You are a career coach. Write a brief (3–4 sentence), professional follow-up email to send 5 business days after applying.

Rules:
- Re-express genuine interest — reference something specific about the company (product, mission, recent news)
- Connect one concrete skill from your resume to their biggest stated need
- End with a clear, low-pressure next-step ask
- NEVER use: "I am writing to follow up", "per my application", "I hope this email finds you well"
- Sound human — like a real email you'd actually send, not a template`,
};

// ── Main App ─────────────────────────────────────────────────────
export default function JobTracker() {
  const [apps, setApps]                       = useState([]);
  const [baseResume, setBaseResume]           = useState("");
  const [resumeVersions, setResumeVersions] = useState([]);  // [{ id, content, docxPath, createdAt }]
  const [activeResumeId, setActiveResumeId] = useState(null);
  const [resumeDraft, setResumeDraft]         = useState("");
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [view, setView]                       = useState("board");
  const [showForm, setShowForm]               = useState(false);
  const [selected, setSelected]               = useState(null);
  const [aiResult, setAiResult]               = useState({ action: null, text: "", json: null, loading: false });
  const [copied, setCopied]                   = useState(false);
  const [filterStatus, setFilterStatus]       = useState("All");
  const [form, setForm]                       = useState({ company: "", role: "", url: "", status: "Wishlist", notes: "", jd: "" });
  const [aiProvider, setAiProvider]           = useState(() => localStorage.getItem("job_tracker_provider") || "claude");
  const [ollamaModel, setOllamaModel]         = useState(() => localStorage.getItem("job_tracker_ollama_model") || "llama3.2");
  const [ollamaStatus, setOllamaStatus]       = useState("unknown"); // "unknown" | "checking" | "online" | "offline"
  const [docxPath, setDocxPath]               = useState("");
  const [resumeTab, setResumeTab]             = useState("text"); // "text" | "docx"
  const [docxUploading, setDocxUploading]     = useState(false);
  const [docxGenerating, setDocxGenerating]   = useState(false);
  const [docxPreview, setDocxPreview]         = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    loadApps().then(setApps);
    loadAllResumes().then(versions => {
      setResumeVersions(versions);
      if (versions.length > 0) {
        const latest = versions[0]; // already sorted desc
        setActiveResumeId(latest.id);
        setBaseResume(latest.content);
        setResumeDraft(latest.content);
        setDocxPath(latest.docxPath);
        if (latest.docxPath) setResumeTab("docx");
      }
    });
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

  const persistResume = async (text, dPath = "") => {
    setBaseResume(text);
    const result = await saveResume(text, dPath);
    if (result) {
      const newVersion = { id: result.id, content: text, docxPath: dPath, createdAt: result.createdAt };
      setResumeVersions(prev => [newVersion, ...prev]);
      setActiveResumeId(result.id);
      if (dPath) setDocxPath(dPath);
    }
  };

  const switchResumeVersion = (id) => {
    const version = resumeVersions.find(v => v.id === id);
    if (!version) return;
    setActiveResumeId(id);
    setBaseResume(version.content);
    setResumeDraft(version.content);
    setDocxPath(version.docxPath);
    setDocxPreview("");
  };

  const handleDeleteResume = async (id) => {
    const version = resumeVersions.find(v => v.id === id);
    if (!version) return;
    await deleteResumeById(id, version.docxPath);
    const remaining = resumeVersions.filter(v => v.id !== id);
    setResumeVersions(remaining);
    if (activeResumeId === id) {
      if (remaining.length > 0) {
        switchResumeVersion(remaining[0].id);
      } else {
        setActiveResumeId(null);
        setBaseResume("");
        setResumeDraft("");
        setDocxPath("");
        setDocxPreview("");
      }
    }
  };

  const handleDocxUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDocxUploading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const text = await extractTextFromDocx(arrayBuffer);
      setDocxPreview(text);
      setResumeDraft(text);
      const storagePath = await uploadDocx(file);
      if (storagePath) {
        await persistResume(text, storagePath);
      }
    } catch (err) {
      console.error("DOCX upload failed:", err);
    }
    setDocxUploading(false);
  };

  const handleDownloadDocx = async () => {
    if (!aiResult.json || !docxPath) return;
    setDocxGenerating(true);
    try {
      const template = await downloadDocxTemplate(docxPath);
      if (!template) { setDocxGenerating(false); return; }
      const blob = generateTailoredDocx(template, aiResult.json);
      const name = `Resume_${selected?.company || "Tailored"}_${selected?.role || "Role"}.docx`
        .replace(/\s+/g, "_");
      saveAs(blob, name);
    } catch (err) {
      console.error("DOCX generation failed:", err);
    }
    setDocxGenerating(false);
  };

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

  const runAI = async (action, forceRegenerate = false) => {
    if (!selected) return;
    const actionDef = AI_ACTIONS.find(a => a.id === action);
    if (actionDef?.needsResume && !baseResume.trim()) {
      setAiResult({ action, text: '⚠️  Please set your base resume first — click "My Resume" in the header.', json: null, loading: false });
      return;
    }

    // Check cache first
    const cached = selected.ai_results?.[action];
    if (cached && !forceRegenerate) {
      setCopied(false);
      if (action === "resume" && cached.json) {
        setAiResult({ action, text: cached.text, json: cached.json, loading: false });
      } else {
        setAiResult({ action, text: cached.text, json: null, loading: false });
      }
      return;
    }

    setAiResult({ action, text: "", json: null, loading: true });
    setCopied(false);
    const context = [
      `Role: ${selected.role} at ${selected.company}`,
      `Job Description:\n${selected.jd || "Not provided"}`,
      baseResume ? `Candidate Resume:\n${baseResume}` : "",
      selected.notes ? `Notes: ${selected.notes}` : "",
    ].filter(Boolean).join("\n\n---\n\n");
    const maxTok = action === "resume" ? 3000 : 1200;
    try {
      const text = aiProvider === "ollama"
        ? await callOllama(ollamaModel, SYSTEM_PROMPTS[action], context)
        : await callClaude(SYSTEM_PROMPTS[action], context, maxTok);

      let result;
      if (action === "resume") {
        const json = parseResumeJson(text);
        const display = json ? formatResumeJsonAsText(json) : text;
        result = { action, text: display, json, loading: false };
      } else {
        result = { action, text, json: null, loading: false };
      }
      setAiResult(result);

      // Persist to DB
      const updatedResults = { ...(selected.ai_results || {}), [action]: { text: result.text, json: result.json } };
      const updatedApp = { ...selected, ai_results: updatedResults };
      setSelected(updatedApp);
      setApps(prev => prev.map(a => a.id === selected.id ? updatedApp : a));
      await updateApp(selected.id, { ai_results: updatedResults });
    } catch {
      setAiResult({ action, text: "Error contacting AI. Please try again.", json: null, loading: false });
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
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Inter:wght@300;400;500;600&family=Instrument+Serif:ital@0;1&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e2335; border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: #2a3050; }
        input, textarea, select { font-family: inherit; }

        .btn { cursor: pointer; border: none; outline: none; transition: all 0.2s ease; }
        .btn:hover { transform: translateY(-0.5px); }
        .btn:active { transform: translateY(0.5px); }

        .card {
          background: linear-gradient(145deg, #13161e 0%, #10131a 100%);
          border: 1px solid #1a1e2e;
          border-radius: 10px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.15), 0 0 0 0.5px rgba(255,255,255,0.02) inset;
        }

        .tag { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 6px; font-size: 10px; font-weight: 500; letter-spacing: 0.3px; }

        .inp {
          background: #0a0c12;
          border: 1px solid #1a1e2e;
          border-radius: 8px;
          color: #c8cdd8;
          padding: 10px 14px;
          width: 100%;
          font-size: 13px;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .inp:focus { outline: none; border-color: #e8c56a55; box-shadow: 0 0 0 3px rgba(232,197,106,0.06); }
        .inp::placeholder { color: #282d3d; }

        .board-col { min-width: 220px; max-width: 220px; }

        .job-card {
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .job-card:hover {
          border-color: #2a3050 !important;
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(0,0,0,0.25);
        }

        .overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.6);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          z-index: 50;
          display: flex; align-items: center; justify-content: center;
          padding: 16px;
          animation: fadeIn 0.15s ease;
        }

        .modal {
          background: linear-gradient(160deg, #14171f 0%, #0f1118 100%);
          border: 1px solid #1e2235;
          border-radius: 16px;
          padding: 28px;
          width: 640px;
          max-width: 100%;
          max-height: 92vh;
          overflow-y: auto;
          box-shadow: 0 24px 80px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.03) inset;
          animation: slideUp 0.2s ease;
        }

        .ai-btn {
          background: linear-gradient(135deg, #0f1118 0%, #0c0e15 100%);
          border: 1px solid #1a1e2a;
          border-radius: 8px;
          color: #5a6080;
          padding: 10px 12px;
          font-size: 11px;
          cursor: pointer;
          transition: all 0.2s ease;
          text-align: left;
          position: relative;
          font-family: inherit;
          overflow: hidden;
        }
        .ai-btn::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.04), transparent);
        }
        .ai-btn:hover {
          border-color: #2a3050;
          color: #b0b8d0;
          background: linear-gradient(135deg, #141825 0%, #0f1118 100%);
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }

        .ai-result {
          background: #080a0f;
          border: 1px solid #141825;
          border-radius: 10px;
          padding: 18px;
          font-size: 12px;
          line-height: 1.85;
          white-space: pre-wrap;
          overflow-y: auto;
          color: #a8b0c5;
          box-shadow: 0 2px 12px rgba(0,0,0,0.15) inset;
        }

        .shimmer {
          background: linear-gradient(90deg, #141720 25%, #1e2240 50%, #141720 75%);
          background-size: 200%;
          animation: shimmer 1.4s infinite;
          border-radius: 4px;
        }
        @keyframes shimmer { 0%{background-position:200%} 100%{background-position:-200%} }
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
        @keyframes slideUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

        .copy-btn {
          background: linear-gradient(135deg, #141720 0%, #111420 100%);
          border: 1px solid #1e2335;
          border-radius: 6px;
          color: #5a6080;
          padding: 4px 12px;
          font-size: 10px;
          cursor: pointer;
          font-family: inherit;
          transition: all 0.2s ease;
          letter-spacing: 0.5px;
        }
        .copy-btn:hover { border-color: #e8c56a44; color: #e8c56a; background: #1a1e2a; transform: translateY(-0.5px); }

        .lbl {
          font-size: 9px;
          letter-spacing: 2.5px;
          color: #404860;
          margin-bottom: 8px;
          display: block;
          text-transform: uppercase;
        }

        .detail-section {
          padding: 12px 0;
          border-bottom: 1px solid #111520;
        }
        .detail-section:last-child { border-bottom: none; }

        .glow-dot {
          display: inline-block;
          border-radius: 50%;
          animation: pulse 2s infinite;
        }
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ borderBottom: "1px solid #141825", padding: "14px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        background: "linear-gradient(180deg, #0e1019 0%, #0a0c12 100%)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: 24, color: "#ffffff", fontStyle: "italic",
              textShadow: "0 1px 2px rgba(0,0,0,0.5)" }}>Resume</span>
            <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: 24, fontStyle: "italic",
              background: "linear-gradient(135deg, #f5dfa0 0%, #e8a840 100%)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              filter: "drop-shadow(0 0 12px rgba(232,168,64,0.35))" }}>Forge</span>
          </div>
          <div style={{ height: 16, width: 1, background: "#252a3a" }} />
          <span style={{ fontSize: 8, color: "#505878", letterSpacing: 3.5, fontWeight: 600, marginTop: 1 }}>AI-POWERED</span>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* Stats */}
          {[["TOTAL", stats.total, "#c8cdd8"], ["ACTIVE", stats.active, "#7aafff"], ["OFFERS", stats.offers, "#5de8b8"]].map(([l, v, c]) => (
            <div key={l} style={{ textAlign: "center", minWidth: 40, padding: "4px 6px", borderRadius: 8,
              background: `linear-gradient(135deg, ${c}06, transparent)` }}>
              <div style={{ fontSize: 17, fontWeight: 600, color: c, lineHeight: 1, fontFamily: "'Inter', sans-serif" }}>{v}</div>
              <div style={{ fontSize: 7, color: "#2a2f40", letterSpacing: 2, marginTop: 3, fontWeight: 500 }}>{l}</div>
            </div>
          ))}

          <div style={{ width: 1, height: 24, background: "#252a3a", margin: "0 6px" }} />

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

          <div style={{ width: 1, height: 24, background: "#252a3a", margin: "0 6px" }} />

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
            style={{ background: "linear-gradient(135deg, #e8c56a 0%, #d4a84a 100%)", color: "#0a0b0f", borderRadius: 8,
              padding: "7px 18px", fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
              boxShadow: "0 2px 12px rgba(232,197,106,0.2)" }}>
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
          <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
            {["All", ...STATUSES].map(s => {
              const st = STATUS_STYLE[s];
              const active = filterStatus === s;
              const count = s !== "All" ? apps.filter(a => a.status === s).length : null;
              return (
                <button key={s} className="btn" onClick={() => { setFilterStatus(s); if (s !== "All") setView("list"); }}
                  style={{ padding: "5px 12px", borderRadius: 20, fontSize: 10, letterSpacing: 0.5, fontWeight: 500,
                    border: `1px solid ${active && st ? st.border : "#161a28"}`,
                    background: active && st ? `linear-gradient(135deg, ${st.bg}, transparent)` : "transparent",
                    color: active && st ? st.text : active ? "#c8cdd8" : "#2a2f40",
                    boxShadow: active && st ? `0 0 12px ${st.border}33` : "none",
                    transition: "all 0.2s ease" }}>
                  {s}{count != null && <span style={{ marginLeft: 5, opacity: 0.4, fontSize: 9 }}>{count}</span>}
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
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "6px 10px",
                      background: `linear-gradient(135deg, ${st.bg}, transparent)`, borderRadius: 8,
                      borderLeft: `2px solid ${st.border}` }}>
                      <span style={{ fontSize: 9, letterSpacing: 2, color: st.text, fontWeight: 500 }}>{col.status.toUpperCase()}</span>
                      <span style={{ fontSize: 10, color: st.text + "66", fontWeight: 600, fontFamily: "'Inter', sans-serif" }}>{col.items.length}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      {col.items.map(app => (
                        <JobCard key={app.id} app={app} isSelected={selected?.id === app.id}
                          onClick={() => { setSelected(app); setAiResult({ action: null, text: "", json: null, loading: false }); }} />
                      ))}
                      {col.items.length === 0 && (
                        <div style={{ border: "1px dashed #161a28", borderRadius: 8, padding: "24px 10px", textAlign: "center",
                          fontSize: 10, color: "#1a1e2a", background: "#0a0c10" }}>No jobs yet</div>
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
              {filtered.length === 0 && (
                <div style={{ textAlign: "center", padding: "60px 20px" }}>
                  <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>📋</div>
                  <div style={{ color: "#2a2f40", fontSize: 13, fontWeight: 500 }}>No applications found</div>
                  <div style={{ color: "#1a1e2a", fontSize: 11, marginTop: 4 }}>Click "+ Add Job" to get started</div>
                </div>
              )}
              {filtered.map(app => (
                <div key={app.id} className="card job-card" onClick={() => { setSelected(app); setAiResult({ action: null, text: "", json: null, loading: false }); }}
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
          <div style={{ width: 400, borderLeft: "1px solid #111520", overflow: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16,
            background: "linear-gradient(180deg, #0f1118 0%, #0d0f14 100%)" }}>
            {/* Title */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 20, color: "#eae6d2", fontStyle: "italic", lineHeight: 1.25 }}>{selected.role}</div>
                <div style={{ fontSize: 11, color: "#3a4058", marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 500 }}>{selected.company}</span>
                  <span style={{ color: "#1e2230" }}>·</span>
                  <span>{selected.date}</span>
                </div>
              </div>
              <button className="btn" onClick={() => setSelected(null)}
                style={{ color: "#2a2f3d", fontSize: 16, background: "#0a0c10", width: 28, height: 28, borderRadius: 8,
                  display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid #161a28" }}>×</button>
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
                  const hasCached = !!selected.ai_results?.[a.id];
                  return (
                    <button key={a.id} className="ai-btn" onClick={() => !locked && runAI(a.id)}
                      title={locked ? "Set your base resume first" : hasCached ? "Cached — click to view" : a.hint}
                      style={{
                        borderColor: isActive ? a.color + "66" : hasCached ? a.color + "22" : undefined,
                        background:  isActive ? "#0f1320" : undefined,
                        opacity:     locked ? 0.35 : 1,
                        cursor:      locked ? "not-allowed" : "pointer",
                      }}>
                      <div style={{ color: isActive ? a.color : "#8090a8", fontSize: 12, marginBottom: 3 }}>{a.label}</div>
                      <div style={{ fontSize: 9, color: "#2a2f3d", lineHeight: 1.5 }}>{a.hint}</div>
                      {a.needsResume && !hasCached && <div style={{ fontSize: 8, color: "#2a3a28", marginTop: 2 }}>requires resume</div>}
                      {hasCached && <div style={{ fontSize: 8, color: a.color + "88", marginTop: 2 }}>cached — instant load</div>}
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
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="copy-btn" onClick={() => runAI(aiResult.action, true)}
                        style={{ borderColor: "#f0b06044", color: "#f0b060" }}
                        title="Re-run AI and overwrite cached result">
                        REGENERATE
                      </button>
                      {aiResult.action === "resume" && aiResult.json && docxPath && (
                        <button className="copy-btn" onClick={handleDownloadDocx}
                          style={{ borderColor: "#5de8b844", color: docxGenerating ? "#2a2f3d" : "#5de8b8" }}
                          disabled={docxGenerating}>
                          {docxGenerating ? "GENERATING..." : "DOWNLOAD DOCX"}
                        </button>
                      )}
                      <button className="copy-btn" onClick={copyResult}>{copied ? "✓ COPIED" : "COPY"}</button>
                    </div>
                  )}
                </div>

                {aiResult.loading ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 0" }}>
                    {[95, 75, 88, 60, 92, 50, 70, 82].map((w, i) => (
                      <div key={i} className="shimmer" style={{ height: 10, width: `${w}%`, opacity: 1 - i * 0.05 }} />
                    ))}
                    <div style={{ fontSize: 9, color: "#2a3045", marginTop: 6, letterSpacing: 1.5, fontWeight: 500,
                      display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="glow-dot" style={{ width: 5, height: 5,
                        background: aiProvider === "ollama" ? "#5de8b8" : "#c09af0",
                        boxShadow: `0 0 8px ${aiProvider === "ollama" ? "#5de8b8" : "#c09af0"}` }} />
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
              style={{ marginTop: "auto", padding: "8px", background: "#0e0808", border: "1px solid #1e1212", borderRadius: 8,
                color: "#5a2828", fontSize: 10, letterSpacing: 1.5, fontWeight: 500,
                transition: "all 0.2s ease" }}
              onMouseOver={e => { e.currentTarget.style.background = "#1a0e0e"; e.currentTarget.style.borderColor = "#3a1818"; e.currentTarget.style.color = "#f07070"; }}
              onMouseOut={e => { e.currentTarget.style.background = "#0e0808"; e.currentTarget.style.borderColor = "#1e1212"; e.currentTarget.style.color = "#5a2828"; }}>
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
                  Upload a DOCX to preserve formatting, or paste plain text. The AI tailors a variation for each job — your original is never modified.
                </div>
              </div>
              <button className="btn" onClick={() => setShowResumeModal(false)} style={{ color: "#2a2f3d", fontSize: 20, background: "none", marginLeft: 12 }}>×</button>
            </div>

            {/* Tab toggle */}
            <div style={{ display: "flex", background: "#0f1118", border: "1px solid #1a1e2a", borderRadius: 6, overflow: "hidden", margin: "14px 0 10px" }}>
              {[["docx", "UPLOAD DOCX"], ["text", "PASTE TEXT"]].map(([id, label]) => (
                <button key={id} className="btn" onClick={() => setResumeTab(id)}
                  style={{ flex: 1, padding: "7px", fontSize: 10, letterSpacing: 1.5,
                    background: resumeTab === id ? "#1a1e2a" : "transparent",
                    color: resumeTab === id ? "#e8c56a" : "#2a2f3d" }}>
                  {label}
                </button>
              ))}
            </div>

            {/* Version picker */}
            {resumeVersions.length > 1 && (
              <div style={{ marginBottom: 10 }}>
                <span className="lbl">RESUME VERSIONS</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {resumeVersions.map(v => {
                    const isActive = v.id === activeResumeId;
                    const date = new Date(v.createdAt);
                    const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                      + " " + date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
                    return (
                      <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                        <button className="btn" onClick={() => switchResumeVersion(v.id)}
                          style={{ padding: "4px 10px", fontSize: 10, borderRadius: "4px 0 0 4px",
                            border: `1px solid ${isActive ? "#e8c56a66" : "#1a1e2a"}`, borderRight: "none",
                            background: isActive ? "#1a1810" : "transparent",
                            color: isActive ? "#e8c56a" : "#3a4055" }}>
                          {label}{v.docxPath ? " (.docx)" : " (text)"}{isActive ? " ✓" : ""}
                        </button>
                        <button className="btn" onClick={(e) => { e.stopPropagation(); handleDeleteResume(v.id); }}
                          title="Delete this version"
                          style={{ padding: "4px 6px", fontSize: 10, borderRadius: "0 4px 4px 0",
                            border: `1px solid ${isActive ? "#e8c56a66" : "#1a1e2a"}`,
                            background: "transparent", color: "#4a2020" }}>
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {resumeTab === "docx" ? (
              <>
                {/* DOCX upload area */}
                <div
                  onClick={() => fileInputRef.current?.click()}
                  style={{ border: "2px dashed #1e2330", borderRadius: 8, padding: "32px 20px", textAlign: "center",
                    cursor: "pointer", background: "#0a0c10", transition: "border-color 0.15s" }}
                  onMouseOver={e => e.currentTarget.style.borderColor = "#e8c56a44"}
                  onMouseOut={e => e.currentTarget.style.borderColor = "#1e2330"}>
                  <input ref={fileInputRef} type="file" accept=".docx" onChange={handleDocxUpload}
                    style={{ display: "none" }} />
                  {docxUploading ? (
                    <div style={{ color: "#f0b060", fontSize: 12 }}>Uploading & extracting text...</div>
                  ) : docxPath ? (
                    <div>
                      <div style={{ fontSize: 13, color: "#5de8b8", marginBottom: 6 }}>base_resume.docx uploaded</div>
                      <div style={{ fontSize: 10, color: "#2a2f3d" }}>Click to replace with a new file</div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 13, color: "#5a6080", marginBottom: 6 }}>Click to upload your resume (.docx)</div>
                      <div style={{ fontSize: 10, color: "#2a2f3d" }}>Your formatting will be preserved when generating tailored resumes</div>
                    </div>
                  )}
                </div>

                {/* Extracted text preview */}
                {(docxPreview || (docxPath && baseResume)) && (
                  <div style={{ marginTop: 10 }}>
                    <span className="lbl">EXTRACTED TEXT PREVIEW</span>
                    <div className="ai-result" style={{ maxHeight: 300, fontSize: 11, lineHeight: 1.7 }}>
                      {docxPreview || baseResume}
                    </div>
                  </div>
                )}

                <div style={{ margin: "10px 0", padding: "10px 14px", background: "#0e150e", border: "1px solid #2a4a2a66", borderRadius: 6, fontSize: 11, color: "#6ec87e", lineHeight: 1.7 }}>
                  <strong>Why upload a DOCX?</strong> When the AI generates a tailored resume, it will inject the new content into your original file — same fonts, margins, bullet styles, and layout. You get a ready-to-submit DOCX download.
                </div>
              </>
            ) : (
              <>
                {/* Plain text tab (original) */}
                <div style={{ margin: "4px 0 10px", padding: "10px 14px", background: "#0e150e", border: "1px solid #2a4a2a66", borderRadius: 6, fontSize: 11, color: "#6ec87e", lineHeight: 1.7 }}>
                  <strong>Tips for best AI output:</strong> Include your full work history with bullet points, key skills, education, and any relevant projects. The richer your base resume, the better the tailored output.
                </div>

                <textarea className="inp" rows={20} value={resumeDraft} onChange={e => setResumeDraft(e.target.value)}
                  style={{ resize: "vertical", lineHeight: 1.7, fontSize: 12, fontFamily: "inherit" }}
                  placeholder={`JANE DOE\njane@email.com  |  linkedin.com/in/janedoe\n\nSUMMARY\nFull-stack engineer with 5 years building scalable web applications...\n\nEXPERIENCE\nSenior Software Engineer — Acme Corp  (Jan 2022 – Present)\n• Led migration of monolith to microservices, reducing latency by 40%\n• Mentored team of 4 junior engineers across 3 product lines\n\nSKILLS\nLanguages: TypeScript, Python, Go\nFrameworks: React, Next.js, Node.js\n\nEDUCATION\nB.Sc. Computer Science — State University, 2019`} />
              </>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
              <div style={{ flex: 1, fontSize: 10, color: "#2a2f3d" }}>
                {docxPath && resumeTab === "docx"
                  ? "DOCX template saved — AI will preserve your formatting"
                  : wordCount > 0 ? `${wordCount} words · ready to power AI tailoring` : "Upload a DOCX or paste your resume"}
              </div>
              <button className="btn" onClick={() => setShowResumeModal(false)}
                style={{ padding: "7px 16px", background: "none", border: "1px solid #1a1e2a", borderRadius: 6, color: "#4a5070", fontSize: 11 }}>
                Cancel
              </button>
              {resumeTab === "text" ? (
                <button className="btn" onClick={() => { persistResume(resumeDraft); setShowResumeModal(false); }}
                  style={{ padding: "7px 20px", background: "#e8c56a", borderRadius: 6, color: "#0a0b0f", fontSize: 11, fontWeight: 500 }}>
                  Save Resume
                </button>
              ) : (
                <button className="btn" onClick={() => setShowResumeModal(false)}
                  style={{ padding: "7px 20px", background: "#e8c56a", borderRadius: 6, color: "#0a0b0f", fontSize: 11, fontWeight: 500 }}>
                  Done
                </button>
              )}
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
  const hasCachedResults = app.ai_results && Object.keys(app.ai_results).length > 0;
  return (
    <div className="card job-card" onClick={onClick}
      style={{ padding: "11px 12px",
        border: isSelected ? `1px solid ${st.border}55` : "1px solid #161a28",
        background: isSelected ? `linear-gradient(145deg, ${st.bg}88, #10131a)` : undefined }}>
      <div style={{ fontSize: 12.5, fontWeight: 500, color: "#dce0ee", marginBottom: 4, lineHeight: 1.35 }}>{app.role}</div>
      <div style={{ fontSize: 10.5, color: "#3a4058", marginBottom: 8 }}>{app.company}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <StatusBadge status={app.status} />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {hasCachedResults && (
            <span style={{ width: 4, height: 4, borderRadius: "50%", background: "#e8c56a44", display: "inline-block" }}
              title="Has cached AI results" />
          )}
          <span style={{ fontSize: 9, color: "#1e2235" }}>{app.date}</span>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const st = STATUS_STYLE[status];
  return (
    <span className="tag" style={{
      background: `linear-gradient(135deg, ${st.bg}, transparent)`,
      border: `1px solid ${st.border}`,
      color: st.text,
      boxShadow: `0 0 8px ${st.border}22`
    }}>
      <span style={{ width: 4, height: 4, borderRadius: "50%", background: st.text, display: "inline-block", opacity: 0.6 }} />
      {status}
    </span>
  );
}
