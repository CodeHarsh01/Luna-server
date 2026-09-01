const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);

// Direct WebSocket Server binding
const wss = new WebSocketServer({ server });

const activeNodes = new Map();

// Railway Health Check
app.get('/', (req, res) => {
    res.status(200).json({
        status: "online",
        system: "Luna Mesh Router (Node.js)",
        active_nodes: Array.from(activeNodes.keys())
    });
});

wss.on('connection', (ws, req) => {
    // Extract device_id from URL path (e.g., /ws/heavy_laptop)
    const urlParts = req.url.split('/');
    const deviceId = urlParts[2] || urlParts[1] || 'unknown';

    activeNodes.set(deviceId, ws);
    console.log(`[CONNECTED]: Device ID -> ${deviceId}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            const targetNode = data.target_node;
            const senderId = data.sender_id || deviceId;

            console.log(`[ROUTE]: ${senderId} -> ${targetNode}`);

            if (activeNodes.has(targetNode)) {
                const targetWs = activeNodes.get(targetNode);
                if (targetWs.readyState === 1) { // 1 = OPEN
                    targetWs.send(JSON.stringify(data));
                }
            } else {
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