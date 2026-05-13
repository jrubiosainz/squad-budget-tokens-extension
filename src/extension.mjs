// squad-budget-tokens — Token budget guard for Copilot CLI Squad sessions.
//
// What it does:
//   • Activates only when the current repo is a Squad workspace
//     (i.e. it has a `.squad/` folder OR `.github/agents/squad.agent.md`).
//   • Spins up a tiny HTTP dashboard on http://127.0.0.1:51954/.
//   • The browser asks the user to enter token budgets (input / output / cached)
//     for the current session — same three buckets shown by `/usage`.
//   • Once any limit is set, the dashboard streams (SSE) live token consumption,
//     broken down per Squad agent (Coordinator + each subagent spawned via the
//     `task` tool whose prompt names a member from .squad/agents/).
//   • When ANY of the configured token budgets is hit, every further tool
//     call is denied (kills autopilot loops) and the user is notified.

import { joinSession } from "@github/copilot-sdk/extension";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = 51954;
const URL = `http://${HOST}:${PORT}/`;

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const state = {
    active: false,
    cwd: null,
    knownAgents: [],

    // Token budgets — null means "not enforced". Block when any is exceeded.
    maxInput: null,
    maxOutput: null,
    maxCached: null,

    // Totals across the whole session.
    totalInput: 0,
    totalOutput: 0,
    totalCached: 0,

    // Per-agent: { name: { input, output, cached, role, samples } }
    perAgent: {},

    // Local-inference channel — tokens served by on-device models (Foundry
    // Local). These are FREE: they do NOT count against the token budgets
    // and never trigger safeAbort(). Shown in the doughnut/table with a
    // green palette + LOCAL/FREE tags so the user can tell at a glance
    // which slices are zero-cost.
    totalLocalInput: 0,
    totalLocalOutput: 0,
    totalLocalCached: 0,
    localRequests: 0,
    // { name: { input, output, cached, requests, role, model } }
    perLocalAgent: {},

    blocked: false,
    startedAt: null,
    limitSetAt: null,
    events: [],
    voices: [],
};

const sseClients = new Set();
let httpServer = null;
let browserOpened = false;
let session = null;

// Stack of currently-running task() tool calls so we can attribute usage
// events to the subagent that's actually doing the work.
//   [{ toolCallId, agent, role }, ...] — newest at end
const taskStack = [];

// Dedup token usage events by call_id / event id so the same `usage` payload
// repeated across `delta` and `complete` doesn't double-count.
const seenUsageKeys = new Set();

// Once we've seen a dedicated `*.usage` event in this session, ignore other
// event types that happen to also carry an `output_tokens` field — they
// re-include the same numbers and would double-count.
let usagePathSeen = false;

function safeAbort(reason) {
    if (!session || typeof session.abort !== "function") return;
    Promise.resolve().then(() => session.abort()).catch(() => {});
    try {
        if (typeof session.log === "function") {
            session.log(`squad-budget-tokens: abort() — ${reason}`, { level: "warning" });
        }
    } catch {}
}

// ---------------------------------------------------------------------------
// Squad workspace detection
// ---------------------------------------------------------------------------
function detectSquad(cwd) {
    if (!cwd) return false;
    if (existsSync(join(cwd, ".squad"))) return true;
    if (existsSync(join(cwd, ".github", "agents", "squad.agent.md"))) return true;
    return false;
}

function loadKnownAgents(cwd) {
    const dir = join(cwd, ".squad", "agents");
    if (!existsSync(dir)) return [];
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
            .map((d) => d.name);
    } catch {
        return [];
    }
}

function snapshot() {
    return {
        active: state.active,
        cwd: state.cwd,
        knownAgents: state.knownAgents,
        maxInput: state.maxInput,
        maxOutput: state.maxOutput,
        maxCached: state.maxCached,
        totalInput: state.totalInput,
        totalOutput: state.totalOutput,
        totalCached: state.totalCached,
        perAgent: state.perAgent,
        totalLocalInput: state.totalLocalInput,
        totalLocalOutput: state.totalLocalOutput,
        totalLocalCached: state.totalLocalCached,
        localRequests: state.localRequests,
        perLocalAgent: state.perLocalAgent,
        blocked: state.blocked,
        startedAt: state.startedAt,
        limitSetAt: state.limitSetAt,
        events: state.events.slice(-80),
        voices: state.voices.slice(-50),
    };
}

function pushEvent(level, message, extra) {
    state.events.push({ ts: Date.now(), level, message, ...(extra || {}) });
    if (state.events.length > 250) state.events.shift();
    pushUpdate();
}

function pushUpdate() {
    if (sseClients.size === 0) return;
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of sseClients) {
        try { res.write(payload); } catch {}
    }
}

// ---------------------------------------------------------------------------
// Token addition (the heart of this extension)
// ---------------------------------------------------------------------------
function currentAgent() {
    if (taskStack.length > 0) {
        const top = taskStack[taskStack.length - 1];
        return { name: top.agent, role: top.role || "" };
    }
    return { name: "Coordinator", role: "Squad" };
}

function addTokens({ input = 0, output = 0, cached = 0, agent, role, source }) {
    if (!input && !output && !cached) return;
    const a = agent || currentAgent().name;
    const r = role || currentAgent().role || "";
    if (!state.perAgent[a]) {
        state.perAgent[a] = { input: 0, output: 0, cached: 0, role: r, samples: 0 };
    }
    if (r && !state.perAgent[a].role) state.perAgent[a].role = r;
    state.perAgent[a].input += input;
    state.perAgent[a].output += output;
    state.perAgent[a].cached += cached;
    state.perAgent[a].samples += 1;

    state.totalInput += input;
    state.totalOutput += output;
    state.totalCached += cached;

    state.events.push({
        ts: Date.now(),
        level: "tokens",
        type: "tokens",
        agent: a,
        role: r,
        input, output, cached,
        source: source || "",
        message: `+${input} in · +${output} out · +${cached} cached`,
    });
    if (state.events.length > 250) state.events.shift();

    // Enforce budgets.
    if (!state.blocked) {
        const exceeded = [];
        if (state.maxInput  != null && state.totalInput  >= state.maxInput)  exceeded.push(`input ${state.totalInput}/${state.maxInput}`);
        if (state.maxOutput != null && state.totalOutput >= state.maxOutput) exceeded.push(`output ${state.totalOutput}/${state.maxOutput}`);
        if (state.maxCached != null && state.totalCached >= state.maxCached) exceeded.push(`cached ${state.totalCached}/${state.maxCached}`);
        if (exceeded.length > 0) {
            state.blocked = true;
            pushEvent("error", `Token budget exhausted (${exceeded.join("; ")}). Autopilot halted — session.abort() called.`);
            safeAbort(`token budget exhausted (${exceeded.join("; ")})`);
            return;
        }
    }
    pushUpdate();
}

