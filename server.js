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

// --- AUTO-HEALING ENGINE (GLOBAL PROCESS PROTECTORS) ---
process.on('uncaughtException', (err) => {
    console.error(`[AUTO-HEAL]: Caught Uncaught Exception:`, err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[AUTO-HEAL]: Unhandled Rejection at:`, promise, `reason:`, reason);
});

// 1. Initialize Clients
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || 'AQ.Ab8RN6Jg9QeyAPTzjSblP359mCYpdAi6pryv58rgXDxTTj_1rg'
});

const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL || 'https://11d9cd06-51d8-44ad-b08e-f07cb9ddf667.us-east4-0.gcp.cloud.qdrant.io',
    apiKey: process.env.QDRANT_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6MTA0MDdkYTgtM2VhNy00OTYxLTg3ZDMtMDFiYjRmYmUwZWMwIn0.iAomf8nwPyagu0szzJrsghZqh1H6SWdm3n8Cl6l7Mus',
    checkCompatibility: false
});

const MEMORY_COLLECTION = "luna_shared_memory";
let cachedUserProfile = "User is Boss/Sir. Prefers polite and concise Hinglish responses.";

// Initialize Qdrant Collection with Retry Logic
async function initQdrant(retries = 3) {
    try {
        const collections = await qdrant.getCollections();
        const exists = collections.collections?.some(c => c.name === MEMORY_COLLECTION);

        if (!exists) {
            await qdrant.createCollection(MEMORY_COLLECTION, {
                vectors: { size: 768, distance: "Cosine" }
            });
            console.log(`[QDRANT]: Collection '${MEMORY_COLLECTION}' created successfully.`);
        } else {
            console.log(`[QDRANT]: Connected successfully. Collection '${MEMORY_COLLECTION}' ready.`);
        }
    } catch (err) {
        console.error(`[QDRANT INIT ERROR]:`, err.message);
        if (retries > 0) {
            console.log(`[AUTO-HEAL]: Retrying Qdrant connection in 5s... (${retries} retries left)`);
            setTimeout(() => initQdrant(retries - 1), 5000);
        }
    }
}
initQdrant();

// Helper: Vector Embedding via Gemini (Using gemini-embedding-001)
async function getEmbedding(text) {
    if (!text || text.trim().length < 4) return new Array(768).fill(0); // Quota Optimization
    try {
        const response = await ai.models.embedContent({
            model: "gemini-embedding-001",
            contents: text,
            config: { outputDimensionality: 768 }
        });
        return response.embedding?.values || response.embeddings?.[0]?.values || new Array(768).fill(0);
    } catch (err) {
        console.error(`[EMBEDDING ERROR]:`, err.message);
        return new Array(768).fill(0);
    }
}

// Helper: Save Memory with Deduplication Filter & Fallback
async function saveToMemory(senderId, text) {
    if (!text || text.trim().length < 8) return; // Skip saving short/generic text
    try {
        const textHash = crypto.createHash('md5').update(text.trim().toLowerCase()).digest('hex');
        const vector = await getEmbedding(text);

        // Skip Qdrant upsert if vector generation failed
        if (vector.every(v => v === 0)) return;

        // Deduplication Check via Similarity Search
        const searchResults = await qdrant.query(MEMORY_COLLECTION, {
            query: vector,
            limit: 1
        });

        const points = searchResults.points || [];
        if (points.length > 0 && points[0].score >= 0.92) {
            console.log(`[MEMORY DUP SKIPPED]: Similar memory already exists (Score: ${points[0].score.toFixed(2)})`);
            return;
        }

        const pointId = parseInt(textHash.substring(0, 8), 16);

        await qdrant.upsert(MEMORY_COLLECTION, {
            points: [{
                id: pointId,
                vector: vector,
                payload: {
                    sender_id: senderId,
                    content: text,
                    hash: textHash,
                    timestamp: new Date().toISOString()
                }
            }]
        });
        console.log(`[MEMORY SAVED]: From '${senderId}' (Unique)`);
    } catch (err) {
        console.error(`[MEMORY SAVE ERROR]:`, err.message);
    }
}

// Helper: Recall Relevant Context
async function recallMemory(queryText) {
    if (!queryText || queryText.trim().length < 4) return "";
    try {
        const vector = await getEmbedding(queryText);

        if (vector.every(v => v === 0)) return "";

        const searchResults = await qdrant.query(MEMORY_COLLECTION, {
            query: vector,
            limit: 3
        });
        const points = searchResults.points || [];
        return points
            .map(res => res.payload?.content)
            .filter(Boolean)
            .join("\n");
    } catch (err) {
        console.error(`[MEMORY RECALL ERROR]:`, err.message);
        return "";
    }
}

// Background Self-Training Engine (Updated model to gemini-2.5-flash)
async function selfTrainLuna() {
    try {
        console.log(`[SELF-TRAIN]: Starting memory consolaidation process...`);
        const searchResults = await qdrant.scroll(MEMORY_COLLECTION, { limit: 20 });

        if (!searchResults.points || searchResults.points.length === 0) return;

        const memoryDump = searchResults.points.map(p => p.payload?.content).filter(Boolean).join("\n");

        const summaryResponse = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: `Analyze these conversation logs and extract a concise profile/summary about Boss/Sir (preferences, work habits, key instructions). Keep it under 100 words:\n${memoryDump}`
        });

        if (summaryResponse.text) {
            cachedUserProfile = summaryResponse.text.trim();
            console.log(`[SELF-TRAIN SUCCESS]: Profile Updated -> ${cachedUserProfile}`);
        }
    } catch (err) {
        console.error(`[SELF-TRAIN ERROR]:`, err.message);
    }
}

// Run Self-Training every 6 hours
setInterval(selfTrainLuna, 6 * 60 * 60 * 1000);

// Railway Health Check Endpoint
app.get('/', (req, res) => {
    res.status(200).json({
        status: "online",
        system: "Luna Mesh Router + Gemini + Qdrant (Auto-Healed & Optimized)",
        active_nodes: Array.from(activeNodes.keys()),
        cached_profile: cachedUserProfile
    });
});

// WebSocket Server Handler
wss.on('connection', (ws, req) => {
    const urlParts = req.url.split('/');
    const deviceId = urlParts[2] || urlParts[1] || 'unknown';

    activeNodes.set(deviceId, ws);
    console.log(`[CONNECTED]: Device ID -> ${deviceId}`);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            const targetNode = data.target_node;
            const senderId = data.sender_id || deviceId;

            console.log(`[ROUTE]: ${senderId} -> ${targetNode}`);

            if (activeNodes.has(targetNode)) {
                const targetWs = activeNodes.get(targetNode);
                if (targetWs.readyState === 1) {
                    targetWs.send(JSON.stringify(data));
                }
            }
            else if (targetNode === "luna_server" || targetNode === "server") {
                const userPrompt = data.prompt || data.message || "";

                const currentDateTime = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

                const pcNodeKeys = ['pc', 'laptop', 'heavy_laptop', 'desktop'];
                const isPcConnected = pcNodeKeys.some(key => activeNodes.has(key));
                const pcStatusText = isPcConnected
                    ? "ONLINE (PC is active and ready to perform commands)."
                    : "OFFLINE (PC is off or disconnected. Politely refuse PC tasks).";

                const pastContext = userPrompt.trim().length >= 4 ? await recallMemory(userPrompt) : "";

                const systemInstruction = `You are Luna, a female 24/7 intelligent voice assistant. 

IMPORTANT SYSTEM CONTEXT:
- Current Date and Time: ${currentDateTime} (IST)
- User's PC Status: ${pcStatusText}
- Core Trained Knowledge: ${cachedUserProfile}

RESPONSE GUIDELINES:
1. Reply in clear, casual Hindi or Hinglish.
2. Address the user respectfully as "Boss" or "Sir" dont use both in one message , maintaining a friendly, polite tone.
3. Keep answers concise, direct, and short for smartwatch speaker playback.
4. PC TASKS: Accept if PC is ONLINE; refuse if PC is OFFLINE.
5. Contextual Memory:\n${pastContext}`;

                let aiReply = "";

                try {
                    const response = await ai.models.generateContent({
                        model: 'gemini-3.1-flash-lite',
                        contents: userPrompt,
                        config: {
                            systemInstruction,
                            tools: [{ googleSearch: {} }]
                        }
                    });
                    aiReply = response.text || "Sorry Boss, micro-delay aaya. Kripya dubara boliye.";
                } catch (genErr) {
                    if (genErr.status === 429 || genErr.message?.includes('429') || genErr.message?.includes('RESOURCE_EXHAUSTED')) {
                        console.error(`[QUOTA EXHAUSTED]: Gemini API rate limit hit.`);
                        aiReply = "Boss, API ki per-minute limit exhaust ho gayi hai. Kripya thoda wait karke dubara boliye.";
                    } else {
                        console.error(`[GENERATION ERROR]:`, genErr.message);
                        aiReply = "Sorry Boss, micro-delay aaya. Kripya dubara boliye.";
                    }
                }

                // Non-blocking memory save
                saveToMemory(senderId, `User (${senderId}): ${userPrompt} | Luna: ${aiReply}`);

                ws.send(JSON.stringify({
                    sender_id: "luna_server",
                    target_node: senderId,
                    status: "success",
                    response: aiReply
                }));
            }
            else {
                ws.send(JSON.stringify({
                    sender_id: "server",
                    target_node: senderId,
                    status: "error",
                    message: `Target node '${targetNode}' is offline.`
                }));
            }
        } catch (err) {
            console.error(`[PAYLOAD ERROR]:`, err.message);
            try {
                ws.send(JSON.stringify({
                    sender_id: "server",
                    target_node: deviceId,
                    status: "error",
                    message: "Internal processing recovered gracefully."
                }));
            } catch (_) { }
        }
    });

    ws.on('close', () => {
        activeNodes.delete(deviceId);
        console.log(`[DISCONNECTED]: Device ID -> ${deviceId}`);
    });

    ws.on('error', (err) => {
        activeNodes.delete(deviceId);
        console.error(`[NODE ERROR]:`, err.message);
    });
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER RUNNING]: Listening on port ${PORT}`);
});