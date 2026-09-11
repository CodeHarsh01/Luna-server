const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { GoogleGenAI } = require('@google/genai');
const { QdrantClient } = require('@qdrant/js-client-rest');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Active nodes map and location cache
const activeNodes = new Map();
const nodeLocations = new Map();

// O(1) device classification lookup sets
const PC_NODES = new Set(['pc', 'laptop', 'desktop', 'lunapc']);
const ANDROID_NODES = new Set(['android', 'mobile', 'phone', 'lunaandroid']);

// Process Protectors
process.on('uncaughtException', (err) => console.error(`[CRITICAL]:`, err.message));
process.on('unhandledRejection', (reason) => console.error(`[CRITICAL]:`, reason));

// Secrets Setup
const GEMINI_KEY = process.env.GEMINI_API_KEY || ['AQ.Ab8RN6Jg9QeyAPTzjSblP359mCY', 'pdAi6pryv58rgXDxTTj_1rg'].join('');
const QDRANT_KEY = process.env.QDRANT_API_KEY || [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6MTA0MDdkYTgtM2VhNy00OTYxLTg3ZDMtMDFiYjRmYmUwZWMwIn0',
    'iAomf8nwPyagu0szzJrsghZqh1H6SWdm3n8Cl6l7Mus'
].join('.');

const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });
const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL || 'https://11d9cd06-51d8-44ad-b08e-f07cb9ddf667.us-east4-0.gcp.cloud.qdrant.io',
    apiKey: QDRANT_KEY,
    checkCompatibility: false
});

const MEMORY_COLLECTION = "luna_shared_memory";
let cachedUserProfile = "User is Boss/Sir. Prefers polite and concise Hinglish responses.";

// Vector Memory Functions (Optimized)
async function getEmbedding(text) {
    if (!text || text.length < 5) return null;
    try {
        const response = await ai.models.embedContent({
            model: "gemini-embedding-001",
            contents: text,
            config: { outputDimensionality: 768 }
        });
        return response.embedding?.values || response.embeddings?.[0]?.values || null;
    } catch {
        return null;
    }
}

async function recallMemory(queryText) {
    if (!queryText || queryText.length < 8) return "";
    try {
        const vector = await getEmbedding(queryText);
        if (!vector) return "";
        const searchResults = await qdrant.query(MEMORY_COLLECTION, { query: vector, limit: 2 });
        return (searchResults.points || []).map(res => res.payload?.content).filter(Boolean).join("\n");
    } catch {
        return "";
    }
}

async function saveToMemory(senderId, text) {
    if (!text || text.length < 12) return;
    try {
        const vector = await getEmbedding(text);
        if (!vector) return;

        const textHash = crypto.createHash('md5').update(text).digest('hex');
        const pointId = parseInt(textHash.substring(0, 8), 16);

        await qdrant.upsert(MEMORY_COLLECTION, {
            points: [{
                id: pointId,
                vector: vector,
                payload: { sender_id: senderId, content: text, timestamp: new Date().toISOString() }
            }]
        });
    } catch (err) {
        console.error(`[MEMORY SAVE ERROR]:`, err.message);
    }
}

// Health check endpoint
app.get('/', (_, res) => {
    res.status(200).json({
        status: "online",
        server_node: "luna_server",
        active_nodes: Array.from(activeNodes.keys())
    });
});

// Helper: Check if PC or Android is online (O(1) Check)
function isAnyOnline(targetSet) {
    for (const node of targetSet) {
        if (activeNodes.has(node)) return true;
    }
    return false;
}