// ---------------------------------------------------------------------------
// Recursive scan of an event payload for token-usage signals.
//
// Different SDK / model providers report tokens under different field names:
//   - OpenAI-style:   prompt_tokens / completion_tokens
//   - Anthropic-style: input_tokens / output_tokens / cache_read_input_tokens /
//                      cache_creation_input_tokens
//   - SDK telemetry:  usage_input_tokens / usage_output_tokens
// We accept any of them and map to {input, output, cached}.
// ---------------------------------------------------------------------------
function extractUsage(payload) {
    if (!payload || typeof payload !== "object") return null;
    let input = 0, output = 0, cached = 0, found = false;

    const visit = (node, depth) => {
        if (!node || typeof node !== "object" || depth > 6) return;
        // Direct field names we care about.
        const numeric = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : 0;
        const inKeys     = ["input_tokens", "prompt_tokens", "usage_input_tokens", "inputTokens", "promptTokens"];
        const outKeys    = ["output_tokens", "completion_tokens", "usage_output_tokens", "outputTokens", "completionTokens"];
        const cacheReadKeys = ["cache_read_input_tokens", "cached_tokens", "cacheReadInputTokens", "cacheReadTokens", "cache_read_tokens"];
        const cacheCreateKeys = ["cache_creation_input_tokens", "cacheCreationInputTokens", "cache_creation_tokens"];

        for (const k of inKeys)     { if (k in node) { input  += numeric(node[k]); found = true; } }
        for (const k of outKeys)    { if (k in node) { output += numeric(node[k]); found = true; } }
        for (const k of cacheReadKeys)   { if (k in node) { cached += numeric(node[k]); found = true; } }
        for (const k of cacheCreateKeys) { if (k in node) { cached += numeric(node[k]); found = true; } }

        // Recurse into nested objects/arrays.
        if (Array.isArray(node)) {
            for (const v of node) visit(v, depth + 1);
        } else {
            for (const k of Object.keys(node)) {
                const v = node[k];
                if (v && typeof v === "object") visit(v, depth + 1);
            }
        }
    };
    visit(payload, 0);
    if (!found) return null;
    return { input, output, cached };
}

// ---------------------------------------------------------------------------
// Local-inference channel — Foundry Local etc.
//
// Same shape as addTokens() but DOES NOT count against any token budget and
// never triggers safeAbort(). This is how O'Brien (Foundry Local) shows up
// in the dashboard — the user sees a green slice in the doughnut + a row in
// the breakdown table tagged LOCAL/FREE, while the premium token counters
// stay untouched (these calls cost zero $$).
// ---------------------------------------------------------------------------
function bumpLocalTokens({ agent, role, model, input = 0, output = 0, cached = 0 }) {
    const a = agent || "obrien";
    if (!state.perLocalAgent[a]) {
        state.perLocalAgent[a] = { input: 0, output: 0, cached: 0, requests: 0, role: role || "", model: model || "" };
    }
    if (role  && !state.perLocalAgent[a].role)  state.perLocalAgent[a].role  = role;
    if (model && !state.perLocalAgent[a].model) state.perLocalAgent[a].model = model;
    state.perLocalAgent[a].input  += input;
    state.perLocalAgent[a].output += output;
    state.perLocalAgent[a].cached += cached;
    state.perLocalAgent[a].requests += 1;
    state.totalLocalInput  += input;
    state.totalLocalOutput += output;
    state.totalLocalCached += cached;
    state.localRequests += 1;

    const finalModel = model || state.perLocalAgent[a].model || "";
    state.events.push({
        ts: Date.now(),
        level: "local",
        type: "local-inference",
        agent: a,
        role: role || state.perLocalAgent[a].role || "",
        model: finalModel,
        input, output, cached,
        message: (input || output || cached)
            ? `local · +${input} in · +${output} out · +${cached} cached${finalModel ? " · " + finalModel : ""}`
            : `local inference${finalModel ? " · " + finalModel : ""}`,
    });
    if (state.events.length > 250) state.events.shift();
    pushUpdate();
}

