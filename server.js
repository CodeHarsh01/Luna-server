const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { GoogleGenAI } = require('@google/genai');

// ─── AUTO-LOAD .env FILE IF PRESENT ──────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    try {
        const envConfig = fs.readFileSync(envPath, 'utf8');
        for (const line of envConfig.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const [key, ...vals] = trimmed.split('=');
                const val = vals.join('=').trim().replace(/^["']|["']$/g, '');
                if (!process.env[key.trim()]) process.env[key.trim()] = val;
            }
        }
    } catch (_) { }
}

// ─── CONFIG (hardcoded defaults below; .env only overrides when present) ─────
const CONFIG = {
    port: parseInt(process.env.PORT, 10) || 8080,
    logLevel: process.env.LOG_LEVEL || 'info',
    maxConnections: parseInt(process.env.MAX_CONNECTIONS, 10) || 20,
    maxWsMessageSize: parseInt(process.env.MAX_WS_MESSAGE_SIZE, 10) || 64 * 1024,
    historyLimit: parseInt(process.env.HISTORY_LIMIT, 10) || 12,
    aiModel: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    aiTimeoutMs: parseInt(process.env.AI_TIMEOUT_MS, 10) || 30000,
    webTimeoutMs: parseInt(process.env.WEB_TIMEOUT_MS, 10) || 5000,
    newsRefreshHours: parseFloat(process.env.NEWS_REFRESH_HOURS) || 24,
    aiRateGapMs: parseInt(process.env.AI_RATE_GAP_MS, 10) || 1500,
    heartbeatCleanupSec: parseInt(process.env.HEARTBEAT_CLEANUP_SEC, 10) || 120,
    pingIntervalSec: parseInt(process.env.PING_INTERVAL_SEC, 10) || 30
};

// ─── STRUCTURED LOGGER ────────────────────────────────────────────────────────
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const logLevel = LOG_LEVELS[CONFIG.logLevel] !== undefined ? LOG_LEVELS[CONFIG.logLevel] : LOG_LEVELS.info;

function log(level, msg, extra) {
    if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] > logLevel) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
    if (level === 'error') console.error(line, extra || '');
    else console.log(line, extra || '');
}

// ─── API KEY ──────────────────────────────────────────────────────────────────
const FALLBACK_GEMINI_API_KEY = 'AQ.Ab8RN6Lko7qbW3cnw1R5dE4eJO9rz2Aek1x6jc-hNDm-WYKwiQ';
const GEMINI_KEY = process.env.GEMINI_API_KEY || FALLBACK_GEMINI_API_KEY;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
    server,
    maxPayload: CONFIG.maxWsMessageSize
});

const activeNodes = new Map();
const nodeLocations = new Map();
const lastSeen = new Map();

// ─── NODE CLASSIFICATION LOOKUPS ─────────────────────────────────────────────
const PC_NODES = new Set(['pc', 'laptop', 'desktop', 'lunapc']);
const ANDROID_NODES = new Set(['android', 'mobile', 'phone', 'lunaandroid']);
const KNOWN_NODES = ['luna_watch', 'lunapc', 'lunaandroid'];

function nodeIsActive(node) {
    const ws = activeNodes.get(node);
    return ws && ws.readyState === 1;
}

function reportedActiveNodes() {
    const nodes = [];
    const seen = new Set();
    for (const [id, ws] of activeNodes) {
        if (ws.readyState === 1) {
            nodes.push({ id, status: "online" });
            seen.add(id);
        }
    }
    for (const node of KNOWN_NODES) {
        if (!seen.has(node)) {
            nodes.push({ id: node, status: "offline" });
        }
    }
    return nodes;
}

const PC_CONTROL_KEYWORDS = [
    'pc', 'laptop', 'desktop', 'lunapc',
    'create file', 'save file', 'write file', 'make file',
    'file me', 'file mai', 'file par', 'file pe', 'file mein',
    'run script', 'open application', 'open app', 'execute',
    'download file', 'terminal', 'cmd', 'powershell',
    'save in pc', 'save to pc', 'pc me', 'pc mai', 'laptop me', 'laptop mai'
];

