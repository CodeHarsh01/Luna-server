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

const activeNodes = new Map();
const nodeLocations = new Map();

// Node classification lookups
const PC_NODES = new Set(['pc', 'laptop', 'desktop', 'lunapc']);
const ANDROID_NODES = new Set(['android', 'mobile', 'phone', 'lunaandroid']);

// Keywords that EXPLICITLY mandate system execution
const PC_CONTROL_KEYWORDS = ['create file', 'save file', 'write file', 'run script', 'open application', 'open app', 'execute', 'download file', 'terminal', 'cmd'];
const ANDROID_CONTROL_KEYWORDS = ['macrodroid', 'trigger macro', 'send sms', 'make call', 'turn on bluetooth', 'turn off wifi', 'set alarm', 'android system'];

process.on('uncaughtException', (err) => console.error(`[CRITICAL]:`, err.message));
process.on('unhandledRejection', (reason) => console.error(`[CRITICAL]:`, reason));

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

app.get('/', (_, res) => {
    res.status(200).json({
        status: "online",
        server_node: "luna_server",
        active_nodes: Array.from(activeNodes.keys())
    });
});

function isAnyOnline(targetSet) {
    for (const node of targetSet) {
        if (activeNodes.has(node)) return true;
    }
    return false;
}

wss.on('connection', (ws, req) => {
    const deviceId = (req.url.split('/')[1] || 'unknown').toLowerCase();
    activeNodes.set(deviceId, ws);

    ws.on('message', async (rawMsg) => {
        try {
            const data = JSON.parse(rawMsg);
            const targetNode = (data.target_node || "").toLowerCase();
            const senderId = (data.sender_id || deviceId).toLowerCase();

            if (data.coords || (data.lat && data.lon)) {
                nodeLocations.set(senderId, data.coords || { lat: data.lat, lon: data.lon });
            }

            // --- LUNA_SERVER EXCLUSIVE AI & TASK ROUTER ---
            if (targetNode === "luna_server") {
                const userPrompt = data.prompt || data.message || "";
                if (!userPrompt) return;

                const pcActive = isAnyOnline(PC_NODES);
                const androidActive = isAnyOnline(ANDROID_NODES);
                const senderLocation = nodeLocations.get(senderId) || nodeLocations.get('lunaandroid') || "Unknown Location";

                const promptLower = userPrompt.toLowerCase();

                // Check if user explicitly asked for system-level execution
                const requiresPcSystem = PC_CONTROL_KEYWORDS.some(kw => promptLower.includes(kw));
                const requiresAndroidSystem = ANDROID_CONTROL_KEYWORDS.some(kw => promptLower.includes(kw));

                let targetActionNode = null;
                let systemNotice = "";

                if (requiresPcSystem) {
                    if (pcActive) {
                        targetActionNode = "lunapc";
                    } else {
                        systemNotice = "Luna PC is currently OFFLINE. I cannot modify files or access the PC file system right now.";
                    }
                } else if (requiresAndroidSystem) {
                    if (androidActive) {
                        targetActionNode = "lunaandroid";
                    } else {
                        systemNotice = "Luna Android is currently OFFLINE. I cannot trigger phone macros or system settings right now.";
                    }
                }

                // Memory context retrieval
                const pastContext = userPrompt.length > 10 ? await recallMemory(userPrompt) : "";

                const systemInstruction = `You are Luna, a female 24/7 intelligent multi-device voice assistant.

CURRENT STATE:
- Requesting Device: ${senderId}
- Current Coordinates/Location: ${JSON.stringify(senderLocation)}
- Node Status Notice: ${systemNotice || "All direct knowledge/search tasks are handled by Luna Server directly."}
- Profile: ${cachedUserProfile}

DECISION & RESPONSE RULES:
1. DIRECT ANSWER RULE: If the request is information-based (nearby places, search, web research, general queries), answer directly using your knowledge/search tools. DO NOT request system access.
2. SYSTEM ACCESS RULE: Only acknowledge file or device tasks if explicitly requested by the user.
3. Keep responses concise, direct, and conversational (Hinglish/Hindi/English mix) suitable for voice readout on Smartwatch speakers.
4. Address the user as Boss or Sir and you are female.
5. Saved Context: ${pastContext}`;

                let aiReply = "";

                try {
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: userPrompt,
                        config: {
                            systemInstruction,
                            tools: [{ googleSearch: {} }]
                        }
                    });
                    aiReply = response.text || "Boss, reply generate nahi ho paya. Kripya firse boliye.";
                } catch {
                    aiReply = "Boss, request error aaya. Thodi der baad try kijiye.";
                }

                // Send control payload ONLY if physical OS execution was explicitly requested AND node is online
                if (targetActionNode && activeNodes.has(targetActionNode)) {
                    activeNodes.get(targetActionNode).send(JSON.stringify({
                        sender_id: "luna_server",
                        target_node: targetActionNode,
                        action_prompt: userPrompt,
                        coords: senderLocation
                    }));
                }

                // Send voice answer back to caller (Smartwatch, Android, or PC client)
                ws.send(JSON.stringify({
                    sender_id: "luna_server",
                    target_node: senderId,
                    status: "success",
                    response: aiReply,
                    executing_node: targetActionNode || "luna_server"
                }));

                // Save conversation history asynchronously
                setImmediate(() => saveToMemory(senderId, `User: ${userPrompt} | Luna: ${aiReply}`));
            }
            // --- PEER TO PEER PASS-THROUGH ROUTING ---
            else if (activeNodes.has(targetNode)) {
                const targetWs = activeNodes.get(targetNode);
                if (targetWs.readyState === 1) targetWs.send(rawMsg);
            }
            // --- TARGET NODE OFFLINE ---
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
server.listen(PORT, '0.0.0.0', () => console.log(`[LUNA_SERVER ONLINE]: Listening on port ${PORT}`));