// Detect a Foundry-Local OpenAI-compatible chat-completion call inside a
// shell command. Returns { agent, model } if matched, else null.
//
// Recognises the canonical loopback endpoint Foundry Local serves on
// (always 127.0.0.1, port assigned at runtime) plus the /v1/chat/completions
// path. We deliberately ignore foundry CLI metadata commands (status, list,
// load, etc.) — those don't run inference, so they don't represent O'Brien
// "doing work" and shouldn't show up in the breakdown.
const FOUNDRY_ENDPOINT_RE = /127\.0\.0\.1:\d{4,5}\/v1\/chat\/completions/i;
const FOUNDRY_MODEL_RE    = /["']?model["']?\s*[:=]\s*["']([^"']{3,120})["']/i;

function detectLocalInference(toolName, toolArgs) {
    if (!toolArgs) return null;
    const candidates = [];
    if (typeof toolArgs.command === "string") candidates.push(toolArgs.command);
    if (typeof toolArgs.script  === "string") candidates.push(toolArgs.script);
    if (typeof toolArgs.input   === "string") candidates.push(toolArgs.input);
    if (Array.isArray(toolArgs.args)) candidates.push(toolArgs.args.join(" "));
    const blob = candidates.join("\n");
    if (!blob) return null;
    if (!FOUNDRY_ENDPOINT_RE.test(blob)) return null;
    const m = blob.match(FOUNDRY_MODEL_RE);
    return { agent: "obrien", model: m ? m[1] : "" };
}

// ---------------------------------------------------------------------------
// Squad subagent name parsing (copied + adapted from squad-budget)
// ---------------------------------------------------------------------------
function parseAgentFromTaskPrompt(prompt) {
    if (typeof prompt !== "string") return null;
    // Tolerate the "You are the {Name}" form (Scribe spawns use this), where
    // an extra "the" precedes the actual name. Without the optional `the`
    // prefix we'd capture the article itself and surface "the (unlisted)" in
    // the per-agent table.
    const m = prompt.match(/^\s*You are\s+(?:the\s+)?([A-Za-z@][\w'\-@]*)(?:,\s+the\s+([^.\n]+))?/m);
    if (!m) return null;
    return { name: m[1], role: (m[2] || "").trim() };
}

function findKnownAgentInTaskArgs(toolArgs, knownAgents) {
    if (!toolArgs || !Array.isArray(knownAgents) || knownAgents.length === 0) return null;
    const rawHaystack = [
        toolArgs.prompt, toolArgs.name, toolArgs.description, toolArgs.agent_type,
    ].filter((s) => typeof s === "string").join("\n");
    if (!rawHaystack) return null;
    const haystack = rawHaystack.replace(/['\u2019\u2018]/g, "");
    let firstHit = null, firstIdx = Infinity;
    for (const a of knownAgents) {
        const safe = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(^|[^A-Za-z0-9])${safe}([^A-Za-z0-9]|$)`, "i");
        const m = haystack.match(re);
        if (m && m.index < firstIdx) { firstHit = a; firstIdx = m.index; }
    }
    if (!firstHit) return null;
    const name = firstHit.charAt(0).toUpperCase() + firstHit.slice(1);
    return { name, role: "" };
}

// ---------------------------------------------------------------------------
// Voice extraction (trace-only, doesn't affect budget)
// ---------------------------------------------------------------------------
const VOICE_BUFFER_MAX = 200;
const VOICE_TEXT_MAX = 280;

function stripEmoji(s) {
    return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu, "").trim();
}
function normalizeHeader(raw) {
    return stripEmoji(raw).replace(/\*\*/g, "").replace(/__/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
}
const HEADER_NAME_RE = /^([A-Z][A-Za-z'\-]{1,30})(?:\s*(?:\(([^)]+)\)|[—–-]\s*([^()\n]+?)))?\s*$/;

function parseSquadVoices(text, knownAgents) {
    if (typeof text !== "string" || !text) return [];
    const normalizedKnown = new Set((knownAgents || []).map((a) => a.toLowerCase()));
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const voices = [];
    let cur = null, inFence = false;
    const flush = () => {
        if (cur && cur.text.trim().length > 0) {
            const trimmed = cur.text.trim();
            voices.push({
                name: cur.name, role: cur.role,
                text: trimmed.length > VOICE_TEXT_MAX ? trimmed.slice(0, VOICE_TEXT_MAX - 1) + "…" : trimmed,
            });
        }
        cur = null;
    };
    for (const line of lines) {
        if (/^\s*```/.test(line)) { inFence = !inFence; if (cur) cur.text += line + "\n"; continue; }
        if (inFence) { if (cur) cur.text += line + "\n"; continue; }
        const h = line.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/);
        if (h) {
            flush();
            const norm = normalizeHeader(h[2]);
            const nm = norm.match(HEADER_NAME_RE);
            if (!nm) continue;
            const name = nm[1];
            const role = (nm[2] || nm[3] || "").trim();
            if (normalizedKnown.size > 0 && !normalizedKnown.has(name.toLowerCase())) continue;
            cur = { name, role, text: "" };
        } else if (cur) {
            cur.text += line + "\n";
        }
    }
    flush();
    return voices;
}

function pushVoices(parentAgent, voices) {
    if (!voices || voices.length === 0) return;
    const now = Date.now();
    for (const v of voices) {
        state.voices.push({ ts: now, agent: v.name, role: v.role || "", parent: parentAgent || "", text: v.text });
    }
    while (state.voices.length > VOICE_BUFFER_MAX) state.voices.shift();
    pushUpdate();
}

function openBrowser(url) {
    if (browserOpened) return;
    browserOpened = true;
    let cmd;
    if (process.platform === "win32") cmd = `cmd /c start "" "${url}"`;
    else if (process.platform === "darwin") cmd = `open "${url}"`;
    else cmd = `xdg-open "${url}"`;
    exec(cmd, () => {});
}

// ---------------------------------------------------------------------------
// HTTP server (dashboard + JSON API + SSE)
// ---------------------------------------------------------------------------
function startServer() {
    if (httpServer) return;
    httpServer = createServer((req, res) => {
        const url = req.url || "/";
        if (url === "/" || url.startsWith("/?")) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(DASHBOARD_HTML);
            return;
        }
        if (url === "/api/state") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(snapshot()));
            return;
        }
        if (url === "/api/events") {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
                "access-control-allow-origin": "*",
            });
            res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
            sseClients.add(res);
            req.on("close", () => sseClients.delete(res));
            return;
        }
        if (url === "/api/limit" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                try {
                    const { input, output, cached } = JSON.parse(body || "{}");
                    const norm = (v) => {
                        if (v === "" || v === null || v === undefined) return null;
                        const n = Math.floor(Number(v));
                        if (!Number.isFinite(n) || n < 1) return null;
                        return n;
                    };
                    state.maxInput  = norm(input);
                    state.maxOutput = norm(output);
                    state.maxCached = norm(cached);
                    if (state.maxInput == null && state.maxOutput == null && state.maxCached == null) {
                        throw new Error("at least one of input/output/cached budgets must be set");
                    }
                    state.limitSetAt = Date.now();
                    state.blocked =
                        (state.maxInput  != null && state.totalInput  >= state.maxInput) ||
                        (state.maxOutput != null && state.totalOutput >= state.maxOutput) ||
                        (state.maxCached != null && state.totalCached >= state.maxCached);
                    pushEvent("info",
                        `Token budgets set — input: ${state.maxInput ?? "∞"}, output: ${state.maxOutput ?? "∞"}, cached: ${state.maxCached ?? "∞"}.`);
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: true, maxInput: state.maxInput, maxOutput: state.maxOutput, maxCached: state.maxCached }));
                } catch (e) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
                }
            });
            return;
        }
        if (url === "/api/reset" && req.method === "POST") {
            state.totalInput = 0;
            state.totalOutput = 0;
            state.totalCached = 0;
            state.perAgent = {};
            state.totalLocalInput = 0;
            state.totalLocalOutput = 0;
            state.totalLocalCached = 0;
            state.localRequests = 0;
            state.perLocalAgent = {};
            state.blocked = false;
            seenUsageKeys.clear();
            pushEvent("info", "Token counters reset.");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (url === "/api/unblock" && req.method === "POST") {
            state.blocked = false;
            pushEvent("info", "Block manually cleared by user.");
            res.writeHead(200); res.end("ok");
            return;
        }
        // Local-inference bump endpoint. Wrapper scripts (call-obrien.ps1
        // and verify-obrien.ps1) hit this AFTER successfully calling
        // Foundry Local so the dashboard can show the call without
        // affecting the premium-token budgets. Token counts (input/output/
        // cached) are optional — when present, they're attributed to the
        // local channel so users see the real local volume next to the
        // FREE tag.
        if (url === "/api/local-bump" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => { body += c; if (body.length > 8192) req.destroy(); });
            req.on("end", () => {
                let payload = {};
                try { payload = JSON.parse(body || "{}"); } catch {}
                const agent = (payload.agent || "obrien").toString().slice(0, 60);
                const role  = (payload.role  || "Local Inference (Foundry Local)").toString().slice(0, 80);
                const model = (payload.model || "").toString().slice(0, 120);
                const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0) ? Math.floor(v) : 0;
                bumpLocalTokens({
                    agent, role, model,
                    input:  num(payload.input)  || num(payload.input_tokens)  || num(payload.prompt_tokens),
                    output: num(payload.output) || num(payload.output_tokens) || num(payload.completion_tokens),
                    cached: num(payload.cached) || num(payload.cached_tokens),
                });
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, localRequests: state.localRequests }));
            });
            return;
        }
        if (url === "/api/reset-local" && req.method === "POST") {
            state.totalLocalInput = 0;
            state.totalLocalOutput = 0;
            state.totalLocalCached = 0;
            state.localRequests = 0;
            state.perLocalAgent = {};
            pushEvent("info", "Local counters reset.");
            res.writeHead(200); res.end("ok");
            return;
        }
        res.writeHead(404);
        res.end();
    });
    httpServer.on("error", (err) => {
        try { session.log(`squad-budget-tokens: HTTP server error: ${err.message}`, { level: "warning" }); } catch {}
    });
    httpServer.listen(PORT, HOST);
}

// ---------------------------------------------------------------------------
// Eager activation
// ---------------------------------------------------------------------------
function activate(cwd) {
    if (state.active) return;
    if (!cwd || !detectSquad(cwd)) return;
    state.cwd = cwd;
    state.active = true;
    state.startedAt = state.startedAt || Date.now();
    state.knownAgents = loadKnownAgents(cwd);
    startServer();
    openBrowser(URL);
}

