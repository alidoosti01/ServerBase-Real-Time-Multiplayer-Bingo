const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// In-memory storage (in production, use a database)
const rooms = new Map(); // roomId -> { adminId, players: Set, drawnNumbers: Set, playerData: Map }
const users = new Map(); // socketId -> { userId, username, isAdmin, roomId, bingoCard, playerId }
const playerSessions = new Map(); // playerId -> { username, roomId, bingoCard, socketId }

// Persistence configuration
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'roomHistory.json');
const MAX_HISTORY_SIZE = parseInt(process.env.MAX_HISTORY_SIZE) || 1000; // Max number of rooms in history
const MAX_DISK_USAGE_PERCENT = parseInt(process.env.MAX_DISK_USAGE_PERCENT) || 90; // Cleanup when disk usage exceeds this

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load room history from file
let roomHistory = [];
function loadRoomHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      roomHistory = JSON.parse(data);
      console.log(`Loaded ${roomHistory.length} rooms from history`);
    } else {
      roomHistory = [];
      console.log('No existing history file found, starting fresh');
    }
  } catch (error) {
    console.error('Error loading room history:', error);
    roomHistory = [];
  }
}

// Save room history to file
function saveRoomHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(roomHistory, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving room history:', error);
  }
}

// Check disk space and cleanup if needed
function checkDiskSpaceAndCleanup() {
  try {
    // Check history size limit
    if (roomHistory.length > MAX_HISTORY_SIZE) {
      console.log(`Room history exceeds limit (${roomHistory.length} > ${MAX_HISTORY_SIZE}), cleaning up oldest rooms...`);
      cleanupOldRooms(MAX_HISTORY_SIZE);
      return;
    }
    
    // Check file size if history file exists
    if (fs.existsSync(HISTORY_FILE)) {
      const stats = fs.statSync(HISTORY_FILE);
      const fileSizeMB = stats.size / (1024 * 1024);
      const maxFileSizeMB = 100; // Max 100MB for history file
      
      if (fileSizeMB > maxFileSizeMB) {
        console.log(`History file size (${fileSizeMB.toFixed(2)}MB) exceeds limit (${maxFileSizeMB}MB), cleaning up...`);
        // Keep only 80% of max size
        cleanupOldRooms(Math.floor(MAX_HISTORY_SIZE * 0.8));
      }
    }
  } catch (error) {
    console.error('Error checking disk space:', error);
  }
}

// Remove oldest rooms from history
function cleanupOldRooms(maxSize) {
  if (roomHistory.length <= maxSize) {
    return;
  }
  
  // Sort by closed date (oldest first)
  roomHistory.sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  
  // Remove oldest rooms
  const removed = roomHistory.length - maxSize;
  roomHistory = roomHistory.slice(removed);
  
  // Save updated history
  saveRoomHistory();
  
  console.log(`Removed ${removed} oldest rooms from history. Current size: ${roomHistory.length}`);
}

// Add room to history with persistence and cleanup
function addRoomToHistory(roomData) {
  // Ensure dates are properly formatted
  if (roomData.createdAt instanceof Date) {
    roomData.createdAt = roomData.createdAt.toISOString();
  }
  if (roomData.closedAt instanceof Date) {
    roomData.closedAt = roomData.closedAt.toISOString();
  }
  
  roomHistory.push(roomData);
  
  // Check disk space and cleanup if needed before saving
  checkDiskSpaceAndCleanup();
  
  // Save to disk
  saveRoomHistory();
  
  console.log(`Room ${roomData.roomId} added to history. Total rooms: ${roomHistory.length}`);
}

// Initialize: Load history on startup
loadRoomHistory();
const adminCredentials = {
  username: process.env.ADMIN_USERNAME || 'admin',
  password: process.env.ADMIN_PASSWORD || 'admin123'
};

