const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const { initSocket } = require('./services/socketService');
const authRoutes = require('./routes/authRoutes');
const sportsRoutes = require('./routes/sportsRoutes');
const venueRoutes = require('./routes/venueRoutes');
const courtRoutes = require('./routes/courtRoutes');
const slotRoutes = require('./routes/slotRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const couponRoutes = require('./routes/couponRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const ownerRoutes = require('./routes/ownerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const tournamentRoutes = require('./routes/tournamentRoutes');
const matchRoutes = require('./routes/matchRoutes');
const teamRoutes = require('./routes/teamRoutes');
const advertisementRoutes = require('./routes/advertisementRoutes');
const auctionRoutes = require('./routes/auctionRoutes');
const playerRoutes = require('./routes/playerRoutes');
const userRoutes = require('./routes/userRoutes');
const privacyPolicyRoutes = require('./routes/privacyPolicyRoutes');
const accountDeletionRoutes = require('./routes/accountDeletionRoutes');
const errorHandler = require('./middleware/errorHandler');
const { verifyConnection: verifyEmailConnection } = require('./services/emailService');

const { APP_URL, API_PUBLIC_URL, PORT: CONFIG_PORT, TRUSTED_ORIGINS } = require('./config/siteConfig');

const app = express();
const server = http.createServer(app);

// Prepend listener on HTTP server so Socket.IO / Engine.IO accepts requests
// with or without trailing slash (e.g. /socket.io vs /socket.io/)
server.prependListener('request', (req, res) => {
  if (req.url === '/socket.io' || req.url.startsWith('/socket.io?')) {
    req.url = req.url.replace('/socket.io', '/socket.io/');
  }
});

server.prependListener('upgrade', (req, socket, head) => {
  if (req.url === '/socket.io' || req.url.startsWith('/socket.io?')) {
    req.url = req.url.replace('/socket.io', '/socket.io/');
  }
});

const io = initSocket(server);
const PORT = process.env.PORT || CONFIG_PORT || 5008;

// Enable CORS and JSON parsing
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (TRUSTED_ORIGINS.includes(origin) || origin.endsWith('playzo.duckdns.org')) {
      return callback(null, true);
    }
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Browser permissions header for WebRTC and Live Broadcasting
app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(self), display-capture=(self)'
  );
  next();
});

// Serve static uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health Check API
app.get('/api/health', (req, res) => {
  res.json({
    status: 'UP',
    message: 'Sports Booking Platform API Server is running smoothly',
    timestamp: new Date().toISOString()
  });
});

// Register API Routes
app.use('/api/auth', authRoutes);
app.use('/api/sports', sportsRoutes);
app.use('/api/venues', venueRoutes);
app.use('/api/venues/:venueId/courts', courtRoutes);
app.use('/api/courts/:courtId/slots', slotRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/owner', ownerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/tournaments', tournamentRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/advertisements', advertisementRoutes);
app.use('/api/ads', advertisementRoutes);
app.use('/api/auctions', auctionRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notifications', userRoutes);
app.use('/api/privacy-policy', privacyPolicyRoutes);
app.use('/api/account', accountDeletionRoutes);
app.use('/api/account-deletion', accountDeletionRoutes);
const tvDisplayRoutes = require('./routes/tvDisplayRoutes');
app.use('/api/tv', tvDisplayRoutes);
const streamRoutes = require('./routes/streamRoutes');
app.use('/api/matches', streamRoutes);
app.use('/api/streams', streamRoutes);


// 404 Route Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint '${req.originalUrl}' not found.`
  });
});

// Centralized Error Handler
app.use(errorHandler);

// Start Server
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🏆 Sports Booking & Management Server Started`);
  console.log(`🌐 Public Web App: ${APP_URL}`);
  console.log(`📡 Public API: ${API_PUBLIC_URL}`);
  console.log(`🚀 Local Port: ${PORT}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`====================================================`);
  
  // Verify SMTP Email Server Connection asynchronously
  verifyEmailConnection();
});