// ---------------------------------------------------------------------------
// Wire up the session
// ---------------------------------------------------------------------------
session = await joinSession({
    hooks: {
        onSessionStart: async (input) => {
            state.cwd = input.cwd;
            if (!detectSquad(input.cwd)) return;
            activate(input.cwd);
            await session.log(`🛡️ squad-budget-tokens active — open ${URL} to set token budgets.`);
            const limitsSet = state.maxInput != null || state.maxOutput != null || state.maxCached != null;
            if (!limitsSet) {
                return {
                    additionalContext:
                        `[squad-budget-tokens] A token budget guard is active. ` +
                        `Dashboard at ${URL}. The user must set input/output/cached token ceilings ` +
                        `there before any budget is enforced.`,
                };
            }
            return {
                additionalContext:
                    `[squad-budget-tokens] Active — ` +
                    `input ${state.totalInput}/${state.maxInput ?? "∞"}, ` +
                    `output ${state.totalOutput}/${state.maxOutput ?? "∞"}, ` +
                    `cached ${state.totalCached}/${state.maxCached ?? "∞"}.`,
            };
        },

        onUserPromptSubmitted: async (input) => {
            if (!state.active) return;
            if (state.blocked) {
                safeAbort("user prompt while over token budget");
                pushEvent("info", `User prompt rejected — token budget exhausted. Raise limits at ${URL}.`);
                return {
                    modifiedPrompt:
                        `[squad-budget-tokens] BLOCKED — token budget exhausted ` +
                        `(input ${state.totalInput}/${state.maxInput ?? "∞"}, ` +
                        `output ${state.totalOutput}/${state.maxOutput ?? "∞"}, ` +
                        `cached ${state.totalCached}/${state.maxCached ?? "∞"}). ` +
                        `Do NOT call any tools. Reply with one line telling the user to ` +
                        `open ${URL} to raise the limits or reset, then stop.`,
                };
            }
        },

        onPreToolUse: async (input) => {
            if (!state.active) return;
            if (state.blocked) {
                safeAbort("tool call while over token budget");
                return {
                    permissionDecision: "deny",
                    permissionDecisionReason:
                        `STOP. Token budget exhausted ` +
                        `(input ${state.totalInput}/${state.maxInput ?? "∞"}, ` +
                        `output ${state.totalOutput}/${state.maxOutput ?? "∞"}, ` +
                        `cached ${state.totalCached}/${state.maxCached ?? "∞"}). ` +
                        `Autopilot halted. Do NOT retry. Tell the user to open ${URL} to raise limits or run /clear.`,
                };
            }
        },

        onPostToolUse: async (input) => {
            if (!state.active) return;
            if (input.toolName !== "task") return;
            try {
                const result = input.toolResult;
                if (!result || result.resultType !== "success") return;
                const text = result.textResultForLlm;
                if (typeof text !== "string" || !text) return;
                const voices = parseSquadVoices(text, state.knownAgents);
                if (voices.length === 0) return;
                const meta = parseAgentFromTaskPrompt(input.toolArgs?.prompt)
                    || findKnownAgentInTaskArgs(input.toolArgs, state.knownAgents);
                const parent = meta?.name || input.toolArgs?.agent_type || "task";
                pushVoices(parent, voices);
            } catch {}
        },
    },
});

