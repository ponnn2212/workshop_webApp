const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Allow all origins for development, restrict in production
        methods: ["GET", "POST"]
    }
}); // Initialize Socket.IO with the HTTP server

const PORT = process.env.PORT || 3000;

// Middleware for parsing JSON bodies
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// In-memory data store for rooms
// Structure:
// {
//     roomCode: {
//         code: string,
//         name: string,
//         players: {
//             'Player1': { name: string, buzzedTime: number|null, isFoul: boolean, isWaiting: boolean, socketId: string|null },
//             'Player2': { ... }
//         },
//         gameStarted: boolean,
//         gameStartTime: number|null,
//         buzzedOrder: [{ name: string, time: number }],
//         firstBuzzer: string|null,
//     }
// }
const gameRooms = {};

// Helper function to generate unique room code
function generateRoomCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit code
    } while (gameRooms[code]); // Ensure uniqueness
    return code;
}

// Function to validate name (same as your script.js)
// อนุญาตเฉพาะตัวอักษรไทย, อังกฤษ (ทั้งเล็กและใหญ่), ตัวเลข
function isValidName(name) {
    const regex = /^[ก-๙a-zA-Z0-9]+$/;
    return regex.test(name);
}

// =======================================================
// HTTP API Routes (for initial room creation/joining)
// =======================================================

// 1. Create Room API
app.post('/api/create_room', (req, res) => {
    const { roomName } = req.body;

    if (!roomName || !isValidName(roomName)) {
        return res.status(400).json({ message: 'Invalid: กรุณาใส่ชื่อห้องที่ถูกต้อง (อนุญาตเฉพาะตัวอักษรไทย, อังกฤษ, ตัวเลข)' });
    }

    const roomCode = generateRoomCode();
    gameRooms[roomCode] = {
        code: roomCode,
        name: roomName,
        players: {}, // Players are added via socket 'joinRoomSocket'
        gameStarted: false,
        gameStartTime: null,
        buzzedOrder: [],
        firstBuzzer: null,
    };
    console.log(`[HTTP] Room created: ${roomCode} - ${roomName}`);
    res.status(201).json({ roomCode, roomName, message: 'Room created successfully' });
});

// 2. Join Room API
app.post('/api/join_room', (req, res) => {
    const { roomCode, playerName } = req.body;

    if (!roomCode || roomCode.length !== 4) {
        return res.status(400).json({ message: 'Invalid: กรุณาใส่รหัสห้อง 4 ตัว' });
    }
    if (!playerName || !isValidName(playerName)) {
        return res.status(400).json({ message: 'Invalid: กรุณาใส่ชื่อผู้เล่นที่ถูกต้อง (อนุญาตเฉพาะตัวอักษรไทย, อังกฤษ, ตัวเลข)' });
    }

    const room = gameRooms[roomCode];

    if (!room) {
        return res.status(404).json({ message: 'Invalid: ไม่พบห้องหรือรหัสห้องไม่ถูกต้อง' });
    }

    // Check for duplicate player name (case-insensitive)
    const existingPlayerNames = Object.keys(room.players).map(name => name.toLowerCase());
    if (existingPlayerNames.includes(playerName.toLowerCase()) && !room.players[playerName]) {
        // If the player name already exists AND it's not the same player rejoining
        return res.status(409).json({ message: 'Invalid: ชื่อนี้มีคนใช้แล้วในห้องนี้ กรุณาใช้ชื่ออื่น' });
    }
    
    // Add or update player info
    if (!room.players[playerName]) {
        room.players[playerName] = {
            name: playerName,
            buzzedTime: null,
            isFoul: false,
            isWaiting: true,
            socketId: null // Socket ID will be set when client connects via Socket.IO
        };
        console.log(`[HTTP] Player ${playerName} joined room ${roomCode}`);
    } else {
        // If existing player rejoins and game hasn't started, reset foul status
        if (!room.gameStarted && room.players[playerName].isFoul) {
            room.players[playerName].isFoul = false;
            room.players[playerName].buzzedTime = null;
            room.players[playerName].isWaiting = true;
        }
        console.log(`[HTTP] Player ${playerName} rejoined room ${roomCode}`);
    }
    
    // Respond with success, actual room update will happen via Socket.IO
    res.status(200).json({ message: 'Joined room successfully', roomCode, playerName });
});

