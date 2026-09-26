require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4001;

// ============================================================================
// MIDDLEWARE SETUP
// ============================================================================

// Logging middleware
app.use(morgan(':method :url :status :response-time ms'));

// CORS middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CMS-API-KEY']
}));

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Static files for uploaded images
app.use('/uploads', express.static(path.join(__dirname, '../data/uploads')));

// ============================================================================
// ROUTES
// ============================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API version endpoint
app.get('/api/version', (req, res) => {
  res.json({
    api_version: '1.0.0',
    phase: 2,
    endpoints: [
      'GET /api/costumes',
      'POST /api/costumes',
      'GET /api/costumes/:id',
      'PUT /api/costumes/:id',
      'DELETE /api/costumes/:id',
      'GET /api/props',
      'POST /api/props',
      'GET /api/lenses',
      'POST /api/lenses',
      'PATCH /api/lenses/:id/open',
      'POST /api/upload'
    ]
  });
});

// Routes
const authRoutes = require('./routes/auth');
const costumeRoutes = require('./routes/costumes');
const propsRoutes = require('./routes/props');
const lensesRoutes = require('./routes/lenses');
const imageRoutes = require('./routes/images');

app.use('/api', authRoutes);
app.use('/', authRoutes);

app.use('/api', costumeRoutes);
app.use('/', costumeRoutes);

app.use('/api', propsRoutes);
app.use('/', propsRoutes);

app.use('/api', lensesRoutes);
app.use('/', lensesRoutes);

app.use('/api', imageRoutes);
app.use('/', imageRoutes);

const notificationRoutes = require('./routes/notifications');
app.use('/api', notificationRoutes);
app.use('/', notificationRoutes);

// Static frontend UI
app.use(express.static(path.join(__dirname, '../public')));

// ============================================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ Express Server Started');
  console.log(`${'='.repeat(60)}`);
  console.log(`🌐 Server running on: http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`📚 API version: http://localhost:${PORT}/api/version`);
  console.log(`${'='.repeat(60)}\n`);

  // Log available endpoints
  console.log('📡 Available Endpoints:');
  console.log('   Health: GET /health');
  console.log('   Version: GET /api/version');
  console.log('\nℹ️  More endpoints will be added in Steps 2-4\n');
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Server interrupted, shutting down...');
  process.exit(0);
});

module.exports = app;