// ---------------------------------------------------------------------------
// Wildcard listener — primary token-discovery path.
//
// We don't know in advance which event types carry usage info, so we scan
// every event for the canonical token field names. To avoid double-counting
// the same usage payload that's repeated across delta + complete events,
// we dedupe by (event.type + call_id|message_id|seq).
// ---------------------------------------------------------------------------
session.on((event) => {
    if (!state.active) return;
    try {
        const t = event && event.type;
        if (!t) return;
        const data = event.data || {};

        // Update the task-attribution stack.
        if (t === "tool.execution_start" && data.toolName === "task") {
            const args = data.arguments || {};
            let meta = parseAgentFromTaskPrompt(args.prompt)
                || findKnownAgentInTaskArgs(args, state.knownAgents);
            let agent, role;
            if (meta) {
                const normalized = meta.name.replace(/['\u2019\u2018]/g, "").toLowerCase();
                const isKnown =
                    state.knownAgents.length === 0 ||
                    state.knownAgents.includes(normalized) ||
                    state.knownAgents.includes(meta.name.toLowerCase()) ||
                    state.knownAgents.includes(meta.name);
                let displayName = meta.name;
                if (isKnown && state.knownAgents.includes(normalized)) {
                    displayName = normalized.charAt(0).toUpperCase() + normalized.slice(1);
                }
                agent = isKnown ? displayName : `${meta.name} (unlisted)`;
                role = meta.role;
            } else {
                agent = "subagent";
                role = args.agent_type || "";
            }
            taskStack.push({ toolCallId: data.toolCallId || `t${Date.now()}`, agent, role });
        }

        // Shell-style tool calls: detect Foundry Local inference (zero-cost,
        // off-budget) and attribute it to O'Brien on the local channel so it
        // shows up in the green slice of the doughnut.
        if (t === "tool.execution_start" && typeof data.toolName === "string"
            && /^(powershell|bash|shell|terminal)/i.test(data.toolName)) {
            const local = detectLocalInference(data.toolName, data.arguments || {});
            if (local) {
                bumpLocalTokens({
                    agent: local.agent,
                    role: "Local Inference (Foundry Local)",
                    model: local.model,
                });
            }
        }
        if (t === "tool.execution_complete" && data.toolName === "task") {
            const id = data.toolCallId;
            // Pop matching entry (by id, falling back to "the most recent" for safety).
            let idx = -1;
            for (let i = taskStack.length - 1; i >= 0; i--) {
                if (taskStack[i].toolCallId === id) { idx = i; break; }
            }
            if (idx >= 0) taskStack.splice(idx, 1);
            else if (taskStack.length > 0) taskStack.pop();
        }

        // Voice mining on task complete.
        if (t === "tool.execution_complete" && data.toolName === "task" && data.success === true) {
            const text = data.result?.content;
            if (typeof text === "string" && text) {
                const voices = parseSquadVoices(text, state.knownAgents);
                if (voices.length > 0) {
                    pushVoices((idxToParent(data.toolCallId)) || "task", voices);
                }
            }
        }

        // Usage extraction.
        const usage = extractUsage(data);
        if (usage) {
            // Many SDKs emit BOTH a dedicated `*.usage` event (with the full
            // input/output/cached breakdown) AND another event such as
            // `assistant.message` that re-includes a subset of those numbers.
            // Counting both double-counts. Strategy:
            //   1) Once we've ever seen a `*.usage` event in this session,
            //      ONLY count tokens from `*.usage` events. Other events that
            //      happen to contain a `output_tokens` field are ignored.
            //   2) Before the first `*.usage` event, accept any event so we
            //      still work on SDKs that don't have a dedicated channel.
            const isUsageEvent = typeof t === "string" && /\.usage$/i.test(t);
            if (isUsageEvent) usagePathSeen = true;
            if (usagePathSeen && !isUsageEvent) return;

            // Dedup by message/call id WITHOUT the event type prefix so the
            // same usage payload reported across delta + complete events of
            // the same `*.usage` channel is only counted once.
            const idKey =
                data.messageId || data.message_id ||
                data.callId || data.call_id || data.toolCallId ||
                data.turnId || data.turn_id || data.id || null;
            const dedupKey = idKey
                ? "msg::" + idKey
                : "anon::" + t + "::" + JSON.stringify(usage) + ":" + (state.totalInput + state.totalOutput + state.totalCached);
            if (seenUsageKeys.has(dedupKey)) return;
            seenUsageKeys.add(dedupKey);
            // Cap dedup set to avoid unbounded growth.
            if (seenUsageKeys.size > 5000) {
                const arr = Array.from(seenUsageKeys);
                seenUsageKeys.clear();
                arr.slice(-2500).forEach((k) => seenUsageKeys.add(k));
            }
            addTokens({
                input: usage.input || 0,
                output: usage.output || 0,
                cached: usage.cached || 0,
                source: t,
            });
        }
    } catch {}
});

function idxToParent(toolCallId) {
    if (!toolCallId) return null;
    // Look at recently-popped entries — but since we pop before voice mining
    // we have to rely on the parsing fallback.
    return null;
}

// Fallback assistant.turn_start — if no usage event ever arrives for the
// coordinator (depends on SDK build), we at least mark each turn so the
// agent shows up in the table with zero tokens.
session.on("assistant.turn_start", () => {
    if (!state.active || state.blocked) return;
    if (!state.perAgent["Coordinator"]) {
        state.perAgent["Coordinator"] = { input: 0, output: 0, cached: 0, role: "Squad", samples: 0 };
        pushUpdate();
    }
});

// At shutdown the platform may report authoritative totals.
session.on("session.shutdown", (event) => {
    const d = event?.data;
    if (!d) return;
    pushEvent("info",
        `Session shutdown. Tracked totals — input ${state.totalInput}, output ${state.totalOutput}, cached ${state.totalCached}.`);
});

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Squad Budget · Tokens</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root {
    color-scheme: dark;
    --bgColor-default: #0d1117;
    --bgColor-muted: #161b22;
    --bgColor-inset: #010409;
    --bgColor-emphasis: #21262d;
    --borderColor-default: #30363d;
    --borderColor-muted: #21262d;
    --fgColor-default: #e6edf3;
    --fgColor-muted: #9da7b3;
    --fgColor-onEmphasis: #ffffff;
    --accent-fg: #2f81f7;
    --accent-emphasis: #1f6feb;
    --accent-subtle: rgba(56,139,253,0.15);
    --success-fg: #3fb950;
    --success-emphasis: #238636;
    --success-subtle: rgba(46,160,67,0.15);
    --attention-fg: #d29922;
    --attention-subtle: rgba(187,128,9,0.15);
    --danger-fg: #f85149;
    --danger-subtle: rgba(248,81,73,0.15);
    --purple-fg: #a371f7;
    --purple-subtle: rgba(163,113,247,0.15);
    --focus-ring: 0 0 0 2px var(--accent-emphasis);
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-pill: 999px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    background: var(--bgColor-default);
    color: var(--fgColor-default);
    padding: 24px;
    max-width: 1100px;
    margin-inline: auto;
  }
  h1 { margin: 0 0 4px 0; font-size: 24px; line-height: 1.25; font-weight: 600;
       display: flex; align-items: center; gap: 10px; letter-spacing: -0.01em; }
  h2 { margin: 0 0 8px 0; font-size: 16px; font-weight: 600; line-height: 1.4; }
  h3 { margin: 24px 0 8px 0; font-size: 13px; font-weight: 600; line-height: 1.4;
       text-transform: uppercase; letter-spacing: 0.04em; color: var(--fgColor-muted); }
  code { background: var(--bgColor-emphasis); padding: 1px 6px; border-radius: 4px;
         font-size: 12px; font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace; }
  .muted { color: var(--fgColor-muted); font-size: 13px; }
  .pill {
    font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: var(--radius-pill);
    border: 1px solid transparent; line-height: 1.4;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .pill.idle      { background: var(--bgColor-emphasis); color: var(--fgColor-muted); border-color: var(--borderColor-default); }
  .pill.tracking  { background: var(--accent-subtle); color: var(--accent-fg); border-color: rgba(56,139,253,0.4); }
  .pill.near      { background: rgba(187,128,9,0.15); color: var(--attention-fg); border-color: rgba(187,128,9,0.4); }
  .pill.blocked   { background: var(--danger-subtle); color: var(--danger-fg); border-color: rgba(248,81,73,0.4); }
  .panel {
    background: var(--bgColor-muted);
    border: 1px solid var(--borderColor-default);
    border-radius: var(--radius-md);
    padding: 20px;
    margin-top: 16px;
  }
  .grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 24px; align-items: start; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }

  label { display: block; font-size: 13px; font-weight: 500; color: var(--fgColor-default); margin-bottom: 6px; }
  input[type=number] {
    background: var(--bgColor-default);
    color: var(--fgColor-default);
    border: 1px solid var(--borderColor-default);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    font-size: 14px;
    line-height: 20px;
    width: 100%;
    font-family: inherit;
  }
  input[type=number]:hover { border-color: var(--fgColor-muted); }
  input[type=number]:focus-visible { outline: none; border-color: var(--accent-emphasis); box-shadow: var(--focus-ring); }
  button {
    background: var(--success-emphasis);
    color: var(--fgColor-onEmphasis);
    border: 1px solid rgba(240,246,252,0.1);
    border-radius: var(--radius-sm);
    padding: 8px 16px;
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    cursor: pointer;
    margin-left: 8px;
    font-family: inherit;
    transition: background 0.12s, border-color 0.12s;
  }
  button:hover { background: #2ea043; }
  button.secondary {
    background: var(--bgColor-emphasis);
    color: var(--fgColor-default);
    border: 1px solid var(--borderColor-default);
  }
  button.secondary:hover { background: #30363d; border-color: var(--fgColor-muted); }
  button:focus-visible { outline: none; box-shadow: var(--focus-ring); }
  button + button { margin-left: 8px; }

  .budget-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin: 14px 0 10px 0; }
  @media (max-width: 700px) { .budget-grid { grid-template-columns: 1fr; } }

  /* Three-bucket meters stacked vertically */
  .meter { margin-bottom: 16px; }
  .meter:last-of-type { margin-bottom: 0; }
  .meter .head {
    display: flex; align-items: baseline; justify-content: space-between;
    font-variant-numeric: tabular-nums; margin-bottom: 6px;
  }
  .meter .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;
                  color: var(--fgColor-muted); font-weight: 600; }
  .meter .nums  { font-size: 14px; }
  .meter .nums .used  { font-weight: 600; color: var(--fgColor-default); }
  .meter .nums .limit { color: var(--fgColor-muted); }
  .meter .nums .pct   { color: var(--fgColor-muted); margin-left: 8px; font-size: 12px; }
  .bar-wrap {
    background: var(--bgColor-emphasis);
    border-radius: var(--radius-pill);
    height: 8px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    width: 0%;
    border-radius: var(--radius-pill);
    transition: width 0.3s ease, background-color 0.2s;
  }
  .bar-fill.input  { background: var(--accent-fg); }
  .bar-fill.output { background: var(--purple-fg); }
  .bar-fill.cached { background: var(--success-fg); }
  .bar-fill.near   { background: var(--attention-fg) !important; }
  .bar-fill.over   { background: var(--danger-fg) !important; }

  .actions { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 8px; }
  .actions button { margin-left: 0; }
  .blocked-banner {
    background: var(--danger-subtle);
    border: 1px solid rgba(248,81,73,0.4);
    padding: 12px 14px;
    border-radius: var(--radius-sm);
    color: var(--danger-fg);
    margin-top: 16px;
    font-weight: 500;
    font-size: 13px;
    display: flex; align-items: center; gap: 8px;
  }
  .blocked-banner::before { content: "⛔"; font-size: 16px; }
  .meta-grid { display: grid; gap: 10px; padding: 14px; margin: 14px 0;
               background: var(--bgColor-inset); border: 1px solid var(--borderColor-muted);
               border-radius: var(--radius-sm); font-size: 13px; }
  .meta-grid .row { display: grid; grid-template-columns: 110px 1fr; gap: 12px; align-items: baseline; }
  .meta-grid .label { color: var(--fgColor-muted); }
  .meta-grid .value { color: var(--fgColor-default); font-family: ui-monospace, "SF Mono", "Cascadia Code", monospace;
                      font-size: 12px; word-break: break-all; }
  .agent-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: var(--radius-pill);
          background: var(--accent-subtle); color: var(--accent-fg);
          border: 1px solid rgba(56,139,253,0.3); font-family: inherit; }

  .chart-wrap {
    max-width: 220px;
    width: 100%;
    margin: 0 auto;
    aspect-ratio: 1 / 1;
    position: relative;
  }
  .chart-wrap canvas { width: 100% !important; height: 100% !important; display: block; }

  .events {
    max-height: 320px; overflow-y: auto;
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace;
    font-size: 12px; line-height: 1.6;
    background: var(--bgColor-inset);
    border: 1px solid var(--borderColor-muted);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
  }
  .events .ev {
    display: grid;
    grid-template-columns: 78px 1fr auto;
    gap: 12px;
    padding: 3px 0;
    align-items: baseline;
  }
  .events .ev + .ev { border-top: 1px solid var(--borderColor-muted); }
  .events .ev .ts { color: var(--fgColor-muted); font-variant-numeric: tabular-nums; }
  .events .ev .body { color: var(--fgColor-default); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; min-width: 0; }
  .events .ev .agent { color: var(--fgColor-default); font-weight: 600; }
  .events .ev .role  { color: var(--fgColor-muted); font-size: 11px; }
  .events .ev .msg   { color: var(--fgColor-muted); }
  .events .ev .tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 1px 6px; border-radius: var(--radius-pill);
    background: var(--accent-subtle); color: var(--accent-fg);
    border: 1px solid rgba(56,139,253,0.3);
    font-family: inherit;
  }
  .events .ev.error  .tag { background: var(--danger-subtle); color: var(--danger-fg); border-color: rgba(248,81,73,0.4); }
  .events .ev.tokens .tag { background: var(--purple-subtle); color: var(--purple-fg); border-color: rgba(163,113,247,0.4); }
  .events .ev.info   .tag { background: var(--bgColor-emphasis); color: var(--fgColor-muted); border-color: var(--borderColor-default); }
  .events .ev.local  .tag { background: rgba(63,185,80,0.15); color: var(--success-fg); border-color: rgba(63,185,80,0.4); }
  .events .ev.local  .msg { color: var(--success-fg); }
  .events .ev.error  .msg { color: var(--danger-fg); }
  /* Per-agent table — small green tags for local-inference rows. */
  td .free-tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 1px 6px; border-radius: var(--radius-pill); margin-left: 6px;
    background: rgba(63,185,80,0.15); color: var(--success-fg);
    border: 1px solid rgba(63,185,80,0.4);
  }
  .empty { color: var(--fgColor-muted); font-style: italic; padding: 12px 0; font-size: 13px; }

  .voices {
    max-height: 420px; overflow-y: auto;
    background: var(--bgColor-inset);
    border: 1px solid var(--borderColor-muted);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
  }
  .voice { padding: 10px 0; border-bottom: 1px solid var(--borderColor-muted); }
  .voice:last-child { border-bottom: none; }
  .voice .head {
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    margin-bottom: 4px; font-size: 12px;
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace;
  }
  .voice .ts { color: var(--fgColor-muted); font-variant-numeric: tabular-nums; }
  .voice .agent { color: var(--fgColor-default); font-weight: 600; font-size: 13px; }
  .voice .role { color: var(--fgColor-muted); font-size: 11px; }
  .voice .parent { color: var(--fgColor-muted); font-size: 11px; }
  .voice .tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 1px 6px; border-radius: var(--radius-pill);
    background: var(--purple-subtle); color: var(--purple-fg);
    border: 1px solid rgba(163,113,247,0.4);
    font-family: inherit;
  }
  .voice .text {
    color: var(--fgColor-default); font-size: 13px; line-height: 1.5;
    white-space: pre-wrap; word-wrap: break-word;
    border-left: 2px solid var(--purple-fg); padding-left: 10px; margin-left: 4px;
  }

  .hidden { display: none; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--borderColor-muted); font-size: 13px; }
  thead th { color: var(--fgColor-muted); font-weight: 500; font-size: 12px;
             text-transform: uppercase; letter-spacing: 0.04em;
             border-bottom: 1px solid var(--borderColor-default); }
  tbody tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.empty-cell { text-align: center; color: var(--fgColor-muted); font-style: italic; padding: 18px 0; }