const ANDROID_CONTROL_KEYWORDS = [
    'android', 'phone', 'mobile', 'lunaandroid',
    'macrodroid', 'trigger macro', 'send sms', 'make call',
    'turn on bluetooth', 'turn off wifi', 'set alarm', 'android system',
    'phone me', 'phone mai', 'mobile me', 'mobile mai'
];

const REALTIME_KEYWORDS = [
    'news', 'latest', 'today', 'abhi', 'aaj', 'kal', 'kya hua', 'current', 'now',
    'weather', 'mausam', 'temperature', 'price', 'rate', 'score', 'result',
    'ipl', 'cricket', 'match', 'election', 'sarkar', 'stock', 'market',
    'trending', 'viral', 'breaking', 'update', 'live'
];

const NEWS_KEYWORDS = [
    'news', 'brief', 'khabar', 'samachar', 'headline', 'current affairs', 'day mai kya hua'
];

process.on('uncaughtException', (err) => log('error', 'UNCAUGHT EXCEPTION:', err.message));
process.on('unhandledRejection', (reason) => log('error', 'UNHANDLED REJECTION:', reason));

const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

let cachedUserProfile = process.env.USER_PROFILE || "User is Boss/Sir. Prefers polite and concise Hinglish responses and gender female.";
let serverStartTime = Date.now();
let totalAiCalls = 0;
let failedAiCalls = 0;

// ─── IN-MEMORY CONVERSATION HISTORY ───────────────────────────────────────────
const deviceHistory = new Map();

function recallMemory(senderId) {
    const history = deviceHistory.get(senderId) || [];
    if (history.length === 0) return "No previous context.";
    return history.slice(-6).map(h => `${h.role}: ${h.content}`).join("\n");
}

function saveToMemory(senderId, userPrompt, aiReply) {
    if (!senderId) return;
    if (!deviceHistory.has(senderId)) deviceHistory.set(senderId, []);
    const history = deviceHistory.get(senderId);
    history.push({ role: "User", content: (userPrompt || '').slice(0, 500) });
    history.push({ role: "Luna", content: (aiReply || '').slice(0, 500) });
    if (history.length > CONFIG.historyLimit) history.splice(0, history.length - CONFIG.historyLimit);
}

function trimStaleMemory() {
    const cutoff = Date.now() - CONFIG.heartbeatCleanupSec * 1000;
    for (const [id, ts] of lastSeen) {
        if (ts < cutoff) {
            deviceHistory.delete(id);
        }
    }
}

// ─── FREE WEB SEARCH ──────────────────────────────────────────────────────────
let dailyNewsCache = "";
let lastSearchAt = 0;

async function webSearch(query) {
    const now = Date.now();
    const sinceLast = now - lastSearchAt;
    if (sinceLast < 1000) await new Promise(r => setTimeout(r, 1000 - sinceLast));
    lastSearchAt = Date.now();

    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&skip_disambig=1&no_html=1`;
        const res = await fetch(url, { signal: AbortSignal.timeout(CONFIG.webTimeoutMs) });
        const data = await res.json();
        const parts = [
            data.Answer || '',
            data.AbstractText || '',
            ...(data.RelatedTopics || []).slice(0, 4).map(t => t.Text || t.Topics?.[0]?.Text || '').filter(Boolean)
        ].filter(Boolean);
        return parts.join(' | ').slice(0, 800) || '';
    } catch {
        return '';
    }
}

async function refreshDailyNews() {
    try {
        // Use specific, current search terms instead of generic show names
        const queries = [
            'breaking news India today headlines', 
            'latest international world news updates', 
            'current technology news headlines'
        ];
        const results = await Promise.all(queries.map(q => webSearch(q)));
        dailyNewsCache = results.filter(Boolean).join('\n').slice(0, 1200);
        log('info', `DAILY NEWS UPDATED: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
    } catch (err) {
        log('error', 'DAILY NEWS ERROR:', err.message);
    }
}

refreshDailyNews();
setInterval(refreshDailyNews, CONFIG.newsRefreshHours * 60 * 60 * 1000);
setInterval(trimStaleMemory, CONFIG.heartbeatCleanupSec * 1000).unref();

