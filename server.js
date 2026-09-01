const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Active connected nodes {"device_id": WebSocketInstance}
const activeNodes = new Map();

// --- HTTP Health Check Route ---
app.get('/', (req, res) => {
    res.json({
        status: "online",
        system: "Luna Central Mesh Router",
        active_nodes: Array.from(activeNodes.keys())
    });
});

// --- WebSocket Upgrade & Routing ---
server.on('upgrade', (request, socket, head) => {
    const urlParts = request.url.split('/');
    
    // Expecting endpoint URL format: /ws/device_id
    if (urlParts[1] === 'ws' && urlParts[2]) {
        const deviceId = urlParts[2];
        
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request, deviceId);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (ws, request, deviceId) => {
    // Register Connected Node
    activeNodes.set(deviceId, ws);
    console.log(`[SERVER]: Node Connected -> [${deviceId}]`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            const targetNode = data.target_node;
            const senderId = data.sender_id || deviceId;

            console.log(`[SERVER]: Routing message from [${senderId}] to [${targetNode}]`);

            // Check if Target Node is online
            if (activeNodes.has(targetNode)) {
                const targetWs = activeNodes.get(targetNode);
                if (targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify(data));
                }
            } else {
                // Fallback message if target node is offline
                console.log(`[SERVER]: Target [${targetNode}] is Offline.`);
                const fallbackMsg = {
                    sender_id: "server",
                    target_node: senderId,
                    status: "error",
                    message: `Target node '${targetNode}' offline hai.`
                };
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(fallbackMsg));
                }
            }
        } catch (err) {
            console.error(`[SERVER]: Error parsing payload from [${deviceId}]:`, err.message);
        }
    });

    ws.on('close', () => {
        activeNodes.delete(deviceId);
        console.log(`[SERVER]: Node Disconnected -> [${deviceId}]`);
    });

    ws.on('error', (err) => {
        console.error(`[SERVER]: Error on node [${deviceId}]:`, err.message);
        activeNodes.delete(deviceId);
    });
});

// Railway dynamic PORT variable pass karta hai
const PORT = process.env.PORT || 8000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER]: Luna Router running on port ${PORT}`);
});