// JWT Secret (in production, use a secure random string)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Helper function to generate room code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Authentication endpoint
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (username === adminCredentials.username && password === adminCredentials.password) {
    const token = jwt.sign(
      { username, isAdmin: true },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ success: true, token, isAdmin: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

// Verify token middleware
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle admin login via socket
  socket.on('admin:login', (data) => {
    const { username, password } = data;
    
    if (username === adminCredentials.username && password === adminCredentials.password) {
      users.set(socket.id, {
        userId: socket.id,
        username: username,
        isAdmin: true,
        roomId: null
      });
      socket.emit('admin:loginSuccess', { isAdmin: true, username: username });
    } else {
      socket.emit('admin:loginError', { message: 'Invalid credentials' });
    }
  });

  // Create room (admin only)
  socket.on('room:create', (data) => {
    const user = users.get(socket.id);
    
    if (!user || !user.isAdmin) {
      socket.emit('error', { message: 'Only admins can create rooms' });
      return;
    }

    // Ensure admin has a username
    if (!user.username) {
      user.username = 'Admin';
    }

    const { roomId: existingRoomId } = data || {};
    
    // Check if admin is reconnecting to existing room
    // Find room where this admin is the owner
    let room;
    if (existingRoomId && rooms.has(existingRoomId)) {
      room = rooms.get(existingRoomId);
      // Check if this socket belongs to the admin who created the room
      // We need to check by username since socket.id changes on reconnect
      const adminUsername = user.username || 'Admin';
      // For now, allow reconnection if admin socket is null (disconnected)
      if (!room.adminSocketId) {
        // Admin reconnecting to their room
        room.adminSocketId = socket.id;
        room.players.add(socket.id);
        user.roomId = existingRoomId;
        socket.join(existingRoomId);
        
        socket.emit('room:created', { 
          roomId: existingRoomId, 
          playerCount: room.players.size,
          reconnected: true,
          drawnNumbers: Array.from(room.drawnNumbers)
        });
        
        sendPlayersListToAdmin(room);
        console.log(`Admin reconnected to room ${existingRoomId}`);
        return;
      }
    }

    // Create new room
    let roomCode;
    do {
      roomCode = generateRoomCode();
    } while (rooms.has(roomCode));

    room = {
      roomId: roomCode,
      adminId: socket.id,
      adminSocketId: socket.id,
      players: new Set([socket.id]),
      drawnNumbers: new Set(),
      gameStarted: false,
      gameOver: false,
      winner: null,
      winnerInfo: null,
      createdAt: new Date(),
      playerData: new Map(), // playerId -> { username, bingoCard, socketId }
      completedRows: new Set() // Track completed rows to avoid duplicate notifications
    };

    rooms.set(roomCode, room);
    user.roomId = roomCode;

    socket.join(roomCode);
    socket.emit('room:created', { roomId: roomCode, playerCount: 1, reconnected: false });
    
    // Send initial players list
    sendPlayersListToAdmin(room);
    
    console.log(`Room ${roomCode} created by admin ${user.username} (${socket.id})`);
  });

  // Join room
  socket.on('room:join', (data) => {
    const { roomId, playerName, playerSessionId } = data;
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (!playerName || playerName.trim().length === 0) {
      socket.emit('error', { message: 'Please enter your name' });
      return;
    }

    const trimmedName = playerName.trim();
    
    // Check for duplicate names in room (excluding current player if reconnecting)
    const existingNames = new Set();
    room.playerData.forEach((playerData, pid) => {
      if (pid !== playerSessionId) {
        existingNames.add(playerData.username.toLowerCase());
      }
    });
    
    if (existingNames.has(trimmedName.toLowerCase())) {
      socket.emit('error', { message: 'This name is already taken. Please choose another name.' });
      return;
    }

    // Generate or use existing player session ID
    let actualPlayerId = playerSessionId;
    if (!actualPlayerId || !room.playerData.has(actualPlayerId)) {
      // Generate unique player ID
      actualPlayerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // Restore or create player data
    let playerData = room.playerData.get(actualPlayerId);
    if (playerData) {
      // Reconnecting - restore state
      playerData.username = trimmedName;
      playerData.socketId = socket.id;
    } else {
      // New player
      playerData = {
        username: trimmedName,
        bingoCard: null,
        socketId: socket.id
      };
      room.playerData.set(actualPlayerId, playerData);
    }

    const user = users.get(socket.id) || {
      userId: socket.id,
      username: trimmedName,
      isAdmin: false,
      roomId: null,
      playerId: actualPlayerId
    };

    user.username = trimmedName;
    user.roomId = roomId;
    user.playerId = actualPlayerId;
    users.set(socket.id, user);

    room.players.add(socket.id);
    socket.join(roomId);

    // Send current game state to player
    socket.emit('room:joined', {
      roomId: roomId,
      playerCount: room.players.size,
      isAdmin: user.isAdmin,
      drawnNumbers: Array.from(room.drawnNumbers),
      playerId: actualPlayerId,
      playerName: trimmedName,
      bingoCard: playerData.bingoCard // Restore bingo card if exists
    });

    // Notify other players
    io.to(roomId).emit('player:joined', {
      playerCount: room.players.size,
      playerId: actualPlayerId,
      playerName: trimmedName
    });

    // Send players list to admin
    sendPlayersListToAdmin(room);

    console.log(`Player ${trimmedName} (${actualPlayerId}) joined room ${roomId}`);
  });

  // Helper function to send players list to admin
  function sendPlayersListToAdmin(room) {
    const adminSocket = io.sockets.sockets.get(room.adminSocketId);
    if (adminSocket) {
      const playersList = Array.from(room.playerData.entries()).map(([playerId, playerData]) => {
        return {
          playerId: playerId,
          name: playerData.username,
          bingoCard: playerData.bingoCard
        };
      });
      adminSocket.emit('room:playersList', { players: playersList });
    }
  }

  // Helper function to check if a row is complete
  function checkRowComplete(row, drawnNumbers) {
    if (!row || row.length === 0) return null;
    
    const rowNumbers = row.filter(num => num !== null);
    const allMarked = rowNumbers.every(num => drawnNumbers.has(num));
    
    if (allMarked && rowNumbers.length === 5) {
      return rowNumbers;
    }
    return null;
  }

  // Check all players for completed rows
  function checkPlayersForCompletedRows(room) {
    const completedRows = [];
    
    // Initialize completedRows if it doesn't exist (for rooms created before this feature)
    if (!room.completedRows) {
      room.completedRows = new Set();
    }
    
    room.playerData.forEach((playerData, playerId) => {
      if (!playerData.bingoCard || playerData.bingoCard.length === 0) return;
      
      playerData.bingoCard.forEach((row, rowIndex) => {
        const completedNumbers = checkRowComplete(row, room.drawnNumbers);
        if (completedNumbers) {
          // Check if we already notified about this row (to avoid duplicate notifications)
          const rowKey = `${playerId}_row_${rowIndex}`;
          
          if (!room.completedRows.has(rowKey)) {
            room.completedRows.add(rowKey);
            completedRows.push({
              playerId: playerId,
              playerName: playerData.username,
              rowNumber: rowIndex + 1, // 1-indexed for display
              numbers: completedNumbers
            });
          }
        }
      });
    });
    
    return completedRows;
  }

  // Receive player's bingo card
  socket.on('player:bingoCard', (data) => {
    const { roomId, bingoCard, playerId } = data;
    const user = users.get(socket.id);
    const room = rooms.get(roomId);

    if (!user || !room || !room.players.has(socket.id)) {
      socket.emit('error', { message: 'Invalid request' });
      return;
    }

    // Store bingo card in user object
    user.bingoCard = bingoCard;
    
    // Store bingo card in room's playerData for persistence
    const actualPlayerId = playerId || user.playerId;
    if (actualPlayerId) {
      if (room.playerData.has(actualPlayerId)) {
        room.playerData.get(actualPlayerId).bingoCard = bingoCard;
      } else {
        // Create playerData entry if it doesn't exist (shouldn't happen normally)
        room.playerData.set(actualPlayerId, {
          username: user.username,
          bingoCard: bingoCard,
          socketId: socket.id
        });
      }
    }

    // Send to admin
    const adminSocket = io.sockets.sockets.get(room.adminSocketId || room.adminId);
    if (adminSocket) {
      adminSocket.emit('player:bingoCard', {
        playerId: actualPlayerId || socket.id,
        playerName: user.username,
        bingoCard: bingoCard
      });
    }

    console.log(`Received bingo card from ${user.username} (${actualPlayerId || socket.id})`);
  });

  // Draw number (admin only)
  socket.on('game:drawNumber', (data) => {
    const user = users.get(socket.id);
    if (!user || !user.isAdmin || !user.roomId) {
      socket.emit('error', { message: 'Only room admin can draw numbers' });
      return;
    }

    const room = rooms.get(user.roomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    // Check if game is already over
    if (room.gameOver) {
      socket.emit('error', { message: 'Game is over! A winner has been declared.' });
      return;
    }

    if (room.drawnNumbers.size >= 90) {
      socket.emit('error', { message: 'All numbers have been drawn!' });
      return;
    }

    // Generate random number
    let number;
    do {
      number = Math.floor(Math.random() * 90) + 1;
    } while (room.drawnNumbers.has(number));

    room.drawnNumbers.add(number);
    const startTime = Date.now() + 500;

    // Broadcast to all players in room
    io.to(user.roomId).emit('game:numberDrawn', {
      number: number,
      startTime: startTime,
      drawnNumbers: Array.from(room.drawnNumbers)
    });

    // Check for completed rows after a short delay to allow client to update
    setTimeout(() => {
      const completedRows = checkPlayersForCompletedRows(room);
      if (completedRows.length > 0) {
        // Mark game as over when first row is completed
        if (!room.gameOver) {
          room.gameOver = true;
          room.winner = completedRows[0].playerName;
        }
        
        completedRows.forEach(completedRow => {
          // Broadcast notification to all players
          io.to(user.roomId).emit('game:rowCompleted', {
            playerName: completedRow.playerName,
            rowNumber: completedRow.rowNumber,
            numbers: completedRow.numbers
          });
          console.log(`${completedRow.playerName} completed row ${completedRow.rowNumber} with numbers: ${completedRow.numbers.join(', ')}`);
          
          // Store winner info in room
          if (!room.winnerInfo) {
            const winnerPlayerData = room.playerData.get(completedRow.playerId);
            room.winnerInfo = {
              playerId: completedRow.playerId,
              playerName: completedRow.playerName,
              rowNumber: completedRow.rowNumber,
              numbers: completedRow.numbers,
              bingoCard: winnerPlayerData ? winnerPlayerData.bingoCard : null
            };
          }
        });
      }
    }, 1500); // Wait for animation to complete

    console.log(`Number ${number} drawn in room ${user.roomId}`);
  });

  // Close room (admin only or when game is over)
  socket.on('room:close', (data) => {
    const user = users.get(socket.id);
    const { roomId } = data;
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    // Only admin can close room, or if game is over
    if (user && user.isAdmin && room.adminId === user.userId) {
      // Store room in history before closing
      if (room.gameOver && room.winnerInfo) {
        addRoomToHistory({
          roomId: room.roomId,
          createdAt: room.createdAt || new Date(),
          closedAt: new Date(),
          winner: room.winnerInfo.playerName,
          winnerRowNumber: room.winnerInfo.rowNumber,
          winnerNumbers: room.winnerInfo.numbers,
          winnerBingoCard: room.winnerInfo.bingoCard,
          totalPlayers: room.playerData.size,
          totalNumbersDrawn: room.drawnNumbers.size
        });
      }

      // Notify all players in room
      io.to(roomId).emit('room:closed', { message: 'Room has been closed' });

      // Remove room
      rooms.delete(roomId);
      console.log(`Room ${roomId} closed by admin`);
    } else if (room.gameOver) {
      // Store room in history when game is over
      if (room.winnerInfo) {
        addRoomToHistory({
          roomId: room.roomId,
          createdAt: room.createdAt || new Date(),
          closedAt: new Date(),
          winner: room.winnerInfo.playerName,
          winnerRowNumber: room.winnerInfo.rowNumber,
          winnerNumbers: room.winnerInfo.numbers,
          winnerBingoCard: room.winnerInfo.bingoCard,
          totalPlayers: room.playerData.size,
          totalNumbersDrawn: room.drawnNumbers.size
        });
      }

      // Notify all players in room
      io.to(roomId).emit('room:closed', { message: 'Game is over. Room is closing.' });

      // Remove room
      rooms.delete(roomId);
      console.log(`Room ${roomId} closed after game over`);
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    
    if (user && user.roomId) {
      const room = rooms.get(user.roomId);
      
      if (room) {
        room.players.delete(socket.id);
        
        // If admin disconnects, keep room alive but mark admin as disconnected
        if (user.isAdmin && (room.adminSocketId === socket.id || room.adminId === socket.id)) {
          room.adminSocketId = null; // Mark admin as disconnected
          console.log(`Admin disconnected from room ${user.roomId}, keeping room alive`);
          // Don't close the room - allow admin to reconnect
        } else if (user.playerId) {
          // Regular player disconnected - keep their data for reconnection
          const playerData = room.playerData.get(user.playerId);
          if (playerData) {
            playerData.socketId = null; // Mark as disconnected
          }
          
          // Notify remaining players
          io.to(user.roomId).emit('player:left', {
            playerCount: room.players.size,
            playerId: user.playerId,
            playerName: user.username
          });
          
          // Update admin's players list if admin is connected
          sendPlayersListToAdmin(room);
        }
      }
    }

    users.delete(socket.id);
    console.log('User disconnected:', socket.id);
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, users: users.size });
});

// Get room history (admin only)
app.get('/api/rooms/history', verifyToken, (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  res.json({ success: true, rooms: roomHistory });
});

// Serve admin page (with create room and history)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Redirect /admin/history to /admin
app.get('/admin/history', (req, res) => {
  res.redirect('/admin');
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Admin credentials: ${adminCredentials.username} / ${adminCredentials.password}`);
});