function cleanReply(text) {
    return text
        .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/[*#`~_>|\\]/g, '')
        .replace(/\/{2,}/g, '')
        .replace(/^\s*[-•]\s*/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const lastAiCallAt = new Map();
function checkAiRateLimit(senderId) {
    const last = lastAiCallAt.get(senderId) || 0;
    const now = Date.now();
    if (now - last < CONFIG.aiRateGapMs) return true;
    lastAiCallAt.set(senderId, now);
    return false;
}

function uptimeSeconds() {
    return Math.floor((Date.now() - serverStartTime) / 1000);
}

app.get('/', (_, res) => {
    res.status(200).json({
        status: "online",
        server_node: "luna_server",
        active_nodes: reportedActiveNodes(),
        uptime_seconds: uptimeSeconds()
    });
});

app.get('/health', (_, res) => {
    const mem = process.memoryUsage();
    res.status(200).json({
        status: "ok",
        uptime_seconds: uptimeSeconds(),
        active_connections: activeNodes.size,
        max_connections: CONFIG.maxConnections,
        nodes: reportedActiveNodes(),
        memory_mb: {
            rss: +(mem.rss / 1048576).toFixed(1),
            heap_used: +(mem.heapUsed / 1048576).toFixed(1),
            heap_total: +(mem.heapTotal / 1048576).toFixed(1)
        },
        ai: {
            model: CONFIG.aiModel,
            total_calls: totalAiCalls,
            failed_calls: failedAiCalls
        },
        history_entries: deviceHistory.size
    });
});

function getOnlineNode(targetSet) {
    for (const node of targetSet) {
        if (nodeIsActive(node)) return node;
    }
    return null;
}

async function generateAiReply(userPrompt, systemInstruction) {
    totalAiCalls++;
    const call = () => ai.models.generateContent({
        model: CONFIG.aiModel,
        contents: userPrompt,
        config: { systemInstruction }
    });

    let response;
    try {
        response = await Promise.race([
            call(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), CONFIG.aiTimeoutMs))
        ]);
    } catch (aiErr) {
        if (aiErr.status === 429 || aiErr.message?.includes('429') || aiErr.message?.includes('RESOURCE_EXHAUSTED')) {
            log('warn', 'AI 429 RATE LIMIT, retrying after 2s');
            await new Promise(r => setTimeout(r, 2000));
            response = await Promise.race([
                call(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), CONFIG.aiTimeoutMs))
            ]);
        } else {
            failedAiCalls++;
            throw aiErr;
        }
    }
    return cleanReply(response.text || "Boss, reply generate nahi ho paya. Kripya firse boliye.");
}

