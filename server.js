const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config();

// Create express app
const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/treasurehunt', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// Define player schema
const playerSchema = new mongoose.Schema({
  username: String,
  userId: String,
  highScore: { type: Number, default: 0 },
  gamesCompleted: { type: Number, default: 0 },
  fastestTime: { type: Number, default: null }
});

const Player = mongoose.model('Player', playerSchema);

// Define room schema
const roomSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
  isActive: { type: Boolean, default: true }
});

const Room = mongoose.model('Room', roomSchema);

// Initialize Socket.IO server
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Store active rooms and players
const activeRooms = new Map();

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create a new room
  socket.on('createRoom', async ({ roomCode }) => {
    try {
      // Create room in database
      const newRoom = new Room({ code: roomCode });
      await newRoom.save();

      activeRooms.set(roomCode, {
        players: [],
        isGameActive: false,
        currentQuestionIndex: 0,
        gameComplete: false
      });

      socket.join(roomCode);
      socket.emit('roomCreated', roomCode);
      
      console.log(`Room created: ${roomCode}`);
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('error', { message: 'Failed to create room' });
    }
  });

  // Join an existing room
  socket.on('joinRoom', async ({ roomCode, user }) => {
    try {
      // Check if room exists
      const room = await Room.findOne({ code: roomCode, isActive: true });
      
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      // Check if player exists in database
      let player = await Player.findOne({ userId: user.id });
      
      if (!player) {
        // Create new player
        player = new Player({
          username: user.username,
          userId: user.id
        });
        await player.save();
      }

      // Add player to room in database if not already added
      if (!room.players.includes(player._id)) {
        room.players.push(player._id);
        await room.save();
      }

      // Add player to active room
      if (!activeRooms.has(roomCode)) {
        activeRooms.set(roomCode, {
          players: [],
          isGameActive: false,
          currentQuestionIndex: 0,
          gameComplete: false
        });
      }

      const activeRoom = activeRooms.get(roomCode);
      
      // Track the socket id with the user for future reference
      socket.userId = user.id;
      socket.roomCode = roomCode;
      
      // Check if player already exists in the room to avoid duplicates
      if (!activeRoom.players.find(p => p.id === user.id)) {
        activeRoom.players.push({
          id: user.id,
          username: user.username,
          isReady: false,
          score: 0
        });
      }

      socket.join(roomCode);

      // Broadcast to other players in the room
      socket.to(roomCode).emit('playerJoined', {
        id: user.id,
        username: user.username,
        isReady: false,
        score: 0
      });

      // Send current room state to the new player
      socket.emit('roomState', activeRoom);
      
      console.log(`User ${user.username} joined room ${roomCode}, players in room:`, activeRoom.players.length);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Player ready status
  socket.on('playerReady', ({ roomCode, playerId }) => {
    console.log(`Player ${playerId} ready in room ${roomCode}`);
    
    if (!activeRooms.has(roomCode)) {
      console.log('Room not found:', roomCode);
      return;
    }

    const room = activeRooms.get(roomCode);
    const playerIndex = room.players.findIndex(p => p.id === playerId);
    
    if (playerIndex !== -1) {
      room.players[playerIndex].isReady = true;
      
      // Broadcast player ready to everyone in the room
      io.to(roomCode).emit('playerReady', playerId);
      
      // Check if all players are ready
      const allReady = room.players.every(p => p.isReady);
      
      console.log(`All players ready in room ${roomCode}: ${allReady}`);
      console.log(`Players in room: ${room.players.length}`);
      
      if (allReady && room.players.length > 0) {
        // Start the game countdown
        console.log(`Starting game in room ${roomCode}`);
        io.to(roomCode).emit('gameStart');
      }
    }
  });

  // All players ready notification
  socket.on('allPlayersReady', ({ roomCode }) => {
    if (!activeRooms.has(roomCode)) return;
    
    const room = activeRooms.get(roomCode);
    const allReady = room.players.every(p => p.isReady);
    
    // Double check all players are actually ready
    if (allReady && room.players.length > 0) {
      console.log(`All players ready confirmed in room ${roomCode}, starting game`);
      io.to(roomCode).emit('gameStart');
    }
  });

  // Start countdown
  socket.on('startCountdown', ({ roomCode }) => {
    if (!activeRooms.has(roomCode)) return;
    
    const room = activeRooms.get(roomCode);
    room.isGameActive = true;
    
    console.log(`Game countdown started in room ${roomCode}`);
    io.to(roomCode).emit('gameStart');
  });

  // Correct answer submitted
  socket.on('correctAnswer', ({ roomCode, questionIndex, points }) => {
    if (!activeRooms.has(roomCode)) return;
    
    const room = activeRooms.get(roomCode);
    
    // Update the player's score
    const playerId = socket.userId;
    const playerIndex = room.players.findIndex(p => p.id === playerId);
    
    if (playerIndex !== -1) {
      // Add points for correct answer
      room.players[playerIndex].score += points || 100;
      
      // Broadcast updated player score to all players in the room
      io.to(roomCode).emit('updateScores', room.players);
    }
  });

  // Player completes game
  socket.on('completeGame', async ({ roomCode, time }) => {
    if (!activeRooms.has(roomCode)) return;
    
    const room = activeRooms.get(roomCode);
    const playerId = socket.userId;
    const playerIndex = room.players.findIndex(p => p.id === playerId);
    
    if (playerIndex !== -1) {
      // Update player's completion time in the room
      room.players[playerIndex].completionTime = time;
      
      try {
        // Update player stats in database
        const player = await Player.findOne({ userId: playerId });
        
        if (player) {
          player.gamesCompleted += 1;
          player.highScore = Math.max(player.highScore, room.players[playerIndex].score);
          
          // Update fastest time if this is faster or first completion
          if (!player.fastestTime || time < player.fastestTime) {
            player.fastestTime = time;
            console.log(`Updated player ${playerId} with new fastest time: ${time}`);
          }
          
          await player.save();
          console.log(`Updated player stats in database for ${playerId}`);
        } else {
          console.log(`No player found with userId: ${playerId}`);
        }
        
        // Sort players by completion time
        room.players.sort((a, b) => {
          const timeA = a.completionTime || Number.MAX_VALUE;
          const timeB = b.completionTime || Number.MAX_VALUE;
          return timeA - timeB;
        });
        
        // Mark the room as game complete when the first player finishes
        if (!room.gameComplete) {
          room.gameComplete = true;
        }
        
        // Send updated leaderboard to all players
        io.to(roomCode).emit('updateScores', room.players);
        
        // Check if all active players have completed
        const activePlayers = room.players.filter(p => p.isReady);
        const allCompleted = activePlayers.every(p => p.completionTime);
        
        if (allCompleted) {
          console.log(`All players completed the game in room ${roomCode}`);
          io.to(roomCode).emit('gameEnd', room.players);
        }
      } catch (error) {
        console.error('Error updating player stats:', error);
      }
    } else {
      console.error(`Player with ID ${playerId} not found in room ${roomCode}`);
    }
  });

  // Reset game
  socket.on('resetGame', ({ roomCode }) => {
    if (!activeRooms.has(roomCode)) return;
    
    const room = activeRooms.get(roomCode);
    
    room.isGameActive = false;
    room.currentQuestionIndex = 0;
    room.gameComplete = false;
    room.players = room.players.map(p => ({
      ...p,
      isReady: false,
      score: 0,
      completionTime: undefined
    }));
    
    io.to(roomCode).emit('gameReset', room);
  });

  // Leave room
  socket.on('leaveRoom', ({ roomCode }) => {
    handlePlayerDisconnect(socket, roomCode);
  });

  // Handle disconnections
  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    handlePlayerDisconnect(socket, roomCode);
    console.log('User disconnected:', socket.id);
  });
});

// Helper function to handle player disconnection
function handlePlayerDisconnect(socket, roomCode) {
  if (!roomCode || !activeRooms.has(roomCode)) return;
  
  const room = activeRooms.get(roomCode);
  const playerId = socket.userId;
  
  if (!playerId) {
    console.log('No userId found for socket:', socket.id);
    return;
  }
  
  // Remove player from room
  room.players = room.players.filter(p => p.id !== playerId);
  console.log(`Player ${playerId} removed from room ${roomCode}`);
  
  // Notify other players
  socket.to(roomCode).emit('playerLeft', playerId);
  
  // Remove room if empty
  if (room.players.length === 0) {
    activeRooms.delete(roomCode);
    console.log(`Room ${roomCode} removed (empty)`);
    
    // Update room in database
    Room.findOneAndUpdate(
      { code: roomCode },
      { isActive: false },
      { new: true }
    ).catch(err => console.error('Error updating room status:', err));
  }
  
  socket.leave(roomCode);
}

// API Routes
app.get('/api/leaderboard', async (req, res) => {
  try {
    const players = await Player.find()
      .sort({ highScore: -1 })
      .limit(10);
    
    res.json(players);
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ message: 'Failed to fetch leaderboard' });
  }
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
}

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