</style>
</head>
<body>
  <h1>🛡️ Squad Budget · Tokens <span class="pill idle" id="status-pill" role="status" aria-live="polite">connecting…</span></h1>
  <div class="muted" id="cwd"></div>

  <div class="panel" id="setup-panel">
    <h2>Set token budgets for this session</h2>
    <p class="muted" style="margin-top:0">
      Tracks the same buckets shown by Copilot CLI's <code>/usage</code>: input, output and cached
      tokens consumed by Squad — coordinator turns plus every subagent dispatched via the
      <code>task</code> tool. When ANY budget is hit, all further tool calls are denied
      (even with autopilot on) until you raise the limits or reset.
    </p>

    <div class="meta-grid" id="setup-meta" aria-label="Detected workspace">
      <div class="row">
        <span class="label">Workspace</span>
        <span class="value" id="setup-cwd">—</span>
      </div>
      <div class="row">
        <span class="label">Agents detected</span>
        <span class="agent-chips" id="setup-agents"><span class="muted">none</span></span>
      </div>
    </div>

    <div class="budget-grid">
      <div>
        <label for="limit-input">Max input tokens</label>
        <input type="number" id="limit-input" min="1" placeholder="e.g. 200000" />
      </div>
      <div>
        <label for="limit-output">Max output tokens</label>
        <input type="number" id="limit-output" min="1" placeholder="e.g. 50000" />
      </div>
      <div>
        <label for="limit-cached">Max cached tokens</label>
        <input type="number" id="limit-cached" min="1" placeholder="e.g. 1000000" />
      </div>
    </div>
    <button id="limit-set" aria-label="Start tracking with the entered budgets">Start tracking</button>
    <div class="muted" style="margin-top:8px">
      Leave any field empty to mean "unlimited" for that bucket. At least one must be set.
      Cached tokens are typically much higher than input/output — they're discounted by the platform but still count toward usage.
    </div>
  </div>

  <div class="panel hidden" id="dashboard-panel">
    <div class="grid">
      <div>
        <div class="meter">
          <div class="head">
            <span class="label">Input tokens</span>
            <span class="nums">
              <span class="used" id="used-input">0</span> /
              <span class="limit" id="limit-input-disp">∞</span>
              <span class="pct" id="pct-input">—</span>
            </span>
          </div>
          <div class="bar-wrap"><div class="bar-fill input" id="bar-input"></div></div>
        </div>

        <div class="meter">
          <div class="head">
            <span class="label">Output tokens</span>
            <span class="nums">
              <span class="used" id="used-output">0</span> /
              <span class="limit" id="limit-output-disp">∞</span>
              <span class="pct" id="pct-output">—</span>
            </span>
          </div>
          <div class="bar-wrap"><div class="bar-fill output" id="bar-output"></div></div>
        </div>

        <div class="meter">
          <div class="head">
            <span class="label">Cached tokens</span>
            <span class="nums">
              <span class="used" id="used-cached">0</span> /
              <span class="limit" id="limit-cached-disp">∞</span>
              <span class="pct" id="pct-cached">—</span>
            </span>
          </div>
          <div class="bar-wrap"><div class="bar-fill cached" id="bar-cached"></div></div>
        </div>

        <div class="blocked-banner hidden" id="blocked-banner" role="alert">
          Token budget exhausted — Squad has been halted. Tool calls are being denied.
        </div>

        <p class="muted" style="margin: 8px 0 0; font-size: 12px;">
          <strong id="local-count" style="color:#3fb950">0</strong> local inference calls
          <span class="muted">(free, off-budget)</span>
        </p>

        <div class="actions">
          <button class="secondary" id="reset" aria-label="Reset token counters to zero">Reset counters</button>
          <button class="secondary" id="raise" aria-label="Raise the maximum token limits">Raise limits…</button>
          <button class="secondary" id="unblock" aria-label="Clear the block and resume tool calls">Clear block</button>
        </div>
      </div>
      <div>
        <div class="chart-wrap">
          <canvas id="chart" aria-label="Per-agent total token share"></canvas>
        </div>
        <p class="muted" style="text-align:center;font-size:11px;margin-top:8px">
          Per-agent share of total tokens (input + output + cached).
        </p>
      </div>
    </div>

    <h3>Per-agent breakdown</h3>
    <table>
      <thead><tr>
        <th scope="col">Agent</th>
        <th scope="col">Role</th>
        <th scope="col" class="num">Input</th>
        <th scope="col" class="num">Output</th>
        <th scope="col" class="num">Cached</th>
        <th scope="col" class="num">Total</th>
      </tr></thead>
      <tbody id="agent-rows">
        <tr><td colspan="6" class="empty-cell">No tokens consumed yet.</td></tr>
      </tbody>
    </table>

    <h3>Recent activity</h3>
    <div class="events" id="events" role="log" aria-live="polite" aria-label="Recent token events">
      <div class="empty">Waiting for activity…</div>
    </div>

    <h3>Squad voices</h3>
    <p class="muted" style="margin-top:-4px;margin-bottom:8px;font-size:12px">
      Individual member statements parsed from each <code>task</code> result. Trace-only.
    </p>
    <div class="voices" id="voices" role="log" aria-live="polite" aria-label="Squad member voices">
      <div class="empty">No squad voices captured yet.</div>
    </div>
  </div>