// =======================================================
// Socket.IO Events (for real-time communication)
// =======================================================
io.on('connection', (socket) => {
    console.log(`[Socket.IO] New client connected: ${socket.id}`);

    // When a client wants to join a specific room (Socket.IO room)
    socket.on('joinRoomSocket', ({ roomCode, playerName }) => {
        const room = gameRooms[roomCode];
        if (room && room.players[playerName]) {
            socket.join(roomCode); // Make this socket a member of the Socket.IO room
            room.players[playerName].socketId = socket.id; // Store socket ID for player
            // Also store roomCode and playerName on socket for easy access on disconnect
            socket.data.roomCode = roomCode;
            socket.data.playerName = playerName;

            console.log(`[Socket.IO] ${playerName} (${socket.id}) joined room ${roomCode}`);
            // Emit updated room status to ALL clients in that room
            io.to(roomCode).emit('roomStatusUpdate', room);
        } else {
            console.warn(`[Socket.IO] Attempt to join invalid socket room for ${playerName} in ${roomCode}`);
            socket.emit('error', 'Failed to join socket room.');
        }
    });

    // Event for creator to start the game
    socket.on('startGame', ({ roomCode }) => {
        const room = gameRooms[roomCode];
        if (room && !room.gameStarted) { // Only start if game is not already started
            room.gameStarted = true;
            room.gameStartTime = Date.now();
            room.firstBuzzer = null;
            room.buzzedOrder = [];

            // Reset buzz status for non-foul players
            for (const pName in room.players) {
                if (!room.players[pName].isFoul) { // Foul players remain foul for the round
                    room.players[pName].buzzedTime = null;
                    room.players[pName].isWaiting = true;
                } else {
                    room.players[pName].isWaiting = false;
                }
            }
            console.log(`[Socket.IO] Game started in room ${roomCode}`);
            io.to(roomCode).emit('roomStatusUpdate', room); // Broadcast update
        }
    });

    // Event for creator to reset the game entirely
    socket.on('resetGame', ({ roomCode }) => {
        const room = gameRooms[roomCode];
        if (room) {
            room.gameStarted = false;
            room.gameStartTime = null;
            room.firstBuzzer = null;
            room.buzzedOrder = [];

            // Reset all player statuses
            for (const pName in room.players) {
                room.players[pName].buzzedTime = null;
                room.players[pName].isFoul = false;
                room.players[pName].isWaiting = true;
            }
            console.log(`[Socket.IO] Game reset in room ${roomCode}`);
            io.to(roomCode).emit('roomStatusUpdate', room); // Broadcast update
        }
    });

    // Event for creator to clear current round results (keep game started)
    socket.on('clearResults', ({ roomCode }) => {
        const room = gameRooms[roomCode];
        if (room) {
            room.firstBuzzer = null;
            room.buzzedOrder = [];
            for (const pName in room.players) {
                if (!room.players[pName].isFoul) { // Don't clear foul status
                    room.players[pName].buzzedTime = null;
                }
            }
            console.log(`[Socket.IO] Results cleared in room ${roomCode}`);
            io.to(roomCode).emit('roomStatusUpdate', room); // Broadcast update
        }
    });

    // Event for a player to buzz
    socket.on('buzz', ({ roomCode, playerName }) => {
        const room = gameRooms[roomCode];
        if (room && room.players[playerName]) {
            const player = room.players[playerName];
            const buzzTime = Date.now();

            if (player.buzzedTime !== null || player.isFoul) {
                // Player already buzzed or is foul, ignore
                return;
            }

            if (!room.gameStarted) {
                // Foul buzz (pressed before game started)
                player.buzzedTime = buzzTime;
                player.isFoul = true;
                player.isWaiting = false;
                console.log(`[Socket.IO] ${playerName} FOUL in room ${roomCode}!`);
            } else {
                // Valid buzz during game
                player.buzzedTime = buzzTime;
                player.isWaiting = false;

                if (!room.firstBuzzer) { // Set first buzzer if not already set
                    room.firstBuzzer = playerName;
                }
                room.buzzedOrder.push({ name: playerName, time: buzzTime });
                console.log(`[Socket.IO] ${playerName} buzzed in room ${roomCode} at ${buzzTime}`);
            }
            io.to(roomCode).emit('roomStatusUpdate', room); // Broadcast update
        }
    });

    // Handle client disconnection
    socket.on('disconnect', () => {
        const roomCode = socket.data.roomCode;
        const playerName = socket.data.playerName;

        if (roomCode && playerName) {
            const room = gameRooms[roomCode];
            if (room && room.players[playerName]) {
                // Optionally remove player or just mark them as disconnected
                // For this game, we'll keep them in the list but mark socketId null
                room.players[playerName].socketId = null; 
                console.log(`[Socket.IO] Player ${playerName} (${socket.id}) disconnected from room ${roomCode}`);
                io.to(roomCode).emit('roomStatusUpdate', room); // Broadcast update
            }
        }
        console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
    });
});

// Start the server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Frontend accessible at http://localhost:${PORT}`);
});