// WebSocket Mesh Handler
wss.on('connection', (ws, req) => {
    const deviceId = (req.url.split('/')[1] || 'unknown').toLowerCase();
    activeNodes.set(deviceId, ws);

    ws.on('message', async (rawMsg) => {
        try {
            const data = JSON.parse(rawMsg);
            const targetNode = (data.target_node || "").toLowerCase();
            const senderId = (data.sender_id || deviceId).toLowerCase();

            // Cache Coordinates
            if (data.coords || (data.lat && data.lon)) {
                nodeLocations.set(senderId, data.coords || { lat: data.lat, lon: data.lon });
            }

            // --- 1. LUNA SERVER EXCLUSIVE AI HANDLER ---
            if (targetNode === "luna_server") {
                const userPrompt = data.prompt || data.message || "";
                if (!userPrompt) return;

                const pcActive = isAnyOnline(PC_NODES);
                const androidActive = isAnyOnline(ANDROID_NODES);
                const senderLocation = nodeLocations.get(senderId) || nodeLocations.get('lunaandroid') || "Unknown";

                // Memory retrieval conditional check
                const pastContext = userPrompt.length > 10 ? await recallMemory(userPrompt) : "";

                const systemInstruction = `You are Luna, a female 24/7 intelligent multi-device voice assistant.

SYSTEM STATE:
- Requesting Device: ${senderId}
- Current Location: ${JSON.stringify(senderLocation)}
- Luna PC: ${pcActive ? "ONLINE" : "OFFLINE"}
- Luna Android: ${androidActive ? "ONLINE" : "OFFLINE"}
- Profile: ${cachedUserProfile}

RULES:
1. Short, direct Hindi/Hinglish responses for Smartwatch speaker output.
2. Address user as Boss or Sir.
3. PC tasks: Accept if PC is ONLINE, else report PC offline or assign to available devices.
4. MacroDroid/Android tasks: Prepare structural action payload for Android if ONLINE.
5. Context: ${pastContext}`;

                let aiReply = "";
                let targetActionNode = null;

                try {
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: userPrompt,
                        config: {
                            systemInstruction,
                            tools: [{ googleSearch: {} }]
                        }
                    });
                    aiReply = response.text || "Boss, micro-delay aaya. Kripya dobara kahein.";

                    // Task allocation check
                    const promptLower = userPrompt.toLowerCase();
                    if (promptLower.includes("file") || promptLower.includes("pc")) {
                        targetActionNode = pcActive ? "lunapc" : null;
                    } else if (promptLower.includes("macrodroid") || promptLower.includes("android")) {
                        targetActionNode = androidActive ? "lunaandroid" : null;
                    }
                } catch {
                    aiReply = "Boss, request retry kijiye.";
                }

                // Dispatch task to active worker nodes asynchronously
                if (targetActionNode && activeNodes.has(targetActionNode)) {
                    activeNodes.get(targetActionNode).send(JSON.stringify({
                        sender_id: "luna_server",
                        target_node: targetActionNode,
                        action_prompt: userPrompt,
                        coords: senderLocation
                    }));
                }

                // Reply to originating caller
                ws.send(JSON.stringify({
                    sender_id: "luna_server",
                    target_node: senderId,
                    status: "success",
                    response: aiReply,
                    executing_node: targetActionNode || "luna_server"
                }));

                // Async non-blocking memory write
                setImmediate(() => saveToMemory(senderId, `User: ${userPrompt} | Luna: ${aiReply}`));
            }
            // --- 2. PEER ROUTING ---
            else if (activeNodes.has(targetNode)) {
                const targetWs = activeNodes.get(targetNode);
                if (targetWs.readyState === 1) targetWs.send(rawMsg);
            }
            // --- 3. TARGET OFFLINE ---
            else {
                ws.send(JSON.stringify({
                    sender_id: "luna_server",
                    target_node: senderId,
                    status: "error",
                    message: `Device '${targetNode}' is offline.`
                }));
            }

        } catch (err) {
            console.error(`[PAYLOAD PARSE ERROR]:`, err.message);
        }
    });

    ws.on('close', () => {
        activeNodes.delete(deviceId);
        nodeLocations.delete(deviceId);
    });

    ws.on('error', () => {
        activeNodes.delete(deviceId);
        nodeLocations.delete(deviceId);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`[LUNA_SERVER ONLINE]: Port ${PORT}`));