// ─── WEBSOCKET SERVER ──────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
    if (activeNodes.size >= CONFIG.maxConnections) {
        log('warn', 'CONNECTION LIMIT REACHED, rejecting');
        ws.send(JSON.stringify({ sender_id: "luna_server", status: "error", message: "Server connection limit reached." }));
        ws.close(1013, 'try_again_later');
        return;
    }

    const pathname = req.url ? req.url.split('?')[0] : '';
    const parts = pathname.split('/').filter(Boolean);
    const deviceId = (parts.length > 0 ? parts[parts.length - 1] : 'unknown').toLowerCase();
    let registeredId = deviceId;
    activeNodes.set(registeredId, ws);
    lastSeen.set(registeredId, Date.now());
    log('info', `CONNECTED: ${registeredId}`);

    ws._missedPings = 0;
    ws.on('pong', () => { ws._missedPings = 0; });

    ws.on('message', async (rawMsg) => {
        ws._missedPings = 0;
        lastSeen.set(registeredId, Date.now());

        const strMsg = rawMsg ? rawMsg.toString().trim() : '';
        if (!strMsg) return;
        if (strMsg.length > CONFIG.maxWsMessageSize) {
            ws.send(JSON.stringify({ sender_id: "luna_server", target_node: registeredId, status: "error", message: "Message too large." }));
            return;
        }

        // FIX 1: Safe payload parsing with string fallback
        let data;
        try {
            data = JSON.parse(strMsg);
        } catch {
            // Converts unquoted literal strings (e.g. "hi") safely without throwing Unexpected Token error
            data = { prompt: strMsg, target_node: "luna_server" };
        }

        const targetNode = (data.target_node || "luna_server").toLowerCase();
        const senderId = (data.sender_id || registeredId).toLowerCase();

        // Re-register device under its real sender_id if different
        if (senderId && senderId !== 'unknown' && registeredId !== senderId) {
            activeNodes.delete(registeredId);
            nodeLocations.delete(registeredId);
            registeredId = senderId;
            activeNodes.set(registeredId, ws);
        }

        // Cache coordinates if provided
        if (data.coords || (data.lat && data.lon)) {
            nodeLocations.set(registeredId, data.coords || { lat: data.lat, lon: data.lon });
        }

        // ── FIX 2: DIRECT LUNA SERVER PROCESSING ────────────────────────────
        if (targetNode === "luna_server" || targetNode === "server") {
            const userPrompt = data.prompt || data.message || data.action_prompt || "";
            if (!userPrompt) return;

            const senderLocation = nodeLocations.get(senderId) || nodeLocations.get('lunaandroid') || "Unknown Location";
            const promptLower = userPrompt.toLowerCase();

            const requiresPcSystem = PC_CONTROL_KEYWORDS.some(kw => promptLower.includes(kw));
            const requiresAndroidSystem = ANDROID_CONTROL_KEYWORDS.some(kw => promptLower.includes(kw));

            let targetActionNode = null;
            let systemNotice = "";

            if (requiresPcSystem) {
                const activePcNode = getOnlineNode(PC_NODES);
                if (activePcNode) {
                    targetActionNode = activePcNode;
                } else {
                    systemNotice = "CRITICAL: Luna PC (lunapc) is currently DISCONNECTED/OFFLINE. Do NOT pretend or claim that you saved any file to PC. State clearly to the user that PC is offline and file cannot be saved right now.";
                }
            } else if (requiresAndroidSystem) {
                const activeAndroidNode = getOnlineNode(ANDROID_NODES);
                if (activeAndroidNode) {
                    targetActionNode = activeAndroidNode;
                } else {
                    systemNotice = "CRITICAL: Luna Android is currently DISCONNECTED/OFFLINE. Do NOT claim that macro or command was executed on mobile.";
                }
            }

            const pastContext = recallMemory(senderId);

            const needsWebSearch = REALTIME_KEYWORDS.some(kw => promptLower.includes(kw));
            let webContext = "";
            if (needsWebSearch) {
                webContext = await webSearch(userPrompt);
                log('debug', `WEB SEARCH: "${userPrompt}" -> ${webContext ? 'results found' : 'no results'}`);
            }

            const needsNews = NEWS_KEYWORDS.some(kw => promptLower.includes(kw)) || needsWebSearch;
            const currentDateTime = new Date().toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
                dateStyle: "full",
                timeStyle: "medium"
            });

            const systemInstruction = `You are Luna, a female 24/7 intelligent multi-device voice assistant.

CURRENT STATE:
- Current Live Date & Time (IST): ${currentDateTime}
- Requesting Device: ${senderId}
- Current Coordinates/Location: ${JSON.stringify(senderLocation)}
- Target Node Auto-Detection: ${targetActionNode ? `Forwarding task to '${targetActionNode}'` : "Handled directly by Luna Server"}
- Node Status Notice: ${systemNotice || "All system target nodes checked and verified."}
- Profile: ${cachedUserProfile}
${webContext ? `\nLIVE WEB SEARCH RESULTS (use for answering):\n${webContext}` : ''}
${needsNews && dailyNewsCache ? `\nDAILY NEWS BRIEFING (auto-refreshed every 24h):\n${dailyNewsCache}` : ''}

DEVICE CAPABILITIES:
- luna_watch (Smartwatch): Voice output ONLY. No file system, no system access. Never suggest saving on watch.
- lunapc (PC): Can save files, run scripts, open apps.
- lunaandroid (Android Phone): Can trigger macros, send SMS, control phone settings.

DECISION & RESPONSE RULES:
1. DIRECT ANSWER: Answer information queries (search, time, weather, nearby places) concisely. Use LIVE WEB SEARCH RESULTS if provided.
2. HYBRID TASK: If user wants to search AND save (e.g. nearby cafe list pc mai save karo), provide the answer AND confirm it is forwarded to PC or Android. Never offer to save on Watch.
3. OFFLINE DEVICE: If target device is offline, tell user clearly that the device is offline and file cannot be saved/action cannot be performed right now, but still answer the query part.
4. PLAIN TEXT ONLY: No emojis, no markdown (no *, **, #, -, backtick), no bullet points. Clean spoken text only for Smartwatch speaker.
5. Concise Hinglish/Hindi/English mix. Address user as Boss or Sir. You are female.
6. Conversation History:
${pastContext}`;

            if (checkAiRateLimit(senderId)) {
                ws.send(JSON.stringify({
                    sender_id: "luna_server",
                    target_node: senderId,
                    status: "busy",
                    response: "Boss, thoda ruk ke boliye — pehla sawaal process ho raha hai."
                }));
                return;
            }

            let aiReply = "";
            try {
                aiReply = await generateAiReply(userPrompt, systemInstruction);
            } catch (aiErr) {
                log('error', 'AI GENERATION ERROR:', aiErr.message);
                aiReply = aiErr.message === 'AI_TIMEOUT'
                    ? "Boss, AI response ka timeout ho gaya. Thodi der baad try kijiye."
                    : "Boss, request error aaya. Thodi der baad try kijiye.";
            }

            // Forward task payload to PC or Android if detected and online
            if (targetActionNode && activeNodes.has(targetActionNode)) {
                activeNodes.get(targetActionNode).send(JSON.stringify({
                    sender_id: "luna_server",
                    target_node: targetActionNode,
                    action_prompt: userPrompt,
                    ai_response: aiReply,
                    coords: senderLocation
                }));
            }

            // Return text/voice response to the originating client
            ws.send(JSON.stringify({
                sender_id: "luna_server",
                target_node: senderId,
                status: "success",
                response: aiReply,
                executing_node: targetActionNode || "luna_server"
            }));

            saveToMemory(senderId, userPrompt, aiReply);
        }
        // ── PEER-TO-PEER PASS-THROUGH ROUTING ────────────────────────────
        else if (activeNodes.has(targetNode)) {
            const targetWs = activeNodes.get(targetNode);
            if (targetWs && targetWs.readyState === 1) targetWs.send(rawMsg);
        }
        // ── TARGET NODE OFFLINE ───────────────────────────────────────────
        else {
            ws.send(JSON.stringify({
                sender_id: "luna_server",
                target_node: senderId,
                status: "error",
                message: `Target node '${targetNode}' offline hai.`
            }));
        }
    });

    ws.on('close', () => {
        activeNodes.delete(registeredId);
        nodeLocations.delete(registeredId);
        lastSeen.delete(registeredId);
        log('info', `DISCONNECTED: ${registeredId}`);
    });

    ws.on('error', () => {
        activeNodes.delete(registeredId);
        nodeLocations.delete(registeredId);
        lastSeen.delete(registeredId);
    });
});

const keepAlive = setInterval(() => {
    wss.clients.forEach((ws) => {
        ws._missedPings = (ws._missedPings || 0) + 1;
        if (ws._missedPings > 2) {
            log('warn', 'KEEPALIVE: dropping unresponsive connection');
            ws.terminate();
            return;
        }
        try { ws.ping(); } catch (_) { }
    });
}, CONFIG.pingIntervalSec * 1000);
keepAlive.unref();

function shutdown(signal) {
    log('info', `Received ${signal}. Shutting down gracefully...`);
    clearInterval(keepAlive);
    wss.clients.forEach((ws) => {
        try { ws.close(1001, 'server_shutting_down'); } catch (_) { }
    });
    server.close(() => {
        log('info', 'All connections closed. Bye.');
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(CONFIG.port, '0.0.0.0', () => log('info', `LUNA_SERVER ONLINE: Listening on port ${CONFIG.port} (max ${CONFIG.maxConnections} connections)`));