<script>
let chart = null;

async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body || {}) });
  return r.json().catch(() => ({}));
}

document.getElementById("limit-set").onclick = async () => {
  const inp = document.getElementById("limit-input").value;
  const out = document.getElementById("limit-output").value;
  const cac = document.getElementById("limit-cached").value;
  if (!inp && !out && !cac) { alert("Enter at least one budget."); return; }
  const r = await postJSON("/api/limit", { input: inp, output: out, cached: cac });
  if (r && r.ok === false) alert("Failed: " + (r.error || "unknown"));
};
document.getElementById("reset").onclick = () => postJSON("/api/reset");
document.getElementById("unblock").onclick = () => postJSON("/api/unblock");
document.getElementById("raise").onclick = async () => {
  const inp = prompt("New max INPUT tokens (blank = unlimited):", "");
  const out = prompt("New max OUTPUT tokens (blank = unlimited):", "");
  const cac = prompt("New max CACHED tokens (blank = unlimited):", "");
  await postJSON("/api/limit", { input: inp, output: out, cached: cac });
};

function fmt(n) {
  if (n == null) return "∞";
  if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function setMeter(id, used, limit) {
  document.getElementById("used-" + id).textContent = fmt(used);
  document.getElementById("limit-" + id + "-disp").textContent = limit == null ? "∞" : fmt(limit);
  const pctEl = document.getElementById("pct-" + id);
  const bar = document.getElementById("bar-" + id);
  if (limit == null || limit === 0) {
    pctEl.textContent = "—";
    bar.style.width = "0%";
    bar.classList.remove("near", "over");
    return 0;
  }
  const pct = Math.min(100, (used / limit) * 100);
  pctEl.textContent = pct.toFixed(1) + "%";
  bar.style.width = pct + "%";
  bar.classList.toggle("near", pct >= 60 && pct < 85);
  bar.classList.toggle("over", pct >= 85);
  return pct;
}

function render(s) {
  document.getElementById("cwd").textContent = s.cwd ? "Workspace: " + s.cwd : "";
  document.getElementById("setup-cwd").textContent = s.cwd || "—";
  const agentsEl = document.getElementById("setup-agents");
  if (s.knownAgents && s.knownAgents.length) {
    agentsEl.innerHTML = s.knownAgents.map(a => "<span class='chip'>" + a + "</span>").join("");
  } else {
    agentsEl.innerHTML = "<span class='muted'>none detected</span>";
  }

  const limitsSet = s.maxInput != null || s.maxOutput != null || s.maxCached != null;
  const setup = document.getElementById("setup-panel");
  const dash  = document.getElementById("dashboard-panel");
  if (limitsSet) { setup.classList.add("hidden"); dash.classList.remove("hidden"); }
  else           { setup.classList.remove("hidden"); dash.classList.add("hidden"); }

  const pctI = setMeter("input",  s.totalInput,  s.maxInput);
  const pctO = setMeter("output", s.totalOutput, s.maxOutput);
  const pctC = setMeter("cached", s.totalCached, s.maxCached);
  const maxPct = Math.max(pctI, pctO, pctC);

  const pill = document.getElementById("status-pill");
  pill.classList.remove("idle", "tracking", "near", "blocked");
  if (s.blocked) {
    pill.classList.add("blocked"); pill.textContent = "blocked";
  } else if (limitsSet && maxPct >= 85) {
    pill.classList.add("near"); pill.textContent = "near limit";
  } else if (s.active && limitsSet) {
    pill.classList.add("tracking"); pill.textContent = "tracking";
  } else {
    pill.classList.add("idle"); pill.textContent = s.active ? "ready" : "idle";
  }

  document.getElementById("blocked-banner").classList.toggle("hidden", !s.blocked);
  document.getElementById("local-count").textContent = (s.localRequests || 0).toLocaleString();

  // Per-agent doughnut by total tokens.
  // Premium (paid) agents use the existing palette; local-inference agents
  // use a green palette so they're visually distinct AS local in the chart
  // legend, even when collapsed into a single doughnut. They never affect
  // the input/output/cached meters above (off-budget).
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
  const premiumEntries = Object.entries(s.perAgent || {})
    .map(([n, v]) => [n, v, (v.input || 0) + (v.output || 0) + (v.cached || 0)])
    .sort((a, b) => b[2] - a[2]);
  const localEntries = Object.entries(s.perLocalAgent || {})
    .map(([n, v]) => [n, v, (v.input || 0) + (v.output || 0) + (v.cached || 0)])
    .sort((a, b) => b[2] - a[2]);
  const COLORS = ["#2f81f7","#a371f7","#3fb950","#d29922","#f85149","#79c0ff","#ff7b72","#bc8cff","#ffa657","#56d364"];
  const LOCAL_COLORS = ["#3fb950","#56d364","#7ee787","#26a641"];
  const premiumTotal = premiumEntries.reduce((sum, [,, t]) => sum + t, 0);
  const localTotal   = localEntries.reduce((sum, [,, t]) => sum + t, 0);
  const localCalls   = (s.perLocalAgent ? Object.values(s.perLocalAgent).reduce((sum, v) => sum + (v.requests || 0), 0) : 0)
                       || (s.localRequests || 0);
  // The local channel may have ZERO tokens (wrapper hasn't reported usage)
  // but still represents a real call we should show. Give it a slim slice
  // sized 1% of the premium total (or 1 if there are no premium tokens) so
  // it remains visible without dominating the chart.
  const localChartValue = (entry) => entry[2] > 0
    ? entry[2]
    : Math.max(1, Math.floor(premiumTotal * 0.01));
  let labels, data, backgroundColor, isLocal, emptyState = false;
  const haveAny = premiumEntries.length > 0 || localEntries.length > 0;
  if (!haveAny || (premiumTotal === 0 && localCalls === 0)) {
    labels = ["No activity"]; data = [1]; backgroundColor = ["#30363d"]; isLocal = [false]; emptyState = true;
  } else {
    labels = [
      ...premiumEntries.map(([n]) => n),
      ...localEntries.map(([n]) => n + " (local)"),
    ];
    data = [
      ...premiumEntries.map(([,, t]) => t),
      ...localEntries.map((e) => localChartValue(e)),
    ];
    backgroundColor = [
      ...premiumEntries.map((_, i) => COLORS[i % COLORS.length]),
      ...localEntries.map((_, i) => LOCAL_COLORS[i % LOCAL_COLORS.length]),
    ];
    isLocal = [
      ...premiumEntries.map(() => false),
      ...localEntries.map(() => true),
    ];
  }
  const tooltipLabel = (ctx) => {
    const local = isLocal[ctx.dataIndex];
    if (local) {
      const realTotal = localEntries[ctx.dataIndex - premiumEntries.length]?.[2] || 0;
      return ctx.label + ": " + realTotal.toLocaleString() + " tokens (free, local)";
    }
    return ctx.label + ": " + ctx.parsed.toLocaleString() + " tokens";
  };
  if (!chart) {
    chart = new Chart(document.getElementById("chart"), {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor, borderColor: "#161b22", borderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: true, aspectRatio: 1, cutout: "62%",
        plugins: {
          legend: { display: !emptyState, position: "bottom",
            labels: { color: "#9da7b3", font: { size: 11, family: "-apple-system, Segoe UI, sans-serif" },
                      boxWidth: 8, boxHeight: 8, padding: 8, usePointStyle: true } },
          tooltip: { enabled: !emptyState, callbacks: { label: tooltipLabel } }
        }
      }
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.data.datasets[0].backgroundColor = backgroundColor;
    chart.options.plugins.legend.display = !emptyState;
    chart.options.plugins.tooltip.enabled = !emptyState;
    chart.options.plugins.tooltip.callbacks.label = tooltipLabel;
    chart.update("none");
  }

  const premiumRows = premiumEntries.map(([name, v, total]) => {
    return "<tr><td>" + name + "</td><td>" + (v.role || "") + "</td>" +
           "<td class=num>" + fmt(v.input) + "</td>" +
           "<td class=num>" + fmt(v.output) + "</td>" +
           "<td class=num>" + fmt(v.cached) + "</td>" +
           "<td class=num><strong>" + fmt(total) + "</strong></td></tr>";
  }).join("");
  const localRows = localEntries.map(([name, v, total]) => {
    const role = (v.role || "Local Inference") + (v.model ? " · " + v.model : "");
    return "<tr><td>" + esc(name) + " <span class='free-tag'>local</span></td>" +
           "<td>" + esc(role) + "</td>" +
           "<td class=num>" + fmt(v.input)  + "</td>" +
           "<td class=num>" + fmt(v.output) + "</td>" +
           "<td class=num>" + fmt(v.cached) + "</td>" +
           "<td class=num><strong>" + fmt(total) + "</strong> <span class='free-tag'>free</span></td></tr>";
  }).join("");
  const rows = premiumRows + localRows;
  document.getElementById("agent-rows").innerHTML = rows ||
    "<tr><td colspan=6 class=empty-cell>No tokens consumed yet.</td></tr>";

  const fmtTs = (ts) => {
    const d = new Date(ts); const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  };
  const evs = (s.events || []).slice().reverse().slice(0, 80).map(e => {
    const ts = fmtTs(e.ts);
    if (e.level === "tokens") {
      const agent = esc(e.agent || "—");
      const role = e.role ? "<span class='role'>" + esc(e.role) + "</span>" : "";
      return "<div class='ev tokens'>" +
        "<span class='ts'>" + ts + "</span>" +
        "<span class='body'><span class='agent'>" + agent + "</span>" + role +
        "<span class='msg'>" + esc(e.message) + "</span></span>" +
        "<span class='tag'>tokens</span></div>";
    }
    if (e.level === "local") {
      const agent = esc(e.agent || "obrien");
      const role = e.role ? "<span class='role'>" + esc(e.role) + "</span>" : "";
      return "<div class='ev local'>" +
        "<span class='ts'>" + ts + "</span>" +
        "<span class='body'><span class='agent'>" + agent + "</span>" + role +
        "<span class='msg'>" + esc(e.message) + "</span></span>" +
        "<span class='tag'>local · free</span></div>";
    }
    const lvl = esc(e.level || "info");
    return "<div class='ev " + lvl + "'>" +
      "<span class='ts'>" + ts + "</span>" +
      "<span class='body'><span class='msg'>" + esc(e.message) + "</span></span>" +
      "<span class='tag'>" + lvl + "</span></div>";
  }).join("");
  document.getElementById("events").innerHTML = evs ||
    "<div class='empty'>Waiting for activity…</div>";

  const voices = (s.voices || []).slice().reverse().slice(0, 50).map(v => {
    const ts = fmtTs(v.ts);
    const role = v.role ? "<span class='role'>" + esc(v.role) + "</span>" : "";
    const parent = v.parent && v.parent !== v.agent
      ? "<span class='parent'>via " + esc(v.parent) + "</span>" : "";
    return "<div class='voice'>" +
      "<div class='head'>" +
        "<span class='ts'>" + ts + "</span>" +
        "<span class='agent'>" + esc(v.agent) + "</span>" +
        role + parent + "<span class='tag'>voice</span>" +
      "</div>" +
      "<div class='text'>" + esc(v.text) + "</div>" +
    "</div>";
  }).join("");
  document.getElementById("voices").innerHTML = voices ||
    "<div class='empty'>No squad voices captured yet.</div>";
}

const es = new EventSource("/api/events");
es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch {} };
es.onerror = () => {
  const p = document.getElementById("status-pill");
  p.classList.remove("tracking","near","blocked"); p.classList.add("idle");
  p.textContent = "disconnected";
};
fetch("/api/state").then(r => r.json()).then(render).catch(() => {});
</script>
</body>
</html>`;

// Eager activation — runs after DASHBOARD_HTML is defined.
try { activate(process.cwd()); } catch {}
