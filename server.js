const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { GoogleGenAI } = require('@google/genai');
const { QdrantClient } = require('@qdrant/js-client-rest');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const activeNodes = new Map();

// 1. Initialize Clients (Set environment variables on Railway)
const ai = new GoogleGenAI({ apiKey: 'AQ.Ab8RN6Jg9QeyAPTzjSblP359mCYpdAi6pryv58rgXDxTTj_1rg' });
const qdrant = new QdrantClient({
    url: 'https://11d9cd06-51d8-44ad-b08e-f07cb9ddf667.us-east4-0.gcp.cloud.qdrant.io',
    apiKey: process.env.QDRANT_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6OTczZTc1NDgtMGM4Ni00OTBlLTliMGItZWQ4NDYwZWU2YWRhIn0.tgRnfChr3C5BAHZCFLxTlxrkwy449TG70xGviT_FRPQ'
});

const MEMORY_COLLECTION = "luna_shared_memory";

// Initialize Qdrant Collection on Startup
async function initQdrant() {
    try {
        const collections = await qdrant.getCollections();
        const exists = collections.collections.some(c => c.name === MEMORY_COLLECTION);

        if (!exists) {
            await qdrant.createCollection(MEMORY_COLLECTION, {
                vectors: { size: 768, distance: "Cosine" } // 768 size for text-embedding-004
            });
            console.log(`[QDRANT]: Collection '${MEMORY_COLLECTION}' created successfully.`);
        }
    } catch (err) {
        console.error(`[QDRANT INIT ERROR]:`, err.message);
    }
}
initQdrant();

// Helper: Vector Embedding Helper via Gemini
async function getEmbedding(text) {
    const response = await ai.models.embedContent({
        model: "text-embedding-004",
        contents: text
    });
    return response.embedding.values;
}

// Helper: Save Context to Qdrant Shared Memory
async function saveToMemory(senderId, text) {
    try {
        const vector = await getEmbedding(text);
        await qdrant.upsert(MEMORY_COLLECTION, {
            points: [{
                id: Date.now(), // Unique Timestamp ID
                vector: vector,
                payload: {
                    sender_id: senderId,
                    content: text,
                    timestamp: new Date().toISOString()
                }
            }]
        });
        console.log(`[MEMORY SAVED]: From '${senderId}'`);
    } catch (err) {
        console.error(`[MEMORY SAVE ERROR]:`, err.message);
    }
}

// Helper: Recall Relevant Context from Qdrant Memory
async function recallMemory(queryText) {
    try {
        const vector = await getEmbedding(queryText);
        const searchResults = await qdrant.search(MEMORY_COLLECTION, {
            vector: vector,
            limit: 3 // Fetch top 3 relevant memories
        });
        return searchResults.map(res => res.payload.content).join("\n");
    } catch (err) {
        console.error(`[MEMORY RECALL ERROR]:`, err.message);
        return "";
    }
}

// Railway Health Check Endpoint
app.get('/', (req, res) => {
    res.status(200).json({
        status: "online",
        system: "Luna Mesh Router + Gemini + Qdrant (Node.js)",
        active_nodes: Array.from(activeNodes.keys())
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

            // Direct Route to another active node (Watch -> Phone / Laptop -> Watch)
            if (activeNodes.has(targetNode)) {
                const targetWs = activeNodes.get(targetNode);
                if (targetWs.readyState === 1) {
                    targetWs.send(JSON.stringify(data));
                }
            }
            // Handle AI Request directly on Server (e.g. target_node = "luna_ai")
            else if (targetNode === "luna_ai" || targetNode === "server") {
                const userPrompt = data.prompt || data.message || "";

                // 1. Fetch relevant shared context
                const pastContext = await recallMemory(userPrompt);
                // 1. Live Timestamp Fetch Karein
                const currentDateTime = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

                // 2. Updated System Instruction (Hindi/Hinglish + Time Awareness)
                const systemInstruction = `You are Luna, a 24/7 intelligent voice assistant. 

IMPORTANT SYSTEM CONTEXT:
- Current Date and Time: ${currentDateTime} (IST)

RESPONSE GUIDELINES:
1. Always reply in clear Hindi or Hinglish (a natural mix of Hindi and English written in the Latin script).
2. Keep your responses concise, direct, and conversational since your reply will be read out loud on a smartwatch speaker.
3. Keep track of time and date for time-sensitive queries (e.g., reminders, greetings, or schedule checks).
4. Use the following past memory context if relevant to personalize your response:
\n${pastContext}`;

                // 3. Gemini Call
                const response = await ai.models.generateContent({
                    model: 'gemini-3.1-flash-lite',
                    contents: userPrompt,
                    config: { systemInstruction }
                });

                const aiReply = response.text;

                // 3. Save new memory asynchronously
                saveToMemory(senderId, `User (${senderId}): ${userPrompt} | Luna: ${aiReply}`);

                // 4. Send response back to sender node
                ws.send(JSON.stringify({
                    sender_id: "luna_ai",
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